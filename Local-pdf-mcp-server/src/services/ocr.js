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
const FIGURE_LOOKUP_SCHEMA_VERSION = 1;
const PAGE_CONTEXT_CACHE_SCHEMA_VERSION = 1;
const OCR_HEALTH_TTL_MS = 60_000;
const PAGE_CONTEXT_CACHE_KIND = "page-context";
const FIGURE_CACHE_KINDS = ["figure-images", "figure-ocr", PAGE_CONTEXT_CACHE_KIND];

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
      },
    };
  }
  cachedOcrHealth = { checkedAtMs: now, status };
  return { ...status, cache_hit: false, ocr_health_cache_hit: false, checkedAtMs: now };
}

export function clearOcrHealthCache() {
  cachedOcrHealth = null;
}

export function formatOcrHealthReport(status) {
  const ocr = status.ocr || {};
  const lines = [
    "OCR health via eval_health_check: OK",
    `Node.js: ${status.node?.ok === false ? "unavailable" : "OK"}`,
    `Python worker: ${status.python?.ok === false ? `unavailable (${status.python.reason || "unknown"})` : "OK"}`,
    `PyMuPDF: ${status.python?.versions?.pymupdf || status.versions?.pymupdf || "unknown"}`,
    `PaddleOCR: ${ocr.available ? "available" : "missing"}`,
    `OCR enabled: ${ocr.enabled ? "true" : "false"}`,
    `OCR engine: ${ocr.engine || "paddleocr"}`,
  ];
  if (ocr.reason) lines.push(`Reason: ${ocr.reason}`);
  if (ocr.hint) lines.push(`Hint: ${ocr.hint}`);
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
    if (cached && (cached.figures || []).some((figure) => Array.isArray(figure.bbox))) return { ...cached, cached: true };
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
  const { requestId, workerRoot, cancelPath } = await prepareWorkerRoot("figure_ocr.build");
  options.onWorkerContext?.({ requestId, workerRoot, cancelPath, operation: "figure_ocr.build" });
  const tempPath = path.join(workerRoot, "figure_ocr.json");
  const source = await getPdfSourceInfo(filename);
  try {
    const worker = await runPythonWorker({
      requestId,
      operation: "figure_ocr.build",
      allowedRoots: [DOCUMENTS_DIR, INDEX_DIR, RENDERS_DIR],
      inputs: { filename, pdfPath: safePdfPath(filename), figuresPath: safeFiguresIndexPath(filename) },
      outputs: { artifactPath: tempPath, rendersRoot: RENDERS_DIR, cancelPath },
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

function ocrCachePaths(filename, render, source, engine) {
  const key = cacheKey({
    kind: "ocr_figure",
    filename,
    page: render.page,
    bbox: render.bbox,
    scale: render.scale,
    engine,
    source: pdfSourceFingerprint(source),
  });
  return {
    key,
    ocrPath: safeCachePath("figure-ocr", filename, key, "json"),
  };
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

export async function ocrFigureOnDemand(args = {}) {
  const engine = normalizeOcrEngine(args.engine);
  const render = await renderFigureOnDemand(args);
  if (!render.ok) return { ...render, engine, ocr_text: [], plain_text: "" };

  if (engine === "none") {
    return {
      ok: false,
      filename: render.filename,
      page: render.page,
      page_count: render.page_count || null,
      figure_id: render.figure_id || "",
      bbox: render.bbox,
      engine: "none",
      cache_hit: false,
      image_path: render.image_path,
      ocr_text: [],
      plain_text: "",
      error_code: "OCR_ENGINE_DISABLED",
      message: "OCR engine was disabled by request.",
      warnings: ["engine=none skips OCR and returns no text."],
    };
  }

  let source;
  try {
    source = await getPdfSourceInfo(render.filename);
  } catch (error) {
    return failureFromError(error, "PDF_NOT_FOUND", { filename: render.filename, page: render.page, image_path: render.image_path });
  }

  const paths = ocrCachePaths(render.filename, render, source, engine);
  const force = Boolean(args.force);
  if (!force && await pathExists(paths.ocrPath)) {
    try {
      const cached = await readJsonCached(paths.ocrPath);
      return { ...cached, cache_hit: true, image_cache_hit: Boolean(render.cache_hit), image_path: render.image_path };
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
        cache_hit: false,
        image_path: render.image_path,
        ocr_text: [],
        plain_text: "",
        error_code: result.error_code || "OCR_FAILED",
        message: result.message || result.error || "OCR failed",
        hint: result.hint || "",
        health: result.health || null,
        warnings: [...(render.warnings || []), ...(result.warnings || [])].filter(Boolean),
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
    return output;
  } catch (error) {
    return failureFromError(error, "OCR_FAILED", {
      filename: render.filename,
      page: render.page,
      page_count: render.page_count || null,
      figure_id: render.figure_id || "",
      bbox: render.bbox,
      engine,
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
  const ocrPaths = ocrCachePaths(filename, { ...target, scale }, source, engine);
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

function pageContextCachePath(filename, source, startPage, endPage) {
  const key = cacheKey({
    kind: PAGE_CONTEXT_CACHE_KIND,
    filename,
    startPage,
    endPage,
    source: pdfSourceFingerprint(source),
  });
  return { key, cachePath: safeCachePath(PAGE_CONTEXT_CACHE_KIND, filename, key, "json") };
}

async function surroundingContext(filename, page, pageCount, contextPages = 0) {
  const count = Math.max(0, Math.min(2, Math.floor(Number(contextPages || 0))));
  const startPage = Math.max(1, Number(page) - count);
  const endPage = Math.min(Number(pageCount || page || 1), Number(page) + count);
  const warnings = [];
  let source = null;
  let contextCache = null;

  try {
    source = await getPdfSourceInfo(filename);
    contextCache = pageContextCachePath(filename, source, startPage, endPage);
    if (await pathExists(contextCache.cachePath)) {
      const cached = await readJsonCached(contextCache.cachePath);
      if (
        cached.schemaVersion === PAGE_CONTEXT_CACHE_SCHEMA_VERSION &&
        cached.filename === filename &&
        Number(cached.startPage) === startPage &&
        Number(cached.endPage) === endPage &&
        Array.isArray(cached.pages) &&
        (!cached.source || isSamePdfSource(cached.source, source))
      ) {
        return {
          pages: cached.pages.map((item) => ({ page: Number(item.page), text: compactText(item.text || "", 3500) })),
          warnings,
          context_cache_hit: true,
          cache_key: contextCache.key,
        };
      }
    }
  } catch (error) {
    warnings.push(`Page context cache unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const cachePath = safePagesCachePath(filename);
    if (await pathExists(cachePath)) {
      const stat = await fs.stat(cachePath);
      if (stat.size <= contextFullCacheMaxBytes()) {
        const cached = await readJsonCached(cachePath);
        const cachedSource = source || await getPdfSourceInfo(filename);
        if (cached.filename === filename && Array.isArray(cached.pages) && (!cached.source || isSamePdfSource(cached.source, cachedSource))) {
          const pages = cached.pages
              .filter((item) => Number(item.page) >= startPage && Number(item.page) <= endPage)
              .map((item) => ({ page: Number(item.page), text: compactText(item.text || "", 3500) }));
          if (contextCache && source) {
            await atomicWriteJson(contextCache.cachePath, {
              schemaVersion: PAGE_CONTEXT_CACHE_SCHEMA_VERSION,
              filename,
              startPage,
              endPage,
              source,
              sourceFingerprint: pdfSourceFingerprint(source),
              pages,
            }).catch(() => {});
          }
        return {
          pages,
          warnings,
          context_cache_hit: false,
          cache_key: contextCache?.key || "",
        };
        }
      }
    }
  } catch (error) {
    warnings.push(`Pages cache context unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const { requestId, workerRoot, cancelPath } = await prepareWorkerRoot("pages.extract.figure-context");
  try {
    const worker = await runPythonWorker({
      requestId,
      operation: "pages.extract",
      allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
      inputs: { filename, pdfPath: safePdfPath(filename) },
      outputs: { cancelPath },
      options: { startPage, endPage },
    }, { timeoutMs: 120_000 });
    const pages = (worker.result?.pages || []).map((item) => ({ page: Number(item.page), text: compactText(item.text || "", 3500) }));
    if (contextCache && source) {
      await atomicWriteJson(contextCache.cachePath, {
        schemaVersion: PAGE_CONTEXT_CACHE_SCHEMA_VERSION,
        filename,
        startPage,
        endPage,
        source,
        sourceFingerprint: pdfSourceFingerprint(source),
        pages,
      }).catch(() => {});
    }
    return {
      pages,
      warnings,
      context_cache_hit: false,
      cache_key: contextCache?.key || "",
    };
  } catch (error) {
    return {
      pages: [],
      warnings: [...warnings, `Surrounding context unavailable: ${error instanceof Error ? error.message : String(error)}`],
      context_cache_hit: false,
      cache_key: contextCache?.key || "",
    };
  } finally {
    await fs.rm(workerRoot, { recursive: true, force: true }).catch(() => {});
  }
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
  const inspectOcr = await ocrFigureForInspect({ ...args, engine: "auto" });
  const ocr = inspectOcr.ocr;
  const renderFailed = !ocr.ok && !ocr.image_path;
  if (renderFailed) return ocr;

  let target = inspectOcr.target || null;
  if (!target) {
    try {
      target = await resolveFigureTarget(String(args.filename || ocr.filename || "").trim(), args);
    } catch {
      target = null;
    }
  }
  const figure = target?.figure || null;
  const mode = normalizeInspectMode(args.mode, figure);
  const includeContext = args.include_context === undefined ? true : Boolean(args.include_context);
  const context = includeContext
    ? await surroundingContext(ocr.filename, ocr.page, ocr.page_count || ocr.page, args.context_pages)
    : { pages: [], warnings: [] };
  const items = ocr.ok ? (ocr.ocr_text || []) : [];
  const labels = uniqueLabels(items);
  const warnings = [
    ...(ocr.warnings || []),
    ...(context.warnings || []),
    "Connector/arrow detection is not implemented in this on-demand inspector; verify control/data flow against the rendered image and surrounding manual text.",
    "Block detection is limited to OCR label evidence and should not be treated as verified diagram topology.",
  ].filter(Boolean);

  return {
    ok: true,
    filename: ocr.filename,
    page: ocr.page,
    figure_id: ocr.figure_id || "",
    caption: ocr.caption || figure?.caption || figure?.title || "",
    bbox: ocr.bbox || [],
    figure_type: mode,
    image_path: ocr.image_path || "",
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
    provenance: {
      tool: "inspect_figure",
      render_tool: "render_figure",
      ocr_tool: "ocr_figure",
      figures_index: ocr.figure_id ? safeFiguresIndexPath(ocr.filename) : "",
      ocr_cache: ocr.cache_key || "",
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

async function listFigureCacheFiles(args = {}) {
  const filename = String(args.filename || "").trim();
  if (filename) ensurePdfFilename(filename);
  const byKind = {};
  let files = [];
  for (const kind of FIGURE_CACHE_KINDS) {
    byKind[kind] = await listCacheKind(kind, filename);
    files = files.concat(byKind[kind]);
  }
  return { filename, byKind, files };
}

export async function getFigureCacheStatus(args = {}) {
  try {
    const listed = await listFigureCacheFiles(args);
    const kinds = {};
    for (const kind of FIGURE_CACHE_KINDS) {
      const files = listed.byKind[kind] || [];
      kinds[kind] = {
        files: files.length,
        bytes: files.reduce((sum, item) => sum + item.bytes, 0),
      };
    }
    return {
      ok: true,
      filename: listed.filename || "",
      cache_root: ensureInsideRoot(path.join(INDEX_DIR, "cache"), INDEX_DIR, "figure cache root"),
      kinds,
      total_files: listed.files.length,
      total_bytes: listed.files.reduce((sum, item) => sum + item.bytes, 0),
      warnings: [],
    };
  } catch (error) {
    return failureFromError(error, "FIGURE_CACHE_STATUS_FAILED");
  }
}

export async function cleanupFigureCache(args = {}) {
  try {
    const listed = await listFigureCacheFiles(args);
    const now = Date.now();
    const olderThanHours = Number(args.older_than_hours || 0);
    const maxBytes = Number(args.max_bytes || 0);
    let candidates = listed.files.slice();
    if (Number.isFinite(olderThanHours) && olderThanHours > 0) {
      const cutoff = now - olderThanHours * 60 * 60 * 1000;
      candidates = candidates.filter((item) => item.mtimeMs < cutoff);
    }
    if (Number.isFinite(maxBytes) && maxBytes > 0) {
      let remainingBytes = listed.files.reduce((sum, item) => sum + item.bytes, 0);
      candidates = listed.files
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
      confirm,
      dry_run: !confirm,
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
    return failureFromError(error, "FIGURE_CACHE_CLEANUP_FAILED");
  }
}
