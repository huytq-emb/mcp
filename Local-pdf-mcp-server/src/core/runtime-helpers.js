import { ATOMIC_WRITE_RETRY_MS, DEFAULT_BITFIELD_LIST_TOP_K, DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE, DEFAULT_REGISTER_LIST_TOP_K, DEFAULT_TOP_K, EVIDENCE_CONTRACT_SCHEMA_VERSION, INDEX_LOCK_SCHEMA_VERSION, INDEX_LOCK_STALE_MS, MAX_BITFIELD_LIST_TOP_K, MAX_CHUNK_SIZE, MAX_REGISTER_LIST_TOP_K, MAX_TOOL_OUTPUT_CHARS, MAX_TOP_K, MIN_CHUNK_SIZE, SERVER_NAME, SERVER_VERSION } from "./runtime-constants.js";
import fs from "node:fs/promises";
import path from "node:path";
import { sourceFingerprint } from "../artifacts/manifest.js";
import { readSourceIdentity, readStableSourceIdentity } from "../artifacts/source-identity.js";
import { atomicWriteFile as writeFileAtomically } from "./atomic-file.js";
import { getPathResolver } from "./path-resolver.js";
import { normalizeEvidenceContract } from "../evidence/contract.js";
import { sanitizeDriverProfileName } from "../driver-profiles/catalog.js";
import {
  ensureDirectPdfFilename,
  ensureInsideRoot as ensurePathInsideRoot,
} from "./path-safety.js";

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

export function extractEvidenceContractFromText(text) {
  const match = String(text || "").match(/Machine-readable evidence contract:\s*```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function textResult(text) {
  const fullText = String(text ?? "");
  const evidenceContract = extractEvidenceContractFromText(fullText);
  const result = {
    content: [
      {
        type: "text",
        text: limitOutput(fullText),
      },
    ],
  };
  if (evidenceContract) result.structuredContent = { evidenceContract };
  return result;
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
  return writeFileAtomically(targetPath, data, encoding);
}

export async function atomicWriteJson(targetPath, value) {
  let payload = value;
  const indexDir = getPathResolver().indexDir();
  const indexRelativePath = path.relative(indexDir, path.resolve(targetPath));
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.partial !== true &&
    indexRelativePath !== "" &&
    !indexRelativePath.startsWith("..") &&
    !path.isAbsolute(indexRelativePath) &&
    !Object.prototype.hasOwnProperty.call(value, "artifactComplete")
  ) {
    payload = { ...value, artifactComplete: true };
  }
  await atomicWriteFile(targetPath, JSON.stringify(payload, null, 2), "utf-8");
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
  await fs.mkdir(getPathResolver().indexDir(), { recursive: true });
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

export async function getPdfSourceInfo(filename, options = {}) {
  const filePath = safePdfPath(filename);
  return readSourceIdentity(filePath, { includeHash: options.includeHash === true, bypassCache: options.bypassCache === true });
}

export async function getStablePdfSourceInfo(filename) {
  return readStableSourceIdentity(safePdfPath(filename));
}

export function isSamePdfSource(cacheSource, currentSource) {
  if (!cacheSource || !currentSource) return false;
  if (!cacheSource.sha256 || !currentSource.sha256) return false;
  return Number(cacheSource.size) === Number(currentSource.size)
    && String(cacheSource.sha256).toLowerCase() === String(currentSource.sha256).toLowerCase();
}

export function ensurePdfFilename(filename) {
  ensureDirectPdfFilename(filename);
}


export function ensurePdfFilenameLite(filename) {
  return ensureDirectPdfFilename(filename);
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
      `Use mcp_control(action="rebuild_artifact", filename="${safeName}", artifact="pages") to start a detached rebuild.`,
      `Use mcp_control(action="index_status_lite", filename="${safeName}") for status checks.`,
      `Use mcp_control(action="compat_report") for the Step 40.7 compatibility contract.`,
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
  return ensurePathInsideRoot(candidatePath, rootDir, what);
}

export function safePdfPath(filename) {
  return getPathResolver().pdf(filename);
}

export function safeIndexPath(filename) {
  return getPathResolver().chunkIndex(filename);
}

export function safePagesCachePath(filename) {
  return getPathResolver().pages(filename);
}

export function safePagesPartialCachePath(filename) {
  return getPathResolver().pagesPartial(filename);
}

export function safeSectionsIndexPath(filename) {
  return getPathResolver().sections(filename);
}

export function safeRegistersIndexPath(filename) {
  return getPathResolver().registers(filename);
}

export function safeTablesIndexPath(filename) {
  return getPathResolver().tables(filename);
}

export function safeTablesPartialIndexPath(filename) {
  return getPathResolver().tablesPartial(filename);
}

export function safeBitfieldsIndexPath(filename) {
  return getPathResolver().bitfields(filename);
}

export function safeSequencesIndexPath(filename) {
  return getPathResolver().sequences(filename);
}

export function safeCautionsIndexPath(filename) {
  return getPathResolver().cautions(filename);
}

export function safeFiguresIndexPath(filename) {
  return getPathResolver().figures(filename);
}

export function safeFigureLookupIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.figures.lookup.json`),
    getPathResolver().indexDir(),
    "figures lookup index"
  );
}

export function safeFigureOcrIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.figure_ocr.json`),
    getPathResolver().indexDir(),
    "figure OCR index"
  );
}

// New evidence tools must pass their structured payload directly rather than
// recovering it from the human-readable Markdown compatibility block.
export function evidenceBundleResult(text, bundle) {
  return {
    content: [
      {
        type: "text",
        text: limitOutput(String(text ?? "")),
      },
    ],
    structuredContent: bundle,
  };
}

export function safeFigureSemanticIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.figure_semantic.json`),
    getPathResolver().indexDir(),
    "figure semantic index"
  );
}

export function safeVisualEvidencePath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.visual-evidence.json`),
    getPathResolver().indexDir(),
    "visual evidence index"
  );
}

export function safeArtifactManifestPath(filename) {
  return getPathResolver().manifest(filename);
}

export function safeEvidenceGraphPath(filename) {
  return getPathResolver().evidenceGraph(filename);
}

export function safeHybridQualityReportJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.hybrid-quality.json`),
    getPathResolver().indexDir(),
    "hybrid Python quality report JSON"
  );
}

export function safeHybridQualityReportMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.hybrid-quality.md`),
    getPathResolver().indexDir(),
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
  return ensureInsideRoot(path.join(getPathResolver().rendersDir(), `${stem}.${ext}`), getPathResolver().rendersDir(), "render output");
}

export function safeDriverPackPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.driver-pack.txt`),
    getPathResolver().indexDir(),
    "driver evidence pack"
  );
}

export function safeDriverPackJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.driver-pack.json`),
    getPathResolver().indexDir(),
    "driver evidence pack JSON"
  );
}

export function safeDriverPackMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.driver-pack.md`),
    getPathResolver().indexDir(),
    "driver evidence pack Markdown"
  );
}

export function safeDriverTaskPlanPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.driver-task-plan.txt`),
    getPathResolver().indexDir(),
    "driver task plan"
  );
}

export function safeDriverTaskPlanJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.driver-task-plan.json`),
    getPathResolver().indexDir(),
    "driver task plan JSON"
  );
}

export function safeDriverTaskPlanMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.driver-task-plan.md`),
    getPathResolver().indexDir(),
    "driver task plan Markdown"
  );
}

export function safeDoctorReportPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.doctor.txt`),
    getPathResolver().indexDir(),
    "doctor report"
  );
}

export function safeDoctorReportJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.doctor.json`),
    getPathResolver().indexDir(),
    "doctor report JSON"
  );
}

export function safeDoctorReportMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.doctor.md`),
    getPathResolver().indexDir(),
    "doctor report Markdown"
  );
}

export function safeEvalCasesPath() {
  return ensureInsideRoot(
    path.join(getPathResolver().evalDir(), "manual-cases.json"),
    getPathResolver().evalDir(),
    "eval cases"
  );
}

export function safeEvalProfilePath(profileName) {
  const safeName = sanitizeDriverProfileName(profileName || "generic");
  return ensureInsideRoot(
    path.join(getPathResolver().evalProfilesDir(), `${safeName}.json`),
    getPathResolver().evalProfilesDir(),
    "eval profile"
  );
}

export function safeEvalFixturePath(fixtureName) {
  const safeName = sanitizeDriverProfileName(fixtureName || "fixture");
  return ensureInsideRoot(
    path.join(getPathResolver().evalFixturesDir(), `${safeName}.json`),
    getPathResolver().evalFixturesDir(),
    "eval fixture"
  );
}

export function safeEvalReportTextPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.eval-report.txt`),
    getPathResolver().indexDir(),
    "eval report text"
  );
}

export function safeEvalReportJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.eval-report.json`),
    getPathResolver().indexDir(),
    "eval report JSON"
  );
}

export function safeEvalReportMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.eval-report.md`),
    getPathResolver().indexDir(),
    "eval report Markdown"
  );
}

export function safeDriverProfilePath(profileName) {
  const safeName = sanitizeDriverProfileName(profileName);
  return ensureInsideRoot(
    path.join(getPathResolver().driverProfilesDir(), `${safeName}.json`),
    getPathResolver().driverProfilesDir(),
    "driver profile"
  );
}

export function safeDriverProfileFragmentPath(fragmentName) {
  const safeName = sanitizeDriverProfileName(fragmentName);
  return ensureInsideRoot(
    path.join(getPathResolver().driverProfileFragmentsDir(), `${safeName}.json`),
    getPathResolver().driverProfileFragmentsDir(),
    "driver profile fragment"
  );
}

export function safeIndexLockPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.index.lock`),
    getPathResolver().indexDir(),
    "index build lock"
  );
}

export function safeJobsStatePath() {
  return getPathResolver().jobsDir();
}

export function safeModuleProfileJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.module-profile.json`),
    getPathResolver().indexDir(),
    "module profile JSON"
  );
}

export function safeModuleProfileTextPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(getPathResolver().indexDir(), `${filename}.module-profile.txt`),
    getPathResolver().indexDir(),
    "module profile text"
  );
}
