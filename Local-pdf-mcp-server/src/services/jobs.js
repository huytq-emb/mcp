import { atomicWriteJson, clampChunkOverlap, clampChunkSize, ensurePdfFilename, escapeRegExp, getPdfSourceInfo, pathExists, safeArtifactManifestPath, safeBitfieldsIndexPath, safeCautionsIndexPath, safeDriverPackJsonPath, safeDriverPackMarkdownPath, safeDriverPackPath, safeDriverTaskPlanJsonPath, safeDriverTaskPlanMarkdownPath, safeDriverTaskPlanPath, safeEvidenceGraphPath, safeFigureOcrIndexPath, safeFigureSemanticIndexPath, safeFiguresIndexPath, safeIndexLockPath, safeIndexPath, safeJobsStatePath, safeModuleProfileJsonPath, safePagesCachePath, safePagesPartialCachePath, safeRegistersIndexPath, safeSectionsIndexPath, safeSequencesIndexPath, safeTablesIndexPath, safeTablesPartialIndexPath, safeVisualEvidencePath } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { BACKGROUND_JOB_START_DELAY_MS, BITFIELD_INDEX_SCHEMA_VERSION, CAUTION_INDEX_SCHEMA_VERSION, DRIVER_ARTIFACT_SCHEMA_VERSION, EVIDENCE_GRAPH_SCHEMA_VERSION, FIGURE_INDEX_SCHEMA_VERSION, FIGURE_OCR_SCHEMA_VERSION, FIGURE_SEMANTIC_SCHEMA_VERSION, INDEX_SCHEMA_VERSION, JOBS_STATE_SCHEMA_VERSION, JOB_HISTORY_LIMIT, JOB_LOG_LIMIT, MAX_ACTIVE_JOBS, MODULE_PROFILE_SCHEMA_VERSION, PAGE_CACHE_SCHEMA_VERSION, REGISTER_INDEX_SCHEMA_VERSION, SECTION_INDEX_SCHEMA_VERSION, SEQUENCE_INDEX_SCHEMA_VERSION, SERVER_NAME, SERVER_VERSION, STATUS_FAST_READ_BYTES, STATUS_FULL_PARSE_MAX_BYTES, TABLE_INDEX_SCHEMA_VERSION, VISUAL_EVIDENCE_SCHEMA_VERSION } from "../core/runtime-constants.js";
import { getPathResolver } from "../core/path-resolver.js";
import { spawn } from "../core/process-runner.js";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_MANIFEST_SCHEMA_VERSION, artifactDescendants, createArtifactManifest, formatManifestSummary } from "../artifacts/manifest.js";
import { buildEvidenceGraph } from "./evidence-graph.js";
import { createJobStore, JobUpdateRejectedError, TERMINAL_JOB_STATES } from "./job-store.js";
import { withSourceIdentityCache } from "../artifacts/source-identity.js";


const buildBitfieldsIndex = createRuntimePort("buildBitfieldsIndex");
const buildCautionsIndex = createRuntimePort("buildCautionsIndex");
const buildFigureOcrWithPython = createRuntimePort("buildFigureOcrWithPython");
const buildFiguresIndex = createRuntimePort("buildFiguresIndex");
const buildPagesCache = createRuntimePort("buildPagesCache");
const buildPdfIndex = createRuntimePort("buildPdfIndex");
const buildRegistersIndex = createRuntimePort("buildRegistersIndex");
const buildSectionsIndex = createRuntimePort("buildSectionsIndex");
const buildSequencesIndex = createRuntimePort("buildSequencesIndex");
const buildTablesIndex = createRuntimePort("buildTablesIndex");


const getFileStat = createRuntimePort("getFileStat");
const getBitfieldsIndex = createRuntimePort("getBitfieldsIndex");
const getPagesCache = createRuntimePort("getPagesCache");
const getPdfPageCount = createRuntimePort("getPdfPageCount");

const getSectionsIndex = createRuntimePort("getSectionsIndex");
const loadPdfIndex = createRuntimePort("loadPdfIndex");
const loadCautionsIndex = createRuntimePort("loadCautionsIndex");
const loadRegistersIndex = createRuntimePort("loadRegistersIndex");
const loadTablesIndex = createRuntimePort("loadTablesIndex");
const rebuildFigureSemanticsArtifact = createRuntimePort("rebuildFigureSemanticsArtifact");


// -----------------------------------------------------------------------------
// Background jobs / timeout hardening
// -----------------------------------------------------------------------------

export const jobs = new Map();
export let jobSequence = 0;
export let jobsStateWriteTimer = null;
export let jobsStateWriteInProgress = false;
export let jobsStateWritePending = false;
const pendingJobWrites = new Set();
const jobWriteChains = new Map();
let cachedJobStore = null;
let cachedJobStoreRoot = "";

export function getJobStore() {
  const paths = getPathResolver();
  if (!cachedJobStore || cachedJobStoreRoot !== paths.root()) {
    cachedJobStore = createJobStore({ paths });
    cachedJobStoreRoot = paths.root();
  }
  return cachedJobStore;
}

export function nowIso() {
  return new Date().toISOString();
}

export function createJobId(type) {
  jobSequence += 1;
  return `${type}-${Date.now()}-${jobSequence}`;
}

export function parseJobSequenceFromId(id) {
  const match = String(id || "").match(/-(\d+)$/);
  return match ? Number(match[1]) : 0;
}

export function normalizeJobForPersistence(job) {
  if (!job || !job.id) return null;
  return {
    id: String(job.id),
    type: job.type || "unknown",
    filename: job.filename || "",
    status: job.status || "unknown",
    phase: job.phase || "",
    message: job.message || "",
    progress: job.progress || null,
    metadata: job.metadata || {},
    createdAt: job.createdAt || null,
    createdMs: Number(job.createdMs || 0),
    startedAt: job.startedAt || null,
    startedMs: Number(job.startedMs || 0),
    updatedAt: job.updatedAt || null,
    updatedMs: Number(job.updatedMs || 0),
    revision: Number(job.revision || 0),
    finishedAt: job.finishedAt || null,
    finishedMs: Number(job.finishedMs || 0),
    result: job.result || null,
    error: job.error || null,
    log: Array.isArray(job.log) ? job.log.slice(-JOB_LOG_LIMIT) : [],
  };
}

export function jobsStatePayload() {
  const serializedJobs = [...jobs.values()]
    .map(normalizeJobForPersistence)
    .filter(Boolean)
    .sort((a, b) => Number(b.createdMs || 0) - Number(a.createdMs || 0));

  return {
    schemaVersion: JOBS_STATE_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    updatedAt: nowIso(),
    updatedMs: Date.now(),
    jobSequence,
    jobs: serializedJobs,
  };
}

export async function flushJobsState() {
  jobsStateWriteInProgress = true;
  try {
    while (pendingJobWrites.size) await Promise.allSettled([...pendingJobWrites]);
  } finally {
    jobsStateWriteInProgress = false;
    jobsStateWritePending = false;
  }
}

function queueJobWrite(job) {
  const snapshot = normalizeJobForPersistence(job);
  const previous = jobWriteChains.get(snapshot.id) || Promise.resolve();
  const operation = previous.then(async () => {
    const store = getJobStore();
    const current = await store.readJob(snapshot.id);
    if (!current) return store.createJob(snapshot);
    return store.updateJob(snapshot.id, snapshot, { updatedMs: snapshot.updatedMs });
  }).then((persisted) => {
    const current = jobs.get(snapshot.id);
    if (!current || Number(persisted.revision || 0) >= Number(current.revision || 0)) jobs.set(snapshot.id, persisted);
    return persisted;
  }).catch((error) => {
    if (error instanceof JobUpdateRejectedError && error.current) jobs.set(snapshot.id, error.current);
    console.error(`[${SERVER_NAME}] ${error instanceof Error ? error.message : String(error)}`);
    return error.current || null;
  });
  jobWriteChains.set(snapshot.id, operation);
  pendingJobWrites.add(operation);
  jobsStateWritePending = true;
  operation.finally(() => {
    pendingJobWrites.delete(operation);
    if (jobWriteChains.get(snapshot.id) === operation) jobWriteChains.delete(snapshot.id);
  });
  return operation;
}

export function persistJobsStateSoon(job = null) {
  if (job) return queueJobWrite(job);
  return Promise.all([...jobs.values()].map(queueJobWrite));
}

export function trimJobHistory({ persist = false } = {}) {
  const items = [...jobs.values()].sort((a, b) => Number(a.createdMs || 0) - Number(b.createdMs || 0));
  let changed = false;

  while (items.length > JOB_HISTORY_LIMIT) {
    const old = items.shift();
    if (!old) break;
    if (old.status === "running" || old.status === "queued") {
      items.push(old);
      break;
    }
    jobs.delete(old.id);
    void getJobStore().deleteJob(old.id).catch((error) => console.error(`[${SERVER_NAME}] Failed to trim job ${old.id}: ${error.message}`));
    changed = true;
  }

  if (changed && persist) void Promise.all([...jobs.values()].map(queueJobWrite));
}

export function activeJobCount() {
  return [...jobs.values()].filter((job) => job.status === "running" || job.status === "queued").length;
}

export function updateJob(job, patch = {}) {
  if (TERMINAL_JOB_STATES.has(job.status) && patch.status && patch.status !== job.status) {
    throw new JobUpdateRejectedError(job.id, `terminal state ${job.status} is monotonic and cannot become ${patch.status}`, job);
  }
  const updatedMs = Math.max(Date.now(), Number(job.updatedMs || 0) + 1);
  Object.assign(job, patch, { updatedAt: new Date(updatedMs).toISOString(), updatedMs });
  if (patch.message) {
    job.log = job.log || [];
    job.log.push({ at: job.updatedAt, message: patch.message, phase: patch.phase || job.phase || "" });
    if (job.log.length > JOB_LOG_LIMIT) job.log = job.log.slice(-JOB_LOG_LIMIT);
  }
  jobs.set(job.id, job);
  trimJobHistory();
  queueJobWrite(job);
  return job;
}

export async function loadJobsStateFromDisk() {
  const store = getJobStore();
  await fs.mkdir(getPathResolver().jobsDir(), { recursive: true });
  let loadedJobs = await store.listJobs();
  let legacySequence = 0;
  const legacyPath = getPathResolver().legacyJobsState();
  if (!loadedJobs.length && await pathExists(legacyPath)) {
    try {
      const parsed = JSON.parse(await fs.readFile(legacyPath, "utf-8"));
      legacySequence = Number(parsed.jobSequence || 0);
      for (const legacyJob of parsed.jobs || []) {
        const normalized = normalizeJobForPersistence(legacyJob);
        if (normalized) await store.createJob(normalized).catch((error) => {
          if (!(error instanceof JobUpdateRejectedError)) throw error;
        });
      }
      loadedJobs = await store.listJobs();
    } catch (error) {
      console.error(`[${SERVER_NAME}] Unable to migrate legacy background jobs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  loadedJobs = await store.recoverJobs();
  let maxSequence = legacySequence;

  jobs.clear();
  for (const loadedJob of loadedJobs) {
    const job = normalizeJobForPersistence(loadedJob);
    if (!job || !job.id) continue;

    maxSequence = Math.max(maxSequence, parseJobSequenceFromId(job.id));

    jobs.set(job.id, job);
  }

  jobSequence = Math.max(jobSequence, maxSequence);
  trimJobHistory();
}


export async function refreshJobsStateFromDisk() {
  const loadedJobs = await getJobStore().listJobs();
  let maxSequence = jobSequence;
  const loadedIds = new Set();
  for (const loadedJob of loadedJobs) {
    const job = normalizeJobForPersistence(loadedJob);
    if (!job || !job.id) continue;
    loadedIds.add(job.id);
    maxSequence = Math.max(maxSequence, parseJobSequenceFromId(job.id));
    const current = jobs.get(job.id);
    if (!current || Number(job.updatedMs || 0) >= Number(current.updatedMs || 0)) {
      jobs.set(job.id, job);
    }
  }
  for (const id of [...jobs.keys()]) if (!loadedIds.has(id)) jobs.delete(id);
  jobSequence = Math.max(jobSequence, maxSequence);
}

export function jobSnapshot(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    filename: job.filename,
    phase: job.phase || "",
    progress: job.progress || null,
    message: job.message || "",
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    durationMs: job.startedMs ? ((job.finishedMs || Date.now()) - job.startedMs) : 0,
    result: job.result || null,
    error: job.error || null,
    metadata: job.metadata || {},
    log: (job.log || []).slice(-20),
  };
}

export function formatJobStatus(job) {
  if (!job) return "Job not found.";
  return [
    `Job: ${job.id}`,
    `Type: ${job.type}`,
    `Status: ${job.status}`,
    `File: ${job.filename}`,
    `Phase: ${job.phase || "unknown"}`,
    `Message: ${job.message || ""}`,
    job.metadata?.engineMode ? `Engine mode: ${job.metadata.engineMode}` : null,
    job.metadata?.engine ? `Worker engine: ${job.metadata.engine}` : null,
    job.metadata?.orchestratorPid ? `Orchestrator PID: ${job.metadata.orchestratorPid}` : null,
    job.metadata?.workerPid ? `Python worker PID: ${job.metadata.workerPid}` : null,
    job.progress ? `Progress: ${job.progress.current || 0}/${job.progress.total || "?"} ${job.progress.unit || ""} (${job.progress.percent ?? "?"}%)` : null,
    `Created: ${job.createdAt}`,
    job.startedAt ? `Started: ${job.startedAt}` : null,
    job.finishedAt ? `Finished: ${job.finishedAt}` : null,
    job.startedMs ? `Duration: ${(job.finishedMs || Date.now()) - job.startedMs} ms` : null,
    job.result ? "" : null,
    job.result ? "Result:" : null,
    job.result ? JSON.stringify(job.result, null, 2) : null,
    job.error ? "" : null,
    job.error ? `Error: ${job.error}` : null,
    "",
    "Recent log:",
    ...((job.log || []).slice(-12).map((entry) => `- ${entry.at} ${entry.phase ? `[${entry.phase}] ` : ""}${entry.message}`)),
  ].filter(Boolean).join("\n");
}

export function formatJobsList() {
  const rows = [...jobs.values()].sort((a, b) => Number(b.createdMs || 0) - Number(a.createdMs || 0));
  if (!rows.length) return "No background jobs.";
  return [
    "Background jobs",
    "",
    ...rows.map((job) => [
      `- ${job.id}`,
      `  type: ${job.type}`,
      `  status: ${job.status}`,
      `  file: ${job.filename}`,
      `  phase: ${job.phase || "unknown"}`,
      `  message: ${job.message || ""}`,
      job.metadata?.engine ? `  engine: ${job.metadata.engine}` : job.metadata?.engineMode ? `  engine mode: ${job.metadata.engineMode}` : null,
      job.progress ? `  progress: ${job.progress.current || 0}/${job.progress.total || "?"} ${job.progress.unit || ""} (${job.progress.percent ?? "?"}%)` : null,
      `  updated: ${job.updatedAt || job.createdAt}`,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

export function startBackgroundJob(type, filename, runner, metadata = {}) {
  trimJobHistory({ persist: true });
  if (activeJobCount() >= MAX_ACTIVE_JOBS) {
    throw new Error(`Too many active jobs (${MAX_ACTIVE_JOBS}). Wait for a running job to finish before starting another.`);
  }

  const job = {
    id: createJobId(type),
    type,
    filename,
    status: "queued",
    phase: "queued",
    message: "Queued",
    createdAt: nowIso(),
    createdMs: Date.now(),
    updatedAt: nowIso(),
    updatedMs: Date.now(),
    metadata,
    log: [],
  };
  jobs.set(job.id, job);
  updateJob(job, { message: "Queued", phase: "queued" });

  setTimeout(async () => {
    try {
      if (job.status === "cancelled") return;
      updateJob(job, { status: "running", phase: "start", message: "Job started", startedAt: nowIso(), startedMs: Date.now() });
      const result = await runner(job);
      if (job.status === "cancelled") return;
      updateJob(job, { status: "done", phase: "done", message: "Job completed", finishedAt: nowIso(), finishedMs: Date.now(), result });
    } catch (error) {
      if (job.status === "cancelled") return;
      updateJob(job, { status: "failed", phase: "failed", message: "Job failed", finishedAt: nowIso(), finishedMs: Date.now(), error: error instanceof Error ? error.message : String(error) });
    }
  }, BACKGROUND_JOB_START_DELAY_MS);

  return job;
}

export function updateIndexJobProgress(job, phase, current = 0, total = 0, unit = "") {
  if (job && job.status === "cancelled") {
    throw new Error(`Job cancelled: ${job.id}`);
  }
  const percent = total ? Math.min(100, Math.round((Number(current || 0) / Number(total)) * 100)) : null;
  updateJob(job, {
    phase,
    progress: { current, total, unit, percent },
    message: total ? `${phase}: ${current}/${total} ${unit}` : phase,
  });
}

export async function startIndexPdfJob(filename, options = {}) {
  return startExternalRebuildArtifactJob(filename, "core", { ...options, jobType: "index-pdf" });
}

export async function startExternalRebuildArtifactJob(filename, artifact, options = {}) {
  trimJobHistory({ persist: true });
  if (activeJobCount() >= MAX_ACTIVE_JOBS) {
    throw new Error(`Too many active jobs (${MAX_ACTIVE_JOBS}). Wait for a running job to finish before starting another.`);
  }

  const normalized = normalizeArtifactName(artifact);
  const job = {
    id: createJobId("rebuild-artifact"),
    type: options.jobType || "rebuild-artifact",
    filename,
    status: "queued",
    phase: "queued",
    message: "Queued in detached external worker process",
    createdAt: nowIso(),
    createdMs: Date.now(),
    updatedAt: nowIso(),
    updatedMs: Date.now(),
    metadata: { artifact: normalized, forceLock: Boolean(options.forceLock), force: Boolean(options.force), worker: true, detached: true, engineMode: process.env.RENESAS_MCP_EXTRACTION_ENGINE || "auto" },
    log: [],
  };
  jobs.set(job.id, job);
  updateJob(job, { message: "Queued in detached external worker process", phase: "queued" });
  await flushJobsState();

  const workerArgs = {
    jobId: job.id,
    filename,
    artifact: normalized,
    options: {
      forceLock: Boolean(options.forceLock),
      force: Boolean(options.force),
      chunkSize: clampChunkSize(options.chunkSize),
      chunkOverlap: clampChunkOverlap(options.chunkOverlap, clampChunkSize(options.chunkSize)),
      allowFullRebuild: options.allowFullRebuild !== false,
      cascadeDependents: Boolean(options.cascadeDependents),
    },
  };
  const encoded = Buffer.from(JSON.stringify(workerArgs), "utf-8").toString("base64");

  // Step 40.3: detach the worker. Do not use execFile callback here because
  // the parent MCP server would keep a child-process handle and stdout/stderr
  // buffers while the PDF worker runs. Some MCP clients treat that as a tool
  // call that has not fully settled and cancel subsequent calls. The worker is
  // responsible for updating the persistent jobs state file by jobId.
  try {
    const child = spawn(
      process.execPath,
      [getPathResolver().appEntry(), "--worker-rebuild-artifact", encoded],
      {
        cwd: getPathResolver().root(),
        env: { ...process.env, RENESAS_MCP_ROOT: getPathResolver().root() },
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }
    );
    updateJob(job, { metadata: { ...(job.metadata || {}), orchestratorPid: child.pid } });
    await flushJobsState();
    child.unref();
  } catch (error) {
    updateJob(job, {
      status: "failed",
      phase: "worker-spawn-failed",
      message: "Failed to spawn detached external worker",
      finishedAt: nowIso(),
      finishedMs: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return job;
}

export function normalizeArtifactName(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  const aliases = new Map([
    ["page", "pages"], ["pages-cache", "pages"], ["pages", "pages"],
    ["chunk", "chunk-index"], ["chunks", "chunk-index"], ["index", "chunk-index"], ["chunk-index", "chunk-index"],
    ["section", "sections"], ["sections", "sections"], ["sections-index", "sections"],
    ["table", "tables"], ["tables", "tables"], ["tables-index", "tables"],
    ["register", "registers"], ["registers", "registers"], ["registers-index", "registers"],
    ["bitfield", "bitfields"], ["bitfields", "bitfields"], ["bitfields-index", "bitfields"],
    ["sequence", "sequences"], ["sequences", "sequences"], ["sequences-index", "sequences"],
    ["caution", "cautions"], ["cautions", "cautions"], ["cautions-index", "cautions"],
    ["figure", "figures"], ["figures", "figures"], ["figures-index", "figures"],
    ["figure-ocr", "figure_ocr"], ["figure_ocr", "figure_ocr"], ["ocr", "figure_ocr"], ["figures-ocr", "figure_ocr"],
    ["figure-semantic", "figure_semantic"], ["figure_semantic", "figure_semantic"], ["figure-semantics", "figure_semantic"], ["semantics", "figure_semantic"],
    ["evidence-graph", "evidence-graph"], ["graph", "evidence-graph"], ["evidence_graph", "evidence-graph"],
    ["all", "all"], ["core", "core"], ["driver", "driver"],
  ]);
  return aliases.get(raw) || raw;
}

export function artifactPathsForStatus(filename) {
  return [
    { key: "pages", label: "Pages cache", path: safePagesCachePath(filename), schemaVersion: PAGE_CACHE_SCHEMA_VERSION, rootKey: "pages", countKey: "pageCount" },
    { key: "pages-partial", label: "Partial pages checkpoint", path: safePagesPartialCachePath(filename), schemaVersion: PAGE_CACHE_SCHEMA_VERSION, rootKey: "pages", countKey: "pageCount", optional: true },
    { key: "chunk-index", label: "Chunk index", path: safeIndexPath(filename), schemaVersion: INDEX_SCHEMA_VERSION, rootKey: "chunks", countKey: "chunkCount" },
    { key: "sections", label: "Sections index", path: safeSectionsIndexPath(filename), schemaVersion: SECTION_INDEX_SCHEMA_VERSION, rootKey: "sections", countKey: "sectionCount" },
    { key: "tables", label: "Tables index", path: safeTablesIndexPath(filename), schemaVersion: TABLE_INDEX_SCHEMA_VERSION, rootKey: "tables", countKey: "tableCount" },
    { key: "tables-partial", label: "Partial tables checkpoint", path: safeTablesPartialIndexPath(filename), schemaVersion: TABLE_INDEX_SCHEMA_VERSION, rootKey: "tables", countKey: "scannedPageCount", optional: true },
    { key: "registers", label: "Registers index", path: safeRegistersIndexPath(filename), schemaVersion: REGISTER_INDEX_SCHEMA_VERSION, rootKey: "registers", countKey: "registerCount" },
    { key: "bitfields", label: "Bitfields index", path: safeBitfieldsIndexPath(filename), schemaVersion: BITFIELD_INDEX_SCHEMA_VERSION, rootKey: "bitfields", countKey: "bitfieldCount" },
    { key: "sequences", label: "Sequences index", path: safeSequencesIndexPath(filename), schemaVersion: SEQUENCE_INDEX_SCHEMA_VERSION, rootKey: "sequences", countKey: "sequenceCount" },
    { key: "cautions", label: "Cautions index", path: safeCautionsIndexPath(filename), schemaVersion: CAUTION_INDEX_SCHEMA_VERSION, rootKey: "cautions", countKey: "cautionCount" },
    { key: "figures", label: "Figures index", path: safeFiguresIndexPath(filename), schemaVersion: FIGURE_INDEX_SCHEMA_VERSION, rootKey: "figures", countKey: "figureCount" },
    { key: "evidence-graph", label: "Evidence graph", path: safeEvidenceGraphPath(filename), schemaVersion: EVIDENCE_GRAPH_SCHEMA_VERSION, rootKey: "entities", countKey: "entityCount", optional: true },
    { key: "figure_ocr", label: "Figure OCR index", path: safeFigureOcrIndexPath(filename), schemaVersion: FIGURE_OCR_SCHEMA_VERSION, rootKey: "figures", countKey: "figureOcrCount", optional: true },
    { key: "figure_semantic", label: "Figure semantic index", path: safeFigureSemanticIndexPath(filename), schemaVersion: FIGURE_SEMANTIC_SCHEMA_VERSION, rootKey: "records", countKey: "semanticCount", optional: true },
    { key: "visual-evidence", label: "Visual evidence", path: safeVisualEvidencePath(filename), schemaVersion: VISUAL_EVIDENCE_SCHEMA_VERSION, rootKey: "entries", countKey: "entryCount", optional: true },
    { key: "module-profile", label: "Module profile", path: safeModuleProfileJsonPath(filename), schemaVersion: MODULE_PROFILE_SCHEMA_VERSION, rootKey: "profile", optional: true },
    { key: "driver-pack", label: "Driver evidence pack", path: safeDriverPackPath(filename), text: true, optional: true },
    { key: "driver-pack-json", label: "Driver evidence pack JSON", path: safeDriverPackJsonPath(filename), schemaVersion: DRIVER_ARTIFACT_SCHEMA_VERSION, rootKey: "pack", optional: true },
    { key: "driver-pack-md", label: "Driver evidence pack Markdown", path: safeDriverPackMarkdownPath(filename), text: true, optional: true },
    { key: "driver-task-plan", label: "Driver task plan", path: safeDriverTaskPlanPath(filename), text: true, optional: true },
    { key: "driver-task-plan-json", label: "Driver task plan JSON", path: safeDriverTaskPlanJsonPath(filename), schemaVersion: DRIVER_ARTIFACT_SCHEMA_VERSION, rootKey: "plan", optional: true },
    { key: "driver-task-plan-md", label: "Driver task plan Markdown", path: safeDriverTaskPlanMarkdownPath(filename), text: true, optional: true },
  ];
}

export function jsonHeadString(head, key) {
  const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = head.match(re);
  if (!match) return null;
  try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
}

export function jsonHeadNumber(head, key) {
  const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`);
  const match = head.match(re);
  return match ? Number(match[1]) : null;
}

export function jsonHeadBoolean(head, key) {
  const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*(true|false)`);
  const match = head.match(re);
  return match ? match[1] === "true" : null;
}

export async function readFileHead(filePath, maxBytes = STATUS_FAST_READ_BYTES) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(Number(stat.size || 0), maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return { head: buffer.subarray(0, bytesRead).toString("utf-8"), size: stat.size, modifiedAt: stat.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

export async function readArtifactStatus(entry, filename) {
  const exists = await pathExists(entry.path);
  const status = {
    key: entry.key,
    label: entry.label,
    path: entry.path,
    exists,
    optional: Boolean(entry.optional),
    ok: false,
    schemaVersion: null,
    count: null,
    createdAt: null,
    modifiedAt: null,
    sizeBytes: null,
    fastStatus: true,
    text: Boolean(entry.text),
    error: "",
  };

  if (!exists) { status.error = entry.optional ? "missing optional artifact" : "missing"; return status; }

  try {
    const fileStat = await fs.stat(entry.path);
    status.sizeBytes = fileStat.size;
    status.modifiedAt = fileStat.mtime.toISOString();

    if (entry.text) {
      status.ok = true;
      status.count = fileStat.size;
      status.createdAt = status.modifiedAt;
      return status;
    }

    if (fileStat.size <= STATUS_FULL_PARSE_MAX_BYTES) {
      status.fastStatus = false;
      const parsed = JSON.parse(await fs.readFile(entry.path, "utf-8"));
      status.schemaVersion = parsed.schemaVersion ?? null;
      status.createdAt = parsed.createdAt || parsed.updatedAt || status.modifiedAt;
      status.ok = entry.schemaVersion === undefined || parsed.schemaVersion === entry.schemaVersion;
      if (!status.ok) status.error = `schema mismatch: expected ${entry.schemaVersion}, got ${parsed.schemaVersion}`;
      if (entry.countKey && Number.isFinite(Number(parsed[entry.countKey]))) status.count = Number(parsed[entry.countKey]);
      else if (Array.isArray(parsed[entry.rootKey])) status.count = parsed[entry.rootKey].length;
      else if (entry.key === "module-profile") status.count = 1;
      if (parsed.filename && parsed.filename !== filename) { status.ok = false; status.error = `filename mismatch: ${parsed.filename}`; }
      return status;
    }

    const { head } = await readFileHead(entry.path);
    status.schemaVersion = jsonHeadNumber(head, "schemaVersion");
    status.createdAt = jsonHeadString(head, "createdAt") || jsonHeadString(head, "updatedAt") || status.modifiedAt;
    status.count = entry.countKey ? jsonHeadNumber(head, entry.countKey) : null;
    status.artifactComplete = jsonHeadBoolean(head, "artifactComplete");
    const artifactFilename = jsonHeadString(head, "filename");

    status.ok = entry.schemaVersion === undefined || status.schemaVersion === entry.schemaVersion;
    if (!status.ok) {
      status.error = status.schemaVersion === null
        ? `schemaVersion not found in first ${STATUS_FAST_READ_BYTES} bytes`
        : `schema mismatch: expected ${entry.schemaVersion}, got ${status.schemaVersion}`;
    }
    if (artifactFilename && artifactFilename !== filename) { status.ok = false; status.error = `filename mismatch: ${artifactFilename}`; }
    if (!artifactFilename && entry.key !== "module-profile") status.error = status.error || "filename not found in fast metadata window";
    if (entry.key === "module-profile" && status.count === null) status.count = 1;
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
  }
  return status;
}

export async function buildArtifactManifest(filename, options = {}) {
  let source = {};
  try {
    source = await getPdfSourceInfo(filename, { includeHash: true });
  } catch {
    source = {};
  }

  const artifacts = [];
  for (const entry of artifactPathsForStatus(filename)) {
    artifacts.push(await readArtifactStatus(entry, filename));
  }

  return createArtifactManifest({
    filename,
    serverVersion: SERVER_VERSION,
    source,
    artifacts,
    buildStatus: options.buildStatus || "ready",
    notes: options.notes || [],
    staleArtifacts: options.staleArtifacts || [],
    producer: options.producer || null,
  });
}

export async function writeArtifactManifest(filename, options = {}) {
  const previous = await loadArtifactManifest(filename);
  const stale = new Set(options.clearStale ? [] : (previous?.staleArtifacts || []));
  const rebuilt = new Set(options.rebuiltArtifacts || []);
  for (const artifact of rebuilt) stale.delete(artifact);
  for (const descendant of artifactDescendants([...rebuilt])) {
    if (!rebuilt.has(descendant)) stale.add(descendant);
  }
  for (const artifact of options.invalidatedArtifacts || []) stale.add(artifact);
  const manifest = await buildArtifactManifest(filename, { ...options, producer: options.producer === undefined ? previous?.producer || null : options.producer, staleArtifacts: [...stale] });
  await atomicWriteJson(safeArtifactManifestPath(filename), manifest);
  return manifest;
}

export async function loadArtifactManifest(filename) {
  const manifestPath = safeArtifactManifestPath(filename);
  if (!(await pathExists(manifestPath))) return null;
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    if (manifest.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) return null;
    return manifest;
  } catch {
    return null;
  }
}

export function deriveStatusPageCount(artifacts) {
  const preferred = artifacts.find((a) => a.key === "pages" && a.exists && a.ok && Number.isFinite(Number(a.count)));
  if (preferred) return { pageCount: Number(preferred.count), source: "pages artifact" };
  const partial = artifacts.find((a) => a.key === "pages-partial" && a.exists && Number.isFinite(Number(a.count)));
  if (partial) return { pageCount: Number(partial.count), source: "partial pages artifact" };
  return { pageCount: 0, source: "not probed" };
}

export async function getIndexStatus(filename, options = {}) {
  const stat = await getFileStat(filename);
  const lockPath = safeIndexLockPath(filename);
  const lockExists = await pathExists(lockPath);
  const artifacts = [];
  for (const entry of artifactPathsForStatus(filename)) artifacts.push(await readArtifactStatus(entry, filename));

  let { pageCount, source: pageCountSource } = deriveStatusPageCount(artifacts);
  if (options.probePdf === true) {
    try { pageCount = await getPdfPageCount(filename); pageCountSource = "pdf probe"; }
    catch (error) { pageCountSource = `pdf probe failed: ${error instanceof Error ? error.message : String(error)}`; }
  }

  const required = artifacts.filter((a) => !a.optional && a.key !== "visual-evidence");
  const missing = required.filter((a) => !a.exists).map((a) => a.key);
  const broken = required.filter((a) => a.exists && !a.ok).map((a) => a.key);
  const relatedJobs = [...jobs.values()].filter((job) => job.filename === filename).sort((a, b) => Number(b.createdMs || 0) - Number(a.createdMs || 0)).slice(0, 8).map(jobSnapshot);
  const manifest = await loadArtifactManifest(filename);
  return { filename, pdf: { size: stat.size, modifiedAt: stat.mtime.toISOString(), pageCount, pageCountSource }, lock: { exists: lockExists, path: lockPath }, health: missing.length || broken.length ? "WARN" : "OK", missing, broken, artifacts, manifest, relatedJobs };
}

export function getIndexStatusUltraLite(filename) {
  ensurePdfFilename(filename);
  const artifacts = artifactPathsForStatus(filename).map((entry) => ({
    key: entry.key,
    label: entry.label,
    path: entry.path,
    optional: Boolean(entry.optional),
    checked: false,
    note: "not checked in ultra-lite mode",
  }));
  return {
    filename,
    mode: "ultra-lite",
    serverVersion: SERVER_VERSION,
    generatedAt: nowIso(),
    documentsDir: getPathResolver().documentsDir(),
    indexDir: getPathResolver().indexDir(),
    jobsStatePath: safeJobsStatePath(),
    health: "UNKNOWN",
    pdf: {
      checked: false,
      pageCount: 0,
      pageCountSource: "not probed",
      note: "ultra-lite mode does not stat/open the PDF to avoid MCP client cancellation",
    },
    lock: {
      checked: false,
      path: safeIndexLockPath(filename),
      note: "not checked in ultra-lite mode",
    },
    artifacts,
    relatedJobs: [],
    next: [
      `For detailed artifact checks, call mcp_control(action="index_status_lite", filename="${filename}").`,
      `To avoid blocking the MCP server, run mcp_control(action="rebuild_artifact", filename="${filename}", artifact="pages") and poll mcp_control(action="job_status", job_id="...") or mcp_control(action="list_jobs").`,
    ],
  };
}

export function formatIndexStatusUltraLite(status) {
  return [
    `Index status for ${status.filename}: ${status.health} (${status.mode})`,
    `Server version: ${status.serverVersion}`,
    `PDF pages: unknown (${status.pdf.pageCountSource})`,
    `Documents dir: ${status.documentsDir}`,
    `Index dir: ${status.indexDir}`,
    `Jobs state: ${status.jobsStatePath}`,
    "",
    "No filesystem/PDF/artifact probing was performed in this default mode.",
    "This mode is intentionally O(1) and timeout-safe for MCP clients.",
    "",
    "Expected artifacts:",
    ...status.artifacts.map((a) => `- ${a.key}: ${a.path}${a.optional ? " (optional)" : ""}`),
    "",
    "Next:",
    ...status.next.map((line) => `- ${line}`),
  ].join("\n");
}

export function formatIndexStatus(status) {
  return [
    `Index status for ${status.filename}: ${status.health}`,
    `PDF pages: ${status.pdf.pageCount || "unknown"}${status.pdf.pageCountSource ? ` (${status.pdf.pageCountSource})` : ""}`,
    `PDF modified: ${status.pdf.modifiedAt}`,
    `Lock: ${status.lock.exists ? "present" : "none"}`,
    status.lock.exists ? `Lock path: ${status.lock.path}` : null,
    "",
    status.manifest ? formatManifestSummary(status.manifest) : `Artifact manifest: missing (${safeArtifactManifestPath(status.filename)})`,
    "",
    "Artifacts:",
    ...status.artifacts.map((a) => `- ${a.key}: ${a.exists ? (a.ok ? "OK" : "BROKEN") : (a.optional ? "missing optional" : "MISSING")}${a.count !== null ? ` count=${a.count}` : ""}${a.sizeBytes !== null ? ` size=${a.sizeBytes}` : ""}${a.createdAt ? ` created=${a.createdAt}` : ""}${a.fastStatus && a.exists && !a.text ? " fast=1" : ""}${a.error ? ` (${a.error})` : ""}`),
    status.relatedJobs.length ? "" : null,
    status.relatedJobs.length ? "Recent jobs:" : null,
    ...status.relatedJobs.map((j) => `- ${j.id}: ${j.status} ${j.phase || ""} ${j.progress ? `${j.progress.current}/${j.progress.total || "?"} ${j.progress.unit || ""}` : ""}`),
  ].filter(Boolean).join("\n");
}

export function coreHealthFromArtifactStatus(artifacts = []) {
  const coreKeys = new Set(["pages", "chunk-index", "sections", "registers", "bitfields", "sequences", "cautions"]);
  const core = artifacts.filter((artifact) => coreKeys.has(artifact.key));
  if (core.some((artifact) => !artifact.exists || !artifact.ok)) return "fail";
  return "ok";
}

export function advisoryHealthFromArtifactStatus(artifacts = []) {
  const coreKeys = new Set(["pages", "chunk-index", "sections", "registers", "bitfields", "sequences", "cautions"]);
  const advisory = artifacts.filter((artifact) => !coreKeys.has(artifact.key));
  if (advisory.some((artifact) => (artifact.exists && !artifact.ok) || (!artifact.optional && !artifact.exists))) return "warn";
  return "ok";
}

export function pdfInfoArtifactBlock({
  artifact,
  label,
  readyLabel = label,
  statusLabel = `${label} status`,
  countLabel = "Count",
  pathLabel = `${label} path`,
  missingText = `${label}: no`,
}) {
  if (!artifact) return missingText;
  const exists = Boolean(artifact.exists);
  const ready = exists && artifact.ok;
  const lines = [
    `${readyLabel}: ${exists ? "yes" : "no"}`,
    exists ? `${statusLabel}: ${ready ? "valid" : "broken/unreadable"}` : null,
    artifact.error ? `${statusLabel} detail: ${artifact.error}` : null,
    artifact.createdAt ? `${label} created: ${artifact.createdAt}` : null,
    artifact.schemaVersion !== null && artifact.schemaVersion !== undefined ? `${label} schema: ${artifact.schemaVersion}` : null,
    artifact.count !== null && artifact.count !== undefined ? `${countLabel}: ${artifact.count}` : null,
    artifact.path ? `${pathLabel}: ${artifact.path}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

export async function cancelBackgroundJob(jobId, reason = "Cancelled by user") {
  const store = getJobStore();
  let job = await store.readJob(jobId) || jobs.get(jobId);
  if (!job) return null;
  if (["done", "failed", "cancelled"].includes(job.status)) return job;
  if (!(await store.readJob(jobId))) job = await store.createJob(job);
  const updatedMs = Math.max(Date.now(), Number(job.updatedMs || 0) + 1);
  const updatedAt = new Date(updatedMs).toISOString();
  const patch = {
    status: "cancelled", phase: "cancelled", message: reason, finishedAt: updatedAt, finishedMs: updatedMs,
    updatedAt, updatedMs, error: reason,
    log: [...(job.log || []).slice(-(JOB_LOG_LIMIT - 1)), { at: updatedAt, phase: "cancelled", message: reason }],
  };
  const cancelled = await store.updateJob(jobId, patch, { updatedMs });
  jobs.set(jobId, cancelled);
  const cancelPath = job.metadata?.cancelPath;
  if (cancelPath) {
    try {
      writeFileSync(cancelPath, `${reason}\n`, "utf8");
    } catch {
      // Keep cancellation best-effort; job status is still updated in memory/state.
    }
  }
  const workerPid = Number(job.metadata?.workerPid || 0);
  const orchestratorPid = Number(job.metadata?.orchestratorPid || 0);
  for (const pid of [workerPid, orchestratorPid]) {
    if (pid > 0) {
      try { process.kill(pid); } catch { /* Process may have completed between refresh and cancellation. */ }
    }
  }
  return cancelled;
}

export async function cleanupBackgroundJobs(options = {}) {
  const includeRunning = Boolean(options.includeRunning);
  const olderThanHours = Number(options.olderThanHours ?? 0);
  const statuses = new Set(Array.isArray(options.statuses) && options.statuses.length ? options.statuses : ["done", "failed", "cancelled"]);
  const removed = await getJobStore().cleanupJobs({
    includeRunning,
    statuses: [...statuses],
    olderThanMs: olderThanHours > 0 ? olderThanHours * 60 * 60 * 1000 : 0,
  });
  for (const id of removed) jobs.delete(id);
  return removed;
}

export async function rewriteMainIndexCounts(filename, patch = {}) {
  const indexPath = safeIndexPath(filename);
  if (!(await pathExists(indexPath))) return null;
  const indexData = await loadPdfIndex(filename);
  Object.assign(indexData, patch, { updatedAt: new Date().toISOString() });
  await atomicWriteJson(indexPath, indexData);
  return indexData;
}

async function rebuildArtifactOperation(filename, artifact, options = {}) {
  const normalized = normalizeArtifactName(artifact);
  const forceLock = Boolean(options.forceLock);
  const force = Boolean(options.force);
  const chunkSize = clampChunkSize(options.chunkSize);
  const chunkOverlap = clampChunkOverlap(options.chunkOverlap, chunkSize);
  const allowFullRebuild = options.allowFullRebuild !== false;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  if (["all", "core", "chunk-index"].includes(normalized)) {
    if (onProgress) onProgress({ phase: normalized === "chunk-index" ? "rebuild-chunk-index" : "rebuild-core", current: 0, total: 0, unit: "" });
    const indexData = await buildPdfIndex(filename, { forceLock, chunkSize, chunkOverlap, reusePageCache: true, onProgress, onWorkerContext: options.onWorkerContext, onWorkerSpawn: options.onWorkerSpawn, onWorkerStderr: options.onWorkerStderr, extractionEngine: options.extractionEngine });
    await writeArtifactManifest(filename, { buildStatus: "ready", notes: [`rebuilt ${normalized}`], clearStale: true });
    return { artifact: normalized, rebuilt: ["pages", "sections", "chunk-index", "tables", "registers", "bitfields", "cautions", "sequences", "figures", "evidence-graph"], counts: { pages: indexData.pageCount, chunks: indexData.chunkCount, tables: indexData.tableCount, registers: indexData.registerCount, bitfields: indexData.bitfieldCount, sequences: indexData.sequenceCount, cautions: indexData.cautionCount, figures: indexData.figureCount, evidenceGraphEntities: indexData.evidenceGraphEntityCount || 0 } };
  }
  if (normalized === "pages") {
    if (onProgress) onProgress({ phase: "rebuild-pages", current: 0, total: 0, unit: "" });
    const pageCache = await buildPagesCache(filename, { onProgress, onWorkerContext: options.onWorkerContext, onWorkerSpawn: options.onWorkerSpawn, onWorkerStderr: options.onWorkerStderr, extractionEngine: options.extractionEngine });
    await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt pages cache"], rebuiltArtifacts: ["pages"], producer: pageCache.producer || null });
    return { artifact: normalized, rebuilt: ["pages"], counts: { pages: pageCache.pages.length } };
  }
  const pageCache = await getPagesCache(filename, { buildIfMissing: allowFullRebuild });
  if (normalized === "sections") { const sections = await buildSectionsIndex(filename, pageCache); await rewriteMainIndexCounts(filename, { sectionCount: sections.sectionCount }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt sections index"], rebuiltArtifacts: ["sections"] }); return { artifact: normalized, rebuilt: ["sections"], counts: { sections: sections.sectionCount } }; }
  let indexData = null;
  try { indexData = await loadPdfIndex(filename); } catch (error) { if (!allowFullRebuild) throw error; indexData = await buildPdfIndex(filename, { forceLock, chunkSize, chunkOverlap, reusePageCache: true, onProgress, onWorkerContext: options.onWorkerContext, onWorkerSpawn: options.onWorkerSpawn, onWorkerStderr: options.onWorkerStderr, extractionEngine: options.extractionEngine }); }
  const sectionsIndex = await getSectionsIndex(filename);
  const tablesIndex = await loadTablesIndex(filename);
  if (normalized === "tables") {
    const tables = await buildTablesIndex(filename, indexData, pageCache, sectionsIndex, { onProgress, onWorkerContext: options.onWorkerContext, onWorkerSpawn: options.onWorkerSpawn, onWorkerStderr: options.onWorkerStderr, extractionEngine: options.extractionEngine });
    const rebuilt = ["tables"];
    const counts = { tables: tables.tableCount };
    await rewriteMainIndexCounts(filename, { tableCount: tables.tableCount });
    if (options.cascadeDependents) {
      const registers = await buildRegistersIndex(filename, indexData, sectionsIndex, tables);
      const bitfields = await buildBitfieldsIndex(filename, indexData, registers, tables);
      const cautions = await buildCautionsIndex(filename, indexData, sectionsIndex, registers);
      const sequences = await buildSequencesIndex(filename, indexData, sectionsIndex, registers, { tablesIndex: tables, bitfieldsIndex: bitfields, cautionsIndex: cautions });
      Object.assign(counts, { registers: registers.registerCount, bitfields: bitfields.bitfieldCount, cautions: cautions.cautionCount, sequences: sequences.sequenceCount });
      rebuilt.push("registers", "bitfields", "cautions", "sequences");
      await rewriteMainIndexCounts(filename, { registerCount: registers.registerCount, bitfieldCount: bitfields.bitfieldCount, cautionCount: cautions.cautionCount, sequenceCount: sequences.sequenceCount });
    }
    await writeArtifactManifest(filename, { buildStatus: options.cascadeDependents ? "ready" : "partial", notes: [options.cascadeDependents ? "rebuilt tables and dependent accuracy artifacts" : "rebuilt tables index; dependent artifacts require rebuild"], rebuiltArtifacts: rebuilt, producer: tables.producer || null });
    return { artifact: normalized, rebuilt, counts };
  }
  if (normalized === "registers") { const registers = await buildRegistersIndex(filename, indexData, sectionsIndex, tablesIndex); await rewriteMainIndexCounts(filename, { registerCount: registers.registerCount }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt registers index"], rebuiltArtifacts: ["registers"] }); return { artifact: normalized, rebuilt: ["registers"], counts: { registers: registers.registerCount } }; }
  const registersIndex = await loadRegistersIndex(filename) || await buildRegistersIndex(filename, indexData, sectionsIndex, tablesIndex);
  if (normalized === "bitfields") { const bitfields = await buildBitfieldsIndex(filename, indexData, registersIndex, tablesIndex); await rewriteMainIndexCounts(filename, { bitfieldCount: bitfields.bitfieldCount }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt bitfields index"], rebuiltArtifacts: ["bitfields"] }); return { artifact: normalized, rebuilt: ["bitfields"], counts: { bitfields: bitfields.bitfieldCount } }; }
  if (normalized === "sequences") { const bitfieldsIndex = await getBitfieldsIndex(filename, { buildIfMissing: true }); const cautionsIndex = await loadCautionsIndex(filename); const sequences = await buildSequencesIndex(filename, indexData, sectionsIndex, registersIndex, { tablesIndex, bitfieldsIndex, cautionsIndex }); await rewriteMainIndexCounts(filename, { sequenceCount: sequences.sequenceCount }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt sequences index"], rebuiltArtifacts: ["sequences"] }); return { artifact: normalized, rebuilt: ["sequences"], counts: { sequences: sequences.sequenceCount } }; }
  if (normalized === "cautions") { const cautions = await buildCautionsIndex(filename, indexData, sectionsIndex, registersIndex); await rewriteMainIndexCounts(filename, { cautionCount: cautions.cautionCount }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt cautions index"], rebuiltArtifacts: ["cautions"] }); return { artifact: normalized, rebuilt: ["cautions"], counts: { cautions: cautions.cautionCount } }; }
  if (normalized === "figures") { const figures = await buildFiguresIndex(filename, pageCache, { force }); await rewriteMainIndexCounts(filename, { figureCount: figures.figureCount }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt figures index"], rebuiltArtifacts: ["figures"], producer: figures.producer || { engine: figures.generatedBy?.includes("python") ? "python" : "node", operation: "figures.extract" } }); return { artifact: normalized, rebuilt: ["figures"], counts: { figures: figures.figureCount } }; }
  if (normalized === "evidence-graph") { const graph = await buildEvidenceGraph(filename); await rewriteMainIndexCounts(filename, { evidenceGraphEntityCount: graph.entities.length }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt normalized evidence graph"], rebuiltArtifacts: ["evidence-graph"] }); return { artifact: normalized, rebuilt: ["evidence-graph"], counts: { entities: graph.entities.length, relationships: graph.relationships.length, conflicts: graph.conflicts.length } }; }
  if (normalized === "figure_ocr") {
    const result = await buildFigureOcrWithPython(filename, { force, onProgress, onWorkerContext: options.onWorkerContext, onWorkerSpawn: options.onWorkerSpawn, onWorkerStderr: options.onWorkerStderr });
    if (result.ok === false) {
      await writeArtifactManifest(filename, { buildStatus: "partial", notes: [`figure OCR unavailable: ${result.error || "OCR unavailable"}`], rebuiltArtifacts: [] });
      return { ok: false, artifact: normalized, rebuilt: [], counts: {}, error: result.error || "OCR unavailable", hint: result.hint || "" };
    }
    await writeArtifactManifest(filename, { buildStatus: "partial", notes: [result.cached ? "figure OCR cache reused" : "rebuilt figure OCR index"], rebuiltArtifacts: ["figure_ocr"], producer: { engine: "python", operation: "figure_ocr.build" } });
    return { ok: true, artifact: normalized, rebuilt: result.cached ? [] : ["figure_ocr"], counts: result.counts || { figure_ocr: result.artifact?.figureOcrCount || 0 } };
  }
  if (normalized === "figure_semantic") {
    const result = await rebuildFigureSemanticsArtifact(filename, { force, onProgress, page: options.page, generateOcr: options.generateOcr });
    await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt figure semantic index"], rebuiltArtifacts: ["figure_semantic"], producer: { engine: "node", operation: "figure_semantics.build" } });
    return result;
  }
  if (normalized === "driver") throw new Error("driver artifact rebuild is intentionally not automatic. Use build_driver_evidence_pack or source_review_prompt_pack with explicit module/focus inputs.");
  throw new Error(`Unknown artifact: ${artifact}. Supported: pages, chunk-index, sections, tables, registers, bitfields, sequences, cautions, figures, evidence-graph, figure_ocr, figure_semantic, core/all.`);
}

export async function rebuildArtifact(filename, artifact, options = {}) {
  return withSourceIdentityCache(async () => {
    await getPdfSourceInfo(filename, { includeHash: true });
    return rebuildArtifactOperation(filename, artifact, options);
  });
}

export async function startRebuildArtifactJob(filename, artifact, options = {}) {
  // Step 40.2: heavy PDF/artifact rebuilds must not run in the MCP server
  // process. Running pdfjs extraction in the same Node event loop can make even
  // tiny follow-up calls such as index_status() look cancelled to the client.
  return await startExternalRebuildArtifactJob(filename, artifact, options);
}
