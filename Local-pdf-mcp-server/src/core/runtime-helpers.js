import { ATOMIC_WRITE_RETRY_MS, DEFAULT_BITFIELD_LIST_TOP_K, DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE, DEFAULT_REGISTER_LIST_TOP_K, DEFAULT_TOP_K, DOCUMENTS_DIR, DRIVER_PROFILES_DIR, DRIVER_PROFILE_FRAGMENTS_DIR, EVAL_DIR, EVAL_FIXTURES_DIR, EVAL_PROFILES_DIR, EVIDENCE_CONTRACT_SCHEMA_VERSION, INDEX_DIR, INDEX_LOCK_SCHEMA_VERSION, INDEX_LOCK_STALE_MS, MAX_BITFIELD_LIST_TOP_K, MAX_CHUNK_SIZE, MAX_REGISTER_LIST_TOP_K, MAX_TOOL_OUTPUT_CHARS, MAX_TOP_K, MIN_CHUNK_SIZE, RENDERS_DIR, SERVER_NAME, SERVER_VERSION } from "./runtime-constants.js";
import fs from "node:fs/promises";
import path from "node:path";
import { sourceFingerprint } from "../artifacts/manifest.js";
import { normalizeEvidenceContract } from "../evidence/contract.js";
import { sanitizeDriverProfileName } from "../driver-profiles/catalog.js";

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

export function textResult(text) {
  return {
    content: [
      {
        type: "text",
        text: limitOutput(String(text ?? "")),
      },
    ],
  };
}

export function jsonResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: limitOutput(JSON.stringify(payload, null, 2)),
      },
    ],
    structuredContent: payload,
  };
}

export function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);

  return {
    content: [
      {
        type: "text",
        text: `Error: ${message}`,
      },
    ],
    isError: true,
  };
}


export function compactText(value, maxChars = 240) {
  const text = normalizeText(String(value || ""));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function evidenceTypeFromText(text, fallback = "paragraph") {
  const raw = String(text || "");
  if (/\b(Register\s+Name|Abbreviation|Offset\s+Address|Access\s+Size)\b/i.test(raw)) return "register-table";
  if (/\b(Bit\s+Name|Bit|R\/W|Access|Initial\s+Value|Description)\b/i.test(raw)) return "bitfield-table";
  if (/\b(sequence|procedure|operation|setting|before|after|when|must|should|step)\b/i.test(raw)) return "procedure";
  if (/\b(Caution|Note|Restriction|Prohibited|Undefined|Reserved|do\s+not|must\s+not|only\s+when)\b/i.test(raw)) return "caution";
  if (/\b(Interrupt|IRQ|status|flag|error|clear|cleared)\b/i.test(raw)) return "status-flow";
  return fallback;
}

export function confidenceLevel(value) {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (["high", "medium", "low"].includes(lower)) return lower;
  }
  const n = Number(value || 0);
  if (n >= 75) return "high";
  if (n >= 40) return "medium";
  return "low";
}

export function makeEvidence({
  source = "manual",
  evidenceType = "paragraph",
  page = null,
  chunkId = null,
  quote = "",
  confidence = "medium",
  name = "",
  field = "",
  tool = "",
} = {}) {
  return {
    source,
    evidenceType,
    page: Number.isFinite(Number(page)) ? Number(page) : null,
    chunkId: chunkId || null,
    quote: compactText(quote, 360),
    confidence: confidenceLevel(confidence),
    ...(name ? { name } : {}),
    ...(field ? { field } : {}),
    ...(tool ? { tool } : {}),
  };
}

export function makeInference({ statement = "", basis = "", confidence = "low", risk = "" } = {}) {
  return {
    statement: compactText(statement, 320),
    basis: compactText(basis, 260),
    confidence: confidenceLevel(confidence),
    ...(risk ? { risk: compactText(risk, 260) } : {}),
  };
}

export function makeNeedsVerification({ item = "", reason = "", suggestedTools = [] } = {}) {
  return {
    item: compactText(item, 260),
    reason: compactText(reason, 320),
    suggestedTools: Array.isArray(suggestedTools) ? suggestedTools.slice(0, 8) : [],
  };
}

export function makeEvidenceContract({
  tool,
  filename,
  query = "",
  input = null,
  sourceFingerprint: fingerprint = "",
  evidence = [],
  inference = [],
  inferences = null,
  needsVerification = [],
  warnings = [],
  recommendedNextTools = [],
} = {}) {
  return normalizeEvidenceContract({
    schemaVersion: EVIDENCE_CONTRACT_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    tool,
    filename,
    sourceFingerprint: fingerprint || "unknown",
    input: input || { query },
    evidence: evidence.filter(Boolean).slice(0, 24),
    inferences: (Array.isArray(inferences) ? inferences : inference).filter(Boolean).slice(0, 24),
    needsVerification: needsVerification.filter(Boolean).slice(0, 24),
    warnings: warnings.filter(Boolean).map((w) => compactText(w, 280)).slice(0, 16),
    recommendedNextTools: recommendedNextTools.filter(Boolean).slice(0, 16),
    rule: "Treat evidence as manual-backed. Treat inference as heuristic. Do not use any needsVerification item as driver fact until verified with read_pdf_pages/read_pdf_chunk or coordinate table extraction.",
  });
}

export function formatEvidenceContract(contract) {
  return [
    "",
    "---",
    "",
    "Machine-readable evidence contract:",
    "```json",
    JSON.stringify(contract, null, 2),
    "```",
  ].join("\n");
}

export function appendEvidenceContract(text, contract) {
  return `${text}${formatEvidenceContract(contract)}`;
}

export function evidenceFromChunk(chunk, quote = "", options = {}) {
  return makeEvidence({
    source: "manual-pdf-chunk",
    evidenceType: evidenceTypeFromText(quote || chunk?.text || "", options.evidenceType || "chunk"),
    page: chunk?.page,
    chunkId: chunk?.id,
    quote: quote || chunk?.text || "",
    confidence: options.confidence || chunk?.confidence || chunk?.score || "medium",
    name: options.name || "",
    field: options.field || "",
    tool: options.tool || "",
  });
}

export function limitOutput(text, maxChars = MAX_TOOL_OUTPUT_CHARS) {
  if (text.length <= maxChars) return text;

  return `${text.slice(
    0,
    maxChars
  )}\n\n[Output truncated by ${SERVER_NAME}. Original length: ${text.length} characters. Use search_pdf, read_pdf_chunk, or a smaller page range.]`;
}

export function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[\t\u00a0]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n[ ]+/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function normalizeForSearch(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[_\-./()[\]{}:;,=+*<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalSymbol(text) {
  return String(text || "")
    .toUpperCase()
    .normalize("NFKC")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[^A-Z0-9_]/g, "")
    .trim();
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function clampInteger(value, defaultValue, min, max) {
  const n = Number(value ?? defaultValue);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function clampTopK(value) {
  return clampInteger(value, DEFAULT_TOP_K, 1, MAX_TOP_K);
}

export function clampRegisterListTopK(value) {
  return clampInteger(value, DEFAULT_REGISTER_LIST_TOP_K, 1, MAX_REGISTER_LIST_TOP_K);
}

export function clampBitfieldListTopK(value) {
  return clampInteger(value, DEFAULT_BITFIELD_LIST_TOP_K, 1, MAX_BITFIELD_LIST_TOP_K);
}

export function clampChunkSize(value) {
  return clampInteger(value, DEFAULT_CHUNK_SIZE, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE);
}

export function clampChunkOverlap(value, chunkSize) {
  const n = Number(value ?? DEFAULT_CHUNK_OVERLAP);
  if (!Number.isFinite(n)) return Math.min(DEFAULT_CHUNK_OVERLAP, chunkSize - 1);
  return Math.max(0, Math.min(Math.floor(n), chunkSize - 1));
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function atomicWriteFile(targetPath, data, encoding = "utf-8") {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    await fs.writeFile(tmpPath, data, encoding);
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

export async function atomicWriteJson(targetPath, value) {
  await atomicWriteFile(targetPath, JSON.stringify(value, null, 2), "utf-8");
}

export async function readIndexLock(filename) {
  const lockPath = safeIndexLockPath(filename);
  if (!(await pathExists(lockPath))) return null;

  try {
    const raw = await fs.readFile(lockPath, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...parsed, lockPath };
  } catch {
    return {
      schemaVersion: INDEX_LOCK_SCHEMA_VERSION,
      filename,
      createdAt: "unknown",
      pid: "unknown",
      lockPath,
      broken: true,
    };
  }
}

export function isIndexLockStale(lockInfo, nowMs = Date.now()) {
  if (!lockInfo) return false;
  const createdMs = Number(lockInfo.createdAtMs || 0);
  if (!Number.isFinite(createdMs) || createdMs <= 0) return true;
  return nowMs - createdMs > INDEX_LOCK_STALE_MS;
}

export async function removeIndexLock(filename, reason = "manual cleanup") {
  const lockPath = safeIndexLockPath(filename);
  const lockInfo = await readIndexLock(filename);
  if (lockInfo) {
    try {
      await fs.rm(lockPath, { force: true });
    } catch {
      // Ignore cleanup failure; the next acquire will fail if the lock remains.
    }
  }
  return { lockPath, lockInfo, reason };
}

export async function acquireIndexLock(filename, options = {}) {
  await fs.mkdir(INDEX_DIR, { recursive: true });
  const lockPath = safeIndexLockPath(filename);
  const forceLock = Boolean(options.forceLock);

  if (forceLock && (await pathExists(lockPath))) {
    await removeIndexLock(filename, "force_lock requested");
    await sleep(ATOMIC_WRITE_RETRY_MS);
  }

  const lockData = {
    schemaVersion: INDEX_LOCK_SCHEMA_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    pid: process.pid,
    serverVersion: SERVER_VERSION,
    staleAfterMs: INDEX_LOCK_STALE_MS,
    command: "index_pdf",
  };

  try {
    const handle = await fs.open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(lockData, null, 2), "utf-8");
    } finally {
      await handle.close();
    }
    return { lockPath, lockData, acquired: true };
  } catch (error) {
    if (error && error.code !== "EEXIST") throw error;
    const existing = await readIndexLock(filename);

    if (existing && isIndexLockStale(existing)) {
      await removeIndexLock(filename, "stale lock cleanup");
      await sleep(ATOMIC_WRITE_RETRY_MS);
      return acquireIndexLock(filename, { ...options, forceLock: false });
    }

    const created = existing?.createdAt || "unknown";
    const pid = existing?.pid || "unknown";
    throw new Error([
      `Index build lock exists for ${filename}.`,
      `Lock path: ${lockPath}`,
      `Created: ${created}`,
      `PID: ${pid}`,
      "Another index_pdf may be running. Wait for it to finish, or use force_lock=true only if you are sure it is stale.",
    ].join("\n"));
  }
}

export async function releaseIndexLock(filename, lock) {
  if (!lock || !lock.lockPath) return;
  const current = await readIndexLock(filename);
  if (current && current.pid === process.pid) {
    await fs.rm(lock.lockPath, { force: true });
  }
}

export async function withIndexBuildLock(filename, options, callback) {
  const lock = await acquireIndexLock(filename, options);
  try {
    return await callback(lock);
  } finally {
    await releaseIndexLock(filename, lock);
  }
}

export async function getPdfSourceInfo(filename) {
  const filePath = safePdfPath(filename);
  const stat = await fs.stat(filePath);

  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mtime: stat.mtime.toISOString(),
  };
}

export function isSamePdfSource(cacheSource, currentSource) {
  if (!cacheSource || !currentSource) return false;

  const cacheMtime = Number(cacheSource.mtimeMs);
  const currentMtime = Number(currentSource.mtimeMs);

  return (
    Number(cacheSource.size) === Number(currentSource.size) &&
    Number.isFinite(cacheMtime) &&
    Number.isFinite(currentMtime) &&
    Math.abs(cacheMtime - currentMtime) < 1500
  );
}

export function ensurePdfFilename(filename) {
  if (!filename || typeof filename !== "string") {
    throw new Error("filename is required");
  }

  if (!filename.toLowerCase().endsWith(".pdf")) {
    throw new Error("Only .pdf files are allowed");
  }

  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    path.basename(filename) !== filename
  ) {
    throw new Error(
      "Invalid filename. Only files directly inside the documents folder are allowed."
    );
  }
}


export function ensurePdfFilenameLite(filename) {
  if (!filename || typeof filename !== "string") {
    throw new Error("filename is required");
  }
  const value = filename.trim();
  if (!value.toLowerCase().endsWith(".pdf")) {
    throw new Error("Only .pdf files are allowed");
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error("Invalid filename. Only a direct PDF filename is allowed.");
  }
  return value;
}

export function getIndexStatusUltraMinimal(filename) {
  const safeName = ensurePdfFilenameLite(filename);
  return {
    filename: safeName,
    mode: "ultra-minimal",
    serverVersion: SERVER_VERSION,
    generatedAt: nowIso(),
    health: "UNKNOWN",
    note: "No filesystem, PDF, job-state, lock, or artifact probing was performed.",
    next: [
      `Use eval_health_check(step40_action="rebuild_artifact", filename="${safeName}", artifact="pages") to start a detached rebuild.`,
      `Use eval_health_check(step40_action="index_status_lite", filename="${safeName}") for status checks on MCP clients that cancel direct Step 40 tools.`,
      `Use eval_health_check(step40_action="compat_report") for the Step 40.7 compatibility contract.`,
    ],
  };
}

export function formatIndexStatusUltraMinimal(status) {
  return [
    `Index status for ${status.filename}: ${status.health} (${status.mode})`,
    `Server version: ${status.serverVersion}`,
    `Generated: ${status.generatedAt}`,
    status.note,
    "",
    "Next:",
    ...status.next.map((line) => `- ${line}`),
  ].join("\n");
}

export function ensureInsideRoot(candidatePath, rootDir, what) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    return resolvedCandidate;
  }

  throw new Error(`Invalid ${what} path`);
}

export function safePdfPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(path.join(DOCUMENTS_DIR, filename), DOCUMENTS_DIR, "PDF");
}

export function safeIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.index.json`),
    INDEX_DIR,
    "index"
  );
}

export function safePagesCachePath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.pages.json`),
    INDEX_DIR,
    "pages cache"
  );
}

export function safePagesPartialCachePath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.pages.partial.json`),
    INDEX_DIR,
    "partial pages cache"
  );
}

export function safeSectionsIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.sections.json`),
    INDEX_DIR,
    "sections index"
  );
}

export function safeRegistersIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.registers.json`),
    INDEX_DIR,
    "registers index"
  );
}

export function safeTablesIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.tables.json`),
    INDEX_DIR,
    "tables index"
  );
}

export function safeTablesPartialIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.tables.partial.json`),
    INDEX_DIR,
    "partial tables index"
  );
}

export function safeBitfieldsIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.bitfields.json`),
    INDEX_DIR,
    "bitfields index"
  );
}

export function safeSequencesIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.sequences.json`),
    INDEX_DIR,
    "sequences index"
  );
}

export function safeCautionsIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.cautions.json`),
    INDEX_DIR,
    "cautions index"
  );
}

export function safeFiguresIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.figures.json`),
    INDEX_DIR,
    "figures/captions index"
  );
}

export function safeFigureLookupIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.figures.lookup.json`),
    INDEX_DIR,
    "figures lookup index"
  );
}

export function safeFigureOcrIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.figure_ocr.json`),
    INDEX_DIR,
    "figure OCR index"
  );
}

export function safeVisualEvidencePath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.visual-evidence.json`),
    INDEX_DIR,
    "visual evidence index"
  );
}

export function safeArtifactManifestPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.manifest.json`),
    INDEX_DIR,
    "artifact manifest"
  );
}

export function safeHybridQualityReportJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.hybrid-quality.json`),
    INDEX_DIR,
    "hybrid Python quality report JSON"
  );
}

export function safeHybridQualityReportMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.hybrid-quality.md`),
    INDEX_DIR,
    "hybrid Python quality report Markdown"
  );
}

export const jsonFileCache = new Map();

function envPositiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function jsonCacheLimits() {
  return {
    maxEntries: envPositiveInteger("RENESAS_MCP_JSON_CACHE_MAX_ENTRIES", 64),
    maxBytes: envPositiveInteger("RENESAS_MCP_JSON_CACHE_MAX_BYTES", 256 * 1024 * 1024),
  };
}

function jsonCacheBytes() {
  let total = 0;
  for (const entry of jsonFileCache.values()) total += Number(entry.byteSize || entry.size || 0);
  return total;
}

function evictJsonFileCache(protectedKey = "") {
  const limits = jsonCacheLimits();
  if (limits.maxEntries === 0 || limits.maxBytes === 0) {
    jsonFileCache.clear();
    return;
  }
  let totalBytes = jsonCacheBytes();
  for (const [key, entry] of jsonFileCache) {
    if (jsonFileCache.size <= limits.maxEntries && totalBytes <= limits.maxBytes) break;
    if (key === protectedKey && jsonFileCache.size <= 1) break;
    jsonFileCache.delete(key);
    totalBytes -= Number(entry.byteSize || entry.size || 0);
  }
}

export function clearJsonFileCache() {
  jsonFileCache.clear();
}

export function getJsonFileCacheStats() {
  const limits = jsonCacheLimits();
  return {
    entries: jsonFileCache.size,
    bytes: jsonCacheBytes(),
    maxEntries: limits.maxEntries,
    maxBytes: limits.maxBytes,
  };
}

export async function readJsonCached(filePath) {
  const stat = await fs.stat(filePath);
  const key = path.resolve(filePath);
  const cached = jsonFileCache.get(key);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    jsonFileCache.delete(key);
    jsonFileCache.set(key, cached);
    return cached.data;
  }

  const raw = await fs.readFile(filePath, "utf-8");
  const data = JSON.parse(raw);
  jsonFileCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, byteSize: Buffer.byteLength(raw), data });
  evictJsonFileCache(key);
  return data;
}

export function sanitizeRenderStem(value) {
  return String(value || "render")
    .trim()
    .replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "render";
}

export function safeRenderOutputPath(filename, page, format, suffix = "") {
  ensurePdfFilename(filename);
  const ext = String(format || "png").toLowerCase() === "jpg" ? "jpg" : String(format || "png").toLowerCase() === "svg" || String(format || "png").toLowerCase() === "text_svg" ? "svg" : "png";
  const pageNumber = clampInteger(page, 1, 1, 999999);
  const stem = sanitizeRenderStem(`${filename}-p${pageNumber}${suffix ? `-${suffix}` : ""}`);
  return ensureInsideRoot(path.join(RENDERS_DIR, `${stem}.${ext}`), RENDERS_DIR, "render output");
}

export function safeDriverPackPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.driver-pack.txt`),
    INDEX_DIR,
    "driver evidence pack"
  );
}

export function safeDriverPackJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.driver-pack.json`),
    INDEX_DIR,
    "driver evidence pack JSON"
  );
}

export function safeDriverPackMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.driver-pack.md`),
    INDEX_DIR,
    "driver evidence pack Markdown"
  );
}

export function safeDriverTaskPlanPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.driver-task-plan.txt`),
    INDEX_DIR,
    "driver task plan"
  );
}

export function safeDriverTaskPlanJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.driver-task-plan.json`),
    INDEX_DIR,
    "driver task plan JSON"
  );
}

export function safeDriverTaskPlanMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.driver-task-plan.md`),
    INDEX_DIR,
    "driver task plan Markdown"
  );
}

export function safeDoctorReportPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.doctor.txt`),
    INDEX_DIR,
    "doctor report"
  );
}

export function safeDoctorReportJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.doctor.json`),
    INDEX_DIR,
    "doctor report JSON"
  );
}

export function safeDoctorReportMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.doctor.md`),
    INDEX_DIR,
    "doctor report Markdown"
  );
}

export function safeEvalCasesPath() {
  return ensureInsideRoot(
    path.join(EVAL_DIR, "manual-cases.json"),
    EVAL_DIR,
    "eval cases"
  );
}

export function safeEvalProfilePath(profileName) {
  const safeName = sanitizeDriverProfileName(profileName || "generic");
  return ensureInsideRoot(
    path.join(EVAL_PROFILES_DIR, `${safeName}.json`),
    EVAL_PROFILES_DIR,
    "eval profile"
  );
}

export function safeEvalFixturePath(fixtureName) {
  const safeName = sanitizeDriverProfileName(fixtureName || "fixture");
  return ensureInsideRoot(
    path.join(EVAL_FIXTURES_DIR, `${safeName}.json`),
    EVAL_FIXTURES_DIR,
    "eval fixture"
  );
}

export function safeEvalReportTextPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.eval-report.txt`),
    INDEX_DIR,
    "eval report text"
  );
}

export function safeEvalReportJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.eval-report.json`),
    INDEX_DIR,
    "eval report JSON"
  );
}

export function safeEvalReportMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.eval-report.md`),
    INDEX_DIR,
    "eval report Markdown"
  );
}

export function safeDriverProfilePath(profileName) {
  const safeName = sanitizeDriverProfileName(profileName);
  return ensureInsideRoot(
    path.join(DRIVER_PROFILES_DIR, `${safeName}.json`),
    DRIVER_PROFILES_DIR,
    "driver profile"
  );
}

export function safeDriverProfileFragmentPath(fragmentName) {
  const safeName = sanitizeDriverProfileName(fragmentName);
  return ensureInsideRoot(
    path.join(DRIVER_PROFILE_FRAGMENTS_DIR, `${safeName}.json`),
    DRIVER_PROFILE_FRAGMENTS_DIR,
    "driver profile fragment"
  );
}

export function safeIndexLockPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.index.lock`),
    INDEX_DIR,
    "index build lock"
  );
}

export function safeJobsStatePath() {
  return ensureInsideRoot(
    path.join(INDEX_DIR, ".jobs.json"),
    INDEX_DIR,
    "background jobs state"
  );
}

export function safeModuleProfileJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.module-profile.json`),
    INDEX_DIR,
    "module profile JSON"
  );
}

export function safeModuleProfileTextPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.module-profile.txt`),
    INDEX_DIR,
    "module profile text"
  );
}
