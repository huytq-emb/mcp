import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DOCUMENTS_DIR,
  FIGURE_INDEX_SCHEMA_VERSION,
  FIGURE_OCR_SCHEMA_VERSION,
  INDEX_DIR,
  PYTHON_WORKER_DEFAULT_TIMEOUT_MS,
  RENDERS_DIR,
} from "../core/runtime-constants.js";
import {
  atomicWriteJson,
  compactText,
  ensureInsideRoot,
  ensurePdfFilename,
  getPdfSourceInfo,
  isSamePdfSource,
  normalizeForSearch,
  pathExists,
  readJsonCached,
  safeFigureLookupIndexPath,
  safeFigureOcrIndexPath,
  safeFiguresIndexPath,
  safePagesCachePath,
  safePdfPath,
  sanitizeRenderStem,
} from "../core/runtime-helpers.js";
import {
  PythonWorkerError,
  atomicPromoteWorkerArtifact,
  runPythonWorker,
  validateWorkerArtifact,
} from "./python-worker.js";

export const OCR_INSTALL_HINT = String.raw`Run: .\.venv\Scripts\python.exe -m pip install -r requirements-ocr.txt`;
export const OCR_STRUCTURE_INSTALL_HINT = String.raw`Run: .\.venv\Scripts\python.exe -m pip install -r requirements-ocr-structure.txt`;
export const OCR_VL_INSTALL_HINT = String.raw`Run: .\.venv\Scripts\python.exe -m pip install -r requirements-ocr-vl.txt`;
const FIGURE_LOOKUP_SCHEMA_VERSION = 1;
const PAGE_CONTEXT_CACHE_SCHEMA_VERSION = 1;
const FIGURE_SEMANTIC_SCHEMA_VERSION = 1;
const OCR_HEALTH_TTL_MS = 60_000;
const PAGE_CONTEXT_CACHE_KIND = "page-context";
const FIGURE_STRUCTURE_CACHE_KIND = "figure-structure";
const FIGURE_VL_CACHE_KIND = "figure-vl";
const FIGURE_SEMANTIC_CACHE_KIND = "figure-semantic-evidence";
const FIGURE_CACHE_KINDS = ["figure-images", "figure-ocr", FIGURE_STRUCTURE_CACHE_KIND, FIGURE_VL_CACHE_KIND, FIGURE_SEMANTIC_CACHE_KIND, PAGE_CONTEXT_CACHE_KIND];
const OCR_FIGURE_MODES = new Set(["text", "structure", "vl", "auto"]);
const INSPECT_FIGURE_PARSERS = new Set(["safe", "ocr", "structure", "vl", "auto"]);
const FIGURE_TYPES = new Set(["block_diagram", "sequence", "timing", "flowchart", "register_diagram", "table", "unknown"]);

let cachedOcrHealth = null;

function requestIdFor(operation) {
  return `${operation.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function prepareWorkerRoot(operation) {
  const requestId = requestIdFor(operation);
  const workerRoot = path.join(INDEX_DIR, ".workers", requestId);
  await fs.mkdir(workerRoot, { recursive: true });
  return { requestId, workerRoot, cancelPath: path.join(workerRoot, "cancel.requested") };
}

function optionsForWorker(options = {}) {
  return {
    dpi: Number(options.dpi || 200),
    minFigureAreaRatio: Number(options.minFigureAreaRatio || options.min_area_ratio || 0.03),
    maxFiguresPerPage: Number(options.maxFiguresPerPage || options.max_figures_per_page || 8),
    force: Boolean(options.force),
    ocrConcurrency: Math.max(1, Math.min(2, Number(options.ocrConcurrency || options.ocr_concurrency || 1))),
  };
}

function figureOcrCheckpointPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(path.join(INDEX_DIR, `${filename}.figure_ocr.partial.json`), INDEX_DIR, "figure OCR checkpoint");
}

function capabilityStatus(raw = {}, fallback = {}) {
  const available = Boolean(raw.available ?? fallback.available);
  return {
    available,
    reason: available ? "" : String(raw.reason || fallback.reason || "missing dependency"),
    hint: available ? "" : String(raw.hint || fallback.hint || ""),
    missing: Array.isArray(raw.missing) ? raw.missing : Array.isArray(fallback.missing) ? fallback.missing : [],
    ...Object.fromEntries(Object.entries(raw).filter(([key]) => !["available", "reason", "hint", "missing"].includes(key))),
  };
}

function normalizeOcrHealthStatus(status = {}) {
  const ocr = status.ocr || {};
  const text = capabilityStatus(ocr.text || {}, {
    available: Boolean(ocr.available),
    reason: ocr.reason || "missing dependency",
    hint: ocr.hint || OCR_INSTALL_HINT,
    missing: ocr.missing || [],
  });
  const structure = capabilityStatus(ocr.structure || {}, {
    available: false,
    reason: text.available ? "PP-StructureV3 capability was not reported by the Python worker" : text.reason,
    hint: OCR_STRUCTURE_INSTALL_HINT,
    missing: text.missing,
  });
  const vl = capabilityStatus(ocr.vl || {}, {
    available: false,
    reason: text.available ? "PaddleOCR-VL capability was not reported by the Python worker" : text.reason,
    hint: OCR_VL_INSTALL_HINT,
    missing: text.missing,
  });
  return {
    ...status,
    ocr: {
      ...ocr,
      enabled: Boolean(text.available),
      engine: ocr.engine || "paddleocr",
      available: Boolean(text.available),
      reason: text.available ? "" : text.reason,
      hint: text.available ? "" : text.hint || OCR_INSTALL_HINT,
      missing: text.available ? [] : text.missing,
      text,
      structure,
      vl,
    },
  };
}

export async function getOcrHealth(options = {}) {
  const ttlMs = Math.max(1_000, Number(options.ttlMs || process.env.RENESAS_MCP_OCR_HEALTH_TTL_MS || OCR_HEALTH_TTL_MS));
  const now = Date.now();
  if (!options.force && cachedOcrHealth && now - cachedOcrHealth.checkedAtMs <= ttlMs) {
    return {
      ...cachedOcrHealth.status,
      cache_hit: true,
      ocr_health_cache_hit: true,
      checkedAtMs: cachedOcrHealth.checkedAtMs,
    };
  }
  let status;
  try {
    const worker = await runPythonWorker({ operation: "ocr.health", allowedRoots: [] }, { timeoutMs: options.timeoutMs || 10_000 });
    status = {
      ok: true,
      node: { ok: true },
      python: { ok: true, interpreter: worker.interpreter, versions: worker.result?.versions || {} },
      ...(worker.result || {}),
    };
  } catch (error) {
    status = {
      ok: true,
      node: { ok: true },
      python: { ok: false, reason: error instanceof Error ? error.message : String(error), code: error.code || "PYTHON_UNAVAILABLE" },
      ocr: {
        enabled: false,
        engine: "paddleocr",
        available: false,
        reason: "python worker unavailable",
        hint: OCR_INSTALL_HINT,
        text: { available: false, reason: "python worker unavailable", hint: OCR_INSTALL_HINT, missing: [] },
        structure: { available: false, reason: "python worker unavailable", hint: OCR_STRUCTURE_INSTALL_HINT, missing: [] },
        vl: { available: false, reason: "python worker unavailable", hint: OCR_VL_INSTALL_HINT, missing: [] },
      },
    };
  }
  status = normalizeOcrHealthStatus(status);
  cachedOcrHealth = { checkedAtMs: now, status };
  return { ...status, cache_hit: false, ocr_health_cache_hit: false, checkedAtMs: now };
}

export function clearOcrHealthCache() {
  cachedOcrHealth = null;
}

export function formatOcrHealthReport(status) {
  const ocr = status.ocr || {};
  const text = ocr.text || {};
  const structure = ocr.structure || {};
  const vl = ocr.vl || {};
  const modelCache = ocr.modelCache || {};
  const lines = [
    "OCR health via eval_health_check: OK",
    `Node.js: ${status.node?.ok === false ? "unavailable" : "OK"}`,
    `Python worker: ${status.python?.ok === false ? `unavailable (${status.python.reason || "unknown"})` : "OK"}`,
    `PyMuPDF: ${status.python?.versions?.pymupdf || status.versions?.pymupdf || "unknown"}`,
    `PaddleOCR: ${ocr.available ? "available" : "missing"}`,
    `PaddleOCR text OCR: ${text.available ?? ocr.available ? "available" : "missing"}`,
    `PP-Structure/document parser: ${structure.available ? "available" : "missing"}`,
    `PaddleOCR-VL parser: ${vl.available ? "available" : "missing"}`,
    `PaddleX model cache: ${modelCache.path || "unknown"}`,
    `Cached PaddleX models: ${Number(modelCache.modelCount || 0)}`,
    `OCR enabled: ${ocr.enabled ? "true" : "false"}`,
    `OCR engine: ${ocr.engine || "paddleocr"}`,
  ];
  if (modelCache.path && Number(modelCache.modelCount || 0) <= 0) {
    lines.push("Model cache status: empty; first OCR inference may need network or a pre-downloaded PaddleX cache.");
  }
  if (ocr.reason) lines.push(`Reason: ${ocr.reason}`);
  if (ocr.hint) lines.push(`Hint: ${ocr.hint}`);
  if (modelCache.hint) lines.push(`Model cache hint: ${modelCache.hint}`);
  for (const [label, capability] of [["Structure", structure], ["VL", vl]]) {
    if (capability.reason && !capability.available) lines.push(`${label} reason: ${capability.reason}`);
    if (capability.hint && !capability.available) lines.push(`${label} hint: ${capability.hint}`);
  }
  lines.push("", "Machine summary JSON:");
  lines.push(JSON.stringify({
    ok: status.ok !== false,
    node: status.node || { ok: true },
    python: status.python || {},
    ocr,
  }, null, 2));
  return lines.join("\n");
}

async function loadJsonArtifact(filename, filePath, schemaVersion, requireSource = true) {
  if (!(await pathExists(filePath))) return null;
  try {
    const data = await readJsonCached(filePath);
    if (data.schemaVersion !== schemaVersion) return null;
    if (data.filename !== filename) return null;
    if (requireSource) {
      const source = await getPdfSourceInfo(filename);
      if (!isSamePdfSource(data.source, source)) return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function loadFigureOcrIndex(filename) {
  const data = await loadJsonArtifact(filename, safeFigureOcrIndexPath(filename), FIGURE_OCR_SCHEMA_VERSION);
  if (!data || !Array.isArray(data.figures)) return null;
  return data;
}

export async function loadPythonFiguresIndex(filename) {
  const data = await loadJsonArtifact(filename, safeFiguresIndexPath(filename), FIGURE_INDEX_SCHEMA_VERSION);
  if (!data || !Array.isArray(data.figures)) return null;
  return data;
}

export async function buildFiguresWithPython(filename, options = {}) {
  if (!options.force) {
    const cached = await loadPythonFiguresIndex(filename);
    if (cached && (cached.figures || []).some((figure) => Array.isArray(figure.bbox))) {
      await ensureFigureLookupIndex(filename, cached).catch(() => {});
      return { ...cached, cached: true };
    }
  }
  const { requestId, workerRoot, cancelPath } = await prepareWorkerRoot("figures.extract");
  options.onWorkerContext?.({ requestId, workerRoot, cancelPath, operation: "figures.extract" });
  const tempPath = path.join(workerRoot, "figures.json");
  const source = await getPdfSourceInfo(filename);
  try {
    const worker = await runPythonWorker({
      requestId,
      operation: "figures.extract",
      allowedRoots: [DOCUMENTS_DIR, INDEX_DIR, RENDERS_DIR],
      inputs: { filename, pdfPath: safePdfPath(filename) },
      outputs: { artifactPath: tempPath, rendersRoot: RENDERS_DIR, cancelPath },
      options: optionsForWorker(options),
    }, {
      timeoutMs: options.timeoutMs || PYTHON_WORKER_DEFAULT_TIMEOUT_MS,
      onProgress: options.onProgress,
      onSpawn: options.onWorkerSpawn,
      onStderr: options.onWorkerStderr,
    });
    const descriptor = worker.artifacts.find((entry) => entry.kind === "figures") || worker.result?.artifact;
    if (!descriptor) throw new PythonWorkerError("PROTOCOL_ERROR", "Python worker did not return figures artifact metadata");
    const validated = await validateWorkerArtifact(descriptor, { workerRoot, filename, source });
    await atomicPromoteWorkerArtifact(validated.tempPath, safeFiguresIndexPath(filename));
    const value = JSON.parse(await fs.readFile(safeFiguresIndexPath(filename), "utf-8"));
    value.producer = { engine: "python", operation: "figures.extract", requestId, durationMs: worker.durationMs };
    await ensureFigureLookupIndex(filename, value, { force: true }).catch(() => {});
    return value;
  } finally {
    await fs.rm(workerRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function buildFigureOcrWithPython(filename, options = {}) {
  if (!options.force) {
    const cached = await loadFigureOcrIndex(filename);
    if (cached) return { ok: true, cached: true, artifact: cached, counts: { figure_ocr: cached.figureOcrCount || 0 } };
  }
  let figures = await loadPythonFiguresIndex(filename);
  if (!figures || !(figures.figures || []).some((figure) => Array.isArray(figure.bbox))) {
    figures = await buildFiguresWithPython(filename, { ...options, force: true });
  }
  const health = await getOcrHealth({ timeoutMs: Math.min(Number(options.timeoutMs || 10_000), 30_000) });
  if (!health.ocr?.available) {
    return { ok: false, error: health.ocr?.reason || "OCR unavailable", hint: health.ocr?.hint || OCR_INSTALL_HINT, health };
  }
  const { requestId, workerRoot, cancelPath } = await prepareWorkerRoot("figure_ocr.build");
  options.onWorkerContext?.({ requestId, workerRoot, cancelPath, operation: "figure_ocr.build" });
  const tempPath = path.join(workerRoot, "figure_ocr.json");
  const checkpointPath = figureOcrCheckpointPath(filename);
  const source = await getPdfSourceInfo(filename);
  try {
    const worker = await runPythonWorker({
      requestId,
      operation: "figure_ocr.build",
      allowedRoots: [DOCUMENTS_DIR, INDEX_DIR, RENDERS_DIR],
      inputs: { filename, pdfPath: safePdfPath(filename), figuresPath: safeFiguresIndexPath(filename), existingArtifactPath: safeFigureOcrIndexPath(filename) },
      outputs: { artifactPath: tempPath, checkpointPath, rendersRoot: RENDERS_DIR, cancelPath },
      options: optionsForWorker(options),
    }, {
      timeoutMs: options.timeoutMs || PYTHON_WORKER_DEFAULT_TIMEOUT_MS,
      onProgress: options.onProgress,
      onSpawn: options.onWorkerSpawn,
      onStderr: options.onWorkerStderr,
    });
    if (worker.result?.ok === false) {
      return { ok: false, error: worker.result.error || "OCR unavailable", hint: worker.result.hint || OCR_INSTALL_HINT, health: worker.result.health || null };
    }
    const descriptor = worker.artifacts.find((entry) => entry.kind === "figure_ocr") || worker.result?.artifact;
    if (!descriptor) throw new PythonWorkerError("PROTOCOL_ERROR", "Python worker did not return figure OCR artifact metadata");
    const validated = await validateWorkerArtifact(descriptor, { workerRoot, filename, source });
    await atomicPromoteWorkerArtifact(validated.tempPath, safeFigureOcrIndexPath(filename));
    const artifact = JSON.parse(await fs.readFile(safeFigureOcrIndexPath(filename), "utf-8"));
    return { ok: true, cached: Boolean(worker.result?.cached), artifact, counts: { figure_ocr: artifact.figureOcrCount || 0 } };
  } finally {
    await fs.rm(workerRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function pdfSourceFingerprint(source = {}) {
  return `size=${Number(source.size || 0)};mtimeMs=${Math.round(Number(source.mtimeMs || 0))}`;
}

function softFailure(errorCode, message, extra = {}) {
  return {
    ok: false,
    error_code: errorCode,
    message,
    warnings: [],
    ...extra,
  };
}

function failureFromError(error, fallbackCode = "FIGURE_OCR_FAILED", extra = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error?.code === "ENOENT" ? "PDF_NOT_FOUND" : error?.code || fallbackCode;
  return softFailure(code, message, extra);
}

function normalizeBbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const bbox = value.map((item) => Number(item));
  if (bbox.some((item) => !Number.isFinite(item))) return null;
  if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) return null;
  return bbox.map((item) => Math.round(item * 100) / 100);
}

function normalizeScale(value) {
  const n = Number(value ?? 2.0);
  if (!Number.isFinite(n)) return 2.0;
  return Math.max(0.25, Math.min(6.0, Math.round(n * 100) / 100));
}

function normalizeOcrEngine(value) {
  const engine = String(value || "auto").trim().toLowerCase();
  if (["auto", "paddleocr", "none"].includes(engine)) return engine;
  return "auto";
}

function normalizeOcrFigureMode(value, defaultMode = "text") {
  const mode = String(value === undefined || value === null || value === "" ? defaultMode : value).trim().toLowerCase();
  return OCR_FIGURE_MODES.has(mode) ? mode : defaultMode;
}

function normalizeInspectParser(value, defaultParser = "safe") {
  const parser = String(value === undefined || value === null || value === "" ? defaultParser : value).trim().toLowerCase();
  return INSPECT_FIGURE_PARSERS.has(parser) ? parser : defaultParser;
}

function normalizeInspectMode(value, figure = null) {
  const requested = String(value || "auto").trim().toLowerCase();
  if (["block_diagram", "sequence", "timing", "flowchart", "register_diagram"].includes(requested)) return requested;
  const text = normalizeForSearch(`${figure?.kind || ""} ${figure?.caption || ""} ${figure?.title || ""}`);
  if (/timing|waveform/.test(text)) return "timing";
  if (/sequence|flow/.test(text)) return "sequence";
  if (/register|bit field|bitfield/.test(text)) return "register_diagram";
  if (/block|configuration|module/.test(text)) return "block_diagram";
  return "auto";
}

function normalizeFigureType(value) {
  const figureType = String(value || "unknown").trim().toLowerCase();
  if (figureType === "auto") return "unknown";
  return FIGURE_TYPES.has(figureType) ? figureType : "unknown";
}

function selectOcrMode(requestedMode, health) {
  const mode = normalizeOcrFigureMode(requestedMode, "text");
  if (mode !== "auto") return mode;
  return health?.ocr?.structure?.available ? "structure" : "text";
}

function autoVlEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.RENESAS_MCP_AUTO_VL || "").trim());
}

export function selectInspectParser(requestedParser, figureType, health, env = process.env) {
  const parser = normalizeInspectParser(requestedParser, "safe");
  if (parser !== "auto") return parser;
  if (health?.ocr?.structure?.available) return "structure";
  if (["timing", "sequence", "flowchart"].includes(figureType) && autoVlEnabled(env) && health?.ocr?.vl?.available) return "vl";
  if (health?.ocr?.text?.available || health?.ocr?.available) return "ocr";
  return "safe";
}

function cacheKey(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

function envPositiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function contextFullCacheMaxBytes() {
  return envPositiveInteger("RENESAS_MCP_CONTEXT_FULL_CACHE_MAX_BYTES", 16 * 1024 * 1024);
}

function cacheDir(cacheName) {
  return ensureInsideRoot(path.join(INDEX_DIR, "cache", cacheName), INDEX_DIR, `${cacheName} cache`);
}

function safeCachePath(cacheName, filename, key, ext) {
  ensurePdfFilename(filename);
  const safeExt = String(ext || "json").replace(/[^A-Za-z0-9]/g, "") || "json";
  const dir = cacheDir(cacheName);
  const stem = sanitizeRenderStem(`${filename}-${key}`);
  return ensureInsideRoot(path.join(dir, `${stem}.${safeExt}`), INDEX_DIR, `${cacheName} cache file`);
}

function figureIdentifiers(figure = {}) {
  return [figure.id, figure.figureUid, figure.figure_uid].map((item) => String(item || "").trim()).filter(Boolean);
}

function figureLookupEntry(figure = {}) {
  const ids = figureIdentifiers(figure);
  const id = ids[0] || "";
  return {
    id,
    figureUid: figure.figureUid || figure.figure_uid || id,
    figure_uid: figure.figure_uid || figure.figureUid || id,
    page: Number(figure.page || 0),
    bbox: Array.isArray(figure.bbox) ? figure.bbox : [],
    caption: String(figure.caption || figure.title || "").trim(),
    title: String(figure.title || figure.caption || "").trim(),
    kind: String(figure.kind || figure.type || "").trim(),
    renderPath: figure.renderPath || figure.render_path || "",
    render_path: figure.render_path || figure.renderPath || "",
    identifiers: ids,
  };
}

function buildFigureLookupArtifact(filename, index = {}) {
  const byId = {};
  for (const figure of index.figures || []) {
    const entry = figureLookupEntry(figure);
    if (!entry.identifiers.length) continue;
    for (const id of entry.identifiers) byId[id] = entry;
  }
  return {
    schemaVersion: FIGURE_LOOKUP_SCHEMA_VERSION,
    filename,
    generatedBy: "local-pdf-mcp-server.figure-lookup",
    createdAt: new Date().toISOString(),
    source: index.source || null,
    sourceFingerprint: index.sourceFingerprint || (index.source ? pdfSourceFingerprint(index.source) : ""),
    figureCount: Object.values(byId).filter((entry, indexValue, entries) => entries.findIndex((candidate) => candidate.id === entry.id) === indexValue).length,
    aliasCount: Object.keys(byId).length,
    byId,
  };
}

async function loadFigureLookupIndex(filename) {
  const data = await loadJsonArtifact(filename, safeFigureLookupIndexPath(filename), FIGURE_LOOKUP_SCHEMA_VERSION);
  if (!data || !data.byId || typeof data.byId !== "object") return null;
  return data;
}

async function writeFigureLookupIndex(filename, index) {
  const lookup = buildFigureLookupArtifact(filename, index);
  await atomicWriteJson(safeFigureLookupIndexPath(filename), lookup);
  return lookup;
}

export async function ensureFigureLookupIndex(filename, index = null, options = {}) {
  ensurePdfFilename(filename);
  if (!options.force) {
    const existing = await loadFigureLookupIndex(filename).catch(() => null);
    if (existing) return existing;
  }
  const figuresIndex = index || await loadPythonFiguresIndex(filename);
  if (!figuresIndex || !Array.isArray(figuresIndex.figures)) return null;
  return writeFigureLookupIndex(filename, figuresIndex);
}

async function resolveFigureTarget(filename, args = {}) {
  const figureId = String(args.figure_id || args.figureId || "").trim();
  if (figureId) {
    let lookup = null;
    try {
      lookup = await loadFigureLookupIndex(filename);
    } catch {
      lookup = null;
    }
    const lookupFigure = lookup?.byId?.[figureId];
    if (lookupFigure) {
      const bbox = normalizeBbox(lookupFigure.bbox);
      if (!bbox) {
        return softFailure("FIGURE_BBOX_UNAVAILABLE", `Figure has no usable bbox: ${figureId}`, { filename, figure_id: figureId, page: lookupFigure.page || null, lookup_cache_hit: true });
      }
      return {
        ok: true,
        filename,
        figure: lookupFigure,
        figure_id: figureId,
        page: Number(lookupFigure.page || 0),
        bbox,
        caption: String(lookupFigure.caption || lookupFigure.title || "").trim(),
        lookup_cache_hit: true,
      };
    }

    let index = null;
    try {
      index = await loadPythonFiguresIndex(filename);
    } catch (error) {
      return failureFromError(error, "FIGURES_INDEX_UNAVAILABLE", { filename, figure_id: figureId });
    }
    if (!index) {
      return softFailure("FIGURES_INDEX_UNAVAILABLE", `Figures index is not available for ${filename}. Run build_figures_index first.`, { filename, figure_id: figureId });
    }
    const figure = (index.figures || []).find((item) => figureIdentifiers(item).includes(figureId));
    if (!figure) {
      return softFailure("FIGURE_ID_NOT_FOUND", `figure_id was not found in the figures index: ${figureId}`, { filename, figure_id: figureId });
    }
    await writeFigureLookupIndex(filename, index).catch(() => {});
    const bbox = normalizeBbox(figure.bbox);
    if (!bbox) {
      return softFailure("FIGURE_BBOX_UNAVAILABLE", `Figure has no usable bbox: ${figureId}`, { filename, figure_id: figureId, page: figure.page || null });
    }
    return {
      ok: true,
      filename,
      figure,
      figure_id: figureId,
      page: Number(figure.page || 0),
      bbox,
      caption: String(figure.caption || figure.title || "").trim(),
      lookup_cache_hit: false,
    };
  }

  const page = Number(args.page || 0);
  const bbox = normalizeBbox(args.bbox);
  if (!Number.isInteger(page) || page < 1 || !bbox) {
    return softFailure("INVALID_INPUT", "Provide either figure_id or both page and bbox=[x0,y0,x1,y1].", {
      filename,
      page: args.page ?? null,
      bbox: Array.isArray(args.bbox) ? args.bbox : null,
    });
  }
  return { ok: true, filename, figure: null, figure_id: "", page, bbox, caption: "" };
}

function renderCachePaths(filename, target, source, scale) {
  const key = cacheKey({
    kind: "render_figure",
    filename,
    page: target.page,
    bbox: target.bbox,
    scale,
    source: pdfSourceFingerprint(source),
  });
  return {
    key,
    imagePath: safeCachePath("figure-images", filename, key, "png"),
    metaPath: safeCachePath("figure-images", filename, `${key}.meta`, "json"),
  };
}

function ocrCachePaths(filename, render, source, engine, mode = "text") {
  const payload = {
    kind: "ocr_figure",
    filename,
    page: render.page,
    bbox: render.bbox,
    scale: render.scale,
    engine,
    source: pdfSourceFingerprint(source),
  };
  if (mode && mode !== "text") payload.mode = mode;
  const key = cacheKey(payload);
  return {
    key,
    ocrPath: safeCachePath("figure-ocr", filename, key, "json"),
  };
}

function figureParserCachePaths(filename, render, source, parser, engine) {
  const kind = parser === "vl" ? FIGURE_VL_CACHE_KIND : FIGURE_STRUCTURE_CACHE_KIND;
  const key = cacheKey({
    kind,
    filename,
    page: render.page,
    bbox: render.bbox,
    scale: render.scale,
    parser,
    engine,
    source: pdfSourceFingerprint(source),
  });
  return {
    key,
    rawPath: safeCachePath(kind, filename, key, "json"),
  };
}

function semanticEvidenceCachePaths(filename, render, source, parser, engine, figureType) {
  const key = cacheKey({
    kind: FIGURE_SEMANTIC_CACHE_KIND,
    filename,
    page: render.page,
    bbox: render.bbox,
    scale: render.scale,
    parser,
    engine,
    figureType,
    source: pdfSourceFingerprint(source),
  });
  return {
    key,
    evidencePath: safeCachePath(FIGURE_SEMANTIC_CACHE_KIND, filename, key, "json"),
  };
}

function conciseText(value, maxChars = 160) {
  return compactText(String(value || ""), maxChars);
}

function uniqueStrings(values = []) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

const PARSER_TEXT_KEYS = new Set(["text", "content", "label", "rec_text", "plaintext", "plain_text", "markdown", "markdown_text"]);
const PARSER_TEXT_SKIP_KEYS = new Set([
  "bbox",
  "box",
  "boxes",
  "coordinate",
  "coordinates",
  "created_at",
  "height",
  "image_path",
  "imagepath",
  "input_path",
  "length",
  "omitted",
  "page_count",
  "page_index",
  "path",
  "reason",
  "shape",
  "source",
  "sourcefingerprint",
  "type",
  "width",
]);

function parserKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isHeavyParserKey(key) {
  const normalized = parserKey(key);
  return normalized.endsWith("_img") || normalized.endsWith("_image") || normalized.includes("base64") || normalized.includes("binary");
}

function usefulParserText(value) {
  const text = conciseText(value, 220);
  if (!text) return "";
  if (/^[A-Za-z]:\\/.test(text) || /\\indexes\\cache\\/i.test(text)) return "";
  if (/large parser (?:image|binary) payload omitted/i.test(text)) return "";
  if (/^(ndarray|image)$/i.test(text)) return "";
  if (/^(figure_title|footer|number|region|supplementaryregion|min|general)$/i.test(text)) return "";
  return text;
}

function collectParserTextBlocks(value, blocks = [], limit = 40) {
  if (blocks.length >= limit || value === null || value === undefined) return blocks;
  if (typeof value === "string") {
    const text = usefulParserText(value);
    if (text && !blocks.some((item) => item.text === text)) blocks.push({ text, source: "parser" });
    return blocks;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectParserTextBlocks(item, blocks, limit);
    return blocks;
  }
  if (typeof value === "object") {
    if (value.omitted === true) return blocks;
    for (const [key, item] of Object.entries(value)) {
      if (PARSER_TEXT_KEYS.has(parserKey(key))) collectParserTextBlocks(item, blocks, limit);
    }
    for (const [key, item] of Object.entries(value)) {
      const normalized = parserKey(key);
      if (PARSER_TEXT_KEYS.has(normalized) || PARSER_TEXT_SKIP_KEYS.has(normalized) || isHeavyParserKey(normalized)) continue;
      collectParserTextBlocks(item, blocks, limit);
    }
  }
  return blocks;
}

function labelItemsFromTextBlocks(blocks = []) {
  const labels = [];
  const seen = new Set();
  for (const block of blocks) {
    const label = conciseText(block.text || "", 80);
    if (!label || label.length > 80) continue;
    const key = normalizeForSearch(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    labels.push({ label, bbox: block.bbox || [], confidence: Number(block.confidence || 0), source: block.source || "parser" });
    if (labels.length >= 24) break;
  }
  return labels;
}

function classifySignalLabels(labels = [], pattern) {
  return labels
    .map((item) => item.label || "")
    .filter((label) => pattern.test(label))
    .slice(0, 16)
    .map((label) => ({ name: label, direction: "unknown", confidence: "observed_text" }));
}

function tableItemsFromParser(raw = {}) {
  const tables = [];
  const visit = (value) => {
    if (tables.length >= 8 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const typeText = normalizeForSearch(`${value.type || ""} ${value.label || ""} ${value.block_type || ""}`);
    if (/table/.test(typeText)) {
      tables.push({
        title: conciseText(value.title || value.label || "", 120),
        bbox: Array.isArray(value.bbox) ? value.bbox : [],
        source: "parser",
        verified: false,
      });
    }
    for (const item of Object.values(value)) visit(item);
  };
  visit(raw.items || []);
  return tables;
}

function semanticTextSources(textBlocks = [], raw = {}, parser = "ocr") {
  const result = [];
  const seen = new Set();
  const add = (text, source = "") => {
    const value = conciseText(text, 1200);
    if (!value) return;
    const key = normalizeForSearch(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push({ text: value, source: source || (parser === "ocr" ? "ocr" : "parser") });
  };
  for (const block of textBlocks) add(block.text || "", block.source || "");
  add(raw?.plainText || raw?.plain_text || "", parser === "vl" ? "vl" : "parser");
  add(raw?.markdown || raw?.markdown_text || "", parser === "vl" ? "vl" : "parser");
  return result;
}

function semanticLines(text) {
  return String(text || "")
    .split(/[\r\n;]+/)
    .map((line) => conciseText(line.replace(/\s+/g, " "), 260))
    .filter(Boolean);
}

function nodeTypeFromLabel(label) {
  const normalized = normalizeForSearch(label);
  if (!normalized) return "";
  if (/\b(bus|axi|ahb|apb|i2c|spi|usb|can|ethernet|gmii|mii|mdio)\b/.test(normalized)) return "bus";
  if (/\b(clk|clock|pclk|aclk|sclk|pll|oscillator|divider)\b/.test(normalized)) return "clock";
  if (/\b(reset|rst|resetn|rstn)\b/.test(normalized)) return "reset";
  if (/\b(irq|int|interrupt|request|req|ack|tx|rx|signal)\b/.test(normalized)) return "signal";
  if (/\b(register|reg)\b/.test(normalized) || /\b[A-Z0-9_]+_REG\b/.test(label)) return "register";
  if (/\b(controller|module|block|unit|engine|fifo|buffer|channel|mux|selector|port|pin|gpio|timer|counter|dma)\b/.test(normalized)) return "block";
  return "";
}

function technicalEndpoint(value) {
  const text = conciseText(value, 80)
    .replace(/^[\s"'`([{]+|[\s"'`)\]}]+$/g, "")
    .replace(/[,:.]+$/g, "")
    .replace(/^\s*(?:from|to|the|a|an)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length < 2 || text.length > 80) return "";
  if (text.split(/\s+/).length > 8) return "";
  if (/^(and|or|then|before|after|when|while|with|without|input|output|connected|connects|feeds|drives)$/i.test(text)) return "";
  return text;
}

function endpointLooksTechnical(text) {
  if (!text) return false;
  if (nodeTypeFromLabel(text)) return true;
  if (/[A-Z0-9_]{2,}/.test(text)) return true;
  return /^[A-Z][A-Za-z0-9_./-]+(?:\s+[A-Z][A-Za-z0-9_./-]+){0,4}$/.test(text);
}

function candidateNodesFromLabels(labels = [], parser = "ocr", figureType = "unknown") {
  const nodes = [];
  const seen = new Set();
  for (const item of labels) {
    const label = technicalEndpoint(item.label || "");
    if (!label) continue;
    if (/(?:->|=>)|\b(?:connected\s+to|connects\s+to|feeds|drives|input\s+to|output\s+(?:to|from)|to)\b/i.test(label)) continue;
    const type = nodeTypeFromLabel(label);
    const blockDiagramLabel = ["block_diagram", "sequence", "flowchart"].includes(figureType) && endpointLooksTechnical(label);
    if (!type && !blockDiagramLabel) continue;
    const key = normalizeForSearch(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    nodes.push({
      label,
      type: type || "block",
      bbox: item.bbox || [],
      source: item.source || (parser === "ocr" ? "ocr" : "parser"),
      confidence: Number(item.confidence || 0) > 0 ? "observed_text" : "low",
      verified: false,
    });
    if (nodes.length >= 24) break;
  }
  return nodes;
}

function addCandidateEdge(edges, seen, fromRaw, toRaw, relation, confidence, source, evidence, requireTechnical = false) {
  const from = technicalEndpoint(fromRaw);
  const to = technicalEndpoint(toRaw);
  if (!from || !to || normalizeForSearch(from) === normalizeForSearch(to)) return;
  if (requireTechnical && (!endpointLooksTechnical(from) || !endpointLooksTechnical(to))) return;
  const key = `${normalizeForSearch(from)}|${normalizeForSearch(to)}|${relation}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({
    from,
    to,
    relation,
    direction: "candidate",
    confidence,
    source,
    evidence: conciseText(evidence, 180),
    verified: false,
  });
}

function candidateEdgesFromText(sources = [], parser = "ocr") {
  const edges = [];
  const seen = new Set();
  for (const sourceItem of sources) {
    const source = parser === "vl" || sourceItem.source === "vl" ? "vl_text" : sourceItem.source === "ocr" ? "ocr_text" : "parser_text";
    for (const line of semanticLines(sourceItem.text)) {
      if (/(?:->|=>)/.test(line)) {
        const parts = line.split(/\s*(?:->|=>)\s*/).map((part) => technicalEndpoint(part)).filter(Boolean);
        if (parts.length > 2) {
          for (let index = 0; index < parts.length - 1; index += 1) {
            addCandidateEdge(edges, seen, parts[index], parts[index + 1], "connects_to", "medium", source, line);
          }
          if (edges.length >= 16) return edges;
          continue;
        }
      }
      let match = line.match(/^(.+?)\s*(?:->|=>)\s*(.+)$/);
      if (match) addCandidateEdge(edges, seen, match[1], match[2], "connects_to", "medium", source, line);
      match = line.match(/^from\s+(.+?)\s+to\s+(.+)$/i);
      if (match) addCandidateEdge(edges, seen, match[1], match[2], "connects_to", "low", source, line);
      match = line.match(/^(.+?)\s+(?:is\s+)?(?:connected\s+to|connects\s+to)\s+(.+)$/i);
      if (match) addCandidateEdge(edges, seen, match[1], match[2], "connects_to", "low", source, line);
      match = line.match(/^(.+?)\s+(feeds|drives)\s+(.+)$/i);
      if (match) addCandidateEdge(edges, seen, match[1], match[3], match[2].toLowerCase(), "low", source, line);
      match = line.match(/^(.+?)\s+(?:is\s+)?input\s+to\s+(.+)$/i);
      if (match) addCandidateEdge(edges, seen, match[1], match[2], "input_to", "low", source, line);
      match = line.match(/^(.+?)\s+(?:is\s+)?output\s+to\s+(.+)$/i);
      if (match) addCandidateEdge(edges, seen, match[1], match[2], "output_to", "low", source, line);
      match = line.match(/^output\s+from\s+(.+?)\s+to\s+(.+)$/i);
      if (match) addCandidateEdge(edges, seen, match[1], match[2], "output_to", "low", source, line);
      match = line.match(/^(.+?)\s+to\s+(.+)$/i);
      if (match) addCandidateEdge(edges, seen, match[1], match[2], "connects_to", "low", source, line, true);
      if (edges.length >= 16) return edges;
    }
  }
  return edges;
}

function timingConstraintsFromText(sources = [], parser = "ocr") {
  const constraints = [];
  const seen = new Set();
  const timingPattern = /\b(rising edge|falling edge|setup|hold|delay|before|after|cycle|clock)\b/i;
  for (const sourceItem of sources) {
    const source = parser === "vl" || sourceItem.source === "vl" ? "vl_text" : sourceItem.source === "ocr" ? "ocr_text" : "parser_text";
    for (const line of semanticLines(sourceItem.text)) {
      if (!timingPattern.test(line)) continue;
      const description = conciseText(line, 180);
      const key = normalizeForSearch(description);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      constraints.push({
        description,
        edge: /rising edge/i.test(line) ? "rising" : /falling edge/i.test(line) ? "falling" : "unknown",
        confidence: "low",
        source,
        verified: false,
      });
      if (constraints.length >= 12) return constraints;
    }
  }
  return constraints;
}

function sequenceStepsFromText(sources = [], parser = "ocr", figureType = "unknown") {
  const steps = [];
  const seen = new Set();
  const addStep = (text, source) => {
    const value = conciseText(text, 180);
    const key = normalizeForSearch(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    steps.push({ index: steps.length + 1, text: value, source, confidence: "low", verified: false });
  };
  for (const sourceItem of sources) {
    const source = parser === "vl" || sourceItem.source === "vl" ? "vl_text" : sourceItem.source === "ocr" ? "ocr_text" : "parser_text";
    for (const line of semanticLines(sourceItem.text)) {
      let match = line.match(/^\s*(?:step\s*)?(\d{1,2})[\).:-]\s+(.{3,180})$/i);
      if (match) addStep(match[2], source);
      match = line.match(/^\s*[-*]\s+(.{3,180})$/);
      if (match) addStep(match[1], source);
      if (["sequence", "flowchart"].includes(figureType) && line.includes("->")) {
        for (const part of line.split("->")) addStep(part, source);
      }
      if (steps.length >= 16) return steps;
    }
  }
  return steps;
}

function rawArtifactKind(parser) {
  if (parser === "structure") return "structure";
  if (parser === "vl") return "vl";
  return "text";
}

function unavailableSemanticEvidence({ filename, source, render = {}, figureType = "unknown", parser = "ocr", engine = "paddleocr", warning = "", rawPath = "", rawCached = false } = {}) {
  const normalizedFigureType = normalizeFigureType(figureType);
  const warnings = uniqueStrings([warning]);
  return {
    schemaVersion: FIGURE_SEMANTIC_SCHEMA_VERSION,
    filename,
    source: source || null,
    figure_id: render.figure_id || "",
    page: render.page || null,
    bbox: render.bbox || [],
    figure_type: normalizedFigureType,
    parser,
    engine,
    direct_visual_observations: [],
    extracted_items: {
      text_blocks: [],
      labels: [],
      nodes: [],
      edges: [],
      signals: [],
      clocks: [],
      resets: [],
      timing_constraints: [],
      sequence_steps: [],
      tables: [],
    },
    related_registers: [],
    related_bitfields: [],
    engineering_inferences: [],
    source_implications: [],
    uncertainties: ["No parser output is available for this figure; inspect the rendered image and nearby manual text before drawing conclusions."],
    warnings,
    raw_artifact: {
      path: rawPath,
      kind: rawArtifactKind(parser),
      cached: Boolean(rawCached),
    },
  };
}

export function buildSemanticEvidence({ filename, source, render = {}, figureType = "unknown", parser = "ocr", engine = "paddleocr", ocr = null, raw = null, rawPath = "", rawCached = false, extraWarnings = [] } = {}) {
  const normalizedFigureType = normalizeFigureType(figureType);
  const textBlocks = [];
  if (ocr && Array.isArray(ocr.ocr_text)) {
    for (const item of ocr.ocr_text.slice(0, 60)) {
      const text = conciseText(item.text || "", 220);
      if (!text) continue;
      textBlocks.push({
        text,
        bbox: item.bbox || [],
        image_bbox: item.image_bbox || [],
        confidence: Number(item.confidence || 0),
        source: "ocr",
      });
    }
  }
  if (raw && raw.items) collectParserTextBlocks(raw.items, textBlocks, 60);
  if (raw?.plainText && textBlocks.length < 60) collectParserTextBlocks(raw.plainText, textBlocks, 60);
  if (raw?.plain_text && textBlocks.length < 60) collectParserTextBlocks(raw.plain_text, textBlocks, 60);
  if (raw?.markdown && textBlocks.length < 60) collectParserTextBlocks(raw.markdown, textBlocks, 60);
  const labels = labelItemsFromTextBlocks(textBlocks);
  const semanticSources = semanticTextSources(textBlocks, raw, parser);
  const nodes = candidateNodesFromLabels(labels, parser, normalizedFigureType);
  const edges = candidateEdgesFromText(semanticSources, parser);
  const timingConstraints = timingConstraintsFromText(semanticSources, parser);
  const sequenceSteps = sequenceStepsFromText(semanticSources, parser, normalizedFigureType);
  const warnings = uniqueStrings([
    ...(Array.isArray(render.warnings) ? render.warnings : []),
    ...(ocr && Array.isArray(ocr.warnings) ? ocr.warnings : []),
    ...(raw && Array.isArray(raw.warnings) ? raw.warnings : []),
    ...extraWarnings,
  ]);
  const uncertainties = [
    "Connector, arrow, signal direction, and timing-edge relationships are unverified unless separately confirmed by manual text/register/sequence/caution evidence.",
  ];
  if (edges.length) {
    uncertainties.push("Candidate edges are derived only from explicit OCR/parser text phrases; visual connector geometry and direction are not verified.");
  }
  if (timingConstraints.length) {
    uncertainties.push("Candidate timing constraints are text hints only and must be verified against the rendered diagram and manual timing tables.");
  }
  if (sequenceSteps.length) {
    uncertainties.push("Candidate sequence steps are parser/OCR text observations and do not verify flowchart ordering by themselves.");
  }
  if (parser === "vl") {
    uncertainties.push("PaddleOCR-VL visual graph edges are treated as unverified observations/inferences until cross-checked.");
  }
  return {
    schemaVersion: FIGURE_SEMANTIC_SCHEMA_VERSION,
    filename,
    source: source || null,
    figure_id: render.figure_id || "",
    page: render.page || raw?.page || null,
    bbox: render.bbox || raw?.bbox || [],
    figure_type: normalizedFigureType,
    parser,
    engine,
    direct_visual_observations: [
      ...(render.image_path ? [`Rendered figure crop is available at ${render.image_path}.`] : []),
      ...(textBlocks.length ? [`Parser/OCR produced ${textBlocks.length} concise text block(s).`] : []),
      ...(raw?.itemCount !== undefined ? [`Raw ${parser} parser artifact contains ${Number(raw.itemCount || 0)} top-level item(s).`] : []),
      ...(nodes.length ? [`Semantic normalizer found ${nodes.length} candidate node label(s) from parser/OCR text.`] : []),
      ...(edges.length ? [`Semantic normalizer found ${edges.length} candidate relation(s) from explicit text phrases.`] : []),
      ...(timingConstraints.length ? [`Semantic normalizer found ${timingConstraints.length} timing hint(s) from parser/OCR text.`] : []),
      ...(sequenceSteps.length ? [`Semantic normalizer found ${sequenceSteps.length} candidate sequence step(s) from parser/OCR text.`] : []),
    ],
    extracted_items: {
      text_blocks: textBlocks.slice(0, 40),
      labels,
      nodes,
      edges,
      signals: classifySignalLabels(labels, /irq|int|interrupt|req|ack|tx|rx|dma|signal/i),
      clocks: classifySignalLabels(labels, /clk|clock|pclk|aclk|sclk/i),
      resets: classifySignalLabels(labels, /reset|rst|resetn|rstn/i),
      timing_constraints: timingConstraints,
      sequence_steps: sequenceSteps,
      tables: raw ? tableItemsFromParser(raw) : [],
    },
    related_registers: [],
    related_bitfields: [],
    engineering_inferences: [],
    source_implications: [],
    uncertainties,
    warnings,
    raw_artifact: {
      path: rawPath,
      kind: rawArtifactKind(parser),
      cached: Boolean(rawCached),
    },
  };
}

async function writeSemanticEvidenceCache(filename, render, source, parser, engine, figureType, evidence) {
  const paths = semanticEvidenceCachePaths(filename, render, source, parser, engine, figureType);
  await atomicWriteJson(paths.evidencePath, evidence).catch(() => {});
  return paths;
}

export async function renderFigureOnDemand(args = {}) {
  const filename = String(args.filename || "").trim();
  try {
    ensurePdfFilename(filename);
  } catch (error) {
    return failureFromError(error, "INVALID_INPUT", { filename });
  }

  const scale = normalizeScale(args.scale);
  const target = await resolveFigureTarget(filename, args);
  if (!target.ok) return { scale, ...target };

  let source;
  try {
    source = await getPdfSourceInfo(filename);
  } catch (error) {
    return failureFromError(error, "PDF_NOT_FOUND", { filename, page: target.page, figure_id: target.figure_id || "" });
  }

  const paths = renderCachePaths(filename, target, source, scale);
  const force = Boolean(args.force);
  if (!force && await pathExists(paths.imagePath) && await pathExists(paths.metaPath)) {
    try {
      const cached = await readJsonCached(paths.metaPath);
      return { ...cached, cache_hit: true, image_path: paths.imagePath };
    } catch {
      // Re-render below when metadata is unreadable.
    }
  }

  const { requestId, workerRoot, cancelPath } = await prepareWorkerRoot("figure.render");
  try {
    const worker = await runPythonWorker({
      requestId,
      operation: "figure.render",
      allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
      inputs: { filename, pdfPath: safePdfPath(filename) },
      outputs: { imagePath: paths.imagePath, cancelPath },
      options: { page: target.page, bbox: target.bbox, scale, force },
    }, {
      timeoutMs: args.timeoutMs || 120_000,
      onProgress: args.onProgress,
      onSpawn: args.onWorkerSpawn,
      onStderr: args.onWorkerStderr,
    });
    const result = worker.result || {};
    if (result.ok === false) {
      return {
        ok: false,
        filename,
        page: target.page,
        figure_id: target.figure_id || "",
        bbox: target.bbox,
        scale,
        error_code: result.error_code || "PDF_RENDER_FAILED",
        message: result.message || "PDF render failed",
        warnings: result.warnings || [],
      };
    }
    const output = {
      ok: true,
      filename,
      page: target.page,
      page_count: result.pageCount || result.page_count || null,
      figure_id: target.figure_id || "",
      caption: target.caption || "",
      bbox: result.bbox || target.bbox,
      scale,
      image_path: paths.imagePath,
      cache_key: paths.key,
      cache_hit: Boolean(result.cache_hit),
      lookup_cache_hit: Boolean(target.lookup_cache_hit),
      source_fingerprint: pdfSourceFingerprint(source),
      provenance: {
        tool: "render_figure",
        source_pdf: safePdfPath(filename),
        figures_index: target.figure_id ? safeFiguresIndexPath(filename) : "",
        figures_lookup: target.figure_id ? safeFigureLookupIndexPath(filename) : "",
      },
      warnings: [...(target.warnings || []), ...(result.warnings || [])].filter(Boolean),
    };
    await atomicWriteJson(paths.metaPath, output);
    return output;
  } catch (error) {
    return failureFromError(error, "PDF_RENDER_FAILED", { filename, page: target.page, figure_id: target.figure_id || "", bbox: target.bbox, scale });
  } finally {
    await fs.rm(workerRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function figureParserOnDemand(args = {}, parser = "structure", existingRender = null, requestedFigureType = "unknown") {
  const engine = normalizeOcrEngine(args.engine);
  const render = existingRender || await renderFigureOnDemand(args);
  if (!render.ok) {
    return {
      ...render,
      parser,
      engine,
      raw: null,
      semantic_evidence: unavailableSemanticEvidence({
        filename: render.filename || args.filename || "",
        render,
        figureType: requestedFigureType,
        parser,
        engine,
        warning: render.message || "Figure render failed.",
      }),
    };
  }
  let source;
  try {
    source = await getPdfSourceInfo(render.filename);
  } catch (error) {
    const failure = failureFromError(error, "PDF_NOT_FOUND", { filename: render.filename, page: render.page, image_path: render.image_path });
    return {
      ...failure,
      parser,
      engine,
      raw: null,
      semantic_evidence: unavailableSemanticEvidence({
        filename: render.filename,
        render,
        figureType: requestedFigureType,
        parser,
        engine,
        warning: failure.message,
      }),
    };
  }
  if (engine === "none") {
    const semantic = unavailableSemanticEvidence({
      filename: render.filename,
      source,
      render,
      figureType: requestedFigureType,
      parser,
      engine: "none",
      warning: "engine=none skips OCR/parser work and returns no parsed figure evidence.",
    });
    return {
      ok: false,
      filename: render.filename,
      page: render.page,
      page_count: render.page_count || null,
      figure_id: render.figure_id || "",
      caption: render.caption || "",
      bbox: render.bbox,
      scale: render.scale,
      parser,
      engine: "none",
      image_path: render.image_path,
      error_code: `${parser.toUpperCase()}_PARSER_DISABLED`,
      message: "OCR/parser engine was disabled by request.",
      warnings: semantic.warnings,
      raw_artifact: semantic.raw_artifact,
      semantic_evidence: semantic,
    };
  }
  const health = await getOcrHealth({ timeoutMs: Math.min(Number(args.timeoutMs || 10_000), 30_000) });
  const capability = health.ocr?.[parser] || {};
  const paths = figureParserCachePaths(render.filename, render, source, parser, engine);
  const force = Boolean(args.force);
  if (!force && await pathExists(paths.rawPath)) {
    try {
      const raw = await readJsonCached(paths.rawPath);
      const semantic = buildSemanticEvidence({
        filename: render.filename,
        source,
        render,
        figureType: requestedFigureType,
        parser,
        engine: raw.engine || health.ocr?.engine || "paddleocr",
        raw,
        rawPath: paths.rawPath,
        rawCached: true,
      });
      const semanticPaths = await writeSemanticEvidenceCache(render.filename, render, source, parser, engine, requestedFigureType, semantic);
      return {
        ok: raw.ok !== false,
        filename: render.filename,
        page: render.page,
        page_count: render.page_count || null,
        figure_id: render.figure_id || "",
        caption: render.caption || "",
        bbox: render.bbox,
        scale: render.scale,
        parser,
        engine: raw.engine || "paddleocr",
        image_path: render.image_path,
        cache_key: paths.key,
        cache_hit: true,
        raw_artifact: { path: paths.rawPath, kind: rawArtifactKind(parser), cached: true },
        plain_text: conciseText(raw.plainText || raw.plain_text || "", 1000),
        error_code: raw.ok === false ? raw.error_code || `${parser.toUpperCase()}_PARSER_UNAVAILABLE` : "",
        message: raw.ok === false ? raw.message || `${parser} parser unavailable` : "",
        hint: raw.hint || "",
        warnings: [...(render.warnings || []), ...(raw.warnings || [])].filter(Boolean),
        semantic_evidence: semantic,
        semantic_cache_key: semanticPaths.key,
        semantic_cache_path: semanticPaths.evidencePath,
      };
    } catch {
      // Re-run parser below when cached raw parser metadata is unreadable.
    }
  }
  if (!capability.available) {
    const warning = capability.hint || capability.reason || `${parser} parser unavailable`;
    const semantic = unavailableSemanticEvidence({
      filename: render.filename,
      source,
      render,
      figureType: requestedFigureType,
      parser,
      engine: health.ocr?.engine || "paddleocr",
      rawPath: "",
      rawCached: false,
      warning,
    });
    const semanticPaths = await writeSemanticEvidenceCache(render.filename, render, source, parser, engine, requestedFigureType, semantic);
    return {
      ok: false,
      filename: render.filename,
      page: render.page,
      page_count: render.page_count || null,
      figure_id: render.figure_id || "",
      caption: render.caption || "",
      bbox: render.bbox,
      scale: render.scale,
      parser,
      engine: health.ocr?.engine || "paddleocr",
      image_path: render.image_path,
      cache_key: paths.key,
      cache_hit: false,
      raw_artifact: semantic.raw_artifact,
      plain_text: "",
      error_code: `${parser.toUpperCase()}_PARSER_UNAVAILABLE`,
      message: capability.reason || `${parser} parser unavailable`,
      hint: capability.hint || (parser === "vl" ? OCR_VL_INSTALL_HINT : OCR_STRUCTURE_INSTALL_HINT),
      health,
      warnings: [...(render.warnings || []), warning].filter(Boolean),
      semantic_evidence: semantic,
      semantic_cache_key: semanticPaths.key,
      semantic_cache_path: semanticPaths.evidencePath,
    };
  }

  const { requestId, workerRoot, cancelPath } = await prepareWorkerRoot(`figure.${parser}`);
  const tempPath = path.join(workerRoot, `${parser}.json`);
  try {
    const worker = await runPythonWorker({
      requestId,
      operation: parser === "vl" ? "figure.vl" : "figure.structure",
      allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
      inputs: { filename: render.filename, pdfPath: safePdfPath(render.filename), imagePath: render.image_path },
      outputs: { artifactPath: tempPath, cancelPath },
      options: { page: render.page, bbox: render.bbox, scale: render.scale, engine, force },
    }, {
      timeoutMs: args.timeoutMs || 300_000,
      onProgress: args.onProgress,
      onSpawn: args.onWorkerSpawn,
      onStderr: args.onWorkerStderr,
    });
    const descriptor = worker.artifacts.find((entry) => entry.kind === `figure_${parser}`) || worker.result?.artifact;
    if (!descriptor) throw new PythonWorkerError("PROTOCOL_ERROR", `Python worker did not return ${parser} artifact metadata`);
    const validated = await validateWorkerArtifact(descriptor, { workerRoot, filename: render.filename, source });
    await atomicPromoteWorkerArtifact(validated.tempPath, paths.rawPath);
    const raw = await readJsonCached(paths.rawPath);
    const semantic = buildSemanticEvidence({
      filename: render.filename,
      source,
      render,
      figureType: requestedFigureType,
      parser,
      engine: raw.engine || health.ocr?.engine || "paddleocr",
      raw,
      rawPath: paths.rawPath,
      rawCached: false,
    });
    const semanticPaths = await writeSemanticEvidenceCache(render.filename, render, source, parser, engine, requestedFigureType, semantic);
    return {
      ok: raw.ok !== false,
      filename: render.filename,
      page: render.page,
      page_count: render.page_count || null,
      figure_id: render.figure_id || "",
      caption: render.caption || "",
      bbox: render.bbox,
      scale: render.scale,
      parser,
      engine: raw.engine || "paddleocr",
      image_path: render.image_path,
      cache_key: paths.key,
      cache_hit: false,
      raw_artifact: { path: paths.rawPath, kind: rawArtifactKind(parser), cached: false },
      plain_text: conciseText(raw.plainText || raw.plain_text || "", 1000),
      error_code: raw.ok === false ? raw.error_code || `${parser.toUpperCase()}_PARSER_UNAVAILABLE` : "",
      message: raw.ok === false ? raw.message || `${parser} parser unavailable` : "",
      hint: raw.hint || "",
      health: raw.ok === false ? health : undefined,
      warnings: [...(render.warnings || []), ...(raw.warnings || [])].filter(Boolean),
      semantic_evidence: semantic,
      semantic_cache_key: semanticPaths.key,
      semantic_cache_path: semanticPaths.evidencePath,
    };
  } catch (error) {
    const warning = `${parser} parser worker unavailable: ${error instanceof Error ? error.message : String(error)}`;
    const semantic = unavailableSemanticEvidence({
      filename: render.filename,
      source,
      render,
      figureType: requestedFigureType,
      parser,
      engine,
      warning,
    });
    const semanticPaths = await writeSemanticEvidenceCache(render.filename, render, source, parser, engine, requestedFigureType, semantic);
    return {
      ok: false,
      filename: render.filename,
      page: render.page,
      page_count: render.page_count || null,
      figure_id: render.figure_id || "",
      caption: render.caption || "",
      bbox: render.bbox,
      scale: render.scale,
      parser,
      engine,
      image_path: render.image_path,
      cache_key: paths.key,
      cache_hit: false,
      raw_artifact: semantic.raw_artifact,
      plain_text: "",
      error_code: `${parser.toUpperCase()}_PARSER_FAILED`,
      message: error instanceof Error ? error.message : String(error),
      warnings: [...(render.warnings || []), warning].filter(Boolean),
      semantic_evidence: semantic,
      semantic_cache_key: semanticPaths.key,
      semantic_cache_path: semanticPaths.evidencePath,
    };
  } finally {
    await fs.rm(workerRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function ocrFigureOnDemand(args = {}) {
  const engine = normalizeOcrEngine(args.engine);
  const requestedMode = normalizeOcrFigureMode(args.mode, "text");
  let effectiveMode = requestedMode;
  if (requestedMode === "auto") {
    const health = await getOcrHealth({ timeoutMs: Math.min(Number(args.timeoutMs || 10_000), 30_000) });
    effectiveMode = selectOcrMode("auto", health);
  }
  const render = await renderFigureOnDemand(args);
  if (!render.ok) return { ...render, engine, mode: effectiveMode, parser: effectiveMode === "text" ? "ocr" : effectiveMode, ocr_text: [], plain_text: "" };

  if (effectiveMode === "structure" || effectiveMode === "vl") {
    const parsed = await figureParserOnDemand(args, effectiveMode, render, normalizeFigureType(args.figure_type || args.mode_hint || "unknown"));
    const textBlocks = parsed.semantic_evidence?.extracted_items?.text_blocks || [];
    return {
      ...parsed,
      mode: effectiveMode,
      ocr_text: textBlocks.slice(0, 60).map((item) => ({
        text: item.text || "",
        bbox: item.bbox || [],
        image_bbox: item.image_bbox || [],
        confidence: Number(item.confidence || 0),
      })),
      confidence_avg: 0,
    };
  }

  if (engine === "none") {
    const semantic = unavailableSemanticEvidence({
      filename: render.filename,
      render,
      figureType: "unknown",
      parser: "ocr",
      engine: "none",
      warning: "engine=none skips OCR and returns no text.",
    });
    return {
      ok: false,
      filename: render.filename,
      page: render.page,
      page_count: render.page_count || null,
      figure_id: render.figure_id || "",
      bbox: render.bbox,
      engine: "none",
      mode: "text",
      parser: "ocr",
      cache_hit: false,
      image_path: render.image_path,
      ocr_text: [],
      plain_text: "",
      error_code: "OCR_ENGINE_DISABLED",
      message: "OCR engine was disabled by request.",
      warnings: ["engine=none skips OCR and returns no text."],
      semantic_evidence: semantic,
    };
  }

  let source;
  try {
    source = await getPdfSourceInfo(render.filename);
  } catch (error) {
    return failureFromError(error, "PDF_NOT_FOUND", { filename: render.filename, page: render.page, image_path: render.image_path });
  }

  const paths = ocrCachePaths(render.filename, render, source, engine, "text");
  const force = Boolean(args.force);
  if (!force && await pathExists(paths.ocrPath)) {
    try {
      const cached = await readJsonCached(paths.ocrPath);
      const semantic = buildSemanticEvidence({
        filename: render.filename,
        source,
        render,
        figureType: "unknown",
        parser: "ocr",
        engine: cached.engine || "paddleocr",
        ocr: cached,
        rawPath: paths.ocrPath,
        rawCached: true,
      });
      const semanticPaths = await writeSemanticEvidenceCache(render.filename, render, source, "ocr", cached.engine || engine, "unknown", semantic);
      return {
        ...cached,
        mode: "text",
        parser: "ocr",
        cache_hit: true,
        image_cache_hit: Boolean(render.cache_hit),
        image_path: render.image_path,
        raw_artifact: { path: paths.ocrPath, kind: "text", cached: true },
        semantic_evidence: semantic,
        semantic_cache_key: semanticPaths.key,
        semantic_cache_path: semanticPaths.evidencePath,
      };
    } catch {
      // Re-run OCR below when metadata is unreadable.
    }
  }

  const health = await getOcrHealth({ timeoutMs: Math.min(Number(args.timeoutMs || 10_000), 30_000) });
  if (!health.ocr?.available) {
    return {
      ok: false,
      filename: render.filename,
      page: render.page,
      page_count: render.page_count || null,
      figure_id: render.figure_id || "",
      caption: render.caption || "",
      bbox: render.bbox,
      scale: render.scale,
      engine: health.ocr?.engine || "paddleocr",
      mode: "text",
      parser: "ocr",
      cache_hit: false,
      image_cache_hit: Boolean(render.cache_hit),
      image_path: render.image_path,
      ocr_text: [],
      plain_text: "",
      error_code: "OCR_ENGINE_UNAVAILABLE",
      message: "PaddleOCR is not installed or not importable.",
      hint: health.ocr?.hint || OCR_INSTALL_HINT,
      health,
      ocr_health_cache_hit: Boolean(health.ocr_health_cache_hit || health.cache_hit),
      warnings: [...(render.warnings || []), health.ocr?.hint || OCR_INSTALL_HINT].filter(Boolean),
      semantic_evidence: unavailableSemanticEvidence({
        filename: render.filename,
        source,
        render,
        figureType: "unknown",
        parser: "ocr",
        engine: health.ocr?.engine || "paddleocr",
        warning: health.ocr?.hint || OCR_INSTALL_HINT,
      }),
    };
  }

  const { requestId, workerRoot, cancelPath } = await prepareWorkerRoot("ocr.image");
  try {
    const worker = await runPythonWorker({
      requestId,
      operation: "ocr.image",
      allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
      inputs: { filename: render.filename, pdfPath: safePdfPath(render.filename), imagePath: render.image_path },
      outputs: { cancelPath },
      options: { engine, bbox: render.bbox, scale: render.scale },
    }, {
      timeoutMs: args.timeoutMs || 180_000,
      onProgress: args.onProgress,
      onSpawn: args.onWorkerSpawn,
      onStderr: args.onWorkerStderr,
    });
    const result = worker.result || {};
    if (result.ok === false) {
      return {
        ok: false,
        filename: render.filename,
        page: render.page,
        page_count: render.page_count || null,
        figure_id: render.figure_id || "",
        bbox: render.bbox,
        engine: result.engine || "paddleocr",
        mode: "text",
        parser: "ocr",
        cache_hit: false,
        image_path: render.image_path,
        ocr_text: [],
        plain_text: "",
        error_code: result.error_code || "OCR_FAILED",
        message: result.message || result.error || "OCR failed",
        hint: result.hint || "",
        health: result.health || null,
        warnings: [...(render.warnings || []), ...(result.warnings || [])].filter(Boolean),
        semantic_evidence: unavailableSemanticEvidence({
          filename: render.filename,
          source,
          render,
          figureType: "unknown",
          parser: "ocr",
          engine: result.engine || "paddleocr",
          warning: result.message || result.error || "OCR failed",
        }),
      };
    }
    const items = Array.isArray(result.ocr_text) ? result.ocr_text : [];
    const output = {
      ok: true,
      filename: render.filename,
      page: render.page,
      page_count: render.page_count || null,
      figure_id: render.figure_id || "",
      caption: render.caption || "",
      bbox: render.bbox,
      scale: render.scale,
      engine: result.engine || "paddleocr",
      mode: "text",
      parser: "ocr",
      cache_key: paths.key,
      cache_hit: false,
      image_cache_hit: Boolean(render.cache_hit),
      lookup_cache_hit: Boolean(render.lookup_cache_hit),
      image_path: render.image_path,
      ocr_text: items,
      plain_text: String(result.plain_text || items.map((item) => item.text).join(" ")).trim(),
      confidence_avg: Number(result.confidence_avg || 0),
      source_fingerprint: pdfSourceFingerprint(source),
      warnings: [...(render.warnings || []), ...(result.warnings || [])].filter(Boolean),
    };
    await atomicWriteJson(paths.ocrPath, output);
    const semantic = buildSemanticEvidence({
      filename: render.filename,
      source,
      render,
      figureType: "unknown",
      parser: "ocr",
      engine: output.engine,
      ocr: output,
      rawPath: paths.ocrPath,
      rawCached: false,
    });
    const semanticPaths = await writeSemanticEvidenceCache(render.filename, render, source, "ocr", output.engine, "unknown", semantic);
    output.raw_artifact = { path: paths.ocrPath, kind: "text", cached: false };
    output.semantic_evidence = semantic;
    output.semantic_cache_key = semanticPaths.key;
    output.semantic_cache_path = semanticPaths.evidencePath;
    return output;
  } catch (error) {
    return failureFromError(error, "OCR_FAILED", {
      filename: render.filename,
      page: render.page,
      page_count: render.page_count || null,
      figure_id: render.figure_id || "",
      bbox: render.bbox,
      engine,
      mode: "text",
      parser: "ocr",
      image_path: render.image_path,
      ocr_text: [],
      plain_text: "",
      warnings: render.warnings || [],
    });
  } finally {
    await fs.rm(workerRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function ocrFigureForInspect(args = {}) {
  const engine = normalizeOcrEngine(args.engine || "auto");
  const filename = String(args.filename || "").trim();
  try {
    ensurePdfFilename(filename);
  } catch (error) {
    return { ocr: failureFromError(error, "INVALID_INPUT", { filename }), target: null };
  }

  if (engine === "none") {
    return { ocr: await ocrFigureOnDemand({ ...args, engine }), target: null };
  }

  const scale = normalizeScale(args.scale);
  const target = await resolveFigureTarget(filename, args);
  if (!target.ok) return { ocr: { scale, ...target, engine, ocr_text: [], plain_text: "" }, target: null };

  let source;
  try {
    source = await getPdfSourceInfo(filename);
  } catch (error) {
    return { ocr: failureFromError(error, "PDF_NOT_FOUND", { filename, page: target.page, figure_id: target.figure_id || "" }), target };
  }

  const renderPaths = renderCachePaths(filename, target, source, scale);
  const ocrPaths = ocrCachePaths(filename, { ...target, scale }, source, engine, "text");
  const force = Boolean(args.force);
  if (!force && await pathExists(renderPaths.imagePath) && await pathExists(ocrPaths.ocrPath)) {
    try {
      const cached = await readJsonCached(ocrPaths.ocrPath);
      return {
        ocr: {
          ...cached,
          cache_hit: true,
          image_path: renderPaths.imagePath,
          lookup_cache_hit: Boolean(target.lookup_cache_hit),
        },
        target,
      };
    } catch {
      // Fall through to combined worker when cached OCR metadata is unreadable.
    }
  }

  const health = await getOcrHealth({ timeoutMs: Math.min(Number(args.timeoutMs || 10_000), 30_000) });
  if (!health.ocr?.available) {
    const fallback = await ocrFigureOnDemand({ ...args, engine });
    return {
      ocr: {
        ...fallback,
        ocr_health_cache_hit: Boolean(health.ocr_health_cache_hit || health.cache_hit),
      },
      target,
    };
  }

  const { requestId, workerRoot, cancelPath } = await prepareWorkerRoot("figure.inspect_basic");
  try {
    const worker = await runPythonWorker({
      requestId,
      operation: "figure.inspect_basic",
      allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
      inputs: { filename, pdfPath: safePdfPath(filename) },
      outputs: { imagePath: renderPaths.imagePath, cancelPath },
      options: { page: target.page, bbox: target.bbox, scale, engine, force },
    }, {
      timeoutMs: args.timeoutMs || 180_000,
      onProgress: args.onProgress,
      onSpawn: args.onWorkerSpawn,
      onStderr: args.onWorkerStderr,
    });
    const result = worker.result || {};
    if (result.ok === false) {
      return {
        ocr: {
          ok: false,
          filename,
          page: target.page,
          figure_id: target.figure_id || "",
          bbox: target.bbox,
          scale,
          engine,
          cache_hit: false,
          image_path: renderPaths.imagePath,
          ocr_text: [],
          plain_text: "",
          error_code: result.error_code || "FIGURE_INSPECT_FAILED",
          message: result.message || "Figure inspect worker failed",
          warnings: result.warnings || [],
        },
        target,
      };
    }

    const renderResult = result.render || {};
    if (renderResult.ok === false) {
      return {
        ocr: {
          ok: false,
          filename,
          page: target.page,
          figure_id: target.figure_id || "",
          bbox: target.bbox,
          scale,
          engine,
          cache_hit: false,
          image_path: renderPaths.imagePath,
          ocr_text: [],
          plain_text: "",
          error_code: renderResult.error_code || "PDF_RENDER_FAILED",
          message: renderResult.message || "PDF render failed",
          warnings: renderResult.warnings || [],
        },
        target,
      };
    }

    const renderOutput = {
      ok: true,
      filename,
      page: target.page,
      page_count: renderResult.pageCount || renderResult.page_count || null,
      figure_id: target.figure_id || "",
      caption: target.caption || "",
      bbox: renderResult.bbox || target.bbox,
      scale,
      image_path: renderPaths.imagePath,
      cache_key: renderPaths.key,
      cache_hit: Boolean(renderResult.cache_hit),
      lookup_cache_hit: Boolean(target.lookup_cache_hit),
      source_fingerprint: pdfSourceFingerprint(source),
      provenance: {
        tool: "render_figure",
        source_pdf: safePdfPath(filename),
        figures_index: target.figure_id ? safeFiguresIndexPath(filename) : "",
        figures_lookup: target.figure_id ? safeFigureLookupIndexPath(filename) : "",
      },
      warnings: [...(target.warnings || []), ...(renderResult.warnings || [])].filter(Boolean),
    };
    await atomicWriteJson(renderPaths.metaPath, renderOutput);

    const ocrResult = result.ocr || {};
    if (ocrResult.ok === false) {
      return {
        ocr: {
          ok: false,
          filename,
          page: target.page,
          page_count: renderOutput.page_count,
          figure_id: target.figure_id || "",
          caption: target.caption || "",
          bbox: renderOutput.bbox,
          scale,
          engine: ocrResult.engine || "paddleocr",
          cache_hit: false,
          image_cache_hit: Boolean(renderOutput.cache_hit),
          image_path: renderPaths.imagePath,
          ocr_text: [],
          plain_text: "",
          error_code: ocrResult.error_code || "OCR_FAILED",
          message: ocrResult.message || ocrResult.error || "OCR failed",
          hint: ocrResult.hint || "",
          health: ocrResult.health || null,
          warnings: [...(renderOutput.warnings || []), ...(ocrResult.warnings || [])].filter(Boolean),
        },
        target,
      };
    }

    const items = Array.isArray(ocrResult.ocr_text) ? ocrResult.ocr_text : [];
    const output = {
      ok: true,
      filename,
      page: target.page,
      page_count: renderOutput.page_count,
      figure_id: target.figure_id || "",
      caption: target.caption || "",
      bbox: renderOutput.bbox,
      scale,
      engine: ocrResult.engine || "paddleocr",
      cache_key: ocrPaths.key,
      cache_hit: false,
      image_cache_hit: Boolean(renderOutput.cache_hit),
      lookup_cache_hit: Boolean(target.lookup_cache_hit),
      image_path: renderPaths.imagePath,
      ocr_text: items,
      plain_text: String(ocrResult.plain_text || items.map((item) => item.text).join(" ")).trim(),
      confidence_avg: Number(ocrResult.confidence_avg || 0),
      source_fingerprint: pdfSourceFingerprint(source),
      warnings: [...(renderOutput.warnings || []), ...(ocrResult.warnings || [])].filter(Boolean),
    };
    await atomicWriteJson(ocrPaths.ocrPath, output);
    return { ocr: output, target };
  } catch (error) {
    const fallback = await ocrFigureOnDemand({ ...args, engine });
    return {
      ocr: {
        ...fallback,
        warnings: [...(fallback.warnings || []), `Combined inspect worker unavailable: ${error instanceof Error ? error.message : String(error)}`],
      },
      target,
    };
  } finally {
    await fs.rm(workerRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function pageContextCachePath(filename, source, page) {
  const key = cacheKey({
    kind: PAGE_CONTEXT_CACHE_KIND,
    filename,
    page,
    source: pdfSourceFingerprint(source),
  });
  return { key, cachePath: safeCachePath(PAGE_CONTEXT_CACHE_KIND, filename, key, "json") };
}

async function readCachedContextPage(filename, source, pageNumber) {
  const contextCache = pageContextCachePath(filename, source, pageNumber);
  if (!(await pathExists(contextCache.cachePath))) return { page: null, cache: contextCache };
  const cached = await readJsonCached(contextCache.cachePath);
  if (
    cached.schemaVersion === PAGE_CONTEXT_CACHE_SCHEMA_VERSION &&
    cached.filename === filename &&
    Number(cached.page) === pageNumber &&
    typeof cached.text === "string" &&
    (!cached.source || isSamePdfSource(cached.source, source))
  ) {
    return {
      page: { page: pageNumber, text: compactText(cached.text || "", 3500) },
      cache: contextCache,
    };
  }
  return { page: null, cache: contextCache };
}

async function writeCachedContextPage(filename, source, pageNumber, text) {
  const contextCache = pageContextCachePath(filename, source, pageNumber);
  await atomicWriteJson(contextCache.cachePath, {
    schemaVersion: PAGE_CONTEXT_CACHE_SCHEMA_VERSION,
    filename,
    page: pageNumber,
    source,
    sourceFingerprint: pdfSourceFingerprint(source),
    text: String(text || ""),
  }).catch(() => {});
  return contextCache;
}

async function surroundingContext(filename, page, pageCount, contextPages = 0) {
  const count = Math.max(0, Math.min(2, Math.floor(Number(contextPages || 0))));
  const startPage = Math.max(1, Number(page) - count);
  const endPage = Math.min(Number(pageCount || page || 1), Number(page) + count);
  const warnings = [];
  let source = null;
  const cacheKeys = [];
  const pagesByNumber = new Map();
  const missingPages = [];

  try {
    source = await getPdfSourceInfo(filename);
    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
      try {
        const cached = await readCachedContextPage(filename, source, pageNumber);
        cacheKeys.push(cached.cache.key);
        if (cached.page) pagesByNumber.set(pageNumber, cached.page);
        else missingPages.push(pageNumber);
      } catch {
        missingPages.push(pageNumber);
      }
    }
    if (!missingPages.length) {
      return {
        pages: [...pagesByNumber.keys()].sort((a, b) => a - b).map((pageNumber) => pagesByNumber.get(pageNumber)),
        warnings,
        context_cache_hit: true,
        cache_key: cacheKeys.join(","),
      };
    }
  } catch (error) {
    warnings.push(`Page context cache unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const extractStart = missingPages.length ? Math.min(...missingPages) : startPage;
  const extractEnd = missingPages.length ? Math.max(...missingPages) : endPage;
  const { requestId, workerRoot, cancelPath } = await prepareWorkerRoot("pages.extract.figure-context");
  try {
    const worker = await runPythonWorker({
      requestId,
      operation: "pages.extract",
      allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
      inputs: { filename, pdfPath: safePdfPath(filename) },
      outputs: { cancelPath },
      options: { startPage: extractStart, endPage: extractEnd },
    }, { timeoutMs: 120_000 });
    for (const item of worker.result?.pages || []) {
      const pageNumber = Number(item.page);
      if (pageNumber < startPage || pageNumber > endPage) continue;
      const pageEntry = { page: pageNumber, text: compactText(item.text || "", 3500) };
      pagesByNumber.set(pageNumber, pageEntry);
      if (source) {
        const written = await writeCachedContextPage(filename, source, pageNumber, item.text || "");
        if (!cacheKeys.includes(written.key)) cacheKeys.push(written.key);
      }
    }
  } catch (error) {
    warnings.push(`Surrounding context worker unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await fs.rm(workerRoot, { recursive: true, force: true }).catch(() => {});
  }

  if (pagesByNumber.size < (endPage - startPage + 1)) {
    try {
      const cachePath = safePagesCachePath(filename);
      if (await pathExists(cachePath)) {
        const stat = await fs.stat(cachePath);
        if (stat.size <= contextFullCacheMaxBytes()) {
          const cached = await readJsonCached(cachePath);
          const cachedSource = source || await getPdfSourceInfo(filename);
          if (cached.filename === filename && Array.isArray(cached.pages) && (!cached.source || isSamePdfSource(cached.source, cachedSource))) {
            for (const item of cached.pages) {
              const pageNumber = Number(item.page);
              if (pageNumber < startPage || pageNumber > endPage || pagesByNumber.has(pageNumber)) continue;
              pagesByNumber.set(pageNumber, { page: pageNumber, text: compactText(item.text || "", 3500) });
              if (source) {
                const written = await writeCachedContextPage(filename, source, pageNumber, item.text || "");
                if (!cacheKeys.includes(written.key)) cacheKeys.push(written.key);
              }
            }
          }
        }
      }
    } catch (error) {
      warnings.push(`Legacy pages cache context unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    pages: [...pagesByNumber.keys()].sort((a, b) => a - b).map((pageNumber) => pagesByNumber.get(pageNumber)),
    warnings,
    context_cache_hit: false,
    cache_key: cacheKeys.join(","),
  };
}

function uniqueLabels(items = []) {
  const labels = [];
  const seen = new Set();
  for (const item of items) {
    const label = String(item.text || "").trim();
    if (!label || label.length > 80) continue;
    const key = normalizeForSearch(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
    if (labels.length >= 16) break;
  }
  return labels;
}

function technicalSummary({ caption = "", labels = [], context = [], ocrOk = false } = {}) {
  const lines = [];
  if (caption) lines.push(`Caption evidence: ${compactText(caption, 220)}`);
  if (labels.length) lines.push(`OCR evidence contains labels/text: ${labels.slice(0, 12).join(", ")}.`);
  if (!labels.length && !ocrOk) lines.push("OCR text is unavailable, so interpretation is limited to caption/context and the rendered image path.");
  const contextHit = (context || []).map((item) => item.text || "").find((text) => text.trim());
  if (contextHit) lines.push(`Nearby text evidence: ${compactText(contextHit, 260)}`);
  if (!lines.length) lines.push("No caption, OCR text, or nearby text evidence was available; inspect the rendered image manually.");
  return lines.slice(0, 4);
}

export async function inspectFigureOnDemand(args = {}) {
  const requestedParser = normalizeInspectParser(args.parser, "safe");
  let target = null;
  try {
    target = await resolveFigureTarget(String(args.filename || "").trim(), args);
  } catch {
    target = null;
  }
  const figure = target?.figure || null;
  const mode = normalizeInspectMode(args.mode, figure);
  let parser = requestedParser;
  if (requestedParser === "auto") {
    const health = await getOcrHealth({ timeoutMs: Math.min(Number(args.timeoutMs || 10_000), 30_000) });
    parser = selectInspectParser("auto", normalizeFigureType(mode), health);
  }

  if (parser === "structure" || parser === "vl") {
    const render = await renderFigureOnDemand(args);
    if (!render.ok) return { ...render, parser, semantic_evidence: render.semantic_evidence || null };
    const parsed = await figureParserOnDemand({ ...args, engine: "auto" }, parser, render, mode);
    const includeContext = args.include_context === undefined ? true : Boolean(args.include_context);
    const context = includeContext
      ? await surroundingContext(parsed.filename, parsed.page, parsed.page_count || parsed.page, args.context_pages)
      : { pages: [], warnings: [] };
    const semantic = parsed.semantic_evidence || unavailableSemanticEvidence({
      filename: parsed.filename,
      render: parsed,
      figureType: mode,
      parser,
      engine: parsed.engine || "paddleocr",
      warning: parsed.message || `${parser} parser returned no semantic evidence`,
    });
    const semanticLabels = semantic.extracted_items?.labels || [];
    const labels = semanticLabels.map((item) => item.label || "").filter(Boolean).slice(0, 16);
    const warnings = uniqueStrings([
      ...(parsed.warnings || []),
      ...(context.warnings || []),
      "Connector/arrow detection remains unverified; verify control/data flow against rendered image and manual text.",
      parser === "vl" ? "PaddleOCR-VL graph edges are not verified evidence until cross-checked against manual text/register/sequence/caution tools." : "",
    ]);
    return {
      ok: true,
      filename: parsed.filename,
      page: parsed.page,
      figure_id: parsed.figure_id || "",
      caption: parsed.caption || figure?.caption || figure?.title || "",
      bbox: parsed.bbox || [],
      figure_type: mode,
      parser,
      image_path: parsed.image_path || "",
      raw_artifact: parsed.raw_artifact || semantic.raw_artifact,
      ocr: {
        ok: parser === "structure" || parser === "vl" ? Boolean(parsed.ok) : false,
        engine: parsed.engine || "paddleocr",
        error_code: parsed.ok ? "" : parsed.error_code || `${parser.toUpperCase()}_PARSER_UNAVAILABLE`,
        message: parsed.ok ? "" : parsed.message || "",
        items: semantic.extracted_items?.text_blocks || [],
        plain_text: parsed.plain_text || "",
      },
      detected_labels: semanticLabels.map((item) => ({
        label: item.label || "",
        bbox: item.bbox || [],
        image_bbox: [],
        confidence: Number(item.confidence || 0),
      })),
      detected_blocks: [],
      detected_connectors: [],
      surrounding_context: context.pages || [],
      context_cache_hit: Boolean(context.context_cache_hit),
      context_cache_key: context.cache_key || "",
      technical_summary: technicalSummary({
        caption: parsed.caption || figure?.caption || figure?.title || "",
        labels,
        context: context.pages || [],
        ocrOk: Boolean(parsed.ok),
      }),
      limitations: warnings,
      warnings,
      semantic_evidence: semantic,
      semantic_cache_key: parsed.semantic_cache_key || "",
      semantic_cache_path: parsed.semantic_cache_path || "",
      provenance: {
        tool: "inspect_figure",
        render_tool: "render_figure",
        ocr_tool: "ocr_figure",
        parser,
        figures_index: parsed.figure_id ? safeFiguresIndexPath(parsed.filename) : "",
        raw_cache: parsed.raw_artifact?.path || "",
        semantic_cache: parsed.semantic_cache_path || "",
      },
    };
  }

  const inspectOcr = await ocrFigureForInspect({ ...args, engine: "auto", mode: "text" });
  const ocr = inspectOcr.ocr;
  const renderFailed = !ocr.ok && !ocr.image_path;
  if (renderFailed) return ocr;

  if (!target) target = inspectOcr.target || null;
  const includeContext = args.include_context === undefined ? true : Boolean(args.include_context);
  const context = includeContext
    ? await surroundingContext(ocr.filename, ocr.page, ocr.page_count || ocr.page, args.context_pages)
    : { pages: [], warnings: [] };
  const items = ocr.ok ? (ocr.ocr_text || []) : [];
  const labels = uniqueLabels(items);
  const source = await getPdfSourceInfo(ocr.filename).catch(() => null);
  const semanticParser = parser === "ocr" ? "ocr" : "safe";
  const semantic = ocr.semantic_evidence || buildSemanticEvidence({
    filename: ocr.filename,
    source,
    render: ocr,
    figureType: mode,
    parser: semanticParser,
    engine: ocr.engine || "paddleocr",
    ocr,
    rawPath: ocr.raw_artifact?.path || "",
    rawCached: Boolean(ocr.cache_hit),
  });
  const warnings = uniqueStrings([
    ...(ocr.warnings || []),
    ...(semantic.warnings || []),
    ...(context.warnings || []),
    "Connector/arrow detection is not implemented in this on-demand inspector; verify control/data flow against the rendered image and surrounding manual text.",
    "Block detection is limited to OCR label evidence and should not be treated as verified diagram topology.",
  ]);

  return {
    ok: true,
    filename: ocr.filename,
    page: ocr.page,
    figure_id: ocr.figure_id || "",
    caption: ocr.caption || figure?.caption || figure?.title || "",
    bbox: ocr.bbox || [],
    figure_type: mode,
    parser: semanticParser,
    image_path: ocr.image_path || "",
    raw_artifact: ocr.raw_artifact || semantic.raw_artifact,
    ocr: {
      ok: Boolean(ocr.ok),
      engine: ocr.engine || "paddleocr",
      error_code: ocr.ok ? "" : ocr.error_code || "OCR_UNAVAILABLE",
      message: ocr.ok ? "" : ocr.message || "",
      items,
      plain_text: ocr.ok ? ocr.plain_text || "" : "",
    },
    detected_labels: items.map((item) => ({
      label: item.text || "",
      bbox: item.bbox || [],
      image_bbox: item.image_bbox || [],
      confidence: Number(item.confidence || 0),
    })),
    detected_blocks: [],
    detected_connectors: [],
    surrounding_context: context.pages || [],
    context_cache_hit: Boolean(context.context_cache_hit),
    context_cache_key: context.cache_key || "",
    technical_summary: technicalSummary({
      caption: ocr.caption || figure?.caption || figure?.title || "",
      labels,
      context: context.pages || [],
      ocrOk: Boolean(ocr.ok),
    }),
    limitations: warnings,
    warnings,
    semantic_evidence: semantic,
    semantic_cache_key: ocr.semantic_cache_key || "",
    semantic_cache_path: ocr.semantic_cache_path || "",
    provenance: {
      tool: "inspect_figure",
      render_tool: "render_figure",
      ocr_tool: "ocr_figure",
      parser: semanticParser,
      figures_index: ocr.figure_id ? safeFiguresIndexPath(ocr.filename) : "",
      ocr_cache: ocr.cache_key || "",
      semantic_cache: ocr.semantic_cache_path || "",
    },
  };
}

async function listCacheKind(kind, filename = "") {
  const dir = cacheDir(kind);
  const prefixes = filename ? [`${filename}-`, sanitizeRenderStem(`${filename}-`)].filter(Boolean) : [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (prefixes.length && !prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    const filePath = ensureInsideRoot(path.join(dir, entry.name), dir, `${kind} cache file`);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) continue;
    files.push({
      kind,
      name: entry.name,
      path: filePath,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  return files;
}

function normalizeCacheKinds(args = {}) {
  const raw = args.kind ?? args.cache_kind ?? "all";
  const requested = Array.isArray(raw) ? raw : String(raw || "all").split(",");
  const kinds = requested.map((item) => String(item || "").trim()).filter(Boolean);
  if (!kinds.length || kinds.includes("all")) return FIGURE_CACHE_KINDS.slice();
  const allowed = new Set(FIGURE_CACHE_KINDS);
  for (const kind of kinds) {
    if (!allowed.has(kind)) throw new Error(`Unsupported cache kind: ${kind}`);
  }
  return [...new Set(kinds)];
}

async function listCacheFiles(args = {}) {
  const filename = String(args.filename || "").trim();
  if (filename) ensurePdfFilename(filename);
  const selectedKinds = normalizeCacheKinds(args);
  const byKind = {};
  let files = [];
  for (const kind of selectedKinds) {
    byKind[kind] = await listCacheKind(kind, filename);
    files = files.concat(byKind[kind]);
  }
  return { filename, kinds: selectedKinds, byKind, files };
}

async function readCacheFileJson(item) {
  if (!String(item.name || "").endsWith(".json")) return null;
  try {
    return await readJsonCached(item.path);
  } catch {
    return null;
  }
}

function cacheSourceFingerprint(data = {}) {
  return String(data.source_fingerprint || data.sourceFingerprint || (data.source ? pdfSourceFingerprint(data.source) : "") || "");
}

async function selectStaleBySource(files, filename) {
  if (!filename) return [];
  const currentSource = await getPdfSourceInfo(filename);
  const currentFingerprint = pdfSourceFingerprint(currentSource);
  const selectedKeys = new Set();
  const byKey = new Map(files.map((item) => [`${item.kind}/${item.name}`, item]));
  for (const item of files) {
    const data = await readCacheFileJson(item);
    if (!data) continue;
    const fileFingerprint = cacheSourceFingerprint(data);
    const sameSource = data.source ? isSamePdfSource(data.source, currentSource) : (fileFingerprint && fileFingerprint === currentFingerprint);
    if (!fileFingerprint && !data.source) continue;
    if (sameSource) continue;
    selectedKeys.add(`${item.kind}/${item.name}`);
    if (item.kind === "figure-images" && item.name.endsWith(".meta.json")) {
      const imageName = item.name.replace(/\.meta\.json$/i, ".png");
      if (byKey.has(`${item.kind}/${imageName}`)) selectedKeys.add(`${item.kind}/${imageName}`);
    }
  }
  return files.filter((item) => selectedKeys.has(`${item.kind}/${item.name}`));
}

export async function getCacheStatus(args = {}) {
  try {
    const listed = await listCacheFiles(args);
    const kinds = {};
    for (const kind of listed.kinds) {
      const files = listed.byKind[kind] || [];
      kinds[kind] = {
        files: files.length,
        bytes: files.reduce((sum, item) => sum + item.bytes, 0),
      };
    }
    return {
      ok: true,
      filename: listed.filename || "",
      kind: args.kind || "all",
      cache_root: ensureInsideRoot(path.join(INDEX_DIR, "cache"), INDEX_DIR, "cache root"),
      kinds,
      total_files: listed.files.length,
      total_bytes: listed.files.reduce((sum, item) => sum + item.bytes, 0),
      warnings: [],
    };
  } catch (error) {
    return failureFromError(error, "CACHE_STATUS_FAILED");
  }
}

export async function getFigureCacheStatus(args = {}) {
  return getCacheStatus(args);
}

export async function cleanupCache(args = {}) {
  try {
    const listed = await listCacheFiles(args);
    const now = Date.now();
    const olderThanHours = Number(args.older_than_hours || 0);
    const maxBytes = Number(args.max_bytes || 0);
    const staleBySource = Boolean(args.stale_by_source || args.staleBySource);
    let candidates = listed.files.slice();
    if (Number.isFinite(olderThanHours) && olderThanHours > 0) {
      const cutoff = now - olderThanHours * 60 * 60 * 1000;
      candidates = candidates.filter((item) => item.mtimeMs < cutoff);
    }
    if (staleBySource) {
      const stale = await selectStaleBySource(candidates, listed.filename);
      candidates = stale;
    }
    if (Number.isFinite(maxBytes) && maxBytes > 0) {
      let remainingBytes = listed.files.reduce((sum, item) => sum + item.bytes, 0);
      candidates = candidates
        .slice()
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
        .filter((item) => {
          if (remainingBytes <= maxBytes) return false;
          remainingBytes -= item.bytes;
          return true;
        });
    }
    const confirm = Boolean(args.confirm);
    const summary = {
      ok: true,
      filename: listed.filename || "",
      kind: args.kind || "all",
      confirm,
      dry_run: !confirm,
      stale_by_source: staleBySource,
      total_files: listed.files.length,
      total_bytes: listed.files.reduce((sum, item) => sum + item.bytes, 0),
      selected_files: candidates.length,
      selected_bytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
      files: candidates.slice(0, 200).map((item) => ({
        kind: item.kind,
        name: item.name,
        path: item.path,
        bytes: item.bytes,
      })),
      warnings: candidates.length > 200 ? [`Only the first 200 selected files are listed; selected_files=${candidates.length}.`] : [],
    };
    if (!confirm) return summary;
    const deleted = [];
    for (const item of candidates) {
      const root = cacheDir(item.kind);
      const safePath = ensureInsideRoot(item.path, root, `${item.kind} cache cleanup file`);
      await fs.rm(safePath, { force: true });
      deleted.push(item);
    }
    return {
      ...summary,
      deleted_files: deleted.length,
      deleted_bytes: deleted.reduce((sum, item) => sum + item.bytes, 0),
      files: deleted.slice(0, 200).map((item) => ({
        kind: item.kind,
        name: item.name,
        path: item.path,
        bytes: item.bytes,
      })),
    };
  } catch (error) {
    return failureFromError(error, "CACHE_CLEANUP_FAILED");
  }
}

export async function cleanupFigureCache(args = {}) {
  return cleanupCache(args);
}
