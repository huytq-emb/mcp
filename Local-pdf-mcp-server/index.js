import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  ARTIFACT_MANIFEST_SCHEMA_VERSION,
  createArtifactManifest,
  formatManifestSummary,
  sourceFingerprint,
} from "./src/artifacts/manifest.js";
import { normalizeEvidenceContract } from "./src/evidence/contract.js";
import {
  DEFAULT_GOLDEN_PROFILE,
  evaluateGoldenProfile,
  formatGoldenReport,
} from "./src/eval/golden.js";

const execFileAsync = promisify(execFile);

/**
 * Local PDF MCP Server
 *
 * Tools:
 * - list_pdfs
 * - pdf_info
 * - doctor
 * - validate_index
 * - list_eval_cases
 * - run_eval
 * - index_pdf
 * - search_pdf
 * - hybrid_search_pdf
 *   - Step 22: BM25 + synonym + symbol alias + proximity ranking
 *   - Step 23: chunkType classification + noise suppression
 * - chunk_type_stats
 * - read_pdf_pages
 * - read_pdf_chunk
 * - find_register
 * - list_registers
 * - find_bitfield
 * - list_bitfields
 * - extract_tables_from_pages
 * - extract_layout_tables_from_pages
 * - extract_register_table
 * - extract_bitfield_table
 * - summarize_register
 * - find_sequence
 * - list_sequences
 * - get_sequence
 * - find_caution
 * - list_cautions
 * - get_cautions_for_register
 * - build_driver_evidence_pack
 * - verify_register_usage
 * - compare_driver_requirements
 * - source_review_prompt_pack
 * - Step 28: data-driven eval profiles + optional fixtures
 * - Step 36: verified visual evidence gate for driver review
 * - Step 29: timeout hardening + background indexing jobs
 * - Step 32: visual review handoff pack
 * - Step 30A: layout-aware register/bitfield table extraction
 * - Step 30B: layout-aware pinmux / pin function table extraction
 * - Step 31A: figure/caption index and visual-context helpers
 * - Step 31B: render selected PDF pages/figure pages for visual review
 * - Step 30A hotfix: COMMON_NON_BITFIELD_WORDS / isLikelyRegisterName
 * - Step 29a: pdf_info TDZ hotfix
 * - analyze_module
 * - get_module_profile
 * - prepare_driver_task
 * - evidence / inference / needs_verification contract in driver-critical outputs
 * - find_section
 *
 * Expected layout:
 *
 * my-mcp-server/
 * ├─ index.js
 * ├─ documents/
 * │  ├─ GBETH.pdf
 * │  └─ WDT.pdf
 * └─ indexes/
 *    ├─ GBETH.pdf.index.json
 *    ├─ GBETH.pdf.pages.json
 *    ├─ GBETH.pdf.sections.json
 *    ├─ GBETH.pdf.registers.json
 *    ├─ GBETH.pdf.bitfields.json
 *    ├─ GBETH.pdf.sequences.json
 *    ├─ GBETH.pdf.driver-pack.txt
 *    ├─ GBETH.pdf.driver-task-plan.txt
 *    ├─ GBETH.pdf.module-profile.json
 *    └─ GBETH.pdf.module-profile.txt
 *
 * driver_profiles/ contains external data-driven subsystem checklists.
 */

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOCUMENTS_DIR = path.join(__dirname, "documents");
const INDEX_DIR = path.join(__dirname, "indexes");
const EVAL_DIR = path.join(__dirname, "eval");
const EVAL_PROFILES_DIR = path.join(EVAL_DIR, "profiles");
const EVAL_FIXTURES_DIR = path.join(EVAL_DIR, "fixtures");
const DRIVER_PROFILES_DIR = path.join(__dirname, "driver_profiles");
const RENDERS_DIR = path.join(__dirname, "renders");

// -----------------------------------------------------------------------------
// Limits / tuning
// -----------------------------------------------------------------------------

const SERVER_NAME = "local-pdf-mcp-server";
const SERVER_VERSION = "7.0.7";
const STEP40_COMPAT_MODE = "eval-health-control-plane";
const STEP40_DIRECT_TOOL_COMPAT_NOTES = [
  "Step 40 direct tool names were observed to be cancelled by some VS Code AI-agent MCP clients even when the server and handler registry were healthy.",
  "The supported Step 40 interface is eval_health_check(step40_action=...).",
  "Direct Step 40 tools remain handled internally for backwards compatibility but are no longer advertised in the tools registry."
];
const STEP40_CONTROL_ACTIONS = [
  "ping",
  "compat_report",
  "index_status_lite",
  "rebuild_artifact",
  "job_status",
  "list_jobs",
  "cancel_job",
  "cleanup_jobs"
];
const EVIDENCE_CONTRACT_SCHEMA_VERSION = 1;
const EVAL_CASES_SCHEMA_VERSION = 1;
const EVAL_PROFILE_SCHEMA_VERSION = 1;
const EVAL_FIXTURE_SCHEMA_VERSION = 1;
const DRIVER_PROFILE_SCHEMA_VERSION = 1;
const VISUAL_EVIDENCE_SCHEMA_VERSION = 1;
const DRIVER_ARTIFACT_SCHEMA_VERSION = 1;

const DEFAULT_CHUNK_SIZE = 2600;
const DEFAULT_CHUNK_OVERLAP = 450;
const MIN_CHUNK_SIZE = 800;
const MAX_CHUNK_SIZE = 12000;

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 30;

const DEFAULT_HYBRID_TOP_K = 12;
const MAX_HYBRID_TOP_K = 40;
const HYBRID_MIN_SCORE = 20;
const HYBRID_BM25_K1 = 1.35;
const HYBRID_BM25_B = 0.72;
const HYBRID_BM25_WEIGHT = 24;
const HYBRID_PROXIMITY_WINDOW = 18;
const HYBRID_PROXIMITY_WEIGHT = 28;

const DEFAULT_REGISTER_LIST_TOP_K = 80;
const MAX_REGISTER_LIST_TOP_K = 200;

const DEFAULT_REGISTER_SUMMARY_CHUNKS = 10;
const MAX_REGISTER_SUMMARY_CHUNKS = 24;
const MAX_REGISTER_SUMMARY_BITFIELDS = 60;

const DEFAULT_BITFIELD_LIST_TOP_K = 80;
const MAX_BITFIELD_LIST_TOP_K = 240;
const MAX_BITFIELD_TABLE_ROWS = 120;

const DEFAULT_TABLE_PAGE_RANGE = 4;
const MAX_TABLE_PAGE_RANGE = 8;
const MAX_EXTRACTED_TABLES = 12;
const MAX_TABLE_ROWS_PER_TABLE = 80;
const MAX_TABLE_COLUMNS = 16;

const DEFAULT_SEQUENCE_TOP_K = 10;
const MAX_SEQUENCE_TOP_K = 30;
const MAX_SEQUENCE_EVIDENCE_LINES = 10;
const DEFAULT_SEQUENCE_INDEX_TOPICS = 40;
const DEFAULT_SEQUENCE_LIST_TOP_K = 80;
const MAX_SEQUENCE_LIST_TOP_K = 200;
const MAX_SEQUENCE_INDEX_RESULTS_PER_TOPIC = 8;

const DEFAULT_CAUTION_TOP_K = 10;
const MAX_CAUTION_TOP_K = 30;
const MAX_CAUTION_EVIDENCE_LINES = 12;

const DEFAULT_DRIVER_PACK_REGISTERS = 24;
const MAX_DRIVER_PACK_REGISTERS = 80;
const DEFAULT_DRIVER_PACK_SUMMARIES = 8;
const MAX_DRIVER_PACK_SUMMARIES = 24;
const DEFAULT_DRIVER_PACK_SEQUENCE_TOPICS = 10;
const DEFAULT_DRIVER_PACK_CAUTION_TOPICS = 10;
const DEFAULT_DRIVER_PACK_MODE = "adaptive";
const DRIVER_PACK_FAST_SEQUENCE_LIMIT = 12;
const DRIVER_PACK_FAST_CAUTION_LIMIT = 12;
const DEFAULT_DRIVER_PACK_BUDGET_MS = 25000;
const MIN_DRIVER_PACK_BUDGET_MS = 5000;
const MAX_DRIVER_PACK_BUDGET_MS = 120000;
const DRIVER_PACK_BUDGET_SAFETY_MS = 1500;
const DRIVER_PACK_FULL_MIN_BUDGET_MS = 60000;
const DEFAULT_DRIVER_TASK_REGISTERS = 12;
const MAX_DRIVER_TASK_REGISTERS = 40;

const INDEX_LOCK_SCHEMA_VERSION = 1;
const INDEX_LOCK_STALE_MS = 30 * 60 * 1000;
const ATOMIC_WRITE_RETRY_MS = 50;
const MAX_EVAL_CASES = 200;

const LARGE_PDF_BACKGROUND_PAGE_THRESHOLD = 350;
const MAX_ACTIVE_JOBS = 2;
const JOB_HISTORY_LIMIT = 40;
const JOB_LOG_LIMIT = 80;
const JOBS_STATE_SCHEMA_VERSION = 1;
const JOBS_STATE_WRITE_DELAY_MS = 250;
// Give the MCP transport a chance to flush the tool response before heavy
// background work starts. setTimeout(..., 0) can still let PDF extraction begin
// before some clients receive the response, causing opaque "tool call canceled"
// failures on large manuals.
const BACKGROUND_JOB_START_DELAY_MS = 5000;
const WORKER_JOB_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_INDEX_JOB_MODE = "auto";

// index_status must be a cheap health probe. Do not JSON.parse large index/page
// artifacts just to report whether they exist; read only a small header window
// and fall back to full parse only for tiny files.
const STATUS_FAST_READ_BYTES = 256 * 1024;
const STATUS_FULL_PARSE_MAX_BYTES = 512 * 1024;

const DEFAULT_CAUTION_LIST_TOP_K = 80;
const MAX_CAUTION_LIST_TOP_K = 200;
const DEFAULT_FIGURE_TOP_K = 40;
const MAX_FIGURE_TOP_K = 200;

const MIN_RENDER_DPI = 72;
const DEFAULT_RENDER_DPI = 160;
const MAX_RENDER_DPI = 300;
const RENDER_COMMAND_TIMEOUT_MS = 120000;
const MAX_RENDER_PAGE_RANGE = 1;
const DEFAULT_CAUTION_INDEX_TOPICS = 36;
const MAX_CAUTION_INDEX_RESULTS_PER_TOPIC = 10;

const DEFAULT_PAGE_RANGE = 5;
const MAX_PAGE_RANGE = 20;

const MAX_TOOL_OUTPUT_CHARS = 30000;
const MAX_PREVIEW_CHARS = 1200;
const PAGE_CACHE_SCHEMA_VERSION = 1;
const SECTION_INDEX_SCHEMA_VERSION = 1;
const REGISTER_INDEX_SCHEMA_VERSION = 1;
const BITFIELD_INDEX_SCHEMA_VERSION = 1;
const SEQUENCE_INDEX_SCHEMA_VERSION = 1;
const CAUTION_INDEX_SCHEMA_VERSION = 1;
const FIGURE_INDEX_SCHEMA_VERSION = 1;
const MODULE_PROFILE_SCHEMA_VERSION = 1;
const MAX_TEXT_ITEM_GAP_SPACES = 12;

const INDEX_SCHEMA_VERSION = 3;

// -----------------------------------------------------------------------------
// MCP server
// -----------------------------------------------------------------------------

const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);


// -----------------------------------------------------------------------------
// Background jobs / timeout hardening
// -----------------------------------------------------------------------------

const jobs = new Map();
let jobSequence = 0;
let jobsStateWriteTimer = null;
let jobsStateWriteInProgress = false;
let jobsStateWritePending = false;

function nowIso() {
  return new Date().toISOString();
}

function createJobId(type) {
  jobSequence += 1;
  return `${type}-${Date.now()}-${jobSequence}`;
}

function parseJobSequenceFromId(id) {
  const match = String(id || "").match(/-(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function normalizeJobForPersistence(job) {
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
    finishedAt: job.finishedAt || null,
    finishedMs: Number(job.finishedMs || 0),
    result: job.result || null,
    error: job.error || null,
    log: Array.isArray(job.log) ? job.log.slice(-JOB_LOG_LIMIT) : [],
  };
}

function jobsStatePayload() {
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

async function flushJobsState() {
  if (jobsStateWriteInProgress) {
    jobsStateWritePending = true;
    return;
  }

  jobsStateWriteInProgress = true;
  jobsStateWritePending = false;

  try {
    await atomicWriteJson(safeJobsStatePath(), jobsStatePayload());
  } catch (error) {
    console.error(`[${SERVER_NAME}] Failed to persist background jobs: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    jobsStateWriteInProgress = false;
    if (jobsStateWritePending) {
      jobsStateWritePending = false;
      void flushJobsState();
    }
  }
}

function persistJobsStateSoon() {
  jobsStateWritePending = true;
  if (jobsStateWriteTimer) return;

  jobsStateWriteTimer = setTimeout(() => {
    jobsStateWriteTimer = null;
    void flushJobsState();
  }, JOBS_STATE_WRITE_DELAY_MS);
}

function trimJobHistory({ persist = false } = {}) {
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
    changed = true;
  }

  if (changed && persist) persistJobsStateSoon();
}

function activeJobCount() {
  return [...jobs.values()].filter((job) => job.status === "running" || job.status === "queued").length;
}

function updateJob(job, patch = {}) {
  Object.assign(job, patch, { updatedAt: nowIso(), updatedMs: Date.now() });
  if (patch.message) {
    job.log = job.log || [];
    job.log.push({ at: job.updatedAt, message: patch.message, phase: patch.phase || job.phase || "" });
    if (job.log.length > JOB_LOG_LIMIT) job.log = job.log.slice(-JOB_LOG_LIMIT);
  }
  jobs.set(job.id, job);
  trimJobHistory();
  persistJobsStateSoon();
  return job;
}

async function loadJobsStateFromDisk() {
  await fs.mkdir(INDEX_DIR, { recursive: true });
  const statePath = safeJobsStatePath();
  if (!(await pathExists(statePath))) return;

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(statePath, "utf-8"));
  } catch (error) {
    console.error(`[${SERVER_NAME}] Ignoring unreadable background jobs state: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const loadedJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  const now = nowIso();
  const nowMs = Date.now();
  let changed = false;
  let maxSequence = Number(parsed.jobSequence || 0);

  jobs.clear();
  for (const loadedJob of loadedJobs) {
    const job = normalizeJobForPersistence(loadedJob);
    if (!job || !job.id) continue;

    maxSequence = Math.max(maxSequence, parseJobSequenceFromId(job.id));

    if (job.status === "running" || job.status === "queued") {
      job.status = "failed";
      job.phase = "interrupted";
      job.message = "Server restarted before this background job completed";
      job.error = "Interrupted by MCP server restart; start a new job if this index is still incomplete.";
      job.finishedAt = job.finishedAt || now;
      job.finishedMs = job.finishedMs || nowMs;
      job.updatedAt = now;
      job.updatedMs = nowMs;
      job.log = Array.isArray(job.log) ? job.log.slice(-JOB_LOG_LIMIT) : [];
      job.log.push({ at: now, phase: "interrupted", message: job.message });
      if (job.log.length > JOB_LOG_LIMIT) job.log = job.log.slice(-JOB_LOG_LIMIT);
      changed = true;
    }

    jobs.set(job.id, job);
  }

  jobSequence = Math.max(jobSequence, maxSequence);
  trimJobHistory();
  if (changed) await flushJobsState();
}


async function refreshJobsStateFromDisk() {
  const statePath = safeJobsStatePath();
  if (!(await pathExists(statePath))) return;
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(statePath, "utf-8"));
  } catch {
    return;
  }
  const loadedJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  let maxSequence = jobSequence;
  for (const loadedJob of loadedJobs) {
    const job = normalizeJobForPersistence(loadedJob);
    if (!job || !job.id) continue;
    maxSequence = Math.max(maxSequence, parseJobSequenceFromId(job.id));
    const current = jobs.get(job.id);
    if (!current || Number(job.updatedMs || 0) >= Number(current.updatedMs || 0)) {
      jobs.set(job.id, job);
    }
  }
  jobSequence = Math.max(jobSequence, maxSequence);
}

function jobSnapshot(job) {
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
    log: (job.log || []).slice(-20),
  };
}

function formatJobStatus(job) {
  if (!job) return "Job not found.";
  return [
    `Job: ${job.id}`,
    `Type: ${job.type}`,
    `Status: ${job.status}`,
    `File: ${job.filename}`,
    `Phase: ${job.phase || "unknown"}`,
    `Message: ${job.message || ""}`,
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

function formatJobsList() {
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
      job.progress ? `  progress: ${job.progress.current || 0}/${job.progress.total || "?"} ${job.progress.unit || ""} (${job.progress.percent ?? "?"}%)` : null,
      `  updated: ${job.updatedAt || job.createdAt}`,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

function startBackgroundJob(type, filename, runner, metadata = {}) {
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

function updateIndexJobProgress(job, phase, current = 0, total = 0, unit = "") {
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

async function startIndexPdfJob(filename, options = {}) {
  const chunkSize = clampChunkSize(options.chunkSize);
  const chunkOverlap = clampChunkOverlap(options.chunkOverlap, chunkSize);
  const forceLock = Boolean(options.forceLock);

  const job = startBackgroundJob("index-pdf", filename, async (jobRef) => {
    const indexData = await buildPdfIndex(filename, {
      chunkSize,
      chunkOverlap,
      forceLock,
      reusePageCache: options.reusePageCache !== false,
      onProgress: (event = {}) => updateIndexJobProgress(
        jobRef,
        event.phase || "indexing",
        event.current || 0,
        event.total || 0,
        event.unit || ""
      ),
    });
    return {
      filename,
      pages: indexData.pageCount,
      chunks: indexData.chunkCount,
      sections: indexData.sectionCount,
      registers: indexData.registerCount,
      bitfields: indexData.bitfieldCount,
      sequences: indexData.sequenceCount,
      cautions: indexData.cautionCount,
      figures: indexData.figureCount,
      indexPath: safeIndexPath(filename),
      pagesCachePath: safePagesCachePath(filename),
    };
  }, { chunkSize, chunkOverlap, forceLock });

  return job;
}

async function startExternalRebuildArtifactJob(filename, artifact, options = {}) {
  trimJobHistory({ persist: true });
  if (activeJobCount() >= MAX_ACTIVE_JOBS) {
    throw new Error(`Too many active jobs (${MAX_ACTIVE_JOBS}). Wait for a running job to finish before starting another.`);
  }

  const normalized = normalizeArtifactName(artifact);
  const job = {
    id: createJobId("rebuild-artifact"),
    type: "rebuild-artifact",
    filename,
    status: "queued",
    phase: "queued",
    message: "Queued in detached external worker process",
    createdAt: nowIso(),
    createdMs: Date.now(),
    updatedAt: nowIso(),
    updatedMs: Date.now(),
    metadata: { artifact: normalized, forceLock: Boolean(options.forceLock), worker: true, detached: true },
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
      chunkSize: clampChunkSize(options.chunkSize),
      chunkOverlap: clampChunkOverlap(options.chunkOverlap, clampChunkSize(options.chunkSize)),
      allowFullRebuild: options.allowFullRebuild !== false,
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
      [__filename, "--worker-rebuild-artifact", encoded],
      {
        cwd: __dirname,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }
    );
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

function normalizeArtifactName(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  const aliases = new Map([
    ["page", "pages"], ["pages-cache", "pages"], ["pages", "pages"],
    ["chunk", "chunk-index"], ["chunks", "chunk-index"], ["index", "chunk-index"], ["chunk-index", "chunk-index"],
    ["section", "sections"], ["sections", "sections"], ["sections-index", "sections"],
    ["register", "registers"], ["registers", "registers"], ["registers-index", "registers"],
    ["bitfield", "bitfields"], ["bitfields", "bitfields"], ["bitfields-index", "bitfields"],
    ["sequence", "sequences"], ["sequences", "sequences"], ["sequences-index", "sequences"],
    ["caution", "cautions"], ["cautions", "cautions"], ["cautions-index", "cautions"],
    ["figure", "figures"], ["figures", "figures"], ["figures-index", "figures"],
    ["all", "all"], ["core", "core"], ["driver", "driver"],
  ]);
  return aliases.get(raw) || raw;
}

function artifactPathsForStatus(filename) {
  return [
    { key: "pages", label: "Pages cache", path: safePagesCachePath(filename), schemaVersion: PAGE_CACHE_SCHEMA_VERSION, rootKey: "pages", countKey: "pageCount" },
    { key: "pages-partial", label: "Partial pages checkpoint", path: safePagesPartialCachePath(filename), schemaVersion: PAGE_CACHE_SCHEMA_VERSION, rootKey: "pages", countKey: "pageCount", optional: true },
    { key: "chunk-index", label: "Chunk index", path: safeIndexPath(filename), schemaVersion: INDEX_SCHEMA_VERSION, rootKey: "chunks", countKey: "chunkCount" },
    { key: "sections", label: "Sections index", path: safeSectionsIndexPath(filename), schemaVersion: SECTION_INDEX_SCHEMA_VERSION, rootKey: "sections", countKey: "sectionCount" },
    { key: "registers", label: "Registers index", path: safeRegistersIndexPath(filename), schemaVersion: REGISTER_INDEX_SCHEMA_VERSION, rootKey: "registers", countKey: "registerCount" },
    { key: "bitfields", label: "Bitfields index", path: safeBitfieldsIndexPath(filename), schemaVersion: BITFIELD_INDEX_SCHEMA_VERSION, rootKey: "bitfields", countKey: "bitfieldCount" },
    { key: "sequences", label: "Sequences index", path: safeSequencesIndexPath(filename), schemaVersion: SEQUENCE_INDEX_SCHEMA_VERSION, rootKey: "sequences", countKey: "sequenceCount" },
    { key: "cautions", label: "Cautions index", path: safeCautionsIndexPath(filename), schemaVersion: CAUTION_INDEX_SCHEMA_VERSION, rootKey: "cautions", countKey: "cautionCount" },
    { key: "figures", label: "Figures index", path: safeFiguresIndexPath(filename), schemaVersion: FIGURE_INDEX_SCHEMA_VERSION, rootKey: "figures", countKey: "figureCount" },
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

function jsonHeadString(head, key) {
  const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = head.match(re);
  if (!match) return null;
  try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
}

function jsonHeadNumber(head, key) {
  const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`);
  const match = head.match(re);
  return match ? Number(match[1]) : null;
}

async function readFileHead(filePath, maxBytes = STATUS_FAST_READ_BYTES) {
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

async function readArtifactStatus(entry, filename) {
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

async function buildArtifactManifest(filename, options = {}) {
  let source = {};
  try {
    source = await getPdfSourceInfo(filename);
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
  });
}

async function writeArtifactManifest(filename, options = {}) {
  const manifest = await buildArtifactManifest(filename, options);
  await atomicWriteJson(safeArtifactManifestPath(filename), manifest);
  return manifest;
}

async function loadArtifactManifest(filename) {
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

function deriveStatusPageCount(artifacts) {
  const preferred = artifacts.find((a) => a.key === "pages" && a.exists && a.ok && Number.isFinite(Number(a.count)));
  if (preferred) return { pageCount: Number(preferred.count), source: "pages artifact" };
  const partial = artifacts.find((a) => a.key === "pages-partial" && a.exists && Number.isFinite(Number(a.count)));
  if (partial) return { pageCount: Number(partial.count), source: "partial pages artifact" };
  return { pageCount: 0, source: "not probed" };
}

async function getIndexStatus(filename, options = {}) {
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

function getIndexStatusUltraLite(filename) {
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
    documentsDir: DOCUMENTS_DIR,
    indexDir: INDEX_DIR,
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
      `For detailed artifact checks, call index_status(filename="${filename}", details=true).`,
      `To avoid blocking the MCP server, run rebuild_artifact(..., background=true) and poll job_status(job_id="...").`,
    ],
  };
}

function formatIndexStatusUltraLite(status) {
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

function formatIndexStatus(status) {
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

function cancelBackgroundJob(jobId, reason = "Cancelled by user") {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (["done", "failed", "cancelled"].includes(job.status)) return job;
  return updateJob(job, { status: "cancelled", phase: "cancelled", message: reason, finishedAt: nowIso(), finishedMs: Date.now(), error: reason });
}

function cleanupBackgroundJobs(options = {}) {
  const includeRunning = Boolean(options.includeRunning);
  const olderThanHours = Number(options.olderThanHours ?? 0);
  const statuses = new Set(Array.isArray(options.statuses) && options.statuses.length ? options.statuses : ["done", "failed", "cancelled"]);
  const cutoffMs = olderThanHours > 0 ? Date.now() - olderThanHours * 60 * 60 * 1000 : 0;
  const removed = [];
  for (const job of [...jobs.values()]) {
    if (!includeRunning && (job.status === "running" || job.status === "queued")) continue;
    if (!statuses.has(job.status)) continue;
    if (cutoffMs && Number(job.updatedMs || job.createdMs || 0) > cutoffMs) continue;
    jobs.delete(job.id); removed.push(job.id);
  }
  if (removed.length) persistJobsStateSoon();
  return removed;
}

async function rewriteMainIndexCounts(filename, patch = {}) {
  const indexPath = safeIndexPath(filename);
  if (!(await pathExists(indexPath))) return null;
  const indexData = await loadPdfIndex(filename);
  Object.assign(indexData, patch, { updatedAt: new Date().toISOString() });
  await atomicWriteJson(indexPath, indexData);
  return indexData;
}

async function rebuildArtifact(filename, artifact, options = {}) {
  const normalized = normalizeArtifactName(artifact);
  const forceLock = Boolean(options.forceLock);
  const chunkSize = clampChunkSize(options.chunkSize);
  const chunkOverlap = clampChunkOverlap(options.chunkOverlap, chunkSize);
  const allowFullRebuild = options.allowFullRebuild !== false;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  if (["all", "core", "chunk-index"].includes(normalized)) {
    if (onProgress) onProgress({ phase: normalized === "chunk-index" ? "rebuild-chunk-index" : "rebuild-core", current: 0, total: 0, unit: "" });
    const indexData = await buildPdfIndex(filename, { forceLock, chunkSize, chunkOverlap, reusePageCache: true, onProgress });
    await writeArtifactManifest(filename, { buildStatus: "ready", notes: [`rebuilt ${normalized}`] });
    return { artifact: normalized, rebuilt: ["pages", "sections", "chunk-index", "registers", "bitfields", "sequences", "cautions", "figures"], counts: { pages: indexData.pageCount, chunks: indexData.chunkCount, registers: indexData.registerCount, bitfields: indexData.bitfieldCount, sequences: indexData.sequenceCount, cautions: indexData.cautionCount, figures: indexData.figureCount } };
  }
  if (normalized === "pages") {
    if (onProgress) onProgress({ phase: "rebuild-pages", current: 0, total: 0, unit: "" });
    const pageCache = await buildPagesCache(filename, { onProgress });
    await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt pages cache"] });
    return { artifact: normalized, rebuilt: ["pages"], counts: { pages: pageCache.pages.length } };
  }
  const pageCache = await getPagesCache(filename, { buildIfMissing: allowFullRebuild });
  if (normalized === "sections") { const sections = await buildSectionsIndex(filename, pageCache); await rewriteMainIndexCounts(filename, { sectionCount: sections.sectionCount }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt sections index"] }); return { artifact: normalized, rebuilt: ["sections"], counts: { sections: sections.sectionCount } }; }
  let indexData = null;
  try { indexData = await loadPdfIndex(filename); } catch (error) { if (!allowFullRebuild) throw error; indexData = await buildPdfIndex(filename, { forceLock, chunkSize, chunkOverlap, reusePageCache: true, onProgress }); }
  const sectionsIndex = await getSectionsIndex(filename);
  if (normalized === "registers") { const registers = await buildRegistersIndex(filename, indexData, sectionsIndex); await rewriteMainIndexCounts(filename, { registerCount: registers.registerCount }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt registers index"] }); return { artifact: normalized, rebuilt: ["registers"], counts: { registers: registers.registerCount } }; }
  const registersIndex = await loadRegistersIndex(filename) || await buildRegistersIndex(filename, indexData, sectionsIndex);
  if (normalized === "bitfields") { const bitfields = await buildBitfieldsIndex(filename, indexData, registersIndex); await rewriteMainIndexCounts(filename, { bitfieldCount: bitfields.bitfieldCount }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt bitfields index"] }); return { artifact: normalized, rebuilt: ["bitfields"], counts: { bitfields: bitfields.bitfieldCount } }; }
  if (normalized === "sequences") { const sequences = await buildSequencesIndex(filename, indexData, sectionsIndex, registersIndex); await rewriteMainIndexCounts(filename, { sequenceCount: sequences.sequenceCount }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt sequences index"] }); return { artifact: normalized, rebuilt: ["sequences"], counts: { sequences: sequences.sequenceCount } }; }
  if (normalized === "cautions") { const cautions = await buildCautionsIndex(filename, indexData, sectionsIndex, registersIndex); await rewriteMainIndexCounts(filename, { cautionCount: cautions.cautionCount }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt cautions index"] }); return { artifact: normalized, rebuilt: ["cautions"], counts: { cautions: cautions.cautionCount } }; }
  if (normalized === "figures") { const figures = await buildFiguresIndex(filename, pageCache); await rewriteMainIndexCounts(filename, { figureCount: figures.figureCount }); await writeArtifactManifest(filename, { buildStatus: "partial", notes: ["rebuilt figures index"] }); return { artifact: normalized, rebuilt: ["figures"], counts: { figures: figures.figureCount } }; }
  if (normalized === "driver") throw new Error("driver artifact rebuild is intentionally not automatic. Use build_driver_evidence_pack or prepare_driver_task with explicit module/focus inputs.");
  throw new Error(`Unknown artifact: ${artifact}. Supported: pages, chunk-index, sections, registers, bitfields, sequences, cautions, figures, core/all.`);
}

async function startRebuildArtifactJob(filename, artifact, options = {}) {
  // Step 40.2: heavy PDF/artifact rebuilds must not run in the MCP server
  // process. Running pdfjs extraction in the same Node event loop can make even
  // tiny follow-up calls such as index_status() look cancelled to the client.
  return await startExternalRebuildArtifactJob(filename, artifact, options);
}

// -----------------------------------------------------------------------------
// Tool definitions
// -----------------------------------------------------------------------------

const tools = [
  {
    name: "list_pdfs",
    description:
      "List all PDF files available in the local documents folder.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "pdf_info",
    description:
      "Get file metadata, PDF page count, and index status for a local PDF.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "doctor",
    description:
      "Check MCP server health for one PDF or all PDFs without rebuilding indexes. Validates PDF readability, core indexes, persistent manual-intelligence artifacts, stale/broken JSON, count mismatches, and optional generated reports.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Optional PDF filename. If omitted, doctor checks all PDFs in the documents folder.",
        },
        strict: {
          type: "boolean",
          description: "If true, optional artifacts such as module profile/driver pack/task plan are reported more aggressively. Default false.",
        },
        write_report: {
          type: "boolean",
          description: "If true, save a .doctor.txt report in the indexes folder. Default true for single-file checks.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "validate_index",
    description:
      "Validate index artifacts for a PDF without rebuilding. This is a focused alias of doctor for checking whether indexes are missing, stale, incompatible, broken, or internally inconsistent.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf. If omitted, validates all PDFs.",
        },
        strict: {
          type: "boolean",
          description: "If true, include optional artifacts in the final health decision. Default false.",
        },
        write_report: {
          type: "boolean",
          description: "If true, save a .doctor.txt report in the indexes folder. Default false.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "plan_manual_workflow",
    description:
      "Route a driver/manual task to the correct MCP workflow. Use this first when an AI agent is unsure which PDF/manual tools to call for driver implementation, debug, review, pinmux/table extraction, register verification, or eval hardening.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Optional PDF filename. If provided, the plan includes file health and concrete tool calls." },
        task: { type: "string", description: "Driver/manual task, bug description, or review goal." },
        module_type: { type: "string", description: "Optional subsystem/module hint, for example ethernet, dmaengine, watchdog, pwm, gpio, pinctrl, i2c, spi, rtc." },
        driver_family: { type: "string", description: "Optional driver family hint, for example stmmac, ravb, rzg2l-gpt, riic, rspi, custom." },
        source_files: { type: "array", items: { type: "string" }, description: "Source files that the VS Code agent will inspect. MCP does not read them." },
        focus_registers: { type: "array", items: { type: "string" }, description: "Registers already suspected or seen in source." },
        focus_bitfields: { type: "array", items: { type: "string" }, description: "Bitfields already suspected or seen in source." },
        depth: { type: "string", enum: ["quick", "standard", "deep"], description: "Workflow strictness. Default standard." },
        output_format: { type: "string", enum: ["report", "checklist", "patch_plan", "debug_plan"], description: "Target final output style for the agent. Default report." },
        include_eval: { type: "boolean", description: "Include eval/static-hardening steps. Default true." },
        include_visual: { type: "boolean", description: "Include visual/table evidence steps when relevant. Default true." }
      },
      additionalProperties: false,
    },
  },
  {
    name: "explain_tool_usage",
    description:
      "Explain which MCP tool to use, when to use it, required inputs, typical next tool, and evidence trust level. Use this as inline help for AI agents to avoid wrong tool selection.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "Optional specific MCP tool name, for example verify_register_usage. If omitted, returns a compact workflow-oriented catalog." },
        task: { type: "string", description: "Optional task context to bias recommendations." }
      },
      additionalProperties: false,
    },
  },
  {
    name: "eval_health_check",
    description:
      "Run static eval/tool-registry hardening checks without requiring a PDF. Verifies tool registry uniqueness, handler coverage, eval/profile JSON readability, schema versions, and npm-test readiness.",
    inputSchema: {
      type: "object",
      properties: {
        create_default: { type: "boolean", description: "Create default eval/profile files before checking. Default true." },
        include_profiles: { type: "boolean", description: "Check driver_profiles/*.json and eval/profiles/*.json. Default true." },
        include_fixtures: { type: "boolean", description: "Check eval/fixtures/*.json. Default true." },
        write_report: { type: "boolean", description: "Save indexes/eval-health-report.json and .txt. Default true." },
        step40_action: {
          type: "string",
          enum: ["health", "ping", "compat_report", "index_status_lite", "rebuild_artifact", "job_status", "list_jobs", "cancel_job", "cleanup_jobs"],
          description: "Step 40 control-plane action routed through this known-good tool. Use compat_report to see direct-tool compatibility status. Default health preserves the original eval_health_check behavior."
        },
        filename: { type: "string", description: "PDF filename for step40_action=index_status_lite or rebuild_artifact." },
        artifact: { type: "string", description: "Artifact for step40_action=rebuild_artifact, for example pages, registers, bitfields, sequences, cautions, figures, or chunk-index." },
        job_id: { type: "string", description: "Job ID for step40_action=job_status or cancel_job." },
        reason: { type: "string", description: "Optional cancellation reason for step40_action=cancel_job." },
        statuses: { type: "array", items: { type: "string" }, description: "Statuses for step40_action=cleanup_jobs." },
        older_than_hours: { type: "number", description: "Age filter for step40_action=cleanup_jobs." },
        include_running: { type: "boolean", description: "Allow cleanup of queued/running jobs when step40_action=cleanup_jobs. Default false." },
        json: { type: "boolean", description: "Return raw JSON for status-oriented step40 actions. Default false." },
        force_lock: { type: "boolean", description: "Remove stale lock before rebuild_artifact. Default false." },
        chunk_size: { type: "number", description: "Chunk size for rebuild_artifact." },
        chunk_overlap: { type: "number", description: "Chunk overlap for rebuild_artifact." },
        allow_full_rebuild: { type: "boolean", description: "Allow dependent full rebuild when requested artifact needs missing base artifacts. Default true." }
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_eval_cases",
    description:
      "List internal regression/evaluation cases for this MCP server. Creates eval/manual-cases.json with default cases if it does not exist.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "Optional case ID filter.",
        },
        create_default: {
          type: "boolean",
          description: "Create default eval/manual-cases.json and eval/profiles/*.json if missing. Default true.",
        },
        scope: {
          type: "string",
          enum: ["all", "generic", "profiles", "fixtures"],
          description: "Which eval cases to list. all merges generic cases, eval profiles, and fixture metadata. Default all.",
        },
        module_type: {
          type: "string",
          description: "Optional module/profile filter, for example ethernet, dmaengine, watchdog, pwm.",
        },
        eval_profile: {
          type: "string",
          description: "Optional explicit eval profile name under eval/profiles/, for example ethernet or dmaengine.",
        },
        fixture: {
          type: "string",
          description: "Optional explicit fixture file name under eval/fixtures/ without .json.",
        },
        include_disabled: {
          type: "boolean",
          description: "Include disabled fixture case files in the listing. Default true for listing, false for run_eval.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_eval",
    description:
      "Run internal regression/evaluation cases against one manual PDF. This does not rebuild indexes unless auto_index=true. Use after changing scoring/parser/workflow code.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename to evaluate, for example r01uh1069ej0115-rzg3e-DMA.pdf. If omitted, the first available PDF is used when possible.",
        },
        case_id: {
          type: "string",
          description: "Optional single case ID to run.",
        },
        module_type: {
          type: "string",
          description: "Optional module type hint injected into applicable default cases, for example dmaengine, watchdog, pwm.",
        },
        auto_index: {
          type: "boolean",
          description: "If true, run index_pdf automatically when doctor reports missing core indexes. Default false.",
        },
        write_report: {
          type: "boolean",
          description: "If true, save .eval-report.txt and .eval-report.json in indexes/. Default true.",
        },
        create_default: {
          type: "boolean",
          description: "Create default eval/manual-cases.json and eval/profiles/*.json if missing. Default true.",
        },
        eval_profile: {
          type: "string",
          description: "Optional explicit eval profile to include from eval/profiles/, for example ethernet, dmaengine, watchdog, pwm, or generic.",
        },
        include_profiles: {
          type: "boolean",
          description: "Include applicable eval/profiles/*.json cases. Default true.",
        },
        include_fixtures: {
          type: "boolean",
          description: "Include matching enabled eval/fixtures/*.json cases. Default true.",
        },
        fixture: {
          type: "string",
          description: "Optional explicit fixture file under eval/fixtures/ without .json. Explicit fixtures run even if disabled=false.",
        },
        include_golden: {
          type: "boolean",
          description: "If true, include V2 register/bitfield golden accuracy checks. Default false.",
        },
        golden_profile: {
          type: "string",
          description: `Golden profile under eval/golden without .json. Default ${DEFAULT_GOLDEN_PROFILE}.`,
        },
        strict_verified_only: {
          type: "boolean",
          description: "If true, only status=verified golden facts can fail the report. Default true.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "start_index_pdf",
    description:
      "Start PDF indexing as a background job. Use this for large manuals (500/800/1000+ pages) to avoid MCP client request timeout. Poll job_status until status is done or failed.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf" },
        force: { type: "boolean", description: "Force rebuilding the index even if a valid index exists. Default false." },
        force_lock: { type: "boolean", description: "Remove stale/existing index lock before rebuilding. Use only when safe. Default false." },
        chunk_size: { type: "number", description: `Chunk size in characters. Default ${DEFAULT_CHUNK_SIZE}.` },
        chunk_overlap: { type: "number", description: `Chunk overlap in characters. Default ${DEFAULT_CHUNK_OVERLAP}.` }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "job_status",
    description:
      "Get status/progress for a background job started by start_index_pdf or auto-background index_pdf.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job ID returned by start_index_pdf/index_pdf." }
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_jobs",
    description:
      "List recent background jobs and their status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "index_pdf",
    description:
      "Build or rebuild searchable text, page cache, section/register/bitfield/sequence/caution indexes for a local PDF. Uses an index build lock and atomic writes to avoid corrupted JSON artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        force: {
          type: "boolean",
          description:
            "Force rebuilding the index even if a valid index already exists.",
        },
        force_lock: {
          type: "boolean",
          description:
            "If true, remove an existing index build lock before rebuilding. Use only if you are sure no other index_pdf is running for this PDF.",
        },
        mode: {
          type: "string",
          enum: ["auto", "foreground", "background"],
          description:
            "Indexing execution mode. auto starts a background job for large PDFs or rebuilds; foreground blocks the MCP request and may timeout on large manuals; background always returns a job ID immediately. Default auto.",
        },
        chunk_size: {
          type: "number",
          description: `Chunk size in characters. Default ${DEFAULT_CHUNK_SIZE}.`,
        },
        chunk_overlap: {
          type: "number",
          description: `Chunk overlap in characters. Default ${DEFAULT_CHUNK_OVERLAP}.`,
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "search_pdf",
    description:
      "Search keywords, phrases, register names, bit names, or natural-language questions inside an indexed PDF. Returns page numbers and chunk IDs.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        query: {
          type: "string",
          description:
            "Keyword, exact phrase, register name, bit field, section title, or natural-language query.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of results. Default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}.`,
        },
      },
      required: ["filename", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "hybrid_search_pdf",
    description:
      "Search an indexed PDF without embeddings by combining exact phrase, keyword/BM25-like scoring, fuzzy token matching, intent expansion, and boosts from register/section/sequence/caution indexes. Use this for natural-language questions when Ollama/embedding search is unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        query: {
          type: "string",
          description:
            "Natural-language question, operation intent, register/bitfield/topic, or phrase to search.",
        },
        register: {
          type: "string",
          description:
            "Optional register context to boost related chunks, for example DMACm_CHCTRL_n or WDTCR.",
        },
        intent: {
          type: "string",
          enum: [
            "auto",
            "register",
            "bitfield",
            "sequence",
            "caution",
            "section",
            "table",
            "irq",
            "clear",
            "reset",
            "start",
            "stop",
            "init",
            "error"
          ],
          description:
            "Optional search intent. Use auto by default; set a concrete intent to bias ranking.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of results. Default ${DEFAULT_HYBRID_TOP_K}, max ${MAX_HYBRID_TOP_K}.`,
        },
      },
      required: ["filename", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "chunk_type_stats",
    description:
      "Show chunkType/noise/content statistics for an indexed PDF. Use this after index_pdf to verify Step 23 classification and diagnose noisy TOC/index/revision chunks affecting search quality.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        include_examples: {
          type: "boolean",
          description: "Include representative chunk examples for each chunk type. Default true.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "read_pdf_pages",
    description:
      "Read extractable text from a specific page range in a local PDF. Use after search_pdf/find_register/find_section to inspect relevant pages.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        start_page: {
          type: "number",
          description: "Start page number, 1-based.",
        },
        end_page: {
          type: "number",
          description: `End page number, 1-based. Maximum range is ${MAX_PAGE_RANGE} pages.`,
        },
      },
      required: ["filename", "start_page", "end_page"],
      additionalProperties: false,
    },
  },
  {
    name: "read_pdf_chunk",
    description:
      "Read the full text of a specific indexed chunk by chunk ID, for example GBETH.pdf:p17:c0.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        chunk_id: {
          type: "string",
          description:
            "Chunk ID returned by search_pdf, find_register, or find_section.",
        },
      },
      required: ["filename", "chunk_id"],
      additionalProperties: false,
    },
  },
  {
    name: "find_register",
    description:
      "Find a hardware register using the register index first, then fall back to chunk search. Supports prefixed/unprefixed variants such as MACCR, GBETHm_MACCR, WDTCR, WDTRR, GTCR, or GTCCR.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        register: {
          type: "string",
          description:
            "Register abbreviation or full register name, for example MACCR, GBETHm_MACCR, WDTCR, GTCCR.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of results. Default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}.`,
        },
      },
      required: ["filename", "register"],
      additionalProperties: false,
    },
  },
  {
    name: "list_registers",
    description:
      "List detected hardware registers from the register index so an AI agent can explore the module register map before inspecting specific registers.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        filter: {
          type: "string",
          description:
            "Optional substring filter for register names, aliases, headings, or section titles. Examples: WDT, MAC, DMA, GPT, GTCC.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of registers to list. Default ${DEFAULT_REGISTER_LIST_TOP_K}, max ${MAX_REGISTER_LIST_TOP_K}.`,
        },
        include_low_confidence: {
          type: "boolean",
          description:
            "Include low-confidence symbol-only candidates. Default false. Keep false when exploring the real register map.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "find_bitfield",
    description:
      "Find chunks related to a hardware register bit field such as EN, ER, SUS, TC, CKS, TOPS, RPES, TSTART, or TCSTF. If register is provided, related register context is prioritized.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        bitfield: {
          type: "string",
          description:
            "Bit field name or symbol to find, for example EN, ER, TC, CKS, TOPS, RPES, TSTART, or TCSTF.",
        },
        register: {
          type: "string",
          description:
            "Optional register name to constrain/prioritize context, for example DMACm_CHCTRL_n, WDTCR, GTCR, or GTCCR.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of results. Default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}.`,
        },
      },
      required: ["filename", "bitfield"],
      additionalProperties: false,
    },
  },
  {
    name: "list_bitfields",
    description:
      "List detected bit-field candidates for a register or for the whole indexed hardware manual. Uses the persistent .bitfields.json index built by index_pdf.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        register: {
          type: "string",
          description:
            "Optional register name to filter bit fields, for example DMACm_CHCTRL_n, WDTCR, GTCR, or GTCCR.",
        },
        filter: {
          type: "string",
          description:
            "Optional substring filter for bit-field name, description, evidence, or register.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of bit fields to list. Default ${DEFAULT_BITFIELD_LIST_TOP_K}, max ${MAX_BITFIELD_LIST_TOP_K}.`,
        },
        include_low_confidence: {
          type: "boolean",
          description:
            "Include low-confidence symbol-only candidates. Default false.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_tables_from_pages",
    description:
      "Extract table-like structures from a PDF page range using PDF text item coordinates. Step 30A also annotates semantic column roles when possible. Useful for inspecting register maps and bit-field tables when plain text extraction loses columns.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        start_page: {
          type: "number",
          description: "Start page number, 1-based.",
        },
        end_page: {
          type: "number",
          description: `End page number, 1-based. Maximum range is ${MAX_TABLE_PAGE_RANGE} pages.`,
        },
        min_columns: {
          type: "number",
          description: "Minimum number of detected columns for a row/table candidate. Default 3.",
        },
      },
      required: ["filename", "start_page", "end_page"],
      additionalProperties: false,
    },
  },
  {
    name: "check_pdf_renderers",
    description:
      "Check which optional external PDF page renderers are available for Step 31B visual review. Supported renderers: pdftoppm/Poppler, mutool/MuPDF, magick/ImageMagick. If none are available, render_pdf_page can still create a dependency-free text-layer SVG fallback.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "render_pdf_page",
    description:
      "Step 31B: render one selected PDF page to a local PNG/JPG/SVG file for visual review. Uses optional external renderers when available; can fall back to a text-layer SVG that preserves PDF text coordinates but does not show vector/raster graphics.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf." },
        page: { type: "number", description: "1-based page number to render." },
        dpi: { type: "number", description: `Render DPI. Default ${DEFAULT_RENDER_DPI}, max ${MAX_RENDER_DPI}.` },
        format: { type: "string", enum: ["png", "jpg", "svg", "text_svg"], description: "Output format. png/jpg require an external renderer. svg uses mutool when available; text_svg is a dependency-free text-layer fallback." },
        renderer: { type: "string", enum: ["auto", "pdftoppm", "mutool", "magick", "text_svg"], description: "Renderer selection. Default auto." },
        fallback_text_svg: { type: "boolean", description: "If true, create a text-layer SVG fallback when external image rendering is unavailable. Default true." }
      },
      required: ["filename", "page"],
      additionalProperties: false,
    },
  },
  {
    name: "visual_review_handoff_pack",
    description:
      "Step 32: build a workflow/prompt pack for visual manual content such as timing diagrams, clock trees, block diagrams, reset flows, interrupt routing, and pinmux figures. It combines figure search/context, page/render/crop commands, layout-table checks, and an extraction schema so the VS Code/AI agent can perform a disciplined visual review instead of guessing from text-only extraction.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf or r01uh1039ej0120-rzt2h_n2h-GPIO.pdf." },
        query: { type: "string", description: "Visual target query, for example clock tree, read timing diagram, Safety I/O port setting flow, interrupt route, reset sequence." },
        figure_id: { type: "string", description: "Optional Figure ID from list_figures/find_figure, for example fig-p113-17.3." },
        page: { type: "number", description: "Optional 1-based page number if the visual target page is already known." },
        kind: { type: "string", description: "Optional figure kind filter, for example timing-diagram, clock-tree, block-diagram, flow-sequence, pinmux, interrupt, reset-power." },
        diagram_type: { type: "string", enum: ["auto", "clock_tree", "timing", "block_diagram", "reset_flow", "interrupt_route", "pinmux", "sequence", "table", "other"], description: "Expected visual content type. Default auto." },
        task: { type: "string", description: "Optional review task, for example verify reset sequence, inspect timing diagram, understand clock tree, or review pinmux flow." },
        source_files: { type: "array", items: { type: "string" }, description: "Optional source/DTS files the VS Code agent should inspect alongside the visual manual evidence." },
        review_depth: { type: "string", enum: ["quick", "standard", "deep"], description: "How strict the visual review workflow should be. Default standard." },
        output_format: { type: "string", enum: ["report", "debug_plan", "patch_plan", "checklist"], description: "Expected final response style from the agent. Default report." },
        top_k: { type: "number", description: "Number of figure candidates to include when searching by query. Default 6." },
        include_layout_tables: { type: "boolean", description: "Include layout-table extraction commands and context when useful. Default true." },
        include_render_commands: { type: "boolean", description: "Include render_pdf_page/render_figure_region commands. Default true." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "add_visual_evidence",
    description:
      "Step 33: persist structured observations made from rendered manual figures/diagrams/tables. Use this after visual_review_handoff_pack + render_figure_region/render_pdf_region when the AI agent or user has inspected a PNG/JPG/SVG and wants to store direct visual observations, extracted steps/edges/clocks/pins, uncertainty, and source-code implications as reusable evidence.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        figure_id: { type: "string", description: "Optional Figure/Table ID from find_figure/list_figures." },
        page: { type: "number", description: "Optional 1-based page number for the visual evidence." },
        query: { type: "string", description: "Optional visual target query/task." },
        diagram_type: { type: "string", enum: ["auto", "clock_tree", "timing", "block_diagram", "reset_flow", "interrupt_route", "pinmux", "sequence", "table", "other"], description: "Visual evidence type. Default auto." },
        rendered_path: { type: "string", description: "Path returned by render_pdf_page/render_figure_region/render_pdf_region." },
        rendered_region: { type: "object", description: "Optional crop/region metadata such as x/y/width/height/unit/zoom/dpi.", additionalProperties: true },
        direct_visual_observations: { type: "array", items: { type: "string" }, description: "Direct facts visible in the rendered image. Do not put speculative driver conclusions here." },
        caption_context_facts: { type: "array", items: { type: "string" }, description: "Facts from caption/context text around the figure." },
        extracted_items: { type: "object", description: "Structured extraction payload, e.g. steps/clocks/signals/edges/pins/selectors/routing/timing_constraints.", additionalProperties: true },
        engineering_inferences: { type: "array", items: { type: "string" }, description: "Engineering interpretation derived from the visual evidence. Must remain separate from direct observations." },
        source_implications: { type: "array", items: { type: "string" }, description: "Implications for Linux driver/DTS/source review." },
        uncertainties: { type: "array", items: { type: "string" }, description: "Ambiguous or unreadable visual details that need a better crop or text cross-check." },
        related_registers: { type: "array", items: { type: "string" }, description: "Registers related to this visual evidence." },
        related_bitfields: { type: "array", items: { type: "string" }, description: "Bitfields related to this visual evidence." },
        source_files: { type: "array", items: { type: "string" }, description: "Source/DTS files this evidence may affect." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags such as clock, reset, irq, pinmux, timing." },
        verification_status: { type: "string", enum: ["observed", "needs_verification", "verified", "rejected"], description: "Default needs_verification." },
        confidence: { type: "string", enum: ["low", "medium", "high"], description: "Confidence in direct visual observations. Default medium." },
        notes: { type: "string", description: "Optional free-form note." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "list_visual_evidence",
    description:
      "List persisted Step 33 visual evidence entries for a manual. Supports filtering by query/tag/diagram_type/page/status.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        filter: { type: "string", description: "Optional keyword filter over observations/inferences/tags/registers." },
        diagram_type: { type: "string", description: "Optional diagram type filter." },
        page: { type: "number", description: "Optional page filter." },
        status: { type: "string", description: "Optional verification status filter." },
        top_k: { type: "number", description: "Maximum entries to show. Default 20." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "get_visual_evidence",
    description:
      "Get one persisted visual evidence entry by evidence_id, including observations, structured extraction, uncertainties, source implications, and recommended verification calls.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        evidence_id: { type: "string", description: "Visual evidence ID returned by add_visual_evidence/list_visual_evidence." }
      },
      required: ["filename", "evidence_id"],
      additionalProperties: false,
    },
  },
  {
    name: "visual_evidence_report",
    description:
      "Generate a structured report from persisted visual evidence entries for a manual. Use this before driver review to reuse visual observations from clock trees, timing diagrams, pinmux flows, reset/IRQ routing figures, and table screenshots.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        filter: { type: "string", description: "Optional keyword filter." },
        diagram_type: { type: "string", description: "Optional diagram type filter." },
        status: { type: "string", description: "Optional verification status filter." },
        include_entries: { type: "boolean", description: "Include detailed entries. Default true." },
        top_k: { type: "number", description: "Maximum entries to include. Default 50." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "visual_evidence_verification_queue",
    description:
      "Step 35: list visual evidence entries that still need verification, with suggested manual-evidence calls. Use this before approving driver conclusions that depend on clock/tree/timing/pinmux/reset-flow observations.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        filter: { type: "string", description: "Optional keyword filter over observations/inferences/tags/registers." },
        diagram_type: { type: "string", description: "Optional diagram type filter." },
        page: { type: "number", description: "Optional page filter." },
        include_observed: { type: "boolean", description: "Also include entries with status observed. Default true." },
        include_rejected: { type: "boolean", description: "Also include rejected entries. Default false." },
        top_k: { type: "number", description: "Maximum entries to show. Default 30." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_visual_evidence",
    description:
      "Step 35: update a persisted visual evidence entry verification status with supporting manual evidence. Use status=verified only after cross-checking with manual text/register/bitfield/sequence/caution evidence. The update is appended to verification_history.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        evidence_id: { type: "string", description: "Visual evidence ID." },
        status: { type: "string", enum: ["observed", "needs_verification", "verified", "rejected"], description: "New verification status." },
        confidence: { type: "string", enum: ["low", "medium", "high"], description: "Updated confidence. Optional." },
        verification_note: { type: "string", description: "Concise explanation for the status update." },
        supporting_evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "manual_text | register | bitfield | sequence | caution | source | render | other" },
              tool: { type: "string", description: "Tool that produced the evidence, e.g. read_pdf_pages/get_sequence/verify_register_usage." },
              page: { type: "number" },
              register: { type: "string" },
              bitfield: { type: "string" },
              quote: { type: "string" },
              note: { type: "string" }
            },
            additionalProperties: true
          },
          description: "Supporting evidence used to verify/reject this visual observation. Required for status=verified unless allow_without_support=true."
        },
        supporting_tool_calls: { type: "array", items: { type: "string" }, description: "Concrete MCP calls used during verification." },
        resolved_uncertainties: { type: "array", items: { type: "string" }, description: "Uncertainties resolved by this update." },
        remaining_uncertainties: { type: "array", items: { type: "string" }, description: "Uncertainties still open after this update." },
        tags_to_add: { type: "array", items: { type: "string" }, description: "Optional tags to add." },
        notes: { type: "string", description: "Optional additional note appended to entry notes." },
        reviewer: { type: "string", description: "Optional reviewer/agent label." },
        allow_without_support: { type: "boolean", description: "Allow status=verified without supporting_evidence. Default false; not recommended." }
      },
      required: ["filename", "evidence_id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "render_pdf_region",
    description:
      "Step 31C: render one PDF page, then crop a selected rectangular region and optionally zoom it. Use this after render_pdf_page/full-page review when a clock tree, timing diagram, block diagram, table, or waveform is too small to inspect on the full page. Coordinates may be percentages of the rendered page or pixels.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf." },
        page: { type: "number", description: "1-based page number." },
        x: { type: "number", description: "Left coordinate of crop region. Default 0." },
        y: { type: "number", description: "Top coordinate of crop region. Default 0." },
        width: { type: "number", description: "Crop width. If unit=percent, use 0-100. Default 100 for percent." },
        height: { type: "number", description: "Crop height. If unit=percent, use 0-100. Default 100 for percent." },
        unit: { type: "string", enum: ["percent", "px"], description: "Coordinate unit. percent uses rendered page size; px uses rendered image pixels. Default percent." },
        margin: { type: "number", description: "Extra margin around crop. In percent when unit=percent; in pixels when unit=px. Default 0." },
        zoom: { type: "number", description: "Optional zoom factor after crop. 1.0 means no resize. Default 1.0, max 4.0." },
        dpi: { type: "number", description: `Render DPI before cropping. Default ${DEFAULT_RENDER_DPI}, max ${MAX_RENDER_DPI}.` },
        format: { type: "string", enum: ["png", "jpg"], description: "Output image format for the cropped region. Default png." },
        renderer: { type: "string", enum: ["auto", "pdftoppm", "mutool", "magick"], description: "Renderer used for the initial full-page image. Default auto." },
        fallback_full_page: { type: "boolean", description: "If crop fails because ImageMagick is unavailable, return the full-page render instead of failing. Default false." }
      },
      required: ["filename", "page"],
      additionalProperties: false,
    },
  },
  {
    name: "render_figure_region",
    description:
      "Step 31C: locate a figure/table/diagram by figure_id or page/query, estimate a crop region around/above/below the caption, render the page, crop the region, and optionally zoom it. Use for timing diagrams, clock trees, reset flows, and block diagrams after find_figure/get_figure_context.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf." },
        figure_id: { type: "string", description: "Figure ID from list_figures/find_figure, for example fig-p113-17.3." },
        page: { type: "number", description: "Fallback 1-based page number if figure_id is not provided." },
        query: { type: "string", description: "Optional query to select the best figure on the page or in the index." },
        region: { type: "string", enum: ["auto", "above_caption", "below_caption", "around_caption", "top_half", "middle", "bottom_half", "full_width"], description: "Automatic crop strategy. Default auto. For most Renesas figures with captions below the drawing, above_caption is useful." },
        x: { type: "number", description: "Optional explicit left coordinate. If provided with width/height, overrides automatic x." },
        y: { type: "number", description: "Optional explicit top coordinate. If provided with width/height, overrides automatic y." },
        width: { type: "number", description: "Optional explicit crop width. Used with x/y/height." },
        height: { type: "number", description: "Optional explicit crop height. Used with x/y/width." },
        unit: { type: "string", enum: ["percent", "px"], description: "Coordinate unit for explicit x/y/width/height. Default percent." },
        margin: { type: "number", description: "Extra crop margin. Default 3 percent for auto regions." },
        zoom: { type: "number", description: "Optional zoom factor after crop. Default 1.5, max 4.0." },
        dpi: { type: "number", description: `Render DPI before cropping. Default ${DEFAULT_RENDER_DPI}, max ${MAX_RENDER_DPI}.` },
        format: { type: "string", enum: ["png", "jpg"], description: "Output image format. Default png." },
        renderer: { type: "string", enum: ["auto", "pdftoppm", "mutool", "magick"], description: "Renderer used for the initial full-page image. Default auto." },
        include_context: { type: "boolean", description: "Include figure caption/context in output. Default true." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "render_figure_page",
    description:
      "Step 31B: locate a figure/table/diagram page using figure_id or page/query, then render that page for visual review. Use after find_figure/list_figures/get_figure_context.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf." },
        figure_id: { type: "string", description: "Figure ID from list_figures/find_figure, for example fig-p113-17.3." },
        page: { type: "number", description: "Fallback 1-based page number if figure_id is not provided." },
        query: { type: "string", description: "Optional query to select the best figure on the page or in the index." },
        dpi: { type: "number", description: `Render DPI. Default ${DEFAULT_RENDER_DPI}, max ${MAX_RENDER_DPI}.` },
        format: { type: "string", enum: ["png", "jpg", "svg", "text_svg"], description: "Output format. Default png." },
        renderer: { type: "string", enum: ["auto", "pdftoppm", "mutool", "magick", "text_svg"], description: "Renderer selection. Default auto." },
        include_context: { type: "boolean", description: "Include figure caption/context in the output. Default true." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_layout_tables_from_pages",
    description:
      "Step 30A/30B: extract layout-aware table candidates from selected PDF pages. Reconstructs rows/columns from PDF text item coordinates, infers semantic column roles such as bit/register/offset/access/reset/description and pin/function/signal/port/peripheral, and marks ambiguous rows. Use this when register, bit-field, or pinmux tables are misread by plain text extraction.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf" },
        start_page: { type: "number", description: "Start page number, 1-based." },
        end_page: { type: "number", description: `End page number, 1-based. Maximum range is ${MAX_TABLE_PAGE_RANGE} pages.` },
        min_columns: { type: "number", description: "Minimum number of detected columns for a row/table candidate. Default 2." },
        kind: { type: "string", enum: ["auto", "register", "bitfield", "pinmux", "all"], description: "Optional table kind filter. Default auto/all. Step 30B adds pinmux/pin-function table filtering." },
      },
      required: ["filename", "start_page", "end_page"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_pinmux_table",
    description:
      "Step 30B: extract layout-aware pinmux / pin function table candidates using PDF text-item coordinates. Reconstructs rows/columns, infers semantic roles such as pin/port/function/signal/peripheral/mode/group, and returns candidate pin-function mappings with confidence and raw cells. Use for pinctrl, GPIO, pin function, alternate function, and multiplexing tables.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example pinctrl.pdf or SoC pin function manual PDF." },
        start_page: { type: "number", description: "Optional start page number, 1-based. If omitted, the tool searches indexed text for candidate pinmux pages." },
        end_page: { type: "number", description: `Optional end page number, 1-based. Maximum range is ${MAX_TABLE_PAGE_RANGE} pages.` },
        min_columns: { type: "number", description: "Minimum detected columns for row/table candidates. Default 2." },
        filter: { type: "string", description: "Optional substring filter across pin/port/function/signal/description, for example P2_1, IRQ8, TXD, SDA, ETH, GBETH." },
        pin: { type: "string", description: "Optional pin/port filter, for example P2_1, P10_3, GPIO3_5." },
        function: { type: "string", description: "Optional function/signal/peripheral filter, for example IRQ8, TXD0, SDA1, ETH, GBETH." },
        top_k: { type: "number", description: "Maximum rows to return. Default 80, max 200." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "build_figures_index",
    description:
      "Step 31A: build or rebuild a persistent .figures.json index from page text/captions. This is a lightweight visual-context index for Figure/Table/Clock tree/Timing/Block diagram captions and nearby text. It does not OCR images; it indexes captions and surrounding text so the agent can locate pages that may require visual inspection.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GPIO.pdf or hardware manual PDF." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "list_figures",
    description:
      "Step 31A: list Figure/Table/diagram/caption candidates from the persistent .figures.json index. Use for discovering timing diagrams, clock trees, block diagrams, flowcharts, and key table captions before reading pages visually/textually.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        filter: { type: "string", description: "Optional substring filter across caption/context, for example clock tree, timing, reset, pin function, interrupt." },
        kind: { type: "string", description: "Optional kind filter: figure, table, clock-tree, timing-diagram, block-diagram, flow-sequence, pinmux, register-table, interrupt, reset, unknown." },
        top_k: { type: "number", description: `Maximum candidates to list. Default ${DEFAULT_FIGURE_TOP_K}, max ${MAX_FIGURE_TOP_K}.` }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "find_figure",
    description:
      "Step 31A: search figure/table/diagram captions and nearby context. Use this to locate clock trees, timing diagrams, block diagrams, reset flows, interrupt routes, or pinmux overview figures before calling get_figure_context/read_pdf_pages.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        query: { type: "string", description: "Search query, for example clock tree, read write timing, reset sequence, block diagram, interrupt route." },
        kind: { type: "string", description: "Optional kind filter, for example timing-diagram, clock-tree, block-diagram, flow-sequence, table." },
        top_k: { type: "number", description: `Maximum candidates. Default ${DEFAULT_FIGURE_TOP_K}, max ${MAX_FIGURE_TOP_K}.` }
      },
      required: ["filename", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_figure_context",
    description:
      "Step 31A: return caption, nearby text, headings, candidate layout tables, and suggested follow-up reads for a figure/table/diagram. Use figure_id from list_figures/find_figure or pass a page/query. This is not OCR/vision; it gives the agent the best text/layout context around a visual object.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        figure_id: { type: "string", description: "Figure ID returned by list_figures/find_figure, for example fig-p113-1." },
        page: { type: "number", description: "Optional page number if figure_id is not known." },
        query: { type: "string", description: "Optional query/caption filter if page contains multiple figures/tables." },
        include_pages: { type: "number", description: "Number of surrounding pages to include on each side. Default 0, max 2." },
        include_layout_tables: { type: "boolean", description: "If true, include layout-aware table summaries from the target page range. Default false." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_register_table",
    description:
      "Extract register-map table candidates using PDF text item coordinates. Returns rows with register name, abbreviation, offset, initial value, access size, page, and confidence when detected.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        start_page: {
          type: "number",
          description: "Optional start page. If omitted, the tool uses register-index pages and register-list sections.",
        },
        end_page: {
          type: "number",
          description: "Optional end page. If omitted, the tool uses register-index pages and register-list sections.",
        },
        filter: {
          type: "string",
          description: "Optional register-name substring filter, for example DMACm, WDT, GT, MAC.",
        },
        top_k: {
          type: "number",
          description: "Maximum number of register rows to return. Default 80, max 200.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_bitfield_table",
    description:
      "Extract a layout-aware bit-field table for a register. Uses PDF text-item coordinates first to preserve bit/access/reset/description columns, then falls back to the persistent bitfield index. Verify ambiguous rows with read_pdf_pages/read_pdf_chunk.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        register: {
          type: "string",
          description:
            "Register name to extract a bit-field table for, for example DMACm_CHCTRL_n, WDTCR, GTCR, or GTCCR.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of candidate bit fields/rows. Default ${DEFAULT_BITFIELD_LIST_TOP_K}, max ${MAX_BITFIELD_LIST_TOP_K}.`,
        },
      },
      required: ["filename", "register"],
      additionalProperties: false,
    },
  },
  {
    name: "summarize_register",
    description:
      "Summarize one hardware register by combining register-index metadata, related chunks, detected bit-field evidence, and suggested follow-up reads. Useful for Linux driver source review against the hardware manual.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        register: {
          type: "string",
          description:
            "Register abbreviation or full register name, for example DMACm_CHCTRL_n, WDTCR, GTCR, or GTCCR.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of related chunks to include. Default ${DEFAULT_REGISTER_SUMMARY_CHUNKS}, max ${MAX_REGISTER_SUMMARY_CHUNKS}.`,
        },
        include_bitfield_evidence: {
          type: "boolean",
          description:
            "Include evidence lines for detected bit fields. Default true.",
        },
      },
      required: ["filename", "register"],
      additionalProperties: false,
    },
  },
  {
    name: "find_sequence",
    description:
      "Find hardware operation sequences/procedures such as initialization, start, stop, clear status, reset, enable/disable, or interrupt handling. Useful for detecting driver bugs caused by wrong register write order.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        topic: {
          type: "string",
          description:
            "Sequence topic to find, for example initialization, start DMA transfer, stop channel, clear transfer end, clear interrupt, reset, software reset, enable channel.",
        },
        register: {
          type: "string",
          description:
            "Optional register name to prioritize context, for example DMACm_CHCTRL_n, DMACm_CHSTAT_n, WDTCR, WDTRR, GTCR, or GTCCR.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of sequence candidates. Default ${DEFAULT_SEQUENCE_TOP_K}, max ${MAX_SEQUENCE_TOP_K}.`,
        },
      },
      required: ["filename", "topic"],
      additionalProperties: false,
    },
  },
  {
    name: "list_sequences",
    description:
      "List detected persistent operation-flow/sequence candidates from the .sequences.json index. Useful for discovering init/start/stop/clear/reset/IRQ/error flows in a hardware manual.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        filter: {
          type: "string",
          description: "Optional substring filter, for example init, start, stop, clear, reset, irq, error, transfer, suspend.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of sequences to list. Default ${DEFAULT_SEQUENCE_LIST_TOP_K}, max ${MAX_SEQUENCE_LIST_TOP_K}.`,
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sequence",
    description:
      "Get one persistent operation-flow/sequence by topic from the .sequences.json index. Falls back to dynamic find_sequence-style search when the persistent index has no good match.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        topic: {
          type: "string",
          description: "Sequence topic, for example initialization, start transfer, stop channel, clear interrupt, reset, IRQ handling, or error handling.",
        },
        register: {
          type: "string",
          description: "Optional register name to bias dynamic fallback, for example DMACm_CHCTRL_n or DMACm_CHSTAT_n.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of sequence evidence chunks. Default ${DEFAULT_SEQUENCE_TOP_K}, max ${MAX_SEQUENCE_TOP_K}.`,
        },
      },
      required: ["filename", "topic"],
      additionalProperties: false,
    },
  },
  {
    name: "find_caution",
    description:
      "Find caution/note/restriction/undefined/prohibited/reserved-bit/clear-flag semantics in a hardware manual. Useful for detecting driver bugs such as writing registers while running, reserved-bit handling errors, or wrong write-1-to-clear/write-0-to-clear behavior.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        topic: {
          type: "string",
          description:
            "Caution topic to find, for example reserved bits, write only when stopped, clear flag, write 1 to clear, write 0 to clear, undefined, prohibited, interrupt status, reset, or a register-related condition.",
        },
        register: {
          type: "string",
          description:
            "Optional register name to prioritize context, for example DMACm_CHCTRL_n, DMACm_CHSTAT_n, WDTCR, WDTRR, GTCR, or GTCCR.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of caution candidates. Default ${DEFAULT_CAUTION_TOP_K}, max ${MAX_CAUTION_TOP_K}.`,
        },
      },
      required: ["filename", "topic"],
      additionalProperties: false,
    },
  },
  {
    name: "list_cautions",
    description:
      "List persistent caution/note/restriction candidates from the .cautions.json index. Use this to inspect reserved-bit rules, write timing restrictions, undefined/prohibited behavior, and clear-flag semantics across the manual.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        filter: {
          type: "string",
          description:
            "Optional filter, for example reserved, write only when stopped, clear status, write 1 to clear, undefined, prohibited, interrupt, reset, or a register name.",
        },
        register: {
          type: "string",
          description:
            "Optional register name to list only cautions related to that register, for example DMACm_CHCTRL_n or DMACm_CHSTAT_n.",
        },
        type: {
          type: "string",
          description:
            "Optional caution type filter, for example reserved-bit, clear-semantics, write-timing, undefined-invalid, prohibited, note, caution, reset-access.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of cautions to list. Default ${DEFAULT_CAUTION_LIST_TOP_K}, max ${MAX_CAUTION_LIST_TOP_K}.`,
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "get_cautions_for_register",
    description:
      "Get persistent caution/note/restriction candidates for one register from the .cautions.json index. Useful before approving register writes in a Linux driver.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        register: {
          type: "string",
          description:
            "Register name, for example DMACm_CHCTRL_n, DMACm_CHSTAT_n, WDTCR, WDTRR, GTCR, or GTCCR.",
        },
        filter: {
          type: "string",
          description:
            "Optional topic filter, for example reserved bits, write only when stopped, clear status flag, write 1 to clear, write 0 to clear, undefined, or reset.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of register-specific cautions. Default ${DEFAULT_CAUTION_LIST_TOP_K}, max ${MAX_CAUTION_LIST_TOP_K}.`,
        },
      },
      required: ["filename", "register"],
      additionalProperties: false,
    },
  },
  {
    name: "analyze_module",
    description:
      "Analyze a hardware manual at module level and create a persistent module profile. The profile summarizes likely module type, Linux subsystem, manual structure, register groups, driver-relevant topics, risk areas, and suggested MCP follow-up calls.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        module_type: {
          type: "string",
          description:
            "Optional module/subsystem hint, for example dmaengine, watchdog, pwm, timer, gpio, i2c, spi, uart, ethernet, can, adc, rtc. If omitted, the server infers it from filename/registers/sections.",
        },
        focus: {
          type: "string",
          description:
            "Optional analysis focus, for example minimal driver, interrupt handling, start/stop, status clear, reset, runtime PM, or debugging existing driver.",
        },
        force: {
          type: "boolean",
          description: "Force rebuilding the module profile even if a valid profile already exists.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "get_module_profile",
    description:
      "Get the module profile generated by analyze_module. If no valid profile exists, the server builds one automatically. Use this before build_driver_evidence_pack when an AI agent needs module-level understanding.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        module_type: {
          type: "string",
          description:
            "Optional module/subsystem hint used if the profile must be rebuilt.",
        },
        focus: {
          type: "string",
          description:
            "Optional focus used if the profile must be rebuilt.",
        },
        refresh: {
          type: "boolean",
          description: "If true, rebuild the profile before returning it.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "prepare_driver_task",
    description:
      "Prepare a driver debugging/implementation workflow for an AI agent working in an external VS Code source workspace. This tool does not read source code; it returns mandatory manual-evidence MCP calls, register/bitfield/sequence/caution checks, and source-code review checkpoints for a specific task.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        task: {
          type: "string",
          description:
            "Driver task or bug description, for example: debug DMA transfer does not start, add interrupt handling, implement suspend/resume, support watchdog restart, or add PWM capture.",
        },
        module_type: {
          type: "string",
          description:
            "Optional module/subsystem hint, for example dmaengine, watchdog, pwm, timer, gpio, i2c, spi, uart, ethernet, can, adc, rtc.",
        },
        focus_registers: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional register names already seen in source code or suspected by the user, for example DMACm_CHCTRL_n, DMACm_CHSTAT_n, WDTCR, WDTRR, GTCR.",
        },
        focus_bitfields: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional bit-field names already seen in source code or suspected by the user, for example SETEN, CLREN, TC, ER, CKS, TOPS.",
        },
        top_registers: {
          type: "number",
          description: `Maximum number of task-related registers to include. Default ${DEFAULT_DRIVER_TASK_REGISTERS}, max ${MAX_DRIVER_TASK_REGISTERS}.`,
        },
      },
      required: ["filename", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "list_driver_profiles",
    description:
      "List data-driven driver review profiles from driver_profiles/. Profiles are external JSON files, so new driver/subsystem checklist knowledge can be added without changing MCP code.",
    inputSchema: {
      type: "object",
      properties: {
        create_default: {
          type: "boolean",
          description: "Create default profile JSON files if missing. Default true.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "driver_completeness_checklist",
    description:
      "Build a data-driven Linux driver completeness checklist using external driver_profiles/*.json plus hardware-manual orientation. Use this for review tasks such as Ethernet/stmmac, dmaengine, watchdog, PWM, or an unknown/custom driver. It does not read source code; the VS Code agent should use the checklist to inspect source and then call verify_register_usage for each hardware operation.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example GBETH.pdf, WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf.",
        },
        subsystem: {
          type: "string",
          description: "Optional Linux subsystem/profile hint, for example ethernet, dmaengine, watchdog, pwm, gpio, i2c, spi, uart, can, adc, rtc.",
        },
        driver_family: {
          type: "string",
          description: "Optional driver family hint, for example stmmac, ravb, gpt, rzg2l-gpt, dwmac, custom.",
        },
        profile: {
          type: "string",
          description: "Optional explicit profile name, for example ethernet-stmmac. If omitted, MCP tries subsystem-driver_family, subsystem, then generic.",
        },
        task: {
          type: "string",
          description: "Optional review task/focus, for example Linux MAC driver completeness review, IRQ handling, suspend/resume, reset path, or upstream readiness.",
        },
        create_default: {
          type: "boolean",
          description: "Create default driver_profiles/*.json if missing. Default true.",
        },
        include_visual_evidence: {
          type: "boolean",
          description: "Include persisted visual evidence summary from indexes/<filename>.visual-evidence.json if available. Default true.",
        },
        visual_filter: {
          type: "string",
          description: "Optional filter for visual evidence entries, for example clock reset pinmux interrupt timing.",
        },
        visual_status: {
          type: "string",
          enum: ["all", "verified", "unverified", "needs_verification", "observed", "rejected"],
          description: "Filter visual evidence by verification status. Use verified to include only verified entries. Default all.",
        },
        visual_gate: {
          type: "string",
          enum: ["advisory", "verified_only", "block_unverified"],
          description: "Driver-review gate for visual evidence. advisory warns only; verified_only includes verified entries and reports unverified matches as blockers; block_unverified keeps all entries but treats unverified matches as blockers. Default advisory.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_driver_requirements",
    description:
      "Compare source-code features observed by the VS Code AI agent against the data-driven driver completeness checklist/profile. The MCP server does not read source code; pass implemented_features/source_observations/register_operations extracted by the agent. Returns implemented/missing/unclear matrix, manual verification gaps, and suggested verify_register_usage calls.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf, WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf." },
        subsystem: { type: "string", description: "Optional Linux subsystem/profile hint, for example ethernet, dmaengine, watchdog, pwm, gpio, i2c, spi, uart, can, adc, rtc." },
        driver_family: { type: "string", description: "Optional driver family hint, for example stmmac, ravb, gpt, rzg2l-gpt, dwmac, custom." },
        profile: { type: "string", description: "Optional explicit driver profile name, for example ethernet-stmmac." },
        task: { type: "string", description: "Optional review task/focus, for example Linux MAC driver completeness review, IRQ handling, suspend/resume, reset path, or upstream readiness." },
        source_files: { type: "array", items: { type: "string" }, description: "Source files inspected by the VS Code AI agent." },
        source_summary: { type: "string", description: "Optional concise source-code summary produced by the AI agent after reading the workspace." },
        implemented_features: { type: "array", items: { type: "string" }, description: "Feature/checklist items observed in source code, for example clocks enabled, reset deasserted, request IRQ, parse phy-mode, register stmmac platform data." },
        missing_features: { type: "array", items: { type: "string" }, description: "Feature/checklist items explicitly observed as missing or unsupported in source code." },
        source_observations: { type: "array", items: { type: "string" }, description: "Additional source-code observations, uncertainties, TODOs, or notable implementation details extracted by the agent." },
        register_operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              register: { type: "string" },
              operation: { type: "string" },
              bitfields: { type: "array", items: { type: "string" } },
              access_type: { type: "string" },
              intent: { type: "string" },
              source_snippet: { type: "string" }
            },
            additionalProperties: true
          },
          description: "Optional register operations observed in source. These are not verified automatically; output will suggest verify_register_usage calls."
        },
        create_default: { type: "boolean", description: "Create default driver_profiles/*.json if missing. Default true." },
        include_visual_evidence: { type: "boolean", description: "Include persisted visual evidence when comparing source coverage. Default true." },
        visual_filter: { type: "string", description: "Optional filter for visual evidence entries relevant to the source review task." },
        visual_status: { type: "string", enum: ["all", "verified", "unverified", "needs_verification", "observed", "rejected"], description: "Filter persisted visual evidence by verification status. Default all." },
        visual_gate: { type: "string", enum: ["advisory", "verified_only", "block_unverified"], description: "If verified_only or block_unverified, matching unverified visual evidence becomes needsVerification/blocker. Default advisory." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "source_review_prompt_pack",
    description:
      "Generate a structured prompt/workflow pack for a VS Code AI agent that must review or implement a Linux driver using source code in the workspace and manual evidence from this MCP server. This avoids long ad-hoc prompts: it tells the agent which source facts to extract, which MCP tools to call, and how to produce implemented/missing/unclear conclusions.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf, WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf." },
        subsystem: { type: "string", description: "Optional Linux subsystem/profile hint, for example ethernet, dmaengine, watchdog, pwm, gpio, i2c, spi, uart, can, adc, rtc." },
        driver_family: { type: "string", description: "Optional driver family hint, for example stmmac, ravb, gpt, rzg2l-gpt, dwmac, custom." },
        profile: { type: "string", description: "Optional explicit driver profile name, for example ethernet-stmmac." },
        task: { type: "string", description: "Driver task/review goal, for example evaluate driver completeness, debug IRQ handling, implement reset path, or add suspend/resume." },
        source_files: { type: "array", items: { type: "string" }, description: "Optional source files that the VS Code AI agent should inspect first. MCP does not read these files." },
        review_depth: { type: "string", enum: ["quick", "standard", "deep"], description: "Prompt strictness/depth. quick uses a short workflow; standard is default; deep requires exhaustive register-operation extraction." },
        output_format: { type: "string", enum: ["report", "checklist", "patch_plan", "debug_plan"], description: "Expected final answer style for the VS Code agent. Default report." },
        create_default: { type: "boolean", description: "Create default driver_profiles/*.json if missing. Default true." },
        include_visual_evidence: { type: "boolean", description: "Include persisted visual evidence and visual-review workflow reminders in the generated prompt. Default true." },
        visual_filter: { type: "string", description: "Optional filter for visual evidence entries relevant to the prompt task." },
        visual_status: { type: "string", enum: ["all", "verified", "unverified", "needs_verification", "observed", "rejected"], description: "Filter persisted visual evidence by verification status. Default all." },
        visual_gate: { type: "string", enum: ["advisory", "verified_only", "block_unverified"], description: "If verified_only or block_unverified, the generated prompt treats matching unverified visual evidence as blockers. Default advisory." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_register_usage",
    description:
      "Verify a source-code register operation against the hardware manual. The AI agent should call this after reading source code in VS Code and identifying a writel/readl/regmap operation. This tool checks register existence, bit-field evidence, sequence/order hints, caution/restriction rules, reserved-bit/clear semantics risks, and returns an evidence/inference/needsVerification contract.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example GBETH.pdf, WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf.",
        },
        register: {
          type: "string",
          description: "Register name or source-code register macro, for example DMACm_CHCTRL_n, WDTCR, GBETH_MACCR, MACCR.",
        },
        operation: {
          type: "string",
          description: "Source-code operation or driver intent, for example writel(SETEN), read-modify-write enable TX/RX, clear interrupt status, poll reset done.",
        },
        bitfields: {
          type: "array",
          items: { type: "string" },
          description: "Optional bit-field names/macro symbols seen in source code, for example SETEN, TE, RE, TC, ER.",
        },
        access_type: {
          type: "string",
          enum: ["auto", "read", "write", "raw_write", "read_modify_write", "set_bits", "clear_bits", "write_one_to_clear", "write_zero_to_clear", "poll", "reset"],
          description: "Optional source-code access pattern. Use raw_write for writel(value, reg), read_modify_write for readl/modify/writel, poll for read-poll loops.",
        },
        intent: {
          type: "string",
          enum: ["auto", "init", "start", "stop", "clear", "irq", "reset", "error", "status", "configure", "read", "write"],
          description: "Optional hardware intent. auto derives from operation/access_type.",
        },
        source_snippet: {
          type: "string",
          description: "Optional short source-code snippet or code summary. The MCP server does not read the repo; the AI agent may pass the relevant snippet here.",
        },
        top_k: {
          type: "number",
          description: "Maximum candidates for internal verification searches. Default 8.",
        },
      },
      required: ["filename", "register", "operation"],
      additionalProperties: false,
    },
  },
  {
    name: "build_driver_evidence_pack",
    description:
      "Build a driver-oriented evidence pack from the hardware manual. It combines module identity, likely Linux subsystem, register groups, key registers, bit-field candidates, operation sequence candidates, cautions/restrictions, and follow-up MCP calls for AI agents working in an external source workspace.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        module_type: {
          type: "string",
          description:
            "Optional module/subsystem hint, for example dmaengine, watchdog, pwm, timer, gpio, i2c, spi, uart, ethernet, can, adc, rtc. If omitted, the server infers it from filename/registers/sections.",
        },
        focus: {
          type: "string",
          description:
            "Optional driver focus, for example minimal driver, interrupt handling, start/stop, reset, status clear, runtime PM, or debugging existing driver.",
        },
        mode: {
          type: "string",
          enum: ["adaptive", "fast", "full"],
          description:
            "Build mode. adaptive is the default: fast-first, budget-aware, returns partial results instead of timing out. fast uses persistent indexes only. full enables deeper dynamic searches but can be slow.",
        },
        budget_ms: {
          type: "number",
          description: `Internal time budget in milliseconds for this tool. Default ${DEFAULT_DRIVER_PACK_BUDGET_MS}, min ${MIN_DRIVER_PACK_BUDGET_MS}, max ${MAX_DRIVER_PACK_BUDGET_MS}. The server returns partial results before this budget is exhausted.`,
        },
        top_registers: {
          type: "number",
          description: `Maximum number of registers to include in the register map summary. Default ${DEFAULT_DRIVER_PACK_REGISTERS}, max ${MAX_DRIVER_PACK_REGISTERS}.`,
        },
        top_summaries: {
          type: "number",
          description: `Maximum number of key register summaries to include. Default ${DEFAULT_DRIVER_PACK_SUMMARIES}, max ${MAX_DRIVER_PACK_SUMMARIES}.`,
        },
        include_visual_evidence: {
          type: "boolean",
          description: "Include persisted visual evidence relevant to the driver focus if available. Default true.",
        },
        visual_filter: {
          type: "string",
          description: "Optional filter for visual evidence entries, for example clock reset pinmux interrupt timing.",
        },
        visual_status: {
          type: "string",
          enum: ["all", "verified", "unverified", "needs_verification", "observed", "rejected"],
          description: "Filter visual evidence by verification status. Use verified to include only verified entries. Default all.",
        },
        visual_gate: {
          type: "string",
          enum: ["advisory", "verified_only", "block_unverified"],
          description: "Driver-review gate for visual evidence. advisory warns only; verified_only includes verified entries and reports unverified matches as blockers; block_unverified keeps all entries but treats unverified matches as blockers. Default advisory.",
        },
        visual_top_k: {
          type: "number",
          description: "Maximum visual evidence entries to include. Default 8, max 30.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "find_section",
    description:
      "Find section headings/topics using the section index first, then fall back to chunk search. Examples: Register Description, DMA initialization, Timestamp, MDIO, Clock Setting, Interrupt Source.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        section: {
          type: "string",
          description:
            "Section title, heading fragment, or topic to find.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of results. Default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}.`,
        },
      },
      required: ["filename", "section"],
      additionalProperties: false,
    },
  },
];

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------

function textResult(text) {
  return {
    content: [
      {
        type: "text",
        text: limitOutput(String(text ?? "")),
      },
    ],
  };
}

function errorResult(error) {
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


function compactText(value, maxChars = 240) {
  const text = normalizeText(String(value || ""));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function evidenceTypeFromText(text, fallback = "paragraph") {
  const raw = String(text || "");
  if (/\b(Register\s+Name|Abbreviation|Offset\s+Address|Access\s+Size)\b/i.test(raw)) return "register-table";
  if (/\b(Bit\s+Name|Bit|R\/W|Access|Initial\s+Value|Description)\b/i.test(raw)) return "bitfield-table";
  if (/\b(sequence|procedure|operation|setting|before|after|when|must|should|step)\b/i.test(raw)) return "procedure";
  if (/\b(Caution|Note|Restriction|Prohibited|Undefined|Reserved|do\s+not|must\s+not|only\s+when)\b/i.test(raw)) return "caution";
  if (/\b(Interrupt|IRQ|status|flag|error|clear|cleared)\b/i.test(raw)) return "status-flow";
  return fallback;
}

function confidenceLevel(value) {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (["high", "medium", "low"].includes(lower)) return lower;
  }
  const n = Number(value || 0);
  if (n >= 75) return "high";
  if (n >= 40) return "medium";
  return "low";
}

function makeEvidence({
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

function makeInference({ statement = "", basis = "", confidence = "low", risk = "" } = {}) {
  return {
    statement: compactText(statement, 320),
    basis: compactText(basis, 260),
    confidence: confidenceLevel(confidence),
    ...(risk ? { risk: compactText(risk, 260) } : {}),
  };
}

function makeNeedsVerification({ item = "", reason = "", suggestedTools = [] } = {}) {
  return {
    item: compactText(item, 260),
    reason: compactText(reason, 320),
    suggestedTools: Array.isArray(suggestedTools) ? suggestedTools.slice(0, 8) : [],
  };
}

function makeEvidenceContract({
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

function formatEvidenceContract(contract) {
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

function appendEvidenceContract(text, contract) {
  return `${text}${formatEvidenceContract(contract)}`;
}

function evidenceFromChunk(chunk, quote = "", options = {}) {
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

function limitOutput(text, maxChars = MAX_TOOL_OUTPUT_CHARS) {
  if (text.length <= maxChars) return text;

  return `${text.slice(
    0,
    maxChars
  )}\n\n[Output truncated by ${SERVER_NAME}. Original length: ${text.length} characters. Use search_pdf, read_pdf_chunk, or a smaller page range.]`;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[\t\u00a0]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n[ ]+/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function normalizeForSearch(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[_\-./()[\]{}:;,=+*<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalSymbol(text) {
  return String(text || "")
    .toUpperCase()
    .normalize("NFKC")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[^A-Z0-9_]/g, "")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampInteger(value, defaultValue, min, max) {
  const n = Number(value ?? defaultValue);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampTopK(value) {
  return clampInteger(value, DEFAULT_TOP_K, 1, MAX_TOP_K);
}

function clampRegisterListTopK(value) {
  return clampInteger(value, DEFAULT_REGISTER_LIST_TOP_K, 1, MAX_REGISTER_LIST_TOP_K);
}

function clampBitfieldListTopK(value) {
  return clampInteger(value, DEFAULT_BITFIELD_LIST_TOP_K, 1, MAX_BITFIELD_LIST_TOP_K);
}

function clampChunkSize(value) {
  return clampInteger(value, DEFAULT_CHUNK_SIZE, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE);
}

function clampChunkOverlap(value, chunkSize) {
  const n = Number(value ?? DEFAULT_CHUNK_OVERLAP);
  if (!Number.isFinite(n)) return Math.min(DEFAULT_CHUNK_OVERLAP, chunkSize - 1);
  return Math.max(0, Math.min(Math.floor(n), chunkSize - 1));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function atomicWriteFile(targetPath, data, encoding = "utf-8") {
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

async function atomicWriteJson(targetPath, value) {
  await atomicWriteFile(targetPath, JSON.stringify(value, null, 2), "utf-8");
}

async function readIndexLock(filename) {
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

function isIndexLockStale(lockInfo, nowMs = Date.now()) {
  if (!lockInfo) return false;
  const createdMs = Number(lockInfo.createdAtMs || 0);
  if (!Number.isFinite(createdMs) || createdMs <= 0) return true;
  return nowMs - createdMs > INDEX_LOCK_STALE_MS;
}

async function removeIndexLock(filename, reason = "manual cleanup") {
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

async function acquireIndexLock(filename, options = {}) {
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

async function releaseIndexLock(filename, lock) {
  if (!lock || !lock.lockPath) return;
  const current = await readIndexLock(filename);
  if (current && current.pid === process.pid) {
    await fs.rm(lock.lockPath, { force: true });
  }
}

async function withIndexBuildLock(filename, options, callback) {
  const lock = await acquireIndexLock(filename, options);
  try {
    return await callback(lock);
  } finally {
    await releaseIndexLock(filename, lock);
  }
}

async function getPdfSourceInfo(filename) {
  const filePath = safePdfPath(filename);
  const stat = await fs.stat(filePath);

  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mtime: stat.mtime.toISOString(),
  };
}

function isSamePdfSource(cacheSource, currentSource) {
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

function ensurePdfFilename(filename) {
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


function ensurePdfFilenameLite(filename) {
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

function getIndexStatusUltraMinimal(filename) {
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

function formatIndexStatusUltraMinimal(status) {
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

function ensureInsideRoot(candidatePath, rootDir, what) {
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

function safePdfPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(path.join(DOCUMENTS_DIR, filename), DOCUMENTS_DIR, "PDF");
}

function safeIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.index.json`),
    INDEX_DIR,
    "index"
  );
}

function safePagesCachePath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.pages.json`),
    INDEX_DIR,
    "pages cache"
  );
}

function safePagesPartialCachePath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.pages.partial.json`),
    INDEX_DIR,
    "partial pages cache"
  );
}

function safeSectionsIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.sections.json`),
    INDEX_DIR,
    "sections index"
  );
}

function safeRegistersIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.registers.json`),
    INDEX_DIR,
    "registers index"
  );
}

function safeBitfieldsIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.bitfields.json`),
    INDEX_DIR,
    "bitfields index"
  );
}

function safeSequencesIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.sequences.json`),
    INDEX_DIR,
    "sequences index"
  );
}

function safeCautionsIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.cautions.json`),
    INDEX_DIR,
    "cautions index"
  );
}

function safeFiguresIndexPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.figures.json`),
    INDEX_DIR,
    "figures/captions index"
  );
}

function safeVisualEvidencePath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.visual-evidence.json`),
    INDEX_DIR,
    "visual evidence index"
  );
}

function safeArtifactManifestPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.manifest.json`),
    INDEX_DIR,
    "artifact manifest"
  );
}

function sanitizeRenderStem(value) {
  return String(value || "render")
    .trim()
    .replace(/\.pdf$/i, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "render";
}

function safeRenderOutputPath(filename, page, format, suffix = "") {
  ensurePdfFilename(filename);
  const ext = String(format || "png").toLowerCase() === "jpg" ? "jpg" : String(format || "png").toLowerCase() === "svg" || String(format || "png").toLowerCase() === "text_svg" ? "svg" : "png";
  const pageNumber = clampInteger(page, 1, 1, 999999);
  const stem = sanitizeRenderStem(`${filename}-p${pageNumber}${suffix ? `-${suffix}` : ""}`);
  return ensureInsideRoot(path.join(RENDERS_DIR, `${stem}.${ext}`), RENDERS_DIR, "render output");
}

function safeDriverPackPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.driver-pack.txt`),
    INDEX_DIR,
    "driver evidence pack"
  );
}

function safeDriverPackJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.driver-pack.json`),
    INDEX_DIR,
    "driver evidence pack JSON"
  );
}

function safeDriverPackMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.driver-pack.md`),
    INDEX_DIR,
    "driver evidence pack Markdown"
  );
}

function safeDriverTaskPlanPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.driver-task-plan.txt`),
    INDEX_DIR,
    "driver task plan"
  );
}

function safeDriverTaskPlanJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.driver-task-plan.json`),
    INDEX_DIR,
    "driver task plan JSON"
  );
}

function safeDriverTaskPlanMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.driver-task-plan.md`),
    INDEX_DIR,
    "driver task plan Markdown"
  );
}

function safeDoctorReportPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.doctor.txt`),
    INDEX_DIR,
    "doctor report"
  );
}

function safeDoctorReportJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.doctor.json`),
    INDEX_DIR,
    "doctor report JSON"
  );
}

function safeDoctorReportMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.doctor.md`),
    INDEX_DIR,
    "doctor report Markdown"
  );
}

function safeEvalCasesPath() {
  return ensureInsideRoot(
    path.join(EVAL_DIR, "manual-cases.json"),
    EVAL_DIR,
    "eval cases"
  );
}

function safeEvalProfilePath(profileName) {
  const safeName = sanitizeDriverProfileName(profileName || "generic");
  return ensureInsideRoot(
    path.join(EVAL_PROFILES_DIR, `${safeName}.json`),
    EVAL_PROFILES_DIR,
    "eval profile"
  );
}

function safeEvalFixturePath(fixtureName) {
  const safeName = sanitizeDriverProfileName(fixtureName || "fixture");
  return ensureInsideRoot(
    path.join(EVAL_FIXTURES_DIR, `${safeName}.json`),
    EVAL_FIXTURES_DIR,
    "eval fixture"
  );
}

function safeEvalReportTextPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.eval-report.txt`),
    INDEX_DIR,
    "eval report text"
  );
}

function safeEvalReportJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.eval-report.json`),
    INDEX_DIR,
    "eval report JSON"
  );
}

function safeEvalReportMarkdownPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.eval-report.md`),
    INDEX_DIR,
    "eval report Markdown"
  );
}

function normalizeDriverProfileHint(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "pwm/timer" || raw.includes("pwm") || raw.includes("timer")) return "pwm";
  if (raw.includes("ethernet") || raw.includes("netdev") || raw.includes("stmmac") || raw.includes("dwmac")) return "ethernet";
  if (raw.includes("dma")) return "dmaengine";
  if (raw.includes("watchdog") || raw === "wdt") return "watchdog";
  if (raw.includes("gpio") || raw.includes("pinctrl")) return "gpio";
  if (raw.includes("i2c") || raw.includes("iic")) return "i2c";
  if (raw.includes("spi")) return "spi";
  if (raw.includes("uart") || raw.includes("serial")) return "uart";
  if (raw.includes("can")) return "can";
  if (raw.includes("adc") || raw.includes("iio")) return "adc";
  if (raw.includes("rtc")) return "rtc";
  return raw;
}

function sanitizeDriverProfileName(value) {
  const name = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!name) return "generic";
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error("Invalid driver profile name");
  }
  return name;
}

function safeDriverProfilePath(profileName) {
  const safeName = sanitizeDriverProfileName(profileName);
  return ensureInsideRoot(
    path.join(DRIVER_PROFILES_DIR, `${safeName}.json`),
    DRIVER_PROFILES_DIR,
    "driver profile"
  );
}

function safeIndexLockPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.index.lock`),
    INDEX_DIR,
    "index build lock"
  );
}

function safeJobsStatePath() {
  return ensureInsideRoot(
    path.join(INDEX_DIR, ".jobs.json"),
    INDEX_DIR,
    "background jobs state"
  );
}

function safeModuleProfileJsonPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.module-profile.json`),
    INDEX_DIR,
    "module profile JSON"
  );
}

function safeModuleProfileTextPath(filename) {
  ensurePdfFilename(filename);
  return ensureInsideRoot(
    path.join(INDEX_DIR, `${filename}.module-profile.txt`),
    INDEX_DIR,
    "module profile text"
  );
}


// -----------------------------------------------------------------------------
// Doctor / index validation
// -----------------------------------------------------------------------------

function doctorStatusSeverity(status) {
  const table = {
    ok: 0,
    missing_optional: 1,
    warning: 1,
    missing: 2,
    stale: 3,
    incompatible: 3,
    broken: 4,
    error: 4,
  };
  return table[status] ?? 2;
}

function doctorStatusIcon(status) {
  if (status === "ok") return "OK";
  if (status === "missing_optional" || status === "warning") return "WARN";
  return "FAIL";
}

function doctorCheck(name, status, details = {}) {
  return {
    name,
    status,
    severity: doctorStatusSeverity(status),
    ...details,
    errors: details.errors || [],
    warnings: details.warnings || [],
  };
}

async function readJsonForDoctor(filePath, expectedSchemaVersion, label) {
  if (!(await pathExists(filePath))) {
    return doctorCheck(label, "missing", { path: filePath });
  }

  try {
    const stat = await fs.stat(filePath);
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    const warnings = [];
    const errors = [];

    if (expectedSchemaVersion !== undefined && data.schemaVersion !== expectedSchemaVersion) {
      errors.push(`schema mismatch: expected ${expectedSchemaVersion}, got ${data.schemaVersion ?? "unknown"}`);
    }

    return doctorCheck(label, errors.length ? "incompatible" : "ok", {
      path: filePath,
      sizeBytes: stat.size,
      modified: stat.mtime.toISOString(),
      data,
      schemaVersion: data.schemaVersion,
      createdAt: data.createdAt,
      errors,
      warnings,
    });
  } catch (error) {
    return doctorCheck(label, "broken", {
      path: filePath,
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }
}

async function readTextArtifactForDoctor(filePath, label, optional = true) {
  if (!(await pathExists(filePath))) {
    return doctorCheck(label, optional ? "missing_optional" : "missing", { path: filePath });
  }

  try {
    const stat = await fs.stat(filePath);
    return doctorCheck(label, "ok", {
      path: filePath,
      sizeBytes: stat.size,
      modified: stat.mtime.toISOString(),
    });
  } catch (error) {
    return doctorCheck(label, "broken", {
      path: filePath,
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }
}

function markCheck(check, status, message, field = "errors") {
  check.status = status;
  check.severity = doctorStatusSeverity(status);
  check[field] = check[field] || [];
  if (message) check[field].push(message);
  return check;
}

function validateFilenameForDoctor(check, filename) {
  if (!check.data) return check;
  if (check.data.filename && check.data.filename !== filename) {
    return markCheck(check, "incompatible", `filename mismatch: expected ${filename}, got ${check.data.filename}`);
  }
  return check;
}

function validateSourceForDoctor(check, currentSource, kind) {
  if (!check.data || check.status === "broken" || check.status === "missing") return check;

  if (kind === "chunk-index") {
    const sourceSize = Number(check.data.sourceSize);
    const sourceMtime = Number(check.data.sourceModifiedMs);
    if (sourceSize !== Number(currentSource.size)) {
      return markCheck(check, "stale", `source size mismatch: index ${sourceSize}, current ${currentSource.size}`);
    }
    if (!Number.isFinite(sourceMtime) || Math.abs(sourceMtime - Number(currentSource.mtimeMs)) >= 1500) {
      return markCheck(check, "stale", `source mtime mismatch: index ${sourceMtime}, current ${currentSource.mtimeMs}`);
    }
    return check;
  }

  if (check.data.source && !isSamePdfSource(check.data.source, currentSource)) {
    return markCheck(check, "stale", "PDF source metadata differs from current PDF");
  }

  if (!check.data.source && !["module-profile"].includes(kind)) {
    markCheck(check, check.status === "ok" ? "warning" : check.status, "missing source metadata", "warnings");
  }

  return check;
}

function validateShapeForDoctor(check, kind) {
  if (!check.data || check.status === "missing" || check.status === "broken") return check;
  const d = check.data;

  const expectArray = (field) => {
    if (!Array.isArray(d[field])) markCheck(check, "incompatible", `missing/invalid array: ${field}`);
  };
  const expectNumber = (field) => {
    if (!Number.isFinite(Number(d[field]))) markCheck(check, check.status === "ok" ? "warning" : check.status, `missing/invalid number: ${field}`, "warnings");
  };

  if (kind === "chunk-index") {
    expectArray("chunks");
    expectNumber("pageCount");
    expectNumber("chunkCount");
    if (Array.isArray(d.chunks) && Number(d.chunkCount) !== d.chunks.length) {
      markCheck(check, "warning", `chunkCount mismatch: declared ${d.chunkCount}, actual ${d.chunks.length}`, "warnings");
    }
  } else if (kind === "pages") {
    expectArray("pages");
    expectNumber("pageCount");
    if (Array.isArray(d.pages) && Number(d.pageCount) !== d.pages.length) {
      markCheck(check, "warning", `pageCount mismatch: declared ${d.pageCount}, actual ${d.pages.length}`, "warnings");
    }
  } else if (kind === "sections") {
    expectArray("sections");
    if (Array.isArray(d.sections) && Number(d.sectionCount) !== d.sections.length) {
      markCheck(check, "warning", `sectionCount mismatch: declared ${d.sectionCount}, actual ${d.sections.length}`, "warnings");
    }
  } else if (kind === "registers") {
    expectArray("registers");
    if (Array.isArray(d.registers) && Number(d.registerCount) !== d.registers.length) {
      markCheck(check, "warning", `registerCount mismatch: declared ${d.registerCount}, actual ${d.registers.length}`, "warnings");
    }
  } else if (kind === "bitfields") {
    expectArray("bitfields");
    if (Array.isArray(d.bitfields) && Number(d.bitfieldCount) !== d.bitfields.length) {
      markCheck(check, "warning", `bitfieldCount mismatch: declared ${d.bitfieldCount}, actual ${d.bitfields.length}`, "warnings");
    }
  } else if (kind === "sequences") {
    expectArray("sequences");
    if (Array.isArray(d.sequences) && Number(d.sequenceCount) !== d.sequences.length) {
      markCheck(check, "warning", `sequenceCount mismatch: declared ${d.sequenceCount}, actual ${d.sequences.length}`, "warnings");
    }
  } else if (kind === "cautions") {
    expectArray("cautions");
    if (Array.isArray(d.cautions) && Number(d.cautionCount) !== d.cautions.length) {
      markCheck(check, "warning", `cautionCount mismatch: declared ${d.cautionCount}, actual ${d.cautions.length}`, "warnings");
    }
  } else if (kind === "figures") {
    expectArray("figures");
    if (Array.isArray(d.figures) && Number(d.figureCount) !== d.figures.length) {
      markCheck(check, "warning", `figureCount mismatch: declared ${d.figureCount}, actual ${d.figures.length}`, "warnings");
    }
  } else if (kind === "visualEvidence") {
    expectArray("entries");
  } else if (kind === "module-profile") {
    if (!d.moduleType) markCheck(check, "warning", "module profile missing moduleType", "warnings");
    if (!d.linuxSubsystem) markCheck(check, "warning", "module profile missing linuxSubsystem", "warnings");
  } else if (kind === "artifact-manifest") {
    if (!d.source || !d.source.fingerprint) markCheck(check, "warning", "manifest missing source fingerprint", "warnings");
    if (!d.artifacts || typeof d.artifacts !== "object") markCheck(check, "incompatible", "manifest missing artifacts object");
    if (!d.dependencyGraph || typeof d.dependencyGraph !== "object") markCheck(check, "warning", "manifest missing dependencyGraph", "warnings");
  }

  return check;
}

function addCrossIndexWarnings(report) {
  const byName = new Map(report.checks.map((check) => [check.name, check]));
  const chunk = byName.get("chunk index");
  const pages = byName.get("pages cache");
  const sections = byName.get("sections index");
  const registers = byName.get("registers index");
  const bitfields = byName.get("bitfields index");
  const sequences = byName.get("sequences index");
  const cautions = byName.get("cautions index");

  if (chunk?.data && pages?.data && Number(chunk.data.pageCount) !== Number(pages.data.pageCount)) {
    markCheck(chunk, "warning", `cross-check: chunk index pageCount ${chunk.data.pageCount} != pages cache pageCount ${pages.data.pageCount}`, "warnings");
  }
  if (chunk?.data && sections?.data && Number(chunk.data.sectionCount || 0) !== Number(sections.data.sectionCount || 0)) {
    markCheck(chunk, "warning", `cross-check: section count differs (${chunk.data.sectionCount || 0} vs ${sections.data.sectionCount || 0})`, "warnings");
  }
  if (chunk?.data && registers?.data && Number(chunk.data.registerCount || 0) !== Number(registers.data.registerCount || 0)) {
    markCheck(chunk, "warning", `cross-check: register count differs (${chunk.data.registerCount || 0} vs ${registers.data.registerCount || 0})`, "warnings");
  }
  if (chunk?.data && bitfields?.data && Number(chunk.data.bitfieldCount || 0) !== Number(bitfields.data.bitfieldCount || 0)) {
    markCheck(chunk, "warning", `cross-check: bitfield count differs (${chunk.data.bitfieldCount || 0} vs ${bitfields.data.bitfieldCount || 0})`, "warnings");
  }
  if (chunk?.data && sequences?.data && Number(chunk.data.sequenceCount || 0) !== Number(sequences.data.sequenceCount || 0)) {
    markCheck(chunk, "warning", `cross-check: sequence count differs (${chunk.data.sequenceCount || 0} vs ${sequences.data.sequenceCount || 0})`, "warnings");
  }
  if (chunk?.data && cautions?.data && Number(chunk.data.cautionCount || 0) !== Number(cautions.data.cautionCount || 0)) {
    markCheck(chunk, "warning", `cross-check: caution count differs (${chunk.data.cautionCount || 0} vs ${cautions.data.cautionCount || 0})`, "warnings");
  }
}

function summarizeDoctorHealth(checks, strict = false) {
  const coreNames = new Set([
    "pdf file",
    "pdf readability",
    "artifact manifest",
    "chunk index",
    "pages cache",
    "sections index",
    "registers index",
    "bitfields index",
    "sequences index",
    "cautions index",
  ]);

  const coreChecks = checks.filter((check) => coreNames.has(check.name));
  const optionalChecks = checks.filter((check) => !coreNames.has(check.name));
  const coreMax = Math.max(...coreChecks.map((check) => check.severity), 0);
  const optionalMax = Math.max(...optionalChecks.map((check) => check.severity), 0);

  if (coreMax >= 2) return "fail";
  if (strict && optionalMax >= 2) return "fail";
  if (coreMax >= 1 || optionalMax >= 1) return "warn";
  return "ok";
}

async function doctorOnePdf(filename, options = {}) {
  const strict = Boolean(options.strict);
  const checks = [];
  let currentSource = null;
  let pageCount = null;

  try {
    const filePath = safePdfPath(filename);
    const stat = await getFileStat(filename);
    currentSource = await getPdfSourceInfo(filename);
    checks.push(doctorCheck("pdf file", "ok", {
      path: filePath,
      sizeBytes: stat.size,
      modified: stat.mtime.toISOString(),
    }));
  } catch (error) {
    checks.push(doctorCheck("pdf file", "error", {
      errors: [error instanceof Error ? error.message : String(error)],
    }));
    return {
      filename,
      createdAt: new Date().toISOString(),
      strict,
      health: "fail",
      checks,
      recommendations: [`Verify that ${filename} exists in the documents folder.`],
    };
  }

  try {
    pageCount = await getPdfPageCount(filename);
    checks.push(doctorCheck("pdf readability", "ok", { pageCount }));
  } catch (error) {
    checks.push(doctorCheck("pdf readability", "error", {
      errors: [error instanceof Error ? error.message : String(error)],
    }));
  }

  const lockInfo = await readIndexLock(filename);
  if (lockInfo) {
    const stale = isIndexLockStale(lockInfo);
    checks.push(doctorCheck("index build lock", stale ? "stale" : "warning", {
      path: safeIndexLockPath(filename),
      createdAt: lockInfo.createdAt || "unknown",
      pid: lockInfo.pid || "unknown",
      stale,
      recommendation: stale
        ? "Remove stale lock or run index_pdf with force_lock=true if no index build is running."
        : "Another index_pdf may be running. Wait until it finishes before rebuilding.",
    }));
  } else {
    checks.push(doctorCheck("index build lock", "ok", {
      path: safeIndexLockPath(filename),
      details: "no active lock",
    }));
  }

  const jsonSpecs = [
    ["artifact manifest", safeArtifactManifestPath(filename), ARTIFACT_MANIFEST_SCHEMA_VERSION, "artifact-manifest"],
    ["chunk index", safeIndexPath(filename), INDEX_SCHEMA_VERSION, "chunk-index"],
    ["pages cache", safePagesCachePath(filename), PAGE_CACHE_SCHEMA_VERSION, "pages"],
    ["sections index", safeSectionsIndexPath(filename), SECTION_INDEX_SCHEMA_VERSION, "sections"],
    ["registers index", safeRegistersIndexPath(filename), REGISTER_INDEX_SCHEMA_VERSION, "registers"],
    ["bitfields index", safeBitfieldsIndexPath(filename), BITFIELD_INDEX_SCHEMA_VERSION, "bitfields"],
    ["sequences index", safeSequencesIndexPath(filename), SEQUENCE_INDEX_SCHEMA_VERSION, "sequences"],
    ["cautions index", safeCautionsIndexPath(filename), CAUTION_INDEX_SCHEMA_VERSION, "cautions"],
    ["figures index", safeFiguresIndexPath(filename), FIGURE_INDEX_SCHEMA_VERSION, "figures"],
    ["visual evidence", safeVisualEvidencePath(filename), VISUAL_EVIDENCE_SCHEMA_VERSION, "visualEvidence", true],
    ["module profile", safeModuleProfileJsonPath(filename), MODULE_PROFILE_SCHEMA_VERSION, "module-profile"],
  ];

  for (const [name, filePath, schema, kind] of jsonSpecs) {
    let check = await readJsonForDoctor(filePath, schema, name);
    check = validateFilenameForDoctor(check, filename);
    check = validateShapeForDoctor(check, kind);
    if (currentSource && check.data) check = validateSourceForDoctor(check, currentSource, kind);

    if (kind === "module-profile" && check.status === "missing") {
      check.status = strict ? "missing" : "missing_optional";
      check.severity = doctorStatusSeverity(check.status);
    }

    if (kind === "figures" && check.status === "missing") {
      check.status = "missing_optional";
      check.severity = doctorStatusSeverity(check.status);
    }

    checks.push(check);
  }

  checks.push(await readTextArtifactForDoctor(safeModuleProfileTextPath(filename), "module profile text", !strict));
  checks.push(await readTextArtifactForDoctor(safeDriverPackPath(filename), "driver evidence pack", !strict));
  checks.push(await readTextArtifactForDoctor(safeDriverTaskPlanPath(filename), "driver task plan", true));

  const report = {
    filename,
    createdAt: new Date().toISOString(),
    strict,
    pageCount,
    manifest: await loadArtifactManifest(filename),
    checks,
    recommendations: [],
  };

  addCrossIndexWarnings(report);
  report.health = summarizeDoctorHealth(report.checks, strict);
  report.summary = summarizeDoctorChecks(report.checks);
  report.recommendations = buildDoctorRecommendations(report);

  return report;
}

function summarizeDoctorChecks(checks) {
  const summary = { ok: 0, warning: 0, missing: 0, stale: 0, incompatible: 0, broken: 0, error: 0, missing_optional: 0 };
  for (const check of checks || []) {
    summary[check.status] = (summary[check.status] || 0) + 1;
  }
  return summary;
}

function buildDoctorRecommendations(report) {
  const recommendations = [];
  const byName = new Map(report.checks.map((check) => [check.name, check]));
  const coreProblem = report.checks.some((check) => ["missing", "stale", "incompatible", "broken", "error"].includes(check.status) && !["module profile", "module profile text", "driver evidence pack", "driver evidence pack JSON", "driver evidence pack Markdown", "driver task plan", "driver task plan JSON", "driver task plan Markdown"].includes(check.name));

  if (coreProblem) {
    recommendations.push(`Run start_index_pdf(filename="${report.filename}", force=true) for large manuals, then poll job_status. For small manuals, index_pdf(filename="${report.filename}", mode="foreground", force=true) is also valid.`);
  }
  if (["missing", "missing_optional", "stale", "incompatible", "broken"].includes(byName.get("module profile")?.status)) {
    recommendations.push(`Run analyze_module(filename="${report.filename}") to rebuild the module profile.`);
  }
  if (["missing_optional", "missing", "broken"].includes(byName.get("driver evidence pack")?.status)) {
    recommendations.push(`Run build_driver_evidence_pack(filename="${report.filename}") before asking the agent to write/review driver code.`);
  }
  if (["missing_optional", "missing", "broken"].includes(byName.get("driver task plan")?.status)) {
    recommendations.push(`Run prepare_driver_task(filename="${report.filename}", task="<your driver task>") before a specific debug/feature task.`);
  }
  if (!recommendations.length) recommendations.push("No immediate action required. Index artifacts look usable.");
  return recommendations;
}

async function doctorPdfs(options = {}) {
  const filename = String(options.filename || "").trim();
  const files = filename ? [filename] : await listPdfFiles();
  const reports = [];

  for (const file of files) {
    reports.push(await doctorOnePdf(file, options));
  }

  return {
    createdAt: new Date().toISOString(),
    strict: Boolean(options.strict),
    checkedCount: reports.length,
    health: reports.some((r) => r.health === "fail") ? "fail" : reports.some((r) => r.health === "warn") ? "warn" : "ok",
    reports,
  };
}

function stripDoctorDataForOutput(check) {
  const { data, ...rest } = check;
  return rest;
}

function formatDoctorReport(result, options = {}) {
  const includeDetails = options.includeDetails !== false;
  const lines = [];

  lines.push("MCP Manual Server Doctor");
  lines.push(`Created: ${result.createdAt}`);
  lines.push(`Overall health: ${result.health.toUpperCase()}`);
  lines.push(`PDFs checked: ${result.checkedCount}`);
  lines.push(`Strict mode: ${result.strict ? "yes" : "no"}`);
  lines.push("");

  for (const report of result.reports || []) {
    lines.push(`## ${report.filename}`);
    lines.push(`Health: ${report.health.toUpperCase()}`);
    if (report.pageCount) lines.push(`Pages: ${report.pageCount}`);
    lines.push(formatManifestSummary(report.manifest));
    lines.push("Checks:");

    for (const check of report.checks || []) {
      lines.push(`- [${doctorStatusIcon(check.status)}] ${check.name}: ${check.status}`);
      if (check.path) lines.push(`  path: ${check.path}`);
      if (check.createdAt) lines.push(`  created: ${check.createdAt}`);
      if (check.sizeBytes !== undefined) lines.push(`  size: ${check.sizeBytes} bytes`);
      for (const warning of check.warnings || []) lines.push(`  warning: ${warning}`);
      for (const error of check.errors || []) lines.push(`  error: ${error}`);
    }

    lines.push("Recommendations:");
    for (const rec of report.recommendations || []) lines.push(`- ${rec}`);
    lines.push("");
  }

  const compact = {
    health: result.health,
    checkedCount: result.checkedCount,
    reports: (result.reports || []).map((report) => ({
      filename: report.filename,
      health: report.health,
      summary: report.summary,
      manifest: report.manifest ? {
        health: report.manifest.health,
        sourceFingerprint: report.manifest.source?.fingerprint,
        missingRequired: report.manifest.missingRequired,
      } : null,
      checks: includeDetails ? report.checks.map(stripDoctorDataForOutput) : undefined,
      recommendations: report.recommendations,
    })),
  };

  lines.push("Machine summary JSON:");
  lines.push(JSON.stringify(compact, null, 2));

  return lines.join("\n");
}

async function maybeWriteDoctorReports(result, writeReport) {
  if (!writeReport) return [];
  await fs.mkdir(INDEX_DIR, { recursive: true });
  const paths = [];
  for (const report of result.reports || []) {
    const single = {
      createdAt: result.createdAt,
      strict: result.strict,
      checkedCount: 1,
      health: report.health,
      reports: [report],
    };
    const filePath = safeDoctorReportPath(report.filename);
    const jsonPath = safeDoctorReportJsonPath(report.filename);
    const markdownPath = safeDoctorReportMarkdownPath(report.filename);
    const formatted = formatDoctorReport(single);
    await atomicWriteFile(filePath, formatted, "utf-8");
    await atomicWriteJson(jsonPath, single);
    await atomicWriteFile(markdownPath, formatted, "utf-8");
    paths.push(filePath, jsonPath, markdownPath);
  }
  return paths;
}


// -----------------------------------------------------------------------------
// Internal eval suite
// -----------------------------------------------------------------------------

function defaultEvalCases() {
  return {
    schemaVersion: EVAL_CASES_SCHEMA_VERSION,
    description: "Internal regression cases for the hardware-manual MCP server. Cases use assertions instead of exact golden output.",
    cases: [
      {
        id: "doctor-basic",
        description: "Doctor must report server/index health for the target PDF.",
        tool: "doctor",
        args: {},
        assertions: {
          mustContain: ["MCP Manual Server Doctor", "Overall health", "Machine summary JSON"],
          mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
        },
      },
      {
        id: "module-profile-basic",
        description: "Module profile should orient the agent before driver work.",
        tool: "get_module_profile",
        args: {},
        assertions: {
          mustContain: ["Module Profile", "Module identity", "Likely Linux subsystem", "Suggested MCP calls"],
          mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
        },
      },
      {
        id: "driver-pack-basic",
        description: "Driver evidence pack should include register groups, sequences, cautions, and checklist sections.",
        tool: "build_driver_evidence_pack",
        args: { module_type: "${module_type}" },
        assertions: {
          mustContain: ["Driver Evidence Pack", "Register groups", "Operation sequence candidates", "Caution / restriction candidates", "Driver implementation checklist"],
          mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
        },
      },
      {
        id: "prepare-driver-task-debug-start",
        description: "Driver-task workflow should force evidence collection before source edits.",
        tool: "prepare_driver_task",
        args: {
          task: "debug transfer does not start",
          module_type: "${module_type}",
        },
        assertions: {
          mustContain: ["Driver Task Preparation Plan", "Mandatory MCP call sequence", "Task-related registers", "Required source-code checks", "Approval rule"],
          mustContainAny: ["extract_bitfield_table", "get_cautions_for_register", "get_sequence"],
          mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
        },
      },
      {
        id: "hybrid-search-start",
        description: "Hybrid search should accept natural language without embeddings.",
        tool: "hybrid_search_pdf",
        args: {
          query: "how to start transfer operation",
          intent: "start",
          top_k: 5,
        },
        assertions: {
          mustContain: ["Hybrid search results", "Intent"],
          mustContainAny: ["Result 1", "No hybrid results found"],
          mustNotContain: ["Ollama", "embedding", "Unhandled", "TypeError", "ReferenceError"],
        },
      },
      {
        id: "hybrid-search-clear-caution",
        description: "Hybrid search should rank natural-language clear/caution queries without embeddings using BM25/proximity/synonym expansion.",
        tool: "hybrid_search_pdf",
        args: {
          query: "how to clear interrupt status and avoid reserved bit writes",
          intent: "caution",
          top_k: 5,
        },
        assertions: {
          mustContain: ["Hybrid search results", "Intent"],
          mustContainAny: ["bm25", "proximity", "symbol aliases", "No hybrid results found"],
          mustNotContain: ["Ollama", "embedding", "Unhandled", "TypeError", "ReferenceError"],
        },
      },
      {
        id: "chunk-type-stats-basic",
        description: "Step 23 chunkType/noise classification should be present after rebuilding the index.",
        tool: "chunk_type_stats",
        args: { include_examples: false },
        assertions: {
          mustContain: ["Chunk type statistics", "Types:", "Machine summary JSON"],
          mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
        },
      },
      {
        id: "register-table-basic",
        description: "Register table extraction should return a structured result or an actionable fallback.",
        tool: "extract_register_table",
        args: { top_k: 20 },
        assertions: {
          mustContainAny: ["Coordinate register table extraction", "No coordinate register table rows found"],
          mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
        },
      },
      {
        id: "verify-register-usage-basic",
        description: "verify_register_usage should produce a register-operation assessment with evidence contract.",
        tool: "verify_register_usage",
        args: {
          register: "${register}",
          operation: "verify source-code register write operation",
          access_type: "raw_write",
          intent: "write"
        },
        assertions: {
          mustContain: ["Register Usage Verification", "Assessment", "Machine-readable evidence contract"],
          mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
        },
        allowFail: true
      },
      {
        id: "compare-driver-requirements-basic",
        description: "compare_driver_requirements should map source-review features against a data-driven profile checklist.",
        tool: "compare_driver_requirements",
        args: {
          module_type: "${module_type}",
          implemented_features: ["MMIO resource mapping", "clock enable", "request IRQ"],
          source_observations: ["source review input is synthetic for eval"]
        },
        assertions: {
          mustContain: ["Driver Requirements Comparison", "Completeness candidate score", "Machine-readable evidence contract"],
          mustNotContain: ["Unhandled", "TypeError", "ReferenceError"]
        }
      },
      {
        id: "source-review-prompt-pack-basic",
        description: "source_review_prompt_pack should generate a VS Code agent workflow that chains checklist, comparison, and register verification.",
        tool: "source_review_prompt_pack",
        args: {
          module_type: "${module_type}",
          task: "evaluate driver completeness",
          source_files: ["driver.c", "board.dts"]
        },
        assertions: {
          mustContain: ["Source Review Prompt Pack", "Mandatory MCP workflow", "compare_driver_requirements", "verify_register_usage", "Machine-readable evidence contract"],
          mustNotContain: ["Unhandled", "TypeError", "ReferenceError"]
        }
      },
      {
        id: "index-validation-basic",
        description: "validate_index should run without rebuilding and produce machine summary.",
        tool: "validate_index",
        args: {},
        assertions: {
          mustContain: ["MCP Manual Server Doctor", "Machine summary JSON"],
          mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
        },
      },
    ],
  };
}

function defaultEvalProfiles() {
  return {
    generic: {
      schemaVersion: EVAL_PROFILE_SCHEMA_VERSION,
      type: "eval-profile",
      profile: "generic",
      description: "Generic eval cases that should apply to most hardware-manual modules.",
      cases: [
        {
          id: "profile-generic-checklist",
          description: "Data-driven checklist should work through the generic profile fallback.",
          tool: "driver_completeness_checklist",
          args: { subsystem: "${module_type}", task: "generic driver completeness review" },
          assertions: {
            mustContain: ["Driver Completeness Checklist", "Completeness matrix", "Recommended MCP workflow"],
            mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
          },
        },
        {
          id: "profile-generic-source-prompt",
          description: "Source-review prompt pack should produce an agent workflow for any module type.",
          tool: "source_review_prompt_pack",
          args: { module_type: "${module_type}", task: "review driver completeness", review_depth: "standard" },
          assertions: {
            mustContain: ["Source Review Prompt Pack", "Mandatory MCP workflow", "Required extraction schema"],
            mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
          },
        },
      ],
    },
    ethernet: {
      schemaVersion: EVAL_PROFILE_SCHEMA_VERSION,
      type: "eval-profile",
      profile: "ethernet",
      module_type: "ethernet",
      description: "Generic Ethernet/netdev review cases. Not tied to GBETH; GBETH can be a fixture.",
      cases: [
        {
          id: "profile-ethernet-checklist",
          when: { module_type: "ethernet" },
          description: "Ethernet checklist should include MAC/PHY/MDIO/IRQ-oriented review areas.",
          tool: "driver_completeness_checklist",
          args: { subsystem: "ethernet", task: "ethernet MAC driver completeness review" },
          assertions: {
            mustContain: ["Driver Completeness Checklist", "Completeness matrix"],
            mustContainAny: ["MAC", "PHY", "MDIO", "interrupt", "reset"],
            mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
          },
        },
        {
          id: "profile-ethernet-evidence-pack-adaptive",
          when: { module_type: "ethernet" },
          description: "Ethernet evidence pack should use adaptive mode and avoid timeout-prone full scans.",
          tool: "build_driver_evidence_pack",
          args: { module_type: "ethernet", focus: "MAC driver completeness review", mode: "adaptive", budget_ms: 20000, top_registers: 16, top_summaries: 4 },
          assertions: {
            mustContain: ["Driver Evidence Pack", "Build mode"],
            mustNotContain: ["Request timed out", "Unhandled", "TypeError", "ReferenceError"],
          },
        },
      ],
    },
    dmaengine: {
      schemaVersion: EVAL_PROFILE_SCHEMA_VERSION,
      type: "eval-profile",
      profile: "dmaengine",
      module_type: "dmaengine",
      description: "Generic DMAEngine/manual review cases. Not tied to one DMA manual.",
      cases: [
        {
          id: "profile-dmaengine-checklist",
          when: { module_type: "dmaengine" },
          description: "DMAEngine checklist should be generated through external profile fallback.",
          tool: "driver_completeness_checklist",
          args: { subsystem: "dmaengine", task: "DMAEngine driver completeness review" },
          assertions: {
            mustContain: ["Driver Completeness Checklist", "Completeness matrix"],
            mustContainAny: ["DMA", "channel", "transfer", "interrupt", "descriptor"],
            mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
          },
        },
        {
          id: "profile-dmaengine-transfer-search",
          when: { module_type: "dmaengine" },
          description: "Natural-language DMA transfer start search should not require embeddings.",
          tool: "hybrid_search_pdf",
          args: { query: "how to start DMA transfer and check completion status", intent: "start", top_k: 5 },
          assertions: {
            mustContain: ["Hybrid search results", "Intent"],
            mustContainAny: ["Result 1", "No hybrid results found"],
            mustNotContain: ["Ollama", "embedding", "Unhandled", "TypeError", "ReferenceError"],
          },
        },
      ],
    },
    watchdog: {
      schemaVersion: EVAL_PROFILE_SCHEMA_VERSION,
      type: "eval-profile",
      profile: "watchdog",
      module_type: "watchdog",
      description: "Generic watchdog/WDT review cases.",
      cases: [
        {
          id: "profile-watchdog-checklist",
          when: { module_type: "watchdog" },
          description: "Watchdog checklist should be generated through external profile fallback.",
          tool: "driver_completeness_checklist",
          args: { subsystem: "watchdog", task: "watchdog driver completeness review" },
          assertions: {
            mustContain: ["Driver Completeness Checklist", "Completeness matrix"],
            mustContainAny: ["watchdog", "timeout", "reset", "clock", "restart"],
            mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
          },
        },
        {
          id: "profile-watchdog-timeout-search",
          when: { module_type: "watchdog" },
          description: "Watchdog timeout/reset semantics should be discoverable with hybrid search.",
          tool: "hybrid_search_pdf",
          args: { query: "watchdog timeout clock reset restart sequence", intent: "reset", top_k: 5 },
          assertions: {
            mustContain: ["Hybrid search results", "Intent"],
            mustContainAny: ["Result 1", "No hybrid results found"],
            mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
          },
        },
      ],
    },
    pwm: {
      schemaVersion: EVAL_PROFILE_SCHEMA_VERSION,
      type: "eval-profile",
      profile: "pwm",
      module_type: "pwm",
      description: "Generic PWM/timer review cases.",
      cases: [
        {
          id: "profile-pwm-checklist",
          when: { module_type: "pwm" },
          description: "PWM checklist should be generated through external profile fallback.",
          tool: "driver_completeness_checklist",
          args: { subsystem: "pwm", task: "PWM driver completeness review" },
          assertions: {
            mustContain: ["Driver Completeness Checklist", "Completeness matrix"],
            mustContainAny: ["PWM", "period", "duty", "polarity", "capture", "timer"],
            mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
          },
        },
        {
          id: "profile-pwm-start-stop-search",
          when: { module_type: "pwm" },
          description: "PWM/timer start/stop sequence should be discoverable with hybrid search.",
          tool: "hybrid_search_pdf",
          args: { query: "PWM timer start stop output enable sequence", intent: "start", top_k: 5 },
          assertions: {
            mustContain: ["Hybrid search results", "Intent"],
            mustContainAny: ["Result 1", "No hybrid results found"],
            mustNotContain: ["Unhandled", "TypeError", "ReferenceError"],
          },
        },
      ],
    },
  };
}

function defaultEvalFixtures() {
  return {
    "gbeth-smoke": {
      schemaVersion: EVAL_FIXTURE_SCHEMA_VERSION,
      type: "eval-fixture",
      enabled: false,
      fixture: "gbeth-smoke",
      description: "Optional fixture template for a real GBETH.pdf manual. Disabled by default; enable locally when GBETH.pdf exists.",
      when: { filename: "GBETH.pdf", module_type: "ethernet" },
      cases: [
        {
          id: "fixture-gbeth-no-timeout-driver-pack",
          description: "GBETH adaptive evidence pack should return instead of timing out.",
          tool: "build_driver_evidence_pack",
          args: { module_type: "ethernet", focus: "Linux MAC driver completeness review for Renesas GBETH / stmmac glue", mode: "adaptive", budget_ms: 25000, top_registers: 20, top_summaries: 8 },
          assertions: { mustContain: ["Driver Evidence Pack", "Build mode"], mustNotContain: ["Request timed out", "Unhandled", "TypeError", "ReferenceError"] },
        },
        {
          id: "fixture-gbeth-register-anchor",
          description: "GBETH fixture should locate an Ethernet MAC-related register anchor.",
          tool: "find_register",
          args: { register: "MACCR", top_k: 5 },
          assertions: { mustContainAny: ["MACCR", "MAC", "Register"], mustNotContain: ["Unhandled", "TypeError", "ReferenceError"] },
          allowFail: true,
        },
      ],
    },
    "dma-smoke": {
      schemaVersion: EVAL_FIXTURE_SCHEMA_VERSION,
      type: "eval-fixture",
      enabled: false,
      fixture: "dma-smoke",
      description: "Optional fixture template for a real DMA manual. Disabled by default.",
      when: { module_type: "dmaengine" },
      cases: [
        {
          id: "fixture-dma-channel-register-discovery",
          description: "DMA fixture should surface channel/control/status register anchors.",
          tool: "hybrid_search_pdf",
          args: { query: "DMA channel control status transfer start complete", intent: "register", top_k: 8 },
          assertions: { mustContain: ["Hybrid search results"], mustContainAny: ["CH", "channel", "transfer", "Result 1"], mustNotContain: ["Unhandled", "TypeError", "ReferenceError"] },
          allowFail: true,
        },
      ],
    },
    "wdt-smoke": {
      schemaVersion: EVAL_FIXTURE_SCHEMA_VERSION,
      type: "eval-fixture",
      enabled: false,
      fixture: "wdt-smoke",
      description: "Optional fixture template for a real WDT/watchdog manual. Disabled by default.",
      when: { module_type: "watchdog" },
      cases: [
        {
          id: "fixture-wdt-timeout-reset",
          description: "WDT fixture should surface timeout/reset sequence anchors.",
          tool: "hybrid_search_pdf",
          args: { query: "watchdog timeout reset clock counter restart", intent: "reset", top_k: 8 },
          assertions: { mustContain: ["Hybrid search results"], mustContainAny: ["timeout", "reset", "watchdog", "Result 1"], mustNotContain: ["Unhandled", "TypeError", "ReferenceError"] },
          allowFail: true,
        },
      ],
    },
    "gpt-smoke": {
      schemaVersion: EVAL_FIXTURE_SCHEMA_VERSION,
      type: "eval-fixture",
      enabled: false,
      fixture: "gpt-smoke",
      description: "Optional fixture template for a real GPT/PWM manual. Disabled by default.",
      when: { module_type: "pwm" },
      cases: [
        {
          id: "fixture-gpt-pwm-sequence",
          description: "GPT/PWM fixture should surface start/output/capture sequence anchors.",
          tool: "hybrid_search_pdf",
          args: { query: "GPT PWM output compare capture start stop sequence", intent: "start", top_k: 8 },
          assertions: { mustContain: ["Hybrid search results"], mustContainAny: ["PWM", "GPT", "output", "capture", "Result 1"], mustNotContain: ["Unhandled", "TypeError", "ReferenceError"] },
          allowFail: true,
        },
      ],
    },
  };
}

async function ensureDefaultEvalProfileFiles(createDefault = true) {
  await fs.mkdir(EVAL_PROFILES_DIR, { recursive: true });
  if (!createDefault) return [];
  const written = [];
  for (const [name, data] of Object.entries(defaultEvalProfiles())) {
    const filePath = safeEvalProfilePath(name);
    if (!(await pathExists(filePath))) {
      await atomicWriteFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      written.push(filePath);
    }
  }
  return written;
}

async function ensureDefaultEvalFixtureFiles(createDefault = true) {
  await fs.mkdir(EVAL_FIXTURES_DIR, { recursive: true });
  if (!createDefault) return [];
  const written = [];
  for (const [name, data] of Object.entries(defaultEvalFixtures())) {
    const filePath = safeEvalFixturePath(name);
    if (!(await pathExists(filePath))) {
      await atomicWriteFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      written.push(filePath);
    }
  }
  return written;
}

async function readEvalJsonFile(filePath, expectedSchemaVersion, sourceLabel) {
  const raw = await fs.readFile(filePath, "utf-8");
  const data = JSON.parse(raw);
  if (data.schemaVersion !== expectedSchemaVersion) {
    throw new Error(`${sourceLabel} schema mismatch: expected ${expectedSchemaVersion}, got ${data.schemaVersion ?? "unknown"}`);
  }
  if (!Array.isArray(data.cases)) throw new Error(`${sourceLabel} must contain a cases array`);
  return data;
}

async function listEvalProfileFiles() {
  await fs.mkdir(EVAL_PROFILES_DIR, { recursive: true });
  const files = await fs.readdir(EVAL_PROFILES_DIR);
  return files.filter((file) => file.toLowerCase().endsWith(".json")).sort((a, b) => a.localeCompare(b));
}

async function listEvalFixtureFiles() {
  await fs.mkdir(EVAL_FIXTURES_DIR, { recursive: true });
  const files = await fs.readdir(EVAL_FIXTURES_DIR);
  return files.filter((file) => file.toLowerCase().endsWith(".json")).sort((a, b) => a.localeCompare(b));
}

function annotateEvalCases(cases, source, meta = {}) {
  return (cases || []).map((testCase) => ({
    ...testCase,
    source,
    sourceMeta: meta,
  }));
}

function normalizeEvalScope(value) {
  const scope = String(value || "all").trim().toLowerCase();
  return ["all", "generic", "profiles", "fixtures"].includes(scope) ? scope : "all";
}

function evalCaseAppliesToRuntime(testCase, runtime, options = {}) {
  const when = testCase.when || testCase.sourceMeta?.when || {};
  if (testCase.sourceMeta?.enabled === false && !options.includeDisabled && !options.explicitFixture) return false;

  if (when.filename && String(when.filename).toLowerCase() !== String(runtime.filename || "").toLowerCase()) return false;

  const requiredModule = normalizeDriverProfileHint(when.module_type || when.moduleType || "");
  const runtimeModule = normalizeDriverProfileHint(runtime.moduleType || "");
  if (requiredModule && runtimeModule && requiredModule !== runtimeModule) return false;
  if (requiredModule && !runtimeModule) return false;

  const requiredProfile = sanitizeDriverProfileName(when.profile || "");
  const runtimeProfile = sanitizeDriverProfileName(runtime.evalProfile || runtime.moduleType || "");
  if (requiredProfile && runtimeProfile && requiredProfile !== runtimeProfile) return false;

  return true;
}

function uniqueEvalCases(cases) {
  const seen = new Set();
  const unique = [];
  for (const testCase of cases || []) {
    const key = `${testCase.source || "unknown"}:${testCase.id || "unnamed"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(testCase);
  }
  return unique;
}

async function loadEvalCasesFromFiles(options = {}) {
  const createDefault = options.createDefault !== false;
  const scope = normalizeEvalScope(options.scope);
  const moduleType = normalizeDriverProfileHint(options.moduleType || "");
  const evalProfile = sanitizeDriverProfileName(options.evalProfile || moduleType || "generic");
  const explicitFixture = String(options.fixture || "").trim();
  const includeProfiles = options.includeProfiles !== false;
  const includeFixtures = options.includeFixtures !== false;
  const includeDisabled = Boolean(options.includeDisabled);

  await ensureEvalCasesFile(createDefault);
  await ensureDefaultEvalProfileFiles(createDefault);
  await ensureDefaultEvalFixtureFiles(createDefault);

  const sources = [];
  const merged = {
    schemaVersion: EVAL_CASES_SCHEMA_VERSION,
    description: "Merged data-driven eval cases from eval/manual-cases.json, eval/profiles/*.json, and optional eval/fixtures/*.json.",
    cases: [],
    sources,
  };

  if (scope === "all" || scope === "generic") {
    const casesPath = safeEvalCasesPath();
    if (await pathExists(casesPath)) {
      const data = await readEvalJsonFile(casesPath, EVAL_CASES_SCHEMA_VERSION, "eval/manual-cases.json");
      merged.cases.push(...annotateEvalCases(data.cases, "manual-cases", { path: casesPath }));
      sources.push({ type: "generic", path: casesPath, cases: data.cases.length });
    }
  }

  if (includeProfiles && (scope === "all" || scope === "profiles")) {
    const profileNames = new Set();
    if (scope === "profiles" && !options.moduleType && !options.evalProfile) {
      for (const file of await listEvalProfileFiles()) profileNames.add(path.basename(file, ".json"));
    } else {
      profileNames.add("generic");
      if (moduleType) profileNames.add(moduleType);
      if (evalProfile) profileNames.add(evalProfile);
    }

    for (const profileName of profileNames) {
      const profilePath = safeEvalProfilePath(profileName);
      if (!(await pathExists(profilePath))) continue;
      const data = await readEvalJsonFile(profilePath, EVAL_PROFILE_SCHEMA_VERSION, `eval profile ${profileName}`);
      const meta = { path: profilePath, profile: data.profile || profileName, moduleType: data.module_type || "", when: data.when || {} };
      merged.cases.push(...annotateEvalCases(data.cases, `profile:${profileName}`, meta));
      sources.push({ type: "profile", profile: profileName, path: profilePath, cases: data.cases.length });
    }
  }

  if (includeFixtures && (scope === "all" || scope === "fixtures")) {
    const fixtureFiles = [];
    if (explicitFixture) fixtureFiles.push(`${sanitizeDriverProfileName(explicitFixture)}.json`);
    else fixtureFiles.push(...await listEvalFixtureFiles());

    for (const file of fixtureFiles) {
      const fixtureName = path.basename(file, ".json");
      const fixturePath = safeEvalFixturePath(fixtureName);
      if (!(await pathExists(fixturePath))) continue;
      const data = await readEvalJsonFile(fixturePath, EVAL_FIXTURE_SCHEMA_VERSION, `eval fixture ${fixtureName}`);
      const enabled = data.enabled !== false;
      if (!enabled && !includeDisabled && !explicitFixture) {
        sources.push({ type: "fixture", fixture: fixtureName, path: fixturePath, cases: data.cases.length, enabled: false, skipped: true });
        continue;
      }
      const meta = { path: fixturePath, fixture: data.fixture || fixtureName, enabled, when: data.when || {} };
      merged.cases.push(...annotateEvalCases(data.cases, `fixture:${fixtureName}`, meta));
      sources.push({ type: "fixture", fixture: fixtureName, path: fixturePath, cases: data.cases.length, enabled });
    }
  }

  merged.cases = uniqueEvalCases(merged.cases);
  return merged;
}

async function ensureEvalCasesFile(createDefault = true) {
  await fs.mkdir(EVAL_DIR, { recursive: true });
  await fs.mkdir(RENDERS_DIR, { recursive: true });
  await fs.mkdir(EVAL_PROFILES_DIR, { recursive: true });
  await fs.mkdir(EVAL_FIXTURES_DIR, { recursive: true });
  await fs.mkdir(DRIVER_PROFILES_DIR, { recursive: true });
  const casesPath = safeEvalCasesPath();

  if (!(await pathExists(casesPath))) {
    if (!createDefault) return null;
    await atomicWriteFile(casesPath, JSON.stringify(defaultEvalCases(), null, 2), "utf-8");
  }

  return casesPath;
}

async function loadEvalCases(options = {}) {
  return loadEvalCasesFromFiles(options);
}

function materializeEvalArgs(args, runtime) {
  const text = JSON.stringify(args || {});
  const materialized = text
    .replaceAll("${filename}", runtime.filename || "")
    .replaceAll("${module_type}", runtime.moduleType || "")
    .replaceAll("${eval_profile}", runtime.evalProfile || "")
    .replaceAll("${driver_family}", runtime.driverFamily || "")
    .replaceAll("${task}", runtime.task || "");
  return JSON.parse(materialized);
}

function evalAssertText(output, assertions = {}) {
  const text = String(output || "");
  const failures = [];

  for (const needle of assertions.mustContain || []) {
    if (!text.includes(needle)) failures.push(`missing required text: ${needle}`);
  }

  if (Array.isArray(assertions.mustContainAny) && assertions.mustContainAny.length) {
    if (!assertions.mustContainAny.some((needle) => text.includes(needle))) {
      failures.push(`missing any required alternative: ${assertions.mustContainAny.join(" | ")}`);
    }
  }

  for (const needle of assertions.mustNotContain || []) {
    if (text.includes(needle)) failures.push(`forbidden text present: ${needle}`);
  }

  if (Number.isFinite(Number(assertions.minLength)) && text.length < Number(assertions.minLength)) {
    failures.push(`output length ${text.length} < minLength ${assertions.minLength}`);
  }

  if (Number.isFinite(Number(assertions.maxLength)) && text.length > Number(assertions.maxLength)) {
    failures.push(`output length ${text.length} > maxLength ${assertions.maxLength}`);
  }

  return failures;
}

async function executeEvalCaseTool(tool, args, runtime) {
  const filename = args.filename || runtime.filename;

  if (tool === "doctor" || tool === "validate_index") {
    const result = await doctorPdfs({ filename, strict: Boolean(args.strict) });
    return formatDoctorReport(result, { includeDetails: true });
  }

  if (tool === "get_module_profile") {
    const profile = await getModuleProfile(filename, {
      moduleType: String(args.module_type || runtime.moduleType || "").trim(),
      focus: String(args.focus || "").trim(),
      refresh: Boolean(args.refresh),
    });
    return formatModuleProfile(profile);
  }

  if (tool === "build_driver_evidence_pack") {
    const pack = await buildDriverEvidencePack(filename, {
      moduleType: String(args.module_type || runtime.moduleType || "").trim(),
      focus: String(args.focus || "").trim(),
      mode: String(args.mode || "adaptive").trim(),
      budgetMs: args.budget_ms,
      topRegisters: args.top_registers,
      topSummaries: args.top_summaries,
    });
    return formatDriverEvidencePack(pack);
  }

  if (tool === "prepare_driver_task") {
    const task = String(args.task || runtime.task || "debug driver task").trim();
    const plan = await buildDriverTaskPlan(filename, {
      task,
      moduleType: String(args.module_type || runtime.moduleType || "").trim(),
      focusRegisters: normalizeStringArray(args.focus_registers),
      focusBitfields: normalizeStringArray(args.focus_bitfields),
      topRegisters: args.top_registers,
    });
    return formatDriverTaskPlan(plan);
  }

  if (tool === "plan_manual_workflow") {
    const plan = await buildManualWorkflowPlan({
      ...args,
      filename,
      task: String(args.task || runtime.task || "driver/manual workflow").trim(),
      module_type: String(args.module_type || runtime.moduleType || "").trim(),
      driver_family: String(args.driver_family || runtime.driverFamily || "").trim(),
    });
    return formatManualWorkflowPlan(plan);
  }

  if (tool === "eval_health_check") {
    const report = await runEvalHealthCheck({ ...args, write_report: false });
    return formatEvalHealthReport(report);
  }

  if (tool === "hybrid_search_pdf") {
    const payload = await hybridSearchPdf(filename, String(args.query || runtime.task || "operation sequence"), {
      register: String(args.register || "").trim(),
      intent: String(args.intent || "auto").trim() || "auto",
      topK: args.top_k,
    });
    return formatHybridSearchResults(payload);
  }

  if (tool === "extract_register_table") {
    const table = await extractRegisterTable(filename, {
      startPage: args.start_page,
      endPage: args.end_page,
      filter: String(args.filter || "").trim(),
      topK: args.top_k,
    });
    return formatExtractedRegisterTable(table);
  }

  if (tool === "extract_bitfield_table") {
    const register = String(args.register || "").trim();
    if (!register) return "SKIP: extract_bitfield_table requires args.register in eval case";
    const table = await extractBitfieldTable(filename, register, { topK: args.top_k });
    return formatExtractedBitfieldTable(table);
  }

  if (tool === "chunk_type_stats") {
    const stats = await getChunkTypeStats(filename, { includeExamples: args.include_examples !== false });
    return formatChunkTypeStats(stats);
  }

  if (tool === "list_registers") {
    const { registerIndex, results } = await listRegistersFromIndex(filename, {
      filter: String(args.filter || "").trim(),
      topK: args.top_k,
      includeLowConfidence: Boolean(args.include_low_confidence),
    });
    return formatRegisterListResults(registerIndex, results, String(args.filter || "").trim());
  }

  if (tool === "list_sequences") {
    const { sequencesIndex, results } = await listSequencesFromIndex(filename, {
      filter: String(args.filter || "").trim(),
      topK: args.top_k,
    });
    return formatSequenceListResults(sequencesIndex, results, String(args.filter || "").trim());
  }

  if (tool === "list_cautions") {
    const { cautionsIndex, results } = await listCautionsFromIndex(filename, {
      filter: String(args.filter || "").trim(),
      register: String(args.register || "").trim(),
      type: String(args.type || "").trim(),
      topK: args.top_k,
    });
    return formatPersistentCautionList(cautionsIndex, results, {
      filter: String(args.filter || "").trim(),
      register: String(args.register || "").trim(),
      type: String(args.type || "").trim(),
    });
  }

  if (tool === "driver_completeness_checklist") {
    const checklist = await buildDriverCompletenessChecklist(filename, {
      subsystem: String(args.subsystem || args.module_type || runtime.moduleType || "").trim(),
      driverFamily: String(args.driver_family || runtime.driverFamily || "").trim(),
      profile: String(args.profile || runtime.evalProfile || "").trim(),
      task: String(args.task || runtime.task || "driver completeness checklist").trim(),
      createDefault: args.create_default !== false,
    });
    return formatDriverCompletenessChecklist(checklist);
  }

  if (tool === "find_register") {
    const register = String(args.register || "").trim();
    if (!register) return "SKIP: find_register requires args.register in eval case";
    const topK = clampTopK(args.top_k);
    const indexed = await searchRegistersIndex(filename, register, topK);
    if (indexed.results.length) {
      return formatRegisterIndexResults(indexed.registerIndex, indexed.results, register);
    }
    const result = await multiQuerySearch(filename, buildRegisterQueries(register), topK);
    return formatSearchResults(result);
  }

  if (tool === "compare_driver_requirements") {
    const comparison = await compareDriverRequirements(filename, {
      subsystem: String(args.subsystem || args.module_type || runtime.moduleType || "").trim(),
      driverFamily: String(args.driver_family || "").trim(),
      profile: String(args.profile || "").trim(),
      task: String(args.task || runtime.task || "driver completeness comparison").trim(),
      sourceFiles: normalizeStringArray(args.source_files),
      sourceSummary: String(args.source_summary || ""),
      implementedFeatures: normalizeStringArray(args.implemented_features),
      sourceObservations: normalizeStringArray(args.source_observations),
      missingFeatures: normalizeStringArray(args.missing_features),
      registerOperations: Array.isArray(args.register_operations) ? args.register_operations : [],
    });
    return formatCompareDriverRequirements(comparison);
  }

  if (tool === "source_review_prompt_pack") {
    const pack = await buildSourceReviewPromptPack(filename, {
      subsystem: String(args.subsystem || args.module_type || runtime.moduleType || "").trim(),
      driverFamily: String(args.driver_family || "").trim(),
      profile: String(args.profile || "").trim(),
      task: String(args.task || runtime.task || "driver source review").trim(),
      sourceFiles: normalizeStringArray(args.source_files),
      reviewDepth: String(args.review_depth || "standard").trim(),
      outputFormat: String(args.output_format || "report").trim(),
      createDefault: args.create_default !== false,
    });
    return formatSourceReviewPromptPack(pack);
  }

  if (tool === "verify_register_usage") {
    let register = String(args.register || "").trim();
    if (!register || register === "${register}") {
      try {
        const { results } = await listRegistersFromIndex(filename, { topK: 1, includeLowConfidence: true });
        register = (results[0] && (results[0].displayName || results[0].name)) || "";
      } catch {
        register = "";
      }
    }
    if (!register) return "SKIP: verify_register_usage requires at least one detected register";
    const verification = await verifyRegisterUsage(filename, {
      register,
      operation: String(args.operation || "verify source-code register operation"),
      bitfields: normalizeStringArray(args.bitfields),
      accessType: String(args.access_type || "auto"),
      intent: String(args.intent || "auto"),
      sourceSnippet: String(args.source_snippet || ""),
      topK: args.top_k,
    });
    return formatVerifyRegisterUsage(verification);
  }

  return `SKIP: unsupported eval tool "${tool}"`;
}

async function maybeAutoIndexForEval(filename, autoIndex) {
  if (!autoIndex) return { autoIndexed: false, reason: "auto_index disabled" };

  const report = await doctorOnePdf(filename, { strict: false });
  const coreNames = new Set(["chunk index", "pages cache", "sections index", "registers index", "bitfields index", "sequences index", "cautions index"]);
  const coreProblem = (report.checks || []).some((check) => coreNames.has(check.name) && check.severity >= 2);
  if (!coreProblem) return { autoIndexed: false, reason: "core indexes already usable" };

  await buildPdfIndex(filename, { force: true, forceLock: false });
  return { autoIndexed: true, reason: "rebuilt missing/broken core indexes" };
}

async function runEvalSuite(options = {}) {
  const files = await listPdfFiles();
  const filename = String(options.filename || files[0] || "").trim();
  if (!filename) throw new Error("run_eval requires a filename or at least one PDF in the documents folder");

  const moduleType = String(options.moduleType || "").trim();
  const evalProfile = String(options.evalProfile || moduleType || "").trim();
  const driverFamily = String(options.driverFamily || "").trim();
  const caseId = String(options.caseId || "").trim();
  const runtime = {
    filename,
    moduleType,
    evalProfile,
    driverFamily,
    task: String(options.task || "debug driver task").trim(),
  };
  const evalData = await loadEvalCases({
    createDefault: options.createDefault !== false,
    moduleType,
    evalProfile,
    includeProfiles: options.includeProfiles !== false,
    includeFixtures: options.includeFixtures !== false,
    fixture: options.fixture,
    scope: options.scope || "all",
    includeDisabled: false,
  });
  const cases = (evalData.cases || [])
    .filter((testCase) => !caseId || testCase.id === caseId)
    .filter((testCase) => evalCaseAppliesToRuntime(testCase, runtime, {
      includeDisabled: false,
      explicitFixture: Boolean(options.fixture),
    }))
    .slice(0, MAX_EVAL_CASES);
  if (caseId && !cases.length) throw new Error(`No eval case found with id ${caseId}`);

  const autoIndexResult = await maybeAutoIndexForEval(filename, Boolean(options.autoIndex));
  const results = [];

  for (const testCase of cases) {
    const startedAt = Date.now();
    let output = "";
    let status = "pass";
    let failures = [];
    let error = null;

    try {
      const args = materializeEvalArgs(testCase.args || {}, runtime);
      if (!args.filename) args.filename = filename;
      output = await executeEvalCaseTool(testCase.tool, args, runtime);
      failures = evalAssertText(output, testCase.assertions || {});
      if (String(output).startsWith("SKIP:")) status = "skip";
      else if (failures.length) status = testCase.allowFail ? "xfail" : "fail";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = testCase.allowFail ? "xfail" : "fail";
      failures = [error];
    }

    results.push({
      id: testCase.id,
      description: testCase.description || "",
      tool: testCase.tool,
      source: testCase.source || "manual-cases",
      status,
      durationMs: Date.now() - startedAt,
      failures,
      error,
      outputPreview: String(output || "").slice(0, 1200),
    });
  }

  const summary = {
    total: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    skip: results.filter((r) => r.status === "skip").length,
    xfail: results.filter((r) => r.status === "xfail").length,
  };
  const includeGolden = Boolean(options.includeGolden);
  const golden = includeGolden
    ? await evaluateGoldenProfile({
        root: __dirname,
        profile: String(options.goldenProfile || DEFAULT_GOLDEN_PROFILE).trim() || DEFAULT_GOLDEN_PROFILE,
        strictVerifiedOnly: options.strictVerifiedOnly !== false,
      })
    : null;

  return {
    schemaVersion: EVAL_CASES_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    createdAt: new Date().toISOString(),
    filename,
    moduleType,
    evalProfile,
    driverFamily,
    evalSources: evalData.sources || [],
    caseId: caseId || null,
    autoIndex: Boolean(options.autoIndex),
    autoIndexResult,
    includeGolden,
    goldenProfile: includeGolden ? golden.profile : null,
    health: summary.fail || golden?.health === "fail" ? "fail" : "pass",
    summary,
    golden,
    results,
  };
}

function formatEvalCases(evalData, caseId = "") {
  const cases = (evalData.cases || []).filter((testCase) => !caseId || testCase.id === caseId);
  const lines = ["MCP Internal Eval Cases", `Schema version: ${evalData.schemaVersion}`, `Cases: ${cases.length}`, ""];

  if (Array.isArray(evalData.sources) && evalData.sources.length) {
    lines.push("Sources:");
    for (const source of evalData.sources) {
      lines.push(`- ${source.type}${source.profile ? `:${source.profile}` : ""}${source.fixture ? `:${source.fixture}` : ""}: cases=${source.cases}${source.enabled === false ? ", disabled" : ""}${source.skipped ? ", skipped" : ""}`);
    }
    lines.push("");
  }

  if (!cases.length) {
    lines.push(caseId ? `No case found with id ${caseId}` : "No eval cases found.");
    return lines.join("\n");
  }

  for (const testCase of cases) {
    lines.push(`- ${testCase.id}`);
    lines.push(`  tool: ${testCase.tool}`);
    if (testCase.source) lines.push(`  source: ${testCase.source}`);
    if (testCase.when || testCase.sourceMeta?.when) lines.push(`  when: ${JSON.stringify(testCase.when || testCase.sourceMeta?.when)}`);
    if (testCase.description) lines.push(`  description: ${testCase.description}`);
    const mustContain = testCase.assertions && testCase.assertions.mustContain || [];
    const any = testCase.assertions && testCase.assertions.mustContainAny || [];
    if (mustContain.length) lines.push(`  mustContain: ${mustContain.join(" | ")}`);
    if (any.length) lines.push(`  mustContainAny: ${any.join(" | ")}`);
    lines.push("");
  }

  lines.push(`Eval cases file: ${safeEvalCasesPath()}`);
  return lines.join("\n");
}

function formatEvalReport(report) {
  const lines = [
    "MCP Internal Eval Report",
    `Created: ${report.createdAt}`,
    `Server version: ${report.serverVersion}`,
    `File: ${report.filename}`,
    `Module type: ${report.moduleType || "not provided"}`,
    `Eval profile: ${report.evalProfile || "not provided"}`,
    `Driver family: ${report.driverFamily || "not provided"}`,
    `Case filter: ${report.caseId || "none"}`,
    `Health: ${report.health.toUpperCase()}`,
    `Auto index: ${report.autoIndex ? "yes" : "no"} (${report.autoIndexResult.reason})`,
    "",
    `Summary: total=${report.summary.total}, pass=${report.summary.pass}, fail=${report.summary.fail}, skip=${report.summary.skip}, xfail=${report.summary.xfail}`,
    "",
  ];

  if (Array.isArray(report.evalSources) && report.evalSources.length) {
    lines.push("Eval sources:");
    for (const source of report.evalSources) {
      lines.push(`- ${source.type}${source.profile ? `:${source.profile}` : ""}${source.fixture ? `:${source.fixture}` : ""}: cases=${source.cases}${source.enabled === false ? ", disabled" : ""}${source.skipped ? ", skipped" : ""}`);
    }
    lines.push("");
  }

  for (const result of report.results || []) {
    lines.push(`## ${result.id}`);
    lines.push(`Tool: ${result.tool}`);
    if (result.source) lines.push(`Source: ${result.source}`);
    if (result.description) lines.push(`Description: ${result.description}`);
    lines.push(`Status: ${result.status.toUpperCase()}`);
    lines.push(`Duration: ${result.durationMs} ms`);
    if (result.failures && result.failures.length) {
      lines.push("Failures:");
      for (const failure of result.failures) lines.push(`- ${failure}`);
    }
    lines.push("Output preview:");
    lines.push(result.outputPreview || "<empty>");
    lines.push("");
  }

  if (report.golden) {
    lines.push("## Golden Accuracy");
    lines.push(formatGoldenReport(report.golden));
    lines.push("");
  }

  lines.push("Machine summary JSON:");
  lines.push(JSON.stringify({
    health: report.health,
    summary: report.summary,
    golden: report.golden ? {
      health: report.golden.health,
      summary: report.golden.summary,
      missingArtifacts: report.golden.missingArtifacts || [],
    } : null,
    failures: (report.results || []).filter((r) => r.status === "fail").map((r) => ({ id: r.id, failures: r.failures })),
  }, null, 2));

  return lines.join("\n");
}

async function maybeWriteEvalReport(report, writeReport = true) {
  if (!writeReport) return [];
  const textPath = safeEvalReportTextPath(report.filename);
  const jsonPath = safeEvalReportJsonPath(report.filename);
  const markdownPath = safeEvalReportMarkdownPath(report.filename);
  const formatted = formatEvalReport(report);
  await atomicWriteFile(textPath, formatted, "utf-8");
  await atomicWriteFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  await atomicWriteFile(markdownPath, formatted, "utf-8");
  return [textPath, jsonPath, markdownPath];
}

async function listPdfFiles() {
  await fs.mkdir(DOCUMENTS_DIR, { recursive: true });
  const files = await fs.readdir(DOCUMENTS_DIR);

  return files
    .filter((file) => file.toLowerCase().endsWith(".pdf"))
    .sort((a, b) => a.localeCompare(b));
}

async function getFileStat(filename) {
  const filePath = safePdfPath(filename);

  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        `PDF not found: ${filename}. Put it in the documents folder: ${DOCUMENTS_DIR}`
      );
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// PDF extraction
// -----------------------------------------------------------------------------

async function loadPdfDocument(filename) {
  const filePath = safePdfPath(filename);
  const data = await fs.readFile(filePath);

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(data),
    disableWorker: true,
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  });

  return loadingTask.promise;
}

async function getPdfPageCount(filename) {
  const pdf = await loadPdfDocument(filename);
  return pdf.numPages;
}

async function extractPdfPages(filename, options = {}) {
  const pdf = await loadPdfDocument(filename);
  const pageCount = pdf.numPages;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  const startPage = clampInteger(options.startPage, 1, 1, pageCount);
  const endPage = clampInteger(options.endPage, pageCount, startPage, pageCount);

  const pages = [];

  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
    if (onProgress && (pageNumber === startPage || pageNumber === endPage || pageNumber % 10 === 0)) {
      onProgress({ phase: "extract-pages", current: pageNumber - startPage + 1, total: endPage - startPage + 1, unit: "pages" });
    }
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: false,
    });

    const lines = rebuildLinesFromTextItems(content.items);
    const text = normalizeText(lines.join("\n"));

    pages.push({
      page: pageNumber,
      text,
    });
  }

  return {
    filename,
    pageCount,
    pages,
  };
}

async function buildPagesCache(filename, options = {}) {
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const source = await getPdfSourceInfo(filename);
  const partialPath = safePagesPartialCachePath(filename);
  const resume = options.resume !== false;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  let partialPages = [];
  let partialPageCount = 0;

  if (resume && await pathExists(partialPath)) {
    try {
      const partial = JSON.parse(await fs.readFile(partialPath, "utf-8"));
      if (partial.schemaVersion === PAGE_CACHE_SCHEMA_VERSION && partial.filename === filename && isSamePdfSource(partial.source, source) && Array.isArray(partial.pages)) {
        partialPages = partial.pages
          .filter((page) => Number.isFinite(Number(page.page)))
          .sort((a, b) => Number(a.page) - Number(b.page));
        partialPageCount = Number(partial.pageCount || 0);
      }
    } catch {
      // Broken partial caches are ignored and overwritten.
    }
  }

  const pdf = await loadPdfDocument(filename);
  const pageCount = pdf.numPages;
  const pages = [];
  const seenPages = new Set();

  for (const page of partialPages) {
    const pageNumber = Number(page.page);
    if (pageNumber >= 1 && pageNumber <= pageCount && !seenPages.has(pageNumber)) {
      pages.push({ page: pageNumber, text: page.text || "" });
      seenPages.add(pageNumber);
    }
  }

  if (onProgress && pages.length) {
    onProgress({ phase: "resume-pages-cache", current: pages.length, total: pageCount || partialPageCount || pages.length, unit: "pages" });
  }

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    if (seenPages.has(pageNumber)) continue;

    if (onProgress && (pageNumber === 1 || pageNumber === pageCount || pageNumber % 10 === 0)) {
      onProgress({ phase: "extract-pages", current: pageNumber, total: pageCount, unit: "pages" });
    }

    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: false,
    });

    const lines = rebuildLinesFromTextItems(content.items);
    const text = normalizeText(lines.join("\n"));
    pages.push({ page: pageNumber, text });
    seenPages.add(pageNumber);

    if (resume && (pageNumber === pageCount || pageNumber % 10 === 0)) {
      pages.sort((a, b) => a.page - b.page);
      await atomicWriteJson(partialPath, {
        schemaVersion: PAGE_CACHE_SCHEMA_VERSION,
        partial: true,
        filename,
        createdAt: new Date().toISOString(),
        source,
        pageCount,
        pages,
      });
    }
  }

  pages.sort((a, b) => a.page - b.page);

  const cacheData = {
    schemaVersion: PAGE_CACHE_SCHEMA_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    pageCount,
    pages: pages.map((page) => ({ page: page.page, text: page.text || "" })),
  };

  const cachePath = safePagesCachePath(filename);
  await atomicWriteJson(cachePath, cacheData);
  await fs.rm(partialPath, { force: true });

  return cacheData;
}

async function loadPagesCache(filename) {
  const cachePath = safePagesCachePath(filename);

  if (!(await pathExists(cachePath))) {
    return null;
  }

  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    const cacheData = JSON.parse(raw);

    if (cacheData.schemaVersion !== PAGE_CACHE_SCHEMA_VERSION) {
      return null;
    }

    if (cacheData.filename !== filename) {
      return null;
    }

    if (!Array.isArray(cacheData.pages)) {
      return null;
    }

    const currentSource = await getPdfSourceInfo(filename);

    if (!isSamePdfSource(cacheData.source, currentSource)) {
      return null;
    }

    return cacheData;
  } catch {
    return null;
  }
}

async function getPagesCache(filename, options = {}) {
  const existing = await loadPagesCache(filename);

  if (existing) {
    return existing;
  }

  if (options.buildIfMissing === true) {
    return await buildPagesCache(filename, options);
  }

  throw new Error(`Pages cache not found for ${filename}. Run index_pdf or start_index_pdf first. For a small page range, use read_pdf_pages which can extract selected pages without building full cache.`);
}

/**
 * Rebuilds PDF text items into rough visual lines.
 * Hardware manuals often contain register tables; preserving row structure is
 * more useful than a plain item join.
 */
function rebuildLinesFromTextItems(items) {
  const rows = [];

  for (const item of items || []) {
    const str = String(item.str || "").trim();
    if (!str) continue;

    const transform = item.transform || [];
    const x = Number(transform[4] || 0);
    const y = Number(transform[5] || 0);
    const width = Number(item.width || 0);
    const height = Number(item.height || Math.abs(transform[3] || 0) || 10);

    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= Math.max(2, height * 0.35));

    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }

    row.items.push({ x, width, str });
  }

  rows.sort((a, b) => b.y - a.y);

  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x);

    const parts = [];
    let previousEnd = null;

    for (const item of row.items) {
      if (previousEnd !== null) {
        const gap = item.x - previousEnd;
        if (gap > 8) {
          const spaces = Math.min(MAX_TEXT_ITEM_GAP_SPACES, Math.max(1, Math.round(gap / 8)));
          parts.push(" ".repeat(spaces));
        } else {
          parts.push(" ");
        }
      }

      parts.push(item.str);
      previousEnd = item.x + Math.max(item.width, item.str.length * 4);
    }

    return parts.join("").replace(/[ ]{2,}/g, " ").trimEnd();
  });
}

// -----------------------------------------------------------------------------
// Indexing
// -----------------------------------------------------------------------------

function chunkText(text, chunkSize, overlap) {
  const clean = normalizeText(text);
  if (!clean) return [];

  if (clean.length <= chunkSize) return [clean];

  const chunks = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);

    if (end < clean.length) {
      const slice = clean.slice(start, end);
      const boundaries = [
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf("\n"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf("; "),
        slice.lastIndexOf(": "),
      ];
      const boundary = Math.max(...boundaries);

      if (boundary > chunkSize * 0.55) {
        end = start + boundary + 1;
      }
    }

    const chunk = clean.slice(start, end).trim();
    if (chunk) chunks.push(chunk);

    if (end >= clean.length) break;
    start = Math.max(0, end - overlap);
  }

  return chunks;
}


const CHUNK_TYPE_LABELS = [
  "register_table",
  "bitfield_table",
  "procedure",
  "caution",
  "register_description",
  "interrupt_status",
  "clock_reset",
  "overview",
  "toc_index",
  "revision_history",
  "legal_notice",
  "noise",
  "text",
];

function clampScore(value, min = 0, max = 100) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function countRegexMatches(text, pattern) {
  const matches = String(text || "").match(pattern);
  return matches ? matches.length : 0;
}

function isLikelyTocOrIndexChunk(text, headings = []) {
  const raw = String(text || "");
  const normalized = normalizeForSearch(raw);
  const headingText = normalizeForSearch((headings || []).join(" "));
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);

  if (/\b(table of contents|contents|list of figures|list of tables)\b/i.test(raw)) return true;
  if (/\bindex\b/i.test(headingText) && lines.length > 8) return true;

  const numberedLines = lines.filter((line) => /\.{2,}\s*\d+\s*$/.test(line) || /^\d+(?:\.\d+){1,5}\s+.+\s+\d+\s*$/.test(line));
  if (lines.length >= 8 && numberedLines.length / lines.length > 0.45) return true;

  const chapterLike = lines.filter((line) => /^\d+(?:\.\d+)*\s+.+/.test(line));
  if (normalized.includes("contents") && chapterLike.length >= 5) return true;

  return false;
}

function classifyChunkProfile(text, meta = {}) {
  const raw = String(text || "");
  const headings = meta.headings || [];
  const registers = meta.registers || [];
  const bitFields = meta.bitFields || [];
  const lineCount = raw.split("\n").map((line) => line.trim()).filter(Boolean).length;
  const charCount = raw.length;
  const signals = [];
  const types = new Set();
  let noiseScore = 0;
  let contentScore = 35;

  const add = (type, signal, contentDelta = 0, noiseDelta = 0) => {
    types.add(type);
    if (signal) signals.push(signal);
    contentScore += contentDelta;
    noiseScore += noiseDelta;
  };

  if (!raw.trim() || charCount < 30) add("noise", "very-short-or-empty", -20, 45);

  if (isLikelyTocOrIndexChunk(raw, headings)) add("toc_index", "toc/index layout", -35, 70);
  if (/\b(revision history|document revision|revision record|rev\.?\s+date|description of revision)\b/i.test(raw)) add("revision_history", "revision-history language", -30, 65);
  if (/\b(copyright|trademark|notice|disclaimer|all rights reserved|renesas electronics corporation)\b/i.test(raw) && !/\bregister|bit|operation\b/i.test(raw)) add("legal_notice", "legal/notice language", -25, 55);

  if (/\b(Register\s+Name|Abbreviation|Offset\s+Address|Initial\s+Value|Access\s+Size)\b/i.test(raw)) add("register_table", "register table headers", 55, -15);
  if (/\b(Bit\s+Name|Bit\s+Field|R\/W|R\/O|W\/O|Initial\s+Value|Description)\b/i.test(raw) && /\b(bit|b\d+|\[\d+(?::\d+)?\])\b/i.test(raw)) add("bitfield_table", "bitfield table headers", 55, -15);
  if ((registers || []).length && /\b(Address|Offset|Initial\s+Value|Access|Description|Register)\b/i.test(raw)) add("register_description", "register metadata", 35, -8);
  if ((bitFields || []).length >= 2 && /\b(Bit|Description|Set|Clear|Read|Write)\b/i.test(raw)) add("bitfield_table", "multiple bitfield symbols", 30, -8);

  if (/\b(Caution|CAUTION|Note|NOTES?|Restriction|Restrictions|Prohibited|Forbidden|Undefined|Invalid|Reserved|must\s+not|do\s+not|only\s+when)\b/i.test(raw)) add("caution", "caution/restriction language", 45, -10);
  if (/\b(sequence|procedure|operation|setting|settings|step|steps|before|after|when|while|first|then|enable|disable|start|stop|clear|reset|initialize|initialization)\b/i.test(raw)) add("procedure", "operation/procedure language", 35, -5);
  if (/\b(interrupt|IRQ|INT|status flag|interrupt request|interrupt status|enable interrupt|clear interrupt)\b/i.test(raw)) add("interrupt_status", "interrupt/status language", 30, -5);
  if (/\b(clock|PCLK|module stop|standby|reset release|software reset|SWRST|reset)\b/i.test(raw)) add("clock_reset", "clock/reset language", 22, -3);
  if (/\b(overview|features|block diagram|functional overview|outline)\b/i.test(raw) || headings.some((h) => /overview|outline|features/i.test(h))) add("overview", "overview language", 18, -3);

  const letters = raw.replace(/[^A-Za-z]/g, "");
  const uppercaseRatio = letters.length ? raw.replace(/[^A-Z]/g, "").length / letters.length : 0;
  if (lineCount > 30 && uppercaseRatio > 0.78 && !types.has("register_table") && !types.has("bitfield_table")) add("noise", "high-uppercase-list-like chunk", -25, 35);

  const numericPageRefs = countRegexMatches(raw, /\.{2,}\s*\d+\s*$/gm);
  if (numericPageRefs >= 5 && !types.has("register_table")) add("toc_index", "many page-reference lines", -25, 45);

  if (!types.size) types.add("text");

  if (types.has("register_table") || types.has("bitfield_table") || types.has("procedure") || types.has("caution")) {
    noiseScore = Math.max(0, noiseScore - 25);
  }

  const priority = [
    "register_table",
    "bitfield_table",
    "caution",
    "procedure",
    "interrupt_status",
    "clock_reset",
    "register_description",
    "overview",
    "toc_index",
    "revision_history",
    "legal_notice",
    "noise",
    "text",
  ];
  const chunkType = priority.find((type) => types.has(type)) || "text";

  return {
    chunkType,
    chunkTypes: priority.filter((type) => types.has(type)),
    noiseScore: clampScore(noiseScore),
    contentScore: clampScore(contentScore - Math.round(noiseScore / 3)),
    signals: [...new Set(signals)].slice(0, 12),
  };
}

function chunkTypeAdjustmentForBasicSearch(chunk) {
  let adjustment = 0;
  const type = chunk.chunkType || "text";
  const noise = Number(chunk.noiseScore || 0);
  const content = Number(chunk.contentScore || 0);

  adjustment += Math.round(content / 12);
  if (noise >= 70) adjustment -= 55;
  else if (noise >= 45) adjustment -= 25;

  if (["toc_index", "revision_history", "legal_notice", "noise"].includes(type)) adjustment -= 35;
  if (["register_table", "bitfield_table", "register_description", "procedure", "caution"].includes(type)) adjustment += 12;

  return adjustment;
}

function chunkTypeAdjustmentForHybrid(chunk, hybrid) {
  const type = chunk.chunkType || "text";
  const types = new Set([type, ...((chunk.chunkTypes || []))]);
  const intents = new Set(hybrid.intents || []);
  const noise = Number(chunk.noiseScore || 0);
  const content = Number(chunk.contentScore || 0);
  const reasons = [];
  let score = 0;

  score += Math.round(content / 8);
  if (noise >= 75) {
    score -= 120;
    reasons.push("noise suppression");
  } else if (noise >= 50) {
    score -= 55;
    reasons.push("moderate noise suppression");
  }

  const isSearchForNavigation = intents.has("section") || intents.has("table");
  if (!isSearchForNavigation && (types.has("toc_index") || types.has("revision_history") || types.has("legal_notice") || types.has("noise"))) {
    score -= 85;
    reasons.push(`chunkType penalty ${type}`);
  }

  if (intents.has("register") && (types.has("register_table") || types.has("register_description"))) {
    score += 95;
    reasons.push("chunkType register boost");
  }
  if ((intents.has("bitfield") || intents.has("table")) && types.has("bitfield_table")) {
    score += 95;
    reasons.push("chunkType bitfield-table boost");
  }
  if (intents.has("table") && (types.has("register_table") || types.has("bitfield_table"))) {
    score += 80;
    reasons.push("chunkType table boost");
  }
  if (intents.has("caution") && types.has("caution")) {
    score += 110;
    reasons.push("chunkType caution boost");
  }
  if (["sequence", "init", "start", "stop", "clear", "reset", "irq", "error"].some((intent) => intents.has(intent)) && types.has("procedure")) {
    score += 90;
    reasons.push("chunkType procedure boost");
  }
  if (intents.has("irq") && types.has("interrupt_status")) {
    score += 90;
    reasons.push("chunkType interrupt/status boost");
  }
  if (intents.has("reset") && types.has("clock_reset")) {
    score += 65;
    reasons.push("chunkType clock/reset boost");
  }
  if (intents.has("section") && types.has("overview")) {
    score += 35;
    reasons.push("chunkType overview boost");
  }

  return { score, reasons };
}

function summarizeChunkTypes(chunks) {
  const byType = new Map();
  const byNoiseBand = { low: 0, medium: 0, high: 0 };
  let totalNoise = 0;
  let totalContent = 0;

  for (const chunk of chunks || []) {
    const type = chunk.chunkType || "unknown";
    if (!byType.has(type)) {
      byType.set(type, {
        type,
        count: 0,
        pages: new Set(),
        examples: [],
        _noise: 0,
        _content: 0,
      });
    }
    const item = byType.get(type);
    item.count += 1;
    item.pages.add(chunk.page);
    item._noise += Number(chunk.noiseScore || 0);
    item._content += Number(chunk.contentScore || 0);
    if (item.examples.length < 3) {
      item.examples.push({
        id: chunk.id,
        page: chunk.page,
        chunkIndex: chunk.chunkIndex,
        noiseScore: chunk.noiseScore || 0,
        contentScore: chunk.contentScore || 0,
        signals: chunk.chunkTypeSignals || [],
        preview: normalizeText(chunk.text || "").slice(0, 220),
      });
    }

    const noise = Number(chunk.noiseScore || 0);
    if (noise >= 70) byNoiseBand.high += 1;
    else if (noise >= 40) byNoiseBand.medium += 1;
    else byNoiseBand.low += 1;
    totalNoise += noise;
    totalContent += Number(chunk.contentScore || 0);
  }

  const typeStats = [...byType.values()].map((item) => ({
    type: item.type,
    count: item.count,
    pages: [...item.pages].sort((a, b) => a - b).slice(0, 30),
    avgNoise: item.count ? Math.round(item._noise / item.count) : 0,
    avgContent: item.count ? Math.round(item._content / item.count) : 0,
    examples: item.examples,
  })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const count = (chunks || []).length;
  return {
    chunkCount: count,
    avgNoise: count ? Math.round(totalNoise / count) : 0,
    avgContent: count ? Math.round(totalContent / count) : 0,
    byNoiseBand,
    byType: typeStats,
  };
}

async function getChunkTypeStats(filename, options = {}) {
  const indexData = await loadPdfIndex(filename);
  const stats = summarizeChunkTypes(indexData.chunks || []);
  return {
    filename,
    createdAt: new Date().toISOString(),
    indexCreatedAt: indexData.createdAt,
    pageCount: indexData.pageCount,
    includeExamples: options.includeExamples !== false,
    stats,
  };
}

function formatChunkTypeStats(payload) {
  const lines = [
    `Chunk type statistics for ${payload.filename}`,
    `Index created: ${payload.indexCreatedAt}`,
    `Pages: ${payload.pageCount}`,
    `Chunks: ${payload.stats.chunkCount}`,
    `Average noise score: ${payload.stats.avgNoise}`,
    `Average content score: ${payload.stats.avgContent}`,
    `Noise bands: low=${payload.stats.byNoiseBand.low}, medium=${payload.stats.byNoiseBand.medium}, high=${payload.stats.byNoiseBand.high}`,
    "",
    "Types:",
  ];

  for (const item of payload.stats.byType || []) {
    lines.push(`- ${item.type}: count=${item.count}, avgNoise=${item.avgNoise}, avgContent=${item.avgContent}, pages=${item.pages.join(", ") || "unknown"}`);
    if (payload.includeExamples) {
      for (const example of item.examples || []) {
        lines.push(`  example: ${example.id} page=${example.page} noise=${example.noiseScore} content=${example.contentScore} signals=${(example.signals || []).join("; ") || "none"}`);
        lines.push(`    preview: ${example.preview}`);
      }
    }
  }

  lines.push("", "Machine summary JSON:");
  lines.push(JSON.stringify({
    filename: payload.filename,
    chunkCount: payload.stats.chunkCount,
    avgNoise: payload.stats.avgNoise,
    avgContent: payload.stats.avgContent,
    byNoiseBand: payload.stats.byNoiseBand,
    byType: (payload.stats.byType || []).map((item) => ({
      type: item.type,
      count: item.count,
      avgNoise: item.avgNoise,
      avgContent: item.avgContent,
    })),
  }, null, 2));

  return lines.join("\n");
}

function detectHeadings(text) {
  const headings = [];
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const compact = line.replace(/\s+/g, " ");
    const isSectionNumber = /^\d+(?:\.\d+){1,8}\s+\S+/.test(compact);
    const isAppendixSection = /^Appendix\s+[A-Z0-9]+\b/i.test(compact);
    const isTableOrFigure = /^(Table|Figure)\s+\d[\d.\-]*\b/i.test(compact);
    const mentionsRegister = /\b(Register|Registers|Bit Field|Interrupt|Clock|Reset|Operation|Description)\b/i.test(compact) && compact.length <= 180;
    const allCapsHeading = /^[A-Z0-9][A-Z0-9_ /,()\-]{8,160}$/.test(compact) && /[A-Z]{4}/.test(compact);

    if (isSectionNumber || isAppendixSection || isTableOrFigure || mentionsRegister || allCapsHeading) {
      headings.push(compact.slice(0, 220));
    }

    if (headings.length >= 10) break;
  }

  return [...new Set(headings)];
}

function cleanSectionTitle(line) {
  return String(line || "")
    .replace(/\s+/g, " ")
    .replace(/[.·•]+$/g, "")
    .trim()
    .slice(0, 240);
}

function isNoiseSectionLine(line) {
  const text = String(line || "").trim();

  if (!text || text.length < 4 || text.length > 240) return true;
  if (/^[-–—_\s]+$/.test(text)) return true;
  if (/^Page\s+\d+\b/i.test(text)) return true;
  if (/^R\d{2}[A-Z0-9]+/i.test(text)) return true;
  if (/^(Rev\.|Revision|Preliminary|Confidential|Copyright)\b/i.test(text)) return true;
  if (/^\d+$/.test(text)) return true;

  return false;
}

function classifySectionLine(line) {
  const title = cleanSectionTitle(line);

  if (isNoiseSectionLine(title)) return null;

  let match = title.match(/^(\d+(?:\.\d+){0,8})\s+(.{2,})$/);
  if (match) {
    const number = match[1];
    const tail = match[2].trim();
    if (tail.length >= 2 && !/^\d+$/.test(tail)) {
      return {
        title,
        number,
        level: number.split(".").length,
        type: "numbered",
        confidence: 95,
      };
    }
  }

  match = title.match(/^(Appendix\s+[A-Z0-9]+(?:[.\-]\d+)*)\s+(.{2,})$/i);
  if (match) {
    return {
      title,
      number: match[1],
      level: 1,
      type: "appendix",
      confidence: 90,
    };
  }

  match = title.match(/^(Table|Figure)\s+(\d[\d.\-]*)\s+(.{2,})$/i);
  if (match) {
    return {
      title,
      number: `${match[1]} ${match[2]}`,
      level: 99,
      type: match[1].toLowerCase(),
      confidence: 80,
    };
  }

  const manualTopic = /\b(Overview|Register(?:s)?|Register Description|Bit Field|Operation|Operating|Procedure|Setting|Settings|Interrupt(?:s)?|Clock|Reset|Initialization|Configuration|Caution|Note|Restriction|Usage Notes|Pin|DMA|Transfer|Mode)\b/i.test(title);
  const looksLikeHeading = /^[A-Z0-9][A-Za-z0-9_ /,()\-:+]{5,180}$/.test(title);
  const registerHeading = /\b[A-Z][A-Z0-9_]{2,}\b.*\b(Register|Registers)\b/i.test(title);

  if ((manualTopic && looksLikeHeading) || registerHeading) {
    return {
      title,
      number: "",
      level: 50,
      type: "topic",
      confidence: registerHeading ? 78 : 65,
    };
  }

  const allCapsHeading = /^[A-Z0-9][A-Z0-9_ /,()\-:+]{8,160}$/.test(title) && /[A-Z]{4}/.test(title);
  if (allCapsHeading) {
    return {
      title,
      number: "",
      level: 60,
      type: "caps",
      confidence: 55,
    };
  }

  return null;
}

function detectSectionCandidatesFromPage(page) {
  const candidates = [];
  const lines = String(page.text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const classified = classifySectionLine(line);
    if (!classified) continue;

    candidates.push({
      ...classified,
      filename: page.filename,
      page: page.page,
      searchText: normalizeForSearch(classified.title),
      canonicalTitle: canonicalSymbol(classified.title),
    });
  }

  return candidates;
}

async function buildSectionsIndex(filename, pageCache = null) {
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const source = await getPdfSourceInfo(filename);
  const cache = pageCache || (await getPagesCache(filename));
  const byKey = new Map();

  for (const page of cache.pages || []) {
    const pageCandidates = detectSectionCandidatesFromPage({
      ...page,
      filename,
    });

    for (const candidate of pageCandidates) {
      const key = `${candidate.page}:${candidate.title.toLowerCase()}`;
      const previous = byKey.get(key);

      if (!previous || candidate.confidence > previous.confidence) {
        byKey.set(key, candidate);
      }
    }
  }

  const sections = [...byKey.values()]
    .sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      if (a.level !== b.level) return a.level - b.level;
      return b.confidence - a.confidence;
    })
    .map((section, index) => ({
      id: `${filename}:s${index}`,
      filename,
      title: section.title,
      number: section.number || "",
      page: section.page,
      level: section.level,
      type: section.type,
      confidence: section.confidence,
      searchText: section.searchText,
      canonicalTitle: section.canonicalTitle,
    }));

  const indexData = {
    schemaVersion: SECTION_INDEX_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    pageCount: cache.pageCount,
    sectionCount: sections.length,
    sections,
  };

  const sectionsPath = safeSectionsIndexPath(filename);
  await atomicWriteJson(sectionsPath, indexData);

  return indexData;
}

async function loadSectionsIndex(filename) {
  const sectionsPath = safeSectionsIndexPath(filename);

  if (!(await pathExists(sectionsPath))) {
    return null;
  }

  try {
    const raw = await fs.readFile(sectionsPath, "utf-8");
    const indexData = JSON.parse(raw);

    if (indexData.schemaVersion !== SECTION_INDEX_SCHEMA_VERSION) return null;
    if (indexData.filename !== filename) return null;
    if (!Array.isArray(indexData.sections)) return null;

    const currentSource = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(indexData.source, currentSource)) return null;

    return indexData;
  } catch {
    return null;
  }
}

async function getSectionsIndex(filename, options = {}) {
  const existing = await loadSectionsIndex(filename);
  if (existing) return existing;

  if (options.buildIfMissing === true) {
    const pageCache = await getPagesCache(filename, { buildIfMissing: true });
    return buildSectionsIndex(filename, pageCache);
  }

  throw new Error(`Sections index not found for ${filename}. Run index_pdf or start_index_pdf first.`);
}

function detectRegisters(text) {
  const found = new Set();
  const source = String(text || "");

  const patterns = [
    // Renesas module style: DMACm_N0SA_n, DMACm_CHCTRL_n, GBETHm_MACCR, GPTm_GTCR.
    /\b[A-Z][A-Za-z0-9]*m_[A-Za-z0-9_]+(?:_n)?\b/g,
    /\b[A-Z]{2,12}m_[A-Za-z0-9_]+(?:_n)?\b/g,

    // Generic all-caps register-looking symbols.
    /\b[A-Z]{2,12}_[A-Z0-9_]*(?:R|CR|SR|DR|MR|ER|FR|RR|TR|BR|AR|LR|PR|CSR|ISR|IER|ICR|CTRL|STAT)\d*\b/g,
    /\b(?:MAC|MTL|DMA|DMAC|GMAC|ETH|GBETH|WDT|GPT|GT|POEG|ICU|IRQ|INT|SPI|I2C|I3C|UART|CAN|ADC)[A-Z0-9_]*(?:R|CR|SR|DR|MR|ER|FR|RR|TR|BR|AR|LR|PR|CSR|ISR|IER|ICR|CTRL|STAT)\d*\b/g,

    // Known short names that do not always end in R.
    /\b(?:WDT|WDTRR|WDTCR|WDTSR|WDTRCR|GTCR|GTUDDTYC|GTCNT|GTCCR|GTCCRA|GTCCRB|GTIOR|GTINTAD|GTST|GTBER|GTPR|GTPBR|GTDTCR|GTDVU|GTDVD)\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.match(pattern) || []) {
      const symbol = match.trim();
      if (symbol.length >= 3 && symbol.length <= 80) found.add(symbol);
    }
  }

  return [...found].slice(0, 120);
}
function detectBitFields(text) {
  const found = new Set();
  const source = String(text || "");

  const patterns = [
    /\b[A-Z][A-Z0-9_]{1,31}\s*\[[0-9]+(?::[0-9]+)?\]/g,
    /\b[A-Z][A-Z0-9_]{1,31}\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.match(pattern) || []) {
      const cleaned = match.replace(/\s+/g, "").trim();
      if (cleaned.length >= 2 && cleaned.length <= 40) found.add(cleaned);
    }
  }

  return [...found].slice(0, 100);
}

function normalizeRegisterName(name) {
  return canonicalSymbol(name);
}

function registerAliasCandidates(name) {
  const raw = String(name || "").trim();
  const canonical = normalizeRegisterName(raw);
  const aliases = new Set();

  if (!raw || !canonical) return [];

  aliases.add(raw);
  aliases.add(canonical);

  const unprefixed = raw
    .replace(/^[A-Z0-9]+m_/i, "")
    .replace(/^(GBETH|ETH|GMAC|WDT|GPT|POEG|ICU)_/i, "");

  const canonicalUnprefixed = normalizeRegisterName(unprefixed);
  if (canonicalUnprefixed) aliases.add(canonicalUnprefixed);

  for (const prefix of ["GBETHm_", "ETH_", "GMAC_", "WDT_", "GPT_", "POEG_", "ICU_"]) {
    if (canonicalUnprefixed && !canonicalUnprefixed.startsWith(normalizeRegisterName(prefix))) {
      aliases.add(`${prefix}${canonicalUnprefixed}`);
    }
  }

  return [...aliases].filter(Boolean);
}

function looksLikeRegisterSymbol(symbol) {
  const raw = String(symbol || "").trim();
  const value = normalizeRegisterName(raw);
  if (value.length < 3 || value.length > 80) return false;

  const noisy = new Set([
    "NOTE",
    "NOTES",
    "TABLE",
    "FIGURE",
    "REGISTER",
    "REGISTERS",
    "ADDRESS",
    "OFFSET",
    "DESCRIPTION",
    "INITIALVALUE",
    "BITNAME",
    "READ",
    "WRITE",
    "RESERVED",
    "UNDEFINED",
    "CAUTION",
    "CAUTIONS",
  ]);

  if (noisy.has(value)) return false;

  // Avoid common DMA interrupt/signal names being promoted to registers.
  // They can still be found by search_pdf, but should not pollute list_registers.
  const likelySignalOnly = /^(DMAERR|DMAEND\d*|DMAC\d+_DMAER|DMAC\d+_DMAEND\d*)$/.test(value);
  if (likelySignalOnly) return false;

  return (
    /R\d*$/.test(value) ||
    /(CR|SR|DR|MR|ER|FR|RR|TR|BR|AR|LR|PR|CSR|ISR|IER|ICR|CTRL|STAT)$/.test(value) ||
    /^[A-Z0-9]+M_[A-Z0-9_]+(?:_N)?$/.test(value) ||
    /^(WDT|WDTRR|WDTCR|WDTSR|WDTRCR|GT|GPT|POEG|MAC|MTL|DMA|DMAC|GMAC|ETH|GBETH|ICU|I3C|I2C|SPI|UART|CAN|ADC)[A-Z0-9_]*$/.test(value)
  );
}
function isNonRegisterSignal(symbol) {
  const value = normalizeRegisterName(symbol);
  if (!value || value.length < 3 || value.length > 80) return true;
  const noisy = new Set(["NOTE", "NOTES", "TABLE", "FIGURE", "SECTION", "CHAPTER", "PAGE", "PAGES", "REGISTER", "REGISTERS", "ADDRESS", "OFFSET", "DESCRIPTION", "INITIALVALUE", "ACCESS", "ACCESSSIZE", "BIT", "BITS", "BITNAME", "READ", "WRITE", "RESET", "RESERVED", "UNDEFINED", "CAUTION", "CAUTIONS", "PROHIBITED", "FUNCTION", "OPERATION"]);
  if (noisy.has(value)) return true;
  const signalOnlyPatterns = [/^(DMAERR|DMAEND\d*|DMAOR|DMARQ\d*|DREQ\d*|DACK\d*)$/, /^DMAC\d+_(DMAER|DMAERR|DMAEND\d*|DREQ\d*|DACK\d*)$/, /^(IRQ|INT|NMI|FIQ|EVENT|REQUEST|ACK|ERROR|DONE|BUSERR|PERIERR)$/, /^(RXD|TXD|RXER|TXER|RXDV|TXEN|MDC|MDIO|REFCLK|GTXCLK|RXCLK|TXCLK)$/];
  if (signalOnlyPatterns.some((pattern) => pattern.test(value))) return true;
  return !looksLikeRegisterSymbol(symbol);
}

function scoreRegisterOccurrence(symbol, chunk) {
  const name = normalizeRegisterName(symbol);
  const text = String(chunk.text || "");
  const searchText = chunk.searchText || normalizeForSearch(text);
  const headings = (chunk.headings || []).join("\n");
  const headingSearch = normalizeForSearch(headings);
  const canonicalHeading = canonicalSymbol(headings);

  let score = 20;

  if ((chunk.registers || []).map(normalizeRegisterName).includes(name)) score += 30;
  if ((chunk.symbols || []).map(normalizeRegisterName).includes(name)) score += 15;
  if (canonicalHeading.includes(name)) score += 35;

  const registerWord = normalizeForSearch(symbol);
  if (registerWord && searchText.includes(`${registerWord} register`)) score += 30;
  if (registerWord && searchText.includes(`register ${registerWord}`)) score += 25;

  if (/\b(Register|Registers|Register Description|Register Descriptions)\b/i.test(text)) score += 18;
  if (/\b(Address|Offset)\s*:?\b/i.test(text)) score += 14;
  if (/\bInitial\s+Value\s*:?\b/i.test(text)) score += 12;
  if (/\bAccess\s+Size\s*:?\b/i.test(text)) score += 10;
  if (/\bBit\s+Name\b/i.test(text)) score += 12;
  if (/\bDescription\b/i.test(text)) score += 4;

  const occurrenceCount = (canonicalSymbol(text).match(new RegExp(escapeRegExp(name), "g")) || []).length;
  score += Math.min(occurrenceCount * 3, 24);

  return score;
}

function nearestSectionForPage(sectionsIndex, pageNumber) {
  if (!sectionsIndex || !Array.isArray(sectionsIndex.sections)) return null;

  let best = null;
  for (const section of sectionsIndex.sections) {
    if (Number(section.page) > Number(pageNumber)) continue;
    if (!best || section.page > best.page || (section.page === best.page && section.level > best.level)) {
      best = section;
    }
  }

  return best
    ? {
        id: best.id,
        title: best.title,
        page: best.page,
        level: best.level,
        type: best.type,
      }
    : null;
}

function collectRegisterSymbolsFromChunk(chunk) {
  const symbols = new Set();

  for (const value of chunk.registers || []) {
    if (looksLikeRegisterSymbol(value)) symbols.add(value);
  }

  for (const heading of chunk.headings || []) {
    for (const value of detectRegisters(heading)) {
      if (looksLikeRegisterSymbol(value)) symbols.add(value);
    }
  }

  return [...symbols];
}

function normalizeRegisterDisplayName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

function extractRegisterTableRowsFromPage(page) {
  const rows = [];
  const text = String(page.text || "");
  if (!/Register\s+Name\s+Abbreviation\s+Initial\s+Value\s+Offset\s+Address/i.test(text)) {
    return rows;
  }

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    // Example:
    // Next0 Source Address Register n  DMACm_N0SA_n  0000_0000h  0000h + k x 0040h  32
    const match = line.match(/^(.+?)\s+([A-Z][A-Za-z0-9]*m_[A-Za-z0-9_]+(?:_n)?)\s+([0-9A-Fa-f_]+h|-)\s+(.+?)\s+(\d+|-)\s*$/);
    if (!match) continue;

    const [, description, abbreviation, initialValue, offsetAddress, accessSize] = match;
    const cleanedDescription = normalizeRegisterDisplayName(description);

    if (!cleanedDescription || /^Reserve$/i.test(cleanedDescription) || abbreviation === "-") continue;

    rows.push({
      name: abbreviation.trim(),
      displayName: abbreviation.trim(),
      description: cleanedDescription,
      initialValue: initialValue.trim(),
      offsetAddress: normalizeRegisterDisplayName(offsetAddress),
      accessSize: accessSize.trim(),
      page: page.page,
      sourceKind: "register-list-table",
      confidenceBoost: 90,
    });
  }

  return rows;
}

function extractRegisterDescriptionHeadings(chunk) {
  const rows = [];
  const headings = chunk.headings || [];
  const sources = [...headings, ...String(chunk.text || "").split("\n").slice(0, 8)];

  for (const line of sources) {
    const match = String(line).match(/(?:^|\s)(\d+(?:\.\d+){2,})\s+(.+?Register(?:\s+n)?)[^()]*\(([^()]*[A-Za-z0-9]m_[A-Za-z0-9_]+(?:_n)?[^()]*)\)/i);
    if (!match) continue;

    const [, sectionNumber, description, symbolGroup] = match;
    for (const symbolMatch of symbolGroup.matchAll(/\b[A-Z][A-Za-z0-9]*m_[A-Za-z0-9_]+(?:_n)?\b/g)) {
      const name = symbolMatch[0].trim();
      rows.push({
        name,
        displayName: name,
        description: normalizeRegisterDisplayName(description),
        sectionNumber,
        page: chunk.page,
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
        sourceKind: "register-description-heading",
        confidenceBoost: 75,
      });
    }
  }

  return rows;
}

function upsertRegisterCandidate(byName, candidate, chunk = null, sectionsIndex = null) {
  const canonical = normalizeRegisterName(candidate.name);
  if (!canonical || !looksLikeRegisterSymbol(candidate.name)) return;

  const current = byName.get(canonical) || {
    name: canonical,
    displayName: candidate.displayName || candidate.name,
    aliases: new Set(),
    pages: new Set(),
    chunks: new Map(),
    headings: new Set(),
    sections: new Map(),
    descriptions: new Set(),
    offsets: new Set(),
    initialValues: new Set(),
    accessSizes: new Set(),
    sourceKinds: new Set(),
    totalScore: 0,
    occurrenceCount: 0,
  };

  current.displayName = current.displayName || candidate.displayName || candidate.name;
  current.aliases.add(candidate.name);
  current.aliases.add(candidate.displayName || candidate.name);
  current.aliases.add(canonical);
  for (const alias of registerAliasCandidates(candidate.name)) current.aliases.add(alias);

  if (candidate.description) current.descriptions.add(candidate.description);
  if (candidate.offsetAddress) current.offsets.add(candidate.offsetAddress);
  if (candidate.initialValue) current.initialValues.add(candidate.initialValue);
  if (candidate.accessSize) current.accessSizes.add(candidate.accessSize);
  if (candidate.sourceKind) current.sourceKinds.add(candidate.sourceKind);

  const page = Number(candidate.page || (chunk && chunk.page));
  if (Number.isFinite(page)) current.pages.add(page);

  const occurrenceScore = Number(candidate.score || candidate.confidenceBoost || 0) + (chunk ? scoreRegisterOccurrence(candidate.name, chunk) : 0);
  current.totalScore += Math.max(1, occurrenceScore);
  current.occurrenceCount += 1;

  if (chunk) {
    for (const heading of chunk.headings || []) current.headings.add(heading);

    const previousChunk = current.chunks.get(chunk.id);
    if (!previousChunk || occurrenceScore > previousChunk.score) {
      current.chunks.set(chunk.id, {
        id: chunk.id,
        page: chunk.page,
        chunkIndex: chunk.chunkIndex,
        score: occurrenceScore,
        headings: (chunk.headings || []).slice(0, 5),
        preview: normalizeText(chunk.text || "").slice(0, 500),
      });
    }
  } else if (candidate.chunkId) {
    const previousChunk = current.chunks.get(candidate.chunkId);
    if (!previousChunk || occurrenceScore > previousChunk.score) {
      current.chunks.set(candidate.chunkId, {
        id: candidate.chunkId,
        page,
        chunkIndex: candidate.chunkIndex ?? 0,
        score: occurrenceScore,
        headings: [],
        preview: candidate.description || "",
      });
    }
  }

  const nearestSection = nearestSectionForPage(sectionsIndex, page);
  if (nearestSection) current.sections.set(nearestSection.id, nearestSection);

  byName.set(canonical, current);
}

async function buildRegistersIndex(filename, indexData = null, sectionsIndex = null) {
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const source = await getPdfSourceInfo(filename);
  const chunkIndex = indexData || (await loadPdfIndex(filename));
  const sectionIndexData = sectionsIndex || (await getSectionsIndex(filename));
  const pageCache = await getPagesCache(filename);
  const byName = new Map();

  // Highest-confidence source: the module's explicit "List of Registers" table.
  for (const page of pageCache.pages || []) {
    for (const candidate of extractRegisterTableRowsFromPage(page)) {
      upsertRegisterCandidate(byName, candidate, null, sectionIndexData);
    }
  }

  // Next source: individual register-description headings.
  for (const chunk of chunkIndex.chunks || []) {
    for (const candidate of extractRegisterDescriptionHeadings(chunk)) {
      upsertRegisterCandidate(byName, candidate, chunk, sectionIndexData);
    }
  }

  // Fallback source: symbol scan in chunks. This is useful for find_register,
  // but list_registers hides low-confidence symbol-only candidates by default.
  for (const chunk of chunkIndex.chunks || []) {
    const symbols = collectRegisterSymbolsFromChunk(chunk);
    for (const symbol of symbols) {
      upsertRegisterCandidate(
        byName,
        {
          name: symbol,
          displayName: symbol,
          page: chunk.page,
          sourceKind: "symbol-scan",
          confidenceBoost: 10,
        },
        chunk,
        sectionIndexData
      );
    }
  }

  const registers = [...byName.values()]
    .map((entry) => {
      const pages = [...entry.pages].sort((a, b) => a - b);
      const chunks = [...entry.chunks.values()].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.page !== b.page) return a.page - b.page;
        return a.chunkIndex - b.chunkIndex;
      });
      const sourceKinds = [...entry.sourceKinds];
      const hasExplicitTable = sourceKinds.includes("register-list-table");
      const hasDescriptionHeading = sourceKinds.includes("register-description-heading");
      const confidence = Math.max(
        1,
        Math.min(
          99,
          Math.round(
            Math.min(55, entry.totalScore / Math.max(1, entry.occurrenceCount)) +
              Math.min(18, entry.occurrenceCount * 2) +
              Math.min(8, pages.length) +
              (hasExplicitTable ? 25 : 0) +
              (hasDescriptionHeading ? 15 : 0)
          )
        )
      );

      return {
        name: entry.name,
        displayName: entry.displayName,
        filename,
        aliases: [...entry.aliases].map(String).filter(Boolean).slice(0, 32),
        pages,
        chunks: chunks.slice(0, 24),
        sections: [...entry.sections.values()].slice(0, 8),
        headings: [...entry.headings].slice(0, 12),
        descriptions: [...entry.descriptions].slice(0, 6),
        offsetAddresses: [...entry.offsets].slice(0, 6),
        initialValues: [...entry.initialValues].slice(0, 6),
        accessSizes: [...entry.accessSizes].slice(0, 6),
        sourceKinds,
        isExplicitRegister: hasExplicitTable || hasDescriptionHeading,
        occurrenceCount: entry.occurrenceCount,
        confidence,
        searchText: normalizeForSearch([
          entry.name,
          entry.displayName,
          ...entry.aliases,
          ...entry.headings,
          ...entry.descriptions,
          ...entry.offsets,
          ...[...entry.sections.values()].map((section) => section.title),
        ].join("\n")),
        canonicalName: entry.name,
      };
    })
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (a.pages[0] !== b.pages[0]) return a.pages[0] - b.pages[0];
      return a.name.localeCompare(b.name);
    });

  const registerIndexData = {
    schemaVersion: REGISTER_INDEX_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    pageCount: chunkIndex.pageCount,
    chunkCount: chunkIndex.chunkCount || (chunkIndex.chunks || []).length,
    registerCount: registers.length,
    registers,
  };

  const registersPath = safeRegistersIndexPath(filename);
  await atomicWriteJson(registersPath, registerIndexData);

  return registerIndexData;
}

async function loadRegistersIndex(filename) {
  const registersPath = safeRegistersIndexPath(filename);

  if (!(await pathExists(registersPath))) {
    return null;
  }

  try {
    const raw = await fs.readFile(registersPath, "utf-8");
    const indexData = JSON.parse(raw);

    if (indexData.schemaVersion !== REGISTER_INDEX_SCHEMA_VERSION) return null;
    if (indexData.filename !== filename) return null;
    if (!Array.isArray(indexData.registers)) return null;

    const currentSource = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(indexData.source, currentSource)) return null;

    return indexData;
  } catch {
    return null;
  }
}

async function getRegistersIndex(filename, options = {}) {
  const existing = await loadRegistersIndex(filename);
  if (existing) return existing;

  if (options.buildIfMissing === true) {
    const indexData = await loadPdfIndex(filename, { buildIfMissing: true });
    const sectionsIndex = await getSectionsIndex(filename, { buildIfMissing: true });
    return buildRegistersIndex(filename, indexData, sectionsIndex);
  }

  throw new Error(`Registers index not found for ${filename}. Run index_pdf or start_index_pdf first.`);
}

function scoreRegisterIndexEntry(entry, register) {
  const q = tokenizeQuery(register);
  if (!q.normalized && !q.canonical) return 0;

  const canonicalName = entry.canonicalName || normalizeRegisterName(entry.name);
  const aliases = (entry.aliases || []).map((alias) => ({
    raw: alias,
    canonical: normalizeRegisterName(alias),
    normalized: normalizeForSearch(alias),
  }));

  let score = 0;

  if (q.canonical) {
    if (canonicalName === q.canonical) score += 180;
    else if (aliases.some((alias) => alias.canonical === q.canonical)) score += 160;
    else if (canonicalName.endsWith(q.canonical) || q.canonical.endsWith(canonicalName)) score += 85;
    else if (canonicalName.includes(q.canonical) || q.canonical.includes(canonicalName)) score += 45;
  }

  if (q.normalized) {
    if ((entry.searchText || "").includes(q.normalized)) score += 35;
    if (aliases.some((alias) => alias.normalized === q.normalized)) score += 90;
    if (aliases.some((alias) => alias.normalized.includes(q.normalized))) score += 35;
  }

  for (const symbolTerm of q.symbolTerms) {
    if (canonicalName === symbolTerm) score += 80;
    else if (aliases.some((alias) => alias.canonical === symbolTerm)) score += 65;
    else if (canonicalName.includes(symbolTerm)) score += 20;
  }

  score += Math.min(Number(entry.confidence || 0), 99) / 5;
  score += Math.min(Number(entry.occurrenceCount || 0), 15);

  return Math.round(score);
}

async function searchRegistersIndex(filename, register, topK = DEFAULT_TOP_K) {
  const registerIndex = await getRegistersIndex(filename);
  const k = clampTopK(topK);

  const results = registerIndex.registers
    .map((entry) => ({
      ...entry,
      score: scoreRegisterIndexEntry(entry, register),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const aPage = a.pages && a.pages.length ? a.pages[0] : Number.MAX_SAFE_INTEGER;
      const bPage = b.pages && b.pages.length ? b.pages[0] : Number.MAX_SAFE_INTEGER;
      return aPage - bPage;
    })
    .slice(0, k);

  return {
    registerIndex,
    results,
  };
}

function formatRegisterIndexResults(results, query) {
  if (!results.length) {
    return `No register-index results found for "${query}".`;
  }

  return [
    `Register index results for "${query}"`,
    "",
    ...results.map((entry, index) => {
      const bestChunks = (entry.chunks || []).slice(0, 5);
      const pages = (entry.pages || []).join(", ") || "unknown";
      const sections = (entry.sections || [])
        .slice(0, 4)
        .map((section) => `${section.title} (page ${section.page})`)
        .join(" | ") || "none";
      const headings = (entry.headings || []).slice(0, 4).join(" | ") || "none";

      return [
        `Result ${index + 1}`,
        `Register: ${entry.displayName || entry.name}`,
        `Canonical name: ${entry.name}`,
        `Aliases: ${(entry.aliases || []).slice(0, 12).join(", ") || "none"}`,
        `Pages: ${pages}`,
        `Confidence: ${entry.confidence}`,
        `Score: ${entry.score}`,
        `Occurrences: ${entry.occurrenceCount}`,
        `Nearest sections: ${sections}`,
        `Headings: ${headings}`,
        `Related chunks: ${bestChunks.map((chunk) => chunk.id).join(", ") || "none"}`,
        bestChunks.length
          ? `Suggested read: read_pdf_pages(filename="${entry.filename || ""}", start_page=${bestChunks[0].page}, end_page=${Math.min(bestChunks[0].page + DEFAULT_PAGE_RANGE - 1, Math.max(...(entry.pages || [bestChunks[0].page])))})`
          : "Suggested read: none",
        bestChunks.length ? `Best preview:\n${bestChunks[0].preview}` : "Best preview: none",
      ].join("\n");
    }),
  ].join("\n\n---\n\n");
}


function scoreRegisterListEntry(entry, filter) {
  const rawFilter = String(filter || "").trim();

  if (!rawFilter) {
    return Math.round(Number(entry.confidence || 0) + Math.min(Number(entry.occurrenceCount || 0), 20));
  }

  const normalizedFilter = normalizeForSearch(rawFilter);
  const canonicalFilter = normalizeRegisterName(rawFilter);
  const searchText = String(entry.searchText || "");
  const canonicalName = entry.canonicalName || normalizeRegisterName(entry.name);
  const aliases = (entry.aliases || []).map((alias) => ({
    raw: alias,
    canonical: normalizeRegisterName(alias),
    normalized: normalizeForSearch(alias),
  }));

  let score = 0;

  if (canonicalFilter) {
    if (canonicalName === canonicalFilter) score += 180;
    else if (aliases.some((alias) => alias.canonical === canonicalFilter)) score += 160;
    else if (canonicalName.startsWith(canonicalFilter)) score += 95;
    else if (canonicalName.includes(canonicalFilter)) score += 60;
    else if (aliases.some((alias) => alias.canonical.includes(canonicalFilter))) score += 45;
  }

  if (normalizedFilter) {
    if (searchText.includes(normalizedFilter)) score += 35;
    if (aliases.some((alias) => alias.normalized === normalizedFilter)) score += 90;
    if (aliases.some((alias) => alias.normalized.includes(normalizedFilter))) score += 35;
  }

  score += Math.min(Number(entry.confidence || 0), 99) / 8;
  score += Math.min(Number(entry.occurrenceCount || 0), 20);

  return Math.round(score);
}

async function listRegistersFromIndex(filename, options = {}) {
  const registerIndex = await getRegistersIndex(filename);
  const filter = String(options.filter || "").trim();
  const topK = clampRegisterListTopK(options.topK);
  const includeLowConfidence = Boolean(options.includeLowConfidence);

  let registers = (registerIndex.registers || [])
    .filter((entry) => includeLowConfidence || entry.isExplicitRegister || Number(entry.confidence || 0) >= 70)
    .map((entry) => ({
    ...entry,
    score: scoreRegisterListEntry(entry, filter),
  }));

  if (filter) {
    registers = registers.filter((entry) => entry.score > 0);
  }

  registers = registers
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const aPage = a.pages && a.pages.length ? a.pages[0] : Number.MAX_SAFE_INTEGER;
      const bPage = b.pages && b.pages.length ? b.pages[0] : Number.MAX_SAFE_INTEGER;
      if (aPage !== bPage) return aPage - bPage;
      return String(a.name || "").localeCompare(String(b.name || ""));
    })
    .slice(0, topK);

  return {
    registerIndex,
    filter,
    results: registers,
  };
}

function formatRegisterListResults(registerIndex, results, filter) {
  const total = Number(registerIndex.registerCount || (registerIndex.registers || []).length || 0);
  const filterText = String(filter || "").trim();

  if (!results.length) {
    return [
      filterText
        ? `No registers found in ${registerIndex.filename} for filter "${filterText}".`
        : `No registers found in ${registerIndex.filename}.`,
      `Register index path: ${safeRegistersIndexPath(registerIndex.filename)}`,
      "Try index_pdf(filename=..., force=true) to rebuild the register index, or use find_register for a specific symbol.",
    ].join("\n");
  }

  return [
    filterText
      ? `Detected registers in ${registerIndex.filename} matching "${filterText}"`
      : `Detected registers in ${registerIndex.filename}`,
    `Total detected in index: ${total}`,
    `Shown: ${results.length}`,
    `Register index created: ${registerIndex.createdAt}`,
    `Default view: explicit register-list/description entries; pass include_low_confidence=true to include symbol-only candidates.`,
    "",
    ...results.map((entry, index) => {
      const pages = (entry.pages || []).slice(0, 12).join(", ") || "unknown";
      const pageSuffix = (entry.pages || []).length > 12 ? ", ..." : "";
      const sections = (entry.sections || [])
        .slice(0, 2)
        .map((section) => `${section.title} (page ${section.page})`)
        .join(" | ") || "none";
      const bestChunks = (entry.chunks || []).slice(0, 3);
      const chunkIds = bestChunks.map((chunk) => chunk.id).join(", ") || "none";
      const aliases = (entry.aliases || [])
        .filter((alias) => alias !== entry.name && alias !== entry.displayName)
        .slice(0, 8)
        .join(", ") || "none";
      const description = (entry.descriptions || [])[0] || "unknown";
      const offset = (entry.offsetAddresses || [])[0] || "unknown";
      const initialValue = (entry.initialValues || [])[0] || "unknown";
      const accessSize = (entry.accessSizes || [])[0] || "unknown";
      const sourceKinds = (entry.sourceKinds || []).join(", ") || "unknown";
      const firstPage = (entry.pages || [])[0];
      const suggestedRead = firstPage
        ? `read_pdf_pages(filename="${entry.filename || registerIndex.filename}", start_page=${firstPage}, end_page=${Math.min(firstPage + DEFAULT_PAGE_RANGE - 1, registerIndex.pageCount || firstPage)})`
        : "none";

      return [
        `${index + 1}. ${entry.displayName || entry.name}`,
        `   Canonical: ${entry.name}`,
        `   Description: ${description}`,
        `   Offset address: ${offset}`,
        `   Initial value: ${initialValue}`,
        `   Access size: ${accessSize}`,
        `   Pages: ${pages}${pageSuffix}`,
        `   Source: ${sourceKinds}`,
        `   Confidence: ${entry.confidence}`,
        `   Occurrences: ${entry.occurrenceCount}`,
        `   Score: ${entry.score}`,
        `   Aliases: ${aliases}`,
        `   Nearest sections: ${sections}`,
        `   Related chunks: ${chunkIds}`,
        `   Suggested find: find_register(filename="${entry.filename || registerIndex.filename}", register="${entry.name}")`,
        `   Suggested read: ${suggestedRead}`,
      ].join("\n");
    }),
  ].join("\n\n");
}

function buildSearchText(chunk) {
  return [
    chunk.text || "",
    ...(chunk.headings || []),
    ...(chunk.registers || []),
    ...(chunk.bitFields || []),
  ].join("\n");
}

async function buildPdfIndex(filename, options = {}) {
  return withIndexBuildLock(filename, {
    forceLock: Boolean(options.forceLock),
  }, async () => {
    await fs.mkdir(INDEX_DIR, { recursive: true });
    await getFileStat(filename);

    const chunkSize = clampChunkSize(options.chunkSize);
    const chunkOverlap = clampChunkOverlap(options.chunkOverlap, chunkSize);

    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    if (onProgress) onProgress({ phase: "start", current: 0, total: 0, unit: "" });

    let pageCache = null;
    if (options.reusePageCache !== false) pageCache = await loadPagesCache(filename);
    if (!pageCache) {
      if (onProgress) onProgress({ phase: "build-pages-cache", current: 0, total: 0, unit: "" });
      pageCache = await buildPagesCache(filename, { onProgress });
    } else if (onProgress) {
      onProgress({ phase: "reuse-pages-cache", current: pageCache.pageCount, total: pageCache.pageCount, unit: "pages" });
    }

  const pdfData = {
    filename,
    pageCount: pageCache.pageCount,
    pages: pageCache.pages,
  };

  const pdfStat = await getFileStat(filename);
  const sectionsIndex = await buildSectionsIndex(filename, pageCache);
  const chunks = [];

  for (const page of pdfData.pages) {
    if (onProgress && (page.page === 1 || page.page === pdfData.pageCount || page.page % 25 === 0)) {
      onProgress({ phase: "chunk-pages", current: page.page, total: pdfData.pageCount, unit: "pages" });
    }
    const pageHeadings = detectHeadings(page.text);
    const pageChunks = chunkText(page.text, chunkSize, chunkOverlap);

    pageChunks.forEach((chunkTextValue, index) => {
      const headings = [...new Set([...pageHeadings, ...detectHeadings(chunkTextValue)])].slice(0, 12);
      const registers = detectRegisters(chunkTextValue);
      const bitFields = detectBitFields(chunkTextValue);
      const id = `${filename}:p${page.page}:c${index}`;
      const chunkProfile = classifyChunkProfile(chunkTextValue, {
        headings,
        registers,
        bitFields,
        page: page.page,
      });

      chunks.push({
        id,
        filename,
        page: page.page,
        chunkIndex: index,
        headings,
        registers,
        bitFields,
        chunkType: chunkProfile.chunkType,
        chunkTypes: chunkProfile.chunkTypes,
        chunkTypeSignals: chunkProfile.signals,
        noiseScore: chunkProfile.noiseScore,
        contentScore: chunkProfile.contentScore,
        text: chunkTextValue,
        searchText: normalizeForSearch([chunkTextValue, ...headings, ...registers, ...bitFields, chunkProfile.chunkType, ...(chunkProfile.chunkTypes || [])].join("\n")),
        symbols: [...new Set([...registers, ...bitFields].map(canonicalSymbol).filter(Boolean))],
      });
    });
  }

  const indexData = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    sourceSize: pdfStat.size,
    sourceModifiedMs: pdfStat.mtimeMs,
    pageCount: pdfData.pageCount,
    chunkCount: chunks.length,
    chunkTypeStats: summarizeChunkTypes(chunks),
    chunkSize,
    chunkOverlap,
    sectionCount: sectionsIndex.sectionCount,
    registerCount: 0,
    chunks,
  };

  if (onProgress) onProgress({ phase: "build-registers-index", current: 0, total: 0, unit: "" });
  const registersIndex = await buildRegistersIndex(filename, indexData, sectionsIndex);
  indexData.registerCount = registersIndex.registerCount;

  if (onProgress) onProgress({ phase: "build-bitfields-index", current: 0, total: 0, unit: "" });
  const bitfieldsIndex = await buildBitfieldsIndex(filename, indexData, registersIndex);
  indexData.bitfieldCount = bitfieldsIndex.bitfieldCount;

  if (onProgress) onProgress({ phase: "build-sequences-index", current: 0, total: 0, unit: "" });
  const sequencesIndex = await buildSequencesIndex(filename, indexData, sectionsIndex, registersIndex);
  indexData.sequenceCount = sequencesIndex.sequenceCount;

  if (onProgress) onProgress({ phase: "build-cautions-index", current: 0, total: 0, unit: "" });
  const cautionsIndex = await buildCautionsIndex(filename, indexData, sectionsIndex, registersIndex);
  indexData.cautionCount = cautionsIndex.cautionCount;

  if (onProgress) onProgress({ phase: "build-figures-index", current: 0, total: 0, unit: "" });
  const figuresIndex = await buildFiguresIndex(filename, pageCache);
  indexData.figureCount = figuresIndex.figureCount;

    if (onProgress) onProgress({ phase: "write-index", current: 0, total: 0, unit: "" });
    const indexPath = safeIndexPath(filename);
    await atomicWriteJson(indexPath, indexData);
    await writeArtifactManifest(filename, { buildStatus: "ready", notes: ["full index build completed"] });

    return indexData;
  });
}

function isIndexUsable(indexData, pdfStat) {
  if (!indexData || typeof indexData !== "object") return false;
  if (indexData.schemaVersion !== INDEX_SCHEMA_VERSION) return false;
  if (!Array.isArray(indexData.chunks)) return false;
  if (Number(indexData.sourceSize) !== Number(pdfStat.size)) return false;

  const indexedMtime = Number(indexData.sourceModifiedMs || 0);
  if (!Number.isFinite(indexedMtime) || indexedMtime <= 0) return false;

  // Some filesystems have coarse mtime resolution, so allow a small delta.
  return Math.abs(indexedMtime - Number(pdfStat.mtimeMs)) < 1500;
}

async function loadPdfIndex(filename, options = {}) {
  const indexPath = safeIndexPath(filename);
  const pdfStat = await getFileStat(filename);

  if (!(await pathExists(indexPath))) {
    if (options.buildIfMissing === true) {
      return buildPdfIndex(filename, options.buildOptions || {});
    }
    throw new Error(`Index not found for ${filename}. Run index_pdf or start_index_pdf first. Large manuals should be indexed in background with start_index_pdf.`);
  }

  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const indexData = JSON.parse(raw);

    if (isIndexUsable(indexData, pdfStat)) return indexData;

    if (options.rebuildIfStale === true) {
      return buildPdfIndex(filename, options.buildOptions || {});
    }

    throw new Error(
      `Index is stale or incompatible for ${filename}. Run index_pdf with force=true or start_index_pdf. Large manuals should be indexed in background.`
    );
  } catch (error) {
    if (options.rebuildIfBroken === true) return buildPdfIndex(filename, options.buildOptions || {});
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------

function tokenizeQuery(query) {
  const raw = String(query || "").trim();
  const normalized = normalizeForSearch(raw);
  const canonical = canonicalSymbol(raw);

  const terms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);

  const symbolTerms = raw
    .split(/[\s,;:/()\[\]{}]+/)
    .map(canonicalSymbol)
    .filter((term) => term.length >= 2);

  return {
    raw,
    normalized,
    canonical,
    terms: [...new Set(terms)],
    symbolTerms: [...new Set(symbolTerms)],
  };
}

function countWordOccurrences(text, term) {
  if (!term) return 0;
  const escaped = escapeRegExp(term);
  return (text.match(new RegExp(`\\b${escaped}\\b`, "g")) || []).length;
}

function countLooseOccurrences(text, term) {
  if (!term) return 0;
  return text.split(term).length - 1;
}

function scoreChunk(chunk, query) {
  const q = tokenizeQuery(query);
  if (!q.normalized && !q.canonical) return 0;

  const rawText = buildSearchText(chunk);
  const text = chunk.searchText || normalizeForSearch(rawText);
  const symbols = new Set((chunk.symbols || []).map(canonicalSymbol));
  const headingText = normalizeForSearch((chunk.headings || []).join("\n"));
  const registerText = normalizeForSearch((chunk.registers || []).join("\n"));
  const bitFieldText = normalizeForSearch((chunk.bitFields || []).join("\n"));

  let score = 0;

  if (q.normalized) {
    if (text.includes(q.normalized)) score += 70;
    if (headingText.includes(q.normalized)) score += 45;
    if (registerText.includes(q.normalized)) score += 90;
    if (bitFieldText.includes(q.normalized)) score += 60;
  }

  if (q.canonical) {
    if (symbols.has(q.canonical)) score += 120;

    for (const symbol of symbols) {
      if (symbol.includes(q.canonical) || q.canonical.includes(symbol)) score += 25;
    }
  }

  for (const symbolTerm of q.symbolTerms) {
    if (symbols.has(symbolTerm)) score += 60;
  }

  for (const term of q.terms) {
    const exactCount = countWordOccurrences(text, term);
    const looseCount = countLooseOccurrences(text, term);

    score += exactCount * 10;
    score += looseCount * 2;

    if (headingText.includes(term)) score += 12;
    if (registerText.includes(term)) score += 20;
    if (bitFieldText.includes(term)) score += 14;
  }

  // Prefer register-description style chunks in hardware manuals.
  if (/\bAddress\s*:?\b/i.test(rawText)) score += 8;
  if (/\bOffset\s*:?\b/i.test(rawText)) score += 5;
  if (/\bAccess\s+Size\s*:?\b/i.test(rawText)) score += 8;
  if (/\bInitial\s+Value\s*:?\b/i.test(rawText)) score += 8;
  if (/\bBit\s+Name\b/i.test(rawText)) score += 10;
  if (/\bDescription\b/i.test(rawText)) score += 3;

  return score;
}

async function searchPdfIndex(filename, query, topK = DEFAULT_TOP_K) {
  const indexData = await loadPdfIndex(filename);
  const k = clampTopK(topK);

  const results = indexData.chunks
    .map((chunk) => ({
      ...chunk,
      score: scoreChunk(chunk, query),
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, k);

  return {
    indexData,
    results,
  };
}

function clampHybridTopK(value) {
  return clampInteger(value, DEFAULT_HYBRID_TOP_K, 1, MAX_HYBRID_TOP_K);
}

const HYBRID_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from",
  "how", "i", "if", "in", "into", "is", "it", "me", "of", "on", "or",
  "please", "the", "this", "to", "use", "using", "what", "when", "where",
  "which", "with", "write", "read", "get", "set", "find"
]);

const HYBRID_SYNONYM_GROUPS = [
  ["start", "enable", "activate", "run", "kick", "trigger", "seten", "tstart", "issue", "pending"],
  ["stop", "disable", "halt", "terminate", "abort", "pause", "suspend", "clren", "clrrq"],
  ["clear", "ack", "acknowledge", "reset flag", "clear flag", "clear status", "w1c", "w0c", "write one", "write zero"],
  ["interrupt", "irq", "isr", "event", "interrupt request", "interrupt status"],
  ["error", "fault", "abnormal", "bus error", "err", "overflow", "underflow"],
  ["initialize", "initialise", "initialization", "initialisation", "init", "setup", "configure", "configuration", "setting"],
  ["reset", "software reset", "module reset", "swrst", "rst", "reset release"],
  ["status", "flag", "state", "condition", "result"],
  ["register", "reg", "abbreviation", "offset", "address", "initial value", "reset value", "access size"],
  ["bitfield", "bit field", "field", "bit", "mask", "shift", "bit name"],
  ["caution", "note", "restriction", "prohibited", "forbidden", "undefined", "invalid", "reserved", "do not", "must not"],
  ["transfer complete", "transfer end", "tc", "end", "completion", "done"],
  ["read modify write", "rmw", "preserve", "reserved bits", "write back", "mask"],
];

const HYBRID_SYMBOL_ALIAS_GROUPS = [
  ["IRQ", "INT", "INTERRUPT"],
  ["ERR", "ER", "ERROR"],
  ["TC", "TRANSFERCOMPLETE", "TRANSFEREND", "END"],
  ["EN", "ENABLE", "SETEN", "START"],
  ["DIS", "DISABLE", "CLREN", "STOP"],
  ["SUS", "SUSPEND", "SUSPENDED"],
  ["RST", "RESET", "SWRST"],
  ["STAT", "STATUS", "SR"],
  ["CTRL", "CONTROL", "CR"],
  ["CFG", "CONFIG", "CONFIGURATION"],
];

const HYBRID_SYNONYM_MAP = buildHybridSynonymMap(HYBRID_SYNONYM_GROUPS);
const HYBRID_SYMBOL_ALIAS_MAP = buildHybridSymbolAliasMap(HYBRID_SYMBOL_ALIAS_GROUPS);

function classifyHybridIntents(query, forcedIntent = "auto") {
  const normalized = normalizeForSearch(query);
  const canonical = canonicalSymbol(query);
  const intents = new Set();

  const forced = String(forcedIntent || "auto").trim().toLowerCase();
  if (forced && forced !== "auto") intents.add(forced);

  if (/\b(register|offset|address|initial value|reset value|access size|abbreviation)\b/i.test(normalized)) intents.add("register");
  if (/\b(bit|bits|bitfield|field|mask|bit name|r\/w|rw|write only|read only)\b/i.test(normalized)) intents.add("bitfield");
  if (/\b(sequence|procedure|flow|operation|step|steps|before|after|start|stop|enable|disable|init|initialize|configuration|configure|reset|clear|interrupt|irq|error)\b/i.test(normalized)) intents.add("sequence");
  if (/\b(caution|note|restriction|prohibited|forbidden|undefined|invalid|reserved|must|do not|only when|write 1|write one|write 0|write zero|w1c|w0c)\b/i.test(normalized)) intents.add("caution");
  if (/\b(section|chapter|paragraph|overview|description)\b/i.test(normalized)) intents.add("section");
  if (/\b(table|list of registers|register list|register map|column|row)\b/i.test(normalized)) intents.add("table");

  if (/\b(init|initial|initialize|initialization|setup|setting|configure|configuration)\b/i.test(normalized)) intents.add("init");
  if (/\b(start|enable|run|trigger|request|activate|resume|seten|tstart)\b/i.test(normalized) || /SETEN|TSTART/.test(canonical)) intents.add("start");
  if (/\b(stop|disable|halt|suspend|pause|cancel|terminate|abort|clren|clrrq)\b/i.test(normalized) || /CLREN|CLRRQ|SUSP/.test(canonical)) intents.add("stop");
  if (/\b(clear|ack|acknowledge|status|flag|complete|completion|done|end|w1c|w0c|write 1|write one|write 0|write zero)\b/i.test(normalized)) intents.add("clear");
  if (/\b(reset|software reset|swrst|module reset|rst)\b/i.test(normalized) || /SWRST|RESET/.test(canonical)) intents.add("reset");
  if (/\b(interrupt|irq|request|event|status)\b/i.test(normalized)) intents.add("irq");
  if (/\b(error|err|fault|bus error|overflow|underflow|abnormal)\b/i.test(normalized)) intents.add("error");

  if (!intents.size) intents.add("generic");
  return [...intents];
}

function buildHybridIntentTerms(intents) {
  const terms = new Set();
  const add = (...values) => {
    for (const value of values) {
      const normalized = normalizeForSearch(value);
      if (!normalized) continue;
      for (const term of normalized.split(/\s+/)) {
        if (term.length > 1 && !HYBRID_STOP_WORDS.has(term)) terms.add(term);
      }
    }
  };

  for (const intent of intents) {
    if (intent === "register") add("register", "register name", "abbreviation", "offset", "address", "initial value", "reset value", "access size");
    if (intent === "bitfield") add("bit", "bit name", "bit field", "field", "mask", "description", "r w", "read only", "write only");
    if (intent === "sequence" || intent === "init") add("sequence", "procedure", "operation", "setting", "initial", "initialize", "configure", "configuration", "before", "after");
    if (intent === "start") add("start", "enable", "run", "trigger", "request", "activate", "resume", "seten", "tstart");
    if (intent === "stop") add("stop", "disable", "halt", "suspend", "pause", "terminate", "abort", "clren", "clrrq");
    if (intent === "clear") add("clear", "status", "flag", "acknowledge", "write 1", "write one", "write 0", "write zero", "w1c", "w0c", "end", "complete");
    if (intent === "reset") add("reset", "software reset", "module reset", "swrst", "rst");
    if (intent === "irq") add("interrupt", "irq", "event", "request", "status", "enable interrupt", "interrupt status");
    if (intent === "error") add("error", "fault", "bus error", "abnormal", "overflow", "underflow", "err");
    if (intent === "caution") add("caution", "note", "restriction", "prohibited", "forbidden", "undefined", "invalid", "reserved", "must", "do not", "only when");
    if (intent === "section") add("section", "chapter", "overview", "description", "operation", "register description");
    if (intent === "table") add("table", "row", "column", "register name", "abbreviation", "offset address", "access size", "bit name");
  }

  return [...terms];
}

function buildHybridSynonymMap(groups) {
  const map = new Map();
  for (const group of groups || []) {
    const expanded = new Set();
    for (const phrase of group) {
      const normalizedPhrase = normalizeForSearch(phrase);
      if (normalizedPhrase) expanded.add(normalizedPhrase);
      for (const token of normalizedPhrase.split(/\s+/)) {
        if (token && !HYBRID_STOP_WORDS.has(token)) expanded.add(token);
      }
    }
    const values = [...expanded];
    for (const value of values) {
      if (!map.has(value)) map.set(value, new Set());
      for (const alias of values) if (alias !== value) map.get(value).add(alias);
    }
  }
  return map;
}

function buildHybridSymbolAliasMap(groups) {
  const map = new Map();
  for (const group of groups || []) {
    const values = [...new Set(group.map(canonicalSymbol).filter(Boolean))];
    for (const value of values) {
      if (!map.has(value)) map.set(value, new Set());
      for (const alias of values) if (alias !== value) map.get(value).add(alias);
    }
  }
  return map;
}

function expandHybridSynonyms(terms, limit = 120) {
  const expanded = new Set();
  for (const term of terms || []) {
    const normalized = normalizeForSearch(term);
    if (!normalized || HYBRID_STOP_WORDS.has(normalized)) continue;
    expanded.add(normalized);
    const aliases = HYBRID_SYNONYM_MAP.get(normalized);
    if (aliases) for (const alias of aliases) expanded.add(alias);
  }
  return [...expanded].slice(0, limit);
}

function expandHybridSymbolAliases(symbolTerms, limit = 80) {
  const expanded = new Set();
  for (const symbol of symbolTerms || []) {
    const canonical = canonicalSymbol(symbol);
    if (!canonical) continue;
    expanded.add(canonical);
    const aliases = HYBRID_SYMBOL_ALIAS_MAP.get(canonical);
    if (aliases) for (const alias of aliases) expanded.add(alias);

    // Common hardware-manual convention: CHCTRL, CHSTAT, DST_END, etc.
    if (canonical.includes("INT")) expanded.add(canonical.replace(/INT/g, "IRQ"));
    if (canonical.includes("IRQ")) expanded.add(canonical.replace(/IRQ/g, "INT"));
    if (canonical.includes("CTRL")) expanded.add(canonical.replace(/CTRL/g, "CONTROL"));
    if (canonical.includes("STAT")) expanded.add(canonical.replace(/STAT/g, "STATUS"));
  }
  return [...expanded].slice(0, limit);
}

function hybridTermWeight(term, hybrid) {
  if (!term) return 1;
  if ((hybrid.terms || []).includes(term)) return 2.4;
  if ((hybrid.importantTerms || []).includes(term)) return 2.0;
  if ((hybrid.intentTerms || []).includes(term)) return 1.15;
  return 0.9;
}

function tokenizeHybridText(text) {
  return normalizeForSearch(text)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1 && !HYBRID_STOP_WORDS.has(term));
}

function uniqueArray(values, limit = 200) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }

  return previous[b.length];
}

function fuzzySimilarity(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right) return 0;
  if (left === right) return 1;
  const maxLength = Math.max(left.length, right.length);
  if (maxLength <= 2) return 0;
  return 1 - levenshteinDistance(left, right) / maxLength;
}

function buildHybridQuery(query, options = {}) {
  const q = tokenizeQuery(query);
  const intents = classifyHybridIntents(query, options.intent || "auto");
  const intentTerms = buildHybridIntentTerms(intents);
  const queryTerms = q.terms.filter((term) => !HYBRID_STOP_WORDS.has(term));
  const synonymTerms = expandHybridSynonyms([...queryTerms, ...intentTerms], 140);
  const symbolAliasTerms = expandHybridSymbolAliases(q.symbolTerms, 80);
  const symbolAliasTextTerms = symbolAliasTerms.map((term) => normalizeForSearch(term)).filter(Boolean);
  const allTerms = uniqueArray([...queryTerms, ...intentTerms, ...synonymTerms, ...symbolAliasTextTerms], 140);
  const importantTerms = uniqueArray([...queryTerms, ...q.symbolTerms.map((term) => normalizeForSearch(term)).filter(Boolean), ...symbolAliasTextTerms], 90);

  return {
    raw: q.raw,
    normalized: q.normalized,
    canonical: q.canonical,
    terms: queryTerms,
    intentTerms,
    synonymTerms,
    allTerms,
    importantTerms,
    symbolTerms: q.symbolTerms,
    symbolAliasTerms,
    intents,
    register: String(options.register || "").trim(),
    registerCanonical: normalizeRegisterName(options.register || ""),
  };
}

async function buildHybridContext(filename, hybrid) {
  const context = {
    registerMatches: [],
    sectionMatches: [],
    sequenceMatches: [],
    cautionMatches: [],
    relatedChunkIds: new Set(),
    relatedPages: new Set(),
    relatedRegisters: new Set(),
  };

  if (hybrid.register) {
    try {
      const { results } = await searchRegistersIndex(filename, hybrid.register, 6);
      context.registerMatches = results;
      for (const entry of results) {
        for (const page of entry.pages || []) context.relatedPages.add(page);
        for (const chunk of entry.chunks || []) {
          if (chunk.id) context.relatedChunkIds.add(chunk.id);
          if (chunk.page) context.relatedPages.add(chunk.page);
        }
        context.relatedRegisters.add(entry.name);
        for (const alias of entry.aliases || []) context.relatedRegisters.add(alias);
      }
    } catch {
      // Register index is optional for hybrid search.
    }
  }

  try {
    const { results } = await searchSectionsIndex(filename, hybrid.raw, 8);
    context.sectionMatches = results;
    for (const section of results.slice(0, 5)) {
      if (section.page) context.relatedPages.add(section.page);
    }
  } catch {
    // Section index is optional for hybrid search.
  }

  if (hybrid.intents.some((intent) => ["sequence", "init", "start", "stop", "clear", "reset", "irq", "error"].includes(intent))) {
    try {
      const sequencesIndex = await loadSequencesIndex(filename);
      if (!sequencesIndex) throw new Error("sequences index not available");
      context.sequenceMatches = (sequencesIndex.sequences || [])
        .map((sequence) => ({
          ...sequence,
          score: scoreSequenceEntry(sequence, hybrid.raw, hybrid.register),
        }))
        .filter((sequence) => sequence.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      for (const sequence of context.sequenceMatches) {
        for (const page of sequence.pages || []) context.relatedPages.add(page);
        for (const chunk of sequence.chunks || []) {
          if (chunk.id) context.relatedChunkIds.add(chunk.id);
          if (chunk.page) context.relatedPages.add(chunk.page);
        }
        for (const reg of sequence.relatedRegisters || []) context.relatedRegisters.add(reg);
      }
    } catch {
      // Sequence index is optional for hybrid search.
    }
  }

  if (hybrid.intents.some((intent) => ["caution", "clear", "reset", "irq", "error"].includes(intent))) {
    try {
      const cautionsIndex = await loadCautionsIndex(filename);
      if (!cautionsIndex) throw new Error("cautions index not available");
      context.cautionMatches = (cautionsIndex.cautions || [])
        .filter((caution) => cautionMatchesFilter(caution, hybrid.raw, hybrid.register, ""))
        .map((caution) => ({
          ...caution,
          score: scoreSimpleText([
            caution.topic,
            caution.type,
            caution.riskForDriver,
            ...(caution.evidenceLines || []),
            ...(caution.relatedRegisters || []),
          ].join("\n"), hybrid.raw),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      for (const caution of context.cautionMatches) {
        for (const page of caution.pages || []) context.relatedPages.add(page);
        for (const chunk of caution.chunks || []) {
          if (chunk.id) context.relatedChunkIds.add(chunk.id);
          if (chunk.page) context.relatedPages.add(chunk.page);
        }
        for (const reg of caution.relatedRegisters || []) context.relatedRegisters.add(reg);
      }
    } catch {
      // Caution index is optional for hybrid search.
    }
  }

  return context;
}

function extractHybridEvidenceLines(text, hybrid, maxLines = 6) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => normalizeText(line))
    .filter((line) => line.length >= 3);

  const evidence = [];
  const terms = uniqueArray([...hybrid.importantTerms, ...hybrid.allTerms], 40);

  for (const line of lines) {
    const normalized = normalizeForSearch(line);
    if (!normalized) continue;

    let score = 0;
    if (hybrid.normalized && normalized.includes(hybrid.normalized)) score += 80;
    for (const term of terms) {
      if (normalized.includes(term)) score += hybrid.importantTerms.includes(term) ? 14 : 6;
    }
    if (hybrid.registerCanonical && canonicalSymbol(line).includes(hybrid.registerCanonical)) score += 40;
    if (score <= 0) continue;

    evidence.push({ line, score });
  }

  return evidence
    .sort((a, b) => b.score - a.score)
    .map((item) => item.line)
    .filter((line, index, arr) => arr.indexOf(line) === index)
    .slice(0, maxLines);
}

function buildHybridCorpusStats(chunks, hybrid) {
  const terms = uniqueArray([...(hybrid.allTerms || []), ...(hybrid.importantTerms || [])], 160);
  const documents = [];
  const documentFrequency = new Map();
  let totalLength = 0;

  for (const chunk of chunks || []) {
    const tokens = tokenizeHybridText(buildSearchText(chunk));
    const tokenCounts = new Map();
    for (const token of tokens) tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    totalLength += tokens.length;
    documents.push({ id: chunk.id, length: tokens.length || 1, tokenCounts });

    for (const term of terms) {
      if (tokenCounts.has(term)) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  return {
    documentCount: Math.max(1, documents.length),
    averageLength: documents.length ? Math.max(1, totalLength / documents.length) : 1,
    terms,
    documentFrequency,
    documents: new Map(documents.map((doc) => [doc.id, doc])),
  };
}

function scoreHybridBm25(chunk, hybrid, stats) {
  if (!stats || !stats.documents) return { score: 0, hits: 0 };
  const doc = stats.documents.get(chunk.id);
  if (!doc) return { score: 0, hits: 0 };

  let score = 0;
  let hits = 0;
  const N = stats.documentCount;
  const avgdl = stats.averageLength;
  const dl = doc.length || 1;

  for (const term of stats.terms || []) {
    const tf = doc.tokenCounts.get(term) || 0;
    if (!tf) continue;
    const df = stats.documentFrequency.get(term) || 0;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const numerator = tf * (HYBRID_BM25_K1 + 1);
    const denominator = tf + HYBRID_BM25_K1 * (1 - HYBRID_BM25_B + HYBRID_BM25_B * dl / avgdl);
    score += idf * (numerator / denominator) * hybridTermWeight(term, hybrid);
    hits++;
  }

  return {
    score: Math.round(score * HYBRID_BM25_WEIGHT),
    hits,
  };
}

function tokenPositions(tokens, terms) {
  const wanted = new Set(terms || []);
  const positions = new Map();
  tokens.forEach((token, index) => {
    if (!wanted.has(token)) return;
    if (!positions.has(token)) positions.set(token, []);
    positions.get(token).push(index);
  });
  return positions;
}

function scoreHybridProximity(rawText, hybrid) {
  const queryTerms = uniqueArray((hybrid.importantTerms || []).filter((term) => term.length > 1), 24);
  if (queryTerms.length < 2) return { score: 0, pairs: 0 };

  const tokens = tokenizeHybridText(rawText);
  const positions = tokenPositions(tokens, queryTerms);
  const presentTerms = queryTerms.filter((term) => positions.has(term));
  if (presentTerms.length < 2) return { score: 0, pairs: 0 };

  let bestDistance = Number.POSITIVE_INFINITY;
  let pairCount = 0;
  for (let i = 0; i < presentTerms.length; i++) {
    for (let j = i + 1; j < presentTerms.length; j++) {
      const left = positions.get(presentTerms[i]) || [];
      const right = positions.get(presentTerms[j]) || [];
      for (const a of left.slice(0, 12)) {
        for (const b of right.slice(0, 12)) {
          const distance = Math.abs(a - b);
          if (distance <= HYBRID_PROXIMITY_WINDOW) {
            pairCount++;
            if (distance < bestDistance) bestDistance = distance;
          }
        }
      }
    }
  }

  if (!pairCount) return { score: 0, pairs: 0 };
  const closeness = Math.max(0, HYBRID_PROXIMITY_WINDOW - Math.min(bestDistance, HYBRID_PROXIMITY_WINDOW));
  return {
    score: Math.min(120, pairCount * 8 + closeness * HYBRID_PROXIMITY_WEIGHT / HYBRID_PROXIMITY_WINDOW),
    pairs: pairCount,
  };
}

function scoreHybridSymbolAliases(chunk, hybrid) {
  const chunkSymbols = new Set((chunk.symbols || []).map(canonicalSymbol));
  const chunkCanonical = canonicalSymbol([
    ...(chunk.registers || []),
    ...(chunk.bitFields || []),
    ...(chunk.headings || []),
    chunk.text || "",
  ].join("\n"));

  let score = 0;
  let hits = 0;
  for (const alias of hybrid.symbolAliasTerms || []) {
    if (!alias) continue;
    if (chunkSymbols.has(alias) || chunkCanonical.includes(alias)) {
      score += 45;
      hits++;
    }
  }

  return { score: Math.min(score, 180), hits };
}

function scoreHybridChunk(chunk, hybrid, context) {
  const rawText = buildSearchText(chunk);
  const text = chunk.searchText || normalizeForSearch(rawText);
  const textTokens = uniqueArray(tokenizeHybridText(rawText), 500);
  const textTokenSet = new Set(textTokens);
  const symbols = new Set((chunk.symbols || []).map(canonicalSymbol));
  const registerText = normalizeForSearch((chunk.registers || []).join(" "));
  const bitFieldText = normalizeForSearch((chunk.bitFields || []).join(" "));
  const headingText = normalizeForSearch((chunk.headings || []).join(" "));
  const rawLower = String(chunk.text || "").toLowerCase();

  let score = scoreChunk(chunk, hybrid.raw);
  const reasons = [];

  const chunkTypeAdjustment = chunkTypeAdjustmentForHybrid(chunk, hybrid);
  if (chunkTypeAdjustment.score) score += chunkTypeAdjustment.score;
  for (const reason of chunkTypeAdjustment.reasons) reasons.push(reason);

  const bm25 = scoreHybridBm25(chunk, hybrid, context.bm25Stats);
  if (bm25.score > 0) {
    score += bm25.score;
    reasons.push(`bm25 ${bm25.score}/${bm25.hits}`);
  }

  const proximity = scoreHybridProximity(rawText, hybrid);
  if (proximity.score > 0) {
    score += proximity.score;
    reasons.push(`proximity ${Math.round(proximity.score)}/${proximity.pairs}`);
  }

  const aliasScore = scoreHybridSymbolAliases(chunk, hybrid);
  if (aliasScore.score > 0) {
    score += aliasScore.score;
    reasons.push(`symbol aliases ${aliasScore.hits}`);
  }

  if (hybrid.normalized && text.includes(hybrid.normalized)) {
    score += 130;
    reasons.push("exact phrase");
  }

  if (hybrid.canonical && symbols.has(hybrid.canonical)) {
    score += 160;
    reasons.push("exact symbol");
  }

  let importantHits = 0;
  for (const term of hybrid.importantTerms) {
    if (!term) continue;
    if (textTokenSet.has(term) || text.includes(term)) importantHits++;
  }

  const coverage = hybrid.importantTerms.length ? importantHits / hybrid.importantTerms.length : 0;
  if (coverage > 0) {
    score += Math.round(coverage * 120);
    reasons.push(`query coverage ${Math.round(coverage * 100)}%`);
  }

  let intentHits = 0;
  for (const term of hybrid.allTerms) {
    if (!term) continue;
    if (textTokenSet.has(term)) {
      intentHits++;
      score += 4;
    } else if (text.includes(term)) {
      intentHits++;
      score += 2;
    }
  }
  if (intentHits) reasons.push(`expanded terms ${intentHits}`);

  let fuzzyHits = 0;
  const fuzzyTerms = hybrid.importantTerms.filter((term) => term.length >= 4).slice(0, 12);
  for (const term of fuzzyTerms) {
    if (textTokenSet.has(term)) continue;
    if (textTokens.some((candidate) => Math.abs(candidate.length - term.length) <= 2 && fuzzySimilarity(term, candidate) >= 0.86)) {
      fuzzyHits++;
      score += 12;
    }
  }
  if (fuzzyHits) reasons.push(`fuzzy terms ${fuzzyHits}`);

  if (hybrid.registerCanonical) {
    const chunkCanonicalText = canonicalSymbol([
      chunk.text || "",
      ...(chunk.registers || []),
      ...(chunk.headings || []),
      ...(chunk.bitFields || []),
    ].join("\n"));

    if (chunkCanonicalText.includes(hybrid.registerCanonical)) {
      score += 170;
      reasons.push("register context");
    }
  }

  if (context.relatedChunkIds.has(chunk.id)) {
    score += 180;
    reasons.push("persistent-index related chunk");
  }

  if (context.relatedPages.has(chunk.page)) {
    score += 45;
    reasons.push("persistent-index related page");
  }

  for (const reg of context.relatedRegisters) {
    const canonicalReg = normalizeRegisterName(reg);
    if (canonicalReg && symbols.has(canonicalReg)) {
      score += 30;
      reasons.push("related register symbol");
      break;
    }
  }

  if (hybrid.intents.includes("register")) {
    if (/\b(Register Name|Abbreviation|Offset Address|Address|Initial Value|Access Size)\b/i.test(rawText)) {
      score += 70;
      reasons.push("register-table language");
    }
  }

  if (hybrid.intents.includes("bitfield")) {
    if (/\b(Bit Name|Bit|Description|R\/W|Initial Value|Access)\b/i.test(rawText)) {
      score += 70;
      reasons.push("bitfield-table language");
    }
  }

  if (hybrid.intents.some((intent) => ["sequence", "init", "start", "stop", "clear", "reset", "irq", "error"].includes(intent))) {
    if (/\b(sequence|procedure|operation|setting|start|stop|enable|disable|clear|reset|interrupt|status|request|error)\b/i.test(rawText)) {
      score += 60;
      reasons.push("operation-flow language");
    }
    if (/\b(before|after|when|must|should|first|then|following|steps?)\b/i.test(rawText)) {
      score += 35;
      reasons.push("ordering language");
    }
  }

  if (hybrid.intents.includes("caution")) {
    if (/\b(Caution|Note|Restriction|Prohibited|Forbidden|Undefined|Invalid|Reserved|must|do not|only when)\b/i.test(rawText)) {
      score += 90;
      reasons.push("caution language");
    }
    if (/write\s+(?:1|one|0|zero)|write-?1|write-?0|W1C|W0C/i.test(rawText)) {
      score += 55;
      reasons.push("clear/write semantics");
    }
  }

  if (hybrid.intents.includes("section") && headingText) {
    score += 25;
    reasons.push("heading match candidate");
  }

  if (hybrid.intents.includes("table")) {
    const tableSignals = (rawText.match(/\b(Register Name|Abbreviation|Offset|Bit Name|Access Size|Initial Value|Description)\b/gi) || []).length;
    if (tableSignals) {
      score += Math.min(tableSignals * 16, 90);
      reasons.push("table signals");
    }
  }

  // Very short chunks with many keyword hits are usually headings/tables and can be useful,
  // but empty/noisy chunks should not dominate.
  if (String(chunk.text || "").length < 80) score -= 25;
  if (/\b(Revision|Contents|Index)\b/i.test(rawText) && !hybrid.intents.includes("section")) score -= 20;

  const evidenceLines = extractHybridEvidenceLines(chunk.text || "", hybrid, 6);
  if (evidenceLines.length) {
    score += Math.min(evidenceLines.length * 10, 40);
    reasons.push("evidence lines");
  }

  return {
    score: Math.round(score),
    reasons: uniqueArray(reasons, 12),
    evidenceLines,
  };
}

async function hybridSearchPdf(filename, query, options = {}) {
  const indexData = await loadPdfIndex(filename);
  const topK = clampHybridTopK(options.topK);
  const hybrid = buildHybridQuery(query, {
    intent: options.intent || "auto",
    register: options.register || "",
  });

  const context = await buildHybridContext(filename, hybrid);
  context.pageCount = indexData.pageCount;
  context.bm25Stats = buildHybridCorpusStats(indexData.chunks || [], hybrid);

  const results = indexData.chunks
    .map((chunk) => {
      const scored = scoreHybridChunk(chunk, hybrid, context);
      return {
        ...chunk,
        score: scored.score,
        hybridReasons: scored.reasons,
        hybridEvidenceLines: scored.evidenceLines,
      };
    })
    .filter((chunk) => chunk.score >= HYBRID_MIN_SCORE)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, topK);

  return {
    filename,
    query,
    intent: hybrid.intents,
    register: hybrid.register,
    expandedTerms: hybrid.allTerms,
    context,
    results,
  };
}


function buildHybridSearchEvidenceContract(payload) {
  const evidence = [];
  const inference = [];
  const needsVerification = [];
  for (const result of (payload.results || []).slice(0, 10)) {
    const quote = (result.hybridEvidenceLines || [])[0] || result.text || "";
    evidence.push(evidenceFromChunk(result, quote, { tool: "hybrid_search_pdf", confidence: result.score || "medium", name: (result.registers || [])[0] || "" }));
    inference.push(makeInference({
      statement: `Chunk ${result.id} is relevant to query because: ${(result.hybridReasons || []).join(", ") || "hybrid score"}`,
      basis: quote,
      confidence: result.score || "medium",
      risk: "Hybrid search rank is not a hardware fact; verify exact register/bit/sequence details with specialized tools.",
    }));
  }
  if ((payload.results || []).length) {
    needsVerification.push(makeNeedsVerification({
      item: "Exact register offsets / bit positions / clear semantics from hybrid results",
      reason: "hybrid_search_pdf ranks candidate chunks only; it does not prove exact table values.",
      suggestedTools: ["extract_register_table(...) or find_register(...) for offsets", "extract_bitfield_table(...) or find_bitfield(...) for bit fields", "get_sequence(...) for operation order", "get_cautions_for_register(...) for restrictions"],
    }));
  }
  return makeEvidenceContract({
    tool: "hybrid_search_pdf",
    filename: payload.filename,
    query: payload.query,
    evidence,
    inference,
    needsVerification,
    warnings: ["Hybrid search is retrieval/ranking only; do not treat ranked chunks as final hardware facts."],
    recommendedNextTools: [`read_pdf_chunk(filename="${payload.filename}", chunk_id="<chunk-id>")`, `extract_bitfield_table(filename="${payload.filename}", register="<register>")`, `get_cautions_for_register(filename="${payload.filename}", register="<register>")`],
  });
}

function formatHybridSearchResults(payload) {
  const { filename, query, intent, register, expandedTerms, context, results } = payload;

  const header = [
    `Hybrid search results for "${query}"`,
    `File: ${filename}`,
    `Intent: ${intent.join(", ")}`,
    register ? `Register context: ${register}` : "Register context: none",
    `Expanded terms: ${expandedTerms.slice(0, 30).join(", ") || "none"}`,
    `Ranking: exact + BM25 + synonym + symbol-alias + proximity + fuzzy + chunkType/noise + persistent-index boosts`,
    `Index boosts: sections=${context.sectionMatches.length}, registers=${context.registerMatches.length}, sequences=${context.sequenceMatches.length}, cautions=${context.cautionMatches.length}`,
  ];

  if (!results.length) {
    const text = [
      ...header,
      "",
      "No hybrid results found.",
      "Suggested next steps:",
      "- Try a shorter query.",
      "- Pass register=... if the question is about a specific register.",
      "- Use search_pdf for exact register/bit names.",
      "- Use find_sequence/find_caution for very specific operation or restriction queries.",
    ].join("\n");
    return appendEvidenceContract(text, buildHybridSearchEvidenceContract(payload));
  }

  const resultLines = results.map((result, index) => {
    const preview = normalizeText(result.text || "").slice(0, MAX_PREVIEW_CHARS);
    const evidence = (result.hybridEvidenceLines || [])
      .slice(0, 5)
      .map((line) => `   - ${line}`)
      .join("\n") || "   - none";

    return [
      `Result ${index + 1}`,
      `ID: ${result.id}`,
      `File: ${result.filename}`,
      `Page: ${result.page}`,
      `Chunk: ${result.chunkIndex}`,
      `Hybrid score: ${result.score}`,
      `Chunk type: ${result.chunkType || "unknown"}; noise=${result.noiseScore ?? "n/a"}; content=${result.contentScore ?? "n/a"}`,
      `Reasons: ${(result.hybridReasons || []).join(", ") || "none"}`,
      `Headings: ${result.headings && result.headings.length ? result.headings.join(" | ") : "none"}`,
      `Registers: ${result.registers && result.registers.length ? result.registers.join(", ") : "none"}`,
      `Bit fields / symbols: ${result.bitFields && result.bitFields.length ? result.bitFields.slice(0, 30).join(", ") : "none"}`,
      "Evidence lines:",
      evidence,
      `Suggested chunk read: read_pdf_chunk(filename="${result.filename}", chunk_id="${result.id}")`,
      `Suggested page read: read_pdf_pages(filename="${result.filename}", start_page=${result.page}, end_page=${Math.min(result.page + DEFAULT_PAGE_RANGE - 1, payload.context?.pageCount || result.page + DEFAULT_PAGE_RANGE - 1)})`,
      "Preview:",
      `${preview}${(result.text || "").length > MAX_PREVIEW_CHARS ? "..." : ""}`,
    ].join("\n");
  });

  const contextLines = [];
  if (context.sectionMatches.length) {
    contextLines.push("Section hints:");
    for (const section of context.sectionMatches.slice(0, 5)) {
      contextLines.push(`- ${section.title} (page ${section.page}, score ${section.score})`);
    }
  }
  if (context.sequenceMatches.length) {
    contextLines.push("Sequence hints:");
    for (const sequence of context.sequenceMatches.slice(0, 5)) {
      contextLines.push(`- ${sequence.topic} [${sequence.kind || "generic"}] pages ${(sequence.pages || []).join(", ") || "unknown"}`);
    }
  }
  if (context.cautionMatches.length) {
    contextLines.push("Caution hints:");
    for (const caution of context.cautionMatches.slice(0, 5)) {
      contextLines.push(`- ${caution.topic} [${caution.type || "general"}] pages ${(caution.pages || []).join(", ") || "unknown"}`);
    }
  }

  const text = [
    ...header,
    "",
    ...resultLines,
    contextLines.length ? "\n---\n\nPersistent-index hints\n" + contextLines.join("\n") : "",
  ].filter(Boolean).join("\n\n---\n\n");
  return appendEvidenceContract(text, buildHybridSearchEvidenceContract(payload));
}

function scoreSection(section, query) {
  const q = tokenizeQuery(query);
  if (!q.normalized && !q.canonical) return 0;

  const title = section.searchText || normalizeForSearch(section.title);
  const canonicalTitle = section.canonicalTitle || canonicalSymbol(section.title);
  let score = 0;

  if (q.normalized) {
    if (title === q.normalized) score += 140;
    if (title.includes(q.normalized)) score += 95;
  }

  if (q.canonical && canonicalTitle.includes(q.canonical)) {
    score += 55;
  }

  for (const term of q.terms) {
    if (countWordOccurrences(title, term)) score += 18;
    if (title.includes(term)) score += 8;
  }

  for (const symbolTerm of q.symbolTerms) {
    if (canonicalTitle.includes(symbolTerm)) score += 18;
  }

  if (section.type === "numbered") score += 12;
  if (section.type === "appendix") score += 8;
  if (/\b(Register|Description|Operation|Interrupt|Clock|Reset|Caution|Note|Restriction)\b/i.test(section.title)) {
    score += 10;
  }

  return score;
}

async function searchSectionsIndex(filename, query, topK = DEFAULT_TOP_K) {
  const sectionsIndex = await getSectionsIndex(filename);
  const k = clampTopK(topK);

  const results = sectionsIndex.sections
    .map((section) => ({
      ...section,
      pageCount: sectionsIndex.pageCount,
      score: scoreSection(section, query),
    }))
    .filter((section) => section.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.level - b.level;
    })
    .slice(0, k);

  return {
    sectionsIndex,
    results,
  };
}

function formatSectionResults(results, query) {
  if (!results.length) {
    return `No section-index results found for "${query}".`;
  }

  return [
    `Section index results for "${query}"`,
    "",
    ...results.map((section, index) =>
      [
        `Result ${index + 1}`,
        `ID: ${section.id}`,
        `File: ${section.filename}`,
        `Title: ${section.title}`,
        `Page: ${section.page}`,
        `Level: ${section.level}`,
        `Type: ${section.type}`,
        `Confidence: ${section.confidence}`,
        `Score: ${section.score}`,
        `Suggested read: read_pdf_pages(filename="${section.filename}", start_page=${section.page}, end_page=${Math.min(section.page + DEFAULT_PAGE_RANGE - 1, section.pageCount || section.page + DEFAULT_PAGE_RANGE - 1)})`,
      ].join("\n")
    ),
  ].join("\n\n---\n\n");
}

function formatSearchResults(results, query) {
  if (!results.length) {
    return [
      `No results found for "${query}".`,
      "",
      "Suggested next steps:",
      "- Check the exact PDF filename with list_pdfs.",
      "- Run index_pdf with force=true if the PDF changed.",
      "- Try a shorter query, register abbreviation, bit name, or section title.",
    ].join("\n");
  }

  return results
    .map((result, index) => {
      const preview = normalizeText(result.text).slice(0, MAX_PREVIEW_CHARS);
      const truncated = result.text.length > MAX_PREVIEW_CHARS ? "..." : "";

      return [
        `Result ${index + 1}`,
        `ID: ${result.id}`,
        `File: ${result.filename}`,
        `Page: ${result.page}`,
        `Chunk: ${result.chunkIndex}`,
        `Score: ${result.score}`,
        `Chunk type: ${result.chunkType || "unknown"}; noise=${result.noiseScore ?? "n/a"}; content=${result.contentScore ?? "n/a"}`,
        `Headings: ${
          result.headings && result.headings.length
            ? result.headings.join(" | ")
            : "none"
        }`,
        `Registers: ${
          result.registers && result.registers.length
            ? result.registers.join(", ")
            : "none"
        }`,
        `Bit fields / symbols: ${
          result.bitFields && result.bitFields.length
            ? result.bitFields.slice(0, 30).join(", ")
            : "none"
        }`,
        "Preview:",
        `${preview}${truncated}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function buildRegisterQueries(register) {
  const raw = String(register || "").trim();
  const upper = raw.toUpperCase();
  const queries = new Set();

  if (!raw) return [];

  queries.add(raw);
  queries.add(upper);

  const withoutCommonPrefix = raw
    .replace(/^[A-Z0-9]+m_/i, "")
    .replace(/^(GBETH|ETH|GMAC|WDT|GPT|POEG|ICU)_/i, "");

  if (withoutCommonPrefix && withoutCommonPrefix !== raw) {
    queries.add(withoutCommonPrefix);
  }

  const commonPrefixes = ["GBETHm_", "ETH_", "GMAC_", "WDT_", "GPT_", "POEG_", "ICU_"];
  for (const prefix of commonPrefixes) {
    if (!upper.startsWith(prefix.toUpperCase())) {
      queries.add(`${prefix}${withoutCommonPrefix || raw}`);
    }
  }

  queries.add(`${raw} Register`);
  queries.add(`${raw} register description`);
  queries.add(`${raw} Address`);
  queries.add(`${raw} Offset`);
  queries.add(`${raw} Initial Value`);
  queries.add(`${raw} Bit Name`);
  queries.add(`${raw} bits`);

  return [...queries].filter(Boolean);
}

function normalizeBitFieldName(bitfield) {
  return canonicalSymbol(bitfield);
}

function buildBitFieldQueries(bitfield, register = "") {
  const rawBitfield = String(bitfield || "").trim();
  const rawRegister = String(register || "").trim();
  const queries = new Set();

  if (!rawBitfield) return [];

  queries.add(rawBitfield);
  queries.add(rawBitfield.toUpperCase());
  queries.add(`${rawBitfield} Bit Name`);
  queries.add(`${rawBitfield} bit field`);
  queries.add(`${rawBitfield} Description`);
  queries.add(`${rawBitfield} Initial Value`);

  if (rawRegister) {
    queries.add(`${rawRegister} ${rawBitfield}`);
    queries.add(`${rawRegister} ${rawBitfield} Bit Name`);
    queries.add(`${rawRegister} ${rawBitfield} Description`);
  }

  return [...queries].filter(Boolean);
}

function collectRegisterContext(registerResults) {
  const chunkIds = new Set();
  const pages = new Set();
  const names = new Set();

  for (const entry of registerResults || []) {
    for (const name of [entry.name, entry.displayName, ...(entry.aliases || [])]) {
      const canonical = normalizeRegisterName(name);
      if (canonical) names.add(canonical);
    }

    for (const page of entry.pages || []) {
      if (Number.isFinite(Number(page))) pages.add(Number(page));
    }

    for (const chunk of entry.chunks || []) {
      if (chunk.id) chunkIds.add(chunk.id);
      if (Number.isFinite(Number(chunk.page))) pages.add(Number(chunk.page));
    }
  }

  return { chunkIds, pages, names };
}


function isLikelyBitfieldCandidate(symbol, registerEntry = null) {
  const raw = String(symbol || "").trim();
  const value = normalizeBitFieldName(raw);
  if (!value || value.length < 2 || value.length > 48) return false;

  const noisy = new Set([
    "ADDRESS", "OFFSET", "REGISTER", "REGISTERS", "DESCRIPTION", "INITIALVALUE",
    "INITIAL", "VALUE", "ACCESS", "SIZE", "BIT", "BITS", "BITNAME", "NAME",
    "READ", "WRITE", "RESERVED", "UNDEFINED", "CAUTION", "NOTE", "NOTES",
    "TABLE", "FIGURE", "PAGE", "CHAPTER", "SECTION", "MODULE", "FUNCTION",
    "SETTING", "SETTINGS", "CONTROL", "STATUS", "OPERATION", "PROCEDURE",
    "TYPE", "MODE", "SELECT", "SELECTS", "ENABLE", "DISABLE", "ENABLED", "DISABLED",
    "TRANSFER", "REQUEST", "INTERRUPT", "ERROR", "CHANNEL", "CHANNELS", "DMA", "DMAC",
  ]);
  if (noisy.has(value)) return false;

  if (/^B?\d+$/.test(value)) return false;
  if (/^[0-9A-F]+H$/.test(value)) return false;
  if (/^[01]+B$/.test(value)) return false;

  if (registerEntry) {
    const registerNames = [
      registerEntry.name,
      registerEntry.displayName,
      registerEntry.canonicalName,
      ...(registerEntry.aliases || []),
    ].map(normalizeRegisterName).filter(Boolean);
    if (registerNames.includes(value)) return false;
  }

  // Long register-looking names usually belong in registers, not bitfields.
  if (looksLikeRegisterSymbol(raw) && value.length > 8 && /(?:CTRL|STAT|CFG|DCTRL|CHCTRL|CHSTAT|REGISTER|DMAC|GBETH|GPT|WDT)/.test(value)) {
    return false;
  }

  return true;
}

function extractBitRangeFromLine(line, bitfield) {
  const rawLine = String(line || "");
  const rawBitfield = String(bitfield || "").trim();
  if (!rawLine || !rawBitfield) return "unknown";

  const escaped = escapeRegExp(rawBitfield);
  const patterns = [
    new RegExp(`\\b(?:b|bit|bits?)\\s*([0-9]+\\s*[:\\-]\\s*[0-9]+|[0-9]+)\\b.{0,80}\\b${escaped}\\b`, "i"),
    new RegExp(`\\b${escaped}\\b.{0,80}\\b(?:b|bit|bits?)\\s*([0-9]+\\s*[:\\-]\\s*[0-9]+|[0-9]+)\\b`, "i"),
    new RegExp(`\\b${escaped}\\s*\\[([0-9]+\\s*:\\s*[0-9]+|[0-9]+)\\]`, "i"),
    /\[\s*([0-9]+\s*:\s*[0-9]+|[0-9]+)\s*\]/,
  ];

  for (const pattern of patterns) {
    const match = rawLine.match(pattern);
    if (match && match[1]) return match[1].replace(/\s+/g, "").replace("-", ":");
  }

  return "unknown";
}

function extractAccessFromLine(line) {
  const text = String(line || "");
  const patterns = [
    /\b(R\/W|R\/W1C|W1C|W0C|R\/O|RO|W\/O|WO|R|W)\b/i,
    /\b(Read\/Write|Read only|Write only|Write 1 to clear|Write 0 to clear)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].toUpperCase().replace(/READ ONLY/i, "R/O").replace(/WRITE ONLY/i, "W/O");
  }

  return "unknown";
}

function extractResetFromLine(line) {
  const text = String(line || "");
  const patterns = [
    /\b(?:Initial\s+Value|Reset\s+Value|Initial|Reset)\s*[:=]?\s*([0-9A-Fa-f_xX]+h?|[01]+b)\b/i,
    /\b([0-9A-Fa-f]{1,8}_[0-9A-Fa-f_]+h?)\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }

  return "unknown";
}

function classifyBitfieldEvidenceLine(line) {
  const text = String(line || "");
  const tags = [];
  if (/\bBit\s+Name\b|\bbits?\b|\bb[0-9]+\b|\[[0-9]+(?::[0-9]+)?\]/i.test(text)) tags.push("bit-table");
  if (/\bDescription\b|\b0\s*[:=]|\b1\s*[:=]|\bSet\b|\bCleared\b/i.test(text)) tags.push("description");
  if (/\bR\/W\b|\bR\/O\b|\bW\/O\b|\bW1C\b|\bW0C\b|\bAccess\b/i.test(text)) tags.push("access");
  if (/\bInitial\s+Value\b|\bReset\s+Value\b/i.test(text)) tags.push("reset");
  if (/\bCaution\b|\bNote\b|\bReserved\b|\bUndefined\b|\bProhibited\b/i.test(text)) tags.push("risk");
  return tags;
}

function scoreBitfieldCandidate({ symbol, evidenceLines, registerEntry, chunk, source }) {
  let score = 0;
  const value = normalizeBitFieldName(symbol);

  if (source === "chunk-bitfields") score += 45;
  if (source === "evidence-line") score += 75;
  if (source === "symbol-index") score += 25;
  if (registerEntry) score += 25;

  if (value.length <= 5) score += 8;
  if (value.length >= 2 && value.length <= 16) score += 12;
  if (/^(SET|CLR|CL|EN|DIS|ST|SUS|RST|SW|IRQ|INT|ERR|END|TC|TE|RE)/.test(value)) score += 16;

  for (const line of evidenceLines || []) {
    const tags = classifyBitfieldEvidenceLine(line);
    score += tags.length * 18;
    if (lineContainsBitfield(line, value, symbol)) score += 10;
  }

  const text = String(chunk?.text || "");
  if (/\bBit\s+Name\b/i.test(text)) score += 20;
  if (/\bDescription\b/i.test(text)) score += 8;
  if (/\bRegister\s+Name\b/i.test(text) && !/\bBit\s+Name\b/i.test(text)) score -= 25;

  return Math.max(1, Math.round(score));
}

function chooseBestBitfieldEvidence(lines, bitfield) {
  const canonical = normalizeBitFieldName(bitfield);
  const selected = [];

  for (const line of lines || []) {
    if (!line || !lineContainsBitfield(line, canonical, bitfield)) continue;
    selected.push(line.slice(0, 600));
    if (selected.length >= 8) break;
  }

  return selected;
}

function buildBitfieldEntryKey(registerName, bitfield) {
  return `${normalizeRegisterName(registerName || "GLOBAL")}::${normalizeBitFieldName(bitfield)}`;
}

function findNearestRegisterForChunk(registerIndex, chunk) {
  if (!registerIndex || !Array.isArray(registerIndex.registers) || !chunk) return null;
  const chunkRegisters = new Set((chunk.registers || []).map(normalizeRegisterName));
  const chunkId = chunk.id;
  const page = Number(chunk.page);

  let best = null;
  let bestScore = 0;

  for (const entry of registerIndex.registers) {
    let score = 0;
    const names = [entry.name, entry.displayName, entry.canonicalName, ...(entry.aliases || [])]
      .map(normalizeRegisterName)
      .filter(Boolean);

    if (names.some((name) => chunkRegisters.has(name))) score += 100;
    if ((entry.chunks || []).some((c) => c.id === chunkId)) score += 140;
    if ((entry.pages || []).map(Number).includes(page)) score += 35;

    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

function updateBitfieldCandidate(map, candidate) {
  const registerName = candidate.register || "GLOBAL";
  const bitfield = candidate.bitfield;
  if (!isLikelyBitfieldCandidate(bitfield, candidate.registerEntry)) return;

  const key = buildBitfieldEntryKey(registerName, bitfield);
  const existing = map.get(key);
  const evidenceLines = [...new Set([...(existing?.evidenceLines || []), ...(candidate.evidenceLines || [])])].slice(0, 12);
  const pages = [...new Set([...(existing?.pages || []), candidate.page].filter((p) => Number.isFinite(Number(p))).map(Number))].sort((a, b) => a - b);
  const chunks = new Map();

  for (const chunk of existing?.chunks || []) {
    if (chunk.id) chunks.set(chunk.id, chunk);
  }
  if (candidate.chunk?.id) {
    chunks.set(candidate.chunk.id, {
      id: candidate.chunk.id,
      page: candidate.chunk.page,
      chunkIndex: candidate.chunk.chunkIndex,
      score: candidate.chunk.score || candidate.score || 0,
      headings: (candidate.chunk.headings || []).slice(0, 4),
      preview: normalizeText(candidate.chunk.text || "").slice(0, 500),
    });
  }

  const bitRange = existing?.bitRange && existing.bitRange !== "unknown"
    ? existing.bitRange
    : (candidate.bitRange || "unknown");
  const access = existing?.access && existing.access !== "unknown"
    ? existing.access
    : (candidate.access || "unknown");
  const reset = existing?.reset && existing.reset !== "unknown"
    ? existing.reset
    : (candidate.reset || "unknown");

  const score = Math.max(existing?.score || 0, candidate.score || 0) + Math.min(evidenceLines.length * 3, 24);

  map.set(key, {
    id: `${candidate.filename}:bf:${key}`,
    filename: candidate.filename,
    register: registerName,
    canonicalRegister: normalizeRegisterName(registerName),
    bitfield,
    canonicalBitfield: normalizeBitFieldName(bitfield),
    bitRange,
    access,
    reset,
    description: candidate.description || existing?.description || "candidate bit-field evidence; verify against the original bit table",
    pages,
    chunks: [...chunks.values()].slice(0, 12),
    evidenceLines,
    source: [...new Set([existing?.source, candidate.source].filter(Boolean))].join(", ") || "heuristic",
    confidence: Math.max(existing?.confidence || 0, candidate.confidence || 0, Math.min(95, score)),
    score,
  });
}

function collectBitfieldCandidatesFromChunk(filename, chunk, registerEntry, map) {
  const registerName = registerEntry?.name || registerEntry?.displayName || "GLOBAL";
  const lines = String(chunk.text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const chunkBitfields = new Set([...(chunk.bitFields || []), ...(chunk.symbols || [])]);

  for (const symbol of chunkBitfields) {
    if (!isLikelyBitfieldCandidate(symbol, registerEntry)) continue;
    const evidenceLines = chooseBestBitfieldEvidence(lines, symbol);
    if (!evidenceLines.length && registerName === "GLOBAL") continue;

    const bestLine = evidenceLines[0] || "";
    const candidate = {
      filename,
      register: registerName,
      registerEntry,
      bitfield: symbol,
      bitRange: extractBitRangeFromLine(bestLine, symbol),
      access: extractAccessFromLine(bestLine),
      reset: extractResetFromLine(bestLine),
      description: bestLine || "symbol detected near register context",
      page: chunk.page,
      chunk,
      evidenceLines,
      source: "chunk-bitfields",
    };
    candidate.score = scoreBitfieldCandidate({ ...candidate, source: candidate.source });
    candidate.confidence = Math.min(95, candidate.score);
    updateBitfieldCandidate(map, candidate);
  }

  // Also parse rows/lines that look like bit table rows, because PDF text extraction sometimes
  // does not put the field name into chunk.bitFields cleanly.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\b(Bit\s+Name|Description|Initial\s+Value|Access|R\/W|R\/O|W\/O|W1C|W0C|b[0-9]+|\[[0-9]+(?::[0-9]+)?\])\b/i.test(line)) {
      continue;
    }

    const context = [lines[i - 1], line, lines[i + 1]].filter(Boolean).join(" / ");
    const symbols = (context.match(/\b[A-Z][A-Z0-9_]{1,31}\b/g) || [])
      .filter((symbol) => isLikelyBitfieldCandidate(symbol, registerEntry));

    for (const symbol of symbols.slice(0, 12)) {
      const candidate = {
        filename,
        register: registerName,
        registerEntry,
        bitfield: symbol,
        bitRange: extractBitRangeFromLine(context, symbol),
        access: extractAccessFromLine(context),
        reset: extractResetFromLine(context),
        description: context.slice(0, 500),
        page: chunk.page,
        chunk,
        evidenceLines: [context.slice(0, 700)],
        source: "evidence-line",
      };
      candidate.score = scoreBitfieldCandidate({ ...candidate, source: candidate.source });
      candidate.confidence = Math.min(98, candidate.score);
      updateBitfieldCandidate(map, candidate);
    }
  }
}

async function buildBitfieldsIndex(filename, indexData = null, registersIndex = null) {
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const source = await getPdfSourceInfo(filename);
  const pdfIndex = indexData || await loadPdfIndex(filename);
  const regIndex = registersIndex || await getRegistersIndex(filename);
  const candidates = new Map();

  const directRegisterChunkIds = new Map();
  for (const entry of regIndex.registers || []) {
    for (const chunk of entry.chunks || []) {
      if (chunk.id) directRegisterChunkIds.set(chunk.id, entry);
    }
  }

  for (const chunk of pdfIndex.chunks || []) {
    const registerEntry = directRegisterChunkIds.get(chunk.id) || findNearestRegisterForChunk(regIndex, chunk);
    collectBitfieldCandidatesFromChunk(filename, chunk, registerEntry, candidates);
  }

  const bitfields = [...candidates.values()]
    .map((entry, index) => ({
      ...entry,
      id: `${filename}:bf${index}`,
      evidenceLines: (entry.evidenceLines || []).slice(0, 12),
      chunks: (entry.chunks || []).slice(0, 12),
      confidence: Math.max(1, Math.min(100, Math.round(entry.confidence || entry.score || 1))),
      score: Math.round(entry.score || entry.confidence || 1),
    }))
    .sort((a, b) => {
      if (a.canonicalRegister !== b.canonicalRegister) return a.canonicalRegister.localeCompare(b.canonicalRegister);
      if (b.score !== a.score) return b.score - a.score;
      return a.canonicalBitfield.localeCompare(b.canonicalBitfield);
    });

  const index = {
    schemaVersion: BITFIELD_INDEX_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    pageCount: pdfIndex.pageCount,
    registerCount: regIndex.registerCount || 0,
    bitfieldCount: bitfields.length,
    bitfields,
  };

  const bitfieldsPath = safeBitfieldsIndexPath(filename);
  await atomicWriteJson(bitfieldsPath, index);
  return index;
}

async function loadBitfieldsIndex(filename) {
  const bitfieldsPath = safeBitfieldsIndexPath(filename);

  if (!(await pathExists(bitfieldsPath))) return null;

  try {
    const raw = await fs.readFile(bitfieldsPath, "utf-8");
    const index = JSON.parse(raw);
    if (index.schemaVersion !== BITFIELD_INDEX_SCHEMA_VERSION) return null;
    if (index.filename !== filename) return null;
    if (!Array.isArray(index.bitfields)) return null;

    const currentSource = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(index.source, currentSource)) return null;

    return index;
  } catch {
    return null;
  }
}

async function getBitfieldsIndex(filename, options = {}) {
  const existing = await loadBitfieldsIndex(filename);
  if (existing) return existing;

  if (options.buildIfMissing === true) {
    const indexData = await loadPdfIndex(filename, { buildIfMissing: true });
    const registersIndex = await getRegistersIndex(filename, { buildIfMissing: true });
    return buildBitfieldsIndex(filename, indexData, registersIndex);
  }

  throw new Error(`Bitfields index not found for ${filename}. Run index_pdf or start_index_pdf first.`);
}

function scoreBitfieldIndexEntry(entry, options = {}) {
  const register = String(options.register || "").trim();
  const filter = String(options.filter || "").trim();
  const includeLowConfidence = Boolean(options.includeLowConfidence);
  const canonicalRegister = normalizeRegisterName(register);
  const normalizedFilter = normalizeForSearch(filter);

  if (!includeLowConfidence && Number(entry.confidence || 0) < 25) return 0;

  let score = Number(entry.score || entry.confidence || 1);

  if (register) {
    const entryRegister = normalizeRegisterName(entry.register);
    const registerText = normalizeForSearch([entry.register, entry.canonicalRegister].join("\n"));
    if (entryRegister === canonicalRegister) score += 200;
    else if (entryRegister.includes(canonicalRegister) || canonicalRegister.includes(entryRegister)) score += 80;
    else if (!registerText.includes(normalizeForSearch(register))) return 0;
  }

  if (filter) {
    const haystack = normalizeForSearch([
      entry.bitfield,
      entry.canonicalBitfield,
      entry.register,
      entry.description,
      ...(entry.evidenceLines || []),
    ].join("\n"));
    if (!haystack.includes(normalizedFilter)) return 0;
    score += 50;
  }

  return score;
}

async function listBitfieldsFromIndex(filename, options = {}) {
  const bitfieldsIndex = await getBitfieldsIndex(filename);
  const topK = clampBitfieldListTopK(options.topK);

  const results = (bitfieldsIndex.bitfields || [])
    .map((entry) => ({
      ...entry,
      resultScore: scoreBitfieldIndexEntry(entry, options),
    }))
    .filter((entry) => entry.resultScore > 0)
    .sort((a, b) => {
      if (b.resultScore !== a.resultScore) return b.resultScore - a.resultScore;
      if (a.canonicalRegister !== b.canonicalRegister) return a.canonicalRegister.localeCompare(b.canonicalRegister);
      return a.canonicalBitfield.localeCompare(b.canonicalBitfield);
    })
    .slice(0, topK);

  return { bitfieldsIndex, results };
}

function formatBitfieldListResults(bitfieldsIndex, results, options = {}) {
  const register = String(options.register || "").trim();
  const filter = String(options.filter || "").trim();
  const shown = results.length;
  const total = bitfieldsIndex.bitfieldCount || (bitfieldsIndex.bitfields || []).length;

  if (!shown) {
    return [
      register
        ? `No bit-field candidates found for register "${register}" in ${bitfieldsIndex.filename}.`
        : `No bit-field candidates found in ${bitfieldsIndex.filename}.`,
      filter ? `Filter: ${filter}` : "Filter: none",
      "",
      "Suggested next steps:",
      "- Rebuild the PDF index with index_pdf(force=true).",
      "- Try find_bitfield with a specific register and bit-field name.",
      "- Use read_pdf_pages around the register description page if the PDF table extraction is poor.",
    ].join("\n");
  }

  const header = [
    register
      ? `Detected bit-field candidates for register "${register}" in ${bitfieldsIndex.filename}`
      : `Detected bit-field candidates in ${bitfieldsIndex.filename}`,
    `Showing: ${shown} / ${total}`,
    filter ? `Filter: ${filter}` : "Filter: none",
    `Bitfields index created: ${bitfieldsIndex.createdAt}`,
    "",
  ];

  return header.concat(results.map((entry, idx) => {
    const evidence = (entry.evidenceLines || []).slice(0, 3).map((line) => `     evidence: ${line}`).join("\n");
    const chunks = (entry.chunks || []).slice(0, 4).map((chunk) => chunk.id).filter(Boolean).join(", ") || "none";
    const pages = (entry.pages || []).join(", ") || "unknown";
    return [
      `${idx + 1}. ${entry.bitfield}`,
      `   Register: ${entry.register || "unknown"}`,
      `   Bit/range: ${entry.bitRange || "unknown"}`,
      `   Access: ${entry.access || "unknown"}`,
      `   Reset: ${entry.reset || "unknown"}`,
      `   Pages: ${pages}`,
      `   Confidence: ${entry.confidence}`,
      `   Source: ${entry.source || "heuristic"}`,
      `   Description: ${entry.description || "candidate"}`,
      `   Chunks: ${chunks}`,
      `   Suggested find: find_bitfield(filename="${bitfieldsIndex.filename}", register="${entry.register}", bitfield="${entry.bitfield}")`,
      evidence,
    ].filter(Boolean).join("\n");
  })).join("\n\n");
}

async function extractBitfieldTableFromIndex(filename, register, options = {}) {
  const topK = clampBitfieldListTopK(options.topK);
  const { bitfieldsIndex, results } = await listBitfieldsFromIndex(filename, {
    register,
    topK: Math.min(topK, MAX_BITFIELD_TABLE_ROWS),
    includeLowConfidence: true,
  });

  return {
    filename,
    register,
    bitfieldsIndex,
    rows: results.slice(0, MAX_BITFIELD_TABLE_ROWS).map((entry) => ({
      bitRange: entry.bitRange || "unknown",
      bitfield: entry.bitfield,
      access: entry.access || "unknown",
      reset: entry.reset || "unknown",
      description: entry.description || "candidate; verify against original bit table",
      pages: entry.pages || [],
      chunks: (entry.chunks || []).map((chunk) => chunk.id).filter(Boolean),
      confidence: entry.confidence || 0,
      evidenceLines: entry.evidenceLines || [],
    })),
  };
}


function buildBitfieldTableEvidenceContract(table) {
  const rows = (table.rows || []).slice(0, 16);
  const evidence = rows.map((row) => makeEvidence({
    source: row.source || "bitfield-table-extraction",
    evidenceType: "bitfield-table",
    page: (row.pages || [])[0],
    chunkId: (row.chunks || [])[0] || null,
    quote: (row.evidenceLines || [])[0] || row.description || `${row.bitfield} ${row.bitRange || "unknown"}`,
    confidence: row.confidence || "medium",
    name: row.bitfield,
    field: "bitfield",
    tool: "extract_bitfield_table",
  }));
  const inference = rows.map((row) => makeInference({
    statement: `${row.bitfield}: bit/range=${row.bitRange || "unknown"}, access=${row.access || "unknown"}, reset=${row.reset || "unknown"}`,
    basis: (row.evidenceLines || [])[0] || row.description || "coordinate/index heuristic row",
    confidence: row.confidence || "medium",
    risk: "Do not convert to Linux BIT()/GENMASK() macro unless bit/range is explicit and verified.",
  }));
  const needsVerification = [];
  for (const row of rows) {
    const page = (row.pages || [1])[0] || 1;
    if (!row.bitRange || row.bitRange === "unknown") needsVerification.push(makeNeedsVerification({
      item: `${row.bitfield} bit position/range`,
      reason: "Bit/range was not explicit in extracted table output.",
      suggestedTools: [`read_pdf_pages(filename="${table.filename}", start_page=${page}, end_page=${page + 2})`, `find_bitfield(filename="${table.filename}", register="${table.register}", bitfield="${row.bitfield}")`],
    }));
    if (!row.access || row.access === "unknown") needsVerification.push(makeNeedsVerification({
      item: `${row.bitfield} access type`,
      reason: "Access type was not explicit in extracted table output.",
      suggestedTools: [`read_pdf_pages(filename="${table.filename}", start_page=${page}, end_page=${page + 2})`],
    }));
    if (!row.reset || row.reset === "unknown") needsVerification.push(makeNeedsVerification({
      item: `${row.bitfield} reset/initial value`,
      reason: "Reset/initial value was not explicit in extracted table output.",
      suggestedTools: [`read_pdf_pages(filename="${table.filename}", start_page=${page}, end_page=${page + 2})`],
    }));
  }
  return makeEvidenceContract({
    tool: "extract_bitfield_table",
    filename: table.filename,
    query: table.register,
    evidence,
    inference,
    needsVerification,
    warnings: ["Coordinate/table extraction is heuristic; verify original manual table before writing driver macros."],
    recommendedNextTools: [`summarize_register(filename="${table.filename}", register="${table.register}")`, `get_cautions_for_register(filename="${table.filename}", register="${table.register}")`],
  });
}

function formatExtractedBitfieldTable(table) {
  const rows = table.rows || [];
  if (!rows.length) {
    return [
      `No bit-field table candidates found for register "${table.register}" in ${table.filename}.`,
      "",
      "Suggested next steps:",
      `- Try summarize_register(filename="${table.filename}", register="${table.register}").`,
      `- Try find_register(filename="${table.filename}", register="${table.register}").`,
      "- Read the register description pages and verify the original bit table manually.",
    ].join("\n");
  }

  const lines = [
    `Step 30A layout-aware bit-field table candidates for register "${table.register}"`,
    `File: ${table.filename}`,
    `Rows: ${rows.length}`,
    "Reliability: coordinate-table extraction when possible, otherwise heuristic extraction from PDF text/chunk evidence. Verify bit positions/access/reset values with read_pdf_pages or read_pdf_chunk before writing driver macros.",
    "",
    "| # | Bit/Range | Field | Access | Reset | Pages | Confidence | Evidence |",
    "|---:|---|---|---|---|---|---:|---|",
  ];

  rows.forEach((row, index) => {
    const evidence = (row.evidenceLines || [])[0] || row.description || "";
    lines.push(
      `| ${index + 1} | ${row.bitRange || "unknown"} | ${row.bitfield} | ${row.access || "unknown"} | ${row.reset || "unknown"} | ${(row.pages || []).join(", ") || "unknown"} | ${row.confidence || 0} | ${String(evidence).replace(/\|/g, "/").slice(0, 180)} |`
    );
  });

  lines.push("", "Suggested follow-up reads:");
  for (const row of rows.slice(0, 8)) {
    const chunkId = (row.chunks || [])[0];
    if (chunkId) {
      lines.push(`- read_pdf_chunk(filename="${table.filename}", chunk_id="${chunkId}")  # ${row.bitfield}`);
    } else if ((row.pages || []).length) {
      const page = row.pages[0];
      lines.push(`- read_pdf_pages(filename="${table.filename}", start_page=${page}, end_page=${Math.min(page + 2, page)})  # ${row.bitfield}`);
    }
  }

  const text = lines.join("\n");
  return appendEvidenceContract(text, buildBitfieldTableEvidenceContract(table));
}



// -----------------------------------------------------------------------------
// Step 31A: figure/caption index and visual-context helpers
// -----------------------------------------------------------------------------

function classifyFigureKind(type, captionText = "", contextText = "") {
  const text = normalizeForSearch(`${type} ${captionText} ${contextText}`);
  if (/clock\s*tree|clock\s*distribution|clock\s*generation|pll|oscillator/.test(text)) return "clock-tree";
  if (/timing|waveform|read\s*cycle|write\s*cycle|setup\s*time|hold\s*time|t\s*[a-z0-9]+/.test(text)) return "timing-diagram";
  if (/block\s*diagram|module\s*configuration|configuration\s*diagram|overview\s*diagram/.test(text)) return "block-diagram";
  if (/flow|sequence|procedure|setting\s*flow|operation\s*flow|example\s*flow/.test(text)) return "flow-sequence";
  if (/pin\s*function|pinmux|pin\s*mux|multiplexed\s*pin|pfc|ioport|port\s*function/.test(text)) return "pinmux";
  if (/register|bit\s*field|offset|access\s*size|initial\s*value/.test(text)) return "register-table";
  if (/interrupt|irq|vector|routing|event\s*link|intc/.test(text)) return "interrupt";
  if (/reset|standby|power\s*state|low\s*power/.test(text)) return "reset-power";
  if (/^table\b/i.test(String(type || ""))) return "table";
  if (/^fig/i.test(String(type || ""))) return "figure";
  return "unknown";
}

function normalizeFigureNumber(value = "") {
  return String(value || "").trim().replace(/[^A-Za-z0-9_.-]+/g, "");
}

function figureIdFor(page, ordinal, type, number) {
  const prefix = /^table$/i.test(type) ? "tbl" : "fig";
  const num = normalizeFigureNumber(number);
  return `${prefix}-p${page}-${num || ordinal}`.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function extractFigureCaptionsFromPageText(pageText = "", pageNumber = 0) {
  const lines = String(pageText || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const captions = [];
  const captionRe = /^(Figure|Fig\.?|Table)\s+([A-Za-z]?\d+(?:[.\-]\d+)*(?:[A-Za-z])?)\s*[:.\-]?\s*(.{0,220})$/i;
  const softVisualRe = /\b(clock\s*tree|timing\s*diagram|waveform|block\s*diagram|setting\s*flow|operation\s*flow|example\s*flow|multiplexed\s*pin\s*configuration|pin\s*function\s*configuration)\b/i;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let match = line.match(captionRe);
    if (match) {
      const type = /^fig/i.test(match[1]) ? "Figure" : "Table";
      let title = String(match[3] || "").trim();
      // Common PDF extraction issue: caption title spills into following short line.
      if (title.length < 12 && lines[index + 1] && !captionRe.test(lines[index + 1]) && lines[index + 1].length < 160) {
        title = `${title} ${lines[index + 1]}`.trim();
      }
      const contextStart = Math.max(0, index - 4);
      const contextEnd = Math.min(lines.length, index + 6);
      const contextLines = lines.slice(contextStart, contextEnd);
      captions.push({
        page: pageNumber,
        lineIndex: index,
        type,
        number: match[2],
        title,
        caption: `${type} ${match[2]} ${title}`.replace(/\s+/g, " ").trim(),
        contextLines,
        source: "caption-regex",
      });
      continue;
    }

    if (softVisualRe.test(line) && !/^(section|chapter)\b/i.test(line)) {
      const contextStart = Math.max(0, index - 3);
      const contextEnd = Math.min(lines.length, index + 5);
      captions.push({
        page: pageNumber,
        lineIndex: index,
        type: "Visual",
        number: "",
        title: line,
        caption: line,
        contextLines: lines.slice(contextStart, contextEnd),
        source: "visual-keyword",
      });
    }
  }

  return captions;
}

function figureFromCaption(filename, caption, ordinal = 0, pageHeadings = []) {
  const contextText = (caption.contextLines || []).join("\n");
  const kind = classifyFigureKind(caption.type, caption.caption, contextText);
  const id = figureIdFor(caption.page, ordinal, caption.type, caption.number);
  const confidence = Math.min(100,
    50 +
    (caption.source === "caption-regex" ? 25 : 8) +
    (kind !== "unknown" ? 15 : 0) +
    ((caption.title || "").length > 8 ? 6 : 0)
  );

  return {
    id,
    filename,
    page: caption.page,
    type: caption.type,
    number: caption.number || "",
    title: caption.title || "",
    caption: caption.caption || caption.title || "",
    kind,
    lineIndex: caption.lineIndex,
    headings: pageHeadings || [],
    contextLines: caption.contextLines || [],
    contextPreview: compactText(contextText, 1000),
    searchText: normalizeForSearch([caption.caption, caption.title, kind, ...(pageHeadings || []), contextText].join("\n")),
    source: caption.source,
    confidence,
  };
}

async function buildFiguresIndex(filename, pageCache = null) {
  const cache = pageCache || await getPagesCache(filename);
  const source = await getPdfSourceInfo(filename);
  const figures = [];

  for (const page of cache.pages || []) {
    const headings = detectHeadings(page.text || "");
    const captions = extractFigureCaptionsFromPageText(page.text || "", page.page);
    captions.forEach((caption, index) => figures.push(figureFromCaption(filename, caption, index + 1, headings)));
  }

  const byId = new Map();
  for (const figure of figures) {
    let id = figure.id;
    let suffix = 2;
    while (byId.has(id)) {
      id = `${figure.id}-${suffix}`;
      suffix += 1;
    }
    byId.set(id, { ...figure, id });
  }

  const result = {
    schemaVersion: FIGURE_INDEX_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    pageCount: cache.pageCount,
    figureCount: byId.size,
    kindStats: [...byId.values()].reduce((acc, fig) => {
      acc[fig.kind] = (acc[fig.kind] || 0) + 1;
      return acc;
    }, {}),
    figures: [...byId.values()],
  };

  await atomicWriteJson(safeFiguresIndexPath(filename), result);
  return result;
}

async function loadFiguresIndex(filename) {
  const filePath = safeFiguresIndexPath(filename);
  if (!(await pathExists(filePath))) return null;
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (data.schemaVersion !== FIGURE_INDEX_SCHEMA_VERSION) return null;
    if (data.filename !== filename) return null;
    if (!Array.isArray(data.figures)) return null;
    const source = await getPdfSourceInfo(filename);
    if (!data.source || Number(data.source.size) !== Number(source.size) || Number(data.source.modifiedMs) !== Number(source.modifiedMs)) return null;
    return data;
  } catch {
    return null;
  }
}

async function getFiguresIndex(filename, options = {}) {
  const existing = await loadFiguresIndex(filename);
  if (existing) return existing;
  if (options.buildIfMissing === true) return buildFiguresIndex(filename);
  throw new Error(`Figures/captions index not found for ${filename}. Run build_figures_index or index_pdf/start_index_pdf first.`);
}

function figureMatchesFilter(figure, { filter = "", kind = "" } = {}) {
  const kindFilter = String(kind || "").trim().toLowerCase();
  if (kindFilter && String(figure.kind || "").toLowerCase() !== kindFilter && String(figure.type || "").toLowerCase() !== kindFilter) return false;
  const f = normalizeForSearch(filter || "");
  if (!f) return true;
  return normalizeForSearch([figure.caption, figure.title, figure.kind, figure.contextPreview, ...(figure.headings || [])].join("\n")).includes(f);
}

function scoreFigureCandidate(figure, query = "") {
  const q = String(query || "").trim();
  if (!q) return Number(figure.confidence || 0);
  return Number(figure.confidence || 0) + scoreSimpleText([figure.caption, figure.title, figure.kind, figure.contextPreview, ...(figure.headings || [])].join("\n"), q);
}

async function listFigures(filename, options = {}) {
  const index = await getFiguresIndex(filename, { buildIfMissing: true });
  const filter = String(options.filter || "").trim();
  const kind = String(options.kind || "").trim();
  const topK = clampInteger(options.topK, DEFAULT_FIGURE_TOP_K, 1, MAX_FIGURE_TOP_K);
  const results = (index.figures || [])
    .filter((figure) => figureMatchesFilter(figure, { filter, kind }))
    .sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return String(a.id).localeCompare(String(b.id));
    })
    .slice(0, topK);
  return { index, results, filter, kind, topK };
}

async function findFigure(filename, options = {}) {
  const query = String(options.query || "").trim();
  if (!query) throw new Error("query is required");
  const index = await getFiguresIndex(filename, { buildIfMissing: true });
  const kind = String(options.kind || "").trim();
  const topK = clampInteger(options.topK, DEFAULT_FIGURE_TOP_K, 1, MAX_FIGURE_TOP_K);
  const results = (index.figures || [])
    .filter((figure) => figureMatchesFilter(figure, { kind }))
    .map((figure) => ({ ...figure, matchScore: scoreFigureCandidate(figure, query) }))
    .filter((figure) => figure.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore || a.page - b.page)
    .slice(0, topK);
  return { index, results, query, kind, topK };
}

async function getFigureContext(filename, options = {}) {
  const index = await getFiguresIndex(filename, { buildIfMissing: true });
  const figureId = String(options.figureId || "").trim();
  const page = Number(options.page || 0);
  const query = String(options.query || "").trim();
  const includePages = clampInteger(options.includePages, 0, 0, 2);
  let figure = null;

  if (figureId) figure = (index.figures || []).find((item) => item.id === figureId);
  if (!figure && page) {
    const pageFigures = (index.figures || []).filter((item) => Number(item.page) === page);
    if (query) figure = pageFigures.map((item) => ({ ...item, matchScore: scoreFigureCandidate(item, query) })).sort((a, b) => b.matchScore - a.matchScore)[0] || null;
    else figure = pageFigures[0] || null;
  }
  if (!figure && query) {
    const found = await findFigure(filename, { query, topK: 1 });
    figure = found.results[0] || null;
  }
  if (!figure) throw new Error("Figure/table context not found. Provide figure_id from list_figures/find_figure, or pass page/query.");

  const pageCount = index.pageCount || await getPdfPageCount(filename);
  const startPage = Math.max(1, figure.page - includePages);
  const endPage = Math.min(pageCount, figure.page + includePages);
  const pageData = await extractPdfPages(filename, { startPage, endPage });
  let layoutTables = null;
  if (options.includeLayoutTables) {
    try {
      layoutTables = await extractTablesFromPages(filename, { startPage, endPage, minColumns: 2 });
      layoutTables.tables = (layoutTables.tables || []).slice(0, 8).map((table) => ({
        page: table.page,
        kind: table.kind,
        confidence: table.confidence,
        columns: table.columns,
        headerText: table.headerText,
        previewRows: (table.rows || []).slice(0, 6),
      }));
    } catch (error) {
      layoutTables = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { filename, figure, startPage, endPage, pages: pageData.pages || [], layoutTables };
}

function buildFigureEvidenceContract(tool, filename, query, figures) {
  const evidence = (figures || []).slice(0, 20).map((figure) => makeEvidence({
    source: "figures-index",
    evidenceType: figure.kind || figure.type || "figure-caption",
    page: figure.page,
    quote: figure.caption || figure.title,
    confidence: figure.confidence || "medium",
    name: figure.id,
    field: figure.kind,
    tool,
  }));
  const inference = [makeInference({ statement: "Figure/visual context is inferred from PDF text captions and nearby text, not from image OCR or vision rendering.", basis: "PDF text layer captions", confidence: "medium", risk: "If the visual object has no extractable caption/text, it may be missed." })];
  const needsVerification = [makeNeedsVerification({ item: "Visual content inside the actual figure/diagram", reason: "Step 31A locates captions/context but does not inspect raster/vector graphics visually.", suggestedTools: ["read_pdf_pages(...)", "extract_layout_tables_from_pages(...)", "open the PDF page visually if the diagram itself is required"] })];
  return makeEvidenceContract({ tool, filename, query, evidence, inference, needsVerification, warnings: ["Caption index is text-layer based; use it to locate visual pages, then verify the original PDF page."], recommendedNextTools: [`get_figure_context(filename="${filename}", figure_id="<figure-id>")`, `read_pdf_pages(filename="${filename}", start_page=<page>, end_page=<page>)`] });
}

function formatFigureList(result, mode = "list") {
  const rows = result.results || [];
  const lines = [];
  lines.push(mode === "find" ? "Figure/Table Search Results" : "Figure/Table Candidates");
  lines.push(`File: ${result.index.filename}`);
  lines.push(`Figures indexed: ${result.index.figureCount}`);
  lines.push(`Kind stats: ${JSON.stringify(result.index.kindStats || {})}`);
  if (result.query) lines.push(`Query: ${result.query}`);
  if (result.filter) lines.push(`Filter: ${result.filter}`);
  if (result.kind) lines.push(`Kind filter: ${result.kind}`);
  lines.push(`Shown: ${rows.length}`);
  lines.push("Reliability: caption/context index only; it locates candidate visual pages but does not OCR or interpret the image/vector itself.");
  lines.push("");

  if (!rows.length) {
    lines.push("No figure/table candidates found.");
    lines.push("Suggested: search_pdf(filename=..., query=\"Figure clock tree timing diagram block diagram\") or read relevant section pages.");
    return appendEvidenceContract(lines.join("\n"), buildFigureEvidenceContract(mode === "find" ? "find_figure" : "list_figures", result.index.filename, result.query || result.filter || "", []));
  }

  lines.push("| # | ID | Page | Kind | Caption | Score/Conf | Context |");
  lines.push("|---:|---|---:|---|---|---:|---|");
  rows.forEach((figure, index) => {
    lines.push(`| ${index + 1} | ${figure.id} | ${figure.page} | ${figure.kind} | ${String(figure.caption || figure.title).replace(/\|/g, "/").slice(0, 140)} | ${figure.matchScore || figure.confidence || 0} | ${String(figure.contextPreview || "").replace(/\|/g, "/").slice(0, 160)} |`);
  });

  lines.push("", "Suggested follow-up:");
  for (const figure of rows.slice(0, 8)) {
    lines.push(`- get_figure_context(filename="${result.index.filename}", figure_id="${figure.id}", include_pages=1, include_layout_tables=true)`);
  }

  return appendEvidenceContract(lines.join("\n"), buildFigureEvidenceContract(mode === "find" ? "find_figure" : "list_figures", result.index.filename, result.query || result.filter || "", rows));
}

function formatFigureContext(result) {
  const figure = result.figure;
  const lines = [];
  lines.push("Figure/Table Context");
  lines.push(`File: ${result.filename}`);
  lines.push(`Figure ID: ${figure.id}`);
  lines.push(`Page: ${figure.page}`);
  lines.push(`Kind: ${figure.kind}`);
  lines.push(`Caption: ${figure.caption}`);
  lines.push(`Source: ${figure.source}`);
  lines.push(`Confidence: ${figure.confidence}`);
  if ((figure.headings || []).length) lines.push(`Headings: ${figure.headings.join(" | ")}`);
  lines.push("");
  lines.push("Caption-near context:");
  for (const line of figure.contextLines || []) lines.push(`- ${line}`);
  lines.push("");
  lines.push(`Page text range: ${result.startPage}-${result.endPage}`);
  for (const page of result.pages || []) {
    lines.push("", `--- Page ${page.page} text preview ---`);
    lines.push(compactText(page.text || "", 3500));
  }

  if (result.layoutTables) {
    lines.push("", "Layout table candidates on context pages:");
    if (result.layoutTables.error) lines.push(`- Error: ${result.layoutTables.error}`);
    else {
      for (const table of result.layoutTables.tables || []) {
        lines.push(`- Page ${table.page}, kind=${table.kind}, confidence=${table.confidence}, header=${compactText(table.headerText || "", 180)}`);
        for (const row of table.previewRows || []) lines.push(`  row: ${compactText(row.text || "", 220)}`);
      }
    }
  }

  lines.push("", "Suggested next steps:");
  lines.push(`- read_pdf_pages(filename="${result.filename}", start_page=${figure.page}, end_page=${figure.page})`);
  lines.push(`- extract_layout_tables_from_pages(filename="${result.filename}", start_page=${result.startPage}, end_page=${result.endPage}, kind="all")`);
  lines.push("- If the actual graphic content is required, open/render the original PDF page visually; this tool only indexes text/captions around it.");

  return appendEvidenceContract(lines.join("\n"), buildFigureEvidenceContract("get_figure_context", result.filename, figure.caption, [figure]));
}



// -----------------------------------------------------------------------------
// Step 32: visual review handoff pack
// -----------------------------------------------------------------------------

function normalizeVisualDiagramType(value) {
  const raw = String(value || "auto").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const allowed = new Set(["auto", "clock_tree", "timing", "block_diagram", "reset_flow", "interrupt_route", "pinmux", "sequence", "table", "other"]);
  return allowed.has(raw) ? raw : "auto";
}

function inferVisualDiagramType(query = "", kind = "") {
  const text = normalizeForSearch(`${query} ${kind}`);
  if (/clock|pll|oscillator|clk|clock tree|clock distribution/.test(text)) return "clock_tree";
  if (/timing|waveform|read timing|write timing|setup|hold|cycle|pulse width/.test(text)) return "timing";
  if (/block diagram|configuration diagram|module configuration|overview diagram/.test(text)) return "block_diagram";
  if (/reset|power|standby|resume|suspend|initialization flow|setting flow/.test(text)) return "reset_flow";
  if (/interrupt|irq|intc|icu|route|routing|event/.test(text)) return "interrupt_route";
  if (/pin|pinmux|pfc|pmc|ioport|port function|multiplexed/.test(text)) return "pinmux";
  if (/sequence|flow|procedure|operation flow|setting flow/.test(text)) return "sequence";
  if (/table|register table|function assignment|configuration overview/.test(text)) return "table";
  return "other";
}

function visualReviewDepthRules(depth) {
  const d = normalizeReviewDepth(depth);
  if (d === "quick") {
    return [
      "Find the most likely figure/table page and inspect caption/context first.",
      "Render only the top candidate or the supplied page/figure_id.",
      "Extract only the facts needed for the current task and mark the rest as needsVerification.",
    ];
  }
  if (d === "deep") {
    return [
      "Search figure captions, nearby section text, and layout tables for all relevant visual candidates.",
      "Render full page and at least one cropped/zoomed region for each important candidate.",
      "Separate facts read directly from visual evidence from inferences based on caption/context.",
      "Cross-check visual evidence against register/bitfield/sequence/caution tools before proposing a patch.",
      "If the diagram is ambiguous, request a tighter render_pdf_region crop rather than guessing.",
    ];
  }
  return [
    "Find the relevant figure/table candidates from captions/context.",
    "Get figure context and render the best candidate page/region.",
    "Extract concrete visual facts and list ambiguity explicitly.",
    "Use manual text/register tools to verify any driver-relevant conclusion.",
  ];
}

function visualReviewOutputRules(format) {
  const f = normalizeReviewOutputFormat(format);
  if (f === "debug_plan") {
    return [
      "Final output must be a debug plan with hypotheses, visual evidence, manual-text evidence, and tests.",
      "Do not turn a diagram interpretation into a code change without a verification call or explicit uncertainty.",
    ];
  }
  if (f === "patch_plan") {
    return [
      "Final output must be a patch plan grouped by source file/function.",
      "Every hardware-register or DTS/pinctrl/clock/reset change must reference the relevant visual/manual evidence and remaining verification gaps.",
    ];
  }
  if (f === "checklist") {
    return [
      "Final output must be a checklist: visual evidence found / source impact / manual verification / needsVerification.",
    ];
  }
  return [
    "Final output must be a structured visual-review report.",
    "Use sections: visual target, evidence gathered, extracted facts, source-code implications, uncertainties, next actions.",
  ];
}

function buildVisualReviewExtractionSchema(diagramType) {
  const common = {
    visual_target: "<caption/page/query being reviewed>",
    figure_id: "<figure id if available>",
    page: "<page number>",
    rendered_files: ["<full page or cropped render output paths>"],
    direct_visual_observations: ["<facts visible in the rendered figure/diagram>"],
    caption_context_facts: ["<facts from caption or nearby text>"],
    manual_text_cross_checks: ["<read_pdf_pages/get_figure_context/extract_layout_tables evidence>"],
    source_implications: ["<what this means for driver/DTS/source review>"],
    needs_verification: ["<ambiguities or facts not proven visually/manual-textually>"],
  };

  if (diagramType === "clock_tree") {
    return { ...common, clocks: ["<clock name/source/divider/gate relationship>"], reset_or_power_domains: ["<domain/reset relation if visible>"] };
  }
  if (diagramType === "timing") {
    return { ...common, signals: ["<signal name>"], edges: ["<edge/phase relationship>"], timing_constraints: ["<setup/hold/min/max/cycle timing>"], units: ["<ns/cycles/clock units>"] };
  }
  if (diagramType === "interrupt_route") {
    return { ...common, interrupt_sources: ["<source flag/signal>"], routing: ["<route/mux/controller relation>"], clear_or_mask_semantics: ["<status clear/mask relation if visible>"] };
  }
  if (diagramType === "pinmux") {
    return { ...common, pins: ["<pin/port>"], functions: ["<alternate function/peripheral signal>"], selectors: ["<PFC/PMC/mux select value if visible>"] };
  }
  if (diagramType === "reset_flow" || diagramType === "sequence") {
    return { ...common, steps: ["<ordered step>"], conditions: ["<precondition/poll/wait condition>"], registers_or_bits: ["<register/bit involved>"] };
  }
  if (diagramType === "block_diagram") {
    return { ...common, blocks: ["<block/module>"], connections: ["<signal/data/clock/reset connection>"], interfaces: ["<bus/peripheral interface>"] };
  }
  if (diagramType === "table") {
    return { ...common, table_roles: ["<columns/semantic roles>"], extracted_rows: ["<row facts>"], ambiguous_cells: ["<cells requiring manual check>"] };
  }
  return common;
}

function figureCandidateCommandLines(filename, figure, options = {}) {
  const page = Number(figure?.page || options.page || 0);
  const figureId = figure?.id || "<figure-id>";
  const query = quoteForPromptCall(options.query || figure?.caption || "visual target");
  const includeLayout = options.includeLayoutTables !== false;
  const includeRender = options.includeRenderCommands !== false;
  const lines = [];
  if (figure?.id) {
    lines.push(`get_figure_context(filename="${filename}", figure_id="${figureId}", include_pages=1, include_layout_tables=${includeLayout ? "true" : "false"})`);
    if (includeRender) {
      lines.push(`render_figure_page(filename="${filename}", figure_id="${figureId}", dpi=180, format="png")`);
      lines.push(`render_figure_region(filename="${filename}", figure_id="${figureId}", region="auto", zoom=2, dpi=180, format="png")`);
    }
  } else if (page) {
    lines.push(`get_figure_context(filename="${filename}", page=${page}, query="${query}", include_pages=1, include_layout_tables=${includeLayout ? "true" : "false"})`);
    if (includeRender) {
      lines.push(`render_figure_page(filename="${filename}", page=${page}, query="${query}", dpi=180, format="png")`);
      lines.push(`render_figure_region(filename="${filename}", page=${page}, query="${query}", region="auto", zoom=2, dpi=180, format="png")`);
    }
  }
  if (page) {
    lines.push(`read_pdf_pages(filename="${filename}", start_page=${page}, end_page=${page})`);
    if (includeLayout) lines.push(`extract_layout_tables_from_pages(filename="${filename}", start_page=${Math.max(1, page - 1)}, end_page=${page + 1}, kind="all")`);
  }
  return lines;
}

async function buildVisualReviewHandoffPack(filename, options = {}) {
  ensurePdfFilename(filename);
  const query = String(options.query || "").trim();
  const figureId = String(options.figureId || "").trim();
  const page = Number(options.page || 0);
  const kind = String(options.kind || "").trim();
  const task = String(options.task || query || "visual manual evidence review").trim();
  const reviewDepth = normalizeReviewDepth(options.reviewDepth);
  const outputFormat = normalizeReviewOutputFormat(options.outputFormat);
  const includeLayoutTables = options.includeLayoutTables !== false;
  const includeRenderCommands = options.includeRenderCommands !== false;
  const topK = clampInteger(options.topK, 6, 1, DEFAULT_FIGURE_TOP_K);

  let diagramType = normalizeVisualDiagramType(options.diagramType);
  if (diagramType === "auto") diagramType = inferVisualDiagramType(`${query} ${task}`, kind);

  let figures = [];
  let context = null;
  let searchResult = null;
  const warnings = [];

  try {
    if (figureId || page) {
      context = await getFigureContext(filename, { figureId, page, query, includePages: 1, includeLayoutTables });
      figures = [context.figure];
    } else if (query) {
      searchResult = await findFigure(filename, { query, kind, topK });
      figures = searchResult.results || [];
      if (figures[0]) {
        context = await getFigureContext(filename, { figureId: figures[0].id, includePages: 1, includeLayoutTables }).catch((error) => {
          warnings.push(`Could not get context for top figure: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
      }
    } else {
      const listed = await listFigures(filename, { kind, topK });
      searchResult = listed;
      figures = listed.results || [];
    }
  } catch (error) {
    warnings.push(`Figure search/context failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const primaryFigure = context?.figure || figures[0] || null;
  const workflow = [
    `find_figure(filename="${filename}", query="${quoteForPromptCall(query || task)}", kind="${quoteForPromptCall(kind)}", top_k=${topK})`,
  ];
  if (primaryFigure) workflow.push(...figureCandidateCommandLines(filename, primaryFigure, { query, includeLayoutTables, includeRenderCommands }));
  else if (page) workflow.push(...figureCandidateCommandLines(filename, null, { page, query, includeLayoutTables, includeRenderCommands }));
  else {
    workflow.push(`list_figures(filename="${filename}", filter="${quoteForPromptCall(query || task)}", kind="${quoteForPromptCall(kind)}", top_k=${topK})`);
    workflow.push(`get_figure_context(filename="${filename}", figure_id="<figure-id>", include_pages=1, include_layout_tables=${includeLayoutTables ? "true" : "false"})`);
    if (includeRenderCommands) workflow.push(`render_figure_region(filename="${filename}", figure_id="<figure-id>", region="auto", zoom=2, dpi=180, format="png")`);
  }

  return {
    filename,
    createdAt: new Date().toISOString(),
    task,
    query,
    kind,
    diagramType,
    reviewDepth,
    outputFormat,
    sourceFiles: normalizeStringArray(options.sourceFiles),
    figures,
    primaryFigure,
    context,
    searchResult,
    workflow,
    depthRules: visualReviewDepthRules(reviewDepth),
    outputRules: visualReviewOutputRules(outputFormat),
    extractionSchema: buildVisualReviewExtractionSchema(diagramType),
    approvalRules: [
      "Do not infer driver behavior solely from a rendered diagram; cross-check with manual text/register/bitfield/sequence/caution evidence.",
      "When a visual edge/arrow/timing relation is unclear, request a tighter render_pdf_region/render_figure_region crop instead of guessing.",
      "Separate direct visual observations from caption/context text and from engineering inference.",
      "For code or DTS changes, map each visual fact to source impact and list remaining needsVerification.",
    ],
    warnings,
  };
}

function buildVisualReviewHandoffContract(pack) {
  const evidence = (pack.figures || []).slice(0, 10).map((figure) => makeEvidence({
    source: "figures-index",
    evidenceType: figure.kind || "figure-caption",
    page: figure.page,
    quote: figure.caption || figure.title,
    confidence: figure.confidence || "medium",
    name: figure.id,
    field: pack.diagramType,
    tool: "visual_review_handoff_pack",
  }));

  const inference = [makeInference({
    statement: `Generated visual-review workflow for diagramType=${pack.diagramType}`,
    basis: pack.query || pack.task || (pack.primaryFigure ? pack.primaryFigure.caption : "figure/list context"),
    confidence: pack.primaryFigure ? "medium" : "low",
    risk: "Visual-review handoff pack guides analysis but does not itself interpret the rendered image.",
  })];

  const needsVerification = [makeNeedsVerification({
    item: "Rendered visual content",
    reason: "The pack creates the workflow and suggested render commands. The agent/user must inspect generated PNG/JPG/SVG outputs and record direct visual observations.",
    suggestedTools: pack.workflow.filter((line) => /render_figure|render_pdf|get_figure|read_pdf|extract_layout/.test(line)).slice(0, 8),
  })];

  return makeEvidenceContract({
    tool: "visual_review_handoff_pack",
    filename: pack.filename,
    query: pack.query || pack.task,
    evidence,
    inference,
    needsVerification,
    warnings: pack.warnings || [],
    recommendedNextTools: pack.workflow || [],
  });
}

function formatVisualReviewHandoffPack(pack) {
  const lines = [];
  lines.push("Visual Review Handoff Pack");
  lines.push(`File: ${pack.filename}`);
  lines.push(`Created: ${pack.createdAt}`);
  lines.push(`Task: ${pack.task}`);
  lines.push(`Query: ${pack.query || "not specified"}`);
  lines.push(`Kind filter: ${pack.kind || "none"}`);
  lines.push(`Diagram type: ${pack.diagramType}`);
  lines.push(`Review depth: ${pack.reviewDepth}`);
  lines.push(`Output format: ${pack.outputFormat}`);
  if ((pack.sourceFiles || []).length) lines.push(`Source files: ${pack.sourceFiles.join(", ")}`);
  for (const warning of pack.warnings || []) lines.push(`Warning: ${warning}`);
  lines.push("");

  lines.push("1. Candidate figures/tables");
  if ((pack.figures || []).length) {
    lines.push("| # | ID | Page | Kind | Caption | Score/Conf |");
    lines.push("|---:|---|---:|---|---|---:|");
    (pack.figures || []).slice(0, 10).forEach((figure, index) => {
      lines.push(`| ${index + 1} | ${figure.id} | ${figure.page} | ${figure.kind} | ${String(figure.caption || figure.title || "").replace(/\|/g, "/").slice(0, 140)} | ${figure.matchScore || figure.confidence || 0} |`);
    });
  } else {
    lines.push("- No candidate figures found yet. Use the workflow commands below to search/list figures.");
  }
  lines.push("");

  if (pack.context?.figure) {
    lines.push("2. Primary figure context");
    lines.push(`- ID: ${pack.context.figure.id}`);
    lines.push(`- Page: ${pack.context.figure.page}`);
    lines.push(`- Kind: ${pack.context.figure.kind}`);
    lines.push(`- Caption: ${pack.context.figure.caption}`);
    if ((pack.context.figure.contextLines || []).length) {
      lines.push("- Caption-near context:");
      for (const line of pack.context.figure.contextLines.slice(0, 10)) lines.push(`  - ${line}`);
    }
    lines.push("");
  }

  lines.push("3. Mandatory visual-review workflow");
  for (const call of pack.workflow || []) lines.push(`- ${call}`);
  lines.push("");

  lines.push("4. Prompt to give the VS Code AI agent");
  lines.push("```");
  lines.push("You are reviewing hardware-manual visual evidence using the local PDF MCP server.");
  lines.push(`Manual PDF: ${pack.filename}`);
  lines.push(`Task: ${pack.task}`);
  lines.push(`Visual target/query: ${pack.query || "<discover relevant figure/table/diagram>"}`);
  lines.push(`Expected diagram type: ${pack.diagramType}`);
  if ((pack.sourceFiles || []).length) {
    lines.push("Also inspect these source/DTS files in the VS Code workspace:");
    for (const file of pack.sourceFiles) lines.push(`- ${file}`);
  }
  lines.push("");
  lines.push("Mandatory MCP workflow:");
  for (const call of pack.workflow || []) lines.push(`- ${call}`);
  lines.push("");
  lines.push("When you inspect rendered images, fill this extraction schema:");
  lines.push(JSON.stringify(pack.extractionSchema, null, 2));
  lines.push("");
  lines.push("Depth rules:");
  for (const rule of pack.depthRules || []) lines.push(`- ${rule}`);
  lines.push("");
  lines.push("Output rules:");
  for (const rule of pack.outputRules || []) lines.push(`- ${rule}`);
  lines.push("");
  lines.push("Approval rules:");
  for (const rule of pack.approvalRules || []) lines.push(`- ${rule}`);
  lines.push("```");
  lines.push("");

  lines.push("5. Extraction schema");
  lines.push(JSON.stringify(pack.extractionSchema, null, 2));
  lines.push("");
  lines.push("6. Approval rules");
  for (const rule of pack.approvalRules || []) lines.push(`- ${rule}`);

  return appendEvidenceContract(lines.join("\n"), buildVisualReviewHandoffContract(pack));
}


// -----------------------------------------------------------------------------
// Step 33: persisted visual evidence helpers
// -----------------------------------------------------------------------------

function normalizeVisualEvidenceStatus(value) {
  const raw = String(value || "needs_verification").trim().toLowerCase();
  if (["observed", "needs_verification", "verified", "rejected"].includes(raw)) return raw;
  return "needs_verification";
}

function visualEvidenceId(page = 0) {
  const pagePart = Number.isFinite(Number(page)) && Number(page) > 0 ? `p${Number(page)}` : "pna";
  return `ve-${pagePart}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function compactStringArray(values, maxItems = 40, maxChars = 360) {
  return normalizeStringArray(values).slice(0, maxItems).map((item) => compactText(item, maxChars));
}

function normalizePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function flattenVisualExtractedItems(value) {
  const obj = normalizePlainObject(value);
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val)) {
      for (const item of val) lines.push(`${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`);
    } else if (val && typeof val === "object") {
      lines.push(`${key}: ${JSON.stringify(val)}`);
    } else if (val !== undefined && val !== null && String(val).trim()) {
      lines.push(`${key}: ${String(val)}`);
    }
  }
  return lines;
}

async function loadVisualEvidenceIndex(filename) {
  const filePath = safeVisualEvidencePath(filename);
  if (!(await pathExists(filePath))) {
    return {
      schemaVersion: VISUAL_EVIDENCE_SCHEMA_VERSION,
      serverVersion: SERVER_VERSION,
      filename,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: [],
    };
  }
  const raw = await fs.readFile(filePath, "utf-8");
  const data = JSON.parse(raw);
  if (data.schemaVersion !== VISUAL_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported visual evidence schemaVersion ${data.schemaVersion}; expected ${VISUAL_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(data.entries)) data.entries = [];
  return data;
}

async function saveVisualEvidenceIndex(filename, data) {
  data.schemaVersion = VISUAL_EVIDENCE_SCHEMA_VERSION;
  data.serverVersion = SERVER_VERSION;
  data.filename = filename;
  data.updatedAt = new Date().toISOString();
  if (!data.createdAt) data.createdAt = data.updatedAt;
  if (!Array.isArray(data.entries)) data.entries = [];
  await atomicWriteJson(safeVisualEvidencePath(filename), data);
  return data;
}

async function resolveVisualEvidenceFigure(filename, { figureId = "", page = 0, query = "" } = {}) {
  if (!figureId && !page && !query) return null;
  try {
    const result = await getFigureContext(filename, { figureId, page, query, includePages: 0, includeLayoutTables: false });
    return result.figure || null;
  } catch {
    return null;
  }
}

async function addVisualEvidence(filename, options = {}) {
  ensurePdfFilename(filename);
  const page = Number(options.page || 0);
  let diagramType = normalizeVisualDiagramType(options.diagramType || "auto");
  const query = String(options.query || "").trim();
  const figureId = String(options.figureId || "").trim();
  const figure = await resolveVisualEvidenceFigure(filename, { figureId, page, query });
  if (diagramType === "auto") diagramType = inferVisualDiagramType(`${query} ${figure?.caption || ""}`, figure?.kind || "");

  const entry = {
    id: visualEvidenceId(page || figure?.page || 0),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    filename,
    figureId: figureId || figure?.id || "",
    page: Number.isFinite(page) && page > 0 ? page : (figure?.page || null),
    query,
    diagramType,
    figure: figure ? {
      id: figure.id,
      page: figure.page,
      kind: figure.kind,
      caption: figure.caption || figure.title || "",
    } : null,
    renderedPath: String(options.renderedPath || "").trim(),
    renderedRegion: normalizePlainObject(options.renderedRegion),
    directVisualObservations: compactStringArray(options.directVisualObservations, 80),
    captionContextFacts: compactStringArray(options.captionContextFacts, 80),
    extractedItems: normalizePlainObject(options.extractedItems),
    engineeringInferences: compactStringArray(options.engineeringInferences, 80),
    sourceImplications: compactStringArray(options.sourceImplications, 80),
    uncertainties: compactStringArray(options.uncertainties, 80),
    relatedRegisters: compactStringArray(options.relatedRegisters, 60, 160),
    relatedBitfields: compactStringArray(options.relatedBitfields, 80, 160),
    sourceFiles: compactStringArray(options.sourceFiles, 80, 220),
    tags: compactStringArray(options.tags, 40, 80),
    verificationStatus: normalizeVisualEvidenceStatus(options.verificationStatus),
    confidence: confidenceLevel(options.confidence || "medium"),
    notes: compactText(String(options.notes || ""), 1000),
  };

  if (!entry.directVisualObservations.length && !entry.captionContextFacts.length && !flattenVisualExtractedItems(entry.extractedItems).length && !entry.engineeringInferences.length) {
    entry.uncertainties.push("No direct visual observations or extracted items were supplied when this evidence entry was created.");
    entry.verificationStatus = "needs_verification";
  }

  const index = await loadVisualEvidenceIndex(filename);
  index.entries.push(entry);
  await saveVisualEvidenceIndex(filename, index);
  return { index, entry, path: safeVisualEvidencePath(filename) };
}

function visualEvidenceSearchText(entry) {
  return normalizeForSearch([
    entry.id,
    entry.figureId,
    entry.query,
    entry.diagramType,
    entry.figure?.caption,
    entry.renderedPath,
    ...(entry.directVisualObservations || []),
    ...(entry.captionContextFacts || []),
    ...flattenVisualExtractedItems(entry.extractedItems),
    ...(entry.engineeringInferences || []),
    ...(entry.sourceImplications || []),
    ...(entry.uncertainties || []),
    ...(entry.relatedRegisters || []),
    ...(entry.relatedBitfields || []),
    ...(entry.sourceFiles || []),
    ...(entry.tags || []),
    entry.verificationStatus,
  ].filter(Boolean).join(" "));
}

function filterVisualEvidenceEntries(entries, options = {}) {
  const filter = normalizeForSearch(options.filter || "");
  const diagramType = String(options.diagramType || "").trim().toLowerCase();
  const status = String(options.status || "").trim().toLowerCase();
  const page = Number(options.page || 0);
  return (entries || []).filter((entry) => {
    if (diagramType && String(entry.diagramType || "").toLowerCase() !== diagramType) return false;
    if (status && String(entry.verificationStatus || "").toLowerCase() !== status) return false;
    if (Number.isFinite(page) && page > 0 && Number(entry.page || 0) !== page) return false;
    if (filter && !visualEvidenceSearchText(entry).includes(filter)) return false;
    return true;
  });
}

async function listVisualEvidence(filename, options = {}) {
  const index = await loadVisualEvidenceIndex(filename);
  const topK = clampInteger(options.topK, 20, 1, 200);
  const results = filterVisualEvidenceEntries(index.entries, options)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, topK);
  return { filename, path: safeVisualEvidencePath(filename), index, results, filter: options.filter || "" };
}

async function getVisualEvidence(filename, evidenceId) {
  const index = await loadVisualEvidenceIndex(filename);
  const entry = (index.entries || []).find((item) => item.id === evidenceId);
  if (!entry) throw new Error(`Visual evidence entry not found: ${evidenceId}`);
  return { filename, path: safeVisualEvidencePath(filename), index, entry };
}

function buildVisualEvidenceRecommendedTools(filename, entry) {
  const tools = [];
  if (entry.figureId) tools.push(`get_figure_context(filename="${filename}", figure_id="${entry.figureId}", include_pages=1, include_layout_tables=true)`);
  else if (entry.page) tools.push(`get_figure_context(filename="${filename}", page=${entry.page}, query="${quoteForPromptCall(entry.query || entry.figure?.caption || "")}", include_pages=1, include_layout_tables=true)`);
  if (entry.page) tools.push(`read_pdf_pages(filename="${filename}", start_page=${entry.page}, end_page=${entry.page})`);
  if (entry.page) tools.push(`render_figure_region(filename="${filename}", page=${entry.page}, query="${quoteForPromptCall(entry.query || entry.figure?.caption || "")}", region="auto", zoom=2, dpi=180, format="png")`);
  for (const reg of (entry.relatedRegisters || []).slice(0, 3)) {
    tools.push(`verify_register_usage(filename="${filename}", register="${quoteForPromptCall(reg)}", operation="<operation related to visual evidence>", access_type="auto", intent="auto")`);
  }
  return tools.slice(0, 10);
}

function buildVisualEvidenceContract(tool, filename, entries, query = "") {
  const selected = (entries || []).slice(0, 10);
  const evidence = selected.map((entry) => makeEvidence({
    source: "visual-evidence-index",
    evidenceType: entry.diagramType || "visual-evidence",
    page: entry.page,
    quote: (entry.directVisualObservations || [])[0] || (entry.captionContextFacts || [])[0] || entry.figure?.caption || entry.query || entry.id,
    confidence: entry.confidence || "medium",
    name: entry.id,
    field: entry.verificationStatus,
    tool,
  }));
  const inference = selected.flatMap((entry) => (entry.engineeringInferences || []).slice(0, 2).map((text) => makeInference({
    statement: text,
    basis: entry.id,
    confidence: entry.confidence || "medium",
    risk: "Stored engineering inference; verify against manual text/register evidence before using in driver changes.",
  }))).slice(0, 12);
  const needsVerification = selected.filter((entry) => entry.verificationStatus !== "verified").map((entry) => makeNeedsVerification({
    item: `${entry.id} (${entry.diagramType})`,
    reason: entry.uncertainties?.length ? entry.uncertainties.join("; ") : "Visual evidence is not marked verified.",
    suggestedTools: buildVisualEvidenceRecommendedTools(filename, entry),
  })).slice(0, 12);
  return makeEvidenceContract({
    tool,
    filename,
    query,
    evidence,
    inference,
    needsVerification,
    warnings: ["Visual evidence entries are user/agent observations from rendered pages. Cross-check critical driver facts with manual text/register/bitfield/sequence/caution tools."],
    recommendedNextTools: selected.flatMap((entry) => buildVisualEvidenceRecommendedTools(filename, entry)).slice(0, 12),
  });
}

function formatVisualEvidenceEntry(entry, detailed = true) {
  const lines = [];
  lines.push(`- ${entry.id}`);
  lines.push(`  page: ${entry.page || "unknown"}`);
  lines.push(`  diagramType: ${entry.diagramType}`);
  lines.push(`  status: ${entry.verificationStatus}`);
  lines.push(`  confidence: ${entry.confidence}`);
  const supportSummary = verificationSupportSummary(entry);
  if (supportSummary.supportingEvidenceCount || supportSummary.supportingToolCallCount || supportSummary.verificationHistoryCount) {
    lines.push(`  verification support: evidence=${supportSummary.supportingEvidenceCount}, tool_calls=${supportSummary.supportingToolCallCount}, history=${supportSummary.verificationHistoryCount}`);
    if (supportSummary.lastVerifiedAt) lines.push(`  verifiedAt: ${supportSummary.lastVerifiedAt}`);
  }
  if (entry.figureId) lines.push(`  figure: ${entry.figureId}${entry.figure?.caption ? ` — ${entry.figure.caption}` : ""}`);
  if (entry.renderedPath) lines.push(`  rendered: ${entry.renderedPath}`);
  if ((entry.tags || []).length) lines.push(`  tags: ${entry.tags.join(", ")}`);
  if (!detailed) return lines;
  if ((entry.directVisualObservations || []).length) {
    lines.push("  direct visual observations:");
    for (const item of entry.directVisualObservations) lines.push(`    - ${item}`);
  }
  if ((entry.captionContextFacts || []).length) {
    lines.push("  caption/context facts:");
    for (const item of entry.captionContextFacts) lines.push(`    - ${item}`);
  }
  const extracted = flattenVisualExtractedItems(entry.extractedItems);
  if (extracted.length) {
    lines.push("  extracted items:");
    for (const item of extracted.slice(0, 30)) lines.push(`    - ${item}`);
  }
  if ((entry.engineeringInferences || []).length) {
    lines.push("  engineering inferences:");
    for (const item of entry.engineeringInferences) lines.push(`    - ${item}`);
  }
  if ((entry.sourceImplications || []).length) {
    lines.push("  source implications:");
    for (const item of entry.sourceImplications) lines.push(`    - ${item}`);
  }
  if ((entry.uncertainties || []).length) {
    lines.push("  uncertainties / needs verification:");
    for (const item of entry.uncertainties) lines.push(`    - ${item}`);
  }
  if ((entry.relatedRegisters || []).length) lines.push(`  related registers: ${entry.relatedRegisters.join(", ")}`);
  if ((entry.relatedBitfields || []).length) lines.push(`  related bitfields: ${entry.relatedBitfields.join(", ")}`);
  if ((entry.sourceFiles || []).length) lines.push(`  source files: ${entry.sourceFiles.join(", ")}`);
  if (entry.notes) lines.push(`  notes: ${entry.notes}`);
  return lines;
}

function formatAddVisualEvidence(result) {
  const { filename, path: filePath, entry, index } = result;
  const lines = [];
  lines.push("Visual Evidence Added");
  lines.push(`File: ${filename}`);
  lines.push(`Evidence ID: ${entry.id}`);
  lines.push(`Page: ${entry.page || "unknown"}`);
  lines.push(`Diagram type: ${entry.diagramType}`);
  lines.push(`Status: ${entry.verificationStatus}`);
  lines.push(`Confidence: ${entry.confidence}`);
  lines.push(`Store: ${filePath}`);
  lines.push(`Total entries: ${index.entries.length}`);
  lines.push("");
  lines.push(...formatVisualEvidenceEntry(entry, true));
  lines.push("");
  lines.push("Suggested next calls:");
  for (const call of buildVisualEvidenceRecommendedTools(filename, entry)) lines.push(`- ${call}`);
  return appendEvidenceContract(lines.join("\n"), buildVisualEvidenceContract("add_visual_evidence", filename, [entry], entry.query));
}

function formatListVisualEvidence(result) {
  const lines = [];
  lines.push("Visual Evidence Entries");
  lines.push(`File: ${result.filename}`);
  lines.push(`Store: ${result.path}`);
  lines.push(`Total stored: ${result.index.entries.length}`);
  lines.push(`Shown: ${result.results.length}`);
  if (result.filter) lines.push(`Filter: ${result.filter}`);
  lines.push("");
  if (!result.results.length) lines.push("- No visual evidence entries matched.");
  else for (const entry of result.results) lines.push(...formatVisualEvidenceEntry(entry, false));
  return appendEvidenceContract(lines.join("\n"), buildVisualEvidenceContract("list_visual_evidence", result.filename, result.results, result.filter));
}

function formatGetVisualEvidence(result) {
  const lines = [];
  lines.push("Visual Evidence Entry");
  lines.push(`File: ${result.filename}`);
  lines.push(`Store: ${result.path}`);
  lines.push("");
  lines.push(...formatVisualEvidenceEntry(result.entry, true));
  lines.push("");
  lines.push("Suggested next calls:");
  for (const call of buildVisualEvidenceRecommendedTools(result.filename, result.entry)) lines.push(`- ${call}`);
  return appendEvidenceContract(lines.join("\n"), buildVisualEvidenceContract("get_visual_evidence", result.filename, [result.entry], result.entry.id));
}

async function buildVisualEvidenceReport(filename, options = {}) {
  const index = await loadVisualEvidenceIndex(filename);
  const topK = clampInteger(options.topK, 50, 1, 300);
  const entries = filterVisualEvidenceEntries(index.entries, options)
    .sort((a, b) => String(a.diagramType || "").localeCompare(String(b.diagramType || "")) || Number(a.page || 0) - Number(b.page || 0))
    .slice(0, topK);
  const byType = new Map();
  const byStatus = new Map();
  for (const entry of entries) {
    byType.set(entry.diagramType || "unknown", (byType.get(entry.diagramType || "unknown") || 0) + 1);
    byStatus.set(entry.verificationStatus || "unknown", (byStatus.get(entry.verificationStatus || "unknown") || 0) + 1);
  }
  return { filename, path: safeVisualEvidencePath(filename), index, entries, byType, byStatus, includeEntries: options.includeEntries !== false, filter: options.filter || "" };
}

function formatVisualEvidenceReport(report) {
  const lines = [];
  lines.push("Visual Evidence Report");
  lines.push(`File: ${report.filename}`);
  lines.push(`Store: ${report.path}`);
  lines.push(`Total stored: ${report.index.entries.length}`);
  lines.push(`Included: ${report.entries.length}`);
  if (report.filter) lines.push(`Filter: ${report.filter}`);
  lines.push("");
  lines.push("Summary by diagram type:");
  if (!report.byType.size) lines.push("- none");
  for (const [type, count] of report.byType.entries()) lines.push(`- ${type}: ${count}`);
  lines.push("");
  lines.push("Summary by status:");
  if (!report.byStatus.size) lines.push("- none");
  for (const [status, count] of report.byStatus.entries()) lines.push(`- ${status}: ${count}`);
  lines.push("");
  lines.push("Driver-review usage rule:");
  lines.push("- Direct visual observations may guide review, but critical register/bitfield/sequence facts must still be verified with manual text/table tools.");
  lines.push("- Engineering inferences from visual evidence must not be treated as hardware facts unless verification_status=verified and supporting manual evidence exists.");
  lines.push("");
  if (report.includeEntries) {
    lines.push("Entries:");
    if (!report.entries.length) lines.push("- No matching visual evidence entries.");
    for (const entry of report.entries) {
      lines.push(...formatVisualEvidenceEntry(entry, true));
      lines.push("");
    }
  } else {
    lines.push("Entries omitted. Use include_entries=true or get_visual_evidence for details.");
  }
  lines.push("Machine summary JSON:");
  lines.push(JSON.stringify({
    filename: report.filename,
    totalStored: report.index.entries.length,
    included: report.entries.length,
    byType: Object.fromEntries(report.byType.entries()),
    byStatus: Object.fromEntries(report.byStatus.entries()),
    entries: report.entries.slice(0, 40).map((entry) => ({ id: entry.id, page: entry.page, figureId: entry.figureId, diagramType: entry.diagramType, status: entry.verificationStatus, confidence: entry.confidence, tags: entry.tags })),
  }, null, 2));
  return appendEvidenceContract(lines.join("\n"), buildVisualEvidenceContract("visual_evidence_report", report.filename, report.entries, report.filter));
}

// -----------------------------------------------------------------------------
// Step 35: visual evidence verification status workflow
// -----------------------------------------------------------------------------

function normalizeSupportingEvidenceItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 80).map((item) => {
    if (typeof item === "string") {
      return { type: "other", quote: compactText(item, 800) };
    }
    if (!item || typeof item !== "object") return null;
    return {
      type: compactText(String(item.type || "other"), 80),
      tool: compactText(String(item.tool || ""), 120),
      page: Number.isFinite(Number(item.page)) && Number(item.page) > 0 ? Number(item.page) : null,
      register: compactText(String(item.register || ""), 120),
      bitfield: compactText(String(item.bitfield || ""), 120),
      quote: compactText(String(item.quote || ""), 1200),
      note: compactText(String(item.note || ""), 1200),
    };
  }).filter(Boolean).filter((item) => item.quote || item.note || item.tool || item.register || item.bitfield || item.page);
}

function visualEvidenceVerificationRequirements(entry) {
  const text = normalizeForSearch([
    entry.diagramType,
    entry.query,
    entry.figure?.caption,
    ...(entry.directVisualObservations || []),
    ...(entry.engineeringInferences || []),
    ...(entry.sourceImplications || []),
    ...(entry.relatedRegisters || []),
    ...(entry.relatedBitfields || []),
    ...(entry.tags || []),
  ].filter(Boolean).join(" "));

  const requirements = [];
  requirements.push("Confirm the figure/table caption and surrounding manual text with get_figure_context or read_pdf_pages.");

  if (/register|bit|field|w1c|w0c|clear|reserved|status|control/.test(text) || (entry.relatedRegisters || []).length) {
    requirements.push("Verify affected register/bitfield semantics with verify_register_usage or extract_bitfield_table.");
  }
  if (/sequence|flow|reset|start|stop|enable|disable|order|wait|poll/.test(text)) {
    requirements.push("Verify operation order with get_sequence and surrounding page text.");
  }
  if (/caution|restriction|reserved|prohibited|undefined|only when|must/.test(text)) {
    requirements.push("Verify restrictions with get_cautions_for_register or find_caution.");
  }
  if (/clock|pll|divider|gate|mstp|module clock/.test(text)) {
    requirements.push("Cross-check clock source/divider/gate assumptions against manual text and clock/reset registers.");
  }
  if (/timing|setup|hold|cycle|edge|waveform/.test(text)) {
    requirements.push("Cross-check timing constraints against caption/table text and numeric timing notes.");
  }
  if (/pinmux|pfc|pmc|ioport|port|pin|function|selector/.test(text)) {
    requirements.push("Cross-check pin/function selector values with extract_pinmux_table and page text.");
  }
  if (/interrupt|irq|route|mask|status/.test(text)) {
    requirements.push("Cross-check interrupt routing/status/clear semantics with sequence/caution/register evidence.");
  }

  return [...new Set(requirements)];
}

function visualEvidenceVerificationSuggestedTools(filename, entry) {
  const tools = [];
  if (entry.figureId) tools.push(`get_figure_context(filename="${filename}", figure_id="${entry.figureId}", include_pages=1, include_layout_tables=true)`);
  else if (entry.page) tools.push(`get_figure_context(filename="${filename}", page=${entry.page}, query="${quoteForPromptCall(entry.query || entry.figure?.caption || "")}", include_pages=1, include_layout_tables=true)`);
  if (entry.page) tools.push(`read_pdf_pages(filename="${filename}", start_page=${entry.page}, end_page=${entry.page})`);
  if (entry.page && /pinmux|pfc|pmc|pin|port|function|selector/i.test(visualEvidenceSearchText(entry))) {
    tools.push(`extract_pinmux_table(filename="${filename}", start_page=${entry.page}, end_page=${entry.page}, filter="${quoteForPromptCall(entry.query || "pin function")}")`);
  }
  if (entry.page) tools.push(`extract_layout_tables_from_pages(filename="${filename}", start_page=${entry.page}, end_page=${entry.page}, kind="auto")`);
  for (const reg of (entry.relatedRegisters || []).slice(0, 4)) {
    tools.push(`verify_register_usage(filename="${filename}", register="${quoteForPromptCall(reg)}", operation="<operation supported by ${entry.id}>", access_type="auto", intent="auto")`);
    tools.push(`get_cautions_for_register(filename="${filename}", register="${quoteForPromptCall(reg)}")`);
  }
  if (/sequence|flow|reset|start|stop|enable|disable|order|wait|poll/i.test(visualEvidenceSearchText(entry))) {
    tools.push(`get_sequence(filename="${filename}", topic="${quoteForPromptCall(entry.query || entry.diagramType || "visual sequence")}")`);
  }
  return [...new Set(tools)].slice(0, 14);
}

function verificationSupportSummary(entry) {
  const support = Array.isArray(entry.supportingEvidence) ? entry.supportingEvidence : [];
  const calls = Array.isArray(entry.supportingToolCalls) ? entry.supportingToolCalls : [];
  const history = Array.isArray(entry.verificationHistory) ? entry.verificationHistory : [];
  return {
    supportingEvidenceCount: support.length,
    supportingToolCallCount: calls.length,
    verificationHistoryCount: history.length,
    lastVerifiedAt: entry.verifiedAt || "",
  };
}

async function updateVisualEvidenceVerification(filename, evidenceId, options = {}) {
  ensurePdfFilename(filename);
  const status = normalizeVisualEvidenceStatus(options.status);
  const index = await loadVisualEvidenceIndex(filename);
  const entry = (index.entries || []).find((item) => item.id === evidenceId);
  if (!entry) throw new Error(`Visual evidence entry not found: ${evidenceId}`);

  const supportingEvidence = normalizeSupportingEvidenceItems(options.supportingEvidence);
  const supportingToolCalls = compactStringArray(options.supportingToolCalls, 80, 600);
  const resolvedUncertainties = compactStringArray(options.resolvedUncertainties, 80, 400);
  const remainingUncertainties = compactStringArray(options.remainingUncertainties, 80, 400);
  const note = compactText(String(options.verificationNote || options.notes || ""), 2000);
  const allowWithoutSupport = Boolean(options.allowWithoutSupport);

  if (status === "verified" && !allowWithoutSupport && !supportingEvidence.length && !supportingToolCalls.length) {
    throw new Error("status=verified requires supporting_evidence or supporting_tool_calls. Use status=observed/needs_verification, or set allow_without_support=true only for exceptional cases.");
  }

  const beforeStatus = entry.verificationStatus || "needs_verification";
  if (!Array.isArray(entry.supportingEvidence)) entry.supportingEvidence = [];
  if (!Array.isArray(entry.supportingToolCalls)) entry.supportingToolCalls = [];
  if (!Array.isArray(entry.verificationHistory)) entry.verificationHistory = [];

  entry.verificationStatus = status;
  if (options.confidence) entry.confidence = confidenceLevel(options.confidence);
  entry.updatedAt = new Date().toISOString();
  if (status === "verified") entry.verifiedAt = entry.updatedAt;
  if (status === "rejected") entry.rejectedAt = entry.updatedAt;

  entry.supportingEvidence.push(...supportingEvidence.map((item) => ({ ...item, addedAt: entry.updatedAt })));
  entry.supportingToolCalls.push(...supportingToolCalls);

  if (remainingUncertainties.length) entry.uncertainties = remainingUncertainties;
  else if (resolvedUncertainties.length && Array.isArray(entry.uncertainties)) {
    const resolvedSet = new Set(resolvedUncertainties.map((item) => normalizeForSearch(item)));
    entry.uncertainties = entry.uncertainties.filter((item) => !resolvedSet.has(normalizeForSearch(item)));
  }

  const tagsToAdd = compactStringArray(options.tagsToAdd, 40, 80);
  if (tagsToAdd.length) entry.tags = [...new Set([...(entry.tags || []), ...tagsToAdd])];
  if (note) entry.notes = [entry.notes || "", `Verification note (${entry.updatedAt}): ${note}`].filter(Boolean).join("\n").slice(0, 5000);

  const historyItem = {
    at: entry.updatedAt,
    from: beforeStatus,
    to: status,
    confidence: entry.confidence || "medium",
    reviewer: compactText(String(options.reviewer || ""), 120),
    note,
    supportingEvidenceCount: supportingEvidence.length,
    supportingToolCallCount: supportingToolCalls.length,
    resolvedUncertainties,
    remainingUncertainties,
  };
  entry.verificationHistory.push(historyItem);

  await saveVisualEvidenceIndex(filename, index);
  return { filename, path: safeVisualEvidencePath(filename), index, entry, historyItem, supportSummary: verificationSupportSummary(entry) };
}

async function buildVisualEvidenceVerificationQueue(filename, options = {}) {
  const index = await loadVisualEvidenceIndex(filename);
  const topK = clampInteger(options.topK, 30, 1, 200);
  const includeObserved = options.includeObserved !== false;
  const includeRejected = Boolean(options.includeRejected);
  const entries = filterVisualEvidenceEntries(index.entries, options)
    .filter((entry) => {
      const status = entry.verificationStatus || "needs_verification";
      if (status === "verified") return false;
      if (status === "observed") return includeObserved;
      if (status === "rejected") return includeRejected;
      return true;
    })
    .map((entry) => ({
      ...entry,
      verificationRequirements: visualEvidenceVerificationRequirements(entry),
      suggestedTools: visualEvidenceVerificationSuggestedTools(filename, entry),
      supportSummary: verificationSupportSummary(entry),
    }))
    .sort((a, b) => {
      const order = { needs_verification: 0, observed: 1, rejected: 2 };
      const ao = order[a.verificationStatus] ?? 3;
      const bo = order[b.verificationStatus] ?? 3;
      if (ao !== bo) return ao - bo;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    })
    .slice(0, topK);
  return { filename, path: safeVisualEvidencePath(filename), index, entries, filter: options.filter || "" };
}

function buildVisualEvidenceVerificationContract(tool, filename, entries, query = "") {
  const evidence = (entries || []).slice(0, 10).map((entry) => makeEvidence({
    source: "visual-evidence-verification-workflow",
    evidenceType: entry.diagramType || "visual-evidence",
    page: entry.page || undefined,
    quote: `${entry.id}: status=${entry.verificationStatus}; requirements=${(entry.verificationRequirements || visualEvidenceVerificationRequirements(entry)).slice(0, 2).join(" | ")}`,
    confidence: entry.confidence || "medium",
    name: entry.id,
    field: entry.verificationStatus,
    tool,
  }));
  const needsVerification = (entries || []).filter((entry) => entry.verificationStatus !== "verified").slice(0, 12).map((entry) => makeNeedsVerification({
    item: `${entry.id} (${entry.diagramType || "visual"})`,
    reason: (entry.verificationRequirements || visualEvidenceVerificationRequirements(entry)).join("; "),
    suggestedTools: entry.suggestedTools || visualEvidenceVerificationSuggestedTools(filename, entry),
  }));
  return makeEvidenceContract({
    tool,
    filename,
    query,
    evidence,
    inference: [],
    needsVerification,
    warnings: ["Step 35 only changes verification workflow/status. Verified visual evidence must still retain supporting manual evidence for auditability."],
    recommendedNextTools: (entries || []).flatMap((entry) => entry.suggestedTools || visualEvidenceVerificationSuggestedTools(filename, entry)).slice(0, 16),
  });
}

function formatVisualEvidenceVerificationQueue(result) {
  const lines = [];
  lines.push("Visual Evidence Verification Queue");
  lines.push(`File: ${result.filename}`);
  lines.push(`Store: ${result.path}`);
  lines.push(`Total stored: ${result.index.entries.length}`);
  lines.push(`Queue entries: ${result.entries.length}`);
  if (result.filter) lines.push(`Filter: ${result.filter}`);
  lines.push("");
  if (!result.entries.length) {
    lines.push("- No visual evidence entries require verification for this filter.");
  }
  for (const entry of result.entries) {
    lines.push(`- ${entry.id}: page ${entry.page || "unknown"}, type=${entry.diagramType}, status=${entry.verificationStatus}, confidence=${entry.confidence}`);
    if (entry.figure?.caption) lines.push(`  caption: ${compactText(entry.figure.caption, 220)}`);
    if (entry.query) lines.push(`  query: ${entry.query}`);
    if ((entry.uncertainties || []).length) lines.push(`  uncertainties: ${(entry.uncertainties || []).slice(0, 3).join("; ")}`);
    lines.push(`  support: evidence=${entry.supportSummary.supportingEvidenceCount}, tool_calls=${entry.supportSummary.supportingToolCallCount}, history=${entry.supportSummary.verificationHistoryCount}`);
    lines.push("  verification requirements:");
    for (const req of (entry.verificationRequirements || []).slice(0, 8)) lines.push(`    - ${req}`);
    lines.push("  suggested MCP calls:");
    for (const call of (entry.suggestedTools || []).slice(0, 8)) lines.push(`    - ${call}`);
    lines.push(`  update: verify_visual_evidence(filename="${result.filename}", evidence_id="${entry.id}", status="verified", supporting_evidence=[...], supporting_tool_calls=[...])`);
  }
  return appendEvidenceContract(lines.join("\n"), buildVisualEvidenceVerificationContract("visual_evidence_verification_queue", result.filename, result.entries, result.filter));
}

function formatVerifyVisualEvidence(result) {
  const { filename, path: filePath, entry, historyItem, supportSummary } = result;
  const lines = [];
  lines.push("Visual Evidence Verification Updated");
  lines.push(`File: ${filename}`);
  lines.push(`Store: ${filePath}`);
  lines.push(`Evidence ID: ${entry.id}`);
  lines.push(`Status: ${historyItem.from} -> ${historyItem.to}`);
  lines.push(`Confidence: ${entry.confidence}`);
  lines.push(`Updated: ${historyItem.at}`);
  if (entry.verifiedAt) lines.push(`Verified at: ${entry.verifiedAt}`);
  if (entry.rejectedAt) lines.push(`Rejected at: ${entry.rejectedAt}`);
  lines.push(`Support summary: evidence=${supportSummary.supportingEvidenceCount}, tool_calls=${supportSummary.supportingToolCallCount}, history=${supportSummary.verificationHistoryCount}`);
  if (historyItem.note) lines.push(`Note: ${historyItem.note}`);
  lines.push("");
  lines.push(...formatVisualEvidenceEntry(entry, true));
  if ((entry.supportingEvidence || []).length) {
    lines.push("");
    lines.push("Supporting evidence:");
    for (const item of (entry.supportingEvidence || []).slice(-12)) {
      lines.push(`- ${item.type || "other"}${item.tool ? ` via ${item.tool}` : ""}${item.page ? ` page ${item.page}` : ""}${item.register ? ` register ${item.register}` : ""}${item.bitfield ? ` bitfield ${item.bitfield}` : ""}`);
      if (item.quote) lines.push(`  quote: ${item.quote}`);
      if (item.note) lines.push(`  note: ${item.note}`);
    }
  }
  if ((entry.supportingToolCalls || []).length) {
    lines.push("");
    lines.push("Supporting tool calls:");
    for (const call of (entry.supportingToolCalls || []).slice(-12)) lines.push(`- ${call}`);
  }
  lines.push("");
  lines.push("Remaining suggested calls:");
  for (const call of visualEvidenceVerificationSuggestedTools(filename, entry).slice(0, 8)) lines.push(`- ${call}`);

  return appendEvidenceContract(lines.join("\n"), buildVisualEvidenceVerificationContract("verify_visual_evidence", filename, [entry], entry.id));
}

// -----------------------------------------------------------------------------
// Step 34: integrate persisted visual evidence into driver review workflow
// -----------------------------------------------------------------------------

function visualEvidenceDriverSearchText(entry) {
  return normalizeForSearch([
    entry.id,
    entry.figureId,
    entry.page ? `page ${entry.page}` : "",
    entry.query,
    entry.diagramType,
    entry.figure?.caption,
    ...(entry.directVisualObservations || []),
    ...(entry.captionContextFacts || []),
    ...flattenVisualExtractedItems(entry.extractedItems),
    ...(entry.engineeringInferences || []),
    ...(entry.sourceImplications || []),
    ...(entry.uncertainties || []),
    ...(entry.relatedRegisters || []),
    ...(entry.relatedBitfields || []),
    ...(entry.sourceFiles || []),
    ...(entry.tags || []),
    entry.verificationStatus,
  ].filter(Boolean).join("\n"));
}

function scoreVisualEvidenceForDriver(entry, filterText = "", context = {}) {
  const haystack = visualEvidenceDriverSearchText(entry);
  const filter = normalizeForSearch(filterText || "");
  const moduleType = normalizeForSearch(context.moduleType || "");
  const registers = normalizeStringArray(context.registers || []).map(normalizeRegisterName).filter(Boolean);
  const sourceFiles = normalizeStringArray(context.sourceFiles || []).map(normalizeForSearch).filter(Boolean);

  let score = 0;
  if (filter) score += scoreSimpleText(haystack, filter);
  if (moduleType && haystack.includes(moduleType)) score += 20;
  if (entry.verificationStatus === "verified") score += 45;
  else if (entry.verificationStatus === "observed") score += 25;
  else if (entry.verificationStatus === "needs_verification") score += 10;
  if (entry.confidence === "high") score += 20;
  else if (entry.confidence === "medium") score += 10;

  const entryRegs = new Set((entry.relatedRegisters || []).map(normalizeRegisterName));
  for (const reg of registers) {
    if (entryRegs.has(reg) || haystack.includes(normalizeForSearch(reg))) score += 35;
  }
  for (const file of sourceFiles) {
    if (file && haystack.includes(file)) score += 20;
  }
  if (/clock|reset|timing|interrupt|pinmux|sequence|flow|block|diagram/.test(haystack)) score += 8;
  return score;
}

async function collectRelevantVisualEvidence(filename, options = {}) {
  const include = options.include !== false;
  if (!include) return [];
  const topK = clampInteger(options.topK, 8, 1, 30);
  let index;
  try {
    index = await loadVisualEvidenceIndex(filename);
  } catch {
    return [];
  }
  const entries = Array.isArray(index.entries) ? index.entries : [];
  if (!entries.length) return [];

  const filterParts = [
    options.filter,
    options.task,
    options.focus,
    options.moduleType,
    ...(normalizeStringArray(options.tags || [])),
    ...(normalizeStringArray(options.registers || [])),
    ...(normalizeStringArray(options.sourceFiles || [])),
  ].filter(Boolean);
  const filterText = filterParts.join(" ");
  const explicitFilter = normalizeForSearch(options.filter || "");
  const filtered = filterVisualEvidenceEntries(entries, {
    filter: explicitFilter || "",
    diagramType: options.diagramType || "",
    status: options.status || "",
    page: options.page || 0,
  });

  const candidates = (explicitFilter ? filtered : entries)
    .map((entry) => ({
      ...entry,
      driverReviewScore: scoreVisualEvidenceForDriver(entry, filterText, {
        moduleType: options.moduleType,
        registers: options.registers,
        sourceFiles: options.sourceFiles,
      }),
    }))
    .filter((entry) => explicitFilter || entry.driverReviewScore > 0 || !filterText)
    .sort((a, b) => {
      if (Number(b.driverReviewScore || 0) !== Number(a.driverReviewScore || 0)) return Number(b.driverReviewScore || 0) - Number(a.driverReviewScore || 0);
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    })
    .slice(0, topK);

  return candidates;
}

function summarizeVisualEvidenceForDriver(entries, limit = 8) {
  return (entries || []).slice(0, limit).map((entry) => ({
    id: entry.id,
    page: entry.page,
    figureId: entry.figureId,
    diagramType: entry.diagramType,
    status: entry.verificationStatus,
    confidence: entry.confidence,
    score: entry.driverReviewScore || 0,
    caption: entry.figure?.caption || "",
    renderedPath: entry.renderedPath || "",
    observations: (entry.directVisualObservations || []).slice(0, 3),
    sourceImplications: (entry.sourceImplications || []).slice(0, 3),
    uncertainties: (entry.uncertainties || []).slice(0, 3),
    relatedRegisters: (entry.relatedRegisters || []).slice(0, 8),
    relatedBitfields: (entry.relatedBitfields || []).slice(0, 8),
    tags: (entry.tags || []).slice(0, 8),
  }));
}

function visualEvidenceDriverWarnings(entries) {
  const warnings = [];
  if (!(entries || []).length) return warnings;
  const unverified = entries.filter((entry) => entry.verificationStatus !== "verified");
  if (unverified.length) warnings.push(`${unverified.length} visual evidence entr${unverified.length === 1 ? "y is" : "ies are"} not verified; treat as review guidance, not hardware fact.`);
  const hasInference = entries.some((entry) => (entry.engineeringInferences || []).length || (entry.sourceImplications || []).length);
  if (hasInference) warnings.push("Visual engineering inferences/source implications must be cross-checked with register/bitfield/sequence/caution evidence before patch approval.");
  return warnings;
}


function normalizeVisualEvidenceStatusFilter(value) {
  const raw = String(value || "all").trim().toLowerCase();
  if (["all", "verified", "unverified", "needs_verification", "observed", "rejected"].includes(raw)) return raw;
  return "all";
}

function normalizeVisualEvidenceGateMode(value) {
  const raw = String(value || "advisory").trim().toLowerCase();
  if (["advisory", "verified_only", "block_unverified"].includes(raw)) return raw;
  return "advisory";
}

function visualEvidenceEntryStatus(entry) {
  return String(entry?.verificationStatus || "needs_verification").trim().toLowerCase() || "needs_verification";
}

function visualEvidenceEntryMatchesStatus(entry, statusFilter = "all") {
  const status = visualEvidenceEntryStatus(entry);
  const filter = normalizeVisualEvidenceStatusFilter(statusFilter);
  if (filter === "all") return true;
  if (filter === "unverified") return status !== "verified" && status !== "rejected";
  return status === filter;
}

function visualEvidenceGateRequirements(options = {}) {
  const statusFilter = normalizeVisualEvidenceStatusFilter(options.status || options.visualStatus || "all");
  const gate = normalizeVisualEvidenceGateMode(options.gate || options.visualGate || "advisory");
  const requireVerified = Boolean(options.requireVerified || options.visualRequireVerified) || gate === "verified_only" || gate === "block_unverified" || statusFilter === "verified";
  return { statusFilter, gate, requireVerified };
}

function visualEvidenceGateWarnings(gate = {}) {
  const warnings = [];
  if (!gate || !Array.isArray(gate.allEntries)) return warnings;
  if (gate.statusFilter === "verified" && gate.entries.length === 0 && gate.allEntries.length > 0) {
    warnings.push(`visual_status=verified selected no entries, but ${gate.allEntries.length} related visual evidence entr${gate.allEntries.length === 1 ? "y exists" : "ies exist"} with non-verified or rejected status.`);
  }
  if (gate.requireVerified && gate.unverifiedEntries.length) {
    warnings.push(`${gate.unverifiedEntries.length} related visual evidence entr${gate.unverifiedEntries.length === 1 ? "y is" : "ies are"} not verified and must be resolved before approving visual-dependent driver conclusions.`);
  }
  if (gate.rejectedEntries.length && gate.statusFilter === "all") {
    warnings.push(`${gate.rejectedEntries.length} rejected visual evidence entr${gate.rejectedEntries.length === 1 ? "y" : "ies"} matched this review context; do not use rejected observations as support.`);
  }
  return warnings;
}

async function collectDriverReviewVisualEvidence(filename, options = {}) {
  const requirements = visualEvidenceGateRequirements(options);
  const topK = clampInteger(options.topK, 8, 1, 30);
  const allEntries = await collectRelevantVisualEvidence(filename, {
    ...options,
    status: "",
    topK: Math.max(topK, 30),
  });

  const verifiedEntries = allEntries.filter((entry) => visualEvidenceEntryStatus(entry) === "verified");
  const unverifiedEntries = allEntries.filter((entry) => {
    const status = visualEvidenceEntryStatus(entry);
    return status !== "verified" && status !== "rejected";
  });
  const rejectedEntries = allEntries.filter((entry) => visualEvidenceEntryStatus(entry) === "rejected");

  let entries;
  if (requirements.gate === "verified_only") entries = verifiedEntries;
  else entries = allEntries.filter((entry) => visualEvidenceEntryMatchesStatus(entry, requirements.statusFilter));
  entries = entries.slice(0, topK);

  const blockers = [];
  if (requirements.requireVerified && unverifiedEntries.length) {
    blockers.push({
      kind: "unverified_visual_evidence",
      count: unverifiedEntries.length,
      evidenceIds: unverifiedEntries.slice(0, 12).map((entry) => entry.id),
      reason: "Related visual evidence is not verified. Cross-check with manual/register/bitfield/sequence/caution evidence or mark it rejected/not applicable before approving visual-dependent driver conclusions.",
    });
  }
  if (requirements.statusFilter === "verified" && !verifiedEntries.length && allEntries.length) {
    blockers.push({
      kind: "no_verified_visual_evidence",
      count: allEntries.length,
      evidenceIds: allEntries.slice(0, 12).map((entry) => entry.id),
      reason: "visual_status=verified was requested, but only non-verified/rejected visual evidence matched the review context.",
    });
  }

  return {
    enabled: options.include !== false,
    statusFilter: requirements.statusFilter,
    gate: requirements.gate,
    requireVerified: requirements.requireVerified,
    entries,
    allEntries: allEntries.slice(0, Math.max(topK, 12)),
    verifiedEntries: verifiedEntries.slice(0, topK),
    unverifiedEntries: unverifiedEntries.slice(0, Math.max(topK, 12)),
    rejectedEntries: rejectedEntries.slice(0, topK),
    blockers,
    warnings: visualEvidenceGateWarnings({
      statusFilter: requirements.statusFilter,
      gate: requirements.gate,
      requireVerified: requirements.requireVerified,
      entries,
      allEntries,
      unverifiedEntries,
      rejectedEntries,
    }),
  };
}

function visualEvidenceGateSuggestedCalls(filename, gate = {}) {
  const calls = [];
  for (const entry of (gate.unverifiedEntries || []).slice(0, 6)) {
    calls.push(`get_visual_evidence(filename="${filename}", evidence_id="${entry.id}")`);
    calls.push(`visual_evidence_verification_queue(filename="${filename}", filter="${quoteForPromptCall(entry.query || entry.figure?.caption || entry.diagramType || entry.id)}", top_k=10)`);
    calls.push(`verify_visual_evidence(filename="${filename}", evidence_id="${entry.id}", status="verified", supporting_evidence=[...], supporting_tool_calls=[...])`);
  }
  if (!calls.length) calls.push(`visual_evidence_report(filename="${filename}", status="verified", include_entries=true)`);
  return [...new Set(calls)].slice(0, 18);
}

function visualEvidenceGateNeedsVerification(gate = {}, filename = "") {
  const items = [];
  for (const blocker of gate.blockers || []) {
    items.push(makeNeedsVerification({
      item: blocker.kind,
      reason: blocker.reason,
      suggestedTools: visualEvidenceGateSuggestedCalls(filename, gate),
    }));
  }
  for (const entry of (gate.unverifiedEntries || []).slice(0, 8)) {
    items.push(makeNeedsVerification({
      item: `${entry.id} (${entry.diagramType || "visual"}, status=${entry.verificationStatus || "needs_verification"})`,
      reason: "Related visual evidence matched this driver-review context but is not verified.",
      suggestedTools: [
        `get_visual_evidence(filename="${filename}", evidence_id="${entry.id}")`,
        `verify_visual_evidence(filename="${filename}", evidence_id="${entry.id}", status="verified", supporting_evidence=[...], supporting_tool_calls=[...])`,
      ],
    }));
  }
  return items;
}

function formatVisualEvidenceGateSection(gate = {}, filename = "") {
  const lines = ["Visual evidence verification gate"];
  if (!gate || gate.enabled === false) {
    lines.push("- Visual evidence was disabled for this driver-review tool call.");
    return lines;
  }
  lines.push(`- status filter: ${gate.statusFilter || "all"}`);
  lines.push(`- gate mode: ${gate.gate || "advisory"}`);
  lines.push(`- require verified: ${gate.requireVerified ? "yes" : "no"}`);
  lines.push(`- selected entries: ${(gate.entries || []).length}`);
  lines.push(`- related verified entries: ${(gate.verifiedEntries || []).length}`);
  lines.push(`- related unverified entries: ${(gate.unverifiedEntries || []).length}`);
  if ((gate.blockers || []).length) {
    lines.push("- BLOCKERS:");
    for (const blocker of gate.blockers) {
      lines.push(`  - ${blocker.kind}: ${blocker.reason}`);
      if ((blocker.evidenceIds || []).length) lines.push(`    evidence: ${blocker.evidenceIds.join(", ")}`);
    }
    lines.push("- Required action: verify or reject the blocking visual evidence before approving driver conclusions that depend on it.");
  } else if (gate.requireVerified) {
    lines.push("- Gate result: PASS for currently matched visual evidence.");
  } else {
    lines.push("- Gate result: advisory only; unverified visual evidence is shown as guidance, not proof.");
  }
  if ((gate.unverifiedEntries || []).length) {
    lines.push("- Suggested verification calls:");
    for (const call of visualEvidenceGateSuggestedCalls(filename, gate).slice(0, 8)) lines.push(`  - ${call}`);
  }
  return lines;
}

function formatDriverVisualEvidenceSection(entries, filename, title = "Relevant visual evidence") {
  const lines = [title];
  if (!(entries || []).length) {
    lines.push("- No persisted visual evidence matched this driver-review context.");
    lines.push(`- Suggested: visual_review_handoff_pack(filename="${filename}", query="<clock/timing/reset/pinmux/interrupt topic>")`);
    return lines;
  }
  for (const entry of entries.slice(0, 10)) {
    lines.push(`- ${entry.id}: page ${entry.page || "unknown"}, type=${entry.diagramType || "unknown"}, status=${entry.verificationStatus || "unknown"}, confidence=${entry.confidence || "unknown"}, score=${entry.driverReviewScore || 0}`);
    if (entry.figure?.caption) lines.push(`  caption: ${compactText(entry.figure.caption, 240)}`);
    if (entry.renderedPath) lines.push(`  render: ${entry.renderedPath}`);
    for (const obs of (entry.directVisualObservations || []).slice(0, 2)) lines.push(`  visual: ${obs}`);
    for (const imp of (entry.sourceImplications || []).slice(0, 2)) lines.push(`  source implication: ${imp}`);
    for (const unc of (entry.uncertainties || []).slice(0, 2)) lines.push(`  uncertainty: ${unc}`);
    const regs = (entry.relatedRegisters || []).slice(0, 6).join(", ");
    if (regs) lines.push(`  related registers: ${regs}`);
    lines.push(`  suggested: get_visual_evidence(filename="${filename}", evidence_id="${entry.id}")`);
  }
  lines.push(`- Summary/report: visual_evidence_report(filename="${filename}", include_entries=true)`);
  return lines;
}

function visualEvidenceToEvidenceContractItems(entries, toolName) {
  return (entries || []).slice(0, 8).map((entry) => makeEvidence({
    source: "visual-evidence-index",
    evidenceType: `visual-${entry.diagramType || "diagram"}`,
    page: entry.page || undefined,
    quote: (entry.directVisualObservations || [])[0] || (entry.captionContextFacts || [])[0] || entry.figure?.caption || entry.query || entry.id,
    confidence: entry.confidence || "medium",
    name: entry.id,
    tool: toolName,
  }));
}

// -----------------------------------------------------------------------------
// Step 31B: page rendering helpers
// -----------------------------------------------------------------------------

function normalizeRenderFormat(value) {
  const raw = String(value || "png").trim().toLowerCase();
  if (["png", "jpg", "jpeg", "svg", "text_svg"].includes(raw)) return raw === "jpeg" ? "jpg" : raw;
  return "png";
}

function normalizeRenderer(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (["auto", "pdftoppm", "mutool", "magick", "text_svg"].includes(raw)) return raw;
  return "auto";
}

function clampRenderDpi(value) {
  return clampInteger(value, DEFAULT_RENDER_DPI, MIN_RENDER_DPI, MAX_RENDER_DPI);
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function commandExists(command) {
  return Boolean(await resolveRendererCommand(command));
}

async function pathExistsCaseInsensitive(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates || []) {
    if (!candidate) continue;
    const normalized = path.normalize(String(candidate));
    if (await pathExistsCaseInsensitive(normalized)) return normalized;
  }
  return null;
}

async function findExecutableUnder(rootDir, executableName, maxDepth = RENDERER_SEARCH_DEPTH) {
  if (!rootDir || !(await pathExistsCaseInsensitive(rootDir))) return null;
  const target = executableName.toLowerCase();
  const queue = [{ dir: rootDir, depth: 0 }];

  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === target) return full;
      if (entry.isDirectory() && depth < maxDepth) {
        // Keep the search bounded and biased toward Windows package installs.
        const name = entry.name.toLowerCase();
        if (
          depth <= 1 ||
          name.includes("poppler") ||
          name.includes("mupdf") ||
          name.includes("imagemagick") ||
          name === "library" ||
          name === "bin"
        ) {
          queue.push({ dir: full, depth: depth + 1 });
        }
      }
    }
  }

  return null;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function rendererEnvCandidates(command) {
  const env = process.env || {};
  if (command === "pdftoppm") {
    return uniqueStrings([
      env.PDF_RENDERER_PDFTOPPM,
      env.PDFTOPPM_PATH,
      env.POPPLER_PDFTOPPM,
      env.POPPLER_PATH ? path.join(env.POPPLER_PATH, process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm") : "",
      env.POPPLER_BIN ? path.join(env.POPPLER_BIN, process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm") : "",
    ]);
  }
  if (command === "mutool") {
    return uniqueStrings([
      env.PDF_RENDERER_MUTOOL,
      env.MUTOOL_PATH,
      env.MUPDF_MUTOOL,
      env.MUPDF_PATH ? path.join(env.MUPDF_PATH, process.platform === "win32" ? "mutool.exe" : "mutool") : "",
      env.MUPDF_BIN ? path.join(env.MUPDF_BIN, process.platform === "win32" ? "mutool.exe" : "mutool") : "",
    ]);
  }
  if (command === "magick") {
    return uniqueStrings([
      env.PDF_RENDERER_MAGICK,
      env.MAGICK_PATH,
      env.IMAGEMAGICK_MAGICK,
      env.IMAGEMAGICK_PATH ? path.join(env.IMAGEMAGICK_PATH, process.platform === "win32" ? "magick.exe" : "magick") : "",
      env.IMAGEMAGICK_BIN ? path.join(env.IMAGEMAGICK_BIN, process.platform === "win32" ? "magick.exe" : "magick") : "",
    ]);
  }
  return [];
}

async function windowsRendererCandidates(command) {
  if (process.platform !== "win32") return [];
  const env = process.env || {};
  const localAppData = env.LOCALAPPDATA || path.join(env.USERPROFILE || "", "AppData", "Local");
  const wingetPackages = localAppData ? path.join(localAppData, "Microsoft", "WinGet", "Packages") : "";
  const programFiles = env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const exe = `${command}.exe`;
  const direct = [];

  if (command === "pdftoppm") {
    direct.push(
      path.join(wingetPackages, "oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe", "poppler-25.07.0", "Library", "bin", exe),
      path.join(programFiles, "poppler", "bin", exe),
      path.join(programFilesX86, "poppler", "bin", exe)
    );
  } else if (command === "mutool") {
    direct.push(
      path.join(wingetPackages, "ArtifexSoftware.mutool_Microsoft.Winget.Source_8wekyb3d8bbwe", "mupdf-1.23.0-windows", exe),
      path.join(programFiles, "MuPDF", exe),
      path.join(programFilesX86, "MuPDF", exe)
    );
  } else if (command === "magick") {
    direct.push(
      path.join(programFiles, "ImageMagick-7.1.2-Q16-HDRI", exe),
      path.join(programFiles, "ImageMagick-7.1.1-Q16-HDRI", exe),
      path.join(programFiles, "ImageMagick-7.1.0-Q16-HDRI", exe),
      path.join(programFilesX86, "ImageMagick-7.1.2-Q16-HDRI", exe)
    );
  }

  const foundDirect = await firstExistingPath(direct);
  if (foundDirect) return [foundDirect];

  const roots = [];
  if (command === "pdftoppm" || command === "mutool") roots.push(wingetPackages);
  if (command === "magick") roots.push(programFiles, programFilesX86, wingetPackages);

  for (const root of uniqueStrings(roots)) {
    const found = await findExecutableUnder(root, exe);
    if (found) return [found];
  }
  return [];
}

async function resolveRendererCommand(command) {
  const executable = process.platform === "win32" && !String(command).toLowerCase().endsWith(".exe") ? `${command}.exe` : command;
  const envCandidate = await firstExistingPath(rendererEnvCandidates(command));
  if (envCandidate) return envCandidate;

  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(probe, [command], { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const resolved = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (resolved) return resolved;
  } catch {
    // Continue with known Windows install locations.
  }

  const windowsCandidates = await windowsRendererCandidates(command);
  if (windowsCandidates.length) return windowsCandidates[0];

  return null;
}

async function detectPdfRenderers() {
  const [pdftoppmPath, mutoolPath, magickPath] = await Promise.all([
    resolveRendererCommand("pdftoppm"),
    resolveRendererCommand("mutool"),
    resolveRendererCommand("magick"),
  ]);
  const pdftoppm = Boolean(pdftoppmPath);
  const mutool = Boolean(mutoolPath);
  const magick = Boolean(magickPath);
  return {
    pdftoppm,
    mutool,
    magick,
    pdftoppmPath,
    mutoolPath,
    magickPath,
    text_svg: true,
    recommended: pdftoppm ? "pdftoppm" : mutool ? "mutool" : magick ? "magick" : "text_svg",
    notes: [
      pdftoppm ? `Poppler pdftoppm is available: ${pdftoppmPath}` : "Poppler pdftoppm not found in MCP server PATH or known Windows install locations.",
      mutool ? `MuPDF mutool is available: ${mutoolPath}` : "MuPDF mutool not found in MCP server PATH or known Windows install locations.",
      magick ? `ImageMagick magick is available: ${magickPath}` : "ImageMagick magick not found in MCP server PATH or known Windows install locations.",
      "text_svg fallback is always available but only renders the PDF text layer; it does not render diagrams/images/vector paths.",
      "If PowerShell can find a renderer but MCP cannot, add the renderer bin directory to the MCP server environment PATH or set PDF_RENDERER_PDFTOPPM / PDF_RENDERER_MUTOOL / PDF_RENDERER_MAGICK.",
    ],
  };
}

async function findFirstExistingRender(prefix, ext) {
  const dir = path.dirname(prefix);
  const base = path.basename(prefix);
  const files = await fs.readdir(dir).catch(() => []);
  const candidates = files
    .filter((file) => file.startsWith(base) && file.toLowerCase().endsWith(`.${ext}`))
    .map((file) => path.join(dir, file));
  return candidates[0] || null;
}

async function renderWithPdftoppm(commandPath, pdfPath, outPath, page, dpi, format) {
  const ext = format === "jpg" ? "jpg" : "png";
  const prefix = outPath.replace(/\.(png|jpg)$/i, "");
  const args = ["-f", String(page), "-l", String(page), "-r", String(dpi), ext === "jpg" ? "-jpeg" : "-png", pdfPath, prefix];
  await execFileAsync(commandPath || "pdftoppm", args, { timeout: RENDER_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 * 8 });
  const expected = `${prefix}-${page}.${ext}`;
  const produced = await pathExists(expected) ? expected : await findFirstExistingRender(prefix, ext);
  if (!produced) throw new Error(`pdftoppm completed but output file was not found for prefix ${prefix}`);
  if (produced !== outPath) await fs.rename(produced, outPath);
  return { renderer: "pdftoppm", commandPath: commandPath || "pdftoppm", command: `${commandPath || "pdftoppm"} ${args.join(" ")}` };
}

async function renderWithMutool(commandPath, pdfPath, outPath, page, dpi) {
  const args = ["draw", "-o", outPath, "-r", String(dpi), pdfPath, String(page)];
  await execFileAsync(commandPath || "mutool", args, { timeout: RENDER_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 * 8 });
  if (!(await pathExists(outPath))) throw new Error(`mutool completed but output file was not found: ${outPath}`);
  return { renderer: "mutool", commandPath: commandPath || "mutool", command: `${commandPath || "mutool"} ${args.join(" ")}` };
}

async function renderWithMagick(commandPath, pdfPath, outPath, page, dpi) {
  const pageSelector = `${pdfPath}[${Math.max(0, Number(page) - 1)}]`;
  const args = ["-density", String(dpi), pageSelector, "-background", "white", "-alpha", "remove", outPath];
  await execFileAsync(commandPath || "magick", args, { timeout: RENDER_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 * 8 });
  if (!(await pathExists(outPath))) throw new Error(`magick completed but output file was not found: ${outPath}`);
  return { renderer: "magick", commandPath: commandPath || "magick", command: `${commandPath || "magick"} ${args.join(" ")}` };
}

async function renderTextLayerSvg(filename, pageNumber, outPath, options = {}) {
  const pdf = await loadPdfDocument(filename);
  const pageCount = pdf.numPages;
  const pageNum = clampInteger(pageNumber, 1, 1, pageCount);
  const page = await pdf.getPage(pageNum);
  const scale = clampRenderDpi(options.dpi) / 72;
  const viewport = page.getViewport({ scale });
  const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
  const lines = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(viewport.width)}" height="${Math.round(viewport.height)}" viewBox="0 0 ${Math.round(viewport.width)} ${Math.round(viewport.height)}">`);
  lines.push(`<rect x="0" y="0" width="100%" height="100%" fill="white"/>`);
  lines.push(`<text x="12" y="18" font-size="12" fill="#666">Text-layer fallback render: ${xmlEscape(filename)} page ${pageNum}. Diagrams/images/vector paths are not rendered.</text>`);

  for (const item of content.items || []) {
    const str = String(item.str || "").trim();
    if (!str) continue;
    const tx = pdfjsLib.Util && item.transform
      ? pdfjsLib.Util.transform(viewport.transform, item.transform)
      : [1, 0, 0, 1, Number(item.transform?.[4] || 0) * scale, Number(item.transform?.[5] || 0) * scale];
    const x = Number(tx[4] || 0);
    const y = Number(tx[5] || 0);
    const fontSize = Math.max(4, Math.min(28, Math.abs(Number(tx[3] || item.height || 10))));
    const rotate = Math.atan2(Number(tx[1] || 0), Number(tx[0] || 1)) * 180 / Math.PI;
    const transform = Math.abs(rotate) > 0.5 ? ` transform="rotate(${rotate.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)})"` : "";
    lines.push(`<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-size="${fontSize.toFixed(2)}" fill="black"${transform}>${xmlEscape(str)}</text>`);
  }

  lines.push(`</svg>`);
  await atomicWriteFile(outPath, lines.join("\n"), "utf-8");
  return { renderer: "text_svg", command: "pdfjs text-layer SVG fallback", pageCount };
}

async function renderPdfPage(filename, options = {}) {
  ensurePdfFilename(filename);
  await fs.mkdir(RENDERS_DIR, { recursive: true });
  const pageCount = await getPdfPageCount(filename);
  const page = clampInteger(options.page, 1, 1, pageCount);
  const dpi = clampRenderDpi(options.dpi);
  const requestedFormat = normalizeRenderFormat(options.format || "png");
  let format = requestedFormat;
  const renderer = normalizeRenderer(options.renderer);
  const fallbackTextSvg = options.fallbackTextSvg !== false;
  const pdfPath = safePdfPath(filename);
  const suffix = `${requestedFormat}-dpi${dpi}`;
  let outPath = safeRenderOutputPath(filename, page, requestedFormat, suffix);
  const availability = await detectPdfRenderers();
  const attempts = [];
  let renderInfo = null;
  let warning = "";

  const tryRenderer = async (name) => {
    attempts.push(name);
    if (name === "pdftoppm") {
      if (!availability.pdftoppm) throw new Error("pdftoppm not available");
      if (!["png", "jpg"].includes(format)) throw new Error("pdftoppm supports png/jpg in this tool");
      return renderWithPdftoppm(availability.pdftoppmPath, pdfPath, outPath, page, dpi, format);
    }
    if (name === "mutool") {
      if (!availability.mutool) throw new Error("mutool not available");
      return renderWithMutool(availability.mutoolPath, pdfPath, outPath, page, dpi);
    }
    if (name === "magick") {
      if (!availability.magick) throw new Error("magick not available");
      if (!["png", "jpg"].includes(format)) throw new Error("magick path is used only for png/jpg in this tool");
      return renderWithMagick(availability.magickPath, pdfPath, outPath, page, dpi);
    }
    if (name === "text_svg") {
      format = "text_svg";
      outPath = safeRenderOutputPath(filename, page, "text_svg", `text-svg-dpi${dpi}`);
      return renderTextLayerSvg(filename, page, outPath, { dpi });
    }
    throw new Error(`Unsupported renderer: ${name}`);
  };

  const plan = [];
  if (renderer !== "auto") plan.push(renderer);
  else if (requestedFormat === "svg") plan.push("mutool", "text_svg");
  else if (requestedFormat === "text_svg") plan.push("text_svg");
  else plan.push("pdftoppm", "mutool", "magick");

  const errors = [];
  for (const candidate of plan) {
    try {
      renderInfo = await tryRenderer(candidate);
      break;
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!renderInfo && fallbackTextSvg) {
    warning = `External render failed/unavailable; created text-layer SVG fallback. Errors: ${errors.join(" | ")}`;
    renderInfo = await tryRenderer("text_svg");
  }

  if (!renderInfo) throw new Error(`Unable to render page. Tried: ${attempts.join(", ")}. Errors: ${errors.join(" | ")}`);

  const stat = await fs.stat(outPath);
  return {
    filename,
    page,
    pageCount,
    dpi,
    requestedFormat,
    outputFormat: format === "text_svg" ? "svg" : format,
    renderer: renderInfo.renderer,
    outputPath: outPath,
    sizeBytes: stat.size,
    availability,
    warning,
    attempts,
  };
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = "B";
  for (const candidate of units) {
    size /= 1024;
    unit = candidate;
    if (size < 1024) break;
  }
  const decimals = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(decimals)} ${unit}`;
}

function formatRenderResult(result) {
  const lines = [];
  lines.push("Rendered PDF Page");
  lines.push(`File: ${result.filename}`);
  lines.push(`Page: ${result.page}/${result.pageCount}`);
  lines.push(`DPI: ${result.dpi}`);
  lines.push(`Renderer: ${result.renderer}`);
  lines.push(`Output format: ${result.outputFormat}`);
  lines.push(`Output path: ${result.outputPath}`);
  lines.push(`Size: ${formatBytes(result.sizeBytes)}`);
  if (result.warning) lines.push(`Warning: ${result.warning}`);
  lines.push(`Renderer availability: ${JSON.stringify(result.availability)}`);
  lines.push("");
  if (result.renderer === "text_svg") {
    lines.push("Important: this is a text-layer SVG fallback. It preserves text positions but does not render actual diagrams/images/vector paths. Install Poppler pdftoppm or MuPDF mutool for real visual rendering.");
  } else {
    lines.push("This image file can be opened locally or passed to a vision-capable agent/model for diagram/timing/clock-tree inspection.");
  }
  lines.push("");
  lines.push("Suggested follow-up:");
  lines.push(`- get_figure_context(filename="${result.filename}", page=${result.page}, include_pages=1, include_layout_tables=true)`);
  lines.push(`- read_pdf_pages(filename="${result.filename}", start_page=${result.page}, end_page=${result.page})`);
  return lines.join("\n");
}

async function renderFigurePage(filename, options = {}) {
  const context = await getFigureContext(filename, {
    figureId: String(options.figureId || "").trim(),
    page: options.page,
    query: String(options.query || "").trim(),
    includePages: options.includeContext !== false ? 1 : 0,
    includeLayoutTables: false,
  });
  const render = await renderPdfPage(filename, {
    page: context.figure.page,
    dpi: options.dpi,
    format: options.format || "png",
    renderer: options.renderer || "auto",
    fallbackTextSvg: true,
  });
  return { ...render, figure: context.figure, context: options.includeContext === false ? null : context };
}

function formatRenderFigureResult(result) {
  const lines = [];
  lines.push(formatRenderResult(result));
  lines.push("", "Figure/Table target:");
  lines.push(`- ID: ${result.figure.id}`);
  lines.push(`- Kind: ${result.figure.kind}`);
  lines.push(`- Caption: ${result.figure.caption}`);
  lines.push(`- Confidence: ${result.figure.confidence}`);
  if (result.context) {
    lines.push("", "Caption-near context:");
    for (const line of result.figure.contextLines || []) lines.push(`- ${line}`);
  }
  return appendEvidenceContract(lines.join("\n"), buildFigureEvidenceContract("render_figure_page", result.filename, result.figure.caption, [result.figure]));
}


// -----------------------------------------------------------------------------
// Step 31C: region crop / zoom rendering helpers
// -----------------------------------------------------------------------------

function normalizeCropUnit(value) {
  const raw = String(value || "percent").trim().toLowerCase();
  return raw === "px" ? "px" : "percent";
}

function clampZoom(value, defaultValue = 1.0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.max(1.0, Math.min(4.0, n));
}

function normalizeFigureRegionMode(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (["auto", "above_caption", "below_caption", "around_caption", "top_half", "middle", "bottom_half", "full_width"].includes(raw)) return raw;
  return "auto";
}

function imageMagickArgsForIdentify() {
  return ["identify", "-format", "%w %h"];
}

async function identifyImageSize(magickPath, imagePath) {
  const args = [...imageMagickArgsForIdentify(), imagePath];
  const { stdout } = await execFileAsync(magickPath || "magick", args, { timeout: RENDER_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 });
  const [width, height] = String(stdout || "").trim().split(/\s+/).map((v) => Number(v));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Unable to identify image size for ${imagePath}: ${stdout}`);
  }
  return { width, height };
}

function clampCropRect(rect, imageSize) {
  const width = Math.max(1, Math.round(Number(imageSize.width || 1)));
  const height = Math.max(1, Math.round(Number(imageSize.height || 1)));
  let x = Math.round(Number(rect.x || 0));
  let y = Math.round(Number(rect.y || 0));
  let w = Math.round(Number(rect.width || width));
  let h = Math.round(Number(rect.height || height));

  x = Math.max(0, Math.min(width - 1, x));
  y = Math.max(0, Math.min(height - 1, y));
  w = Math.max(1, Math.min(width - x, w));
  h = Math.max(1, Math.min(height - y, h));

  return { x, y, width: w, height: h };
}

function cropRectFromInput(options, imageSize) {
  const unit = normalizeCropUnit(options.unit);
  const defaultWidth = unit === "percent" ? 100 : imageSize.width;
  const defaultHeight = unit === "percent" ? 100 : imageSize.height;
  const margin = Math.max(0, Number(options.margin || 0));

  if (unit === "px") {
    return clampCropRect({
      x: Number(options.x || 0) - margin,
      y: Number(options.y || 0) - margin,
      width: Number(options.width || defaultWidth) + margin * 2,
      height: Number(options.height || defaultHeight) + margin * 2,
    }, imageSize);
  }

  const xPct = Number(options.x ?? 0) - margin;
  const yPct = Number(options.y ?? 0) - margin;
  const wPct = Number(options.width ?? defaultWidth) + margin * 2;
  const hPct = Number(options.height ?? defaultHeight) + margin * 2;

  return clampCropRect({
    x: imageSize.width * xPct / 100,
    y: imageSize.height * yPct / 100,
    width: imageSize.width * wPct / 100,
    height: imageSize.height * hPct / 100,
  }, imageSize);
}

function safeRenderRegionOutputPath(filename, page, format, suffix = "") {
  ensurePdfFilename(filename);
  const ext = String(format || "png").toLowerCase() === "jpg" ? "jpg" : "png";
  const pageNumber = clampInteger(page, 1, 1, 999999);
  const stem = sanitizeRenderStem(`${filename}-p${pageNumber}-region${suffix ? `-${suffix}` : ""}`);
  return ensureInsideRoot(path.join(RENDERS_DIR, `${stem}.${ext}`), RENDERS_DIR, "render region output");
}

async function cropRenderedImageWithMagick(magickPath, inputPath, outputPath, rect, zoom = 1.0) {
  const geometry = `${rect.width}x${rect.height}+${rect.x}+${rect.y}`;
  const args = [inputPath, "-crop", geometry, "+repage"];
  if (zoom && zoom > 1.001) args.push("-resize", `${Math.round(zoom * 100)}%`);
  args.push(outputPath);
  await execFileAsync(magickPath || "magick", args, { timeout: RENDER_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 * 8 });
  if (!(await pathExists(outputPath))) throw new Error(`ImageMagick crop completed but output file was not found: ${outputPath}`);
  return { renderer: "magick-crop", commandPath: magickPath || "magick", command: `${magickPath || "magick"} ${args.join(" ")}`, geometry };
}

async function renderPdfRegion(filename, options = {}) {
  const page = Number(options.page);
  const dpi = clampRenderDpi(options.dpi);
  const requestedFormat = normalizeRenderFormat(options.format || "png") === "jpg" ? "jpg" : "png";
  const zoom = clampZoom(options.zoom, 1.0);
  const availability = await detectPdfRenderers();
  if (!availability.magick) {
    if (options.fallbackFullPage) {
      const full = await renderPdfPage(filename, { page, dpi, format: requestedFormat, renderer: options.renderer || "auto", fallbackTextSvg: false });
      return { ...full, region: null, cropRenderer: null, cropWarning: "ImageMagick is unavailable; returned full page render because fallback_full_page=true." };
    }
    throw new Error("ImageMagick magick is required for Step 31C crop/zoom. Install ImageMagick or set PDF_RENDERER_MAGICK.");
  }

  const full = await renderPdfPage(filename, {
    page,
    dpi,
    format: requestedFormat,
    renderer: options.renderer || "auto",
    fallbackTextSvg: false,
  });

  const imageSize = await identifyImageSize(availability.magickPath, full.outputPath);
  const rect = cropRectFromInput(options, imageSize);
  const suffix = `${requestedFormat}-dpi${dpi}-x${rect.x}-y${rect.y}-w${rect.width}-h${rect.height}-z${String(zoom).replace(/\./g, "p")}`;
  const outPath = safeRenderRegionOutputPath(filename, full.page, requestedFormat, suffix);
  const cropInfo = await cropRenderedImageWithMagick(availability.magickPath, full.outputPath, outPath, rect, zoom);
  const stat = await fs.stat(outPath);

  return {
    ...full,
    outputPath: outPath,
    sizeBytes: stat.size,
    region: {
      unit: normalizeCropUnit(options.unit),
      input: {
        x: options.x ?? 0,
        y: options.y ?? 0,
        width: options.width ?? (normalizeCropUnit(options.unit) === "px" ? imageSize.width : 100),
        height: options.height ?? (normalizeCropUnit(options.unit) === "px" ? imageSize.height : 100),
        margin: options.margin || 0,
      },
      pixels: rect,
      imageSize,
      zoom,
      fullPagePath: full.outputPath,
    },
    cropRenderer: cropInfo,
    renderer: `${full.renderer}+magick-crop`,
    outputFormat: requestedFormat,
  };
}

function formatRegionRenderResult(result, title = "Rendered PDF Region") {
  const lines = [];
  lines.push(title);
  lines.push(`File: ${result.filename}`);
  lines.push(`Page: ${result.page}/${result.pageCount}`);
  lines.push(`DPI: ${result.dpi}`);
  lines.push(`Renderer: ${result.renderer}`);
  lines.push(`Output format: ${result.outputFormat}`);
  lines.push(`Output path: ${result.outputPath}`);
  lines.push(`Size: ${formatBytes(result.sizeBytes)}`);
  if (result.region) {
    lines.push(`Full page render: ${result.region.fullPagePath}`);
    lines.push(`Image size: ${result.region.imageSize.width}x${result.region.imageSize.height}px`);
    lines.push(`Crop pixels: x=${result.region.pixels.x}, y=${result.region.pixels.y}, width=${result.region.pixels.width}, height=${result.region.pixels.height}`);
    lines.push(`Input unit: ${result.region.unit}`);
    lines.push(`Zoom: ${result.region.zoom}x`);
  }
  if (result.cropWarning) lines.push(`Warning: ${result.cropWarning}`);
  if (result.warning) lines.push(`Warning: ${result.warning}`);
  lines.push("");
  lines.push("This cropped/zoomed image is intended for vision review of diagrams, timing charts, clock trees, block diagrams, and dense tables.");
  lines.push("");
  lines.push("Suggested follow-up:");
  lines.push(`- get_figure_context(filename="${result.filename}", page=${result.page}, include_pages=1, include_layout_tables=true)`);
  lines.push(`- render_pdf_page(filename="${result.filename}", page=${result.page}, dpi=${result.dpi}, format="${result.outputFormat}")`);
  return lines.join("\n");
}

async function getCaptionTextBounds(filename, pageNumber, captionOrQuery, dpi = DEFAULT_RENDER_DPI) {
  const query = normalizeForSearch(captionOrQuery || "");
  if (!query) return null;
  const queryTokens = query.split(/\s+/).filter((token) => token.length >= 3).slice(0, 12);
  if (!queryTokens.length) return null;

  const pdf = await loadPdfDocument(filename);
  const page = await pdf.getPage(pageNumber);
  const scale = clampRenderDpi(dpi) / 72;
  const viewport = page.getViewport({ scale });
  const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
  const matches = [];

  for (const item of content.items || []) {
    const str = String(item.str || "").trim();
    if (!str) continue;
    const norm = normalizeForSearch(str);
    const hitCount = queryTokens.filter((token) => norm.includes(token)).length;
    if (!hitCount) continue;
    const tx = pdfjsLib.Util && item.transform
      ? pdfjsLib.Util.transform(viewport.transform, item.transform)
      : [1, 0, 0, 1, Number(item.transform?.[4] || 0) * scale, Number(item.transform?.[5] || 0) * scale];
    const x = Number(tx[4] || 0);
    const y = Number(tx[5] || 0);
    const fontSize = Math.max(4, Math.min(40, Math.abs(Number(tx[3] || item.height || 10))));
    const width = Math.max(4, Number(item.width || str.length * 5) * scale);
    matches.push({ x, y: Math.max(0, y - fontSize), width, height: fontSize * 1.5, score: hitCount, text: str });
  }

  if (!matches.length) return null;
  matches.sort((a, b) => b.score - a.score);
  const topScore = matches[0].score;
  const selected = matches.filter((m) => m.score >= Math.max(1, topScore - 1)).slice(0, 8);
  const minX = Math.min(...selected.map((m) => m.x));
  const minY = Math.min(...selected.map((m) => m.y));
  const maxX = Math.max(...selected.map((m) => m.x + m.width));
  const maxY = Math.max(...selected.map((m) => m.y + m.height));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    matches: selected,
  };
}

function figureRegionPercentFromCaptionBounds(bounds, mode = "auto") {
  if (!bounds) {
    const fallback = mode === "bottom_half" ? { x: 0, y: 50, width: 100, height: 50 }
      : mode === "top_half" ? { x: 0, y: 0, width: 100, height: 50 }
      : mode === "middle" ? { x: 0, y: 25, width: 100, height: 50 }
      : { x: 0, y: 0, width: 100, height: 100 };
    return fallback;
  }

  const captionY = (bounds.y / bounds.viewportHeight) * 100;
  const captionH = (bounds.height / bounds.viewportHeight) * 100;
  const normalizedMode = mode === "auto" ? "above_caption" : mode;

  if (normalizedMode === "above_caption") {
    const y = Math.max(0, captionY - 42);
    const h = Math.max(20, Math.min(55, captionY - y + captionH + 4));
    return { x: 3, y, width: 94, height: h };
  }
  if (normalizedMode === "below_caption") {
    const y = Math.min(95, captionY - 2);
    return { x: 3, y, width: 94, height: Math.max(5, 100 - y - 2) };
  }
  if (normalizedMode === "around_caption") {
    const y = Math.max(0, captionY - 20);
    return { x: 3, y, width: 94, height: Math.min(60, 40 + captionH) };
  }
  if (normalizedMode === "top_half") return { x: 0, y: 0, width: 100, height: 50 };
  if (normalizedMode === "middle") return { x: 0, y: 25, width: 100, height: 50 };
  if (normalizedMode === "bottom_half") return { x: 0, y: 50, width: 100, height: 50 };
  if (normalizedMode === "full_width") return { x: 0, y: Math.max(0, captionY - 45), width: 100, height: Math.min(65, captionY + captionH + 8) };
  return { x: 0, y: 0, width: 100, height: 100 };
}

async function renderFigureRegion(filename, options = {}) {
  const context = await getFigureContext(filename, {
    figureId: String(options.figureId || "").trim(),
    page: options.page,
    query: String(options.query || "").trim(),
    includePages: options.includeContext !== false ? 1 : 0,
    includeLayoutTables: false,
  });

  const explicitCrop = options.x !== undefined && options.y !== undefined && options.width !== undefined && options.height !== undefined;
  let cropOptions = {};
  let captionBounds = null;
  let regionMode = normalizeFigureRegionMode(options.region || "auto");

  if (explicitCrop) {
    cropOptions = {
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height,
      unit: normalizeCropUnit(options.unit),
      margin: options.margin ?? 0,
    };
  } else {
    captionBounds = await getCaptionTextBounds(filename, context.figure.page, `${context.figure.caption} ${options.query || ""}`, options.dpi || DEFAULT_RENDER_DPI).catch(() => null);
    cropOptions = {
      ...figureRegionPercentFromCaptionBounds(captionBounds, regionMode),
      unit: "percent",
      margin: options.margin ?? 3,
    };
  }

  const render = await renderPdfRegion(filename, {
    page: context.figure.page,
    dpi: options.dpi,
    format: options.format || "png",
    renderer: options.renderer || "auto",
    zoom: options.zoom === undefined ? 1.5 : options.zoom,
    fallbackFullPage: false,
    ...cropOptions,
  });

  return {
    ...render,
    figure: context.figure,
    context: options.includeContext === false ? null : context,
    regionMode,
    captionBounds,
    explicitCrop,
  };
}

function formatRenderFigureRegionResult(result) {
  const lines = [];
  lines.push(formatRegionRenderResult(result, "Rendered Figure/Page Region"));
  lines.push("", "Figure/Table target:");
  lines.push(`- ID: ${result.figure.id}`);
  lines.push(`- Kind: ${result.figure.kind}`);
  lines.push(`- Caption: ${result.figure.caption}`);
  lines.push(`- Confidence: ${result.figure.confidence}`);
  lines.push(`- Region mode: ${result.explicitCrop ? "explicit" : result.regionMode}`);
  if (result.captionBounds) {
    lines.push(`- Caption bounds: x=${result.captionBounds.x.toFixed(1)}, y=${result.captionBounds.y.toFixed(1)}, width=${result.captionBounds.width.toFixed(1)}, height=${result.captionBounds.height.toFixed(1)}`);
  }
  if (result.context) {
    lines.push("", "Caption-near context:");
    for (const line of result.figure.contextLines || []) lines.push(`- ${line}`);
  }
  return appendEvidenceContract(lines.join("\n"), buildFigureEvidenceContract("render_figure_region", result.filename, result.figure.caption, [result.figure]));
}

function formatRendererAvailability(availability) {
  const lines = [];
  lines.push("PDF Renderer Availability");
  lines.push(`pdftoppm: ${availability.pdftoppm ? "yes" : "no"}${availability.pdftoppmPath ? ` (${availability.pdftoppmPath})` : ""}`);
  lines.push(`mutool: ${availability.mutool ? "yes" : "no"}${availability.mutoolPath ? ` (${availability.mutoolPath})` : ""}`);
  lines.push(`magick: ${availability.magick ? "yes" : "no"}${availability.magickPath ? ` (${availability.magickPath})` : ""}`);
  lines.push(`text_svg fallback: yes`);
  lines.push(`Recommended: ${availability.recommended}`);
  lines.push(`MCP server PATH: ${compactText(process.env.PATH || "", 500)}`);
  lines.push("");
  for (const note of availability.notes || []) lines.push(`- ${note}`);
  lines.push("");
  lines.push("For real visual diagram/timing/clock-tree review, install Poppler (pdftoppm) or MuPDF (mutool). The text_svg fallback is useful only for coordinate-preserving text inspection.");
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Coordinate-based table extraction
// -----------------------------------------------------------------------------

async function extractPdfCoordinateRows(filename, startPage, endPage) {
  const pdf = await loadPdfDocument(filename);
  const pageCount = pdf.numPages;
  const start = clampInteger(startPage, 1, 1, pageCount);
  const end = clampInteger(endPage, start, start, Math.min(pageCount, start + MAX_TABLE_PAGE_RANGE - 1));
  const pages = [];

  for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: true,
    });

    const rows = coordinateItemsToRows(content.items || []);
    pages.push({ page: pageNumber, rows });
  }

  return { filename, pageCount, startPage: start, endPage: end, pages };
}

function coordinateItemsToRows(items) {
  const rows = [];

  for (const item of items || []) {
    const str = String(item.str || "").trim();
    if (!str) continue;

    const transform = item.transform || [];
    const x = Number(transform[4] || 0);
    const y = Number(transform[5] || 0);
    const width = Number(item.width || Math.max(str.length * 4, 4));
    const height = Number(item.height || Math.abs(transform[3] || 0) || 10);

    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= Math.max(2.2, height * 0.4));
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ x, y, width, height, text: str });
  }

  rows.sort((a, b) => b.y - a.y);

  return rows.map((row, index) => {
    row.items.sort((a, b) => a.x - b.x);
    const cells = splitRowItemsIntoCells(row.items);
    return {
      rowIndex: index,
      y: row.y,
      cells,
      cellCount: cells.length,
      text: cells.map((cell) => cell.text).join(" | "),
    };
  });
}

function splitRowItemsIntoCells(items) {
  const cells = [];
  let current = null;

  for (const item of items || []) {
    if (!current) {
      current = {
        x: item.x,
        endX: item.x + item.width,
        y: item.y,
        parts: [item.text],
      };
      continue;
    }

    const gap = item.x - current.endX;
    const looksLikeSameCell = gap <= 10 || (gap <= 18 && /^[,.;:)\]]+$/.test(item.text));

    if (looksLikeSameCell) {
      current.parts.push(item.text);
      current.endX = Math.max(current.endX, item.x + item.width);
    } else {
      cells.push({
        x: current.x,
        endX: current.endX,
        text: current.parts.join(" ").replace(/\s+/g, " ").trim(),
      });
      current = {
        x: item.x,
        endX: item.x + item.width,
        y: item.y,
        parts: [item.text],
      };
    }
  }

  if (current) {
    cells.push({
      x: current.x,
      endX: current.endX,
      text: current.parts.join(" ").replace(/\s+/g, " ").trim(),
    });
  }

  return cells.filter((cell) => cell.text);
}

function isTableLikeRow(row, minColumns = 3) {
  if (!row) return false;
  const text = row.text || "";
  if ((row.cellCount || 0) >= minColumns) return true;
  if (/\b(Register|Abbreviation|Offset|Address|Initial|Access|Bit|Bit Name|Description|R\/W|Read|Write|Pin|Port|GPIO|Pinmux|Pin\s*Mux|Function|Signal|Peripheral|PFC|IOPORT|Alternate)\b/i.test(text)) return true;
  if (/\b[0-9A-F]{2,4}h\b/i.test(text) && /\b[A-Z0-9_]+\b/.test(text)) return true;
  return false;
}

function extractTablesFromCoordinateRows(pageRows, options = {}) {
  const minColumns = clampInteger(options.minColumns, 3, 2, MAX_TABLE_COLUMNS);
  const tables = [];

  for (const page of pageRows.pages || []) {
    let block = [];

    const flush = () => {
      if (block.length >= 2) {
        const table = normalizeTableBlock(page.page, block, minColumns);
        if (table.rows.length >= 2) tables.push(table);
      }
      block = [];
    };

    for (const row of page.rows || []) {
      if (isTableLikeRow(row, minColumns)) {
        block.push(row);
      } else {
        flush();
      }
    }
    flush();
  }

  return tables.slice(0, MAX_EXTRACTED_TABLES);
}

function normalizeTableBlock(page, rows, minColumns = 3) {
  const xAnchors = [];

  for (const row of rows) {
    for (const cell of row.cells || []) {
      const existing = xAnchors.find((anchor) => Math.abs(anchor.x - cell.x) <= 16);
      if (existing) {
        existing.x = (existing.x * existing.count + cell.x) / (existing.count + 1);
        existing.count += 1;
      } else {
        xAnchors.push({ x: cell.x, count: 1 });
      }
    }
  }

  const columns = xAnchors
    .filter((anchor) => anchor.count >= 2 || xAnchors.length <= minColumns)
    .sort((a, b) => a.x - b.x)
    .slice(0, MAX_TABLE_COLUMNS)
    .map((anchor, index) => ({ index, x: Math.round(anchor.x), count: anchor.count }));

  const normalizedRows = rows.slice(0, MAX_TABLE_ROWS_PER_TABLE).map((row) => {
    const cells = Array(columns.length).fill("");
    for (const cell of row.cells || []) {
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      columns.forEach((column, index) => {
        const distance = Math.abs(column.x - cell.x);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      cells[bestIndex] = [cells[bestIndex], cell.text].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    }
    return {
      y: Math.round(row.y * 10) / 10,
      text: row.text,
      cells,
    };
  });

  const headerText = normalizedRows.slice(0, 3).map((row) => row.text).join(" / ");
  const table = {
    page,
    kind: classifyCoordinateTable(headerText, normalizedRows),
    columns,
    rows: normalizedRows,
    headerText,
    confidence: scoreCoordinateTable(headerText, normalizedRows),
  };
  return enrichCoordinateTableLayout(table);
}

function classifyCoordinateTable(headerText, rows) {
  const text = `${headerText} ${(rows || []).slice(0, 5).map((row) => row.text).join(" ")}`;
  if (/\b(Register Name|Abbreviation|Offset Address|Initial Value|Access Size)\b/i.test(text)) return "register-table";
  if (/\b(Pin\s*Name|Pin\s*No|Pin\s*Number|Pin\s*Function|Alternate\s*Function|Alt\s*Function|Function\s*Assignment|Function\s*Select|Selectable\s*Function|Port\s*Name|GPIO\s*Port|I\/O\s*Port|Peripheral\s*Signal|Signal\s*Name|Mux\s*Mode|Pinmux|Pin\s*Mux|PFC|IOPORT|PMC|PMm|PFCm)\b/i.test(text)) return "pinmux-table";
  if (/\b(Bit|Bit Name|Field|R\/W|Access|Description|Initial Value)\b/i.test(text)) return "bitfield-table";
  if (/\b(Caution|Note|Restriction|Prohibited|Undefined|Reserved)\b/i.test(text)) return "caution-table";
  return "table-candidate";
}

function scoreCoordinateTable(headerText, rows) {
  let score = 40;
  const text = `${headerText} ${(rows || []).slice(0, 6).map((row) => row.text).join(" ")}`;
  if (/\b(Register Name|Abbreviation)\b/i.test(text)) score += 25;
  if (/\b(Offset Address|Address|Initial Value|Access Size)\b/i.test(text)) score += 20;
  if (/\b(Bit Name|Bit|R\/W|Access|Description)\b/i.test(text)) score += 20;
  if (/\b(Pin\s*Name|Pin\s*No|Pin\s*Function|Alternate\s*Function|Alt\s*Function|Function\s*Assignment|Function\s*Select|Port\s*Name|GPIO\s*Port|I\/O\s*Port|Signal\s*Name|Peripheral\s*Signal|Pinmux|Pin\s*Mux|PFC|IOPORT|PMC|PMm|PFCm)\b/i.test(text)) score += 25;
  if ((rows || []).length >= 4) score += 10;
  return Math.min(100, score);
}

function normalizeLayoutHeaderText(text) {
  return String(text || "").replace(/\s+/g, " ").replace(/[＿_]+/g, "_").trim();
}

function scoreColumnRole(text, role) {
  const raw = normalizeLayoutHeaderText(text);
  const lower = raw.toLowerCase();
  const canonical = normalizeForSearch(raw);
  let score = 0;
  const add = (pattern, value) => {
    if (pattern.test(raw) || pattern.test(lower) || pattern.test(canonical)) score += value;
  };
  if (role === "bit") {
    add(/^\s*(bit|bits|b\d+|bit\s*position|bit\s*no\.?|no\.?|position)\s*$/i, 70);
    add(/\b(bit|bits|b\d+|bit\s*position|bit\s*no)\b/i, 35);
    add(/^\s*\[?\d{1,2}(?::\d{1,2})?\]?\s*$/i, 42);
  } else if (role === "bitfield") {
    add(/\b(bit\s*name|field\s*name|bit\s*field|symbol|name|mnemonic|abbreviation)\b/i, 65);
    add(/^\s*(name|symbol|field)\s*$/i, 38);
    add(/^\s*[A-Z][A-Z0-9_]{1,31}\s*$/i, 22);
  } else if (role === "access") {
    add(/\b(access|r\s*\/\s*w|read\s*\/\s*write|read|write|r\/o|w\/o|r\s*only|w\s*only)\b/i, 70);
    add(/^\s*(r|w|rw|ro|wo|r\/w|r\/o|w\/o|read only|write only)\s*$/i, 55);
  } else if (role === "reset") {
    add(/\b(initial\s*value|reset\s*value|default\s*value|initial|reset|default)\b/i, 70);
    add(/^\s*(0x[0-9a-f]+|[0-9a-f]+h|[01]b|0|1|−|-|undefined)\s*$/i, 25);
  } else if (role === "description") {
    add(/\b(description|function|operation|setting|settings|contents|meaning|remarks|note)\b/i, 70);
    if (raw.length > 28) score += 18;
  } else if (role === "register") {
    add(/\b(register\s*name|register|name)\b/i, 65);
    add(/^\s*[A-Z][A-Z0-9_]{2,}\s*$/i, 18);
  } else if (role === "abbreviation") {
    add(/\b(abbreviation|abbrev\.?|symbol|register\s*symbol|short\s*name)\b/i, 70);
    add(/^\s*[A-Z0-9]+m?_[A-Za-z0-9_]+(?:_n)?\s*$/i, 35);
  } else if (role === "offset") {
    add(/\b(offset\s*address|address\s*offset|offset|address|addr\.?|base\s*\+)\b/i, 70);
    add(/(?:\+\s*)?[0-9A-Fa-f]{3,8}h\b/i, 45);
  } else if (role === "accessSize") {
    add(/\b(access\s*size|access\s*width|size|width|bits?|byte)\b/i, 60);
    add(/^\s*(8|16|32|64|128)\s*(bit|bits|byte|bytes)?\s*$/i, 35);
  } else if (role === "pin") {
    add(/\b(pin\s*name|pin\s*no\.?|pin\s*number|pin|pad|ball|terminal)\b/i, 72);
    add(/^\s*(P[A-Z0-9]*\d+[_\-]\d+|P\d+[_\-]\d+|GPIO\d+[_\-]\d+|[A-Z]{1,3}\d{1,3})\s*$/i, 55);
  } else if (role === "port") {
    add(/\b(port\s*name|port|gpio\s*port|i\/o\s*port)\b/i, 70);
    add(/^\s*(P[A-Z0-9]*\d+|PORT\d+|GPIO\d+)\s*$/i, 42);
  } else if (role === "function") {
    add(/\b(pin\s*function|function\s*name|function|alternate\s*function|alt\s*function|function\s*select|selectable\s*function)\b/i, 75);
    add(/\b(ALT\d+|AF\d+|FUNC\d+|function\s*\d+)\b/i, 40);
  } else if (role === "signal") {
    add(/\b(signal\s*name|signal|multiplexed\s*signal|peripheral\s*signal)\b/i, 72);
    add(/^\s*[A-Z][A-Z0-9_]{1,31}(?:[0-9])?\s*$/i, 18);
  } else if (role === "peripheral") {
    add(/\b(peripheral|module|ip\s*block|function\s*group|interface)\b/i, 68);
    add(/\b(ETH|GBETH|I2C|IIC|SPI|SCI|UART|CAN|PWM|GPT|ADC|USB|SDHI|MMC|IRQ|INTC|DMAC)\b/i, 38);
  } else if (role === "mode") {
    add(/\b(mode|mux\s*mode|function\s*mode|pin\s*mode|select\s*code|setting\s*value|sel|mux)\b/i, 66);
    add(/^\s*(mode\s*)?[0-9A-Fa-f]+h?\s*$/i, 28);
  } else if (role === "group") {
    add(/\b(group|pin\s*group|function\s*group|bank)\b/i, 60);
  }
  return score;
}

function inferLayoutColumnRoles(rows, columns) {
  const roleNames = ["bit", "bitfield", "access", "reset", "description", "register", "abbreviation", "offset", "accessSize", "pin", "port", "function", "signal", "peripheral", "mode", "group"];
  const columnRoles = [];
  const headerCandidates = [];
  for (const [rowIndex, row] of (rows || []).slice(0, 8).entries()) {
    const joined = (row.cells || []).join(" ");
    let score = 0;
    for (const role of roleNames) score += Math.min(80, scoreColumnRole(joined, role));
    if ((row.cells || []).filter(Boolean).length >= 2) headerCandidates.push({ rowIndex, score, text: joined });
  }
  const header = headerCandidates.sort((a, b) => b.score - a.score)[0] || { rowIndex: 0, score: 0, text: "" };
  const headerRows = (rows || []).slice(Math.max(0, header.rowIndex - 1), Math.min((rows || []).length, header.rowIndex + 2));
  for (let colIndex = 0; colIndex < (columns || []).length; colIndex += 1) {
    const samples = [];
    for (const row of headerRows) if ((row.cells || [])[colIndex]) samples.push(row.cells[colIndex]);
    for (const row of (rows || []).slice(header.rowIndex + 1, header.rowIndex + 6)) if ((row.cells || [])[colIndex]) samples.push(row.cells[colIndex]);
    const combined = samples.join(" / ");
    const roleScores = roleNames
      .map((role) => ({ role, score: scoreColumnRole(combined, role) + scoreColumnRole((rows[header.rowIndex]?.cells || [])[colIndex] || "", role) }))
      .sort((a, b) => b.score - a.score);
    const best = roleScores[0] || { role: "unknown", score: 0 };
    const second = roleScores[1] || { role: "unknown", score: 0 };
    columnRoles.push({
      column: colIndex,
      x: columns[colIndex]?.x ?? 0,
      role: best.score >= 35 ? best.role : "unknown",
      confidence: Math.min(100, best.score),
      ambiguous: best.score < 50 || (second.score > 0 && best.score - second.score < 15),
      alternatives: roleScores.slice(0, 3),
      header: (rows[header.rowIndex]?.cells || [])[colIndex] || "",
      samples: samples.slice(0, 5),
    });
  }
  const knownRoles = new Set(columnRoles.filter((c) => c.role !== "unknown").map((c) => c.role));
  const headerText = header.text || "";
  const headerAndSamples = [
    headerText,
    ...(rows || []).slice(0, 8).map((row) => row.text || (row.cells || []).join(" ")),
  ].join(" ");
  const looksBitfield = /\b(Bit|Bit Name|Field|R\/W|Access|Description|Initial Value)\b/i.test(headerAndSamples) || knownRoles.has("bit") || knownRoles.has("bitfield");
  const looksRegister = /\b(Register Name|Abbreviation|Offset Address|Initial Value|Access Size)\b/i.test(headerAndSamples) || knownRoles.has("offset") || knownRoles.has("register") || knownRoles.has("abbreviation");
  const looksPinmux = /\b(Pin\s*Name|Pin\s*No\.?|Pin\s*Number|Pin\s*Function|Alternate\s*Function|Alt\s*Function|Function\s*Assignment|Function\s*Select|Selectable\s*Function|Port\s*Name|GPIO\s*Port|I\/O\s*Port|Peripheral\s*Signal|Signal\s*Name|Mux\s*Mode|Pinmux|Pin\s*Mux|PFC|IOPORT|PMC|PMm|PFCm)\b/i.test(headerAndSamples) || knownRoles.has("pin") || knownRoles.has("port") || knownRoles.has("function") || knownRoles.has("signal") || knownRoles.has("peripheral");
  if (looksBitfield && !looksPinmux && (columns || []).length >= 4) {
    const fallback = ["bit", "bitfield", "access", "reset", "description"];
    for (let i = 0; i < Math.min(fallback.length, columnRoles.length); i += 1) {
      if (columnRoles[i].role === "unknown" || columnRoles[i].confidence < 45) {
        columnRoles[i].role = fallback[i]; columnRoles[i].confidence = Math.max(columnRoles[i].confidence, 42); columnRoles[i].fallback = true;
      }
    }
  } else if (looksRegister && !looksPinmux && (columns || []).length >= 4) {
    const fallback = ["register", "abbreviation", "offset", "reset", "accessSize", "description"];
    for (let i = 0; i < Math.min(fallback.length, columnRoles.length); i += 1) {
      if (columnRoles[i].role === "unknown" || columnRoles[i].confidence < 45) {
        columnRoles[i].role = fallback[i]; columnRoles[i].confidence = Math.max(columnRoles[i].confidence, 42); columnRoles[i].fallback = true;
      }
    }
  } else if (looksPinmux && (columns || []).length >= 2) {
    const fallback = ["pin", "function", "signal", "peripheral", "mode", "description"];
    for (let i = 0; i < Math.min(fallback.length, columnRoles.length); i += 1) {
      if (columnRoles[i].role === "unknown" || columnRoles[i].confidence < 45) {
        columnRoles[i].role = fallback[i]; columnRoles[i].confidence = Math.max(columnRoles[i].confidence, 42); columnRoles[i].fallback = true;
      }
    }
  }
  const roleMap = {};
  for (const column of columnRoles) if (column.role !== "unknown" && (!roleMap[column.role] || column.confidence > roleMap[column.role].confidence)) roleMap[column.role] = column;
  const warnings = columnRoles.filter((c) => c.ambiguous).map((c) => `column ${c.column} role ${c.role} is ambiguous`).slice(0, 8);
  return { headerRowIndex: header.rowIndex, headerScore: header.score, columnRoles, roleMap, kindHint: looksPinmux ? "pinmux-table" : looksBitfield ? "bitfield-table" : looksRegister ? "register-table" : "table-candidate", warnings };
}

function cellByRole(row, layout, roles) {
  for (const role of Array.isArray(roles) ? roles : [roles]) {
    const column = layout?.roleMap?.[role];
    if (!column) continue;
    const value = (row.cells || [])[column.column];
    if (value) return normalizeRegisterCell(value);
  }
  return "";
}

function rowCellsByRole(row, layout) {
  const cellsByRole = {};
  for (const column of layout?.columnRoles || []) {
    if (column.role === "unknown") continue;
    const value = (row.cells || [])[column.column];
    if (value) cellsByRole[column.role] = [cellsByRole[column.role], normalizeRegisterCell(value)].filter(Boolean).join(" ").trim();
  }
  return cellsByRole;
}

function enrichCoordinateTableLayout(table) {
  const layout = inferLayoutColumnRoles(table.rows || [], table.columns || []);
  const rows = (table.rows || []).map((row, index) => ({ ...row, rawCells: row.cells || [], cellsByRole: rowCellsByRole(row, layout), isHeaderCandidate: index <= layout.headerRowIndex }));
  const roleNames = new Set((layout.columnRoles || []).map((c) => c.role));
  let kind = table.kind;
  if (layout.kindHint === "bitfield-table" && (roleNames.has("bit") || roleNames.has("bitfield"))) kind = "bitfield-table";
  if (layout.kindHint === "register-table" && (roleNames.has("register") || roleNames.has("abbreviation") || roleNames.has("offset"))) kind = "register-table";
  if (layout.kindHint === "pinmux-table" && (roleNames.has("pin") || roleNames.has("port") || roleNames.has("function") || roleNames.has("signal") || roleNames.has("peripheral"))) kind = "pinmux-table";
  const roleScore = [...roleNames].filter((role) => role !== "unknown").length * 4;
  const confidence = Math.min(100, Math.max(table.confidence || 0, scoreCoordinateTable(table.headerText, rows)) + roleScore - (layout.warnings || []).length * 2);
  return { ...table, kind, rows, layout, confidence };
}

const COMMON_NON_BITFIELD_WORDS = new Set([
  "ADDRESS", "OFFSET", "REGISTER", "REGISTERS", "DESCRIPTION", "INITIALVALUE",
  "INITIAL", "VALUE", "ACCESS", "SIZE", "BITS", "BIT", "BITNAME", "NAME",
  "READ", "WRITE", "READONLY", "WRITEONLY", "RESERVED", "UNDEFINED",
  "CAUTION", "CAUTIONS", "NOTE", "NOTES", "TABLE", "FIGURE", "PAGE", "CHAPTER",
  "SECTION", "MODULE", "FUNCTION", "OPERATION", "PROCEDURE", "SETTING", "SETTINGS",
  "CONTROL", "STATUS", "TRANSFER", "REQUEST", "INTERRUPT", "ERROR", "CHANNEL",
  "CHANNELS", "DMA", "DMAC", "DMACM", "BASE", "OFFSETADDRESS", "ACCESSSIZE",
  "H", "B", "RW", "RO", "WO", "R", "W"
]);

function isLikelyRegisterName(value) {
  const raw = String(value || "").trim();
  const canonical = canonicalSymbol(raw);
  if (!canonical) return false;

  // Prefer the existing register-symbol heuristic where available.
  if (typeof looksLikeRegisterSymbol === "function" && looksLikeRegisterSymbol(raw)) return true;

  return (
    /(?:^|_)(REG|REGISTER)$/.test(canonical) ||
    /(CR|SR|DR|MR|ER|FR|RR|TR|BR|AR|LR|PR|CSR|ISR|IER|ICR|CTRL|STAT|CFG|DCTRL|CHCTRL|CHSTAT)$/.test(canonical) ||
    /^(DMAC|DMA|GBETH|ETH|GMAC|MAC|MTL|WDT|GPT|POEG|ICU|I3C|I2C|SPI|UART|CAN|ADC)[A-Z0-9_]*$/.test(canonical)
  );
}

function extractBitRangeFromValue(value) {
  const match = String(value || "").match(/\b(?:[0-9]{1,2}\s*[:：]\s*[0-9]{1,2}|[0-9]{1,2}|\[[0-9]{1,2}\s*[:：]?\s*[0-9]{0,2}\])\b/);
  return match ? match[0].replace(/[\[\]\s]/g, "").replace("：", ":") : "unknown";
}

function normalizeAccessValue(value) {
  const match = String(value || "").trim().match(/\b(R\s*\/\s*W|R\s*\/\s*O|W\s*\/\s*O|R\s*W|RO|WO|RW|R|W|Read only|Write only|Read\/Write)\b/i);
  return match ? match[0].replace(/\s+/g, "").toUpperCase() : "unknown";
}

function extractResetValue(value) {
  const match = String(value || "").trim().match(/\b(?:0x[0-9A-Fa-f]+|[0-9A-Fa-f]+h|[01]+b|[01]|undefined|reserved|−|-)\b/);
  return match ? match[0] : "unknown";
}

function likelyDescriptionFromCells(row, layout, usedRoles = []) {
  const used = new Set(usedRoles);
  const parts = [];
  for (const column of layout?.columnRoles || []) {
    if (used.has(column.role)) continue;
    const value = (row.cells || [])[column.column];
    if (value) parts.push(value);
  }
  if (!parts.length) parts.push(cellByRole(row, layout, "description"));
  return normalizeRegisterCell(parts.join(" "));
}

async function extractTablesFromPages(filename, options = {}) {
  const pageCount = await getPdfPageCount(filename);
  let start = Math.floor(Number(options.startPage));
  let end = Math.floor(Number(options.endPage));
  if (!Number.isFinite(start)) start = 1;
  if (!Number.isFinite(end)) end = start + DEFAULT_TABLE_PAGE_RANGE - 1;
  start = clampInteger(start, 1, 1, pageCount);
  end = clampInteger(end, start, start, Math.min(pageCount, start + MAX_TABLE_PAGE_RANGE - 1));

  const coordinateRows = await extractPdfCoordinateRows(filename, start, end);
  const tables = extractTablesFromCoordinateRows(coordinateRows, {
    minColumns: options.minColumns || 3,
  });

  return {
    filename,
    pageCount,
    startPage: start,
    endPage: end,
    tables,
  };
}

function formatExtractedTables(result) {
  const tables = result.tables || [];
  if (!tables.length) {
    return [
      `No coordinate table candidates found in ${result.filename} from page ${result.startPage} to ${result.endPage}.`,
      "",
      "Suggested next steps:",
      `- read_pdf_pages(filename="${result.filename}", start_page=${result.startPage}, end_page=${result.endPage})`,
      "- Try a smaller/larger page range around the register list or bit-field description.",
    ].join("\n");
  }

  const lines = [
    `Coordinate table extraction for ${result.filename}`,
    `Pages: ${result.startPage}-${result.endPage}`,
    `Tables detected: ${tables.length}`,
    "Reliability: coordinate-based heuristic. Verify original PDF pages before writing driver macros.",
  ];

  tables.forEach((table, tableIndex) => {
    lines.push("", `Table ${tableIndex + 1}`, `Page: ${table.page}`, `Kind: ${table.kind}`, `Confidence: ${table.confidence}`, `Columns: ${table.columns.map((c) => `${c.index}@x${c.x}`).join(", ")}`);
    lines.push("Rows:");
    for (const row of (table.rows || []).slice(0, 20)) {
      lines.push(`- ${row.cells.map((cell) => cell || "·").join(" | ")}`);
    }
    if ((table.rows || []).length > 20) lines.push(`... ${table.rows.length - 20} more rows omitted`);
  });

  return lines.join("\n");
}

function formatLayoutExtractedTables(result, kindFilter = "auto") {
  const wanted = String(kindFilter || "auto").toLowerCase();
  let tables = result.tables || [];
  if (wanted === "register") tables = tables.filter((table) => table.kind === "register-table");
  if (wanted === "bitfield") tables = tables.filter((table) => table.kind === "bitfield-table");
  if (wanted === "pinmux") tables = tables.filter((table) => table.kind === "pinmux-table");
  if (!tables.length) {
    return [`No layout-aware table candidates found in ${result.filename} from page ${result.startPage} to ${result.endPage}.`, `Kind filter: ${wanted}`, "", "Suggested next steps:", `- read_pdf_pages(filename="${result.filename}", start_page=${result.startPage}, end_page=${result.endPage})`, "- Try a smaller page range around the exact register/bit-field/pin-function description pages."].join("\n");
  }
  const lines = [`Step 30A/30B layout-aware table extraction for ${result.filename}`, `Pages: ${result.startPage}-${result.endPage}`, `Kind filter: ${wanted}`, `Tables shown: ${tables.length}`, "Reliability: layout-aware coordinate heuristic. Use it to preserve row/column structure, but verify driver-critical bit positions and reset values against original pages."];
  tables.forEach((table, index) => {
    lines.push("", `Table ${index + 1}`, `Page: ${table.page}`, `Kind: ${table.kind}`, `Confidence: ${table.confidence}`);
    const roles = (table.layout?.columnRoles || []).map((col) => `${col.column}@x${Math.round(col.x)}=${col.role}${col.ambiguous ? "?" : ""}${col.fallback ? "*" : ""}`).join(", ");
    lines.push(`Columns: ${roles || table.columns.map((c) => `${c.index}@x${c.x}`).join(", ")}`);
    if ((table.layout?.warnings || []).length) lines.push(`Layout warnings: ${table.layout.warnings.join("; ")}`);
    lines.push("Rows:");
    for (const row of (table.rows || []).slice(0, 24)) {
      const roleText = Object.keys(row.cellsByRole || {}).length ? ` {${Object.entries(row.cellsByRole).map(([k, v]) => `${k}: ${v}`).join("; ")}}` : "";
      lines.push(`- ${row.rawCells ? row.rawCells.join(" | ") : (row.cells || []).join(" | ")}${roleText}`);
    }
    if ((table.rows || []).length > 24) lines.push(`... ${table.rows.length - 24} more rows omitted`);
  });
  return lines.join("\n");
}

function normalizeRegisterCell(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractRegisterRowsFromCoordinateTable(table) {
  const rows = [];
  const allRows = table.rows || [];
  const layout = table.layout || inferLayoutColumnRoles(allRows, table.columns || []);
  const headerIndex = Number.isFinite(layout.headerRowIndex) ? layout.headerRowIndex : allRows.findIndex((row) => /\b(Register Name|Abbreviation|Offset Address|Initial Value|Access Size)\b/i.test(row.text));
  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;
  let previous = null;
  for (const row of allRows.slice(startIndex)) {
    const rowText = normalizeRegisterCell(row.text);
    if (!rowText || /\b(Register Name|Abbreviation|Offset Address|Initial Value|Access Size)\b/i.test(rowText)) continue;
    const registerCell = cellByRole(row, layout, ["abbreviation", "register"]);
    const symbolMatch = registerCell.match(/\b[A-Z0-9]+m?_[A-Za-z0-9_]+(?:_n)?\b|\b[A-Z][A-Z0-9_]{2,}\b/) || rowText.match(/\b[A-Z0-9]+m?_[A-Za-z0-9_]+(?:_n)?\b|\b[A-Z][A-Z0-9_]{2,}\b/);
    if (!symbolMatch) {
      if (previous && rowText.length > 8 && !/(?:\+\s*)?[0-9A-F]{3,8}h/i.test(rowText)) {
        previous.description = normalizeRegisterCell([previous.description, rowText].filter(Boolean).join(" "));
        previous.evidence = normalizeRegisterCell([previous.evidence, rowText].filter(Boolean).join(" / "));
        previous.continuationRows = (previous.continuationRows || 0) + 1;
      }
      continue;
    }
    const register = normalizeRegisterCell(symbolMatch[0]);
    if (isNonRegisterSignal(register)) continue;
    const offsetCell = cellByRole(row, layout, "offset");
    const resetCell = cellByRole(row, layout, "reset");
    const accessSizeCell = cellByRole(row, layout, "accessSize");
    const descriptionCell = cellByRole(row, layout, "description");
    const offsetMatch = (offsetCell || rowText).match(/(?:\+\s*)?[0-9A-F]{3,8}h(?:\s*\+\s*[A-Za-z0-9_ ]+)?/i);
    const initialMatch = resetCell ? [resetCell] : rowText.match(/\b(?:0x[0-9A-Fa-f]+|[0-9A-Fa-f]{1,8}h|[01]+b|0|1)\b/i);
    const accessSizeMatch = (accessSizeCell || rowText).match(/\b(8|16|32|64|128)\b(?:\s*bits?)?/i);
    const description = descriptionCell || likelyDescriptionFromCells(row, layout, ["register", "abbreviation", "offset", "reset", "accessSize"]);
    let confidence = table.kind === "register-table" ? 72 : 54;
    if (offsetMatch) confidence += 12;
    if (initialMatch) confidence += 6;
    if (accessSizeMatch) confidence += 5;
    if (layout.roleMap?.offset || layout.roleMap?.abbreviation || layout.roleMap?.register) confidence += 8;
    if ((layout.warnings || []).length) confidence -= Math.min(10, layout.warnings.length * 2);
    previous = { register, offsetAddress: offsetMatch ? offsetMatch[0].replace(/\s+/g, "") : "unknown", initialValue: initialMatch ? initialMatch[0] : "unknown", accessSize: accessSizeMatch ? accessSizeMatch[0] : "unknown", description: description || "candidate register-map row", page: table.page, confidence: Math.max(1, Math.min(98, confidence)), evidence: rowText, source: "layout-aware-coordinate-table", layoutRoles: layout.columnRoles, layoutWarnings: layout.warnings || [], rawCells: row.rawCells || row.cells || [], cellsByRole: row.cellsByRole || rowCellsByRole(row, layout) };
    rows.push(previous);
  }
  return rows;
}

async function extractRegisterTable(filename, options = {}) {
  const filter = String(options.filter || "").trim();
  const topK = clampRegisterListTopK(options.topK);
  const pageCount = await getPdfPageCount(filename);

  let ranges = [];
  if (Number.isFinite(Number(options.startPage)) && Number.isFinite(Number(options.endPage))) {
    const start = clampInteger(options.startPage, 1, 1, pageCount);
    const end = clampInteger(options.endPage, start, start, Math.min(pageCount, start + MAX_TABLE_PAGE_RANGE - 1));
    ranges = [{ start, end }];
  } else {
    const sections = await loadSectionsIndex(filename).catch(() => null);
    const pages = new Set();
    for (const section of (sections && sections.sections) || []) {
      if (/register|address|map|list/i.test(section.title || "")) pages.add(section.page);
    }
    const registers = await loadRegistersIndex(filename).catch(() => null);
    for (const reg of (registers && registers.registers || []).slice(0, 12)) {
      for (const page of reg.pages || []) pages.add(page);
    }
    if (!pages.size) pages.add(1);
    ranges = [...pages].sort((a, b) => a - b).slice(0, 8).map((page) => ({
      start: clampInteger(page, 1, 1, pageCount),
      end: Math.min(pageCount, page + DEFAULT_TABLE_PAGE_RANGE - 1),
    }));
  }

  const seen = new Map();
  for (const range of ranges) {
    const extracted = await extractTablesFromPages(filename, {
      startPage: range.start,
      endPage: range.end,
      minColumns: 3,
    });
    for (const table of extracted.tables || []) {
      if (table.kind !== "register-table" && !/register/i.test(table.headerText || "")) continue;
      for (const row of extractRegisterRowsFromCoordinateTable(table)) {
        if (filter && !normalizeForSearch(`${row.register} ${row.description}`).includes(normalizeForSearch(filter))) continue;
        const key = canonicalSymbol(row.register);
        const prev = seen.get(key);
        if (!prev || row.confidence > prev.confidence) seen.set(key, row);
      }
    }
  }

  const rows = [...seen.values()]
    .sort((a, b) => b.confidence - a.confidence || a.page - b.page || a.register.localeCompare(b.register))
    .slice(0, topK);

  return { filename, filter, rows };
}


function buildRegisterTableEvidenceContract(result) {
  const rows = (result.rows || []).slice(0, 20);
  const evidence = rows.map((row) => makeEvidence({
    source: "layout-aware-register-table",
    evidenceType: "register-table",
    page: row.page,
    quote: row.evidence || `${row.register} ${row.offsetAddress || "unknown"}`,
    confidence: row.confidence || "medium",
    name: row.register,
    field: "register",
    tool: "extract_register_table",
  }));
  const inference = rows.map((row) => makeInference({
    statement: `${row.register}: offset=${row.offsetAddress || "unknown"}, initial=${row.initialValue || "unknown"}, accessSize=${row.accessSize || "unknown"}`,
    basis: row.evidence || row.description || "coordinate-table row",
    confidence: row.confidence || "medium",
    risk: "Do not use offset/reset/access-size in driver macros until verified against original manual table.",
  }));
  const needsVerification = [];
  for (const row of rows) {
    if (!row.offsetAddress || row.offsetAddress === "unknown") needsVerification.push(makeNeedsVerification({ item: `${row.register} offset address`, reason: "Offset address was not explicit in coordinate extraction output.", suggestedTools: [`find_register(filename="${result.filename}", register="${row.register}")`, `read_pdf_pages(filename="${result.filename}", start_page=${row.page}, end_page=${row.page + 2})`] }));
    if (!row.initialValue || row.initialValue === "unknown") needsVerification.push(makeNeedsVerification({ item: `${row.register} initial/reset value`, reason: "Initial/reset value was not explicit in coordinate extraction output.", suggestedTools: [`read_pdf_pages(filename="${result.filename}", start_page=${row.page}, end_page=${row.page + 2})`] }));
    if (!row.accessSize || row.accessSize === "unknown") needsVerification.push(makeNeedsVerification({ item: `${row.register} access size`, reason: "Access size was not explicit in coordinate extraction output.", suggestedTools: [`read_pdf_pages(filename="${result.filename}", start_page=${row.page}, end_page=${row.page + 2})`] }));
  }
  return makeEvidenceContract({
    tool: "extract_register_table",
    filename: result.filename,
    query: result.filter || "register table",
    evidence,
    inference,
    needsVerification,
    warnings: ["Layout-aware register-table extraction is heuristic; verify original manual table before driver macro updates."],
    recommendedNextTools: [`list_registers(filename="${result.filename}", top_k=100)`, `read_pdf_pages(filename="${result.filename}", start_page=<page>, end_page=<page+2>)`],
  });
}

function formatExtractedRegisterTable(result) {
  const rows = result.rows || [];
  if (!rows.length) {
    return [
      `No coordinate register table rows found in ${result.filename}.`,
      result.filter ? `Filter: ${result.filter}` : "Filter: none",
      "",
      "Suggested next steps:",
      `- list_registers(filename="${result.filename}", top_k=100)`,
      "- Use extract_tables_from_pages around the register-list pages.",
      "- Use read_pdf_pages to inspect the register map manually if the table layout is complex.",
    ].join("\n");
  }

  const lines = [
    `Step 30A layout-aware register table extraction for ${result.filename}`,
    result.filter ? `Filter: ${result.filter}` : "Filter: none",
    `Rows: ${rows.length}`,
    "Reliability: coordinate-based heuristic. Verify offset/reset/access against the original PDF before writing macros.",
    "",
    "| # | Register | Offset | Initial | Access Size | Page | Confidence | Description / Evidence |",
    "|---:|---|---|---|---|---:|---:|---|",
  ];

  rows.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.register} | ${row.offsetAddress || "unknown"} | ${row.initialValue || "unknown"} | ${row.accessSize || "unknown"} | ${row.page} | ${row.confidence} | ${String(row.description || row.evidence || "").replace(/\|/g, "/").slice(0, 180)} |`);
  });

  const text = lines.join("\n");
  return appendEvidenceContract(text, buildRegisterTableEvidenceContract(result));
}


function normalizePinmuxFilterText(value) {
  return normalizeForSearch(String(value || "").replace(/[()\[\]{}]/g, " "));
}

function extractPinNameFromText(text) {
  const source = String(text || "");
  const match = source.match(/\b(?:P[A-Z0-9]*\d+[_\-]\d+|P\d+[_\-]\d+|GPIO\d+[_\-]\d+|P[A-Z]?\d{1,3}|PORT\d+)\b/i);
  return match ? match[0].replace("-", "_") : "";
}

function isPinmuxHeaderOrNoise(text) {
  const value = normalizeForSearch(text);
  if (!value) return true;
  if (/^(pin|pins|port|ports|function|functions|signal|signals|peripheral|peripherals|mode|mux|group|description|remarks|note|table)$/.test(value)) return true;
  if (/\b(pin name|pin no|pin number|pin function|alternate function|port name|signal name|peripheral signal|function select)\b/.test(value)) return true;
  return false;
}

function pinmuxFunctionCellsForRow(row, layout) {
  const cells = [];
  const usedRoles = new Set(["pin", "port", "group", "description"]);
  for (const column of layout?.columnRoles || []) {
    const value = normalizeRegisterCell((row.cells || [])[column.column]);
    if (!value || isPinmuxHeaderOrNoise(value)) continue;
    const header = normalizeRegisterCell(column.header || "");
    const role = column.role || "unknown";
    if (["function", "signal", "peripheral", "mode", "mux"].includes(role)) {
      cells.push({ role, header, value, column: column.column });
      continue;
    }
    if (!usedRoles.has(role) && /\b(function|signal|peripheral|alt|af\d+|mode|mux|sel|select)\b/i.test(header)) {
      cells.push({ role: role === "unknown" ? "function" : role, header, value, column: column.column });
    }
  }
  return cells;
}

function extractPinmuxRowsFromCoordinateTable(table, options = {}) {
  const rows = [];
  const allRows = table.rows || [];
  const layout = table.layout || inferLayoutColumnRoles(allRows, table.columns || []);
  const headerIndex = Number.isFinite(layout.headerRowIndex)
    ? layout.headerRowIndex
    : allRows.findIndex((row) => /\b(Pin\s*Name|Pin\s*No|Pin\s*Number|Pin\s*Function|Alternate\s*Function|Function\s*Select|Port\s*Name|GPIO\s*Port|Peripheral\s*Signal|Signal\s*Name|Mux\s*Mode|Pinmux|Pin\s*Mux|PFC|IOPORT)\b/i.test(row.text));
  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;
  const filter = normalizePinmuxFilterText(options.filter || "");
  const pinFilter = normalizePinmuxFilterText(options.pin || "");
  const functionFilter = normalizePinmuxFilterText(options.functionName || options.function || "");

  for (const row of allRows.slice(startIndex)) {
    const rowText = normalizeRegisterCell(row.text);
    if (!rowText || isPinmuxHeaderOrNoise(rowText)) continue;
    const cellsByRole = row.cellsByRole || rowCellsByRole(row, layout);
    const pinCell = cellByRole(row, layout, ["pin", "port"]) || extractPinNameFromText(rowText);
    const portCell = cellByRole(row, layout, "port");
    const groupCell = cellByRole(row, layout, "group");
    const descCell = cellByRole(row, layout, "description");
    const functionCells = pinmuxFunctionCellsForRow(row, layout);
    let pin = normalizeRegisterCell(pinCell);
    let port = normalizeRegisterCell(portCell);
    if (!pin && port) pin = port;
    if (!port && pin && /^P[A-Z0-9]*\d+$/i.test(pin)) port = pin;
    const fallbackFunction = normalizeRegisterCell(cellByRole(row, layout, ["function", "signal", "peripheral", "mode"]) || likelyDescriptionFromCells(row, layout, ["pin", "port", "group", "description"]));
    const candidates = functionCells.length ? functionCells : (fallbackFunction ? [{ role: "function", header: "", value: fallbackFunction, column: -1 }] : []);
    for (const candidate of candidates) {
      const functionName = normalizeRegisterCell(candidate.value);
      if (!functionName || functionName === pin || functionName === port || isPinmuxHeaderOrNoise(functionName)) continue;
      const signal = candidate.role === "signal" ? functionName : (cellByRole(row, layout, "signal") || "");
      const peripheral = candidate.role === "peripheral" ? functionName : (cellByRole(row, layout, "peripheral") || "");
      const mode = candidate.role === "mode" ? functionName : (cellByRole(row, layout, "mode") || candidate.header || "");
      const description = normalizeRegisterCell([descCell, candidate.header && candidate.header !== functionName ? `column=${candidate.header}` : "", rowText].filter(Boolean).join(" / "));
      const haystack = normalizePinmuxFilterText([pin, port, groupCell, functionName, signal, peripheral, mode, description, rowText].join(" "));
      if (filter && !haystack.includes(filter)) continue;
      if (pinFilter && !normalizePinmuxFilterText([pin, port, rowText].join(" ")).includes(pinFilter)) continue;
      if (functionFilter && !normalizePinmuxFilterText([functionName, signal, peripheral, mode, rowText].join(" ")).includes(functionFilter)) continue;
      let confidence = table.kind === "pinmux-table" ? 72 : 50;
      if (pin) confidence += 12;
      if (functionName) confidence += 12;
      if (layout.roleMap?.pin || layout.roleMap?.port) confidence += 6;
      if (layout.roleMap?.function || layout.roleMap?.signal || layout.roleMap?.peripheral) confidence += 6;
      if ((layout.warnings || []).length) confidence -= Math.min(12, layout.warnings.length * 2);
      rows.push({ pin: pin || "unknown", port: port || "unknown", function: functionName, signal: signal || "", peripheral: peripheral || "", mode: mode || "", group: normalizeRegisterCell(groupCell || ""), description: description || "candidate pin function row", page: table.page, confidence: Math.max(1, Math.min(98, confidence)), evidence: rowText, source: "layout-aware-pinmux-table", layoutRoles: layout.columnRoles, layoutWarnings: layout.warnings || [], rawCells: row.rawCells || row.cells || [], cellsByRole });
    }
  }
  return rows;
}

async function findPinmuxCandidatePages(filename, options = {}) {
  if (options.startPage !== undefined && options.endPage !== undefined) return [];
  const query = [options.filter, options.pin, options.functionName || options.function, "pin function pinmux pin mux port gpio peripheral signal alternate function pfc i/o port"].filter(Boolean).join(" ");
  const pages = new Set();
  try {
    const search = await searchPdfIndex(filename, query, 12);
    for (const result of search.results || []) if (result.page) pages.add(result.page);
  } catch {}
  return [...pages].sort((a, b) => a - b).slice(0, 8);
}

async function extractPinmuxTable(filename, options = {}) {
  const topK = clampRegisterListTopK(options.topK);
  const minColumns = clampInteger(options.minColumns, 2, 2, MAX_TABLE_COLUMNS);
  const pageCount = await getPdfPageCount(filename);
  const rows = [];
  let startPage = options.startPage === undefined ? undefined : Number(options.startPage);
  let endPage = options.endPage === undefined ? undefined : Number(options.endPage);
  const searchedPages = [];
  if (Number.isFinite(startPage)) {
    if (!Number.isFinite(endPage)) endPage = startPage + DEFAULT_TABLE_PAGE_RANGE - 1;
    startPage = clampInteger(startPage, 1, 1, pageCount);
    endPage = clampInteger(endPage, startPage, startPage, Math.min(pageCount, startPage + MAX_TABLE_PAGE_RANGE - 1));
    const extracted = await extractTablesFromPages(filename, { startPage, endPage, minColumns });
    for (const table of extracted.tables || []) {
      if (table.kind !== "pinmux-table" && !/pin|port|gpio|function|signal|peripheral|pinmux|pin\s*mux|pfc|ioport/i.test(table.headerText || "")) continue;
      rows.push(...extractPinmuxRowsFromCoordinateTable(table, options));
    }
  } else {
    const candidatePages = await findPinmuxCandidatePages(filename, options);
    for (const page of candidatePages) {
      searchedPages.push(page);
      const extracted = await extractTablesFromPages(filename, { startPage: page, endPage: Math.min(pageCount, page + 1), minColumns });
      for (const table of extracted.tables || []) {
        if (table.kind !== "pinmux-table" && !/pin|port|gpio|function|signal|peripheral|pinmux|pin\s*mux|pfc|ioport/i.test(table.headerText || "")) continue;
        rows.push(...extractPinmuxRowsFromCoordinateTable(table, options));
      }
    }
  }
  const seen = new Map();
  for (const row of rows) {
    const key = [canonicalSymbol(row.pin), canonicalSymbol(row.function), canonicalSymbol(row.mode), row.page].join(":");
    const prev = seen.get(key);
    if (!prev || row.confidence > prev.confidence) seen.set(key, row);
  }
  const finalRows = [...seen.values()].sort((a, b) => b.confidence - a.confidence || a.page - b.page || String(a.pin).localeCompare(String(b.pin))).slice(0, topK);
  return { filename, startPage: startPage || null, endPage: endPage || null, searchedPages, filter: options.filter || "", pin: options.pin || "", functionName: options.functionName || options.function || "", rows: finalRows };
}

function buildPinmuxTableEvidenceContract(result) {
  const rows = (result.rows || []).slice(0, 20);
  const evidence = rows.map((row) => makeEvidence({ source: "layout-aware-pinmux-table", evidenceType: "pin-function-table", page: row.page, quote: row.evidence || `${row.pin} ${row.function}`, confidence: row.confidence || "medium", name: row.pin, field: row.function, tool: "extract_pinmux_table" }));
  const inference = rows.map((row) => makeInference({ statement: `${row.pin}: function=${row.function}${row.mode ? `, mode=${row.mode}` : ""}${row.peripheral ? `, peripheral=${row.peripheral}` : ""}`, basis: row.evidence || row.description || "layout-aware pinmux table row", confidence: row.confidence || "medium", risk: "Pinmux extraction is heuristic. Verify pin/function/mode against the original PDF table and the SoC pinctrl binding before editing DTS or pinctrl code." }));
  const needsVerification = [];
  for (const row of rows) {
    if (!row.pin || row.pin === "unknown") needsVerification.push(makeNeedsVerification({ item: "pin name", reason: "Pin/port column was not confidently identified.", suggestedTools: [`read_pdf_pages(filename="${result.filename}", start_page=${row.page}, end_page=${row.page})`] }));
    if (!row.function) needsVerification.push(makeNeedsVerification({ item: `${row.pin} function`, reason: "Function/signal column was not confidently identified.", suggestedTools: [`read_pdf_pages(filename="${result.filename}", start_page=${row.page}, end_page=${row.page})`] }));
  }
  return makeEvidenceContract({ tool: "extract_pinmux_table", filename: result.filename, query: [result.filter, result.pin, result.functionName].filter(Boolean).join(" ") || "pinmux table", evidence, inference, needsVerification, warnings: ["Layout-aware pinmux extraction is heuristic; verify original PDF tables before DTS/pinctrl changes."], recommendedNextTools: [`read_pdf_pages(filename="${result.filename}", start_page=<page>, end_page=<page+1>)`, `extract_layout_tables_from_pages(filename="${result.filename}", start_page=<page>, end_page=<page+1>, kind="pinmux")`] });
}

function formatExtractedPinmuxTable(result) {
  const rows = result.rows || [];
  if (!rows.length) {
    return [`No layout-aware pinmux/pin-function rows found in ${result.filename}.`, result.startPage ? `Pages: ${result.startPage}-${result.endPage}` : `Searched pages from index: ${(result.searchedPages || []).join(", ") || "none"}`, result.filter ? `Filter: ${result.filter}` : "Filter: none", result.pin ? `Pin filter: ${result.pin}` : "Pin filter: none", result.functionName ? `Function filter: ${result.functionName}` : "Function filter: none", "", "Suggested next steps:", `- search_pdf(filename="${result.filename}", query="pin function pinmux port gpio peripheral signal")`, `- extract_layout_tables_from_pages(filename="${result.filename}", start_page=<page>, end_page=<page+1>, kind="pinmux")`, `- read_pdf_pages(filename="${result.filename}", start_page=<page>, end_page=<page+1>)`].join("\n");
  }
  const lines = [`Step 30B layout-aware pinmux / pin function extraction for ${result.filename}`, result.startPage ? `Pages: ${result.startPage}-${result.endPage}` : `Searched pages: ${(result.searchedPages || []).join(", ") || "none"}`, result.filter ? `Filter: ${result.filter}` : "Filter: none", result.pin ? `Pin filter: ${result.pin}` : "Pin filter: none", result.functionName ? `Function filter: ${result.functionName}` : "Function filter: none", `Rows: ${rows.length}`, "Reliability: layout-aware coordinate heuristic. Verify pin/function/mode against the original PDF before DTS/pinctrl changes.", "", "| # | Pin/Port | Function / Signal | Peripheral | Mode/Select | Page | Confidence | Evidence |", "|---:|---|---|---|---|---:|---:|---|"];
  rows.forEach((row, index) => {
    const fn = [row.function, row.signal && row.signal !== row.function ? row.signal : ""].filter(Boolean).join(" / ");
    lines.push(`| ${index + 1} | ${String(row.pin || row.port || "unknown").replace(/\|/g, "/")} | ${String(fn || "unknown").replace(/\|/g, "/")} | ${String(row.peripheral || "").replace(/\|/g, "/")} | ${String(row.mode || "").replace(/\|/g, "/")} | ${row.page} | ${row.confidence} | ${String(row.description || row.evidence || "").replace(/\|/g, "/").slice(0, 180)} |`);
  });
  return appendEvidenceContract(lines.join("\n"), buildPinmuxTableEvidenceContract(result));
}

function extractBitfieldRowsFromCoordinateTable(table, register = "") {
  const rows = [];
  const allRows = table.rows || [];
  const layout = table.layout || inferLayoutColumnRoles(allRows, table.columns || []);
  const headerIndex = Number.isFinite(layout.headerRowIndex) ? layout.headerRowIndex : allRows.findIndex((row) => /\b(Bit|Bit Name|Field|Access|R\/W|Description|Initial Value)\b/i.test(row.text));
  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;
  let previous = null;
  for (const row of allRows.slice(startIndex)) {
    const rowText = normalizeRegisterCell(row.text);
    if (!rowText || /\b(Bit Name|Description|Access|Initial Value)\b/i.test(rowText)) continue;
    if (register && canonicalSymbol(rowText).includes(canonicalSymbol(register)) && rowText.length < register.length + 10) continue;
    const bitCell = cellByRole(row, layout, "bit");
    const fieldCell = cellByRole(row, layout, "bitfield");
    const accessCell = cellByRole(row, layout, "access");
    const resetCell = cellByRole(row, layout, "reset");
    const descCell = cellByRole(row, layout, "description");
    const bitRange = extractBitRangeFromValue(bitCell || rowText);
    let bitfield = normalizeRegisterCell(fieldCell);
    if (!bitfield || bitfield === bitRange || /^(bit|bits|reserved|description)$/i.test(bitfield)) {
      const symbolCandidates = rowText.match(/\b[A-Z][A-Z0-9_]{1,31}\b/g) || [];
      bitfield = symbolCandidates.find((symbol) => !COMMON_NON_BITFIELD_WORDS.has(symbol) && !isLikelyRegisterName(symbol) && canonicalSymbol(symbol) !== canonicalSymbol(register)) || "";
    }
    if ((!bitfield || bitRange === "unknown") && previous && !fieldCell && !bitCell) {
      const continuation = descCell || rowText;
      if (continuation && continuation.length > 4) {
        previous.description = normalizeRegisterCell([previous.description, continuation].filter(Boolean).join(" "));
        previous.evidenceLines = [...(previous.evidenceLines || []), rowText].slice(0, 4);
        previous.continuationRows = (previous.continuationRows || 0) + 1;
      }
      continue;
    }
    if (!bitfield) continue;
    const access = normalizeAccessValue(accessCell || rowText);
    const reset = extractResetValue(resetCell || rowText);
    let description = descCell || likelyDescriptionFromCells(row, layout, ["bit", "bitfield", "access", "reset"]);
    description = description.replace(bitfield, "").replace(bitRange !== "unknown" ? bitRange : "", "").replace(access !== "unknown" ? access : "", "").replace(reset !== "unknown" ? reset : "", "").trim() || "candidate bit-field row";
    let confidence = table.kind === "bitfield-table" ? 74 : 56;
    if (bitRange !== "unknown") confidence += 12;
    if (access !== "unknown") confidence += 6;
    if (reset !== "unknown") confidence += 5;
    if (layout.roleMap?.bit && layout.roleMap?.bitfield) confidence += 8;
    if ((layout.warnings || []).length) confidence -= Math.min(10, layout.warnings.length * 2);
    previous = { bitRange, bitfield, access, reset, description, pages: [table.page], chunks: [], confidence: Math.max(1, Math.min(98, confidence)), evidenceLines: [rowText], source: "layout-aware-coordinate-table", layoutRoles: layout.columnRoles, layoutWarnings: layout.warnings || [], rawCells: row.rawCells || row.cells || [], cellsByRole: row.cellsByRole || rowCellsByRole(row, layout) };
    rows.push(previous);
  }
  return rows;
}

async function extractBitfieldTable(filename, register, options = {}) {
  const topK = clampBitfieldListTopK(options.topK);
  const registerMatches = await searchRegistersIndex(filename, register, { topK: 3 }).catch(() => ({ results: [] }));
  const pages = new Set();

  for (const match of registerMatches.results || []) {
    for (const page of match.pages || []) pages.add(page);
    for (const chunk of match.chunks || []) if (chunk.page) pages.add(chunk.page);
  }

  if (!pages.size) {
    const indexRows = await extractBitfieldTableFromIndex(filename, register, options);
    return { ...indexRows, source: "bitfield-index-fallback" };
  }

  const rows = [];
  const pageCount = await getPdfPageCount(filename);
  for (const page of [...pages].sort((a, b) => a - b).slice(0, 6)) {
    const extracted = await extractTablesFromPages(filename, {
      startPage: Math.max(1, page - 1),
      endPage: Math.min(pageCount, page + 2),
      minColumns: 2,
    });
    for (const table of extracted.tables || []) {
      if (table.kind !== "bitfield-table" && !/bit|field|description|access|r\/w/i.test(table.headerText || "")) continue;
      rows.push(...extractBitfieldRowsFromCoordinateTable(table, register));
    }
  }

  const seen = new Map();
  for (const row of rows) {
    const key = `${canonicalSymbol(row.bitfield)}:${row.bitRange}`;
    const prev = seen.get(key);
    if (!prev || row.confidence > prev.confidence) seen.set(key, row);
  }

  const coordinateRows = [...seen.values()]
    .sort((a, b) => b.confidence - a.confidence || String(a.bitfield).localeCompare(String(b.bitfield)))
    .slice(0, Math.min(topK, MAX_BITFIELD_TABLE_ROWS));

  if (coordinateRows.length >= 2) {
    return {
      filename,
      register,
      source: "layout-aware-coordinate-table",
      rows: coordinateRows,
    };
  }

  const indexRows = await extractBitfieldTableFromIndex(filename, register, options);
  return {
    ...indexRows,
    source: coordinateRows.length ? "mixed-coordinate-and-index-fallback" : "bitfield-index-fallback",
    rows: coordinateRows.concat(indexRows.rows || []).slice(0, Math.min(topK, MAX_BITFIELD_TABLE_ROWS)),
  };
}

function lineContainsBitfield(line, canonicalBitfield, rawBitfield) {
  const canonicalLine = canonicalSymbol(line);
  if (canonicalBitfield && canonicalLine.includes(canonicalBitfield)) return true;

  const raw = String(rawBitfield || "").trim();
  if (!raw) return false;

  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(raw)}([^A-Za-z0-9_]|$)`, "i").test(line);
}

function extractBitfieldEvidenceLines(text, bitfield, maxLines = 8) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const canonicalBitfield = normalizeBitFieldName(bitfield);
  const evidence = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!lineContainsBitfield(line, canonicalBitfield, bitfield)) continue;

    const previous = index > 0 ? lines[index - 1] : "";
    const next = index + 1 < lines.length ? lines[index + 1] : "";
    const context = [previous, line, next].filter(Boolean).join(" / ");
    evidence.push(context.slice(0, 500));

    if (evidence.length >= maxLines) break;
  }

  return evidence;
}

function scoreBitfieldChunk(chunk, bitfield, register = "", registerContext = null) {
  const rawBitfield = String(bitfield || "").trim();
  const rawRegister = String(register || "").trim();
  const canonicalBitfield = normalizeBitFieldName(rawBitfield);
  const canonicalRegister = normalizeRegisterName(rawRegister);

  if (!rawBitfield || !canonicalBitfield) return 0;

  const rawText = buildSearchText(chunk);
  const text = chunk.searchText || normalizeForSearch(rawText);
  const symbols = new Set((chunk.symbols || []).map(canonicalSymbol));
  const bitFields = new Set((chunk.bitFields || []).map(canonicalSymbol));
  const registers = new Set((chunk.registers || []).map(normalizeRegisterName));
  const headings = normalizeForSearch((chunk.headings || []).join("\n"));
  const normalizedBitfield = normalizeForSearch(rawBitfield);
  const normalizedRegister = normalizeForSearch(rawRegister);
  const evidenceLines = extractBitfieldEvidenceLines(rawText, rawBitfield, 12);

  let score = 0;

  if (bitFields.has(canonicalBitfield)) score += 150;
  if (symbols.has(canonicalBitfield)) score += 120;

  if (normalizedBitfield && text.includes(normalizedBitfield)) score += 45;

  const exactRegex = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(rawBitfield)}([^A-Za-z0-9_]|$)`, "gi");
  const exactMatches = rawText.match(exactRegex) || [];
  score += exactMatches.length * 20;

  for (const line of evidenceLines) {
    score += 18;
    if (/\b(Bit\s+Name|Bit|Bits?|Description|Setting|Value|Initial\s+Value|R\/W|Access|b[0-9]+|\[[0-9]+(?::[0-9]+)?\])\b/i.test(line)) {
      score += 28;
    }
    if (/\b(0|1|Set|Cleared|Enable|Disable|Transfer|Interrupt|Status|Error|Request)\b/i.test(line)) {
      score += 8;
    }
  }

  if (/\bBit\s+Name\b/i.test(rawText)) score += 20;
  if (/\bDescription\b/i.test(rawText)) score += 8;
  if (/\bInitial\s+Value\b/i.test(rawText)) score += 8;
  if (/\bAccess\s+Size\b/i.test(rawText)) score += 6;

  if (rawRegister) {
    if (canonicalRegister && registers.has(canonicalRegister)) score += 70;
    if (canonicalRegister && symbols.has(canonicalRegister)) score += 70;
    if (canonicalRegister && canonicalSymbol(rawText).includes(canonicalRegister)) score += 35;
    if (normalizedRegister && text.includes(normalizedRegister)) score += 25;
    if (normalizedRegister && headings.includes(normalizedRegister)) score += 30;

    if (registerContext) {
      if (registerContext.chunkIds && registerContext.chunkIds.has(chunk.id)) score += 120;
      if (registerContext.pages && registerContext.pages.has(Number(chunk.page))) score += 45;
      if (registerContext.names) {
        for (const name of registerContext.names) {
          if (registers.has(name) || symbols.has(name)) {
            score += 30;
            break;
          }
        }
      }
    }
  }

  // Avoid ranking pure register-map entries too high when they mention a bit-like symbol only incidentally.
  if (/\bRegister\s+Name\b/i.test(rawText) && !/\bBit\s+Name\b/i.test(rawText)) score -= 20;

  return Math.max(0, Math.round(score));
}

async function findBitfieldInIndex(filename, bitfield, options = {}) {
  const rawBitfield = String(bitfield || "").trim();
  const rawRegister = String(options.register || "").trim();
  const topK = clampTopK(options.topK);

  if (!rawBitfield) throw new Error("bitfield is required");

  let registerResults = [];
  let registerContext = null;

  if (rawRegister) {
    const registerSearch = await searchRegistersIndex(filename, rawRegister, Math.max(topK, 8));
    registerResults = registerSearch.results;
    registerContext = collectRegisterContext(registerResults);
  }

  const queries = buildBitFieldQueries(rawBitfield, rawRegister);
  const searchTopK = Math.min(MAX_TOP_K, Math.max(topK * 3, DEFAULT_TOP_K));
  const candidates = new Map();

  for (const query of queries) {
    const { results } = await searchPdfIndex(filename, query, searchTopK);

    for (const result of results) {
      const previous = candidates.get(result.id);
      const merged = previous
        ? {
            ...previous,
            score: Math.max(previous.score, result.score),
          }
        : result;
      candidates.set(result.id, merged);
    }
  }

  // If a register is provided, force related register chunks into the candidate set even if the
  // generic text search ranked them low. This is useful for tables where PDF extraction splits
  // bit names from descriptions across adjacent lines.
  if (rawRegister && registerResults.length) {
    const indexData = await loadPdfIndex(filename);
    const relatedChunkIds = new Set();
    const relatedPages = new Set();

    for (const entry of registerResults) {
      for (const chunk of entry.chunks || []) {
        if (chunk.id) relatedChunkIds.add(chunk.id);
        if (Number.isFinite(Number(chunk.page))) relatedPages.add(Number(chunk.page));
      }
      for (const page of entry.pages || []) {
        if (Number.isFinite(Number(page))) relatedPages.add(Number(page));
      }
    }

    for (const chunk of indexData.chunks || []) {
      const nearPage = relatedPages.has(Number(chunk.page));
      const directChunk = relatedChunkIds.has(chunk.id);
      if (nearPage || directChunk) {
        candidates.set(chunk.id, candidates.get(chunk.id) || chunk);
      }
    }
  }

  const results = [...candidates.values()]
    .map((chunk) => ({
      ...chunk,
      score: scoreBitfieldChunk(chunk, rawBitfield, rawRegister, registerContext),
      bitfieldEvidence: extractBitfieldEvidenceLines(chunk.text || "", rawBitfield, 5),
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, topK);

  return {
    bitfield: rawBitfield,
    register: rawRegister,
    registerResults,
    results,
  };
}

function formatBitfieldResults(searchResult) {
  const bitfield = searchResult.bitfield;
  const register = searchResult.register;
  const results = searchResult.results || [];
  const registerResults = searchResult.registerResults || [];

  if (!results.length) {
    return [
      register
        ? `No bit-field results found for "${bitfield}" in register context "${register}".`
        : `No bit-field results found for "${bitfield}".`,
      "",
      "Suggested next steps:",
      "- Verify the bit-field spelling from the manual.",
      "- Try passing a related register, for example find_bitfield(filename=\"...\", register=\"DMACm_CHCTRL_n\", bitfield=\"EN\").",
      "- Try search_pdf with the bit-field plus 'Bit Name' or 'Description'.",
    ].join("\n");
  }

  const header = [
    register
      ? `Bit-field results for "${bitfield}" within register context "${register}"`
      : `Bit-field results for "${bitfield}"`,
  ];

  if (register) {
    header.push(
      registerResults.length
        ? `Register context matches: ${registerResults.slice(0, 5).map((entry) => entry.displayName || entry.name).join(", ")}`
        : `Register context matches: none; used generic bit-field search fallback.`
    );
  }

  return [
    ...header,
    "",
    ...results.map((result, index) => {
      const preview = normalizeText(result.text || "").slice(0, MAX_PREVIEW_CHARS);
      const truncated = (result.text || "").length > MAX_PREVIEW_CHARS ? "..." : "";
      const evidence = (result.bitfieldEvidence || []).length
        ? result.bitfieldEvidence.map((line) => `   - ${line}`).join("\n")
        : "   - none";

      return [
        `Result ${index + 1}`,
        `ID: ${result.id}`,
        `File: ${result.filename}`,
        `Page: ${result.page}`,
        `Chunk: ${result.chunkIndex}`,
        `Score: ${result.score}`,
        `Headings: ${
          result.headings && result.headings.length
            ? result.headings.join(" | ")
            : "none"
        }`,
        `Registers: ${
          result.registers && result.registers.length
            ? result.registers.join(", ")
            : "none"
        }`,
        `Bit fields / symbols: ${
          result.bitFields && result.bitFields.length
            ? result.bitFields.slice(0, 40).join(", ")
            : "none"
        }`,
        "Evidence lines:",
        evidence,
        `Suggested chunk read: read_pdf_chunk(filename="${result.filename}", chunk_id="${result.id}")`,
        `Suggested page read: read_pdf_pages(filename="${result.filename}", start_page=${result.page}, end_page=${Math.min(result.page + DEFAULT_PAGE_RANGE - 1, result.pageCount || result.page + DEFAULT_PAGE_RANGE - 1)})`,
        "Preview:",
        `${preview}${truncated}`,
      ].join("\n");
    }),
  ].join("\n\n---\n\n");
}


function clampRegisterSummaryTopK(value) {
  const n = Number(value || DEFAULT_REGISTER_SUMMARY_CHUNKS);
  if (!Number.isFinite(n)) return DEFAULT_REGISTER_SUMMARY_CHUNKS;
  return Math.max(1, Math.min(MAX_REGISTER_SUMMARY_CHUNKS, Math.floor(n)));
}

function isLikelySummaryBitfield(symbol, registerEntry = null) {
  const raw = String(symbol || "").trim();
  const canonical = canonicalSymbol(raw);
  if (!canonical || canonical.length < 1 || canonical.length > 32) return false;

  const registerNames = new Set();
  if (registerEntry) {
    for (const name of [registerEntry.name, registerEntry.displayName, ...(registerEntry.aliases || [])]) {
      const normalized = normalizeRegisterName(name);
      if (normalized) registerNames.add(normalized);
    }
  }

  if (registerNames.has(normalizeRegisterName(raw))) return false;
  if (looksLikeRegisterSymbol(raw)) return false;
  if (/^[0-9]+$/.test(canonical)) return false;
  if (/^[0-9A-F]+H$/.test(canonical)) return false;

  const noisyWords = new Set([
    "REGISTER", "REGISTERS", "DESCRIPTION", "INITIAL", "VALUE", "VALUES",
    "OFFSET", "ADDRESS", "ACCESS", "SIZE", "PAGE", "PAGES", "TABLE",
    "FIGURE", "RESERVED", "RESERVE", "SETTING", "SETTINGS", "BIT", "BITS",
    "NAME", "NOTES", "NOTE", "CAUTION", "SECTION", "CHAPTER", "READ", "WRITE",
    "WHEN", "THIS", "THAT", "THE", "AND", "OR", "FOR", "FROM", "WITH",
  ]);

  return !noisyWords.has(canonical);
}

function scoreRegisterSummaryChunk(chunk, registerEntry, registerQuery) {
  const rawText = buildSearchText(chunk);
  const normalizedText = chunk.searchText || normalizeForSearch(rawText);
  const canonicalText = canonicalSymbol(rawText);
  const chunkRegisters = new Set((chunk.registers || []).map(normalizeRegisterName));
  const chunkSymbols = new Set((chunk.symbols || []).map(canonicalSymbol));
  const registerNames = new Set();

  for (const name of [registerEntry.name, registerEntry.displayName, ...(registerEntry.aliases || []), registerQuery]) {
    const normalized = normalizeRegisterName(name);
    if (normalized) registerNames.add(normalized);
  }

  const directChunkIds = new Set((registerEntry.chunks || []).map((item) => item.id).filter(Boolean));
  const pages = new Set((registerEntry.pages || []).map(Number).filter(Number.isFinite));
  let score = 0;

  if (directChunkIds.has(chunk.id)) score += 140;
  if (pages.has(Number(chunk.page))) score += 45;

  for (const name of registerNames) {
    if (chunkRegisters.has(name) || chunkSymbols.has(name)) score += 90;
    if (canonicalText.includes(name)) score += 55;
  }

  const normalizedRegister = normalizeForSearch(registerQuery || registerEntry.displayName || registerEntry.name);
  if (normalizedRegister && normalizedText.includes(normalizedRegister)) score += 35;

  if (/\bRegister\s+Name\b/i.test(rawText)) score += 18;
  if (/\b(Bit\s+Name|Bit|Bits?)\b/i.test(rawText)) score += 42;
  if (/\b(Description|Setting|Operation|Function)\b/i.test(rawText)) score += 16;
  if (/\b(Initial\s+Value|Reset\s+Value|Default\s+Value)\b/i.test(rawText)) score += 18;
  if (/\b(Offset\s+Address|Address|Access\s+Size|R\/W|Read|Write)\b/i.test(rawText)) score += 18;
  if (/\b(Caution|Note|Prohibit|Must|Do\s+not|Reserved|Undefined)\b/i.test(rawText)) score += 12;

  return Math.max(0, Math.round(score));
}

async function collectRegisterSummaryChunks(filename, registerEntry, registerQuery, topK) {
  const indexData = await loadPdfIndex(filename);
  const scored = [];

  for (const chunk of indexData.chunks || []) {
    const score = scoreRegisterSummaryChunk(chunk, registerEntry, registerQuery);
    if (score <= 0) continue;
    scored.push({
      ...chunk,
      summaryScore: score,
      registerEvidence: extractRegisterEvidenceLines(chunk.text || "", registerEntry, registerQuery, 4),
    });
  }

  scored.sort((a, b) => {
    if (b.summaryScore !== a.summaryScore) return b.summaryScore - a.summaryScore;
    if (a.page !== b.page) return a.page - b.page;
    return a.chunkIndex - b.chunkIndex;
  });

  return scored.slice(0, topK);
}

function extractRegisterEvidenceLines(text, registerEntry, registerQuery, maxLines = 8) {
  const names = [registerQuery, registerEntry.name, registerEntry.displayName, ...(registerEntry.aliases || [])]
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean);
  const canonicalNames = [...new Set(names.map(normalizeRegisterName).filter(Boolean))];

  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const evidence = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const canonicalLine = canonicalSymbol(line);
    const matched = canonicalNames.some((name) => canonicalLine.includes(name));
    if (!matched) continue;

    const previous = index > 0 ? lines[index - 1] : "";
    const next = index + 1 < lines.length ? lines[index + 1] : "";
    evidence.push([previous, line, next].filter(Boolean).join(" / ").slice(0, 650));
    if (evidence.length >= maxLines) break;
  }

  return evidence;
}

function collectSummaryBitfields(chunks, registerEntry, maxBitfields = MAX_REGISTER_SUMMARY_BITFIELDS) {
  const byName = new Map();

  for (const chunk of chunks || []) {
    const symbols = new Set([...(chunk.bitFields || []), ...(chunk.symbols || [])]);

    for (const symbol of symbols) {
      if (!isLikelySummaryBitfield(symbol, registerEntry)) continue;
      const canonical = canonicalSymbol(symbol);
      if (!canonical) continue;

      const entry = byName.get(canonical) || {
        name: symbol,
        canonical,
        pages: new Set(),
        chunks: new Set(),
        evidence: [],
        score: 0,
      };

      entry.pages.add(chunk.page);
      entry.chunks.add(chunk.id);
      entry.score += Number(chunk.summaryScore || 0) > 0 ? 2 : 1;

      const evidence = extractBitfieldEvidenceLines(chunk.text || "", symbol, 2);
      for (const line of evidence) {
        if (entry.evidence.length < 4 && !entry.evidence.includes(line)) {
          entry.evidence.push(line);
          entry.score += 5;
        }
      }

      if ((chunk.bitFields || []).some((field) => canonicalSymbol(field) === canonical)) entry.score += 3;
      byName.set(canonical, entry);
    }
  }

  return [...byName.values()]
    .map((entry) => ({
      name: entry.name,
      canonical: entry.canonical,
      pages: [...entry.pages].sort((a, b) => a - b),
      chunks: [...entry.chunks].slice(0, 8),
      evidence: entry.evidence.slice(0, 4),
      score: entry.score,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    })
    .slice(0, maxBitfields);
}

function reliabilityForRegisterSummary(registerEntry, chunks, bitfields) {
  const sources = new Set(registerEntry.sourceKinds || []);
  const hasExplicitRegister = sources.has("register-list-table") || sources.has("register-description-heading");
  const hasBitfieldEvidence = (bitfields || []).some((field) => (field.evidence || []).length > 0);
  const hasRegisterChunks = (chunks || []).length > 0;

  if (hasExplicitRegister && hasBitfieldEvidence && hasRegisterChunks) {
    return "High for locating the register and candidate bit-field context; verify exact bit positions against the original PDF table.";
  }
  if (hasExplicitRegister && hasRegisterChunks) {
    return "Medium-high for locating the register; bit-field extraction may be incomplete.";
  }
  if (hasRegisterChunks) {
    return "Medium. Register was found through heuristic context; verify with read_pdf_pages.";
  }
  return "Low. Register metadata was found, but related chunks were not confidently identified.";
}

function summarizeRegisterEntryFast(filename, registerIndex, registerEntry, indexData, topK = 4) {
  const chunksById = new Map((indexData.chunks || []).map((chunk) => [chunk.id, chunk]));
  const pages = new Set((registerEntry.pages || []).map(Number).filter(Number.isFinite));
  const candidateMap = new Map();

  for (const ref of registerEntry.chunks || []) {
    const chunk = chunksById.get(ref.id);
    if (chunk) candidateMap.set(chunk.id, chunk);
  }

  // Add nearby/page-local chunks only. This avoids scanning the full manual once per register.
  for (const chunk of indexData.chunks || []) {
    if (!pages.has(Number(chunk.page))) continue;
    if (candidateMap.size >= Math.max(topK * 6, 18)) break;
    candidateMap.set(chunk.id, chunk);
  }

  const relatedChunks = [...candidateMap.values()]
    .map((chunk) => {
      const score = scoreRegisterSummaryChunk(chunk, registerEntry, registerEntry.displayName || registerEntry.name);
      return {
        ...chunk,
        summaryScore: score,
        registerEvidence: extractRegisterEvidenceLines(chunk.text || "", registerEntry, registerEntry.displayName || registerEntry.name, 4),
      };
    })
    .filter((chunk) => Number(chunk.summaryScore || 0) > 0)
    .sort((a, b) => {
      if (b.summaryScore !== a.summaryScore) return b.summaryScore - a.summaryScore;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, topK);

  const bitfields = collectSummaryBitfields(relatedChunks, registerEntry, MAX_REGISTER_SUMMARY_BITFIELDS);

  return {
    filename,
    register: registerEntry.displayName || registerEntry.name,
    registerIndex,
    registerEntry,
    registerResults: [registerEntry],
    relatedChunks,
    bitfields,
    reliability: `${reliabilityForRegisterSummary(registerEntry, relatedChunks, bitfields)} Fast summary: used direct/page-local register chunks only to avoid MCP timeout.`,
  };
}

async function summarizeRegister(filename, register, options = {}) {
  const rawRegister = String(register || "").trim();
  if (!rawRegister) throw new Error("register is required");

  const topK = clampRegisterSummaryTopK(options.topK);
  const includeBitfieldEvidence = options.includeBitfieldEvidence !== false;

  const { registerIndex, results: registerResults } = await searchRegistersIndex(filename, rawRegister, Math.max(5, Math.min(MAX_TOP_K, topK)));

  if (!registerResults.length) {
    const fallback = await multiQuerySearch(filename, buildRegisterQueries(rawRegister), Math.min(topK, MAX_TOP_K));
    return {
      filename,
      register: rawRegister,
      registerIndex,
      registerEntry: null,
      registerResults: [],
      relatedChunks: fallback,
      bitfields: [],
      reliability: "Low. No direct register-index match; fallback chunk search only.",
    };
  }

  const registerEntry = registerResults[0];
  const relatedChunks = await collectRegisterSummaryChunks(filename, registerEntry, rawRegister, topK);
  const bitfields = collectSummaryBitfields(relatedChunks, registerEntry, MAX_REGISTER_SUMMARY_BITFIELDS);

  return {
    filename,
    register: rawRegister,
    registerIndex,
    registerEntry,
    registerResults,
    relatedChunks,
    bitfields: includeBitfieldEvidence ? bitfields : bitfields.map((field) => ({ ...field, evidence: [] })),
    reliability: reliabilityForRegisterSummary(registerEntry, relatedChunks, bitfields),
  };
}

function formatRegisterSummary(summary) {
  const filename = summary.filename;
  const queryRegister = summary.register;
  const entry = summary.registerEntry;
  const chunks = summary.relatedChunks || [];
  const bitfields = summary.bitfields || [];

  if (!entry) {
    return [
      `Register summary for "${queryRegister}"`,
      `File: ${filename}`,
      "",
      "Register index match: none",
      `Reliability: ${summary.reliability}`,
      "",
      "Fallback related chunks:",
      chunks.length ? formatSearchResults(chunks, queryRegister) : "none",
      "",
      "Suggested next steps:",
      `- Try list_registers(filename="${filename}", filter="${queryRegister}").`,
      `- Try find_register(filename="${filename}", register="${queryRegister}").`,
      `- Try search_pdf(filename="${filename}", query="${queryRegister} Register Bit Name").`,
    ].join("\n");
  }

  const pages = (entry.pages || []).join(", ") || "unknown";
  const sections = (entry.sections || [])
    .slice(0, 5)
    .map((section) => `${section.title} (page ${section.page})`)
    .join(" | ") || "none";
  const headings = (entry.headings || []).slice(0, 6).join(" | ") || "none";
  const descriptions = (entry.descriptions || []).join(" | ") || "unknown";
  const offsets = (entry.offsetAddresses || []).join(" | ") || "unknown";
  const initialValues = (entry.initialValues || []).join(" | ") || "unknown";
  const accessSizes = (entry.accessSizes || []).join(" | ") || "unknown";
  const sourceKinds = (entry.sourceKinds || []).join(", ") || "unknown";
  const aliases = (entry.aliases || []).slice(0, 16).join(", ") || "none";

  const firstPage = (entry.pages || [])[0];
  const suggestedPageRead = firstPage
    ? `read_pdf_pages(filename="${filename}", start_page=${firstPage}, end_page=${Math.min(firstPage + DEFAULT_PAGE_RANGE - 1, summary.registerIndex.pageCount || firstPage)})`
    : "none";

  const bitfieldLines = bitfields.length
    ? bitfields.slice(0, MAX_REGISTER_SUMMARY_BITFIELDS).map((field, index) => {
        const evidence = (field.evidence || []).length
          ? field.evidence.slice(0, 2).map((line) => `      evidence: ${line}`).join("\n")
          : "      evidence: none";
        const findCall = `find_bitfield(filename="${filename}", register="${entry.displayName || entry.name}", bitfield="${field.name}")`;
        return [
          `${index + 1}. ${field.name}`,
          `   Pages: ${field.pages.join(", ") || "unknown"}`,
          `   Chunks: ${field.chunks.slice(0, 4).join(", ") || "none"}`,
          `   Suggested find: ${findCall}`,
          evidence,
        ].join("\n");
      }).join("\n")
    : "none detected from related chunks";

  const chunkLines = chunks.length
    ? chunks.map((chunk, index) => {
        const preview = normalizeText(chunk.text || "").slice(0, 700);
        const evidence = (chunk.registerEvidence || []).length
          ? chunk.registerEvidence.map((line) => `   - ${line}`).join("\n")
          : "   - none";
        return [
          `Chunk ${index + 1}`,
          `ID: ${chunk.id}`,
          `Page: ${chunk.page}`,
          `Score: ${chunk.summaryScore}`,
          `Headings: ${(chunk.headings || []).join(" | ") || "none"}`,
          `Registers: ${(chunk.registers || []).join(", ") || "none"}`,
          `Bit fields / symbols: ${(chunk.bitFields || []).slice(0, 40).join(", ") || "none"}`,
          "Register evidence lines:",
          evidence,
          `Suggested chunk read: read_pdf_chunk(filename="${filename}", chunk_id="${chunk.id}")`,
          `Preview:\n${preview}${(chunk.text || "").length > 700 ? "..." : ""}`,
        ].join("\n");
      }).join("\n\n---\n\n")
    : "none";

  return [
    `Register summary for "${queryRegister}"`,
    `File: ${filename}`,
    "",
    "Register identity",
    `- Matched register: ${entry.displayName || entry.name}`,
    `- Canonical name: ${entry.name}`,
    `- Aliases: ${aliases}`,
    `- Confidence: ${entry.confidence}`,
    `- Source: ${sourceKinds}`,
    `- Pages: ${pages}`,
    `- Nearest sections: ${sections}`,
    `- Headings: ${headings}`,
    "",
    "Register metadata detected",
    `- Description: ${descriptions}`,
    `- Offset address: ${offsets}`,
    `- Initial value: ${initialValues}`,
    `- Access size: ${accessSizes}`,
    "",
    "Reliability",
    `- ${summary.reliability}`,
    "",
    "Suggested next calls",
    `- ${suggestedPageRead}`,
    `- find_register(filename="${filename}", register="${entry.displayName || entry.name}")`,
    "",
    "Detected bit-field candidates from related chunks",
    bitfieldLines,
    "",
    "Related chunks / evidence",
    chunkLines,
  ].join("\n");
}


function clampSequenceTopK(value) {
  return clampInteger(value, DEFAULT_SEQUENCE_TOP_K, 1, MAX_SEQUENCE_TOP_K);
}

function classifySequenceTopic(topic) {
  const normalized = normalizeForSearch(topic);
  const canonical = canonicalSymbol(topic);
  const kinds = new Set();

  if (/\b(init|initial|initialize|initialization|setup|setting|configure|configuration)\b/i.test(normalized)) kinds.add("init");
  if (/\b(start|enable|run|trigger|request|kick|resume|seten|tstart|transfer start)\b/i.test(normalized) || /SETEN|TSTART/.test(canonical)) kinds.add("start");
  if (/\b(stop|disable|halt|suspend|pause|cancel|clear enable|clren|clrrq)\b/i.test(normalized) || /CLREN|CLRRQ|SUSP/.test(canonical)) kinds.add("stop");
  if (/\b(clear|ack|acknowledge|status|flag|interrupt|w1c|write 1|write one|end|tc|er)\b/i.test(normalized)) kinds.add("clear");
  if (/\b(reset|software reset|swrst|module reset|rst)\b/i.test(normalized) || /SWRST|RESET/.test(canonical)) kinds.add("reset");
  if (/\b(interrupt|irq|request|event|status)\b/i.test(normalized)) kinds.add("interrupt");
  if (/\b(clock|reset release|module standby|mstp|pclk)\b/i.test(normalized)) kinds.add("clock-reset");

  if (!kinds.size) kinds.add("generic");
  return [...kinds];
}

function buildSequenceQueries(topic, register = "") {
  const rawTopic = String(topic || "").trim();
  const rawRegister = String(register || "").trim();
  const kinds = classifySequenceTopic(rawTopic);
  const queries = new Set();

  const add = (value) => {
    const text = String(value || "").trim();
    if (text) queries.add(text);
  };

  add(rawTopic);
  add(`${rawTopic} procedure`);
  add(`${rawTopic} operation`);
  add(`${rawTopic} sequence`);
  add(`${rawTopic} flow`);
  add(`${rawTopic} setting procedure`);
  add(`${rawTopic} register setting`);
  add(`${rawTopic} caution note restriction`);

  if (rawRegister) {
    add(`${rawRegister} ${rawTopic}`);
    add(`${rawRegister} procedure`);
    add(`${rawRegister} operation`);
    add(`${rawRegister} Bit Name Description`);
    add(`${rawRegister} caution note restriction`);
  }

  if (kinds.includes("init")) {
    add("initial setting procedure");
    add("initialization procedure");
    add("initial settings before operation");
    add("register setting procedure");
    add("clock reset setting procedure");
    add("before starting operation setting");
  }

  if (kinds.includes("start")) {
    add("start operation procedure");
    add("start transfer procedure");
    add("enable operation sequence");
    add("set enable bit start transfer");
    add("transfer request start");
    add("channel enable start");
    add("SETEN enable start");
  }

  if (kinds.includes("stop")) {
    add("stop operation procedure");
    add("disable operation sequence");
    add("stop transfer procedure");
    add("suspend channel procedure");
    add("clear enable bit stop");
    add("CLREN stop disable");
  }

  if (kinds.includes("clear")) {
    add("clear status flag procedure");
    add("clear interrupt status");
    add("write 1 to clear status");
    add("write 0 to clear status");
    add("transfer end clear");
    add("error status clear");
    add("status register clear flag");
  }

  if (kinds.includes("reset")) {
    add("software reset procedure");
    add("reset operation sequence");
    add("module reset procedure");
    add("reset release procedure");
    add("SWRST software reset");
  }

  if (kinds.includes("interrupt")) {
    add("interrupt handling procedure");
    add("interrupt status clear");
    add("interrupt enable setting");
    add("interrupt request clear");
    add("status flag interrupt");
  }

  if (kinds.includes("clock-reset")) {
    add("clock setting procedure");
    add("reset release setting");
    add("module standby release");
    add("PCLK clock enable reset");
  }

  return [...queries];
}

function sequenceKeywordSet(topic, register = "") {
  const normalized = normalizeForSearch(`${topic} ${register}`);
  const words = normalized.split(/\s+/).filter((word) => word.length > 1);
  const keywords = new Set(words);

  const common = [
    "procedure", "sequence", "flow", "operation", "setting", "settings",
    "initial", "initialization", "initialize", "start", "stop", "enable",
    "disable", "clear", "reset", "software", "transfer", "request",
    "interrupt", "status", "flag", "error", "end", "complete", "completion",
    "write", "read", "set", "before", "after", "when", "while", "must",
    "should", "prohibit", "prohibited", "caution", "note", "restriction",
  ];

  for (const word of common) keywords.add(word);
  return keywords;
}

function extractSequenceEvidenceLines(text, topic, register = "", maxLines = MAX_SEQUENCE_EVIDENCE_LINES) {
  const keywords = sequenceKeywordSet(topic, register);
  const topicTerms = normalizeForSearch(topic).split(/\s+/).filter((word) => word.length > 1);
  const registerCanonical = normalizeRegisterName(register);
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const scored = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const normalizedLine = normalizeForSearch(line);
    const canonicalLine = canonicalSymbol(line);
    let score = 0;

    for (const term of topicTerms) {
      if (term && normalizedLine.includes(term)) score += 18;
    }

    for (const word of keywords) {
      if (word && normalizedLine.includes(word)) score += 2;
    }

    if (registerCanonical && canonicalLine.includes(registerCanonical)) score += 25;
    if (/\b(procedure|sequence|flow|operation|setting|settings)\b/i.test(line)) score += 18;
    if (/\b(before|after|when|while|must|should|do not|prohibited|only|until)\b/i.test(line)) score += 20;
    if (/\b(write|read|set|clear|enable|disable|start|stop|reset|suspend|transfer|interrupt|status|flag)\b/i.test(line)) score += 12;
    if (/^\(?\d+\)?[.)]\s+/.test(line) || /^Step\s*\d+/i.test(line)) score += 16;
    if (/\b(Caution|Note|Notes|Restriction|Restrictions)\b/i.test(line)) score += 22;

    if (score <= 0) continue;

    const prev = index > 0 ? lines[index - 1] : "";
    const next = index + 1 < lines.length ? lines[index + 1] : "";
    scored.push({
      score,
      index,
      line: [prev, line, next].filter(Boolean).join(" / ").slice(0, 900),
    });
  }

  return scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .slice(0, maxLines)
    .map((item) => item.line);
}

function scoreSequenceChunk(chunk, topic, register = "", registerContext = null, sectionContext = null) {
  const rawText = buildSearchText(chunk);
  const normalizedText = chunk.searchText || normalizeForSearch(rawText);
  const canonicalText = canonicalSymbol(rawText);
  const topicNormalized = normalizeForSearch(topic);
  const topicTerms = topicNormalized.split(/\s+/).filter((word) => word.length > 1);
  const registerCanonical = normalizeRegisterName(register);
  const evidenceLines = extractSequenceEvidenceLines(chunk.text || "", topic, register, 5);
  const kinds = classifySequenceTopic(topic);
  let score = 0;

  if (topicNormalized && normalizedText.includes(topicNormalized)) score += 70;

  for (const term of topicTerms) {
    if (countWordOccurrences(normalizedText, term)) score += 12;
    else if (normalizedText.includes(term)) score += 5;
  }

  if (registerCanonical && canonicalText.includes(registerCanonical)) score += 45;

  if (registerContext) {
    if (registerContext.chunkIds && registerContext.chunkIds.has(chunk.id)) score += 85;
    if (registerContext.pages && registerContext.pages.has(Number(chunk.page))) score += 30;
    if (registerContext.names) {
      for (const name of registerContext.names) {
        if (name && canonicalText.includes(name)) {
          score += 20;
          break;
        }
      }
    }
  }

  if (sectionContext) {
    if (sectionContext.pages && sectionContext.pages.has(Number(chunk.page))) score += 45;
    if (sectionContext.nearPages && sectionContext.nearPages.has(Number(chunk.page))) score += 22;
  }

  if (/\b(procedure|sequence|flow|operation|operations|setting|settings)\b/i.test(rawText)) score += 28;
  if (/\b(before|after|when|while|must|should|do not|prohibited|only|until)\b/i.test(rawText)) score += 24;
  if (/\b(Caution|Note|Notes|Restriction|Restrictions)\b/i.test(rawText)) score += 20;
  if (/^\(?\d+\)?[.)]\s+/m.test(rawText) || /^Step\s*\d+/im.test(rawText)) score += 25;

  if (kinds.includes("init") && /\b(initial|initialization|initialize|setting|configuration|configure|before)\b/i.test(rawText)) score += 30;
  if (kinds.includes("start") && /\b(start|enable|set|request|transfer|operation|SETEN|TSTART)\b/i.test(rawText)) score += 30;
  if (kinds.includes("stop") && /\b(stop|disable|clear|suspend|halt|CLREN|CLRRQ)\b/i.test(rawText)) score += 30;
  if (kinds.includes("clear") && /\b(clear|status|flag|interrupt|write\s*[01]|END|TC|ER)\b/i.test(rawText)) score += 32;
  if (kinds.includes("reset") && /\b(reset|software reset|SWRST|release)\b/i.test(rawText)) score += 32;
  if (kinds.includes("interrupt") && /\b(interrupt|IRQ|request|status|flag|enable|clear)\b/i.test(rawText)) score += 25;

  score += evidenceLines.length * 18;

  // Pure register-list rows are useful context but usually not the actual operation sequence.
  if (/\bRegister\s+Name\b/i.test(rawText) && !/\b(procedure|sequence|operation|Caution|Note)\b/i.test(rawText)) {
    score -= 30;
  }

  return Math.max(0, Math.round(score));
}

function collectSectionContext(sectionResults) {
  const pages = new Set();
  const nearPages = new Set();

  for (const section of sectionResults || []) {
    const page = Number(section.page);
    if (!Number.isFinite(page)) continue;
    pages.add(page);
    for (let delta = -1; delta <= DEFAULT_PAGE_RANGE; delta++) {
      const nearPage = page + delta;
      if (nearPage > 0) nearPages.add(nearPage);
    }
  }

  return { pages, nearPages };
}

async function findSequenceInIndex(filename, topic, options = {}) {
  const rawTopic = String(topic || "").trim();
  const rawRegister = String(options.register || "").trim();
  const topK = clampSequenceTopK(options.topK);
  if (!rawTopic) throw new Error("topic is required");

  const queries = buildSequenceQueries(rawTopic, rawRegister);
  const candidateMap = new Map();
  const searchTopK = Math.min(MAX_TOP_K, Math.max(topK * 3, DEFAULT_TOP_K));

  let registerResults = [];
  let registerContext = null;
  if (rawRegister) {
    const registerSearch = await searchRegistersIndex(filename, rawRegister, Math.max(topK, DEFAULT_TOP_K));
    registerResults = registerSearch.results;
    registerContext = collectRegisterContext(registerResults);
  }

  const sectionQueries = [rawTopic, `${rawTopic} operation`, `${rawTopic} procedure`, `${rawTopic} setting`, `${rawTopic} caution`];
  const sectionResultsById = new Map();
  for (const query of sectionQueries) {
    const { results } = await searchSectionsIndex(filename, query, Math.min(8, topK));
    for (const result of results) sectionResultsById.set(result.id, result);
  }
  const sectionResults = [...sectionResultsById.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.page - b.page;
    })
    .slice(0, 8);
  const sectionContext = collectSectionContext(sectionResults);

  for (const query of queries) {
    const { results } = await searchPdfIndex(filename, query, searchTopK);
    for (const result of results) {
      candidateMap.set(result.id, candidateMap.get(result.id) || result);
    }
  }

  // Pull chunks near matched sections and matched registers into the candidate set even if
  // lexical search missed them. Procedures often appear under headings with sparse repetition
  // of the exact query terms.
  const indexData = await loadPdfIndex(filename);
  for (const chunk of indexData.chunks || []) {
    const page = Number(chunk.page);
    const nearSection = sectionContext.nearPages && sectionContext.nearPages.has(page);
    const nearRegister = registerContext && registerContext.pages && registerContext.pages.has(page);
    const directRegisterChunk = registerContext && registerContext.chunkIds && registerContext.chunkIds.has(chunk.id);
    if (nearSection || nearRegister || directRegisterChunk) {
      candidateMap.set(chunk.id, candidateMap.get(chunk.id) || chunk);
    }
  }

  const results = [...candidateMap.values()]
    .map((chunk) => ({
      ...chunk,
      score: scoreSequenceChunk(chunk, rawTopic, rawRegister, registerContext, sectionContext),
      sequenceEvidence: extractSequenceEvidenceLines(chunk.text || "", rawTopic, rawRegister, MAX_SEQUENCE_EVIDENCE_LINES),
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, topK);

  return {
    filename,
    topic: rawTopic,
    register: rawRegister,
    queries,
    registerResults,
    sectionResults,
    results,
  };
}

function formatSequenceResults(sequenceResult) {
  const filename = sequenceResult.filename;
  const topic = sequenceResult.topic;
  const register = sequenceResult.register;
  const results = sequenceResult.results || [];
  const registerResults = sequenceResult.registerResults || [];
  const sectionResults = sequenceResult.sectionResults || [];

  if (!results.length) {
    return [
      register
        ? `No sequence results found for "${topic}" in register context "${register}".`
        : `No sequence results found for "${topic}".`,
      "",
      "Suggested next steps:",
      `- Try find_section(filename="${filename}", section="${topic} operation").`,
      `- Try search_pdf(filename="${filename}", query="${topic} procedure sequence operation caution").`,
      register
        ? `- Try summarize_register(filename="${filename}", register="${register}").`
        : `- Try passing a related register, for example find_sequence(filename="${filename}", topic="${topic}", register="DMACm_CHCTRL_n").`,
    ].join("\n");
  }

  const header = [
    register
      ? `Sequence results for "${topic}" within register context "${register}"`
      : `Sequence results for "${topic}"`,
    `File: ${filename}`,
  ];

  if (register) {
    header.push(
      registerResults.length
        ? `Register context matches: ${registerResults.slice(0, 5).map((entry) => entry.displayName || entry.name).join(", ")}`
        : "Register context matches: none; used generic sequence search fallback."
    );
  }

  header.push(
    sectionResults.length
      ? `Relevant sections: ${sectionResults.slice(0, 5).map((section) => `${section.title} (page ${section.page})`).join(" | ")}`
      : "Relevant sections: none from section index."
  );

  const queryLine = sequenceResult.queries && sequenceResult.queries.length
    ? `Expanded queries: ${sequenceResult.queries.slice(0, 12).join(" | ")}`
    : "Expanded queries: none";

  return [
    ...header,
    queryLine,
    "",
    ...results.map((result, index) => {
      const preview = normalizeText(result.text || "").slice(0, MAX_PREVIEW_CHARS);
      const truncated = (result.text || "").length > MAX_PREVIEW_CHARS ? "..." : "";
      const evidence = (result.sequenceEvidence || []).length
        ? result.sequenceEvidence.map((line) => `   - ${line}`).join("\n")
        : "   - none";
      const endPage = Math.min(Number(result.page) + DEFAULT_PAGE_RANGE - 1, result.pageCount || Number(result.page) + DEFAULT_PAGE_RANGE - 1);

      return [
        `Result ${index + 1}`,
        `ID: ${result.id}`,
        `File: ${result.filename}`,
        `Page: ${result.page}`,
        `Chunk: ${result.chunkIndex}`,
        `Score: ${result.score}`,
        `Headings: ${(result.headings || []).join(" | ") || "none"}`,
        `Registers: ${(result.registers || []).join(", ") || "none"}`,
        `Bit fields / symbols: ${(result.bitFields || []).slice(0, 40).join(", ") || "none"}`,
        "Sequence evidence lines:",
        evidence,
        `Suggested chunk read: read_pdf_chunk(filename="${result.filename}", chunk_id="${result.id}")`,
        `Suggested page read: read_pdf_pages(filename="${result.filename}", start_page=${result.page}, end_page=${endPage})`,
        "Driver-review hint: verify the exact order of register writes and any before/after/caution conditions from the suggested page read.",
        "Preview:",
        `${preview}${truncated}`,
      ].join("\n");
    }),
  ].join("\n\n---\n\n");
}



function clampSequenceListTopK(value) {
  return clampInteger(value, DEFAULT_SEQUENCE_LIST_TOP_K, 1, MAX_SEQUENCE_LIST_TOP_K);
}

function normalizeSequenceTopic(topic) {
  return String(topic || "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalSequenceId(filename, topic) {
  const normalized = normalizeForSearch(topic).replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return `${filename}:seq:${normalized || "unknown"}`;
}

function defaultSequenceTopicsForModule(filename, sectionsIndex = null, registersIndex = null) {
  const topics = new Set([
    "initialization",
    "initial setting procedure",
    "start operation",
    "start transfer",
    "enable channel",
    "stop operation",
    "stop transfer",
    "disable channel",
    "suspend operation",
    "clear status flag",
    "clear interrupt status",
    "interrupt handling",
    "error handling",
    "software reset",
    "reset operation",
    "clock setting",
    "reset release",
  ]);

  const filenameText = normalizeForSearch(filename);
  if (/dma|dmac/.test(filenameText)) {
    [
      "dma transfer start",
      "dma transfer stop",
      "channel enable",
      "channel disable",
      "transfer end clear",
      "transfer complete interrupt",
      "dma error handling",
      "dma request setting",
    ].forEach((topic) => topics.add(topic));
  }
  if (/wdt|watchdog/.test(filenameText)) {
    ["watchdog start", "watchdog refresh", "watchdog reset", "timeout setting", "counter clear"].forEach((topic) => topics.add(topic));
  }
  if (/gpt|timer|pwm/.test(filenameText)) {
    ["counter start", "counter stop", "clear interrupt status", "pwm output setting", "input capture"].forEach((topic) => topics.add(topic));
  }

  for (const section of (sectionsIndex && sectionsIndex.sections) || []) {
    const title = String(section.title || "").trim();
    if (!title) continue;
    if (/\b(operation|procedure|sequence|setting|settings|initial|start|stop|clear|reset|interrupt|error|transfer|request|enable|disable|suspend)\b/i.test(title)) {
      topics.add(title.replace(/^\d+(?:\.\d+)*\s+/, "").slice(0, 160));
    }
  }

  for (const register of (registersIndex && registersIndex.registers || []).slice(0, 24)) {
    const name = register.displayName || register.name;
    if (!name) continue;
    if (/CTRL|CTL|CR|STAT|SR|INT|ERR|SUS|EN|END|TC|RESET|RST/i.test(name)) {
      topics.add(`${name} operation`);
      topics.add(`${name} clear status`);
    }
  }

  return [...topics].filter(Boolean).slice(0, DEFAULT_SEQUENCE_INDEX_TOPICS);
}

function sequenceTopicKind(topic) {
  const kinds = classifySequenceTopic(topic).filter((kind) => kind !== "generic");
  return kinds.length ? kinds.join(",") : "generic";
}

function inferSequenceRelatedRegisters(chunks, registersIndex, maxRegisters = 12) {
  const scores = new Map();
  const registerEntries = (registersIndex && registersIndex.registers) || [];

  for (const chunk of chunks || []) {
    const canonicalText = canonicalSymbol([chunk.text || "", ...(chunk.registers || []), ...(chunk.headings || [])].join("\n"));
    for (const entry of registerEntries) {
      const names = new Set([entry.name, entry.displayName, ...(entry.aliases || [])].map(normalizeRegisterName).filter(Boolean));
      let matched = false;
      for (const name of names) {
        if (name && canonicalText.includes(name)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      const key = entry.displayName || entry.name;
      scores.set(key, (scores.get(key) || 0) + Number(chunk.score || 1));
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxRegisters)
    .map(([name]) => name);
}

function sequenceConfidenceFromScore(score) {
  const n = Number(score || 0);
  if (n >= 220) return "high";
  if (n >= 120) return "medium";
  return "low";
}

async function buildSequencesIndex(filename, indexData = null, sectionsIndex = null, registersIndex = null) {
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const source = await getPdfSourceInfo(filename);
  const actualIndexData = indexData || await loadPdfIndex(filename);
  const actualSectionsIndex = sectionsIndex || await getSectionsIndex(filename);
  const actualRegistersIndex = registersIndex || await getRegistersIndex(filename);
  const topics = defaultSequenceTopicsForModule(filename, actualSectionsIndex, actualRegistersIndex);
  const sequences = [];

  for (const topic of topics) {
    const sectionMatches = (actualSectionsIndex.sections || [])
      .map((section) => ({ ...section, score: scoreSimpleText(section.title || "", topic) }))
      .filter((section) => section.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    const sectionContext = collectSectionContext(sectionMatches);

    const scoredChunks = (actualIndexData.chunks || [])
      .map((chunk) => ({
        ...chunk,
        score: scoreSequenceChunk(chunk, topic, "", null, sectionContext),
        sequenceEvidence: extractSequenceEvidenceLines(chunk.text || "", topic, "", MAX_SEQUENCE_EVIDENCE_LINES),
      }))
      .filter((chunk) => chunk.score >= 55 && (chunk.sequenceEvidence || []).length > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.page !== b.page) return a.page - b.page;
        return a.chunkIndex - b.chunkIndex;
      })
      .slice(0, MAX_SEQUENCE_INDEX_RESULTS_PER_TOPIC);

    if (!scoredChunks.length) continue;

    const pages = [...new Set(scoredChunks.map((chunk) => Number(chunk.page)).filter(Number.isFinite))].sort((a, b) => a - b);
    const evidenceLines = [];
    for (const chunk of scoredChunks) {
      for (const line of chunk.sequenceEvidence || []) {
        if (!evidenceLines.includes(line)) evidenceLines.push(line);
        if (evidenceLines.length >= MAX_SEQUENCE_EVIDENCE_LINES) break;
      }
      if (evidenceLines.length >= MAX_SEQUENCE_EVIDENCE_LINES) break;
    }

    const topScore = Math.max(...scoredChunks.map((chunk) => Number(chunk.score || 0)));
    sequences.push({
      id: canonicalSequenceId(filename, topic),
      filename,
      topic: normalizeSequenceTopic(topic),
      kind: sequenceTopicKind(topic),
      pages,
      relatedRegisters: inferSequenceRelatedRegisters(scoredChunks, actualRegistersIndex),
      relatedSections: sectionMatches.slice(0, 5).map((section) => ({
        title: section.title,
        page: section.page,
        score: section.score,
      })),
      chunks: scoredChunks.map((chunk) => ({
        id: chunk.id,
        page: chunk.page,
        chunkIndex: chunk.chunkIndex,
        score: chunk.score,
        headings: chunk.headings || [],
        registers: chunk.registers || [],
        evidenceLines: chunk.sequenceEvidence || [],
        preview: normalizeText(chunk.text || "").slice(0, 700),
      })),
      evidenceLines,
      confidence: sequenceConfidenceFromScore(topScore),
      score: Math.round(topScore),
      source: "sequence-index-heuristic",
    });
  }

  const dedup = new Map();
  for (const sequence of sequences) {
    const key = normalizeForSearch(sequence.topic);
    const previous = dedup.get(key);
    if (!previous || sequence.score > previous.score) dedup.set(key, sequence);
  }

  const finalSequences = [...dedup.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.topic).localeCompare(String(b.topic));
  });

  const index = {
    schemaVersion: SEQUENCE_INDEX_SCHEMA_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    sequenceCount: finalSequences.length,
    sequences: finalSequences,
  };

  const sequencesPath = safeSequencesIndexPath(filename);
  await atomicWriteJson(sequencesPath, index);
  return index;
}

async function loadSequencesIndex(filename) {
  const sequencesPath = safeSequencesIndexPath(filename);
  if (!(await pathExists(sequencesPath))) return null;

  try {
    const raw = await fs.readFile(sequencesPath, "utf-8");
    const index = JSON.parse(raw);
    if (index.schemaVersion !== SEQUENCE_INDEX_SCHEMA_VERSION) return null;
    if (index.filename !== filename) return null;
    if (!Array.isArray(index.sequences)) return null;
    const currentSource = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(index.source, currentSource)) return null;
    return index;
  } catch {
    return null;
  }
}

async function getSequencesIndex(filename, options = {}) {
  const existing = await loadSequencesIndex(filename);
  if (existing) return existing;

  if (options.buildIfMissing === true) {
    const indexData = await loadPdfIndex(filename, { buildIfMissing: true });
    const sectionsIndex = await getSectionsIndex(filename, { buildIfMissing: true });
    const registersIndex = await getRegistersIndex(filename, { buildIfMissing: true });
    return await buildSequencesIndex(filename, indexData, sectionsIndex, registersIndex);
  }

  throw new Error(`Sequences index not found for ${filename}. Run index_pdf or start_index_pdf first.`);
}

function scoreSimpleText(text, query) {
  const haystack = normalizeForSearch(text);
  const needle = normalizeForSearch(query);
  if (!haystack || !needle) return 0;
  let score = 0;
  if (haystack.includes(needle)) score += 80;
  for (const term of needle.split(/\s+/).filter((part) => part.length > 1)) {
    if (countWordOccurrences(haystack, term)) score += 12;
    else if (haystack.includes(term)) score += 4;
  }
  return score;
}

function scoreSequenceEntry(sequence, topic, register = "") {
  const q = normalizeForSearch(topic);
  const r = normalizeRegisterName(register);
  const searchText = normalizeForSearch([
    sequence.topic,
    sequence.kind,
    ...(sequence.relatedRegisters || []),
    ...(sequence.evidenceLines || []),
    ...((sequence.relatedSections || []).map((section) => section.title || "")),
  ].join("\n"));
  const canonical = canonicalSymbol([
    ...(sequence.relatedRegisters || []),
    sequence.topic,
  ].join("\n"));

  let score = scoreSimpleText(searchText, q) + Math.round(Number(sequence.score || 0) / 6);
  if (r && canonical.includes(r)) score += 80;
  return score;
}

async function listSequencesFromIndex(filename, options = {}) {
  const sequencesIndex = await getSequencesIndex(filename);
  const filter = String(options.filter || "").trim();
  const topK = clampSequenceListTopK(options.topK);
  const filterText = normalizeForSearch(filter);

  let results = sequencesIndex.sequences || [];
  if (filterText) {
    results = results
      .map((sequence) => ({ ...sequence, filterScore: scoreSequenceEntry(sequence, filter) }))
      .filter((sequence) => sequence.filterScore > 0)
      .sort((a, b) => {
        if (b.filterScore !== a.filterScore) return b.filterScore - a.filterScore;
        return b.score - a.score;
      });
  } else {
    results = [...results].sort((a, b) => b.score - a.score);
  }

  return {
    sequencesIndex,
    results: results.slice(0, topK),
  };
}

function formatSequenceListResults(sequencesIndex, results, filter = "") {
  const lines = [
    filter
      ? `Detected operation-flow/sequence candidates matching "${filter}" in ${sequencesIndex.filename}`
      : `Detected operation-flow/sequence candidates in ${sequencesIndex.filename}`,
    `Sequences index created: ${sequencesIndex.createdAt}`,
    `Total sequences indexed: ${sequencesIndex.sequenceCount || (sequencesIndex.sequences || []).length}`,
    `Showing: ${results.length}`,
    "",
  ];

  if (!results.length) {
    lines.push("No sequence candidates found. Try find_sequence with a concrete topic such as start transfer, clear interrupt, reset, or initialization.");
    return lines.join("\n");
  }

  results.forEach((sequence, index) => {
    const pages = (sequence.pages || []).join(", ") || "unknown";
    const registers = (sequence.relatedRegisters || []).slice(0, 10).join(", ") || "none";
    const evidence = (sequence.evidenceLines || []).slice(0, 2).map((line) => `      - ${line}`).join("\n") || "      - none";
    lines.push(
      [
        `${index + 1}. ${sequence.topic}`,
        `   Kind: ${sequence.kind || "generic"}`,
        `   Pages: ${pages}`,
        `   Related registers: ${registers}`,
        `   Confidence: ${sequence.confidence || "unknown"}`,
        `   Score: ${sequence.score}`,
        `   Evidence:`,
        evidence,
        `   Suggested get: get_sequence(filename="${sequencesIndex.filename}", topic="${sequence.topic}")`,
      ].join("\n")
    );
  });

  return lines.join("\n\n");
}

async function getSequenceFromIndex(filename, topic, options = {}) {
  const sequencesIndex = await getSequencesIndex(filename);
  const register = String(options.register || "").trim();
  const topK = clampSequenceTopK(options.topK);
  const scored = (sequencesIndex.sequences || [])
    .map((sequence) => ({ ...sequence, matchScore: scoreSequenceEntry(sequence, topic, register) }))
    .filter((sequence) => sequence.matchScore > 0)
    .sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return b.score - a.score;
    });

  if (!scored.length || scored[0].matchScore < 35) {
    const fallback = await findSequenceInIndex(filename, topic, { register, topK });
    return { sequencesIndex, topic, register, persistentMatches: [], fallback };
  }

  return {
    sequencesIndex,
    topic,
    register,
    persistentMatches: scored.slice(0, Math.min(topK, 5)),
    fallback: null,
  };
}

function formatPersistentSequenceResult(result) {
  if (result.fallback) {
    return [
      `No strong persistent sequence-index match for "${result.topic}". Falling back to dynamic sequence search.`,
      "",
      formatSequenceResults(result.fallback),
    ].join("\n");
  }

  const filename = result.sequencesIndex.filename;
  const lines = [
    result.register
      ? `Persistent sequence result for "${result.topic}" within register context "${result.register}"`
      : `Persistent sequence result for "${result.topic}"`,
    `File: ${filename}`,
    `Sequences index created: ${result.sequencesIndex.createdAt}`,
    "",
  ];

  for (const [index, sequence] of (result.persistentMatches || []).entries()) {
    const pages = (sequence.pages || []).join(", ") || "unknown";
    const registers = (sequence.relatedRegisters || []).slice(0, 12).join(", ") || "none";
    const sections = (sequence.relatedSections || []).slice(0, 5).map((section) => `${section.title} (page ${section.page})`).join(" | ") || "none";
    const evidence = (sequence.evidenceLines || []).map((line) => `   - ${line}`).join("\n") || "   - none";
    const chunks = (sequence.chunks || []).slice(0, topSafe(5, sequence.chunks.length)).map((chunk) => {
      const endPage = Number(chunk.page) + DEFAULT_PAGE_RANGE - 1;
      return [
        `   Chunk: ${chunk.id}`,
        `   Page: ${chunk.page}`,
        `   Score: ${chunk.score}`,
        `   Suggested chunk read: read_pdf_chunk(filename="${filename}", chunk_id="${chunk.id}")`,
        `   Suggested page read: read_pdf_pages(filename="${filename}", start_page=${chunk.page}, end_page=${endPage})`,
      ].join("\n");
    }).join("\n");

    lines.push([
      `Match ${index + 1}`,
      `Topic: ${sequence.topic}`,
      `Kind: ${sequence.kind || "generic"}`,
      `Pages: ${pages}`,
      `Related registers: ${registers}`,
      `Related sections: ${sections}`,
      `Confidence: ${sequence.confidence || "unknown"}`,
      `Score: ${sequence.score}`,
      `Match score: ${sequence.matchScore}`,
      "Evidence lines:",
      evidence,
      "Related chunks:",
      chunks || "   - none",
      "Driver-review hint: verify the exact order of register writes and any before/after/caution condition before implementing the sequence in Linux driver code.",
    ].join("\n"));
  }

  return lines.join("\n\n---\n\n");
}

function topSafe(max, length) {
  const n = Number(length || 0);
  return Math.max(0, Math.min(max, n));
}


function clampCautionTopK(value) {
  const n = Number(value || DEFAULT_CAUTION_TOP_K);
  if (!Number.isFinite(n)) return DEFAULT_CAUTION_TOP_K;
  return Math.max(1, Math.min(MAX_CAUTION_TOP_K, Math.floor(n)));
}

function clampDriverPackRegisters(value) {
  return clampInteger(value, DEFAULT_DRIVER_PACK_REGISTERS, 1, MAX_DRIVER_PACK_REGISTERS);
}

function clampDriverPackSummaries(value) {
  return clampInteger(value, DEFAULT_DRIVER_PACK_SUMMARIES, 1, MAX_DRIVER_PACK_SUMMARIES);
}

function clampDriverTaskRegisters(value) {
  return clampInteger(value, DEFAULT_DRIVER_TASK_REGISTERS, 1, MAX_DRIVER_TASK_REGISTERS);
}

function buildCautionQueries(topic, register = "") {
  const rawTopic = String(topic || "").trim();
  const rawRegister = String(register || "").trim();
  const combined = `${rawRegister} ${rawTopic}`.trim();
  const normalized = normalizeForSearch(`${rawTopic} ${rawRegister}`);
  const queries = new Set();

  if (rawTopic) queries.add(rawTopic);
  if (combined) queries.add(combined);

  queries.add(`${combined || rawTopic} caution`);
  queries.add(`${combined || rawTopic} note`);
  queries.add(`${combined || rawTopic} restriction`);
  queries.add(`${combined || rawTopic} prohibited`);
  queries.add(`${combined || rawTopic} undefined`);
  queries.add(`${combined || rawTopic} reserved`);
  queries.add(`${combined || rawTopic} must`);

  if (/clear|flag|status|interrupt|end|error/.test(normalized)) {
    queries.add(`${combined || rawTopic} clear status flag`);
    queries.add(`${combined || rawTopic} write 1 to clear`);
    queries.add(`${combined || rawTopic} write one to clear`);
    queries.add(`${combined || rawTopic} write 0 to clear`);
    queries.add(`${combined || rawTopic} write zero to clear`);
    queries.add(`${combined || rawTopic} cleared by writing`);
  }

  if (/reserved|bit|bits/.test(normalized)) {
    queries.add(`${combined || rawTopic} reserved bits`);
    queries.add(`${combined || rawTopic} read value undefined`);
    queries.add(`${combined || rawTopic} write value undefined`);
    queries.add(`${combined || rawTopic} must be written as 0`);
    queries.add(`${combined || rawTopic} must be written as 1`);
  }

  if (/stop|stopped|running|start|enable|disable|write|setting|set/.test(normalized)) {
    queries.add(`${combined || rawTopic} write only when stopped`);
    queries.add(`${combined || rawTopic} set only when stopped`);
    queries.add(`${combined || rawTopic} while stopped`);
    queries.add(`${combined || rawTopic} while operating`);
    queries.add(`${combined || rawTopic} before setting`);
    queries.add(`${combined || rawTopic} after setting`);
    queries.add(`${combined || rawTopic} cannot be changed`);
  }

  if (/reset|clock|module|software/.test(normalized)) {
    queries.add(`${combined || rawTopic} reset caution`);
    queries.add(`${combined || rawTopic} clock note`);
    queries.add(`${combined || rawTopic} module stop`);
  }

  return [...queries]
    .map((query) => query.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function cautionKeywordSet(topic, register = "") {
  const normalized = normalizeForSearch(`${topic} ${register}`);
  const words = normalized.split(/\s+/).filter((word) => word.length > 1);
  const keywords = new Set(words);

  const cautionWords = [
    "caution", "note", "notes", "restriction", "restrictions",
    "prohibit", "prohibited", "undefined", "invalid", "reserved",
    "must", "should", "only", "cannot", "do", "not", "before", "after",
    "when", "while", "until", "except", "write", "read", "clear", "cleared",
    "set", "reset", "stop", "stopped", "start", "enable", "disable",
    "interrupt", "status", "flag", "error", "end", "zero", "one", "0", "1",
  ];

  for (const word of cautionWords) keywords.add(word);
  return keywords;
}

function classifyCautionLine(line) {
  const labels = [];
  const text = String(line || "");

  if (/\b(Caution|CAUTION)\b/.test(text)) labels.push("caution");
  if (/\b(Note|Notes|NOTE|NOTES)\b/.test(text)) labels.push("note");
  if (/\b(Restriction|Restrictions|restricted)\b/i.test(text)) labels.push("restriction");
  if (/\b(prohibit|prohibited|do\s+not|must\s+not|cannot|can't)\b/i.test(text)) labels.push("prohibited/forbidden");
  if (/\b(undefined|invalid|indeterminate|unpredictable)\b/i.test(text)) labels.push("undefined/invalid");
  if (/\breserved\b/i.test(text)) labels.push("reserved-bit handling");
  if (/\b(write|written|writing)\b/i.test(text) && /\b(clear|cleared)\b/i.test(text)) labels.push("clear semantics");
  if (/\b(write|written|writing)\b/i.test(text) && /\b(0|zero|1|one)\b/i.test(text) && /\b(clear|cleared|set|reserved)\b/i.test(text)) labels.push("write value semantics");
  if (/\b(only|when|while|before|after|until)\b/i.test(text) && /\b(stop|stopped|start|running|operation|operating|enable|disable|setting|set|write)\b/i.test(text)) labels.push("operation-order condition");
  if (/\b(initial value|reset value|read as|write as|must be written)\b/i.test(text)) labels.push("reset/read-write constraint");

  return [...new Set(labels)];
}

function extractCautionEvidenceLines(text, topic, register = "", maxLines = MAX_CAUTION_EVIDENCE_LINES) {
  const keywords = cautionKeywordSet(topic, register);
  const topicTerms = normalizeForSearch(topic).split(/\s+/).filter((word) => word.length > 1);
  const registerCanonical = normalizeRegisterName(register);
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const scored = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const normalizedLine = normalizeForSearch(line);
    const canonicalLine = canonicalSymbol(line);
    const labels = classifyCautionLine(line);
    let score = 0;

    for (const term of topicTerms) {
      if (term && normalizedLine.includes(term)) score += 14;
    }

    for (const word of keywords) {
      if (word && normalizedLine.includes(word)) score += 2;
    }

    if (registerCanonical && canonicalLine.includes(registerCanonical)) score += 24;
    if (labels.length) score += labels.length * 18;
    if (/\b(Caution|Note|Notes|Restriction|Restrictions)\b/i.test(line)) score += 28;
    if (/\b(reserved|undefined|invalid|prohibited|do\s+not|must\s+not|cannot)\b/i.test(line)) score += 24;
    if (/\b(write|written|writing)\b/i.test(line) && /\b(0|zero|1|one)\b/i.test(line)) score += 18;
    if (/\b(clear|cleared|status|flag|interrupt|error|end)\b/i.test(line)) score += 12;
    if (/\b(only|when|while|before|after|until)\b/i.test(line)) score += 14;

    if (score <= 0) continue;

    const prev = index > 0 ? lines[index - 1] : "";
    const next = index + 1 < lines.length ? lines[index + 1] : "";
    const context = [prev, line, next].filter(Boolean).join(" / ").slice(0, 1000);
    const labelText = labels.length ? ` [${labels.join(", ")}]` : "";

    scored.push({
      score,
      index,
      line: `${context}${labelText}`,
      labels,
    });
  }

  return scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .slice(0, maxLines)
    .map((entry) => entry.line);
}

function scoreCautionChunk(chunk, topic, register = "", registerContext = null, sectionContext = null) {
  const textRaw = String(chunk.text || "");
  const text = normalizeForSearch(textRaw);
  const canonicalText = canonicalSymbol(textRaw);
  const topicTerms = normalizeForSearch(topic).split(/\s+/).filter((word) => word.length > 1);
  const registerCanonical = normalizeRegisterName(register);
  const metadata = normalizeForSearch([
    ...(chunk.headings || []),
    ...(chunk.registers || []),
    ...(chunk.bitFields || []),
  ].join("\n"));

  let score = 0;

  for (const term of topicTerms) {
    if (term && text.includes(term)) score += 10;
    if (term && metadata.includes(term)) score += 8;
  }

  if (registerCanonical && canonicalText.includes(registerCanonical)) score += 35;
  if (registerCanonical && metadata.includes(normalizeForSearch(register))) score += 20;

  if (registerContext) {
    if (registerContext.chunkIds && registerContext.chunkIds.has(chunk.id)) score += 55;
    if (registerContext.pages && registerContext.pages.has(Number(chunk.page))) score += 28;
    if (registerContext.nearPages && registerContext.nearPages.has(Number(chunk.page))) score += 14;
  }

  if (sectionContext) {
    if (sectionContext.pages && sectionContext.pages.has(Number(chunk.page))) score += 22;
    if (sectionContext.nearPages && sectionContext.nearPages.has(Number(chunk.page))) score += 12;
  }

  if (/\b(Caution|CAUTION)\b/.test(textRaw)) score += 60;
  if (/\b(Note|Notes|NOTE|NOTES)\b/.test(textRaw)) score += 32;
  if (/\b(Restriction|Restrictions)\b/i.test(textRaw)) score += 45;
  if (/\b(prohibit|prohibited|do\s+not|must\s+not|cannot|can't)\b/i.test(textRaw)) score += 40;
  if (/\b(undefined|invalid|indeterminate|unpredictable)\b/i.test(textRaw)) score += 38;
  if (/\breserved\b/i.test(textRaw)) score += 35;
  if (/\b(write|written|writing)\b/i.test(textRaw) && /\b(clear|cleared)\b/i.test(textRaw)) score += 35;
  if (/\b(write|written|writing)\b/i.test(textRaw) && /\b(0|zero|1|one)\b/i.test(textRaw)) score += 28;
  if (/\b(only|when|while|before|after|until)\b/i.test(textRaw) && /\b(stop|stopped|running|operation|enable|disable|setting|set|write)\b/i.test(textRaw)) score += 30;

  const evidence = extractCautionEvidenceLines(textRaw, topic, register, 4);
  score += evidence.length * 16;

  return score;
}

async function findCautionInIndex(filename, topic, options = {}) {
  const rawTopic = String(topic || "").trim();
  const rawRegister = String(options.register || "").trim();
  const topK = clampCautionTopK(options.topK);
  const searchTopK = Math.max(topK * 4, 30);
  const queries = buildCautionQueries(rawTopic, rawRegister);
  const candidateMap = new Map();
  let registerResults = [];
  let registerContext = null;

  if (!rawTopic) throw new Error("topic is required");

  if (rawRegister) {
    const registerSearch = await searchRegistersIndex(filename, rawRegister, Math.min(8, topK));
    registerResults = registerSearch.results;
    registerContext = collectRegisterContext(registerResults);
  }

  const sectionQueries = [
    rawTopic,
    `${rawTopic} caution`,
    `${rawTopic} note`,
    `${rawTopic} restriction`,
    `${rawTopic} usage notes`,
    `${rawTopic} operation`,
  ];

  const sectionResultsById = new Map();
  for (const query of sectionQueries) {
    const { results } = await searchSectionsIndex(filename, query, Math.min(8, topK));
    for (const result of results) sectionResultsById.set(result.id, result);
  }

  const sectionResults = [...sectionResultsById.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.page - b.page;
    })
    .slice(0, 8);
  const sectionContext = collectSectionContext(sectionResults);

  for (const query of queries) {
    const { results } = await searchPdfIndex(filename, query, searchTopK);
    for (const result of results) {
      candidateMap.set(result.id, candidateMap.get(result.id) || result);
    }
  }

  const indexData = await loadPdfIndex(filename);
  for (const chunk of indexData.chunks || []) {
    const page = Number(chunk.page);
    const nearSection = sectionContext.nearPages && sectionContext.nearPages.has(page);
    const nearRegister = registerContext && registerContext.pages && registerContext.pages.has(page);
    const directRegisterChunk = registerContext && registerContext.chunkIds && registerContext.chunkIds.has(chunk.id);
    const textRaw = String(chunk.text || "");
    const hasStrongCautionTerm = /\b(Caution|Note|Notes|Restriction|Restrictions|reserved|undefined|invalid|prohibited|do\s+not|must\s+not|cannot|write\s+(?:0|1|zero|one)|cleared?\s+by\s+writing)\b/i.test(textRaw);

    if (nearSection || nearRegister || directRegisterChunk || hasStrongCautionTerm) {
      candidateMap.set(chunk.id, candidateMap.get(chunk.id) || chunk);
    }
  }

  const results = [...candidateMap.values()]
    .map((chunk) => ({
      ...chunk,
      score: scoreCautionChunk(chunk, rawTopic, rawRegister, registerContext, sectionContext),
      cautionEvidence: extractCautionEvidenceLines(chunk.text || "", rawTopic, rawRegister, MAX_CAUTION_EVIDENCE_LINES),
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, topK);

  return {
    filename,
    topic: rawTopic,
    register: rawRegister,
    queries,
    registerResults,
    sectionResults,
    results,
  };
}

function formatCautionResults(cautionResult) {
  const filename = cautionResult.filename;
  const topic = cautionResult.topic;
  const register = cautionResult.register;
  const results = cautionResult.results || [];
  const registerResults = cautionResult.registerResults || [];
  const sectionResults = cautionResult.sectionResults || [];

  if (!results.length) {
    return [
      register
        ? `No caution/note/restriction results found for "${topic}" in register context "${register}".`
        : `No caution/note/restriction results found for "${topic}".`,
      "",
      "Suggested next steps:",
      `- Try find_section(filename="${filename}", section="Usage Notes").`,
      `- Try search_pdf(filename="${filename}", query="${topic} caution note restriction reserved undefined prohibited").`,
      register
        ? `- Try summarize_register(filename="${filename}", register="${register}").`
        : `- Try passing a related register, for example find_caution(filename="${filename}", topic="write only when stopped", register="DMACm_CHCTRL_n").`,
    ].join("\n");
  }

  const header = [
    register
      ? `Caution results for "${topic}" within register context "${register}"`
      : `Caution results for "${topic}"`,
    `File: ${filename}`,
  ];

  if (register) {
    header.push(
      registerResults.length
        ? `Register context matches: ${registerResults.slice(0, 5).map((entry) => entry.displayName || entry.name).join(", ")}`
        : "Register context matches: none; used generic caution search fallback."
    );
  }

  header.push(
    sectionResults.length
      ? `Relevant sections: ${sectionResults.slice(0, 5).map((section) => `${section.title} (page ${section.page})`).join(" | ")}`
      : "Relevant sections: none from section index."
  );

  const queryLine = cautionResult.queries && cautionResult.queries.length
    ? `Expanded queries: ${cautionResult.queries.slice(0, 14).join(" | ")}`
    : "Expanded queries: none";

  return [
    ...header,
    queryLine,
    "",
    ...results.map((result, index) => {
      const preview = normalizeText(result.text || "").slice(0, MAX_PREVIEW_CHARS);
      const truncated = (result.text || "").length > MAX_PREVIEW_CHARS ? "..." : "";
      const evidence = (result.cautionEvidence || []).length
        ? result.cautionEvidence.map((line) => `   - ${line}`).join("\n")
        : "   - none";
      const endPage = Math.max(Number(result.page), Number(result.page) + DEFAULT_PAGE_RANGE - 1);

      return [
        `Result ${index + 1}`,
        `ID: ${result.id}`,
        `File: ${result.filename}`,
        `Page: ${result.page}`,
        `Chunk: ${result.chunkIndex}`,
        `Score: ${result.score}`,
        `Headings: ${(result.headings || []).join(" | ") || "none"}`,
        `Registers: ${(result.registers || []).join(", ") || "none"}`,
        `Bit fields / symbols: ${(result.bitFields || []).slice(0, 40).join(", ") || "none"}`,
        "Caution / restriction evidence lines:",
        evidence,
        `Suggested chunk read: read_pdf_chunk(filename="${result.filename}", chunk_id="${result.id}")`,
        `Suggested page read: read_pdf_pages(filename="${result.filename}", start_page=${result.page}, end_page=${endPage})`,
        "Driver-review hint: verify reserved-bit handling, allowed write timing, and clear-flag semantics before approving register writes in the driver.",
        "Preview:",
        `${preview}${truncated}`,
      ].join("\n");
    }),
  ].join("\n\n---\n\n");
}


// -----------------------------------------------------------------------------
// Persistent caution / restriction index
// -----------------------------------------------------------------------------

function clampCautionListTopK(value) {
  return clampInteger(value, DEFAULT_CAUTION_LIST_TOP_K, 1, MAX_CAUTION_LIST_TOP_K);
}

function defaultCautionTopicsForModule(filename, sectionsIndex = null, registersIndex = null) {
  const topics = new Set([
    "caution",
    "note",
    "usage notes",
    "restriction",
    "reserved bits",
    "reserved bit handling",
    "write only when stopped",
    "write while running",
    "do not write",
    "prohibited",
    "undefined",
    "invalid setting",
    "write 1 to clear",
    "write 0 to clear",
    "clear status flag",
    "clear interrupt status",
    "read modify write",
    "initial value",
    "reset value",
    "write protection",
    "software reset restriction",
    "interrupt status clear",
    "error status clear",
  ]);

  const filenameText = normalizeForSearch(filename);
  if (/dma|dmac/.test(filenameText)) {
    [
      "dma channel enable restriction",
      "dma channel disable restriction",
      "transfer end clear",
      "dma error clear",
      "channel status clear",
      "transfer request restriction",
      "descriptor address restriction",
    ].forEach((topic) => topics.add(topic));
  }
  if (/wdt|watchdog/.test(filenameText)) {
    ["watchdog refresh restriction", "watchdog write sequence", "watchdog reset condition", "timeout setting caution"].forEach((topic) => topics.add(topic));
  }
  if (/gpt|timer|pwm/.test(filenameText)) {
    ["counter stopped before write", "compare register write restriction", "clear interrupt flag", "reserved bit handling"].forEach((topic) => topics.add(topic));
  }

  for (const section of (sectionsIndex && sectionsIndex.sections) || []) {
    const title = String(section.title || "").trim();
    if (!title) continue;
    if (/\b(caution|note|notes|restriction|usage notes|prohibit|reserved|undefined|invalid|clear|write|reset|interrupt|error)\b/i.test(title)) {
      topics.add(title.replace(/^\d+(?:\.\d+)*\s+/, "").slice(0, 180));
    }
  }

  for (const register of ((registersIndex && registersIndex.registers) || []).slice(0, 36)) {
    const name = register.displayName || register.name;
    if (!name) continue;
    if (/CTRL|CTL|CR|STAT|SR|INT|ERR|SUS|EN|END|TC|RESET|RST|CFG/i.test(name)) {
      topics.add(`${name} caution`);
      topics.add(`${name} reserved bits`);
      topics.add(`${name} clear status`);
      topics.add(`${name} write restriction`);
    }
  }

  return [...topics].filter(Boolean).slice(0, DEFAULT_CAUTION_INDEX_TOPICS);
}

function cautionTypeFromLabels(labels = [], line = "", topic = "") {
  const text = `${labels.join(" ")} ${line} ${topic}`;
  if (/reserved/i.test(text)) return "reserved-bit";
  if (/write\s*1|write one|cleared?\s+by\s+writing\s+1|w1c/i.test(text)) return "clear-semantics-write-1";
  if (/write\s*0|write zero|cleared?\s+by\s+writing\s+0|w0c/i.test(text)) return "clear-semantics-write-0";
  if (/while|when|stopp?ed|running|operation|before|after|only/i.test(text) && /write|set|clear|enable|disable/i.test(text)) return "write-timing";
  if (/undefined|invalid/i.test(text)) return "undefined-invalid";
  if (/prohibit|prohibited|forbidden|do\s+not|must\s+not|cannot/i.test(text)) return "prohibited";
  if (/reset|initial|read|write/i.test(text)) return "reset-access";
  if (/restriction/i.test(text)) return "restriction";
  if (/caution/i.test(text)) return "caution";
  if (/note/i.test(text)) return "note";
  return "general";
}

function inferCautionRelatedRegisters(chunks, registersIndex, maxRegisters = 16) {
  const scores = new Map();
  const registerEntries = (registersIndex && registersIndex.registers) || [];

  for (const chunk of chunks || []) {
    const canonicalText = canonicalSymbol([chunk.text || "", ...(chunk.registers || []), ...(chunk.headings || [])].join("\n"));
    for (const entry of registerEntries) {
      const names = new Set([entry.name, entry.displayName, ...(entry.aliases || [])].map(normalizeRegisterName).filter(Boolean));
      let matched = false;
      for (const name of names) {
        if (name && canonicalText.includes(name)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      const key = entry.displayName || entry.name;
      scores.set(key, (scores.get(key) || 0) + Number(chunk.score || 1));
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxRegisters)
    .map(([name]) => name);
}

function cautionConfidenceFromScore(score) {
  const n = Number(score || 0);
  if (n >= 220) return "high";
  if (n >= 120) return "medium";
  return "low";
}

function canonicalCautionId(filename, topic, type) {
  const normalized = normalizeForSearch(`${type} ${topic}`).replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return `${filename}:caution:${normalized || "unknown"}`;
}

async function buildCautionsIndex(filename, indexData = null, sectionsIndex = null, registersIndex = null) {
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const source = await getPdfSourceInfo(filename);
  const actualIndexData = indexData || await loadPdfIndex(filename);
  const actualSectionsIndex = sectionsIndex || await getSectionsIndex(filename);
  const actualRegistersIndex = registersIndex || await getRegistersIndex(filename);
  const topics = defaultCautionTopicsForModule(filename, actualSectionsIndex, actualRegistersIndex);
  const cautions = [];

  for (const topic of topics) {
    const sectionMatches = (actualSectionsIndex.sections || [])
      .map((section) => ({ ...section, score: scoreSimpleText(section.title || "", topic) }))
      .filter((section) => section.score > 0 || /\b(caution|note|restriction|usage notes)\b/i.test(section.title || ""))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    const sectionContext = collectSectionContext(sectionMatches);

    const scoredChunks = (actualIndexData.chunks || [])
      .map((chunk) => ({
        ...chunk,
        score: scoreCautionChunk(chunk, topic, "", null, sectionContext),
        cautionEvidence: extractCautionEvidenceLines(chunk.text || "", topic, "", MAX_CAUTION_EVIDENCE_LINES),
      }))
      .filter((chunk) => {
        const text = buildSearchText(chunk);
        const hasCautionEvidence = (chunk.cautionEvidence || []).length > 0;
        const hasStrongTerm = /\b(Caution|CAUTION|Note|Notes|Restriction|Restrictions|reserved|undefined|invalid|prohibited|forbidden|do\s+not|must\s+not|cannot|write\s+(?:0|1|zero|one)|cleared?\s+by\s+writing|only\s+when|while\s+running|while\s+stopped)\b/i.test(text);
        return chunk.score >= 55 && (hasCautionEvidence || hasStrongTerm);
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.page !== b.page) return a.page - b.page;
        return a.chunkIndex - b.chunkIndex;
      })
      .slice(0, MAX_CAUTION_INDEX_RESULTS_PER_TOPIC);

    if (!scoredChunks.length) continue;

    const evidenceLines = [];
    const typeScores = new Map();
    for (const chunk of scoredChunks) {
      for (const line of chunk.cautionEvidence || []) {
        if (!evidenceLines.includes(line)) evidenceLines.push(line);
        const labels = classifyCautionLine(line);
        const type = cautionTypeFromLabels(labels, line, topic);
        typeScores.set(type, (typeScores.get(type) || 0) + 1);
        if (evidenceLines.length >= MAX_CAUTION_EVIDENCE_LINES) break;
      }
      if (evidenceLines.length >= MAX_CAUTION_EVIDENCE_LINES) break;
    }

    const type = [...typeScores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || cautionTypeFromLabels([], evidenceLines[0] || "", topic);
    const pages = [...new Set(scoredChunks.map((chunk) => Number(chunk.page)).filter(Number.isFinite))].sort((a, b) => a - b);
    const topScore = Math.max(...scoredChunks.map((chunk) => Number(chunk.score || 0)));
    const relatedRegisters = inferCautionRelatedRegisters(scoredChunks, actualRegistersIndex);

    cautions.push({
      id: canonicalCautionId(filename, topic, type),
      filename,
      topic: normalizeSequenceTopic(topic),
      type,
      pages,
      relatedRegisters,
      relatedSections: sectionMatches.slice(0, 5).map((section) => ({
        title: section.title,
        page: section.page,
        score: section.score,
      })),
      chunks: scoredChunks.map((chunk) => ({
        id: chunk.id,
        page: chunk.page,
        chunkIndex: chunk.chunkIndex,
        score: chunk.score,
        headings: chunk.headings || [],
        registers: chunk.registers || [],
        evidenceLines: chunk.cautionEvidence || [],
        preview: normalizeText(chunk.text || "").slice(0, 700),
      })),
      evidenceLines,
      riskForDriver: riskForCautionType(type),
      confidence: cautionConfidenceFromScore(topScore),
      score: Math.round(topScore),
      source: "caution-index-heuristic",
    });
  }

  const dedup = new Map();
  for (const caution of cautions) {
    const key = `${caution.type}:${normalizeForSearch(caution.topic)}:${(caution.relatedRegisters || []).slice(0, 3).join(",")}`;
    const previous = dedup.get(key);
    if (!previous || caution.score > previous.score) dedup.set(key, caution);
  }

  const finalCautions = [...dedup.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.topic).localeCompare(String(b.topic));
  });

  const index = {
    schemaVersion: CAUTION_INDEX_SCHEMA_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    cautionCount: finalCautions.length,
    cautions: finalCautions,
  };

  const cautionsPath = safeCautionsIndexPath(filename);
  await atomicWriteJson(cautionsPath, index);
  return index;
}

function riskForCautionType(type) {
  switch (String(type || "")) {
    case "reserved-bit":
      return "Preserve reserved bits and avoid raw writes that may change undefined/reserved fields.";
    case "clear-semantics-write-1":
      return "Verify write-1-to-clear behavior before acknowledging interrupt/status flags.";
    case "clear-semantics-write-0":
      return "Verify write-0-to-clear behavior before acknowledging interrupt/status flags.";
    case "write-timing":
      return "Verify allowed write timing such as stopped/running state before register writes.";
    case "undefined-invalid":
      return "Avoid invalid/undefined settings and mark unsupported configurations in the driver.";
    case "prohibited":
      return "Do not implement register operations that the manual marks as prohibited/forbidden.";
    case "reset-access":
      return "Verify reset/access constraints and preserve initial/reset values where required.";
    default:
      return "Review this caution before approving related register writes.";
  }
}

async function loadCautionsIndex(filename) {
  const cautionsPath = safeCautionsIndexPath(filename);
  if (!(await pathExists(cautionsPath))) return null;

  try {
    const raw = await fs.readFile(cautionsPath, "utf-8");
    const index = JSON.parse(raw);
    if (index.schemaVersion !== CAUTION_INDEX_SCHEMA_VERSION) return null;
    if (index.filename !== filename) return null;
    if (!Array.isArray(index.cautions)) return null;
    const currentSource = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(index.source, currentSource)) return null;
    return index;
  } catch {
    return null;
  }
}

async function getCautionsIndex(filename, options = {}) {
  const existing = await loadCautionsIndex(filename);
  if (existing) return existing;

  if (options.buildIfMissing === true) {
    const indexData = await loadPdfIndex(filename, { buildIfMissing: true });
    const sectionsIndex = await getSectionsIndex(filename, { buildIfMissing: true });
    const registersIndex = await getRegistersIndex(filename, { buildIfMissing: true });
    return await buildCautionsIndex(filename, indexData, sectionsIndex, registersIndex);
  }

  throw new Error(`Cautions index not found for ${filename}. Run index_pdf or start_index_pdf first.`);
}

function cautionMatchesFilter(caution, filter = "", register = "", type = "") {
  const filterText = normalizeForSearch(filter);
  const registerCanonical = normalizeRegisterName(register);
  const typeText = normalizeForSearch(type);
  const cautionType = normalizeForSearch(caution.type || "");
  const searchText = normalizeForSearch([
    caution.topic,
    caution.type,
    caution.riskForDriver,
    ...(caution.relatedRegisters || []),
    ...(caution.evidenceLines || []),
    ...((caution.relatedSections || []).map((section) => section.title || "")),
  ].join("\n"));
  const canonicalRegisters = new Set((caution.relatedRegisters || []).map(normalizeRegisterName).filter(Boolean));

  if (filterText) {
    let ok = searchText.includes(filterText);
    if (!ok) {
      ok = filterText.split(/\s+/).filter((term) => term.length > 1).some((term) => searchText.includes(term));
    }
    if (!ok) return false;
  }

  if (registerCanonical) {
    let ok = canonicalRegisters.has(registerCanonical);
    if (!ok) {
      for (const name of canonicalRegisters) {
        if (name.includes(registerCanonical) || registerCanonical.includes(name)) {
          ok = true;
          break;
        }
      }
    }
    if (!ok) return false;
  }

  if (typeText && !cautionType.includes(typeText)) return false;
  return true;
}

async function listCautionsFromIndex(filename, options = {}) {
  const cautionsIndex = await getCautionsIndex(filename);
  const topK = clampCautionListTopK(options.topK);
  const filter = String(options.filter || "").trim();
  const register = String(options.register || "").trim();
  const type = String(options.type || "").trim();

  const results = (cautionsIndex.cautions || [])
    .filter((caution) => cautionMatchesFilter(caution, filter, register, type))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.topic).localeCompare(String(b.topic));
    })
    .slice(0, topK);

  return { cautionsIndex, results, filter, register, type };
}

function formatPersistentCautionList(cautionsIndex, results, options = {}) {
  const filename = cautionsIndex.filename;
  const filter = String(options.filter || "").trim();
  const register = String(options.register || "").trim();
  const type = String(options.type || "").trim();
  const header = [
    `Persistent caution index for ${filename}`,
    `Total cautions indexed: ${cautionsIndex.cautionCount}`,
    filter ? `Filter: ${filter}` : null,
    register ? `Register: ${register}` : null,
    type ? `Type: ${type}` : null,
    `Results shown: ${results.length}`,
  ].filter(Boolean);

  if (!results.length) {
    return [
      ...header,
      "",
      "No persistent caution candidates matched.",
      "Suggested fallback:",
      `- find_caution(filename="${filename}", topic="${filter || 'reserved bits'}"${register ? `, register="${register}"` : ""})`,
      `- find_section(filename="${filename}", section="Usage Notes")`,
    ].join("\n");
  }

  return [
    ...header,
    "",
    ...results.map((caution, index) => {
      const pages = (caution.pages || []).join(", ") || "unknown";
      const registers = (caution.relatedRegisters || []).slice(0, 10).join(", ") || "none";
      const evidence = (caution.evidenceLines || []).slice(0, 3).map((line) => `   - ${line}`).join("\n") || "   - none";
      const chunks = (caution.chunks || []).slice(0, 4).map((chunk) => chunk.id).join(", ") || "none";
      const firstPage = (caution.pages || [1])[0] || 1;
      const endPage = firstPage + DEFAULT_PAGE_RANGE - 1;
      return [
        `${index + 1}. ${caution.topic}`,
        `   Type: ${caution.type}`,
        `   Pages: ${pages}`,
        `   Related registers: ${registers}`,
        `   Confidence: ${caution.confidence}`,
        `   Score: ${caution.score}`,
        `   Risk for driver: ${caution.riskForDriver || "review required"}`,
        `   Related chunks: ${chunks}`,
        "   Evidence:",
        evidence,
        `   Suggested get: get_cautions_for_register(filename="${filename}", register="${(caution.relatedRegisters || [register || ''])[0] || register}")`,
        `   Suggested read: read_pdf_pages(filename="${filename}", start_page=${firstPage}, end_page=${endPage})`,
      ].join("\n");
    }),
  ].join("\n\n");
}

async function getCautionsForRegister(filename, register, options = {}) {
  const rawRegister = String(register || "").trim();
  if (!rawRegister) throw new Error("register is required");

  const listed = await listCautionsFromIndex(filename, {
    register: rawRegister,
    filter: options.filter,
    topK: options.topK,
  });

  if (listed.results.length) {
    return {
      filename,
      register: rawRegister,
      filter: String(options.filter || "").trim(),
      cautionsIndex: listed.cautionsIndex,
      results: listed.results,
      fallback: null,
    };
  }

  const fallbackTopic = String(options.filter || "reserved bits write timing clear status flag").trim();
  const fallback = await findCautionInIndex(filename, fallbackTopic, {
    register: rawRegister,
    topK: options.topK,
  });

  return {
    filename,
    register: rawRegister,
    filter: String(options.filter || "").trim(),
    cautionsIndex: listed.cautionsIndex,
    results: [],
    fallback,
  };
}

function formatCautionsForRegister(result) {
  const filename = result.filename;
  const register = result.register;
  const filter = result.filter;

  if (!result.results.length) {
    return [
      `No persistent caution candidates found for register "${register}"${filter ? ` with filter "${filter}"` : ""}.`,
      "",
      "Dynamic fallback result:",
      result.fallback ? formatCautionResults(result.fallback) : `- find_caution(filename="${filename}", topic="reserved bits", register="${register}")`,
    ].join("\n");
  }

  return [
    `Persistent cautions for register "${register}"`,
    `File: ${filename}`,
    filter ? `Filter: ${filter}` : null,
    `Results shown: ${result.results.length}`,
    "",
    ...result.results.map((caution, index) => {
      const pages = (caution.pages || []).join(", ") || "unknown";
      const evidence = (caution.evidenceLines || []).slice(0, 5).map((line) => `   - ${line}`).join("\n") || "   - none";
      const chunks = (caution.chunks || []).slice(0, 5).map((chunk) => chunk.id).join(", ") || "none";
      const firstPage = (caution.pages || [1])[0] || 1;
      const endPage = firstPage + DEFAULT_PAGE_RANGE - 1;
      return [
        `Result ${index + 1}`,
        `Topic: ${caution.topic}`,
        `Type: ${caution.type}`,
        `Pages: ${pages}`,
        `Confidence: ${caution.confidence}`,
        `Score: ${caution.score}`,
        `Risk for driver: ${caution.riskForDriver || "review required"}`,
        `Related chunks: ${chunks}`,
        "Evidence:",
        evidence,
        `Suggested dynamic check: find_caution(filename="${filename}", topic="${caution.topic}", register="${register}")`,
        `Suggested page read: read_pdf_pages(filename="${filename}", start_page=${firstPage}, end_page=${endPage})`,
      ].join("\n");
    }),
  ].filter(Boolean).join("\n\n---\n\n");
}



// -----------------------------------------------------------------------------
// Module profile
// -----------------------------------------------------------------------------

function modulePurposeForType(moduleType) {
  const type = String(moduleType || "").toLowerCase();
  if (type.includes("dma")) return "Move data between memory/peripherals with channel configuration, transfer descriptors/registers, status, error and interrupt handling.";
  if (type.includes("watchdog")) return "Monitor system liveness and generate reset/interrupt action when refresh does not occur within the configured timeout.";
  if (type.includes("pwm") || type.includes("timer")) return "Generate timer/counter/PWM behavior with period/duty/capture/compare and interrupt/status handling.";
  if (type.includes("gpio")) return "Control pins, direction, input/output state, and optionally interrupt detection.";
  if (type.includes("i2c")) return "Provide an I2C controller with bus timing, transfer state, status, error and interrupt handling.";
  if (type.includes("spi")) return "Provide an SPI controller with clock/mode/chip-select/transfer FIFO or shift-register handling.";
  if (type.includes("uart")) return "Provide serial TX/RX, baud-rate configuration, FIFO/status/error and interrupt handling.";
  if (type.includes("ethernet")) return "Provide network MAC datapath, DMA/status/interrupt, PHY integration and link management.";
  if (type.includes("can")) return "Provide CAN/CAN-FD controller state, bit timing, message buffers/FIFO and interrupt/error handling.";
  if (type.includes("adc")) return "Provide ADC conversion setup, channel selection, trigger, result and interrupt/status handling.";
  if (type.includes("rtc")) return "Provide time/calendar/alarm/counter operation with interrupt/status handling.";
  return "Unknown module purpose. Infer from overview/register groups and the Linux source workspace.";
}

function driverTopicsForModuleType(moduleType) {
  const type = String(moduleType || "").toLowerCase();
  const common = [
    "probe/init resource mapping",
    "clock/reset enable sequence",
    "start/enable operation",
    "stop/disable operation",
    "interrupt/status handling",
    "status clear semantics",
    "reserved-bit handling",
    "runtime PM or suspend/resume constraints",
  ];

  if (type.includes("dma")) return [
    "channel allocation",
    "transfer setup source/destination/count/config",
    "start transfer / issue pending",
    "terminate/suspend/reset channel",
    "transfer-complete status and error status",
    "interrupt clear semantics",
    "per-channel stride and global status registers",
    ...common,
  ];
  if (type.includes("watchdog")) return [
    "timeout calculation",
    "refresh/ping sequence",
    "start/stop watchdog behavior",
    "reset or interrupt output behavior",
    "panic/restart behavior",
    ...common,
  ];
  if (type.includes("pwm") || type.includes("timer")) return [
    "counter start/stop sequence",
    "period/duty or compare/capture setup",
    "output polarity/mode control",
    "interrupt/status clear",
    "shared-channel restrictions",
    ...common,
  ];
  if (type.includes("i2c") || type.includes("spi") || type.includes("uart")) return [
    "clock/timing configuration",
    "transfer start/stop state machine",
    "TX/RX FIFO or data register handling",
    "error/status interrupt clear",
    ...common,
  ];
  return common;
}

function riskTopicsForModuleType(moduleType) {
  const type = String(moduleType || "").toLowerCase();
  const common = [
    "reserved bits",
    "write only when stopped",
    "clear status flag",
    "write 1 to clear",
    "write 0 to clear",
    "undefined read write value",
    "clock reset restriction",
  ];

  if (type.includes("dma")) return [
    "clear transfer end",
    "clear error status",
    "channel enable disable restriction",
    "software reset",
    "suspend transfer",
    ...common,
  ];
  if (type.includes("watchdog")) return [
    "refresh sequence",
    "write protect",
    "timeout setting restriction",
    "reset output condition",
    ...common,
  ];
  if (type.includes("pwm") || type.includes("timer")) return [
    "counter stopped setting",
    "compare register update timing",
    "interrupt flag clear",
    "output disable condition",
    ...common,
  ];
  return common;
}

function profileConfidence(registers, sections, moduleType) {
  let score = 0;
  if (moduleType && moduleType !== "unknown") score += 25;
  if ((registers || []).length >= 4) score += 25;
  if ((registers || []).length >= 12) score += 15;
  if ((sections || []).some((s) => /overview/i.test(s.title || ""))) score += 10;
  if ((sections || []).some((s) => /register/i.test(s.title || ""))) score += 10;
  if ((sections || []).some((s) => /operation|procedure|setting/i.test(s.title || ""))) score += 10;
  if ((sections || []).some((s) => /caution|note|restriction|usage/i.test(s.title || ""))) score += 5;

  if (score >= 80) return { level: "high", score };
  if (score >= 50) return { level: "medium", score };
  return { level: "low", score };
}

function summarizeRegisterGroupsForProfile(groups) {
  return (groups || []).map((group) => ({
    name: group.name,
    count: (group.registers || []).length,
    registers: (group.registers || []).slice(0, 20).map((reg) => ({
      name: reg.displayName || reg.name,
      description: reg.description || "",
      pages: reg.pages || [],
      offsetAddress: reg.offsetAddress || "",
      initialValue: reg.initialValue || "",
      accessSize: reg.accessSize || "",
      confidence: reg.confidence,
    })),
  }));
}

function collectProfileSections(sectionResults) {
  const seen = new Set();
  const out = [];
  for (const section of sectionResults.flat()) {
    const key = `${section.title}|${section.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: section.id,
      title: section.title,
      page: section.page,
      level: section.level,
      type: section.type,
      score: section.score,
      confidence: section.confidence,
    });
  }
  return out.slice(0, 40);
}

async function buildModuleProfile(filename, options = {}) {
  const moduleTypeHint = String(options.moduleType || "").trim();
  const focus = String(options.focus || "").trim();

  await loadPdfIndex(filename);

  const { registerIndex, results: registers } = await listRegistersFromIndex(filename, {
    topK: MAX_REGISTER_LIST_TOP_K,
    includeLowConfidence: false,
  });

  const sectionQueries = [
    "overview",
    "register description",
    "register list",
    "operation procedure setting",
    "interrupt status",
    "clock reset",
    "caution note restriction usage notes",
  ];

  const sectionSearches = [];
  for (const query of sectionQueries) {
    const { results } = await searchSectionsIndex(filename, query, 8);
    sectionSearches.push(results);
  }

  const sections = collectProfileSections(sectionSearches);
  const moduleType = inferModuleType(filename, registers, sections, moduleTypeHint);
  const linuxSubsystem = likelyLinuxSubsystem(moduleType);
  const groups = groupRegistersForDriverPack(registers);
  const keyRegisters = selectKeyRegistersForDriverPack(registers, moduleType, Math.min(16, registers.length));
  const confidence = profileConfidence(registers, sections, moduleType);
  const driverTopics = driverTopicsForModuleType(moduleType);
  const riskTopics = riskTopicsForModuleType(moduleType);

  const profile = {
    schemaVersion: MODULE_PROFILE_SCHEMA_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    moduleType,
    moduleTypeHint,
    linuxSubsystem,
    focus,
    purpose: modulePurposeForType(moduleType),
    confidence,
    sourceStats: {
      registerIndexCreatedAt: registerIndex.createdAt,
      registerCount: registerIndex.registerCount || (registerIndex.registers || []).length || 0,
      listedRegisterCount: registers.length,
      sectionCount: sections.length,
    },
    manualStructure: {
      sections,
      sectionQueries,
    },
    registerGroups: summarizeRegisterGroupsForProfile(groups),
    keyRegisters: keyRegisters.map((reg) => ({
      name: reg.displayName || reg.name,
      canonicalName: reg.name,
      description: reg.description || "",
      pages: reg.pages || [],
      offsetAddress: reg.offsetAddress || "",
      initialValue: reg.initialValue || "",
      accessSize: reg.accessSize || "",
      confidence: reg.confidence,
      driverPackScore: reg.driverPackScore,
      suggestedSummaryCall: `summarize_register(filename="${filename}", register="${reg.displayName || reg.name}")`,
    })),
    driverRelevantTopics: driverTopics,
    highRiskTopics: riskTopics,
    recommendedWorkflow: [
      "Use get_module_profile first for module orientation.",
      "Use build_driver_evidence_pack before writing/reviewing driver code.",
      "Use summarize_register for each register used by source code macros.",
      "Use find_bitfield for every bit/mask macro used by the driver.",
      "Use find_sequence for init/start/stop/reset/status-clear flows.",
      "Use find_caution for reserved bits, write timing, and clear semantics.",
      "Use read_pdf_pages/read_pdf_chunk before trusting exact offset, bit range, reset value, access type, or clear semantics.",
    ],
    suggestedMcpCalls: [
      `build_driver_evidence_pack(filename="${filename}"${moduleType !== "unknown" ? `, module_type="${moduleType}"` : ""})`,
      `list_registers(filename="${filename}", top_k=100)`,
      ...keyRegisters.slice(0, 6).map((reg) => `summarize_register(filename="${filename}", register="${reg.displayName || reg.name}")`),
      `find_sequence(filename="${filename}", topic="initialization")`,
      `find_sequence(filename="${filename}", topic="start operation")`,
      `find_caution(filename="${filename}", topic="reserved bits")`,
      `find_caution(filename="${filename}", topic="clear status flag")`,
    ],
    limitations: [
      "This module profile is heuristic and depends on PDF text extraction quality.",
      "It does not prove exact bit positions or clear semantics without page/chunk evidence.",
      "For complex modules, use this profile as orientation, then verify each register write path with focused MCP calls.",
    ],
  };

  return profile;
}

async function loadModuleProfile(filename) {
  const profilePath = safeModuleProfileJsonPath(filename);
  if (!(await pathExists(profilePath))) return null;

  try {
    const raw = await fs.readFile(profilePath, "utf-8");
    const profile = JSON.parse(raw);
    if (profile.schemaVersion !== MODULE_PROFILE_SCHEMA_VERSION) return null;
    if (profile.filename !== filename) return null;
    return profile;
  } catch {
    return null;
  }
}

async function getModuleProfile(filename, options = {}) {
  const refresh = Boolean(options.refresh || options.force);
  if (!refresh) {
    const existing = await loadModuleProfile(filename);
    if (existing) return existing;
  }

  const profile = await buildModuleProfile(filename, options);
  await saveModuleProfile(profile);
  return profile;
}

async function saveModuleProfile(profile) {
  await fs.mkdir(INDEX_DIR, { recursive: true });
  const jsonPath = safeModuleProfileJsonPath(profile.filename);
  const textPath = safeModuleProfileTextPath(profile.filename);
  await atomicWriteJson(jsonPath, profile);
  await atomicWriteFile(textPath, formatModuleProfile(profile), "utf-8");
  return { jsonPath, textPath };
}

function formatModuleProfile(profile) {
  const lines = [];
  const filename = profile.filename;

  lines.push(`Module Profile`);
  lines.push(`File: ${filename}`);
  lines.push(`Created: ${profile.createdAt}`);
  lines.push("");

  lines.push("1. Module identity");
  lines.push(`- Inferred module type: ${profile.moduleType}`);
  if (profile.moduleTypeHint) lines.push(`- User module type hint: ${profile.moduleTypeHint}`);
  if (profile.focus) lines.push(`- Focus: ${profile.focus}`);
  lines.push(`- Likely Linux subsystem: ${profile.linuxSubsystem}`);
  lines.push(`- Purpose: ${profile.purpose}`);
  lines.push(`- Profile confidence: ${profile.confidence.level} (${profile.confidence.score}/100)`);
  lines.push("");

  lines.push("2. Source/index status");
  lines.push(`- Register index created: ${profile.sourceStats.registerIndexCreatedAt || "unknown"}`);
  lines.push(`- Registers detected: ${profile.sourceStats.registerCount}`);
  lines.push(`- Registers listed in profile: ${profile.sourceStats.listedRegisterCount}`);
  lines.push(`- Relevant sections listed: ${profile.sourceStats.sectionCount}`);
  lines.push("");

  lines.push("3. Manual structure highlights");
  if ((profile.manualStructure.sections || []).length) {
    for (const section of profile.manualStructure.sections.slice(0, 24)) {
      lines.push(`- ${section.title} (page ${section.page}, type: ${section.type || "unknown"}, score: ${section.score || section.confidence || "n/a"})`);
    }
  } else {
    lines.push("- No section highlights found. Use find_section/search_pdf manually.");
  }
  lines.push("");

  lines.push("4. Register groups");
  if ((profile.registerGroups || []).length) {
    for (const group of profile.registerGroups) {
      const regs = (group.registers || []).slice(0, 12).map((r) => r.name).join(", ");
      const suffix = group.count > 12 ? `, ... (+${group.count - 12} more)` : "";
      lines.push(`- ${group.name} (${group.count}): ${regs}${suffix}`);
    }
  } else {
    lines.push("- No register groups detected.");
  }
  lines.push("");

  lines.push("5. Key registers for driver orientation");
  if ((profile.keyRegisters || []).length) {
    for (const [index, reg] of profile.keyRegisters.entries()) {
      const pages = (reg.pages || []).slice(0, 8).join(", ") || "unknown";
      const desc = reg.description ? ` — ${reg.description}` : "";
      const offset = reg.offsetAddress ? `; offset: ${reg.offsetAddress}` : "";
      const initial = reg.initialValue ? `; initial: ${reg.initialValue}` : "";
      const access = reg.accessSize ? `; access size: ${reg.accessSize}` : "";
      lines.push(`${index + 1}. ${reg.name}${desc}`);
      lines.push(`   Pages: ${pages}${offset}${initial}${access}; confidence: ${reg.confidence}; score: ${reg.driverPackScore}`);
      lines.push(`   Suggested: ${reg.suggestedSummaryCall}`);
    }
  } else {
    lines.push("- No key registers selected.");
  }
  lines.push("");

  lines.push("6. Driver-relevant topics");
  for (const topic of profile.driverRelevantTopics || []) lines.push(`- ${topic}`);
  lines.push("");

  lines.push("7. High-risk manual topics to verify");
  for (const topic of profile.highRiskTopics || []) lines.push(`- ${topic}`);
  lines.push("");

  lines.push("8. Recommended workflow for VS Code AI agent");
  for (const item of profile.recommendedWorkflow || []) lines.push(`- ${item}`);
  lines.push("");

  lines.push("9. Suggested MCP calls");
  for (const call of profile.suggestedMcpCalls || []) lines.push(`- ${call}`);
  lines.push("");

  lines.push("10. Limitations");
  for (const item of profile.limitations || []) lines.push(`- ${item}`);

  return lines.join("\n");
}


// -----------------------------------------------------------------------------
// Data-driven driver profiles / completeness checklist
// -----------------------------------------------------------------------------

function defaultDriverProfiles() {
  return {
    generic: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      profile: "generic",
      title: "Generic Linux MMIO/platform driver completeness checklist",
      subsystem: "generic",
      driver_family: "generic",
      description: "Fallback checklist for a Linux platform/MMIO driver when no subsystem-specific profile exists.",
      checklist: [
        {
          area: "Probe / platform integration",
          items: [
            "compatible/of_device_id or platform_device_id match",
            "MMIO resource acquisition and devm_ioremap_resource/ioremap",
            "IRQ resource acquisition and request handler if interrupts are used",
            "clock acquisition/enable/disable and rate assumptions",
            "reset control acquire/deassert/assert ordering",
            "runtime PM enable/disable and error unwinding",
            "pinctrl/default state if pins are required",
            "devm-managed resources or correct cleanup path"
          ],
          required_manual_checks: ["base address/register map", "clock/reset requirements", "interrupt sources", "initialization sequence"]
        },
        {
          area: "Register access correctness",
          items: [
            "all register offsets match the manual",
            "all bit masks/shifts match bit-field tables",
            "reserved bits are preserved on writes",
            "read-only/write-only/access-size constraints are respected",
            "write timing restrictions are respected",
            "status clear semantics are verified"
          ],
          required_manual_checks: ["register offsets", "bitfield positions", "access type", "reserved-bit handling", "clear semantics"]
        },
        {
          area: "Operation sequencing",
          items: [
            "probe/init sequence follows manual order",
            "start/enable path follows manual order",
            "stop/disable path follows manual order",
            "software reset/polling path follows manual order",
            "error handling path handles documented flags and recovery steps"
          ],
          required_manual_checks: ["init sequence", "start sequence", "stop sequence", "reset sequence", "error sequence"]
        },
        {
          area: "Interrupt/status handling",
          items: [
            "IRQ mask/unmask ordering is correct",
            "status is read before clear when required",
            "W1C/W0C semantics are verified",
            "handler distinguishes normal completion from error sources",
            "race with enable/disable/remove/suspend is handled"
          ],
          required_manual_checks: ["interrupt source table", "status register", "clear semantics", "error flags"]
        },
        {
          area: "Power management / reset restore",
          items: [
            "runtime suspend/resume saves/restores necessary state",
            "system suspend/resume handles clocks/resets/IRQs",
            "hardware state after reset is consistent with driver state",
            "wake capability is handled only if documented"
          ],
          required_manual_checks: ["reset values", "clock gating restrictions", "standby restrictions"]
        }
      ],
      source_review_steps: [
        "Read source files in the VS Code workspace; MCP does not read source code.",
        "Extract register macros and bit macros used by the driver.",
        "Classify each hardware operation as raw_write/read_modify_write/poll/write_one_to_clear/reset.",
        "Call verify_register_usage for each operation touching hardware registers.",
        "Resolve every needsVerification item before approving code."
      ],
      required_manual_checks: [
        "register offsets",
        "bitfield positions",
        "access type and access size",
        "reserved-bit handling",
        "init/start/stop/reset sequence",
        "interrupt/status clear semantics",
        "cautions/restrictions"
      ],
      recommended_tools: [
        "doctor",
        "prepare_driver_task",
        "build_driver_evidence_pack",
        "verify_register_usage",
        "extract_register_table",
        "extract_bitfield_table",
        "get_sequence",
        "get_cautions_for_register"
      ]
    },
    ethernet: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      profile: "ethernet",
      title: "Linux Ethernet MAC driver completeness checklist",
      subsystem: "ethernet",
      driver_family: "generic-ethernet",
      description: "Generic Ethernet MAC checklist; use ethernet-stmmac when the driver is STMMAC/DWMAC based.",
      extends: "generic",
      checklist: [
        {
          area: "Netdev / MAC integration",
          items: [
            "net_device allocation/registration path is correct",
            "MAC address setup and validation are implemented",
            "TX/RX enable/disable sequence is verified",
            "speed/duplex/flow-control configuration is handled",
            "multicast/promiscuous/allmulti filters are handled",
            "checksum/TSO/offload capability flags match hardware"
          ],
          required_manual_checks: ["MAC control registers", "TX/RX enable bits", "filter registers", "flow-control registers"]
        },
        {
          area: "PHY / MDIO / link mode",
          items: [
            "phy-mode is parsed from Device Tree",
            "phy-handle/fixed-link is supported as needed",
            "MDIO controller registration and clock/divider are correct",
            "RGMII/RMII/GMII delays and interface mode restrictions are handled",
            "link up/down callbacks program MAC state safely"
          ],
          required_manual_checks: ["MDIO registers", "PHY interface mode", "RGMII delay control", "link speed setting"]
        },
        {
          area: "DMA / descriptor / rings",
          items: [
            "descriptor format matches hardware/manual",
            "RX/TX ring allocation and DMA mapping are correct",
            "descriptor ownership bits and barriers are correct",
            "TX completion and RX refill are handled",
            "DMA reset/start/stop sequence is verified"
          ],
          required_manual_checks: ["DMA registers", "descriptor format", "DMA start/stop sequence", "status/error flags"]
        },
        {
          area: "Interrupt / error recovery",
          items: [
            "normal TX/RX IRQ sources are enabled and acknowledged correctly",
            "DMA/MAC error IRQ sources are handled",
            "status clear semantics are verified",
            "reset/recovery path is available for fatal errors",
            "IRQ masking avoids races with stop/suspend/remove"
          ],
          required_manual_checks: ["interrupt status registers", "interrupt enable/mask registers", "clear semantics", "error recovery sequence"]
        }
      ],
      source_review_steps: [
        "Inspect ndo_open/ndo_stop, IRQ handler, TX/RX path, MDIO/PHY setup, and suspend/resume.",
        "Extract every MAC/DMA/MDIO register operation and call verify_register_usage.",
        "Compare Device Tree nodes against required clocks/resets/interrupts/phy-mode/mdio/fixed-link properties."
      ],
      required_manual_checks: [
        "MAC TX/RX enable sequence",
        "DMA descriptor/ring start-stop sequence",
        "interrupt clear semantics",
        "MDIO clock/divider and PHY interface restrictions",
        "reset and runtime PM restrictions"
      ],
      recommended_tools: ["driver_completeness_checklist", "build_driver_evidence_pack", "verify_register_usage", "get_sequence", "get_cautions_for_register"]
    },
    "ethernet-stmmac": {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      profile: "ethernet-stmmac",
      title: "Linux Ethernet STMMAC/DWMAC glue driver completeness checklist",
      subsystem: "ethernet",
      driver_family: "stmmac",
      extends: "ethernet",
      description: "Checklist for drivers that integrate SoC-specific Ethernet MAC glue with stmmac_platform/stmmac_main.",
      checklist: [
        {
          area: "STMMAC platform/glue integration",
          items: [
            "stmmac_platform or glue probe passes correct plat_stmmacenet_data",
            "compatible string selects correct SoC data",
            "DMA bus mode/axi/config quirks are mapped correctly",
            "MAC version/capability assumptions do not conflict with manual",
            "remove/error unwind calls stmmac_dvr_remove/platform cleanup correctly"
          ],
          required_manual_checks: ["SoC-specific MAC/DMA integration registers", "DMA capability registers", "reset sequence"]
        },
        {
          area: "Device Tree integration for stmmac",
          items: [
            "compatible/reg/interrupts are correct",
            "clocks and clock-names match driver expectations",
            "resets/reset-names match hardware manual sequence",
            "phy-mode/phy-handle/fixed-link/mdio node are correct",
            "RGMII delay properties and pinctrl match board wiring",
            "DMA coherent/cache attributes and AXI settings are reviewed"
          ],
          required_manual_checks: ["clock tree", "reset line", "interrupt lines", "PHY interface mode", "MDIO"]
        },
        {
          area: "STMMAC callbacks and hardware operations",
          items: [
            "init callback programs SoC glue registers before stmmac core starts MAC/DMA",
            "fix_mac_speed or equivalent callback programs speed/duplex related registers",
            "set_tx_clk or clock rate changes are safe",
            "suspend/resume restores glue state before stmmac resumes",
            "reset path waits/polls documented ready bits when required"
          ],
          required_manual_checks: ["speed selection register", "clock/reset sequence", "start/stop sequence", "caution restrictions"]
        }
      ],
      source_review_steps: [
        "Inspect dwmac-renesas-gbeth.c, stmmac_platform.c, stmmac_main.c and related DTS files.",
        "List SoC glue register macros in dwmac-renesas-gbeth.c and call verify_register_usage for each register operation.",
        "Check DTS clocks/resets/interrupts/phy-mode/mdio/fixed-link against the profile checklist.",
        "Do not judge completeness only by stmmac core coverage; verify SoC glue/manual-specific requirements."
      ],
      required_manual_checks: [
        "SoC glue register offsets and bitfields",
        "MAC/DMA reset and start sequence",
        "MDIO/PHY interface configuration",
        "interrupt mapping and clear semantics",
        "clock/reset/runtime PM restrictions"
      ],
      recommended_tools: ["prepare_driver_task", "build_driver_evidence_pack", "verify_register_usage", "hybrid_search_pdf", "get_sequence", "get_cautions_for_register"]
    },
    dmaengine: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      profile: "dmaengine",
      title: "Linux dmaengine driver completeness checklist",
      subsystem: "dmaengine",
      driver_family: "generic-dmaengine",
      extends: "generic",
      checklist: [
        {
          area: "dma_device / channel model",
          items: ["dma_device capabilities are correct", "channel count/stride matches manual", "slave config fields are mapped", "descriptor allocation/lifetime is correct", "cookie completion is correct"],
          required_manual_checks: ["channel register stride", "transfer configuration registers", "status/end/error registers"]
        },
        {
          area: "Transfer programming",
          items: ["source/destination/count registers are programmed in documented order", "transfer size/alignment limits are enforced", "request IDs and directions are mapped correctly", "start/enable bit sequence is verified"],
          required_manual_checks: ["start sequence", "channel config bitfields", "address/count registers"]
        },
        {
          area: "IRQ / terminate / error",
          items: ["transfer complete interrupt is acknowledged correctly", "error status is handled", "terminate_all stops channel safely", "synchronize waits for in-flight handlers"],
          required_manual_checks: ["clear semantics", "error flags", "stop/suspend/reset sequence"]
        }
      ],
      source_review_steps: ["Inspect prep/issue_pending/IRQ/terminate/synchronize paths.", "Call verify_register_usage for CHCTRL/CHCFG/CHSTAT/status-clear operations."],
      required_manual_checks: ["channel start/stop sequence", "status clear semantics", "reserved-bit handling", "error recovery"],
      recommended_tools: ["prepare_driver_task", "verify_register_usage", "get_sequence", "get_cautions_for_register"]
    },
    watchdog: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      profile: "watchdog",
      title: "Linux watchdog driver completeness checklist",
      subsystem: "watchdog",
      driver_family: "generic-watchdog",
      extends: "generic",
      checklist: [
        { area: "watchdog core ops", items: ["start/stop/ping/set_timeout/restart implemented as supported", "nowayout behavior is correct", "timeout min/max uses real clock and prescaler limits", "restart priority/path is safe"], required_manual_checks: ["timeout calculation", "refresh sequence", "start/stop sequence", "reset behavior"] },
        { area: "panic/restart behavior", items: ["panic/reboot behavior is verified", "system reset path uses documented reset enable", "clock/reset dependencies are handled"], required_manual_checks: ["reset output behavior", "peri/syscon/reset control", "status flags"] }
      ],
      source_review_steps: ["Inspect watchdog ops and restart/panic path.", "Verify WDTRR/WDTCR/WDTSR/WDTRCR operations with verify_register_usage."],
      required_manual_checks: ["refresh sequence", "timeout formula", "reset output behavior", "reserved-bit handling"],
      recommended_tools: ["verify_register_usage", "get_sequence", "get_cautions_for_register"]
    },
    pwm: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      profile: "pwm",
      title: "Linux PWM/timer driver completeness checklist",
      subsystem: "pwm",
      driver_family: "generic-pwm",
      extends: "generic",
      checklist: [
        { area: "PWM apply/config", items: ["period/duty conversion uses correct clock and prescaler", "polarity/output mode is correct", "enable/disable sequence is safe", "shared channel constraints are handled"], required_manual_checks: ["counter mode", "output control", "prescaler", "start/stop sequence"] },
        { area: "advanced timer features", items: ["capture/interrupt/dead-time/buffer features are implemented only when supported", "register buffering avoids glitches", "status flags are cleared correctly"], required_manual_checks: ["buffer registers", "interrupt/status clear", "capture sequence"] }
      ],
      source_review_steps: ["Inspect pwm_ops apply/get_state and interrupt/capture paths if present.", "Verify GTCR/GTIOR/GTBER/GTST operations."],
      required_manual_checks: ["period/duty formula", "start/stop sequence", "output polarity", "status clear semantics"],
      recommended_tools: ["verify_register_usage", "extract_bitfield_table", "get_sequence"]
    }
  };
}

async function ensureDefaultDriverProfiles(createDefault = true) {
  await fs.mkdir(DRIVER_PROFILES_DIR, { recursive: true });
  if (!createDefault) return;
  const profiles = defaultDriverProfiles();
  for (const [name, profile] of Object.entries(profiles)) {
    const filePath = safeDriverProfilePath(name);
    if (!(await pathExists(filePath))) {
      await atomicWriteJson(filePath, profile);
    }
  }
}

async function listDriverProfiles(options = {}) {
  await ensureDefaultDriverProfiles(options.createDefault !== false);
  const dirents = await fs.readdir(DRIVER_PROFILES_DIR, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const entry of dirents) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const name = entry.name.replace(/\.json$/i, "");
    const filePath = safeDriverProfilePath(name);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const data = JSON.parse(raw);
      profiles.push({
        name,
        path: filePath,
        title: data.title || name,
        subsystem: data.subsystem || "unknown",
        driver_family: data.driver_family || "unknown",
        extends: data.extends || "",
        checklistAreas: Array.isArray(data.checklist) ? data.checklist.length : 0,
      });
    } catch (error) {
      profiles.push({ name, path: filePath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return profiles;
}

async function loadDriverProfileByName(name) {
  const profileName = sanitizeDriverProfileName(name);
  const filePath = safeDriverProfilePath(profileName);
  if (!(await pathExists(filePath))) return null;
  const raw = await fs.readFile(filePath, "utf-8");
  const profile = JSON.parse(raw);
  if (profile.schemaVersion !== DRIVER_PROFILE_SCHEMA_VERSION) {
    throw new Error(`Unsupported driver profile schemaVersion in ${profileName}: ${profile.schemaVersion}`);
  }
  return { ...profile, _profileName: profileName, _profilePath: filePath };
}

function mergeUniqueStrings(...arrays) {
  return [...new Set(arrays.flat().map((item) => String(item || "").trim()).filter(Boolean))];
}

function mergeDriverProfiles(base, overlay) {
  if (!base) return overlay;
  if (!overlay) return base;
  return {
    ...base,
    ...overlay,
    checklist: [...(base.checklist || []), ...(overlay.checklist || [])],
    source_review_steps: mergeUniqueStrings(base.source_review_steps || [], overlay.source_review_steps || []),
    required_manual_checks: mergeUniqueStrings(base.required_manual_checks || [], overlay.required_manual_checks || []),
    recommended_tools: mergeUniqueStrings(base.recommended_tools || [], overlay.recommended_tools || []),
    _profileStack: [...(base._profileStack || [base._profileName || base.profile].filter(Boolean)), overlay._profileName || overlay.profile].filter(Boolean),
    _profilePaths: [...(base._profilePaths || [base._profilePath].filter(Boolean)), overlay._profilePath].filter(Boolean),
  };
}

function driverProfileCandidates({ profile = "", subsystem = "", driverFamily = "" } = {}) {
  const candidates = [];
  const explicit = sanitizeDriverProfileName(profile || "");
  const sub = sanitizeDriverProfileName(normalizeDriverProfileHint(subsystem || ""));
  const family = sanitizeDriverProfileName(normalizeDriverProfileHint(driverFamily || ""));

  if (profile) candidates.push(explicit);
  if (sub && family && sub !== "generic" && family !== "generic") candidates.push(`${sub}-${family}`);
  if (family && family !== "generic") candidates.push(family);
  if (sub && sub !== "generic") candidates.push(sub);
  candidates.push("generic");
  return [...new Set(candidates)];
}

async function resolveDriverProfile(options = {}) {
  await ensureDefaultDriverProfiles(options.createDefault !== false);
  const candidates = driverProfileCandidates(options);
  const warnings = [];
  const loaded = new Map();

  async function loadWithExtends(name, stack = []) {
    const safeName = sanitizeDriverProfileName(name);
    if (loaded.has(safeName)) return loaded.get(safeName);
    if (stack.includes(safeName)) throw new Error(`Circular driver profile extends: ${[...stack, safeName].join(" -> ")}`);
    const profile = await loadDriverProfileByName(safeName);
    if (!profile) return null;
    let merged = profile;
    if (profile.extends) {
      const parent = await loadWithExtends(profile.extends, [...stack, safeName]);
      if (parent) merged = mergeDriverProfiles(parent, profile);
      else warnings.push(`Profile ${safeName} extends missing profile ${profile.extends}`);
    } else {
      merged._profileStack = [profile._profileName || profile.profile].filter(Boolean);
      merged._profilePaths = [profile._profilePath].filter(Boolean);
    }
    loaded.set(safeName, merged);
    return merged;
  }

  for (const candidate of candidates) {
    const profile = await loadWithExtends(candidate);
    if (profile) return { profile, selected: candidate, candidates, warnings };
  }

  throw new Error(`No driver profile found. Tried: ${candidates.join(", ")}`);
}

function formatDriverProfilesList(profiles) {
  if (!profiles.length) {
    return `No driver profiles found. Directory: ${DRIVER_PROFILES_DIR}`;
  }
  const lines = [
    "Driver profiles",
    `Directory: ${DRIVER_PROFILES_DIR}`,
    "",
  ];
  for (const profile of profiles) {
    lines.push(`- ${profile.name}`);
    lines.push(`  title: ${profile.title || "unknown"}`);
    lines.push(`  subsystem: ${profile.subsystem || "unknown"}`);
    lines.push(`  driver_family: ${profile.driver_family || "unknown"}`);
    if (profile.extends) lines.push(`  extends: ${profile.extends}`);
    lines.push(`  checklist areas: ${profile.checklistAreas ?? "unknown"}`);
    if (profile.error) lines.push(`  error: ${profile.error}`);
    lines.push(`  path: ${profile.path}`);
  }
  return lines.join("\n");
}

async function buildDriverCompletenessChecklist(filename, options = {}) {
  ensurePdfFilename(filename);
  const task = String(options.task || "").trim();
  const subsystemHint = String(options.subsystem || "").trim();
  const driverFamily = String(options.driverFamily || "").trim();
  const explicitProfile = String(options.profile || "").trim();

  let moduleProfile = null;
  try {
    moduleProfile = await getModuleProfile(filename, {
      moduleType: subsystemHint,
      focus: task || "driver completeness checklist",
      refresh: false,
    });
  } catch {
    moduleProfile = null;
  }

  const inferredSubsystem = normalizeDriverProfileHint(subsystemHint || moduleProfile?.moduleType || "generic");
  const resolved = await resolveDriverProfile({
    profile: explicitProfile,
    subsystem: inferredSubsystem,
    driverFamily,
    createDefault: options.createDefault !== false,
  });

  const profile = resolved.profile;
  const evidencePackCall = `build_driver_evidence_pack(filename="${filename}", module_type="${inferredSubsystem}", focus="${(task || profile.title || "driver completeness review").replace(/"/g, "'")}", mode="adaptive")`;
  const driverTaskCall = `prepare_driver_task(filename="${filename}", task="${(task || profile.title || "driver completeness review").replace(/"/g, "'")}", module_type="${inferredSubsystem}")`;
  const visualGate = await collectDriverReviewVisualEvidence(filename, {
    include: options.includeVisualEvidence !== false,
    filter: options.visualFilter || task,
    task,
    moduleType: inferredSubsystem,
    topK: 8,
    status: options.visualStatus || "all",
    gate: options.visualGate || "advisory",
    requireVerified: options.visualRequireVerified,
  });
  const visualEvidence = visualGate.entries;

  return {
    filename,
    createdAt: new Date().toISOString(),
    task,
    subsystem: inferredSubsystem,
    driverFamily,
    explicitProfile,
    selectedProfile: resolved.selected,
    triedProfiles: resolved.candidates,
    warnings: [...resolved.warnings, ...visualEvidenceGateWarnings(visualGate)],
    profile,
    moduleProfile,
    requiredManualChecks: profile.required_manual_checks || [],
    sourceReviewSteps: profile.source_review_steps || [],
    recommendedTools: profile.recommended_tools || [],
    visualEvidence,
    visualEvidenceGate: visualGate,
    suggestedMcpCalls: [
      `doctor(filename="${filename}")`,
      driverTaskCall,
      evidencePackCall,
      `visual_evidence_report(filename="${filename}", filter="${quoteForPromptCall(options.visualFilter || task || inferredSubsystem)}", include_entries=true)`,
      `driver_completeness_checklist(filename="${filename}", subsystem="${inferredSubsystem}", driver_family="${driverFamily || profile.driver_family || ""}")`,
      `verify_register_usage(filename="${filename}", register="<source-register>", operation="<source-operation>", bitfields=[...], access_type="<access-pattern>", intent="<intent>")`,
      `get_sequence(filename="${filename}", topic="<init/start/stop/clear/reset/irq/error topic>")`,
      `get_cautions_for_register(filename="${filename}", register="<source-register>")`,
    ],
  };
}

function buildDriverCompletenessContract(checklist) {
  const evidence = [];
  evidence.push(makeEvidence({
    source: "driver-profile-json",
    evidenceType: "checklist-profile",
    quote: `${checklist.profile.title || checklist.profile.profile} loaded from ${(checklist.profile._profileStack || []).join(" -> ")}`,
    confidence: "high",
    name: checklist.selectedProfile,
    tool: "driver_completeness_checklist",
  }));
  if (checklist.moduleProfile) {
    evidence.push(makeEvidence({
      source: "module-profile-index",
      evidenceType: "module-profile",
      quote: `moduleType=${checklist.moduleProfile.moduleType}, linuxSubsystem=${checklist.moduleProfile.linuxSubsystem}, confidence=${checklist.moduleProfile.confidence?.level || "unknown"}`,
      confidence: checklist.moduleProfile.confidence?.score || "medium",
      name: checklist.moduleProfile.moduleType,
      tool: "driver_completeness_checklist",
    }));
  }
  evidence.push(...visualEvidenceToEvidenceContractItems(checklist.visualEvidence || [], "driver_completeness_checklist"));

  const inference = [
    makeInference({
      statement: `Selected driver completeness profile: ${checklist.selectedProfile}`,
      basis: `candidates: ${checklist.triedProfiles.join(", ")}`,
      confidence: "medium",
      risk: "Profile selection is a workflow heuristic, not manual evidence.",
    }),
    makeInference({
      statement: `Subsystem under review: ${checklist.subsystem}`,
      basis: checklist.explicitProfile || checklist.subsystem || checklist.moduleProfile?.moduleType || "fallback generic profile",
      confidence: checklist.subsystem === "generic" ? "low" : "medium",
      risk: "The VS Code agent must confirm subsystem from actual source files.",
    }),
  ];

  const needsVerification = [
    makeNeedsVerification({
      item: "Each checklist item against the real source files",
      reason: "The MCP server does not read the source repository; it only supplies the review checklist and manual evidence workflow.",
      suggestedTools: ["verify_register_usage(...) for each register operation", "build_driver_evidence_pack(..., mode=adaptive)", "get_sequence(...)", "get_cautions_for_register(...)"],
    }),
    makeNeedsVerification({
      item: "All register offsets, bit fields, clear semantics, and operation ordering",
      reason: "Completeness checklist identifies review obligations; exact hardware facts must be verified from manual evidence.",
      suggestedTools: ["extract_register_table(...)", "extract_bitfield_table(...)", "verify_register_usage(...)"],
    }),
  ];

  needsVerification.push(...visualEvidenceGateNeedsVerification(checklist.visualEvidenceGate || {}, checklist.filename));

  return makeEvidenceContract({
    tool: "driver_completeness_checklist",
    filename: checklist.filename,
    query: checklist.task || checklist.profile.title || checklist.selectedProfile,
    evidence,
    inference,
    needsVerification,
    warnings: checklist.warnings || [],
    recommendedNextTools: checklist.suggestedMcpCalls || [],
  });
}

function formatDriverCompletenessChecklist(checklist) {
  const profile = checklist.profile;
  const lines = [];
  lines.push("Driver Completeness Checklist");
  lines.push(`File: ${checklist.filename}`);
  lines.push(`Created: ${checklist.createdAt}`);
  lines.push(`Task: ${checklist.task || "not specified"}`);
  lines.push(`Subsystem: ${checklist.subsystem}`);
  lines.push(`Driver family: ${checklist.driverFamily || profile.driver_family || "not specified"}`);
  lines.push(`Selected profile: ${checklist.selectedProfile}`);
  lines.push(`Profile stack: ${(profile._profileStack || [profile.profile]).join(" -> ")}`);
  if ((profile._profilePaths || []).length) lines.push(`Profile files: ${(profile._profilePaths || []).join(" | ")}`);
  if ((checklist.triedProfiles || []).length) lines.push(`Profile candidates tried: ${checklist.triedProfiles.join(", ")}`);
  for (const warning of checklist.warnings || []) lines.push(`Warning: ${warning}`);
  lines.push("");

  lines.push("1. Profile description");
  lines.push(`- ${profile.title || profile.profile}`);
  if (profile.description) lines.push(`- ${profile.description}`);
  if (checklist.moduleProfile) {
    lines.push(`- Manual/module profile: ${checklist.moduleProfile.moduleType}; likely subsystem: ${checklist.moduleProfile.linuxSubsystem}; confidence: ${checklist.moduleProfile.confidence?.level || "unknown"}`);
  } else {
    lines.push("- Manual/module profile: unavailable; run get_module_profile if needed.");
  }
  lines.push("");

  lines.push("2. Completeness matrix");
  if ((profile.checklist || []).length) {
    for (const [areaIndex, area] of profile.checklist.entries()) {
      lines.push(`${areaIndex + 1}. ${area.area || "Unnamed area"}`);
      for (const item of area.items || []) lines.push(`   - [ ] ${item}`);
      if ((area.required_manual_checks || []).length) {
        lines.push(`   Manual checks: ${(area.required_manual_checks || []).join("; ")}`);
      }
    }
  } else {
    lines.push("- No checklist items in selected profile.");
  }
  lines.push("");

  lines.push("3. Required manual checks");
  for (const item of checklist.requiredManualChecks || []) lines.push(`- ${item}`);
  lines.push("");

  lines.push("4. Persisted visual evidence relevant to this checklist");
  lines.push(...formatDriverVisualEvidenceSection(checklist.visualEvidence || [], checklist.filename).slice(1));
  lines.push("");

  lines.push("4b. Visual evidence verification gate");
  lines.push(...formatVisualEvidenceGateSection(checklist.visualEvidenceGate || {}, checklist.filename).slice(1));
  lines.push("");

  lines.push("5. Required source-code review steps for VS Code agent");
  for (const item of checklist.sourceReviewSteps || []) lines.push(`- ${item}`);
  lines.push("");

  lines.push("6. Recommended MCP workflow");
  for (const call of checklist.suggestedMcpCalls || []) lines.push(`- ${call}`);
  lines.push("");

  lines.push("8. Approval rule");
  lines.push("- Do not mark a checklist item complete based only on this profile.");
  lines.push("- The VS Code agent must inspect source code and map each hardware operation to manual evidence.");
  lines.push("- Use verify_register_usage for every register write/read/poll/reset/status-clear operation found in source.");
  lines.push("- Resolve needsVerification items before claiming driver completeness.");

  return appendEvidenceContract(lines.join("\n"), buildDriverCompletenessContract(checklist));
}


function flattenChecklistRequirements(profile) {
  const rows = [];
  for (const [areaIndex, area] of (profile.checklist || []).entries()) {
    for (const [itemIndex, item] of (area.items || []).entries()) {
      const text = String(item || "").trim();
      if (!text) continue;
      rows.push({ id: `A${areaIndex + 1}.${itemIndex + 1}`, area: area.area || "Unnamed area", item: text, requiredManualChecks: area.required_manual_checks || [] });
    }
  }
  return rows;
}

function tokenizeRequirementText(text) {
  const normalized = normalizeForSearch(text);
  const rawTokens = normalized.split(/\s+/).filter((token) => token.length > 1);
  const stop = new Set(["and", "or", "the", "a", "an", "is", "are", "be", "to", "of", "in", "on", "for", "with", "as", "by", "if", "when", "only", "correct", "handled", "implemented", "support", "supports", "used", "uses", "match", "matches", "driver", "source", "code", "path", "required", "needed", "should", "must"]);
  const aliases = new Map([
    ["irq", ["interrupt", "interrupts", "isr"]], ["interrupt", ["irq", "isr"]],
    ["clk", ["clock", "clocks"]], ["clock", ["clk", "clocks"]],
    ["reset", ["rst", "resets"]], ["pm", ["runtime", "suspend", "resume"]],
    ["phy", ["phylink", "mdio", "link"]], ["mdio", ["phy", "mii"]],
    ["dma", ["descriptor", "ring", "rx", "tx"]], ["rx", ["receive", "receiver"]], ["tx", ["transmit", "transmitter"]],
    ["w1c", ["write", "one", "clear"]], ["w0c", ["write", "zero", "clear"]],
    ["dt", ["device", "tree", "dts"]], ["of", ["device", "tree"]],
    ["mmio", ["ioremap", "resource", "reg"]], ["ioremap", ["mmio", "resource"]],
    ["stmmac", ["dwmac", "plat", "platform"]], ["dwmac", ["stmmac"]],
  ]);
  const out = new Set();
  for (const token of rawTokens) {
    if (stop.has(token)) continue;
    out.add(token);
    if (aliases.has(token)) for (const alias of aliases.get(token)) out.add(alias);
  }
  return [...out];
}

function scoreRequirementAgainstEvidence(requirement, evidenceText) {
  const reqTokens = tokenizeRequirementText(requirement);
  const evidenceTokens = new Set(tokenizeRequirementText(evidenceText));
  const normalizedReq = normalizeForSearch(requirement);
  const normalizedEvidence = normalizeForSearch(evidenceText);
  if (!reqTokens.length || !normalizedEvidence) return { score: 0, hits: [], coverage: 0 };
  const hits = reqTokens.filter((token) => evidenceTokens.has(token) || normalizedEvidence.includes(token));
  let score = Math.round((hits.length / reqTokens.length) * 100);
  if (normalizedEvidence.includes(normalizedReq)) score += 80;
  for (const phrase of ["runtime pm", "device tree", "phy mode", "fixed link", "mac address", "flow control", "checksum", "interrupt", "reset", "clock", "w1c", "write one to clear", "read modify write", "descriptor", "ring", "mdio", "stmmac", "platform data"]) {
    if (normalizedReq.includes(phrase) && normalizedEvidence.includes(phrase)) score += 18;
  }
  return { score: Math.min(score, 180), hits: hits.slice(0, 20), coverage: Math.round((hits.length / reqTokens.length) * 100) };
}

function bestRequirementEvidence(requirement, evidenceItems) {
  let best = { score: 0, hits: [], coverage: 0, evidence: "" };
  for (const item of evidenceItems || []) {
    const score = scoreRequirementAgainstEvidence(requirement, item);
    if (score.score > best.score) best = { ...score, evidence: item };
  }
  return best;
}

function classifyRequirementStatus(requirement, implementedEvidence, missingEvidence = []) {
  const missing = bestRequirementEvidence(requirement.item, missingEvidence);
  if (missing.score >= 70) return { ...requirement, status: "missing", confidence: "high", matchScore: missing.score, matchCoverage: missing.coverage, matchedEvidence: missing.evidence, matchedTokens: missing.hits, reason: "explicitly listed as missing/unsupported by source review input" };
  const best = bestRequirementEvidence(requirement.item, implementedEvidence);
  if (best.score >= 85 || best.coverage >= 60) return { ...requirement, status: "implemented_candidate", confidence: best.score >= 120 || best.coverage >= 75 ? "high" : "medium", matchScore: best.score, matchCoverage: best.coverage, matchedEvidence: best.evidence, matchedTokens: best.hits, reason: "source-review input appears to cover this checklist item" };
  if (best.score >= 45 || best.coverage >= 35) return { ...requirement, status: "unclear", confidence: "medium", matchScore: best.score, matchCoverage: best.coverage, matchedEvidence: best.evidence, matchedTokens: best.hits, reason: "partial token/phrase overlap; source evidence is not specific enough" };
  return { ...requirement, status: "missing_or_not_reported", confidence: "low", matchScore: best.score, matchCoverage: best.coverage, matchedEvidence: best.evidence, matchedTokens: best.hits, reason: "no source-review evidence was provided for this checklist item" };
}

function normalizeRegisterOperationsForComparison(ops) {
  if (!Array.isArray(ops)) return [];
  return ops.map((op) => {
    if (typeof op === "string") return { register: "", operation: op, bitfields: [], access_type: "auto", intent: "auto", source_snippet: "" };
    return { register: String(op.register || "").trim(), operation: String(op.operation || "").trim(), bitfields: normalizeStringArray(op.bitfields), access_type: String(op.access_type || op.accessType || "auto").trim() || "auto", intent: String(op.intent || "auto").trim() || "auto", source_snippet: String(op.source_snippet || op.sourceSnippet || "").trim() };
  }).filter((op) => op.register || op.operation || op.source_snippet);
}

function buildRequirementSuggestedTools(filename, requirement) {
  const tools = [];
  const text = normalizeForSearch(`${requirement.area} ${requirement.item}`);
  const item = requirement.item.replace(/"/g, "'");
  const topic = `${requirement.area}: ${requirement.item}`.replace(/"/g, "'");
  if (/register|offset|bit|mask|access|reserved|clear|w1c|w0c|status|read|write/.test(text)) tools.push(`verify_register_usage(filename="${filename}", register="<source-register>", operation="${item}", access_type="auto", intent="auto")`);
  if (/sequence|start|stop|enable|disable|reset|init|initialize|operation|order/.test(text)) tools.push(`get_sequence(filename="${filename}", topic="${topic}")`);
  if (/caution|restriction|reserved|clear|write|only|undefined|prohibited/.test(text)) tools.push(`find_caution(filename="${filename}", topic="${topic}")`);
  if (/interrupt|irq|status|error|clear/.test(text)) tools.push(`hybrid_search_pdf(filename="${filename}", query="${topic}", intent="irq")`);
  if (!tools.length) tools.push(`hybrid_search_pdf(filename="${filename}", query="${topic}", intent="auto")`);
  return tools.slice(0, 4);
}

async function compareDriverRequirements(filename, options = {}) {
  ensurePdfFilename(filename);
  const implementedFeatures = normalizeStringArray(options.implementedFeatures);
  const sourceObservations = normalizeStringArray(options.sourceObservations);
  const missingFeatures = normalizeStringArray(options.missingFeatures);
  const sourceFiles = normalizeStringArray(options.sourceFiles);
  const sourceSummary = String(options.sourceSummary || "").trim();
  const registerOperations = normalizeRegisterOperationsForComparison(options.registerOperations);
  const checklist = await buildDriverCompletenessChecklist(filename, { subsystem: String(options.subsystem || "").trim(), driverFamily: String(options.driverFamily || "").trim(), profile: String(options.profile || "").trim(), task: String(options.task || "").trim() || "compare source features against driver requirements", createDefault: options.createDefault !== false });
  const requirements = flattenChecklistRequirements(checklist.profile);
  const implementedEvidence = [...implementedFeatures, ...sourceObservations, sourceSummary, ...registerOperations.map((op) => [op.register, op.operation, ...(op.bitfields || []), op.access_type, op.intent, op.source_snippet].join("\n"))].filter(Boolean);
  const compared = requirements.map((req) => classifyRequirementStatus(req, implementedEvidence, missingFeatures));
  for (const req of compared) req.suggestedTools = buildRequirementSuggestedTools(filename, req);
  const implemented = compared.filter((req) => req.status === "implemented_candidate");
  const unclear = compared.filter((req) => req.status === "unclear");
  const missing = compared.filter((req) => req.status === "missing" || req.status === "missing_or_not_reported");
  const manualVerification = new Map();
  for (const req of compared) {
    for (const check of req.requiredManualChecks || []) {
      const key = normalizeForSearch(check);
      if (!manualVerification.has(key)) manualVerification.set(key, { check, requirements: [] });
      manualVerification.get(key).requirements.push(req.id);
    }
  }
  for (const check of checklist.requiredManualChecks || []) {
    const key = normalizeForSearch(check);
    if (!manualVerification.has(key)) manualVerification.set(key, { check, requirements: [] });
  }
  const operationVerificationCalls = registerOperations.map((op) => {
    const bits = (op.bitfields || []).length ? `[${op.bitfields.map((b) => `"${String(b).replace(/"/g, "'")}"`).join(", ")}]` : "[]";
    return { register: op.register, operation: op.operation, call: `verify_register_usage(filename="${filename}", register="${(op.register || "<source-register>").replace(/"/g, "'")}", operation="${(op.operation || "<source-operation>").replace(/"/g, "'")}", bitfields=${bits}, access_type="${op.access_type || "auto"}", intent="${op.intent || "auto"}")` };
  });
  const totals = { requirements: compared.length, implemented: implemented.length, unclear: unclear.length, missing: missing.length, registerOperations: registerOperations.length };
  const completenessPercent = totals.requirements ? Math.round((totals.implemented / totals.requirements) * 100) : 0;
  const reviewStatus = totals.missing === 0 && totals.unclear === 0 ? "complete_candidate_needs_manual_verification" : totals.implemented === 0 ? "insufficient_source_evidence" : "partial_or_unclear";
  const visualGate = await collectDriverReviewVisualEvidence(filename, {
    include: options.includeVisualEvidence !== false,
    filter: options.visualFilter || `${checklist.task || ""} ${sourceSummary}`,
    task: checklist.task,
    moduleType: checklist.subsystem,
    sourceFiles,
    registers: registerOperations.map((op) => op.register).filter(Boolean),
    topK: 8,
    status: options.visualStatus || "all",
    gate: options.visualGate || "advisory",
    requireVerified: options.visualRequireVerified,
  });
  const visualEvidence = visualGate.entries;
  const warnings = [
    ...(checklist.warnings || []),
    ...visualEvidenceDriverWarnings(visualEvidence),
    "This comparison uses source-review input provided by the AI agent; the MCP server does not read the repository.",
    "implemented_candidate means source evidence appears to cover the item; it is not approved until register operations/manual facts are verified.",
  ];
  return { filename, createdAt: new Date().toISOString(), task: checklist.task, subsystem: checklist.subsystem, driverFamily: checklist.driverFamily || checklist.profile.driver_family || "", selectedProfile: checklist.selectedProfile, profile: checklist.profile, profileStack: checklist.profile._profileStack || [], sourceFiles, sourceSummary, implementedFeatures, sourceObservations, missingFeatures, registerOperations, requirements: compared, implemented, unclear, missing, manualVerification: [...manualVerification.values()], operationVerificationCalls, visualEvidence, totals, completenessPercent, reviewStatus, warnings };
}

function buildCompareDriverRequirementsContract(comparison) {
  const evidence = [makeEvidence({ source: "driver-profile-json", evidenceType: "checklist-profile", quote: `${comparison.selectedProfile}: ${(comparison.profileStack || []).join(" -> ") || comparison.profile?.title || "profile"}`, confidence: "high", name: comparison.selectedProfile, tool: "compare_driver_requirements" })];
  for (const item of (comparison.implemented || []).slice(0, 10)) evidence.push(makeEvidence({ source: "source-review-input", evidenceType: "implemented-feature-candidate", quote: `${item.id} ${item.area}: ${item.item}; matched: ${item.matchedEvidence || "n/a"}`, confidence: item.confidence, name: item.id, tool: "compare_driver_requirements" }));
  const inference = [makeInference({ statement: `Completeness candidate score: ${comparison.completenessPercent}% (${comparison.totals.implemented}/${comparison.totals.requirements})`, basis: "token/phrase matching between profile checklist and source-review input", confidence: "medium", risk: "This is a heuristic coverage estimate, not proof of driver correctness." }), makeInference({ statement: `Review status: ${comparison.reviewStatus}`, basis: `missing=${comparison.totals.missing}, unclear=${comparison.totals.unclear}`, confidence: "medium", risk: "A human/agent must verify source operations against manual evidence before approval." })];
  const needsVerification = [];
  for (const item of [...(comparison.unclear || []), ...(comparison.missing || [])].slice(0, 14)) needsVerification.push(makeNeedsVerification({ item: `${item.id} ${item.area}: ${item.item}`, reason: item.reason, suggestedTools: item.suggestedTools || [] }));
  if ((comparison.operationVerificationCalls || []).length) needsVerification.push(makeNeedsVerification({ item: "All register operations supplied by source review", reason: "Register operations must be verified against register/bitfield/sequence/caution evidence before approving the driver.", suggestedTools: comparison.operationVerificationCalls.slice(0, 8).map((op) => op.call) }));
  needsVerification.push(...visualEvidenceGateNeedsVerification(comparison.visualEvidenceGate || {}, comparison.filename));
  return makeEvidenceContract({ tool: "compare_driver_requirements", filename: comparison.filename, query: comparison.task || comparison.selectedProfile, evidence, inference, needsVerification, warnings: comparison.warnings || [], recommendedNextTools: [`driver_completeness_checklist(filename="${comparison.filename}", subsystem="${comparison.subsystem}", driver_family="${comparison.driverFamily}")`, `build_driver_evidence_pack(filename="${comparison.filename}", module_type="${comparison.subsystem}", focus="${String(comparison.task || "driver completeness review").replace(/"/g, "'")}", mode="adaptive")`, ...visualEvidenceGateSuggestedCalls(comparison.filename, comparison.visualEvidenceGate || {}), ...(comparison.operationVerificationCalls || []).slice(0, 6).map((op) => op.call)] });
}

function formatRequirementRows(rows, limit = 80) {
  const lines = [];
  if (!rows.length) return ["- none"];
  for (const item of rows.slice(0, limit)) {
    lines.push(`- ${item.id} [${item.status}; ${item.confidence}; score=${item.matchScore}; coverage=${item.matchCoverage}%] ${item.area}: ${item.item}`);
    if (item.matchedEvidence) lines.push(`  matched source evidence: ${item.matchedEvidence}`);
    if ((item.requiredManualChecks || []).length) lines.push(`  manual checks: ${item.requiredManualChecks.join("; ")}`);
    if ((item.suggestedTools || []).length) {
      lines.push("  suggested MCP calls:");
      for (const call of item.suggestedTools.slice(0, 3)) lines.push(`    - ${call}`);
    }
  }
  if (rows.length > limit) lines.push(`- ... ${rows.length - limit} more not shown`);
  return lines;
}

function formatCompareDriverRequirements(comparison) {
  const lines = [];
  lines.push("Driver Requirements Comparison");
  lines.push(`File: ${comparison.filename}`);
  lines.push(`Created: ${comparison.createdAt}`);
  lines.push(`Task: ${comparison.task || "not specified"}`);
  lines.push(`Subsystem: ${comparison.subsystem}`);
  lines.push(`Driver family: ${comparison.driverFamily || "not specified"}`);
  lines.push(`Selected profile: ${comparison.selectedProfile}`);
  lines.push(`Profile stack: ${(comparison.profileStack || []).join(" -> ") || comparison.selectedProfile}`);
  lines.push(`Review status: ${comparison.reviewStatus}`);
  lines.push(`Completeness candidate score: ${comparison.completenessPercent}%`);
  lines.push(`Summary: implemented=${comparison.totals.implemented}, unclear=${comparison.totals.unclear}, missing/not-reported=${comparison.totals.missing}, total=${comparison.totals.requirements}`);
  if ((comparison.sourceFiles || []).length) lines.push(`Source files inspected: ${comparison.sourceFiles.join(", ")}`);
  for (const warning of comparison.warnings || []) lines.push(`Warning: ${warning}`);
  lines.push("");
  lines.push("1. Source input received");
  lines.push(`- implemented_features: ${(comparison.implementedFeatures || []).length}`);
  lines.push(`- source_observations: ${(comparison.sourceObservations || []).length}`);
  lines.push(`- register_operations: ${(comparison.registerOperations || []).length}`);
  if (comparison.sourceSummary) lines.push(`- source_summary: ${compactText(comparison.sourceSummary, 1000)}`);
  lines.push("");
  lines.push("2. Implemented candidates");
  lines.push(...formatRequirementRows(comparison.implemented || []));
  lines.push("");
  lines.push("3. Unclear / partially covered requirements");
  lines.push(...formatRequirementRows(comparison.unclear || []));
  lines.push("");
  lines.push("4. Missing or not reported requirements");
  lines.push(...formatRequirementRows(comparison.missing || []));
  lines.push("");
  lines.push("5. Relevant persisted visual evidence");
  lines.push(...formatDriverVisualEvidenceSection(comparison.visualEvidence || [], comparison.filename).slice(1));
  lines.push("");

  lines.push("5b. Visual evidence verification gate");
  lines.push(...formatVisualEvidenceGateSection(comparison.visualEvidenceGate || {}, comparison.filename).slice(1));
  lines.push("");

  lines.push("6. Required manual verification topics");
  if ((comparison.manualVerification || []).length) for (const item of comparison.manualVerification) lines.push(`- ${item.check}${(item.requirements || []).length ? ` [requirements: ${item.requirements.slice(0, 12).join(", ")}]` : ""}`); else lines.push("- none");
  lines.push("");
  lines.push("7. Register operation verification calls");
  if ((comparison.operationVerificationCalls || []).length) for (const op of comparison.operationVerificationCalls) lines.push(`- ${op.call}`); else lines.push("- No register_operations were supplied. The VS Code agent should extract writel/readl/regmap/poll operations and rerun this tool.");
  lines.push("");
  lines.push("8. Approval rule");
  lines.push("- implemented_candidate is not final approval; it only means the supplied source review text appears to cover the checklist item.");
  lines.push("- Every hardware operation must be checked with verify_register_usage or an equivalent manual-evidence call.");
  lines.push("- Missing/unclear requirements must be resolved or explicitly justified before claiming driver completeness.");
  lines.push("");
  lines.push("Machine summary JSON:");
  lines.push(JSON.stringify({ filename: comparison.filename, reviewStatus: comparison.reviewStatus, completenessPercent: comparison.completenessPercent, totals: comparison.totals, selectedProfile: comparison.selectedProfile, sourceFiles: comparison.sourceFiles, visualEvidenceCount: (comparison.visualEvidence || []).length, missing: (comparison.missing || []).slice(0, 20).map((item) => ({ id: item.id, area: item.area, item: item.item, status: item.status })), unclear: (comparison.unclear || []).slice(0, 20).map((item) => ({ id: item.id, area: item.area, item: item.item, status: item.status })) }, null, 2));
  return appendEvidenceContract(lines.join("\n"), buildCompareDriverRequirementsContract(comparison));
}


// -----------------------------------------------------------------------------
// Source review prompt pack
// -----------------------------------------------------------------------------

function normalizeReviewDepth(value) {
  const raw = String(value || "standard").trim().toLowerCase();
  if (["quick", "standard", "deep"].includes(raw)) return raw;
  return "standard";
}

function normalizeReviewOutputFormat(value) {
  const raw = String(value || "report").trim().toLowerCase();
  if (["report", "checklist", "patch_plan", "debug_plan"].includes(raw)) return raw;
  return "report";
}

function quoteForPromptCall(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "'").replace(/\n/g, " ").trim();
}

function buildPlaceholderArray(values, fallback = "...") {
  const items = normalizeStringArray(values);
  if (!items.length) return fallback;
  return items.map((item) => `"${quoteForPromptCall(item)}"`).join(", ");
}

function sourceReviewDepthRules(depth) {
  if (depth === "quick") {
    return [
      "Inspect the specified source files and the main probe/open/stop/IRQ paths only.",
      "Extract high-confidence implemented_features and obvious missing/unclear items.",
      "Verify only hardware operations that are central to the requested task.",
    ];
  }
  if (depth === "deep") {
    return [
      "Inspect all related driver, subsystem glue, Kconfig/Makefile, Device Tree, and binding files reachable from the supplied source files.",
      "Extract every MMIO/regmap/readl/writel/poll/reset/clock/runtime-PM/IRQ/DT operation, not only the obvious ones.",
      "Call verify_register_usage for every hardware register operation before final approval.",
      "Treat unverified bit positions, reserved-bit handling, status clear semantics, and operation order as blockers.",
    ];
  }
  return [
    "Inspect the supplied source files plus directly referenced helper files in the same driver path.",
    "Extract implemented_features, missing_features, source_observations, and register_operations from source code.",
    "Call compare_driver_requirements, then verify all listed register operations.",
  ];
}

function sourceReviewOutputRules(format) {
  if (format === "patch_plan") {
    return [
      "Final output must be a patch plan, not a vague review.",
      "Group actions by source file and function.",
      "For every proposed hardware-register change, include the verify_register_usage evidence status.",
    ];
  }
  if (format === "debug_plan") {
    return [
      "Final output must be a debug plan with hypotheses, evidence, commands/tests, and expected observations.",
      "Separate source-code bug candidates from manual-evidence gaps.",
      "Do not propose register writes until verify_register_usage has been called for that register operation.",
    ];
  }
  if (format === "checklist") {
    return [
      "Final output must preserve the checklist structure: implemented / missing / unclear / blocked-by-manual-verification.",
      "Each checklist item must cite either source evidence or a missing/unclear reason.",
    ];
  }
  return [
    "Final output must be a structured review report.",
    "Use sections: summary, implemented, missing, unclear, manual evidence, register-operation verification, risks, next actions.",
  ];
}

async function buildSourceReviewPromptPack(filename, options = {}) {
  const task = String(options.task || "review Linux driver completeness against hardware manual").trim();
  const reviewDepth = normalizeReviewDepth(options.reviewDepth);
  const outputFormat = normalizeReviewOutputFormat(options.outputFormat);
  const sourceFiles = normalizeStringArray(options.sourceFiles);

  const checklist = await buildDriverCompletenessChecklist(filename, {
    subsystem: String(options.subsystem || "").trim(),
    driverFamily: String(options.driverFamily || "").trim(),
    profile: String(options.profile || "").trim(),
    task,
    createDefault: options.createDefault !== false,
  });

  const profile = checklist.profile || {};
  const subsystem = checklist.subsystem || normalizeDriverProfileHint(options.subsystem || profile.subsystem || "generic");
  const driverFamily = String(options.driverFamily || profile.driver_family || "").trim();
  const sourceFileText = sourceFiles.length ? sourceFiles : ["<discover relevant driver source files in VS Code workspace>"];

  const requiredFields = {
    source_files: sourceFileText,
    implemented_features: ["<feature/checklist item observed in source>"],
    missing_features: ["<feature/checklist item clearly missing or not supported>"],
    source_observations: ["<specific source observation, uncertainty, TODO, or risk>"],
    register_operations: [
      {
        register: "<register macro or manual register name>",
        operation: "<what the source does or intends to do>",
        bitfields: ["<bit macro/field>"],
        access_type: "raw_write|read_modify_write|set_bits|clear_bits|write_one_to_clear|write_zero_to_clear|poll|reset|read|write",
        intent: "init|start|stop|clear|irq|reset|error|status|configure|read|write",
        source_snippet: "<short relevant snippet>",
      },
    ],
  };

  const compareCall = [
    `compare_driver_requirements(`,
    `  filename="${filename}",`,
    `  subsystem="${quoteForPromptCall(subsystem)}",`,
    driverFamily ? `  driver_family="${quoteForPromptCall(driverFamily)}",` : null,
    checklist.selectedProfile ? `  profile="${quoteForPromptCall(checklist.selectedProfile)}",` : null,
    `  task="${quoteForPromptCall(task)}",`,
    `  source_files=[${buildPlaceholderArray(sourceFiles, '"<source files inspected>"')}],`,
    `  implemented_features=[...],`,
    `  missing_features=[...],`,
    `  source_observations=[...],`,
    `  register_operations=[...]`,
    `)`,
  ].filter(Boolean).join("\n");

  const registerVerifyCall = `verify_register_usage(filename="${filename}", register="<register>", operation="<source operation>", bitfields=[...], access_type="<access pattern>", intent="<intent>", source_snippet="<short snippet>")`;
  const visualGate = await collectDriverReviewVisualEvidence(filename, {
    include: options.includeVisualEvidence !== false,
    filter: options.visualFilter || task,
    task,
    moduleType: subsystem,
    sourceFiles,
    topK: 8,
    status: options.visualStatus || "all",
    gate: options.visualGate || "advisory",
    requireVerified: options.visualRequireVerified,
  });
  const visualEvidence = visualGate.entries;

  return {
    filename,
    createdAt: new Date().toISOString(),
    task,
    subsystem,
    driverFamily,
    selectedProfile: checklist.selectedProfile,
    profileStack: profile._profileStack || [checklist.selectedProfile].filter(Boolean),
    profileTitle: profile.title || checklist.selectedProfile,
    profileDescription: profile.description || "",
    sourceFiles: sourceFileText,
    sourceFilesProvided: sourceFiles,
    reviewDepth,
    outputFormat,
    depthRules: sourceReviewDepthRules(reviewDepth),
    outputRules: sourceReviewOutputRules(outputFormat),
    checklistAreas: (profile.checklist || []).map((area) => ({
      area: area.area || "Unnamed area",
      items: normalizeStringArray(area.items),
      requiredManualChecks: normalizeStringArray(area.required_manual_checks),
    })),
    requiredManualChecks: normalizeStringArray(checklist.requiredManualChecks || profile.required_manual_checks),
    sourceReviewSteps: normalizeStringArray(checklist.sourceReviewSteps || profile.source_review_steps),
    recommendedTools: normalizeStringArray(checklist.recommendedTools || profile.recommended_tools),
    visualEvidence,
    visualEvidenceGate: visualGate,
    mandatoryWorkflow: [
      `doctor(filename="${filename}")`,
      `driver_completeness_checklist(filename="${filename}", subsystem="${quoteForPromptCall(subsystem)}", driver_family="${quoteForPromptCall(driverFamily)}", profile="${quoteForPromptCall(checklist.selectedProfile)}", task="${quoteForPromptCall(task)}")`,
      `build_driver_evidence_pack(filename="${filename}", module_type="${quoteForPromptCall(subsystem)}", focus="${quoteForPromptCall(task)}", mode="adaptive")`,
      `visual_evidence_report(filename="${filename}", filter="${quoteForPromptCall(options.visualFilter || task)}", status="${quoteForPromptCall(options.visualStatus || "all")}", include_entries=true)`,
      compareCall,
      registerVerifyCall,
    ],
    requiredExtractionSchema: requiredFields,
    approvalRules: [
      "Do not claim a checklist item is complete unless source evidence exists and manual evidence requirements are either verified or explicitly marked not applicable.",
      "Do not treat MCP inference as hardware fact. Use read_pdf_pages/read_pdf_chunk/extract_bitfield_table/get_sequence/get_cautions_for_register/verify_register_usage for verification.",
      "Every source register operation must be either verified with verify_register_usage or listed as needsVerification/blocker.",
      "For raw writes, reserved-bit and unrelated-bit preservation must be checked before approval.",
      "For IRQ/status paths, clear semantics such as W1C/W0C must be checked before approval.",
      "If visual_gate is verified_only or block_unverified, resolve visual evidence blockers before approval.",
    ],
    warnings: [
      "MCP does not read the source repository. The VS Code agent must read files directly from the workspace and pass extracted source facts back to MCP.",
      "This prompt pack is an execution recipe. It is not itself evidence that the driver is complete.",
      ...(checklist.warnings || []),
      ...visualEvidenceGateWarnings(visualGate),
    ],
  };
}

function buildSourceReviewPromptPackContract(pack) {
  const evidence = [
    makeEvidence({
      source: "driver-profile-json",
      evidenceType: "source-review-workflow-profile",
      quote: `${pack.selectedProfile}: ${pack.profileTitle}; stack=${(pack.profileStack || []).join(" -> ")}`,
      confidence: "high",
      name: pack.selectedProfile,
      tool: "source_review_prompt_pack",
    }),
  ];
  evidence.push(...visualEvidenceToEvidenceContractItems(pack.visualEvidence || [], "source_review_prompt_pack"));

  const inference = [
    makeInference({
      statement: `Generated source-review workflow for subsystem=${pack.subsystem}, driverFamily=${pack.driverFamily || "not specified"}`,
      basis: `profile=${pack.selectedProfile}, reviewDepth=${pack.reviewDepth}, outputFormat=${pack.outputFormat}`,
      confidence: pack.subsystem === "generic" ? "low" : "medium",
      risk: "The VS Code agent must confirm the actual subsystem/family from source code.",
    }),
  ];

  const needsVerification = [
    makeNeedsVerification({
      item: "All source-code facts used by compare_driver_requirements",
      reason: "The MCP server does not inspect the source tree; implemented_features/register_operations must be extracted by the VS Code agent.",
      suggestedTools: ["compare_driver_requirements(...) after source extraction"],
    }),
    makeNeedsVerification({
      item: "Every hardware register operation found in source",
      reason: "Prompt pack only tells the agent what to verify; it does not verify register usage itself.",
      suggestedTools: ["verify_register_usage(...) for each readl/writel/regmap/poll/reset/status-clear operation"],
    }),
  ];

  needsVerification.push(...visualEvidenceGateNeedsVerification(pack.visualEvidenceGate || {}, pack.filename));

  return makeEvidenceContract({
    tool: "source_review_prompt_pack",
    filename: pack.filename,
    query: pack.task,
    evidence,
    inference,
    needsVerification,
    warnings: pack.warnings || [],
    recommendedNextTools: pack.mandatoryWorkflow || [],
  });
}

function formatSourceReviewPromptPack(pack) {
  const lines = [];
  lines.push("Source Review Prompt Pack");
  lines.push(`File: ${pack.filename}`);
  lines.push(`Created: ${pack.createdAt}`);
  lines.push(`Task: ${pack.task}`);
  lines.push(`Subsystem: ${pack.subsystem}`);
  lines.push(`Driver family: ${pack.driverFamily || "not specified"}`);
  lines.push(`Selected profile: ${pack.selectedProfile}`);
  lines.push(`Profile stack: ${(pack.profileStack || []).join(" -> ") || pack.selectedProfile}`);
  lines.push(`Review depth: ${pack.reviewDepth}`);
  lines.push(`Output format: ${pack.outputFormat}`);
  for (const warning of pack.warnings || []) lines.push(`Warning: ${warning}`);
  lines.push("");

  lines.push("Prompt to give the VS Code AI agent:");
  lines.push("```");
  lines.push(`You are reviewing Linux driver source code against a hardware manual through the local MCP server.`);
  lines.push(`Manual PDF: ${pack.filename}`);
  lines.push(`Task: ${pack.task}`);
  lines.push(`Subsystem/profile: ${pack.subsystem}${pack.driverFamily ? ` / ${pack.driverFamily}` : ""} / ${pack.selectedProfile}`);
  lines.push("");
  lines.push("Read source code directly from the VS Code workspace. The MCP server cannot read source files for you.");
  lines.push("Start with these files:");
  for (const file of pack.sourceFiles || []) lines.push(`- ${file}`);
  lines.push("");
  lines.push("Mandatory MCP workflow:");
  for (const call of pack.mandatoryWorkflow || []) lines.push(`- ${call}`);
  lines.push("");
  lines.push("Extraction requirements:");
  lines.push("1. Extract implemented_features: concise phrases that match checklist items actually seen in source.");
  lines.push("2. Extract missing_features: items clearly absent or unsupported.");
  lines.push("3. Extract source_observations: uncertainties, TODOs, assumptions, suspicious code paths, and DTS observations.");
  lines.push("4. Extract register_operations for every readl/writel/regmap_update_bits/read_poll_timeout/reset/status-clear operation.");
  lines.push("5. For each register operation, classify access_type and intent, then call verify_register_usage.");
  lines.push("");
  lines.push("Required extraction schema:");
  lines.push(JSON.stringify(pack.requiredExtractionSchema, null, 2));
  lines.push("");
  lines.push("Depth rules:");
  for (const rule of pack.depthRules || []) lines.push(`- ${rule}`);
  lines.push("");
  lines.push("Output rules:");
  for (const rule of pack.outputRules || []) lines.push(`- ${rule}`);
  lines.push("");
  lines.push("Approval rules:");
  for (const rule of pack.approvalRules || []) lines.push(`- ${rule}`);
  lines.push("```");
  lines.push("");

  lines.push("1. Checklist areas from selected profile");
  if ((pack.checklistAreas || []).length) {
    for (const [index, area] of pack.checklistAreas.entries()) {
      lines.push(`${index + 1}. ${area.area}`);
      for (const item of area.items || []) lines.push(`   - ${item}`);
      if ((area.requiredManualChecks || []).length) lines.push(`   manual checks: ${area.requiredManualChecks.join("; ")}`);
    }
  } else {
    lines.push("- No checklist areas found in selected profile.");
  }
  lines.push("");

  lines.push("2. Required manual checks");
  if ((pack.requiredManualChecks || []).length) for (const item of pack.requiredManualChecks) lines.push(`- ${item}`); else lines.push("- none listed by profile");
  lines.push("");

  lines.push("3. Source review steps from profile");
  if ((pack.sourceReviewSteps || []).length) for (const item of pack.sourceReviewSteps) lines.push(`- ${item}`); else lines.push("- Inspect source, extract operations, compare requirements, verify register usage.");
  lines.push("");

  lines.push("4. Persisted visual evidence to consider");
  lines.push(...formatDriverVisualEvidenceSection(pack.visualEvidence || [], pack.filename).slice(1));
  lines.push("");

  lines.push("4b. Visual evidence verification gate");
  lines.push(...formatVisualEvidenceGateSection(pack.visualEvidenceGate || {}, pack.filename).slice(1));
  lines.push("");

  lines.push("5. Mandatory MCP workflow");
  for (const call of pack.mandatoryWorkflow || []) lines.push(`- ${call}`);
  lines.push("");

  lines.push("5. Machine summary JSON:");
  lines.push(JSON.stringify({
    filename: pack.filename,
    task: pack.task,
    subsystem: pack.subsystem,
    driverFamily: pack.driverFamily,
    selectedProfile: pack.selectedProfile,
    reviewDepth: pack.reviewDepth,
    outputFormat: pack.outputFormat,
    sourceFiles: pack.sourceFiles,
    mandatoryWorkflow: pack.mandatoryWorkflow,
    visualEvidenceCount: (pack.visualEvidence || []).length,
    extractionSchemaKeys: Object.keys(pack.requiredExtractionSchema || {}),
  }, null, 2));

  return appendEvidenceContract(lines.join("\n"), buildSourceReviewPromptPackContract(pack));
}

// -----------------------------------------------------------------------------
// Driver evidence pack
// -----------------------------------------------------------------------------

function inferModuleType(filename, registers = [], sections = [], providedType = "") {
  const provided = String(providedType || "").trim().toLowerCase();
  if (provided) return provided;

  const haystack = normalizeForSearch([
    filename,
    ...registers.slice(0, 80).map((r) => `${r.name || ""} ${r.description || ""} ${(r.sections || []).map((s) => s.title).join(" ")}`),
    ...sections.slice(0, 40).map((s) => s.title || ""),
  ].join("\n"));

  const rules = [
    { type: "dmaengine", patterns: ["dma", "dmac", "direct memory access"] },
    { type: "watchdog", patterns: ["watchdog", "wdt"] },
    { type: "pwm/timer", patterns: ["pwm", "gpt", "general pwm timer", "timer"] },
    { type: "gpio", patterns: ["gpio", "port", "pin"] },
    { type: "i2c", patterns: ["i2c", "iic", "riic"] },
    { type: "spi", patterns: ["spi", "rsci", "serial peripheral"] },
    { type: "uart", patterns: ["uart", "scif", "sci", "serial communication"] },
    { type: "ethernet", patterns: ["ethernet", "geth", "gbeth", "mac", "phy"] },
    { type: "can", patterns: ["can", "canfd"] },
    { type: "adc", patterns: ["adc", "analog digital", "a d converter"] },
    { type: "rtc", patterns: ["rtc", "real time clock"] },
  ];

  for (const rule of rules) {
    if (rule.patterns.some((pattern) => haystack.includes(pattern))) return rule.type;
  }

  return "unknown";
}

function likelyLinuxSubsystem(moduleType) {
  const type = String(moduleType || "").toLowerCase();
  const mapping = new Map([
    ["dmaengine", "Linux dmaengine framework"],
    ["watchdog", "Linux watchdog framework"],
    ["pwm/timer", "Linux PWM framework and/or clocksource/clockevent/timer subsystem"],
    ["gpio", "Linux GPIO/pinctrl/IRQ subsystem"],
    ["i2c", "Linux I2C adapter framework"],
    ["spi", "Linux SPI controller framework"],
    ["uart", "Linux serial/TTY framework"],
    ["ethernet", "Linux netdev + phylink/PHY framework"],
    ["can", "Linux SocketCAN framework"],
    ["adc", "Linux IIO ADC framework"],
    ["rtc", "Linux RTC framework"],
  ]);
  return mapping.get(type) || "Unknown; infer from Linux source tree and module purpose.";
}

function classifyRegisterGroup(register) {
  const name = String(register.name || register.displayName || "");
  const desc = String(register.description || "");
  const text = `${name} ${desc}`.toUpperCase();

  if (/(_N[01]SA|_N[01]DA|_CRSA|_CRDA|SOURCE ADDRESS|DESTINATION ADDRESS)/.test(text)) return "Address registers";
  if (/(_N[01]TB|_CRTB|TRANSFER BYTE|TRANSFER COUNT|COUNT)/.test(text)) return "Transfer size/count registers";
  if (/(CHCTRL|CTRL|CONTROL|DCTRL|CR\b|WDTCR|GTCR)/.test(text)) return "Control registers";
  if (/(CHCFG|CFG|CONFIG|MODE|SETTING)/.test(text)) return "Configuration registers";
  if (/(CHSTAT|STATUS|STAT|_SR\b|DST_|ERROR|END|SUS|TC)/.test(text)) return "Status/error registers";
  if (/(INT|IRQ|IEN|IER|ISR|FLAG)/.test(text)) return "Interrupt registers";
  if (/(RESET|RST|SWRST)/.test(text)) return "Reset registers";
  if (/(COMPARE|CAPTURE|COUNTER|COUNT|PERIOD|GTCC|GTCNT)/.test(text)) return "Counter/compare/capture registers";
  if (/(DATA|FIFO|BUFFER|TX|RX)/.test(text)) return "Data/FIFO registers";
  if (/_N\b|_N$|_N\d|_N[01]|_CH|CHANNEL/.test(text)) return "Per-channel registers";
  return "Other registers";
}

function groupRegistersForDriverPack(registers) {
  const groups = new Map();
  for (const reg of registers) {
    const group = classifyRegisterGroup(reg);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(reg);
  }

  const preferred = [
    "Control registers",
    "Configuration registers",
    "Status/error registers",
    "Interrupt registers",
    "Address registers",
    "Transfer size/count registers",
    "Counter/compare/capture registers",
    "Reset registers",
    "Data/FIFO registers",
    "Per-channel registers",
    "Other registers",
  ];

  return preferred
    .filter((name) => groups.has(name))
    .map((name) => ({ name, registers: groups.get(name) }));
}

function scoreKeyRegisterForDriverPack(register, moduleType) {
  const name = String(register.name || register.displayName || "");
  const desc = String(register.description || "");
  const text = `${name} ${desc}`.toUpperCase();
  let score = 0;

  score += Math.min(Number(register.confidence || 0), 100) / 4;
  if (register.isExplicitRegister) score += 20;
  if ((register.chunks || []).length) score += 10;
  if ((register.pages || []).length) score += 6;
  if (/(CTRL|CONTROL|DCTRL|CHCTRL|CR\b|WDTCR|GTCR)/.test(text)) score += 45;
  if (/(CFG|CONFIG|MODE|SETTING|CHCFG)/.test(text)) score += 38;
  if (/(STAT|STATUS|CHSTAT|DST_|ERROR|ER\b|END|TC|SUS|SR\b)/.test(text)) score += 36;
  if (/(INT|IRQ|IEN|IER|ISR|FLAG)/.test(text)) score += 28;
  if (/(RESET|SWRST|RST)/.test(text)) score += 26;
  if (/(_SA|_DA|SOURCE ADDRESS|DESTINATION ADDRESS|_TB|TRANSFER BYTE|TRANSFER COUNT)/.test(text)) score += 22;

  const type = String(moduleType || "").toLowerCase();
  if (type.includes("dma")) {
    if (/(CHCTRL|CHSTAT|CHCFG|DCTRL|DST_|N0SA|N0DA|N0TB)/.test(text)) score += 25;
  } else if (type.includes("watchdog")) {
    if (/(WDTCR|WDTRR|WDTSR|WDTRCR)/.test(text)) score += 35;
  } else if (type.includes("pwm") || type.includes("timer")) {
    if (/(GTCR|GTCCR|GTST|GTINTAD|GTCNT|GTPR|GTBER)/.test(text)) score += 30;
  }

  return Math.round(score);
}

function selectKeyRegistersForDriverPack(registers, moduleType, topK) {
  return registers
    .map((reg) => ({ ...reg, driverPackScore: scoreKeyRegisterForDriverPack(reg, moduleType) }))
    .sort((a, b) => {
      if (b.driverPackScore !== a.driverPackScore) return b.driverPackScore - a.driverPackScore;
      const aPage = (a.pages || [Number.MAX_SAFE_INTEGER])[0];
      const bPage = (b.pages || [Number.MAX_SAFE_INTEGER])[0];
      if (aPage !== bPage) return aPage - bPage;
      return String(a.name || "").localeCompare(String(b.name || ""));
    })
    .slice(0, topK);
}

function sequenceTopicsForDriverPack(moduleType, focus = "") {
  const type = String(moduleType || "").toLowerCase();
  const topics = new Set([
    "initialization",
    "start operation",
    "stop operation",
    "reset",
    "software reset",
    "clear interrupt status",
    "clear status flag",
    "error handling",
  ]);

  if (focus) topics.add(focus);

  if (type.includes("dma")) {
    ["configure transfer", "start DMA transfer", "stop DMA transfer", "suspend channel", "clear transfer end", "clear error status", "interrupt handling"].forEach((t) => topics.add(t));
  } else if (type.includes("watchdog")) {
    ["start watchdog", "refresh watchdog", "restart watchdog", "timeout setting", "reset output"].forEach((t) => topics.add(t));
  } else if (type.includes("pwm") || type.includes("timer")) {
    ["start counter", "stop counter", "set period", "clear interrupt status", "output compare", "input capture"].forEach((t) => topics.add(t));
  } else if (type.includes("i2c")) {
    ["start condition", "stop condition", "transfer sequence", "interrupt handling", "bus reset"].forEach((t) => topics.add(t));
  } else if (type.includes("spi")) {
    ["transfer start", "transfer end", "FIFO operation", "interrupt handling", "reset"].forEach((t) => topics.add(t));
  }

  return [...topics].slice(0, DEFAULT_DRIVER_PACK_SEQUENCE_TOPICS + 6);
}

function cautionTopicsForDriverPack(moduleType, focus = "") {
  const type = String(moduleType || "").toLowerCase();
  const topics = new Set([
    "reserved bits",
    "write only when stopped",
    "write prohibited",
    "undefined",
    "invalid",
    "clear status flag",
    "write 1 to clear",
    "write 0 to clear",
    "interrupt status clear",
    "read modify write",
  ]);

  if (focus) topics.add(focus);

  if (type.includes("dma")) {
    ["channel enable", "channel stop", "transfer end clear", "error status", "suspend", "software reset"].forEach((t) => topics.add(t));
  } else if (type.includes("watchdog")) {
    ["refresh sequence", "write sequence", "timeout", "stop watchdog", "reset"].forEach((t) => topics.add(t));
  } else if (type.includes("pwm") || type.includes("timer")) {
    ["write while counting", "counter stopped", "interrupt clear", "buffer transfer", "output setting"].forEach((t) => topics.add(t));
  }

  return [...topics].slice(0, DEFAULT_DRIVER_PACK_CAUTION_TOPICS + 6);
}

function collectDriverPackBitfields(registerSummaries, limit = 80) {
  const map = new Map();
  for (const summary of registerSummaries) {
    const register = summary.registerEntry && (summary.registerEntry.displayName || summary.registerEntry.name || summary.register);
    for (const field of summary.bitfields || []) {
      const name = String(field.name || "").trim();
      if (!name) continue;
      const key = `${register || "unknown"}:${canonicalSymbol(name)}`;
      if (!map.has(key)) {
        map.set(key, {
          register,
          name,
          pages: new Set(),
          chunks: new Set(),
          evidence: [],
        });
      }
      const entry = map.get(key);
      for (const page of field.pages || []) entry.pages.add(page);
      for (const chunkId of field.chunks || []) entry.chunks.add(chunkId);
      for (const line of field.evidence || []) {
        if (entry.evidence.length < 3) entry.evidence.push(line);
      }
    }
  }

  return [...map.values()].slice(0, limit).map((entry) => ({
    ...entry,
    pages: [...entry.pages].sort((a, b) => a - b),
    chunks: [...entry.chunks].slice(0, 6),
  }));
}

function normalizeDriverPackMode(value) {
  const mode = String(value || DEFAULT_DRIVER_PACK_MODE).trim().toLowerCase();
  if (mode === "full") return "full";
  if (mode === "fast") return "fast";
  return "adaptive";
}

function clampDriverPackBudgetMs(value) {
  return clampInteger(value, DEFAULT_DRIVER_PACK_BUDGET_MS, MIN_DRIVER_PACK_BUDGET_MS, MAX_DRIVER_PACK_BUDGET_MS);
}

function createDriverPackBudget(budgetMs) {
  const startMs = Date.now();
  const maxMs = clampDriverPackBudgetMs(budgetMs);
  return {
    startMs,
    maxMs,
    deadlineMs: startMs + maxMs,
    elapsedMs() {
      return Date.now() - startMs;
    },
    remainingMs() {
      return Math.max(0, startMs + maxMs - Date.now());
    },
    hasTime(requiredMs = DRIVER_PACK_BUDGET_SAFETY_MS) {
      return this.remainingMs() > requiredMs;
    },
    snapshot() {
      return {
        timeBudgetMs: maxMs,
        elapsedMs: this.elapsedMs(),
        remainingMs: this.remainingMs(),
      };
    },
  };
}

function driverPackPerformanceNote(mode, requestedMode, partial, fallbackReason) {
  if (mode === "adaptive") {
    return "Adaptive mode is fast-first and budget-aware. It returns partial evidence plus targeted follow-up calls instead of switching to a full manual scan automatically.";
  }
  if (mode === "fast") {
    return "Fast mode uses persistent register/sequence/caution indexes and avoids expensive dynamic scans. Use targeted follow-up tools for details.";
  }
  if (mode === "full" && fallbackReason) {
    return `Full mode was requested, but the pack used timeout-safe fallback: ${fallbackReason}`;
  }
  if (mode === "full") {
    return "Full mode performs dynamic sequence/caution searches and can be slow on large manuals.";
  }
  return partial ? "Partial evidence pack returned due to tool budget." : "Driver evidence pack generated.";
}

function sequenceToDriverPackItem(sequence, topic, contextRegisters = []) {
  const firstChunk = (sequence.chunks || [])[0] || {};
  const firstPage = (sequence.pages || [firstChunk.page || 1])[0] || firstChunk.page || 1;
  const relatedRegisterSet = new Set((sequence.relatedRegisters || []).map(normalizeRegisterName));
  const register = contextRegisters.find((name) => relatedRegisterSet.has(normalizeRegisterName(name))) || "";

  return {
    topic,
    register,
    result: {
      id: firstChunk.id || sequence.id,
      page: firstPage,
      chunkIndex: firstChunk.chunkIndex || 0,
      score: sequence.matchScore || sequence.filterScore || sequence.score || 0,
      sequenceEvidence: (sequence.evidenceLines || firstChunk.evidenceLines || []).slice(0, MAX_SEQUENCE_EVIDENCE_LINES),
      headings: firstChunk.headings || [],
      registers: sequence.relatedRegisters || [],
      text: firstChunk.preview || "",
    },
    source: "persistent-sequence-index",
  };
}

function cautionToDriverPackItem(caution, topic, contextRegisters = []) {
  const firstChunk = (caution.chunks || [])[0] || {};
  const firstPage = (caution.pages || [firstChunk.page || 1])[0] || firstChunk.page || 1;
  const relatedRegisterSet = new Set((caution.relatedRegisters || []).map(normalizeRegisterName));
  const register = contextRegisters.find((name) => relatedRegisterSet.has(normalizeRegisterName(name))) || "";

  return {
    topic,
    register,
    result: {
      id: firstChunk.id || caution.id,
      page: firstPage,
      chunkIndex: firstChunk.chunkIndex || 0,
      score: caution.matchScore || caution.score || 0,
      cautionEvidence: (caution.evidenceLines || firstChunk.evidenceLines || []).slice(0, MAX_CAUTION_EVIDENCE_LINES),
      type: caution.type || "general",
      riskForDriver: caution.riskForDriver || "review required",
      registers: caution.relatedRegisters || [],
      text: firstChunk.preview || "",
    },
    source: "persistent-caution-index",
  };
}

async function collectDriverPackSequencesFast(filename, moduleType, focus, keyRegisters) {
  const topics = sequenceTopicsForDriverPack(moduleType, focus);
  const contextRegisters = keyRegisters.slice(0, 6).map((r) => r.displayName || r.name).filter(Boolean);
  let sequencesIndex;

  try {
    sequencesIndex = await loadSequencesIndex(filename);
    if (!sequencesIndex) return [];
  } catch {
    return [];
  }

  const selected = [];
  const selectedIds = new Set();

  for (const topic of topics) {
    const candidates = (sequencesIndex.sequences || [])
      .map((sequence) => {
        let score = scoreSequenceEntry(sequence, topic, "");
        const related = new Set((sequence.relatedRegisters || []).map(normalizeRegisterName));
        for (const reg of contextRegisters) {
          if (related.has(normalizeRegisterName(reg))) score += 45;
        }
        return { ...sequence, matchScore: score };
      })
      .filter((sequence) => sequence.matchScore > 0)
      .sort((a, b) => {
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        return Number(b.score || 0) - Number(a.score || 0);
      });

    const best = candidates[0];
    if (!best) continue;
    const key = best.id || `${best.topic}:${(best.pages || []).join(",")}`;
    if (selectedIds.has(key)) continue;
    selectedIds.add(key);
    selected.push(sequenceToDriverPackItem(best, topic, contextRegisters));
    if (selected.length >= DRIVER_PACK_FAST_SEQUENCE_LIMIT) break;
  }

  return selected;
}

async function collectDriverPackCautionsFast(filename, moduleType, focus, keyRegisters) {
  const topics = cautionTopicsForDriverPack(moduleType, focus);
  const contextRegisters = keyRegisters.slice(0, 6).map((r) => r.displayName || r.name).filter(Boolean);
  let cautionsIndex;

  try {
    cautionsIndex = await loadCautionsIndex(filename);
    if (!cautionsIndex) return [];
  } catch {
    return [];
  }

  const selected = [];
  const selectedIds = new Set();

  for (const topic of topics) {
    const candidates = (cautionsIndex.cautions || [])
      .map((caution) => {
        const matches = cautionMatchesFilter(caution, topic, "", "");
        const text = [
          caution.topic,
          caution.type,
          caution.riskForDriver,
          ...(caution.evidenceLines || []),
          ...(caution.relatedRegisters || []),
        ].join("\n");
        let score = (matches ? 70 : 0) + scoreSimpleText(text, topic) + Math.round(Number(caution.score || 0) / 6);
        const related = new Set((caution.relatedRegisters || []).map(normalizeRegisterName));
        for (const reg of contextRegisters) {
          if (related.has(normalizeRegisterName(reg))) score += 45;
        }
        return { ...caution, matchScore: score };
      })
      .filter((caution) => caution.matchScore > 0)
      .sort((a, b) => {
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        return Number(b.score || 0) - Number(a.score || 0);
      });

    const best = candidates[0];
    if (!best) continue;
    const key = best.id || `${best.topic}:${(best.pages || []).join(",")}`;
    if (selectedIds.has(key)) continue;
    selectedIds.add(key);
    selected.push(cautionToDriverPackItem(best, topic, contextRegisters));
    if (selected.length >= DRIVER_PACK_FAST_CAUTION_LIMIT) break;
  }

  return selected;
}

async function collectDriverPackSequences(filename, moduleType, focus, keyRegisters) {
  const topics = sequenceTopicsForDriverPack(moduleType, focus);
  const results = [];
  const contextRegisters = keyRegisters.slice(0, 4).map((r) => r.displayName || r.name).filter(Boolean);

  for (const topic of topics) {
    let best = null;
    const generic = await findSequenceInIndex(filename, topic, { topK: 3 });
    if (generic.results && generic.results.length) {
      best = { topic, register: "", result: generic.results[0] };
    }

    for (const register of contextRegisters) {
      const scoped = await findSequenceInIndex(filename, topic, { register, topK: 2 });
      if (scoped.results && scoped.results.length) {
        const candidate = scoped.results[0];
        if (!best || Number(candidate.score || 0) > Number(best.result.score || 0)) {
          best = { topic, register, result: candidate };
        }
      }
    }

    if (best) results.push(best);
  }

  return results;
}

async function collectDriverPackCautions(filename, moduleType, focus, keyRegisters) {
  const topics = cautionTopicsForDriverPack(moduleType, focus);
  const results = [];
  const contextRegisters = keyRegisters.slice(0, 4).map((r) => r.displayName || r.name).filter(Boolean);

  for (const topic of topics) {
    let best = null;
    const generic = await findCautionInIndex(filename, topic, { topK: 3 });
    if (generic.results && generic.results.length) {
      best = { topic, register: "", result: generic.results[0] };
    }

    for (const register of contextRegisters) {
      const scoped = await findCautionInIndex(filename, topic, { register, topK: 2 });
      if (scoped.results && scoped.results.length) {
        const candidate = scoped.results[0];
        if (!best || Number(candidate.score || 0) > Number(best.result.score || 0)) {
          best = { topic, register, result: candidate };
        }
      }
    }

    if (best) results.push(best);
  }

  return results;
}

function driverImplementationChecklist(moduleType) {
  const type = String(moduleType || "").toLowerCase();
  const common = [
    "Map MMIO resource and validate register offsets against manual evidence.",
    "Enable required clocks and deassert reset using the source tree's clock/reset data.",
    "Preserve reserved bits unless the manual explicitly says a raw write is allowed.",
    "Verify status clear semantics before writing interrupt/status registers.",
    "Implement probe error unwind and remove/shutdown paths.",
  ];

  if (type.includes("dma")) {
    return [
      "Use Linux dmaengine framework conventions: dma_device, virt-dma or appropriate channel model.",
      "Identify per-channel register stride and global register base offsets.",
      "Implement transfer preparation by programming source/destination/count/config registers from manual evidence.",
      "Implement issue_pending/start using the manual start/enable sequence.",
      "Implement terminate/suspend/reset using manual stop/reset restrictions.",
      "Handle transfer-end/error interrupts and clear status exactly as specified.",
      ...common,
    ];
  }

  if (type.includes("watchdog")) {
    return [
      "Use Linux watchdog framework conventions: watchdog_device and watchdog_ops.",
      "Derive min/max timeout from clock and prescaler/top settings.",
      "Implement start/stop/ping using the manual refresh/write sequence.",
      "Verify reset behavior and panic/restart behavior against manual cautions.",
      ...common,
    ];
  }

  if (type.includes("pwm") || type.includes("timer")) {
    return [
      "Use Linux PWM framework or timer subsystem according to driver goal.",
      "Verify counter start/stop restrictions before programming period/duty registers.",
      "Map output polarity/mode bits and status clear behavior from manual evidence.",
      "Handle shared-channel or paired-output constraints if present.",
      ...common,
    ];
  }

  return [
    "Select the Linux subsystem from the current source tree and module function.",
    "Identify the minimum register set for probe/init/start/stop/IRQ paths.",
    "Map each driver macro to manual register/bit-field evidence.",
    "Use find_sequence/find_caution for every register write involved in state changes.",
    ...common,
  ];
}

async function buildDriverEvidencePack(filename, options = {}) {
  const topRegisters = clampDriverPackRegisters(options.topRegisters);
  const topSummaries = clampDriverPackSummaries(options.topSummaries);
  const requestedMode = normalizeDriverPackMode(options.mode);
  const budget = createDriverPackBudget(options.budgetMs);
  const moduleTypeHint = String(options.moduleType || "").trim();
  const focus = String(options.focus || "").trim();
  const partialWarnings = [];
  const skippedPhases = [];
  const completedPhases = [];
  let effectiveMode = requestedMode;
  let fullFallbackReason = "";
  const fingerprint = sourceFingerprint(await getPdfSourceInfo(filename));

  const markPhase = (name) => completedPhases.push({ name, ...budget.snapshot() });
  const skipPhase = (name, reason) => {
    skippedPhases.push({ name, reason, ...budget.snapshot() });
    partialWarnings.push(`${name}: ${reason}`);
  };

  const indexData = await loadPdfIndex(filename);
  markPhase("load-pdf-index");

  const { registerIndex, results: registers } = await listRegistersFromIndex(filename, {
    topK: topRegisters,
    includeLowConfidence: false,
  });
  markPhase("list-registers");

  let overviewSections = [];
  let registerSections = [];
  let operationSections = [];
  let cautionSections = [];

  if (budget.hasTime(2500)) {
    const [overview, regDesc, operation, caution] = await Promise.all([
      searchSectionsIndex(filename, "overview", 5).catch(() => ({ results: [] })),
      searchSectionsIndex(filename, "register description", 6).catch(() => ({ results: [] })),
      searchSectionsIndex(filename, "operation procedure setting", 8).catch(() => ({ results: [] })),
      searchSectionsIndex(filename, "caution note restriction usage notes", 8).catch(() => ({ results: [] })),
    ]);
    overviewSections = overview.results || [];
    registerSections = regDesc.results || [];
    operationSections = operation.results || [];
    cautionSections = caution.results || [];
    markPhase("section-hints");
  } else {
    skipPhase("section-hints", "insufficient time budget");
  }

  const allSections = [...overviewSections, ...registerSections, ...operationSections, ...cautionSections];
  const moduleType = inferModuleType(filename, registers, allSections, moduleTypeHint);
  const keyRegisters = selectKeyRegistersForDriverPack(registers, moduleType, topSummaries);
  const registerSummaries = [];

  if (requestedMode === "full" && budget.maxMs < DRIVER_PACK_FULL_MIN_BUDGET_MS) {
    effectiveMode = "adaptive";
    fullFallbackReason = `budget_ms=${budget.maxMs} is below ${DRIVER_PACK_FULL_MIN_BUDGET_MS} ms required for full mode`;
    partialWarnings.push(fullFallbackReason);
  }

  const useFastSummaries = effectiveMode !== "full";
  for (const reg of keyRegisters) {
    const regName = reg.displayName || reg.name;
    if (!budget.hasTime(useFastSummaries ? 1200 : 6000)) {
      skipPhase(`summary:${regName}`, "time budget nearly exhausted; return partial pack and use summarize_register as follow-up");
      break;
    }
    try {
      if (useFastSummaries) {
        registerSummaries.push(summarizeRegisterEntryFast(filename, registerIndex, reg, indexData, Math.min(4, MAX_REGISTER_SUMMARY_CHUNKS)));
      } else {
        registerSummaries.push(await summarizeRegister(filename, regName, {
          topK: Math.min(8, MAX_REGISTER_SUMMARY_CHUNKS),
          includeBitfieldEvidence: true,
        }));
      }
    } catch (error) {
      registerSummaries.push({
        filename,
        register: regName,
        registerEntry: reg,
        relatedChunks: [],
        bitfields: [],
        reliability: `Failed to summarize register: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  markPhase("register-summaries");

  const bitfields = collectDriverPackBitfields(registerSummaries);
  let sequences = [];
  let cautions = [];

  if (budget.hasTime(effectiveMode === "full" ? 12000 : 1800)) {
    sequences = effectiveMode === "full"
      ? await collectDriverPackSequences(filename, moduleType, focus, keyRegisters)
      : await collectDriverPackSequencesFast(filename, moduleType, focus, keyRegisters);
    markPhase("sequence-candidates");
  } else {
    skipPhase("sequence-candidates", "time budget nearly exhausted; use get_sequence/find_sequence as follow-up");
  }

  if (budget.hasTime(effectiveMode === "full" ? 12000 : 1800)) {
    cautions = effectiveMode === "full"
      ? await collectDriverPackCautions(filename, moduleType, focus, keyRegisters)
      : await collectDriverPackCautionsFast(filename, moduleType, focus, keyRegisters);
    markPhase("caution-candidates");
  } else {
    skipPhase("caution-candidates", "time budget nearly exhausted; use get_cautions_for_register/find_caution as follow-up");
  }

  let visualEvidence = [];
  let visualEvidenceGate = { enabled: options.includeVisualEvidence !== false, statusFilter: options.visualStatus || "all", gate: options.visualGate || "advisory", requireVerified: false, entries: [], allEntries: [], verifiedEntries: [], unverifiedEntries: [], rejectedEntries: [], blockers: [], warnings: [] };
  if (budget.hasTime(700)) {
    visualEvidenceGate = await collectDriverReviewVisualEvidence(filename, {
      include: options.includeVisualEvidence !== false,
      filter: options.visualFilter || focus,
      focus,
      task: focus,
      moduleType,
      registers: keyRegisters.map((reg) => reg.displayName || reg.name).filter(Boolean),
      topK: clampInteger(options.visualTopK, 8, 1, 30),
      status: options.visualStatus || "all",
      gate: options.visualGate || "advisory",
      requireVerified: options.visualRequireVerified,
    });
    visualEvidence = visualEvidenceGate.entries;
    partialWarnings.push(...visualEvidenceGateWarnings(visualEvidenceGate));
    markPhase("visual-evidence");
  } else {
    skipPhase("visual-evidence", "time budget nearly exhausted; use visual_evidence_report as follow-up");
  }

  const groups = groupRegistersForDriverPack(registers);
  markPhase("finalize");

  const partial = skippedPhases.length > 0;
  const budgetSnapshot = budget.snapshot();

  return {
    filename,
    sourceFingerprint: fingerprint,
    createdAt: new Date().toISOString(),
    mode: effectiveMode,
    requestedMode,
    partial,
    partialWarnings,
    skippedPhases,
    completedPhases,
    budget: budgetSnapshot,
    performanceNote: driverPackPerformanceNote(effectiveMode, requestedMode, partial, fullFallbackReason),
    moduleType,
    moduleTypeHint,
    linuxSubsystem: likelyLinuxSubsystem(moduleType),
    focus,
    registerIndex,
    registers,
    groups,
    keyRegisters,
    registerSummaries,
    bitfields,
    sequences,
    cautions,
    visualEvidence,
    visualEvidenceGate,
    sections: {
      overview: overviewSections,
      registerDescription: registerSections,
      operation: operationSections,
      caution: cautionSections,
    },
    checklist: driverImplementationChecklist(moduleType),
  };
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  }

  const text = String(value || "").trim();
  if (!text) return [];

  return [...new Set(text.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean))];
}

function inferDriverTaskIntents(task, moduleType = "") {
  const normalized = normalizeForSearch(`${task} ${moduleType}`);
  const intents = new Set();

  if (/debug|bug|fail|failure|not|hang|timeout|does not|wrong|issue|problem|error|broken|regression/.test(normalized)) intents.add("debug");
  if (/implement|add|support|write|new feature|feature|enable/.test(normalized)) intents.add("implement");
  if (/probe|init|initialize|initial|clock|reset deassert|setup|configuration|configure/.test(normalized)) intents.add("init");
  if (/start|enable|run|kick|trigger|issue pending|transfer start|counter start/.test(normalized)) intents.add("start");
  if (/stop|disable|terminate|suspend|pause|halt|shutdown/.test(normalized)) intents.add("stop");
  if (/clear|status|flag|ack|acknowledge|complete|done|tc|end/.test(normalized)) intents.add("clear");
  if (/irq|interrupt|isr|handler|complete|completion|error interrupt/.test(normalized)) intents.add("irq");
  if (/reset|software reset|swrst|rst/.test(normalized)) intents.add("reset");
  if (/error|err|fault|bus error|overflow|underflow/.test(normalized)) intents.add("error");
  if (/reserved|prohibit|forbid|undefined|invalid|caution|restriction|note|write only|read only|write 1|write 0/.test(normalized)) intents.add("caution");
  if (/bit|field|mask|macro|define|position|shift|bitfield/.test(normalized)) intents.add("bitfield");
  if (/offset|address|register map|stride|base/.test(normalized)) intents.add("register-map");

  if (!intents.size) intents.add("general");
  return [...intents];
}

function sequenceTopicsForDriverTask(task, moduleType, intents) {
  const topics = new Set();
  const taskText = String(task || "").trim();
  if (taskText) topics.add(taskText);

  if (intents.includes("init")) {
    topics.add("initialization procedure");
    topics.add("initial setting procedure");
    topics.add("clock reset setting procedure");
  }
  if (intents.includes("start")) {
    topics.add("start operation");
    topics.add("enable operation sequence");
    topics.add("start transfer");
    topics.add("counter start");
  }
  if (intents.includes("stop")) {
    topics.add("stop operation");
    topics.add("disable operation sequence");
    topics.add("terminate suspend operation");
  }
  if (intents.includes("clear")) {
    topics.add("clear status flag");
    topics.add("clear interrupt status");
    topics.add("transfer complete clear");
  }
  if (intents.includes("irq")) {
    topics.add("interrupt handling");
    topics.add("interrupt source status clear");
    topics.add("error interrupt handling");
  }
  if (intents.includes("reset")) {
    topics.add("software reset procedure");
    topics.add("module reset sequence");
  }
  if (intents.includes("error")) {
    topics.add("error handling");
    topics.add("error status clear");
  }

  const type = String(moduleType || "").toLowerCase();
  if (type.includes("dma")) {
    topics.add("DMA transfer start procedure");
    topics.add("DMA transfer stop procedure");
    topics.add("DMA transfer end interrupt clear");
  } else if (type.includes("watchdog")) {
    topics.add("watchdog refresh sequence");
    topics.add("watchdog start operation");
  } else if (type.includes("pwm") || type.includes("timer")) {
    topics.add("counter start operation");
    topics.add("counter stop operation");
    topics.add("interrupt flag clear");
  }

  return [...topics].slice(0, 14);
}

function cautionTopicsForDriverTask(task, moduleType, intents) {
  const topics = new Set();
  const taskText = String(task || "").trim();

  topics.add("reserved bits");
  topics.add("write only when stopped");
  topics.add("write 1 to clear");
  topics.add("write 0 to clear");
  topics.add("undefined invalid prohibited");

  if (taskText) topics.add(taskText);
  if (intents.includes("clear")) {
    topics.add("clear status flag");
    topics.add("cleared by writing");
    topics.add("status flag clear semantics");
  }
  if (intents.includes("start") || intents.includes("stop")) {
    topics.add("write timing restriction");
    topics.add("operation order restriction");
    topics.add("must be set while stopped");
  }
  if (intents.includes("irq")) {
    topics.add("interrupt status clear");
    topics.add("interrupt enable restriction");
  }
  if (intents.includes("reset")) {
    topics.add("reset value restriction");
    topics.add("software reset caution");
  }

  const type = String(moduleType || "").toLowerCase();
  if (type.includes("dma")) {
    topics.add("channel enable disable restriction");
    topics.add("transfer end status clear");
  }

  return [...topics].slice(0, 14);
}

function sourceReviewChecklistForDriverTask(moduleType, intents) {
  const checklist = [
    "Read the relevant source files directly from the VS Code workspace; this MCP server intentionally does not read source code.",
    "Identify every register offset macro touched by the task and verify it against manual evidence.",
    "Identify every bit macro/mask/shift touched by the task and verify it with extract_bitfield_table/read_pdf_pages evidence.",
    "For each writel/readl/regmap_update_bits path, check sequence evidence and caution evidence before approving code.",
    "For every uncertain hardware detail, mark it explicitly instead of inventing a value.",
  ];

  if (intents.includes("irq") || intents.includes("clear")) {
    checklist.push("Inspect IRQ handler/status-clear path in source and verify write-1-to-clear/write-0-to-clear semantics from manual evidence.");
  }
  if (intents.includes("start")) {
    checklist.push("Inspect start/enable path and verify required ordering: configure registers, clear stale status, enable/start bit, interrupt enable.");
  }
  if (intents.includes("stop")) {
    checklist.push("Inspect terminate/stop/suspend path and verify whether the manual requires disable, wait, clear, or reset steps.");
  }
  if (intents.includes("init")) {
    checklist.push("Inspect probe/init path for MMIO, clocks, reset, IRQ request, runtime PM, and initial register programming.");
  }
  if (intents.includes("reset")) {
    checklist.push("Inspect reset paths and verify software-reset/self-clearing behavior and required wait/poll conditions.");
  }

  const type = String(moduleType || "").toLowerCase();
  if (type.includes("dma")) {
    checklist.push("For dmaengine code, inspect prep/issue_pending/terminate/IRQ/cookie-completion paths and channel stride calculations.");
  } else if (type.includes("watchdog")) {
    checklist.push("For watchdog code, inspect start/stop/ping/set_timeout/restart paths and timeout calculation from clock/prescaler/top fields.");
  } else if (type.includes("pwm") || type.includes("timer")) {
    checklist.push("For PWM/timer code, inspect apply/config/start/stop paths and paired-channel/shared-period constraints.");
  }

  return checklist;
}

async function resolveTaskRegisters(filename, focusRegisters, task, moduleType, topRegisters) {
  const selected = new Map();

  for (const reg of focusRegisters) {
    const { results } = await searchRegistersIndex(filename, reg, 5);
    for (const result of results) {
      const key = canonicalSymbol(result.name || result.displayName || reg);
      if (!selected.has(key)) selected.set(key, result);
    }
  }

  const { results: allRegisters } = await listRegistersFromIndex(filename, {
    topK: Math.max(topRegisters * 3, DEFAULT_DRIVER_PACK_REGISTERS),
    includeLowConfidence: false,
  });

  const normalizedTask = normalizeForSearch(task);
  const taskTokens = normalizedTask.split(/\s+/).filter((t) => t.length > 2);
  const type = String(moduleType || "").toLowerCase();

  const scored = allRegisters.map((reg) => {
    const name = reg.displayName || reg.name || "";
    const haystack = normalizeForSearch([
      name,
      reg.description || "",
      ...(reg.aliases || []),
      ...(reg.sections || []).map((s) => s.title || ""),
      ...(reg.headings || []),
    ].join("\n"));

    let score = Number(reg.driverPackScore || reg.confidence || 0);
    for (const token of taskTokens) if (haystack.includes(token)) score += 18;

    if (/start|enable|transfer|issue pending/.test(normalizedTask) && /ctrl|control|cfg|config|stat|status|en|enable/.test(haystack)) score += 36;
    if (/stop|disable|terminate|suspend/.test(normalizedTask) && /ctrl|control|stat|status|sus|suspend/.test(haystack)) score += 36;
    if (/clear|irq|interrupt|status|complete|error/.test(normalizedTask) && /stat|status|int|irq|er|err|tc|end|clear/.test(haystack)) score += 42;
    if (/reset|swrst/.test(normalizedTask) && /ctrl|control|reset|rst|swrst/.test(haystack)) score += 35;
    if (/offset|address|stride|map/.test(normalizedTask) && /address|offset|cfg|ctrl|stat|status/.test(haystack)) score += 20;

    if (type.includes("dma")) {
      if (/chctrl|chstat|chcfg|dctrl|dst|n0sa|n0da|n0tb|crsa|crda|crtb/i.test(name)) score += 26;
    } else if (type.includes("watchdog")) {
      if (/wdt|wdtrr|wdtcr|wdtsr|wdtrcr/i.test(name)) score += 30;
    }

    return { ...reg, taskScore: score };
  }).sort((a, b) => Number(b.taskScore || 0) - Number(a.taskScore || 0));

  for (const reg of scored) {
    const key = canonicalSymbol(reg.name || reg.displayName || "");
    if (!key || selected.has(key)) continue;
    selected.set(key, reg);
    if (selected.size >= topRegisters) break;
  }

  return [...selected.values()].slice(0, topRegisters);
}

async function collectTaskSequenceHints(filename, topics, registers) {
  const hints = [];
  const contextRegisters = registers.slice(0, 5).map((r) => r.displayName || r.name).filter(Boolean);

  for (const topic of topics) {
    let best = null;
    try {
      const generic = await getSequenceFromIndex(filename, topic, { topK: 3 });
      if (generic && generic.results && generic.results.length) best = { topic, register: "", result: generic.results[0] };
    } catch {}

    for (const register of contextRegisters) {
      try {
        const scoped = await getSequenceFromIndex(filename, topic, { register, topK: 2 });
        if (scoped && scoped.results && scoped.results.length) {
          const candidate = scoped.results[0];
          if (!best || Number(candidate.score || 0) > Number(best.result.score || 0)) best = { topic, register, result: candidate };
        }
      } catch {}
    }

    if (best) hints.push(best);
  }

  return hints;
}

async function collectTaskCautionHints(filename, topics, registers) {
  const hints = [];
  const contextRegisters = registers.slice(0, 6).map((r) => r.displayName || r.name).filter(Boolean);

  for (const topic of topics) {
    let best = null;
    try {
      const generic = await listCautionsFromIndex(filename, { filter: topic, topK: 3 });
      if (generic && generic.results && generic.results.length) best = { topic, register: "", result: generic.results[0] };
    } catch {}

    for (const register of contextRegisters) {
      try {
        const scoped = await getCautionsForRegister(filename, register, { filter: topic, topK: 2 });
        if (scoped && scoped.results && scoped.results.length) {
          const candidate = scoped.results[0];
          if (!best || Number(candidate.score || 0) > Number(best.result.score || 0)) best = { topic, register, result: candidate };
        }
      } catch {}
    }

    if (best) hints.push(best);
  }

  return hints;
}

async function buildDriverTaskPlan(filename, options = {}) {
  const task = String(options.task || "").trim();
  if (!task) throw new Error("task is required");

  const moduleTypeHint = String(options.moduleType || "").trim();
  const focusRegisters = normalizeStringArray(options.focusRegisters);
  const focusBitfields = normalizeStringArray(options.focusBitfields);
  const topRegisters = clampDriverTaskRegisters(options.topRegisters);
  const fingerprint = sourceFingerprint(await getPdfSourceInfo(filename));

  await loadPdfIndex(filename);
  const profile = await getModuleProfile(filename, {
    moduleType: moduleTypeHint,
    focus: task,
    refresh: false,
  });
  const moduleType = profile.moduleType || inferModuleType(filename, [], [], moduleTypeHint);
  const intents = inferDriverTaskIntents(task, moduleType);
  const taskRegisters = await resolveTaskRegisters(filename, focusRegisters, task, moduleType, topRegisters);
  const sequenceTopics = sequenceTopicsForDriverTask(task, moduleType, intents);
  const cautionTopics = cautionTopicsForDriverTask(task, moduleType, intents);
  const sequenceHints = await collectTaskSequenceHints(filename, sequenceTopics, taskRegisters);
  const cautionHints = await collectTaskCautionHints(filename, cautionTopics, taskRegisters);

  return {
    filename,
    sourceFingerprint: fingerprint,
    createdAt: new Date().toISOString(),
    task,
    moduleType,
    moduleTypeHint,
    linuxSubsystem: likelyLinuxSubsystem(moduleType),
    intents,
    focusRegisters,
    focusBitfields,
    taskRegisters,
    sequenceTopics,
    cautionTopics,
    sequenceHints,
    cautionHints,
    profile,
    sourceChecklist: sourceReviewChecklistForDriverTask(moduleType, intents),
  };
}


function normalizeRegisterUsageAccessType(value, operation = "") {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw && raw !== "auto") return raw;

  const text = normalizeForSearch(operation);
  if (/read\s*modify\s*write|rmw|update_bits|regmap_update_bits|set_bits|clear_bits/.test(text)) return "read_modify_write";
  if (/write[_\s-]?1|write\s+one|w1c/.test(text)) return "write_one_to_clear";
  if (/write[_\s-]?0|write\s+zero|w0c/.test(text)) return "write_zero_to_clear";
  if (/poll|wait|readl_poll|read_poll/.test(text)) return "poll";
  if (/readl|ioread|regmap_read|read register/.test(text) && !/writel|iowrite|write/.test(text)) return "read";
  if (/writel|iowrite|regmap_write|write register|raw write/.test(text)) return "raw_write";
  if (/reset|swrst/.test(text)) return "reset";
  if (/clear/.test(text)) return "clear_bits";
  return "write";
}

function inferRegisterUsageIntent(operation, accessType = "auto", explicitIntent = "auto") {
  const forced = String(explicitIntent || "auto").trim().toLowerCase();
  if (forced && forced !== "auto") return forced;

  const text = normalizeForSearch(`${operation} ${accessType}`);
  if (/init|initial|setup|configure|configuration|clock|reset release/.test(text)) return "init";
  if (/start|enable|run|activate|tx enable|rx enable|transmit|receive|seten/.test(text)) return "start";
  if (/stop|disable|halt|terminate|suspend|abort/.test(text)) return "stop";
  if (/clear|ack|acknowledge|w1c|w0c|write one|write zero|status flag/.test(text)) return "clear";
  if (/irq|interrupt|isr/.test(text)) return "irq";
  if (/reset|swrst|software reset/.test(text)) return "reset";
  if (/error|fault|err|abnormal/.test(text)) return "error";
  if (/status|poll|wait|read/.test(text)) return "status";
  if (/write/.test(text)) return "write";
  return "configure";
}

function registerUsageOperationTopic(operation, register, intent) {
  const op = String(operation || "").trim();
  const reg = String(register || "").trim();
  const intentText = String(intent || "").trim();
  return [op, reg, intentText].filter(Boolean).join(" ");
}

function bitfieldMatchesRequested(row, requested) {
  const canonicalRequested = canonicalSymbol(requested);
  const canonicalName = canonicalSymbol(row.bitfield || row.name || "");
  if (!canonicalRequested || !canonicalName) return false;
  return canonicalRequested === canonicalName || canonicalName.includes(canonicalRequested) || canonicalRequested.includes(canonicalName);
}

function assessBitfieldEvidence(requestedBitfields, bitfieldRows) {
  const rows = bitfieldRows || [];
  return (requestedBitfields || []).map((name) => {
    const match = rows.find((row) => bitfieldMatchesRequested(row, name));
    if (!match) {
      return {
        name,
        status: "not_found",
        confidence: "low",
        needsVerification: makeNeedsVerification({
          item: `${name} bit-field evidence`,
          reason: "Requested/source bit-field was not found in extracted bitfield table candidates.",
          suggestedTools: ["find_bitfield(...)", "read_pdf_pages(...)"],
        }),
      };
    }

    const missing = [];
    if (!match.bitRange || match.bitRange === "unknown") missing.push("bit/range");
    if (!match.access || match.access === "unknown") missing.push("access");
    if (!match.reset || match.reset === "unknown") missing.push("reset");

    return {
      name,
      status: missing.length ? "partial" : "found",
      confidence: confidenceLevel(match.confidence || 0),
      row: match,
      missing,
      needsVerification: missing.length ? makeNeedsVerification({
        item: `${name} ${missing.join("/")}`,
        reason: `Bit-field row was found but missing ${missing.join(", ")}.`,
        suggestedTools: ["extract_bitfield_table(...)", "read_pdf_pages(...)", "read_pdf_chunk(...)"],
      }) : null,
    };
  });
}

function cautionEvidenceIndicates(cautions, patterns) {
  const text = (cautions || []).map((c) => [
    c.topic,
    c.type,
    c.riskForDriver,
    ...(c.evidenceLines || []),
  ].join("\n")).join("\n");
  return patterns.some((pattern) => pattern.test(text));
}

function buildRegisterUsageAssessment(input, parts) {
  const accessType = input.accessType;
  const intent = input.intent;
  const cautions = parts.cautions?.results || [];
  const bitfieldAssessment = parts.bitfieldAssessment || [];
  const sequenceResult = parts.sequence;
  const needsVerification = [];
  const warnings = [];
  const recommendations = [];

  if (!parts.registerSummary?.registerEntry) {
    needsVerification.push(makeNeedsVerification({
      item: `${input.register} register identity`,
      reason: "Register was not strongly matched in the register index.",
      suggestedTools: [`find_register(filename="${input.filename}", register="${input.register}")`, `hybrid_search_pdf(filename="${input.filename}", query="${input.register} register offset", intent="register")`],
    }));
  }

  for (const item of bitfieldAssessment) {
    if (item.needsVerification) needsVerification.push(item.needsVerification);
  }

  const hasReservedWarning = cautionEvidenceIndicates(cautions, [/reserved/i, /do\s+not\s+write/i, /write\s+0/i, /write\s+1/i]);
  const hasClearSemantics = cautionEvidenceIndicates(cautions, [/write\s*-?1/i, /write\s+one/i, /w1c/i, /write\s*-?0/i, /write\s+zero/i, /w0c/i, /clear/i]);
  const hasTimingRestriction = cautionEvidenceIndicates(cautions, [/only\s+when/i, /while\s+stopped/i, /must\s+be\s+stopped/i, /before/i, /after/i]);

  if (["raw_write", "write", "set_bits", "clear_bits"].includes(accessType) && !hasReservedWarning) {
    needsVerification.push(makeNeedsVerification({
      item: "reserved-bit preservation",
      reason: "No explicit reserved-bit/RMW caution was found for this register operation. Raw writes may still be unsafe for hardware registers.",
      suggestedTools: [`get_cautions_for_register(filename="${input.filename}", register="${input.register}", filter="reserved bits")`, `read_pdf_pages(...)`],
    }));
  }

  if (["raw_write", "write"].includes(accessType) && input.bitfields.length) {
    warnings.push("Raw write with bitfield intent: verify whether read-modify-write is required to preserve unrelated/reserved bits.");
    recommendations.push("Prefer read-modify-write/update_bits if manual requires preserving reserved or unrelated bits.");
  }

  if ((intent === "clear" || accessType === "write_one_to_clear" || accessType === "write_zero_to_clear") && !hasClearSemantics) {
    needsVerification.push(makeNeedsVerification({
      item: "status clear semantics",
      reason: "Operation appears to clear status/IRQ flags, but W1C/W0C/clear semantics were not proven from caution/sequence evidence.",
      suggestedTools: [`get_sequence(filename="${input.filename}", topic="clear status", register="${input.register}")`, `get_cautions_for_register(filename="${input.filename}", register="${input.register}", filter="clear status")`],
    }));
  }

  if (["start", "stop", "reset", "init", "irq", "error"].includes(intent) && !sequenceResult?.persistentMatches?.length && !sequenceResult?.fallback?.results?.length) {
    needsVerification.push(makeNeedsVerification({
      item: `${intent} operation ordering`,
      reason: "No strong sequence evidence was found for the requested operation/register context.",
      suggestedTools: [`get_sequence(filename="${input.filename}", topic="${intent} operation", register="${input.register}")`, `hybrid_search_pdf(filename="${input.filename}", query="${input.operation}", register="${input.register}", intent="${intent}")`],
    }));
  }

  if (hasTimingRestriction) warnings.push("Timing/order restriction evidence exists. Verify source-code ordering around this register write.");

  const severity = needsVerification.length ? "needs_verification" : warnings.length ? "review_required" : "likely_ok";
  return { severity, warnings, recommendations, needsVerification };
}

async function verifyRegisterUsage(filename, options = {}) {
  const register = String(options.register || "").trim();
  const operation = String(options.operation || "").trim();
  if (!register) throw new Error("register is required");
  if (!operation) throw new Error("operation is required");

  const bitfields = normalizeStringArray(options.bitfields);
  const accessType = normalizeRegisterUsageAccessType(options.accessType, `${operation}\n${options.sourceSnippet || ""}`);
  const intent = inferRegisterUsageIntent(`${operation}\n${options.sourceSnippet || ""}`, accessType, options.intent || "auto");
  const topK = clampTopK(options.topK);
  const topic = registerUsageOperationTopic(operation, register, intent);

  const result = {
    filename,
    register,
    operation,
    accessType,
    intent,
    bitfields,
    sourceSnippet: String(options.sourceSnippet || "").slice(0, 2000),
    parts: {},
    assessment: null,
  };

  try {
    result.parts.registerSummary = await summarizeRegister(filename, register, {
      topK: Math.min(4, topK),
      includeBitfieldEvidence: true,
    });
  } catch (error) {
    result.parts.registerSummaryError = error instanceof Error ? error.message : String(error);
  }

  try {
    result.parts.bitfieldTable = await extractBitfieldTable(filename, register, {
      topK: Math.min(24, Math.max(topK, bitfields.length * 4 || topK)),
    });
    result.parts.bitfieldAssessment = assessBitfieldEvidence(bitfields, result.parts.bitfieldTable.rows || []);
  } catch (error) {
    result.parts.bitfieldTableError = error instanceof Error ? error.message : String(error);
    result.parts.bitfieldAssessment = bitfields.map((name) => ({
      name,
      status: "error",
      confidence: "low",
      needsVerification: makeNeedsVerification({
        item: `${name} bit-field evidence`,
        reason: result.parts.bitfieldTableError,
        suggestedTools: ["find_bitfield(...)", "read_pdf_pages(...)"],
      }),
    }));
  }

  try {
    result.parts.cautions = await getCautionsForRegister(filename, register, {
      filter: `${operation} ${intent} reserved bits clear status write timing`,
      topK: Math.min(8, topK),
    });
  } catch (error) {
    result.parts.cautionsError = error instanceof Error ? error.message : String(error);
  }

  try {
    result.parts.sequence = await getSequenceFromIndex(filename, topic, {
      register,
      topK: Math.min(5, topK),
    });
  } catch (error) {
    result.parts.sequenceError = error instanceof Error ? error.message : String(error);
  }

  try {
    result.parts.hybrid = await hybridSearchPdf(filename, topic, {
      register,
      intent,
      topK: Math.min(5, topK),
    });
  } catch (error) {
    result.parts.hybridError = error instanceof Error ? error.message : String(error);
  }

  result.assessment = buildRegisterUsageAssessment({
    filename,
    register,
    operation,
    accessType,
    intent,
    bitfields,
  }, {
    registerSummary: result.parts.registerSummary,
    bitfieldAssessment: result.parts.bitfieldAssessment,
    cautions: result.parts.cautions,
    sequence: result.parts.sequence,
  });

  return result;
}

function buildRegisterUsageEvidenceContract(result) {
  const evidence = [];
  const inference = [];
  const needsVerification = [...(result.assessment?.needsVerification || [])];
  const warnings = [...(result.assessment?.warnings || [])];

  const entry = result.parts.registerSummary?.registerEntry;
  if (entry) {
    evidence.push(makeEvidence({
      source: "register-index",
      evidenceType: "register-table",
      page: (entry.pages || [])[0],
      chunkId: (entry.chunks || [])[0]?.id || null,
      quote: `${entry.displayName || entry.name}: offset=${(entry.offsetAddresses || []).join(" | ") || "unknown"}, initial=${(entry.initialValues || []).join(" | ") || "unknown"}, accessSize=${(entry.accessSizes || []).join(" | ") || "unknown"}`,
      confidence: entry.confidence || "medium",
      name: entry.displayName || entry.name,
      field: "register",
      tool: "verify_register_usage",
    }));
  }

  for (const item of result.parts.bitfieldAssessment || []) {
    if (item.row) {
      evidence.push(makeEvidence({
        source: "bitfield-table",
        evidenceType: "bitfield-table",
        page: (item.row.pages || [])[0],
        chunkId: (item.row.chunks || [])[0] || null,
        quote: (item.row.evidenceLines || [])[0] || `${item.name}: bit=${item.row.bitRange || "unknown"}, access=${item.row.access || "unknown"}, reset=${item.row.reset || "unknown"}`,
        confidence: item.row.confidence || item.confidence,
        name: item.name,
        field: "bitfield",
        tool: "verify_register_usage",
      }));
    }
  }

  for (const caution of (result.parts.cautions?.results || []).slice(0, 6)) {
    evidence.push(makeEvidence({
      source: "caution-index",
      evidenceType: "caution",
      page: (caution.pages || [])[0],
      chunkId: (caution.chunks || [])[0]?.id || null,
      quote: (caution.evidenceLines || [])[0] || caution.riskForDriver || caution.topic,
      confidence: caution.confidence || caution.score || "medium",
      name: caution.topic,
      field: caution.type,
      tool: "verify_register_usage",
    }));
  }

  for (const sequence of (result.parts.sequence?.persistentMatches || []).slice(0, 4)) {
    evidence.push(makeEvidence({
      source: "sequence-index",
      evidenceType: "procedure",
      page: (sequence.pages || [])[0],
      chunkId: (sequence.chunks || [])[0]?.id || null,
      quote: (sequence.evidenceLines || [])[0] || sequence.topic,
      confidence: sequence.matchScore || sequence.score || "medium",
      name: sequence.topic,
      tool: "verify_register_usage",
    }));
  }

  for (const chunk of (result.parts.hybrid?.results || []).slice(0, 3)) {
    evidence.push(evidenceFromChunk(chunk, (chunk.hybridEvidenceLines || [])[0] || chunk.text || "", {
      tool: "verify_register_usage",
      confidence: chunk.score || "medium",
      name: result.register,
    }));
  }

  inference.push(makeInference({
    statement: `Operation classified as intent=${result.intent}, accessType=${result.accessType}, assessment=${result.assessment?.severity || "unknown"}`,
    basis: result.operation,
    confidence: "medium",
    risk: "Intent/access classification is heuristic from the source-code operation summary.",
  }));

  return makeEvidenceContract({
    tool: "verify_register_usage",
    filename: result.filename,
    query: `${result.register}: ${result.operation}`,
    evidence,
    inference,
    needsVerification,
    warnings,
    recommendedNextTools: [
      `summarize_register(filename="${result.filename}", register="${result.register}")`,
      `extract_bitfield_table(filename="${result.filename}", register="${result.register}")`,
      `get_cautions_for_register(filename="${result.filename}", register="${result.register}")`,
      `get_sequence(filename="${result.filename}", topic="${result.intent} operation", register="${result.register}")`,
    ],
  });
}

function formatVerifyRegisterUsage(result) {
  const lines = [];
  const summary = result.parts.registerSummary;
  const entry = summary?.registerEntry;
  const assessment = result.assessment || {};

  lines.push("Register Usage Verification");
  lines.push(`File: ${result.filename}`);
  lines.push(`Register: ${result.register}`);
  lines.push(`Operation: ${result.operation}`);
  lines.push(`Access type: ${result.accessType}`);
  lines.push(`Intent: ${result.intent}`);
  if (result.sourceSnippet) lines.push(`Source snippet: ${compactText(result.sourceSnippet, 500)}`);
  lines.push(`Assessment: ${assessment.severity || "unknown"}`);
  lines.push("");

  lines.push("1. Register evidence");
  if (entry) {
    lines.push(`- Match: ${entry.displayName || entry.name}`);
    lines.push(`- Description: ${(entry.descriptions || []).join(" | ") || "unknown"}`);
    lines.push(`- Offset: ${(entry.offsetAddresses || []).join(" | ") || "unknown"}`);
    lines.push(`- Initial/reset: ${(entry.initialValues || []).join(" | ") || "unknown"}`);
    lines.push(`- Access size: ${(entry.accessSizes || []).join(" | ") || "unknown"}`);
    lines.push(`- Pages: ${(entry.pages || []).join(", ") || "unknown"}`);
    lines.push(`- Reliability: ${summary.reliability || "unknown"}`);
  } else {
    lines.push("- Register index match: none or uncertain");
    if (result.parts.registerSummaryError) lines.push(`- Error: ${result.parts.registerSummaryError}`);
  }
  lines.push("");

  lines.push("2. Requested/source bit-field checks");
  if (result.bitfields.length) {
    for (const item of result.parts.bitfieldAssessment || []) {
      lines.push(`- ${item.name}: ${item.status}, confidence=${item.confidence}${item.missing?.length ? `, missing=${item.missing.join(", ")}` : ""}`);
      if (item.row) {
        lines.push(`  bit/range=${item.row.bitRange || "unknown"}, access=${item.row.access || "unknown"}, reset=${item.row.reset || "unknown"}, pages=${(item.row.pages || []).join(", ") || "unknown"}`);
      }
    }
  } else {
    lines.push("- No bitfields were provided by the source-code agent. Suggested: pass source macro names in bitfields=[...].");
  }
  if (result.parts.bitfieldTableError) lines.push(`- Bitfield table error: ${result.parts.bitfieldTableError}`);
  lines.push("");

  lines.push("3. Sequence / operation-order evidence");
  if (result.parts.sequence?.persistentMatches?.length) {
    for (const seq of result.parts.sequence.persistentMatches.slice(0, 4)) {
      lines.push(`- ${seq.topic}: pages ${(seq.pages || []).join(", ") || "unknown"}, score=${seq.matchScore || seq.score || "unknown"}`);
      for (const ev of (seq.evidenceLines || []).slice(0, 2)) lines.push(`  evidence: ${ev}`);
    }
  } else if (result.parts.sequence?.fallback) {
    lines.push("- No strong persistent sequence match; dynamic fallback exists. Inspect get_sequence output if needed.");
  } else {
    lines.push("- No strong sequence evidence found.");
    if (result.parts.sequenceError) lines.push(`- Error: ${result.parts.sequenceError}`);
  }
  lines.push("");

  lines.push("4. Caution / restriction evidence");
  if (result.parts.cautions?.results?.length) {
    for (const caution of result.parts.cautions.results.slice(0, 6)) {
      lines.push(`- ${caution.topic} [${caution.type || "general"}]: pages ${(caution.pages || []).join(", ") || "unknown"}, confidence=${caution.confidence}`);
      lines.push(`  risk: ${caution.riskForDriver || "review required"}`);
      for (const ev of (caution.evidenceLines || []).slice(0, 2)) lines.push(`  evidence: ${ev}`);
    }
  } else {
    lines.push("- No persistent caution evidence found for this register/operation.");
    if (result.parts.cautionsError) lines.push(`- Error: ${result.parts.cautionsError}`);
  }
  lines.push("");

  lines.push("5. Risks / warnings");
  if (assessment.warnings?.length) {
    for (const warning of assessment.warnings) lines.push(`- ${warning}`);
  } else {
    lines.push("- No explicit warnings from heuristic assessment.");
  }
  if (assessment.recommendations?.length) {
    lines.push("Recommendations:");
    for (const rec of assessment.recommendations) lines.push(`- ${rec}`);
  }
  lines.push("");

  lines.push("6. Needs verification before patch approval");
  if (assessment.needsVerification?.length) {
    for (const item of assessment.needsVerification) {
      lines.push(`- ${item.item}: ${item.reason}`);
      for (const tool of item.suggestedTools || []) lines.push(`  suggested: ${tool}`);
    }
  } else {
    lines.push("- None from heuristic assessment. Still verify exact source-code context before merging.");
  }

  return appendEvidenceContract(lines.join("\n"), buildRegisterUsageEvidenceContract(result));
}

function buildDriverTaskPlanEvidenceContract(plan) {
  const evidence = [];
  for (const item of (plan.sequenceHints || []).slice(0, 8)) {
    const r = item.result || {};
    const quote = (r.sequenceEvidence || r.evidenceLines || [])[0] || r.preview || "";
    evidence.push(makeEvidence({ source: "sequence-index", evidenceType: "procedure", page: r.page, chunkId: r.id || null, quote, confidence: r.score || r.matchScore || "medium", name: item.topic, tool: "prepare_driver_task" }));
  }
  for (const item of (plan.cautionHints || []).slice(0, 8)) {
    const r = item.result || {};
    const quote = (r.cautionEvidence || r.evidenceLines || [])[0] || r.riskForDriver || "";
    evidence.push(makeEvidence({ source: "caution-index", evidenceType: "caution", page: r.page || (r.pages || [])[0], chunkId: (r.chunks || [])[0]?.id || null, quote, confidence: r.score || r.matchScore || r.confidence || "medium", name: item.topic, tool: "prepare_driver_task" }));
  }
  const inference = [
    makeInference({ statement: `Task intents inferred as: ${(plan.intents || []).join(", ")}`, basis: plan.task, confidence: "medium", risk: "Intent classification drives workflow only; it is not manual evidence." }),
    makeInference({ statement: `Task-related registers selected: ${(plan.taskRegisters || []).slice(0, 12).map((r) => r.displayName || r.name).join(", ") || "none"}`, basis: "register index + task keyword scoring", confidence: "medium", risk: "Selected registers are candidates; verify source usage and manual summaries." }),
  ];
  const needsVerification = [makeNeedsVerification({
    item: "All source-code register writes related to this task",
    reason: "prepare_driver_task does not read source code; the VS Code agent must inspect source and map each writel/readl/regmap operation to manual evidence.",
    suggestedTools: ["summarize_register(...) for each source register macro", "extract_bitfield_table(...) for each bit/mask macro", "get_sequence(...) for operation order", "get_cautions_for_register(...) for write restrictions"],
  })];
  return makeEvidenceContract({
    tool: "prepare_driver_task",
    filename: plan.filename,
    sourceFingerprint: plan.sourceFingerprint,
    query: plan.task,
    evidence,
    inference,
    needsVerification,
    warnings: ["This is a workflow plan, not proof that source code is correct."],
    recommendedNextTools: [`build_driver_evidence_pack(filename="${plan.filename}", module_type="${plan.moduleType}", focus="${plan.task.replace(/"/g, "'")}")`, `hybrid_search_pdf(filename="${plan.filename}", query="${plan.task.replace(/"/g, "'")}", intent="auto")`],
  });
}

function formatDriverTaskPlan(plan) {
  const lines = [];
  const filename = plan.filename;

  lines.push("Driver Task Preparation Plan");
  lines.push(`File: ${filename}`);
  lines.push(`Created: ${plan.createdAt}`);
  lines.push(`Task: ${plan.task}`);
  lines.push("");

  lines.push("1. Module context");
  lines.push(`- Inferred module type: ${plan.moduleType}`);
  if (plan.moduleTypeHint) lines.push(`- User module type hint: ${plan.moduleTypeHint}`);
  lines.push(`- Likely Linux subsystem: ${plan.linuxSubsystem}`);
  lines.push(`- Detected task intents: ${plan.intents.join(", ")}`);
  lines.push(`- Source-code context: read directly from VS Code workspace; this MCP server is manual-only.`);
  lines.push("");

  lines.push("2. Mandatory MCP call sequence before editing source");
  lines.push(`- get_module_profile(filename="${filename}"${plan.moduleTypeHint ? `, module_type="${plan.moduleTypeHint}"` : ""})`);
  lines.push(`- build_driver_evidence_pack(filename="${filename}"${plan.moduleTypeHint ? `, module_type="${plan.moduleTypeHint}"` : ""}, focus="${plan.task.replace(/"/g, "'")}")`);
  lines.push(`- hybrid_search_pdf(filename="${filename}", query="${plan.task.replace(/"/g, "'")}", intent="auto")`);
  if (plan.intents.includes("register-map")) lines.push(`- extract_register_table(filename="${filename}")`);
  lines.push("");

  lines.push("3. Task-related registers to verify");
  if ((plan.taskRegisters || []).length) {
    for (const [index, reg] of plan.taskRegisters.entries()) {
      const name = reg.displayName || reg.name;
      const pages = (reg.pages || []).slice(0, 8).join(", ") || "unknown";
      const desc = reg.description ? ` — ${reg.description}` : "";
      lines.push(`${index + 1}. ${name}${desc}`);
      lines.push(`   Pages: ${pages}; confidence: ${reg.confidence || "unknown"}; task score: ${reg.taskScore || "n/a"}`);
      lines.push(`   Required calls:`);
      lines.push(`   - summarize_register(filename="${filename}", register="${name}")`);
      lines.push(`   - extract_bitfield_table(filename="${filename}", register="${name}")`);
      lines.push(`   - get_cautions_for_register(filename="${filename}", register="${name}")`);
    }
  } else {
    lines.push("- No task-related registers selected. Use list_registers and hybrid_search_pdf to discover candidates.");
  }
  lines.push("");

  lines.push("4. Focus bit fields to verify");
  if ((plan.focusBitfields || []).length) {
    const regs = (plan.taskRegisters || []).slice(0, 6).map((r) => r.displayName || r.name).filter(Boolean);
    for (const field of plan.focusBitfields) {
      if (regs.length) {
        for (const reg of regs.slice(0, 4)) lines.push(`- find_bitfield(filename="${filename}", register="${reg}", bitfield="${field}")`);
      } else {
        lines.push(`- find_bitfield(filename="${filename}", bitfield="${field}")`);
      }
    }
  } else {
    lines.push("- No explicit focus bit fields provided. Extract bitfield tables for task-related registers and verify source macros from the VS Code workspace.");
  }
  lines.push("");

  lines.push("5. Operation/sequence evidence to collect");
  for (const topic of plan.sequenceTopics) lines.push(`- get_sequence(filename="${filename}", topic="${topic}")`);
  if ((plan.sequenceHints || []).length) {
    lines.push("\nBest current sequence hints:");
    for (const item of plan.sequenceHints.slice(0, 8)) {
      const r = item.result || {};
      lines.push(`- ${item.topic}${item.register ? ` [${item.register}]` : ""}: page ${r.page || "?"}, score ${r.score || r.matchScore || "?"}`);
      for (const ev of (r.sequenceEvidence || r.evidenceLines || []).slice(0, 2)) lines.push(`  evidence: ${ev}`);
    }
  }
  lines.push("");

  lines.push("6. Caution/restriction evidence to collect");
  for (const topic of plan.cautionTopics) lines.push(`- list_cautions(filename="${filename}", filter="${topic}")`);
  if ((plan.taskRegisters || []).length) {
    for (const reg of plan.taskRegisters.slice(0, 6)) {
      const name = reg.displayName || reg.name;
      lines.push(`- get_cautions_for_register(filename="${filename}", register="${name}")`);
    }
  }
  if ((plan.cautionHints || []).length) {
    lines.push("\nBest current caution hints:");
    for (const item of plan.cautionHints.slice(0, 10)) {
      const r = item.result || {};
      lines.push(`- ${item.topic}${item.register ? ` [${item.register}]` : ""}: page ${r.page || "?"}, type ${r.type || "unknown"}, score ${r.score || r.matchScore || "?"}`);
      for (const ev of (r.cautionEvidence || r.evidenceLines || []).slice(0, 2)) lines.push(`  evidence: ${ev}`);
    }
  }
  lines.push("");

  lines.push("7. Required source-code checks for the VS Code agent");
  for (const item of plan.sourceChecklist || []) lines.push(`- ${item}`);
  lines.push("");

  lines.push("8. Approval rule before producing a patch");
  lines.push("- Do not approve or generate register/bit macros unless offsets and bit positions are backed by extract_register_table/extract_bitfield_table/read_pdf_pages evidence.");
  lines.push("- Do not approve status clear or interrupt code unless clear semantics are backed by get_sequence/get_cautions_for_register/read_pdf_pages evidence.");
  lines.push("- Do not approve start/stop/reset paths unless operation ordering is backed by get_sequence/find_sequence evidence.");
  lines.push("- If evidence is incomplete, mark the item as uncertain and ask the developer to verify the exact manual page/table.");

  const text = lines.join("\n");
  return appendEvidenceContract(text, buildDriverTaskPlanEvidenceContract(plan));
}

function buildDriverEvidencePackContract(pack) {
  const evidence = [];
  for (const reg of (pack.keyRegisters || []).slice(0, 8)) {
    evidence.push(makeEvidence({
      source: "register-index",
      evidenceType: "register-summary",
      page: (reg.pages || [])[0],
      quote: [reg.displayName || reg.name, reg.description || "", reg.offsetAddress || "", reg.accessSize || ""].filter(Boolean).join(" "),
      confidence: reg.confidence || reg.driverPackScore || "medium",
      name: reg.displayName || reg.name,
      tool: "build_driver_evidence_pack",
    }));
  }
  for (const field of (pack.bitfields || []).slice(0, 8)) {
    evidence.push(makeEvidence({
      source: "bitfield-index",
      evidenceType: "bitfield-table",
      page: (field.pages || [])[0],
      chunkId: (field.chunks || [])[0] || null,
      quote: (field.evidence || [])[0] || `${field.register || "unknown"}.${field.name}`,
      confidence: field.confidence || "medium",
      name: field.name,
      field: field.register || "",
      tool: "build_driver_evidence_pack",
    }));
  }
  for (const item of (pack.sequences || []).slice(0, 6)) {
    const r = item.result || {};
    evidence.push(makeEvidence({
      source: "sequence-index",
      evidenceType: "procedure",
      page: r.page,
      chunkId: r.id,
      quote: (r.sequenceEvidence || [])[0] || item.topic,
      confidence: r.score || "medium",
      name: item.topic,
      tool: "build_driver_evidence_pack",
    }));
  }
  for (const item of (pack.cautions || []).slice(0, 6)) {
    const r = item.result || {};
    evidence.push(makeEvidence({
      source: "caution-index",
      evidenceType: "caution",
      page: r.page,
      chunkId: r.id,
      quote: (r.cautionEvidence || [])[0] || item.topic,
      confidence: r.score || "medium",
      name: item.topic,
      tool: "build_driver_evidence_pack",
    }));
  }

  const inference = [
    makeInference({
      statement: `Module type inferred as ${pack.moduleType}`,
      basis: "register groups, section matches, and user hint",
      confidence: pack.moduleTypeHint ? "medium" : "low",
      risk: "Module identity drives workflow suggestions only; verify against source and manual chapter title.",
    }),
  ];

  const needsVerification = [
    makeNeedsVerification({
      item: "All register offsets, bit positions, and write semantics used in source code",
      reason: "The driver evidence pack collects candidates; final source changes require exact page/table verification.",
      suggestedTools: ["summarize_register(...)", "extract_bitfield_table(...)", "get_sequence(...)", "get_cautions_for_register(...)", "verify_register_usage(...)"],
    }),
  ];

  return makeEvidenceContract({
    tool: "build_driver_evidence_pack",
    filename: pack.filename,
    sourceFingerprint: pack.sourceFingerprint,
    query: pack.focus || pack.moduleType || "driver evidence pack",
    evidence,
    inference,
    needsVerification,
    warnings: [
      "Search-ranked and index-derived evidence is not final proof for driver-critical constants.",
      ...(pack.partialWarnings || []),
    ],
    recommendedNextTools: [
      `source_review_prompt_pack(filename="${pack.filename}", subsystem="${pack.moduleType}")`,
      `verify_register_usage(filename="${pack.filename}", register="<source register>", operation="<source operation>")`,
      `read_pdf_pages(filename="${pack.filename}", start_page=<page>, end_page=<page>)`,
    ],
  });
}

function formatDriverEvidencePack(pack) {
  const lines = [];
  const filename = pack.filename;

  lines.push(`Driver Evidence Pack`);
  lines.push(`File: ${filename}`);
  lines.push(`Created: ${pack.createdAt}`);
  lines.push(`Build mode: ${pack.mode || "adaptive"}`);
  if (pack.requestedMode && pack.requestedMode !== pack.mode) lines.push(`Requested mode: ${pack.requestedMode}`);
  if (pack.budget) lines.push(`Budget: ${pack.budget.elapsedMs} ms elapsed / ${pack.budget.timeBudgetMs} ms budget / ${pack.budget.remainingMs} ms remaining`);
  lines.push(`Partial result: ${pack.partial ? "yes" : "no"}`);
  if (pack.performanceNote) lines.push(`Performance note: ${pack.performanceNote}`);
  if (pack.partialWarnings && pack.partialWarnings.length) {
    lines.push("Partial warnings:");
    for (const warning of pack.partialWarnings.slice(0, 8)) lines.push(`- ${warning}`);
  }
  lines.push("");

  lines.push("1. Module identity");
  lines.push(`- Inferred module type: ${pack.moduleType}`);
  if (pack.moduleTypeHint) lines.push(`- User module type hint: ${pack.moduleTypeHint}`);
  if (pack.focus) lines.push(`- Focus: ${pack.focus}`);
  lines.push(`- Likely Linux subsystem: ${pack.linuxSubsystem}`);
  lines.push(`- Register index created: ${pack.registerIndex.createdAt}`);
  lines.push(`- Registers considered: ${(pack.registers || []).length} of ${pack.registerIndex.registerCount || (pack.registerIndex.registers || []).length || 0}`);
  lines.push("");

  lines.push("2. Relevant manual sections");
  const sectionGroups = [
    ["Overview", pack.sections.overview],
    ["Register description", pack.sections.registerDescription],
    ["Operation/setting", pack.sections.operation],
    ["Caution/usage notes", pack.sections.caution],
  ];
  for (const [label, sections] of sectionGroups) {
    const text = (sections || []).slice(0, 5).map((s) => `${s.title} (page ${s.page})`).join(" | ") || "not found";
    lines.push(`- ${label}: ${text}`);
  }
  lines.push("");

  lines.push("3. Register groups");
  if ((pack.groups || []).length) {
    for (const group of pack.groups) {
      const regs = group.registers.slice(0, 16).map((r) => r.displayName || r.name).join(", ");
      const suffix = group.registers.length > 16 ? `, ... (+${group.registers.length - 16} more)` : "";
      lines.push(`- ${group.name}: ${regs}${suffix}`);
    }
  } else {
    lines.push("- No register groups detected. Rebuild index or inspect list_registers output.");
  }
  lines.push("");

  lines.push("4. Key registers for driver work");
  if ((pack.keyRegisters || []).length) {
    for (const [index, reg] of pack.keyRegisters.entries()) {
      const name = reg.displayName || reg.name;
      const pages = (reg.pages || []).slice(0, 8).join(", ") || "unknown";
      const description = reg.description ? ` — ${reg.description}` : "";
      const offset = reg.offsetAddress ? `, offset: ${reg.offsetAddress}` : "";
      const initial = reg.initialValue ? `, initial: ${reg.initialValue}` : "";
      const access = reg.accessSize ? `, access size: ${reg.accessSize}` : "";
      lines.push(`${index + 1}. ${name}${description}`);
      lines.push(`   Pages: ${pages}${offset}${initial}${access}`);
      lines.push(`   Confidence: ${reg.confidence}; driver-pack score: ${reg.driverPackScore}`);
      lines.push(`   Suggested summary: summarize_register(filename="${filename}", register="${name}")`);
    }
  } else {
    lines.push("- No key registers selected.");
  }
  lines.push("");

  lines.push("5. Candidate bit fields from key register summaries");
  if ((pack.bitfields || []).length) {
    for (const field of pack.bitfields.slice(0, 40)) {
      const pages = field.pages.join(", ") || "unknown";
      lines.push(`- ${field.register || "unknown"}.${field.name} — pages: ${pages}; chunks: ${field.chunks.slice(0, 3).join(", ") || "none"}`);
      if (field.evidence && field.evidence.length) {
        for (const evidence of field.evidence.slice(0, 2)) lines.push(`  evidence: ${evidence}`);
      }
      if (field.register) lines.push(`  Suggested find: find_bitfield(filename="${filename}", register="${field.register}", bitfield="${field.name}")`);
    }
  } else {
    lines.push("- No bit-field candidates found from key register summaries. Use find_bitfield or read_pdf_pages around register pages.");
  }
  lines.push("");

  lines.push("6. Operation sequence candidates");
  if ((pack.sequences || []).length) {
    for (const item of pack.sequences.slice(0, 16)) {
      const r = item.result;
      const evidence = (r.sequenceEvidence || []).slice(0, 3);
      lines.push(`- ${item.topic}${item.register ? ` [register context: ${item.register}]` : ""}: page ${r.page}, chunk ${r.id}, score ${r.score}${item.source ? `, source=${item.source}` : ""}`);
      for (const line of evidence) lines.push(`  evidence: ${line}`);
      lines.push(`  Suggested read: read_pdf_pages(filename="${filename}", start_page=${r.page}, end_page=${Math.max(Number(r.page), Number(r.page) + DEFAULT_PAGE_RANGE - 1)})`);
    }
  } else {
    lines.push("- No sequence candidates found. Use find_sequence with a specific topic/register.");
  }
  lines.push("");

  lines.push("7. Caution / restriction candidates");
  if ((pack.cautions || []).length) {
    for (const item of pack.cautions.slice(0, 16)) {
      const r = item.result;
      const evidence = (r.cautionEvidence || []).slice(0, 3);
      lines.push(`- ${item.topic}${item.register ? ` [register context: ${item.register}]` : ""}: page ${r.page}, chunk ${r.id}, score ${r.score}${item.source ? `, source=${item.source}` : ""}`);
      for (const line of evidence) lines.push(`  evidence: ${line}`);
      lines.push(`  Suggested read: read_pdf_pages(filename="${filename}", start_page=${r.page}, end_page=${Math.max(Number(r.page), Number(r.page) + DEFAULT_PAGE_RANGE - 1)})`);
    }
  } else {
    lines.push("- No caution candidates found. Use find_caution with specific topics such as reserved bits or clear status flag.");
  }
  lines.push("");

  lines.push("8. Persisted visual evidence for driver review");
  lines.push(...formatDriverVisualEvidenceSection(pack.visualEvidence || [], filename).slice(1));
  lines.push("");

  lines.push("8b. Visual evidence verification gate");
  lines.push(...formatVisualEvidenceGateSection(pack.visualEvidenceGate || {}, filename).slice(1));
  lines.push("");

  lines.push("9. Driver implementation checklist for the VS Code agent");
  for (const item of pack.checklist || []) lines.push(`- ${item}`);
  lines.push("");

  lines.push("10. Unknowns and required verification");
  lines.push("- This evidence pack is heuristic. It does not prove exact bit positions unless the underlying page/chunk evidence clearly shows the bit table.");
  lines.push("- Verify offsets, bit ranges, reset values, access types, and clear semantics with read_pdf_pages/read_pdf_chunk before committing driver macros.");
  lines.push("- Use the VS Code workspace for Linux source, DTS, Kconfig, Makefile, binding YAML, and build/test logs. This MCP server is intentionally manual-only.");
  lines.push("");

  if (pack.skippedPhases && pack.skippedPhases.length) {
    lines.push("Skipped phases due to budget:");
    for (const phase of pack.skippedPhases.slice(0, 12)) lines.push(`- ${phase.name}: ${phase.reason} (elapsed=${phase.elapsedMs}ms, remaining=${phase.remainingMs}ms)`);
    lines.push("");
  }

  lines.push("11. Recommended next MCP calls");
  lines.push(`- list_registers(filename="${filename}", top_k=100)`);
  for (const reg of (pack.keyRegisters || []).slice(0, 6)) {
    const name = reg.displayName || reg.name;
    lines.push(`- summarize_register(filename="${filename}", register="${name}")`);
  }
  lines.push(`- find_sequence(filename="${filename}", topic="start operation")`);
  lines.push(`- find_caution(filename="${filename}", topic="reserved bits")`);
  lines.push(`- find_caution(filename="${filename}", topic="clear status flag")`);
  lines.push(`- visual_evidence_report(filename="${filename}", include_entries=true)`);
  lines.push(`- visual_review_handoff_pack(filename="${filename}", query="<clock/timing/reset/pinmux/interrupt visual topic>")`);

  return appendEvidenceContract(lines.join("\n"), buildDriverEvidencePackContract(pack));
}

function buildSectionQueries(section) {
  const raw = String(section || "").trim();
  const queries = new Set();

  queries.add(raw);
  queries.add(`${raw} section`);
  queries.add(`${raw} description`);
  queries.add(`${raw} operation`);
  queries.add(`${raw} setting`);

  return [...queries].filter(Boolean);
}

async function multiQuerySearch(filename, queries, topK) {
  const combined = new Map();

  for (const query of queries) {
    const { results } = await searchPdfIndex(filename, query, topK);

    for (const result of results) {
      const previous = combined.get(result.id);
      const merged = previous
        ? {
            ...previous,
            score: Math.max(previous.score, result.score) + Math.floor(Math.min(previous.score, result.score) * 0.1),
          }
        : result;

      combined.set(result.id, merged);
    }
  }

  return [...combined.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, clampTopK(topK));
}


// -----------------------------------------------------------------------------
// Step 39: workflow router and eval/static-hardening helpers
// -----------------------------------------------------------------------------

function uniqueNonEmptyStrings(values) {
  return [...new Set(normalizeStringArray(values).map((v) => v.trim()).filter(Boolean))];
}

function inferWorkflowFlags(taskText, moduleType, sourceFiles = []) {
  const text = `${taskText || ""} ${moduleType || ""} ${sourceFiles.join(" ")}`.toLowerCase();
  return {
    isDriverReview: /review|completeness|đánh giá|hoàn thiện|source|driver/.test(text),
    isDebug: /debug|bug|crash|fail|timeout|hang|irq|interrupt|dma|reset|reboot|lỗi/.test(text),
    isPatchPlan: /patch|implement|write|add|support|triển khai|sửa|fix/.test(text),
    needsVisual: /pinmux|pfc|table|layout|figure|diagram|mux|function|bảng|hình|timing/.test(text),
    needsRegisterVerification: /register|bit|field|writel|readl|regmap|irq|interrupt|dma|reset|clock|sequence|caution|reserved|clear/.test(text),
    needsEval: /eval|test|regression|hardening|smoke|verify|validate|coverage/.test(text),
  };
}

function q(value) {
  return JSON.stringify(value);
}

function workflowCall(tool, args = {}, why = "") {
  return { tool, args, why };
}

async function buildManualWorkflowPlan(options = {}) {
  const filename = String(options.filename || "").trim();
  const task = String(options.task || "driver/manual task").trim();
  const moduleType = normalizeDriverProfileHint(options.module_type || options.moduleType || "");
  const driverFamily = String(options.driver_family || options.driverFamily || "").trim();
  const sourceFiles = uniqueNonEmptyStrings(options.source_files || options.sourceFiles || []);
  const focusRegisters = uniqueNonEmptyStrings(options.focus_registers || options.focusRegisters || []);
  const focusBitfields = uniqueNonEmptyStrings(options.focus_bitfields || options.focusBitfields || []);
  const depth = ["quick", "standard", "deep"].includes(String(options.depth || "").toLowerCase()) ? String(options.depth).toLowerCase() : "standard";
  const outputFormat = ["report", "checklist", "patch_plan", "debug_plan"].includes(String(options.output_format || "").toLowerCase()) ? String(options.output_format).toLowerCase() : "report";
  const includeEval = options.include_eval === undefined ? true : Boolean(options.include_eval);
  const includeVisual = options.include_visual === undefined ? true : Boolean(options.include_visual);
  const flags = inferWorkflowFlags(task, moduleType, sourceFiles);

  let pdfHealth = null;
  if (filename) {
    const report = await doctorOnePdf(filename, { strict: false });
    pdfHealth = {
      filename,
      status: report.status || report.health || "unknown",
      summary: report.summary || null,
      blockingChecks: (report.checks || []).filter((c) => c.severity >= 2).map((c) => ({ name: c.name, status: c.status, message: c.message })),
    };
  }

  const calls = [];
  if (!filename) {
    calls.push(workflowCall("list_pdfs", {}, "Select the manual PDF before running file-specific evidence tools."));
  } else {
    calls.push(workflowCall("doctor", { filename, strict: false }, "Gate the workflow on usable core indexes and stale/broken artifacts."));
    calls.push(workflowCall("pdf_info", { filename }, "Confirm page count, index freshness, and generated artifact status."));
  }

  if (filename) {
    calls.push(workflowCall("get_module_profile", { filename, module_type: moduleType || undefined, focus: task }, "Build/read module orientation before driver-specific evidence collection."));
    calls.push(workflowCall("driver_completeness_checklist", { filename, subsystem: moduleType || undefined, driver_family: driverFamily || undefined, task }, "Generate the source-review checklist from the selected driver profile."));
    calls.push(workflowCall("build_driver_evidence_pack", { filename, module_type: moduleType || undefined, focus: task, top_registers: depth === "deep" ? 30 : 15, top_summaries: depth === "quick" ? 5 : 10 }, "Collect manual evidence anchors for registers, sequences, cautions, and summaries."));

    if (sourceFiles.length || flags.isDriverReview || flags.isPatchPlan || flags.isDebug) {
      calls.push(workflowCall("source_review_prompt_pack", {
        filename,
        subsystem: moduleType || undefined,
        driver_family: driverFamily || undefined,
        task,
        source_files: sourceFiles,
        review_depth: depth,
        output_format: outputFormat,
      }, "Give the VS Code agent a bounded source-inspection contract. MCP still does not read source files."));
    }

    if (focusRegisters.length) {
      for (const register of focusRegisters.slice(0, depth === "deep" ? 12 : 6)) {
        calls.push(workflowCall("find_register", { filename, register, top_k: 8 }, `Locate manual evidence for ${register}.`));
        calls.push(workflowCall("verify_register_usage", { filename, register, operation: "verify source-code register operation", bitfields: focusBitfields, access_type: "auto", intent: "auto" }, `Verify source operation semantics for ${register}; required before driver-critical conclusions.`));
      }
    } else if (flags.needsRegisterVerification || depth === "deep") {
      calls.push(workflowCall("list_registers", { filename, query: task, top_k: depth === "deep" ? 30 : 15, include_low_confidence: false }, "Find candidate registers, then verify each source-code read/write operation explicitly."));
      calls.push(workflowCall("verify_register_usage", { filename, register: "<register_seen_in_source>", operation: "<readl/writel/regmap operation from source>", bitfields: ["<bitfields_seen_in_source>"], access_type: "auto", intent: "auto", source_snippet: "<short source snippet>" }, "Repeat once per driver-critical register operation observed in the source tree."));
    }

    if (includeVisual && flags.needsVisual) {
      calls.push(workflowCall("extract_layout_tables_from_pages", { filename, start_page: "<page>", end_page: "<page>" }, "Use layout-aware extraction for wide manual tables."));
      calls.push(workflowCall("visual_review_handoff_pack", { filename, task, pages: [] }, "Generate render/region instructions when text extraction is not trustworthy."));
      calls.push(workflowCall("verify_visual_evidence", { filename, evidence_id: "<id>", status: "verified", note: "<human-checked table/figure meaning>" }, "Driver-critical table/figure evidence should be verified before use."));
    }

    calls.push(workflowCall("compare_driver_requirements", {
      filename,
      subsystem: moduleType || undefined,
      driver_family: driverFamily || undefined,
      task,
      source_files: sourceFiles,
      implemented_features: ["<facts observed in source>"],
      missing_features: ["<facts proven missing in source>"],
      source_observations: ["<unclear/TODO/source notes>"],
      register_operations: [{ register: "<register>", operation: "<operation>", bitfields: ["<bitfield>"], access_type: "auto", intent: "auto" }],
    }, "Final manual-vs-source matrix after the VS Code agent has inspected source files."));
  }

  if (includeEval || flags.needsEval) {
    calls.push(workflowCall("eval_health_check", { create_default: true, include_profiles: true, include_fixtures: true, write_report: true }, "Static hardening check after tool/profile/eval changes."));
    if (filename) calls.push(workflowCall("run_eval", { filename, module_type: moduleType || undefined, eval_profile: moduleType || undefined, auto_index: false, write_report: true }, "Run data-driven smoke/regression cases against the selected manual."));
  }

  const gates = [
    "Do not produce driver-critical conclusions from search_pdf alone; use register/bitfield/sequence/caution evidence.",
    "Every source-code readl/writel/regmap operation that affects hardware state must be checked with verify_register_usage when possible.",
    "For pinmux, bit tables, timing diagrams, and wide tables, use visual/layout evidence and mark unverified evidence as needs_verification.",
    "MCP does not read the source repo; source observations must come from the VS Code agent and be passed back into compare_driver_requirements.",
  ];

  return { schemaVersion: "step39.workflow.v1", serverVersion: SERVER_VERSION, createdAt: new Date().toISOString(), task, filename: filename || null, moduleType, driverFamily, sourceFiles, depth, outputFormat, flags, pdfHealth, recommendedCalls: calls, evidenceGates: gates };
}

function formatManualWorkflowPlan(plan) {
  const lines = [
    "Manual Workflow Plan",
    `Created: ${plan.createdAt}`,
    `Task: ${plan.task}`,
    `File: ${plan.filename || "not selected"}`,
    `Module type: ${plan.moduleType || "not provided"}`,
    `Driver family: ${plan.driverFamily || "not provided"}`,
    `Depth: ${plan.depth}`,
    `Output format: ${plan.outputFormat}`,
    "",
  ];
  if (plan.pdfHealth) {
    lines.push("PDF health:");
    lines.push(`- Status: ${plan.pdfHealth.status}`);
    if (plan.pdfHealth.blockingChecks.length) {
      for (const check of plan.pdfHealth.blockingChecks) lines.push(`- Blocker: ${check.name}: ${check.message || check.status || "problem"}`);
    } else lines.push("- No blocking core check reported by doctor.");
    lines.push("");
  }
  lines.push("Recommended MCP call sequence:");
  plan.recommendedCalls.forEach((call, index) => {
    lines.push(`${index + 1}. ${call.tool}(${JSON.stringify(call.args)})`);
    if (call.why) lines.push(`   why: ${call.why}`);
  });
  lines.push("", "Evidence gates:");
  for (const gate of plan.evidenceGates) lines.push(`- ${gate}`);
  return lines.join("\n");
}

const TOOL_USAGE_CATALOG = {
  list_pdfs: { when: "Find available manuals.", next: "pdf_info or doctor", trust: "navigation" },
  doctor: { when: "Check index/artifact health before evidence work.", next: "index_pdf/start_index_pdf or get_module_profile", trust: "health gate" },
  index_pdf: { when: "Build indexes synchronously for small/medium manuals.", next: "doctor", trust: "artifact builder" },
  start_index_pdf: { when: "Build indexes for 500/800/1000+ page manuals without MCP timeout.", next: "job_status", trust: "artifact builder" },
  hybrid_search_pdf: { when: "Recall-oriented search using BM25/synonyms/proximity; good for finding candidate evidence.", next: "read_pdf_pages/find_register/find_bitfield", trust: "hint, not final driver evidence" },
  find_register: { when: "Locate a specific register or macro in the manual.", next: "summarize_register/find_bitfield/verify_register_usage", trust: "manual evidence candidate" },
  find_bitfield: { when: "Locate a bitfield/macro and candidate semantics.", next: "verify_register_usage", trust: "manual evidence candidate" },
  list_sequences: { when: "Find start/stop/reset/initialization sequences.", next: "get_sequence or verify_register_usage", trust: "sequence evidence" },
  list_cautions: { when: "Find restrictions/cautions/reserved-bit/clear-semantics notes.", next: "get_cautions_for_register", trust: "risk evidence" },
  extract_layout_tables_from_pages: { when: "Wide tables where text extraction may collapse columns.", next: "visual_review_handoff_pack/add_visual_evidence", trust: "layout hint" },
  visual_review_handoff_pack: { when: "Prepare human/agent visual review for figures, pinmux, bit tables, timing diagrams.", next: "add_visual_evidence/verify_visual_evidence", trust: "handoff" },
  verify_visual_evidence: { when: "Mark visual/table evidence as verified/rejected/needs_verification.", next: "driver_completeness_checklist/source_review_prompt_pack", trust: "verified visual evidence if status=verified" },
  driver_completeness_checklist: { when: "Create subsystem/profile checklist for source review.", next: "source_review_prompt_pack", trust: "review contract" },
  build_driver_evidence_pack: { when: "Collect module-level manual anchors for driver review/debug.", next: "source_review_prompt_pack", trust: "evidence pack" },
  source_review_prompt_pack: { when: "Tell VS Code agent what source facts to extract and which MCP calls to make.", next: "verify_register_usage", trust: "workflow contract" },
  verify_register_usage: { when: "Verify a readl/writel/regmap/register operation from source against manual semantics.", next: "compare_driver_requirements", trust: "strongest register-operation evidence" },
  compare_driver_requirements: { when: "Final source-observation vs manual/profile matrix.", next: "final report/patch plan", trust: "synthesis; depends on source observations quality" },
  plan_manual_workflow: { when: "First tool when task is ambiguous or multi-step.", next: "follow recommendedCalls", trust: "router" },
  eval_health_check: { when: "After modifying MCP code/eval/profile files or when using Step 40 control-plane actions such as ping/index_status_lite/rebuild_artifact/job_status/list_jobs.", next: "run_eval/npm test or eval_health_check(step40_action=compat_report)", trust: "static hardening and Step 40 compatibility control-plane" },
  run_eval: { when: "Run regression/smoke cases against a manual.", next: "fix failures or add fixtures", trust: "regression signal" },
};

function formatToolUsage(toolName = "", task = "") {
  const name = String(toolName || "").trim();
  const lines = ["MCP Tool Usage Guide"];
  if (task) lines.push(`Task context: ${task}`);
  lines.push("");
  if (name) {
    const entry = TOOL_USAGE_CATALOG[name];
    if (!entry) return [`MCP Tool Usage Guide`, `Unknown tool: ${name}`, "", `Available tools: ${Object.keys(TOOL_USAGE_CATALOG).sort().join(", ")}`].join("\n");
    lines.push(`${name}`);
    lines.push(`- when: ${entry.when}`);
    lines.push(`- next: ${entry.next}`);
    lines.push(`- trust: ${entry.trust}`);
    return lines.join("\n");
  }
  for (const key of Object.keys(TOOL_USAGE_CATALOG).sort()) {
    const entry = TOOL_USAGE_CATALOG[key];
    lines.push(`- ${key}: ${entry.when} Next: ${entry.next}. Trust: ${entry.trust}.`);
  }
  lines.push("", "Default driver-review flow: plan_manual_workflow -> doctor -> get_module_profile -> build_driver_evidence_pack -> source_review_prompt_pack -> verify_register_usage per source operation -> compare_driver_requirements.");
  return lines.join("\n");
}

function buildStep407CompatibilityReport() {
  return {
    schemaVersion: "step40.7.compatibility.v1",
    serverVersion: SERVER_VERSION,
    createdAt: nowIso(),
    mode: STEP40_COMPAT_MODE,
    health: "PASS_WITH_COMPATIBILITY_WORKAROUND",
    supportedInterface: "eval_health_check(step40_action=...)",
    supportedActions: STEP40_CONTROL_ACTIONS,
    hiddenDirectTools: [
      "mcp_server_ping",
      "pdf_index_status_lite",
      "index_status",
      "rebuild_artifact",
      "cancel_job",
      "cleanup_jobs"
    ],
    stillAvailableLegacyHandlers: true,
    notes: STEP40_DIRECT_TOOL_COMPAT_NOTES,
    recommendedCalls: [
      'eval_health_check(step40_action="ping")',
      'eval_health_check(step40_action="index_status_lite", filename="<manual>.pdf")',
      'eval_health_check(step40_action="rebuild_artifact", filename="<manual>.pdf", artifact="pages")',
      'eval_health_check(step40_action="job_status", job_id="<job_id>")',
      'eval_health_check(step40_action="list_jobs")'
    ]
  };
}

function formatStep407CompatibilityReport(report) {
  const lines = [
    "Step 40.7 MCP compatibility report",
    `Server version: ${report.serverVersion}`,
    `Health: ${report.health}`,
    `Mode: ${report.mode}`,
    `Supported interface: ${report.supportedInterface}`,
    "",
    "Supported Step 40 actions via eval_health_check:",
    ...report.supportedActions.map((a) => `- ${a}`),
    "",
    "Hidden/deprecated direct tool names:",
    ...report.hiddenDirectTools.map((t) => `- ${t}`),
    "",
    "Notes:",
    ...report.notes.map((n) => `- ${n}`),
    "",
    "Recommended calls:",
    ...report.recommendedCalls.map((c) => `- ${c}`),
  ];
  return lines.join("\n");
}

async function runEvalHealthCheck(options = {}) {
  const createDefault = options.create_default !== false && options.createDefault !== false;
  const includeProfiles = options.include_profiles === undefined ? true : Boolean(options.include_profiles);
  const includeFixtures = options.include_fixtures === undefined ? true : Boolean(options.include_fixtures);
  if (createDefault) {
    await ensureEvalCasesFile(true);
    await ensureDefaultEvalProfileFiles(true);
    await ensureDefaultEvalFixtureFiles(true);
    await ensureDefaultDriverProfiles(true);
  }
  const checks = [];
  function add(name, status, detail = "") { checks.push({ name, status, detail }); }
  const toolNames = tools.map((t) => t.name);
  const dupTools = toolNames.filter((n, i) => toolNames.indexOf(n) !== i);
  add("tool registry unique names", dupTools.length ? "fail" : "pass", dupTools.length ? `duplicates=${dupTools.join(",")}` : `tools=${toolNames.length}`);
  const source = await fs.readFile(__filename, "utf-8");
  const missingHandlers = toolNames.filter((n) => !source.includes(`name === "${n}"`));
  add("call handler coverage", missingHandlers.length ? "fail" : "pass", missingHandlers.length ? `missing=${missingHandlers.join(",")}` : `handlers=${toolNames.length}`);
  const missingSchema = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== "object").map((t) => t.name);
  add("tool input schemas", missingSchema.length ? "fail" : "pass", missingSchema.length ? `bad=${missingSchema.join(",")}` : "all tools have object inputSchema");
  try { await loadEvalCases({ createDefault, scope: "all", includeProfiles: true, includeFixtures, includeDisabled: true }); add("eval case loading", "pass", "manual cases/profiles/fixtures readable"); } catch (e) { add("eval case loading", "fail", e.message); }
  if (includeProfiles) {
    try { await ensureDefaultDriverProfiles(createDefault); const listed = await listDriverProfiles({ createDefault: false }); add("driver profile loading", "pass", `profiles=${listed.length}`); } catch (e) { add("driver profile loading", "fail", e.message); }
  }
  if (includeFixtures) {
    try { const fixtures = await listEvalFixtureFiles(); add("eval fixture readability", "pass", `fixtures=${fixtures.length}`); } catch (e) { add("eval fixture readability", "fail", e.message); }
  }
  let pkg = null;
  try { pkg = JSON.parse(await fs.readFile(path.join(__dirname, "package.json"), "utf-8")); add("package.json", "pass", `test=${pkg.scripts?.test || "missing"}`); } catch (e) { add("package.json", "fail", e.message); }
  add("step40.7 compatibility mode", "pass", `mode=${STEP40_COMPAT_MODE}; supported=eval_health_check(step40_action=...); hidden_direct_tools=6`);
  const summary = { total: checks.length, pass: checks.filter((c) => c.status === "pass").length, fail: checks.filter((c) => c.status === "fail").length };
  return { schemaVersion: "step39.eval-health.v1", serverVersion: SERVER_VERSION, createdAt: new Date().toISOString(), health: summary.fail ? "fail" : "pass", summary, checks };
}

async function maybeWriteEvalHealthReport(report, writeReport = true) {
  if (!writeReport) return [];
  await fs.mkdir(INDEX_DIR, { recursive: true });
  const jsonPath = ensureInsideRoot(path.join(INDEX_DIR, "eval-health-report.json"), INDEX_DIR, "eval health report JSON");
  const textPath = ensureInsideRoot(path.join(INDEX_DIR, "eval-health-report.txt"), INDEX_DIR, "eval health report text");
  await atomicWriteFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  await atomicWriteFile(textPath, formatEvalHealthReport(report), "utf-8");
  return [jsonPath, textPath];
}

function formatEvalHealthReport(report) {
  const lines = ["MCP Eval Health Check", `Created: ${report.createdAt}`, `Server version: ${report.serverVersion}`, `Health: ${report.health.toUpperCase()}`, `Summary: total=${report.summary.total}, pass=${report.summary.pass}, fail=${report.summary.fail}`, ""];
  for (const check of report.checks || []) lines.push(`- [${String(check.status).toUpperCase()}] ${check.name}: ${check.detail || ""}`);
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Tool handlers
// -----------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === "list_pdfs") {
      const pdfs = await listPdfFiles();

      if (!pdfs.length) {
        return textResult(
          [`No PDF files found.`, `Documents folder: ${DOCUMENTS_DIR}`].join("\n")
        );
      }

      return textResult(
        [`Available PDFs:`, "", ...pdfs.map((file) => `- ${file}`)].join("\n")
      );
    }

    if (name === "plan_manual_workflow") {
      const plan = await buildManualWorkflowPlan(args);
      return textResult(formatManualWorkflowPlan(plan));
    }

    if (name === "explain_tool_usage") {
      return textResult(formatToolUsage(String(args.tool_name || "").trim(), String(args.task || "").trim()));
    }

    if (name === "eval_health_check") {
      const step40Action = String(args.step40_action || "health").trim().toLowerCase();
      if (step40Action && step40Action !== "health") {
        // Step 40.6: route status/job actions through eval_health_check because
        // some VS Code AI-agent MCP clients keep cancelling newly-added tool
        // names even when older tools are callable. This reuses the known-good
        // eval_health_check transport path and avoids adding more tool names.
        if (step40Action === "ping") {
          return textResult([
            "MCP server ping via eval_health_check: OK",
            `Server version: ${SERVER_VERSION}`,
            `Generated: ${nowIso()}`,
            "Transport: eval_health_check(step40_action=ping)",
          ].join("\n"));
        }
        if (step40Action === "compat_report") {
          const report = buildStep407CompatibilityReport();
          if (Boolean(args.json)) return textResult(JSON.stringify(report, null, 2));
          return textResult(formatStep407CompatibilityReport(report));
        }
        if (step40Action === "index_status_lite") {
          const status = getIndexStatusUltraMinimal(args.filename);
          if (Boolean(args.json)) return textResult(JSON.stringify(status, null, 2));
          return textResult(formatIndexStatusUltraMinimal(status));
        }
        if (step40Action === "rebuild_artifact") {
          const filename = args.filename;
          const artifact = normalizeArtifactName(args.artifact || "pages");
          const job = await startRebuildArtifactJob(filename, artifact, {
            forceLock: Boolean(args.force_lock),
            chunkSize: clampChunkSize(args.chunk_size),
            chunkOverlap: clampChunkOverlap(args.chunk_overlap, clampChunkSize(args.chunk_size)),
            allowFullRebuild: args.allow_full_rebuild === undefined ? true : Boolean(args.allow_full_rebuild),
          });
          return textResult([
            `Started detached background artifact rebuild for ${filename}.`,
            `Artifact: ${artifact}`,
            `Job ID: ${job.id}`,
            `Status: ${job.status}`,
            `Mode: detached-worker via eval_health_check`,
            "",
            `Poll via: eval_health_check(step40_action="job_status", job_id="${job.id}")`,
            `List via: eval_health_check(step40_action="list_jobs")`,
            `Persistent job state: ${safeJobsStatePath()}`,
          ].join("\n"));
        }
        if (step40Action === "job_status") {
          await refreshJobsStateFromDisk();
          const jobId = String(args.job_id || "").trim();
          const job = jobs.get(jobId);
          return textResult(formatJobStatus(job));
        }
        if (step40Action === "list_jobs") {
          await refreshJobsStateFromDisk();
          return textResult(formatJobsList());
        }
        if (step40Action === "cancel_job") {
          const jobId = String(args.job_id || "").trim();
          if (!jobId) throw new Error("job_id is required");
          const job = cancelBackgroundJob(jobId, String(args.reason || "Cancelled by user").trim() || "Cancelled by user");
          if (!job) return textResult(`Job not found: ${jobId}`);
          return textResult(formatJobStatus(job));
        }
        if (step40Action === "cleanup_jobs") {
          const statuses = Array.isArray(args.statuses) ? args.statuses.map(String) : undefined;
          const olderThanHours = Number(args.older_than_hours || 0);
          const removed = cleanupBackgroundJobs({ statuses, olderThanHours, includeRunning: Boolean(args.include_running) });
          return textResult([
            `Removed jobs: ${removed.length}`,
            ...removed.map((id) => `- ${id}`),
            "",
            `Remaining jobs: ${jobs.size}`,
            `Persistent job state: ${safeJobsStatePath()}`,
          ].join("\n"));
        }
        throw new Error(`Unknown eval_health_check step40_action: ${args.step40_action}`);
      }

      const report = await runEvalHealthCheck(args);
      const writeReport = args.write_report === undefined ? true : Boolean(args.write_report);
      const reportPaths = await maybeWriteEvalHealthReport(report, writeReport);
      return textResult([
        formatEvalHealthReport(report),
        reportPaths.length ? "" : null,
        ...reportPaths.map((p) => `Eval health report saved: ${p}`),
      ].filter(Boolean).join("\n"));
    }

    if (name === "list_eval_cases") {
      const caseId = String(args.case_id || "").trim();
      const createDefault = args.create_default !== false;
      const evalData = await loadEvalCases({
        createDefault,
        scope: String(args.scope || "all").trim(),
        moduleType: String(args.module_type || "").trim(),
        evalProfile: String(args.eval_profile || "").trim(),
        fixture: String(args.fixture || "").trim(),
        includeProfiles: true,
        includeFixtures: true,
        includeDisabled: args.include_disabled === undefined ? true : Boolean(args.include_disabled),
      });
      return textResult(formatEvalCases(evalData, caseId));
    }

    if (name === "run_eval") {
      const filename = String(args.filename || "").trim();
      const caseId = String(args.case_id || "").trim();
      const moduleType = String(args.module_type || "").trim();
      const evalProfile = String(args.eval_profile || "").trim();
      const fixture = String(args.fixture || "").trim();
      const autoIndex = Boolean(args.auto_index);
      const writeReport = args.write_report === undefined ? true : Boolean(args.write_report);
      const createDefault = args.create_default !== false;
      const includeProfiles = args.include_profiles === undefined ? true : Boolean(args.include_profiles);
      const includeFixtures = args.include_fixtures === undefined ? true : Boolean(args.include_fixtures);
      const includeGolden = Boolean(args.include_golden);
      const goldenProfile = String(args.golden_profile || DEFAULT_GOLDEN_PROFILE).trim();
      const strictVerifiedOnly = args.strict_verified_only === undefined ? true : Boolean(args.strict_verified_only);

      const report = await runEvalSuite({
        filename,
        caseId,
        moduleType,
        evalProfile,
        fixture,
        autoIndex,
        createDefault,
        includeProfiles,
        includeFixtures,
        includeGolden,
        goldenProfile,
        strictVerifiedOnly,
      });
      const reportPaths = await maybeWriteEvalReport(report, writeReport);

      return textResult([
        formatEvalReport(report),
        reportPaths.length ? "" : null,
        ...reportPaths.map((p) => `Eval report saved: ${p}`),
      ].filter(Boolean).join("\n"));
    }

    if (name === "doctor" || name === "validate_index") {
      const filename = String(args.filename || "").trim();
      const strict = Boolean(args.strict);
      const defaultWrite = name === "doctor" && Boolean(filename);
      const writeReport = args.write_report === undefined ? defaultWrite : Boolean(args.write_report);

      const result = await doctorPdfs({
        filename,
        strict,
      });
      const reportPaths = await maybeWriteDoctorReports(result, writeReport);
      const formatted = formatDoctorReport(result, { includeDetails: true });

      return textResult([
        formatted,
        reportPaths.length ? "" : null,
        ...reportPaths.map((p) => `Doctor report saved: ${p}`),
      ].filter(Boolean).join("\n"));
    }

    if (name === "pdf_info") {
      const filename = args.filename;
      const filePath = safePdfPath(filename);
      const stat = await getFileStat(filename);
      const indexPath = safeIndexPath(filename);
      const lockPath = safeIndexLockPath(filename);
      const lockInfo = await readIndexLock(filename);
      const lockText = lockInfo
        ? [
            "Index build lock: yes",
            `Lock path: ${lockPath}`,
            `Created: ${lockInfo.createdAt || "unknown"}`,
            `PID: ${lockInfo.pid || "unknown"}`,
            `Stale: ${isIndexLockStale(lockInfo) ? "yes" : "no"}`,
          ].join("\n")
        : ["Index build lock: no", `Lock path: ${lockPath}`].join("\n");

      let pageCountText = "Pages: unknown";
      try {
        const pageCount = await getPdfPageCount(filename);
        pageCountText = `Pages: ${pageCount}`;
      } catch (error) {
        pageCountText = `Pages: unable to read PDF page count (${error.message})`;
      }

      let indexText = "Indexed: no";
      if (await pathExists(indexPath)) {
        try {
          const raw = await fs.readFile(indexPath, "utf-8");
          const indexData = JSON.parse(raw);
          const usable = isIndexUsable(indexData, stat);

          indexText = [
            `Indexed: yes`,
            `Index status: ${usable ? "valid" : "stale or incompatible"}`,
            `Index created: ${indexData.createdAt || "unknown"}`,
            `Index schema: ${indexData.schemaVersion || "unknown"}`,
            `Indexed pages: ${indexData.pageCount || "unknown"}`,
            `Chunks: ${indexData.chunkCount || (indexData.chunks || []).length || 0}`,
            `Chunk size: ${indexData.chunkSize || "unknown"}`,
            `Chunk overlap: ${indexData.chunkOverlap || "unknown"}`,
            `Index path: ${indexPath}`,
          ].join("\n");
        } catch (error) {
          indexText = [
            "Indexed: yes",
            "Index status: broken/unreadable",
            `Index error: ${error.message}`,
            `Index path: ${indexPath}`,
          ].join("\n");
        }
      }
      const pagesCachePath = safePagesCachePath(filename);
      let pagesCacheText = "Pages cache: no";

      const pageCache = await loadPagesCache(filename);

      if (pageCache) {
        pagesCacheText = [
          "Pages cache: yes",
          `Pages cache created: ${pageCache.createdAt}`,
          `Cached pages: ${pageCache.pages.length}`,
          `Pages cache path: ${pagesCachePath}`,
        ].join("\n");
      }

      const sectionsIndexPath = safeSectionsIndexPath(filename);
      let sectionsIndexText = "Sections index: no";
      const sectionsIndex = await loadSectionsIndex(filename);

      if (sectionsIndex) {
        sectionsIndexText = [
          "Sections index: yes",
          `Sections index created: ${sectionsIndex.createdAt}`,
          `Sections detected: ${sectionsIndex.sectionCount}`,
          `Sections index path: ${sectionsIndexPath}`,
        ].join("\n");
      }

      const registersIndexPath = safeRegistersIndexPath(filename);
      let registersIndexText = "Registers index: no";
      const registersIndex = await loadRegistersIndex(filename);

      if (registersIndex) {
        registersIndexText = [
          "Registers index: yes",
          `Registers index created: ${registersIndex.createdAt}`,
          `Registers detected: ${registersIndex.registerCount}`,
          `Registers index path: ${registersIndexPath}`,
        ].join("\n");
      }

      const bitfieldsIndexPath = safeBitfieldsIndexPath(filename);
      let bitfieldsIndexText = "Bitfields index: no";
      const bitfieldsIndex = await loadBitfieldsIndex(filename);

      if (bitfieldsIndex) {
        bitfieldsIndexText = [
          "Bitfields index: yes",
          `Bitfields index created: ${bitfieldsIndex.createdAt}`,
          `Bitfields detected: ${bitfieldsIndex.bitfieldCount}`,
          `Bitfields index path: ${bitfieldsIndexPath}`,
        ].join("\n");
      }

      const sequencesIndexPath = safeSequencesIndexPath(filename);
      let sequencesIndexText = "Sequences index: no";
      const sequencesIndex = await loadSequencesIndex(filename);

      if (sequencesIndex) {
        sequencesIndexText = [
          "Sequences index: yes",
          `Sequences index created: ${sequencesIndex.createdAt}`,
          `Sequences detected: ${sequencesIndex.sequenceCount}`,
          `Sequences index path: ${sequencesIndexPath}`,
        ].join("\n");
      }

      const cautionsIndexPath = safeCautionsIndexPath(filename);
      let cautionsIndexText = "Cautions index: no";
      const cautionsIndex = await loadCautionsIndex(filename);

      if (cautionsIndex) {
        cautionsIndexText = [
          "Cautions index: yes",
          `Cautions index created: ${cautionsIndex.createdAt}`,
          `Cautions detected: ${cautionsIndex.cautionCount}`,
          `Cautions index path: ${cautionsIndexPath}`,
        ].join("\n");
      }

      const moduleProfileJsonPath = safeModuleProfileJsonPath(filename);
      const moduleProfileTextPath = safeModuleProfileTextPath(filename);
      let moduleProfileText = "Module profile: no";
      const moduleProfile = await loadModuleProfile(filename);

      if (moduleProfile) {
        moduleProfileText = [
          "Module profile: yes",
          `Module profile created: ${moduleProfile.createdAt}`,
          `Module type: ${moduleProfile.moduleType}`,
          `Linux subsystem: ${moduleProfile.linuxSubsystem}`,
          `Profile JSON path: ${moduleProfileJsonPath}`,
          `Profile text path: ${moduleProfileTextPath}`,
        ].join("\n");
      }

      const artifactManifestPath = safeArtifactManifestPath(filename);
      const artifactManifest = await loadArtifactManifest(filename);
      const artifactManifestText = artifactManifest
        ? [formatManifestSummary(artifactManifest), `Manifest path: ${artifactManifestPath}`].join("\n")
        : [
            "Artifact manifest: no",
            `Manifest path: ${artifactManifestPath}`,
            `Next action: start_index_pdf(filename="${filename}") for large manuals, then rerun pdf_info/doctor.`,
          ].join("\n");

      return textResult(
        [
          `PDF: ${filename}`,
          `Path: ${filePath}`,
          `Size: ${stat.size} bytes`,
          `Modified: ${stat.mtime.toISOString()}`,
          "",
          lockText,
          "",
          indexText,
          "",
          pagesCacheText,
          "",
          sectionsIndexText,
          "",
          registersIndexText,
          "",
          bitfieldsIndexText,
          "",
          sequencesIndexText,
          "",
          cautionsIndexText,
          "",
          moduleProfileText,
          "",
          artifactManifestText,
        ].join("\n")
      );
    }

    if (name === "start_index_pdf") {
      const filename = args.filename;
      const force = Boolean(args.force);
      const forceLock = Boolean(args.force_lock);
      const chunkSize = clampChunkSize(args.chunk_size);
      const chunkOverlap = clampChunkOverlap(args.chunk_overlap, chunkSize);
      const indexPath = safeIndexPath(filename);
      const pdfStat = await getFileStat(filename);

      if (!force && (await pathExists(indexPath))) {
        try {
          const raw = await fs.readFile(indexPath, "utf-8");
          const indexData = JSON.parse(raw);
          if (isIndexUsable(indexData, pdfStat)) {
            return textResult([
              `Index already valid for ${filename}.`,
              `Pages: ${indexData.pageCount}`,
              `Chunks: ${indexData.chunkCount}`,
              `Created: ${indexData.createdAt}`,
              `No background job started. Use force=true to rebuild.`,
            ].join("\n"));
          }
        } catch {
          // fall through and start a job
        }
      }

      const job = await startIndexPdfJob(filename, { chunkSize, chunkOverlap, forceLock });
      return textResult([
        `Started background indexing job for ${filename}.`,
        `Job ID: ${job.id}`,
        `Status: ${job.status}`,
        `Mode: background`,
        "",
        `Poll: job_status(job_id="${job.id}")`,
        `List jobs: list_jobs()`,
        `Persistent job state: ${safeJobsStatePath()}`,
      ].join("\n"));
    }

    if (name === "job_status") {
      await refreshJobsStateFromDisk();
      const jobId = String(args.job_id || "").trim();
      const job = jobs.get(jobId);
      return textResult(formatJobStatus(job));
    }

    if (name === "list_jobs") {
      await refreshJobsStateFromDisk();
      return textResult(formatJobsList());
    }

    if (name === "cancel_job") {
      const jobId = String(args.job_id || "").trim();
      if (!jobId) throw new Error("job_id is required");
      const job = cancelBackgroundJob(jobId, String(args.reason || "Cancelled by user").trim() || "Cancelled by user");
      if (!job) return textResult(`Job not found: ${jobId}`);
      return textResult(formatJobStatus(job));
    }

    if (name === "cleanup_jobs") {
      const statuses = Array.isArray(args.statuses) ? args.statuses.map(String) : undefined;
      const olderThanHours = Number(args.older_than_hours || 0);
      const removed = cleanupBackgroundJobs({ statuses, olderThanHours, includeRunning: Boolean(args.include_running) });
      return textResult([
        `Removed jobs: ${removed.length}`,
        ...removed.map((id) => `- ${id}`),
        "",
        `Remaining jobs: ${jobs.size}`,
        `Persistent job state: ${safeJobsStatePath()}`,
      ].join("\n"));
    }

    if (name === "mcp_server_ping") {
      return textResult(`MCP server ping: OK\nServer version: ${SERVER_VERSION}\nGenerated: ${nowIso()}`);
    }

    if (name === "pdf_index_status_lite") {
      const status = getIndexStatusUltraMinimal(args.filename);
      if (Boolean(args.json)) return textResult(JSON.stringify(status, null, 2));
      return textResult(formatIndexStatusUltraMinimal(status));
    }

    if (name === "index_status") {
      const filename = args.filename;
      const details = Boolean(args.details);
      if (!details) {
        const status = getIndexStatusUltraMinimal(filename);
        if (Boolean(args.json)) return textResult(JSON.stringify(status, null, 2));
        return textResult(formatIndexStatusUltraMinimal(status));
      }
      await refreshJobsStateFromDisk();
      const status = await getIndexStatus(filename, { probePdf: Boolean(args.probe_pdf) });
      if (Boolean(args.json)) return textResult(JSON.stringify(status, null, 2));
      return textResult(formatIndexStatus(status));
    }

    if (name === "rebuild_artifact") {
      const filename = args.filename;
      const artifact = normalizeArtifactName(args.artifact);
      const forceLock = Boolean(args.force_lock);
      const chunkSize = clampChunkSize(args.chunk_size);
      const chunkOverlap = clampChunkOverlap(args.chunk_overlap, chunkSize);
      const allowFullRebuild = args.allow_full_rebuild === undefined ? true : Boolean(args.allow_full_rebuild);
      const backgroundDefault = ["all", "core", "chunk-index", "pages"].includes(artifact);
      const background = args.background === undefined ? backgroundDefault : Boolean(args.background);

      if (background) {
        const job = await startRebuildArtifactJob(filename, artifact, { forceLock, chunkSize, chunkOverlap, allowFullRebuild });
        return textResult([
          `Started background artifact rebuild for ${filename}.`,
          `Artifact: ${artifact}`,
          `Job ID: ${job.id}`,
          "",
          `Poll: job_status(job_id="${job.id}")`,
          `Check artifacts: index_status(filename="${filename}")`,
        ].join("\n"));
      }

      const result = await rebuildArtifact(filename, artifact, { forceLock, chunkSize, chunkOverlap, allowFullRebuild });
      const status = await getIndexStatus(filename);
      return textResult([
        `Rebuilt artifact for ${filename}.`,
        `Artifact: ${artifact}`,
        `Rebuilt: ${result.rebuilt.join(", ")}`,
        `Counts: ${JSON.stringify(result.counts)}`,
        "",
        formatIndexStatus(status),
      ].join("\n"));
    }

    if (name === "index_pdf") {
      const filename = args.filename;
      const force = Boolean(args.force);
      const forceLock = Boolean(args.force_lock);
      const mode = String(args.mode || DEFAULT_INDEX_JOB_MODE).trim().toLowerCase();
      const indexPath = safeIndexPath(filename);
      const lockPath = safeIndexLockPath(filename);
      const pdfStat = await getFileStat(filename);

      if (!force && (await pathExists(indexPath))) {
        try {
          const raw = await fs.readFile(indexPath, "utf-8");
          const indexData = JSON.parse(raw);

          if (isIndexUsable(indexData, pdfStat)) {
            const pageCache = await loadPagesCache(filename) || { pages: [], pageCount: indexData.pageCount };
            const sectionsIndex = await loadSectionsIndex(filename) || { sectionCount: indexData.sectionCount || 0 };
            const registersIndex = await loadRegistersIndex(filename) || { registerCount: indexData.registerCount || 0 };
            const bitfieldsIndex = await loadBitfieldsIndex(filename) || { bitfieldCount: indexData.bitfieldCount || 0 };
            const sequencesIndex = await loadSequencesIndex(filename) || { sequenceCount: indexData.sequenceCount || 0 };
            const cautionsIndex = await loadCautionsIndex(filename) || { cautionCount: indexData.cautionCount || 0 };
            const pagesCachePath = safePagesCachePath(filename);
            const sectionsIndexPath = safeSectionsIndexPath(filename);
            const registersIndexPath = safeRegistersIndexPath(filename);
            const bitfieldsIndexPath = safeBitfieldsIndexPath(filename);
            const sequencesIndexPath = safeSequencesIndexPath(filename);
            const cautionsIndexPath = safeCautionsIndexPath(filename);

            return textResult(
              [
                `Index already exists for ${filename}.`,
                `Use force=true to rebuild.`,
                "",
                `Pages: ${indexData.pageCount}`,
                `Chunks: ${indexData.chunkCount}`,
                `Registers: ${registersIndex.registerCount}`,
                `Bitfields: ${bitfieldsIndex.bitfieldCount}`,
                `Sequences: ${sequencesIndex.sequenceCount}`,
                `Cautions: ${cautionsIndex.cautionCount}`,
                `Created: ${indexData.createdAt}`,
                "",
                `Pages cache: ready`,
                `Pages cache path: ${pagesCachePath}`,
                `Pages cached: ${pageCache.pages.length}`,
                "",
                `Sections index: ready`,
                `Sections index path: ${sectionsIndexPath}`,
                `Sections detected: ${sectionsIndex.sectionCount}`,
                "",
                `Registers index: ready`,
                `Registers index path: ${registersIndexPath}`,
          `Bitfields index path: ${bitfieldsIndexPath}`,
                `Registers detected: ${registersIndex.registerCount}`,
                "",
                `Bitfields index: ready`,
                `Bitfields index path: ${bitfieldsIndexPath}`,
                `Bitfields detected: ${bitfieldsIndex.bitfieldCount}`,
                "",
                `Sequences index: ready`,
                `Sequences index path: ${sequencesIndexPath}`,
                `Sequences detected: ${sequencesIndex.sequenceCount}`,
                "",
                `Cautions index: ready`,
                `Cautions index path: ${cautionsIndexPath}`,
                `Cautions detected: ${cautionsIndex.cautionCount}`,
              ].join("\n")
            );
          }
        } catch {
          // Broken index files are rebuilt below.
        }
      }

      const chunkSize = clampChunkSize(args.chunk_size);
      const chunkOverlap = clampChunkOverlap(args.chunk_overlap, chunkSize);

      let pageCount = 0;
      try { pageCount = await getPdfPageCount(filename); } catch { pageCount = 0; }
      const shouldBackground = mode === "background" || (mode !== "foreground" && pageCount >= LARGE_PDF_BACKGROUND_PAGE_THRESHOLD);
      if (shouldBackground) {
        const job = await startIndexPdfJob(filename, { chunkSize, chunkOverlap, forceLock });
        return textResult([
          `Indexing for ${filename} started as a background job to avoid MCP client timeout.`,
          `Pages: ${pageCount || "unknown"}`,
          `Threshold: ${LARGE_PDF_BACKGROUND_PAGE_THRESHOLD} pages`,
          `Job ID: ${job.id}`,
          "",
          `Poll: job_status(job_id="${job.id}")`,
          `Persistent job state: ${safeJobsStatePath()}`,
          `When done, rerun doctor(filename="${filename}") or validate_index(filename="${filename}").`,
          "",
          `To force blocking behavior anyway, call index_pdf(filename="${filename}", mode="foreground", force=${force ? "true" : "false"}).`,
        ].join("\n"));
      }

      const indexData = await buildPdfIndex(filename, {
        chunkSize,
        chunkOverlap,
        forceLock,
        reusePageCache: true,
      });

      const pagesCachePath = safePagesCachePath(filename);
      const sectionsIndexPath = safeSectionsIndexPath(filename);
      const registersIndexPath = safeRegistersIndexPath(filename);
      const bitfieldsIndexPath = safeBitfieldsIndexPath(filename);
      const sequencesIndexPath = safeSequencesIndexPath(filename);
      const cautionsIndexPath = safeCautionsIndexPath(filename);
      const bitfieldsIndex = await loadBitfieldsIndex(filename) || { bitfieldCount: indexData.bitfieldCount || 0 };
      const sequencesIndex = await loadSequencesIndex(filename) || { sequenceCount: indexData.sequenceCount || 0 };
      const cautionsIndex = await loadCautionsIndex(filename) || { cautionCount: indexData.cautionCount || 0 };

      return textResult(
        [
          `Indexed ${filename} successfully.`,
          `Pages: ${indexData.pageCount}`,
          `Chunks: ${indexData.chunkCount}`,
          `Sections detected: ${indexData.sectionCount}`,
          `Registers detected: ${indexData.registerCount}`,
          `Bitfields detected: ${indexData.bitfieldCount || bitfieldsIndex.bitfieldCount}`,
          `Sequences detected: ${indexData.sequenceCount || sequencesIndex.sequenceCount}`,
          `Cautions detected: ${indexData.cautionCount || cautionsIndex.cautionCount}`,
          `Chunk size: ${indexData.chunkSize}`,
          `Chunk overlap: ${indexData.chunkOverlap}`,
          `Created: ${indexData.createdAt}`,
          `Index path: ${indexPath}`,
          `Index lock path: ${lockPath}`,
          `Atomic write: enabled`,
          `Pages cache path: ${pagesCachePath}`,
          `Sections index path: ${sectionsIndexPath}`,
          `Registers index path: ${registersIndexPath}`,
          `Bitfields index path: ${bitfieldsIndexPath}`,
          `Sequences index path: ${sequencesIndexPath}`,
        ].join("\n")
      );
    }
    if (name === "search_pdf") {
      const filename = args.filename;
      const query = String(args.query || "").trim();
      const topK = clampTopK(args.top_k);

      if (!query) throw new Error("query is required");

      const { results } = await searchPdfIndex(filename, query, topK);
      return textResult(formatSearchResults(results, query));
    }
    if (name === "hybrid_search_pdf") {
      const filename = args.filename;
      const query = String(args.query || "").trim();
      const register = String(args.register || "").trim();
      const intent = String(args.intent || "auto").trim() || "auto";
      const topK = clampHybridTopK(args.top_k);

      if (!query) throw new Error("query is required");

      const payload = await hybridSearchPdf(filename, query, {
        register,
        intent,
        topK,
      });

      return textResult(formatHybridSearchResults(payload));
    }
    if (name === "chunk_type_stats") {
      const filename = args.filename;
      const includeExamples = args.include_examples !== false;
      const stats = await getChunkTypeStats(filename, { includeExamples });
      return textResult(formatChunkTypeStats(stats));
    }

    if (name === "read_pdf_pages") {
      const filename = args.filename;

      let start = Math.floor(Number(args.start_page));
      let end = Math.floor(Number(args.end_page));

      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error("start_page and end_page must be numbers");
      }

      if (start < 1) start = 1;
      if (end < start) end = start;
      if (end - start + 1 > MAX_PAGE_RANGE) end = start + MAX_PAGE_RANGE - 1;

      const pageCache = await loadPagesCache(filename);
      let selectedPages = [];
      let source = "pages cache";

      if (pageCache) {
        if (start > pageCache.pageCount) start = pageCache.pageCount;
        end = Math.min(end, pageCache.pageCount);
        selectedPages = pageCache.pages.filter((page) => page.page >= start && page.page <= end);
      } else {
        // Timeout-safe fallback: extract only requested pages, do not build full .pages.json.
        const partial = await extractPdfPages(filename, { startPage: start, endPage: end });
        selectedPages = partial.pages || [];
        source = "direct page extraction; full pages cache not built";
      }

      const text = selectedPages.map((p) => `--- Page ${p.page} ---\n${p.text}`).join("\n\n");

      return textResult([
        `Source: ${source}`,
        `Range: ${start}-${end}`,
        "",
        text || `No extractable text found from page ${start} to page ${end}.`,
      ].join("\n"));
    }

    if (name === "read_pdf_chunk") {
      const filename = args.filename;
      const chunkId = String(args.chunk_id || "").trim();

      if (!chunkId) throw new Error("chunk_id is required");

      const indexData = await loadPdfIndex(filename);
      const chunk = indexData.chunks.find((candidate) => candidate.id === chunkId);

      if (!chunk) {
        return textResult(
          [
            `Chunk not found: ${chunkId}`,
            `File: ${filename}`,
            "Use search_pdf, find_register, find_bitfield, or find_section to get valid chunk IDs.",
          ].join("\n")
        );
      }

      return textResult(
        [
          `ID: ${chunk.id}`,
          `File: ${chunk.filename}`,
          `Page: ${chunk.page}`,
          `Chunk: ${chunk.chunkIndex}`,
          `Headings: ${
            chunk.headings && chunk.headings.length
              ? chunk.headings.join(" | ")
              : "none"
          }`,
          `Registers: ${
            chunk.registers && chunk.registers.length
              ? chunk.registers.join(", ")
              : "none"
          }`,
          `Bit fields / symbols: ${
            chunk.bitFields && chunk.bitFields.length
              ? chunk.bitFields.slice(0, 60).join(", ")
              : "none"
          }`,
          "",
          chunk.text,
        ].join("\n")
      );
    }

    if (name === "list_registers") {
      const filename = args.filename;
      const filter = String(args.filter || "").trim();
      const topK = clampRegisterListTopK(args.top_k);
      const includeLowConfidence = Boolean(args.include_low_confidence);

      const { registerIndex, results } = await listRegistersFromIndex(filename, {
        filter,
        topK,
        includeLowConfidence,
      });

      return textResult(formatRegisterListResults(registerIndex, results, filter));
    }

    if (name === "find_bitfield") {
      const filename = args.filename;
      const bitfield = String(args.bitfield || "").trim();
      const register = String(args.register || "").trim();
      const topK = clampTopK(args.top_k);

      if (!bitfield) throw new Error("bitfield is required");

      const result = await findBitfieldInIndex(filename, bitfield, {
        register,
        topK,
      });

      return textResult(formatBitfieldResults(result));
    }

    if (name === "list_bitfields") {
      const filename = args.filename;
      const register = String(args.register || "").trim();
      const filter = String(args.filter || "").trim();
      const topK = clampBitfieldListTopK(args.top_k);
      const includeLowConfidence = Boolean(args.include_low_confidence);

      const { bitfieldsIndex, results } = await listBitfieldsFromIndex(filename, {
        register,
        filter,
        topK,
        includeLowConfidence,
      });

      return textResult(formatBitfieldListResults(bitfieldsIndex, results, {
        register,
        filter,
      }));
    }

    if (name === "build_figures_index") {
      const filename = args.filename;
      const pageCache = await getPagesCache(filename);
      const index = await buildFiguresIndex(filename, pageCache);
      return textResult([
        `Built figures/captions index for ${filename}.`,
        `Path: ${safeFiguresIndexPath(filename)}`,
        `Pages: ${index.pageCount}`,
        `Figures/captions: ${index.figureCount}`,
        `Kind stats: ${JSON.stringify(index.kindStats || {})}`,
        "",
        `Next: list_figures(filename="${filename}")`,
      ].join("\n"));
    }

    if (name === "list_figures") {
      const filename = args.filename;
      const result = await listFigures(filename, {
        filter: String(args.filter || "").trim(),
        kind: String(args.kind || "").trim(),
        topK: args.top_k,
      });
      return textResult(formatFigureList(result, "list"));
    }

    if (name === "find_figure") {
      const filename = args.filename;
      const result = await findFigure(filename, {
        query: String(args.query || "").trim(),
        kind: String(args.kind || "").trim(),
        topK: args.top_k,
      });
      return textResult(formatFigureList(result, "find"));
    }

    if (name === "add_visual_evidence") {
      const filename = args.filename;
      const result = await addVisualEvidence(filename, {
        figureId: String(args.figure_id || "").trim(),
        page: args.page,
        query: String(args.query || "").trim(),
        diagramType: String(args.diagram_type || "auto").trim(),
        renderedPath: String(args.rendered_path || "").trim(),
        renderedRegion: args.rendered_region || {},
        directVisualObservations: normalizeStringArray(args.direct_visual_observations),
        captionContextFacts: normalizeStringArray(args.caption_context_facts),
        extractedItems: args.extracted_items || {},
        engineeringInferences: normalizeStringArray(args.engineering_inferences),
        sourceImplications: normalizeStringArray(args.source_implications),
        uncertainties: normalizeStringArray(args.uncertainties),
        relatedRegisters: normalizeStringArray(args.related_registers),
        relatedBitfields: normalizeStringArray(args.related_bitfields),
        sourceFiles: normalizeStringArray(args.source_files),
        tags: normalizeStringArray(args.tags),
        verificationStatus: String(args.verification_status || "needs_verification").trim(),
        confidence: String(args.confidence || "medium").trim(),
        notes: String(args.notes || "").trim(),
      });
      return textResult(formatAddVisualEvidence(result));
    }

    if (name === "list_visual_evidence") {
      const filename = args.filename;
      const result = await listVisualEvidence(filename, {
        filter: String(args.filter || "").trim(),
        diagramType: String(args.diagram_type || "").trim(),
        page: args.page,
        status: String(args.status || "").trim(),
        topK: args.top_k,
      });
      return textResult(formatListVisualEvidence(result));
    }

    if (name === "get_visual_evidence") {
      const filename = args.filename;
      const result = await getVisualEvidence(filename, String(args.evidence_id || "").trim());
      return textResult(formatGetVisualEvidence(result));
    }

    if (name === "visual_evidence_report") {
      const filename = args.filename;
      const report = await buildVisualEvidenceReport(filename, {
        filter: String(args.filter || "").trim(),
        diagramType: String(args.diagram_type || "").trim(),
        status: String(args.status || "").trim(),
        includeEntries: args.include_entries !== false,
        topK: args.top_k,
      });
      return textResult(formatVisualEvidenceReport(report));
    }

    if (name === "visual_evidence_verification_queue") {
      const filename = args.filename;
      const result = await buildVisualEvidenceVerificationQueue(filename, {
        filter: String(args.filter || "").trim(),
        diagramType: String(args.diagram_type || "").trim(),
        page: args.page,
        includeObserved: args.include_observed !== false,
        includeRejected: Boolean(args.include_rejected),
        topK: args.top_k,
      });
      return textResult(formatVisualEvidenceVerificationQueue(result));
    }

    if (name === "verify_visual_evidence") {
      const filename = args.filename;
      const result = await updateVisualEvidenceVerification(filename, String(args.evidence_id || "").trim(), {
        status: String(args.status || "needs_verification").trim(),
        confidence: String(args.confidence || "").trim(),
        verificationNote: String(args.verification_note || "").trim(),
        supportingEvidence: Array.isArray(args.supporting_evidence) ? args.supporting_evidence : [],
        supportingToolCalls: normalizeStringArray(args.supporting_tool_calls),
        resolvedUncertainties: normalizeStringArray(args.resolved_uncertainties),
        remainingUncertainties: normalizeStringArray(args.remaining_uncertainties),
        tagsToAdd: normalizeStringArray(args.tags_to_add),
        notes: String(args.notes || "").trim(),
        reviewer: String(args.reviewer || "").trim(),
        allowWithoutSupport: Boolean(args.allow_without_support),
      });
      return textResult(formatVerifyVisualEvidence(result));
    }

    if (name === "visual_review_handoff_pack") {
      const filename = args.filename;
      const pack = await buildVisualReviewHandoffPack(filename, {
        query: String(args.query || "").trim(),
        figureId: String(args.figure_id || "").trim(),
        page: args.page,
        kind: String(args.kind || "").trim(),
        diagramType: String(args.diagram_type || "auto").trim(),
        task: String(args.task || "").trim(),
        sourceFiles: normalizeStringArray(args.source_files),
        reviewDepth: String(args.review_depth || "standard").trim(),
        outputFormat: String(args.output_format || "report").trim(),
        topK: args.top_k,
        includeLayoutTables: args.include_layout_tables !== false,
        includeRenderCommands: args.include_render_commands !== false,
      });
      return textResult(formatVisualReviewHandoffPack(pack));
    }

    if (name === "get_figure_context") {
      const filename = args.filename;
      const result = await getFigureContext(filename, {
        figureId: String(args.figure_id || "").trim(),
        page: args.page,
        query: String(args.query || "").trim(),
        includePages: args.include_pages,
        includeLayoutTables: Boolean(args.include_layout_tables),
      });
      return textResult(formatFigureContext(result));
    }

    if (name === "check_pdf_renderers") {
      const availability = await detectPdfRenderers();
      return textResult(formatRendererAvailability(availability));
    }

    if (name === "render_pdf_region") {
      const filename = args.filename;
      const result = await renderPdfRegion(filename, {
        page: args.page,
        x: args.x,
        y: args.y,
        width: args.width,
        height: args.height,
        unit: args.unit || "percent",
        margin: args.margin,
        zoom: args.zoom,
        dpi: args.dpi,
        format: args.format || "png",
        renderer: args.renderer || "auto",
        fallbackFullPage: Boolean(args.fallback_full_page),
      });
      return textResult(formatRegionRenderResult(result));
    }

    if (name === "render_figure_region") {
      const filename = args.filename;
      const result = await renderFigureRegion(filename, {
        figureId: String(args.figure_id || "").trim(),
        page: args.page,
        query: String(args.query || "").trim(),
        region: String(args.region || "auto").trim(),
        x: args.x,
        y: args.y,
        width: args.width,
        height: args.height,
        unit: args.unit || "percent",
        margin: args.margin,
        zoom: args.zoom,
        dpi: args.dpi,
        format: args.format || "png",
        renderer: args.renderer || "auto",
        includeContext: args.include_context !== false,
      });
      return textResult(formatRenderFigureRegionResult(result));
    }

    if (name === "render_pdf_page") {
      const filename = args.filename;
      const result = await renderPdfPage(filename, {
        page: args.page,
        dpi: args.dpi,
        format: args.format || "png",
        renderer: args.renderer || "auto",
        fallbackTextSvg: args.fallback_text_svg !== false,
      });
      return textResult(formatRenderResult(result));
    }

    if (name === "render_figure_page") {
      const filename = args.filename;
      const result = await renderFigurePage(filename, {
        figureId: String(args.figure_id || "").trim(),
        page: args.page,
        query: String(args.query || "").trim(),
        dpi: args.dpi,
        format: args.format || "png",
        renderer: args.renderer || "auto",
        includeContext: args.include_context !== false,
      });
      return textResult(formatRenderFigureResult(result));
    }

    if (name === "extract_layout_tables_from_pages") {
      const filename = args.filename;
      const startPage = Number(args.start_page);
      const endPage = Number(args.end_page);
      const minColumns = Number(args.min_columns || 2);
      const kind = String(args.kind || "auto").trim();

      const tables = await extractTablesFromPages(filename, { startPage, endPage, minColumns });
      return textResult(formatLayoutExtractedTables(tables, kind));
    }

    if (name === "extract_tables_from_pages") {
      const filename = args.filename;
      const startPage = Number(args.start_page);
      const endPage = Number(args.end_page);
      const minColumns = Number(args.min_columns || 3);

      const tables = await extractTablesFromPages(filename, {
        startPage,
        endPage,
        minColumns,
      });

      return textResult(formatExtractedTables(tables));
    }

    if (name === "extract_pinmux_table") {
      const filename = args.filename;
      const startPage = args.start_page === undefined ? undefined : Number(args.start_page);
      const endPage = args.end_page === undefined ? undefined : Number(args.end_page);
      const minColumns = Number(args.min_columns || 2);
      const filter = String(args.filter || "").trim();
      const pin = String(args.pin || "").trim();
      const functionName = String(args.function || "").trim();
      const topK = clampRegisterListTopK(args.top_k);
      const table = await extractPinmuxTable(filename, { startPage, endPage, minColumns, filter, pin, functionName, topK });
      return textResult(formatExtractedPinmuxTable(table));
    }

    if (name === "extract_register_table") {
      const filename = args.filename;
      const startPage = args.start_page === undefined ? undefined : Number(args.start_page);
      const endPage = args.end_page === undefined ? undefined : Number(args.end_page);
      const filter = String(args.filter || "").trim();
      const topK = clampRegisterListTopK(args.top_k);

      const table = await extractRegisterTable(filename, {
        startPage,
        endPage,
        filter,
        topK,
      });

      return textResult(formatExtractedRegisterTable(table));
    }

    if (name === "extract_bitfield_table") {
      const filename = args.filename;
      const register = String(args.register || "").trim();
      const topK = clampBitfieldListTopK(args.top_k);

      if (!register) throw new Error("register is required");

      const table = await extractBitfieldTable(filename, register, { topK });
      return textResult(formatExtractedBitfieldTable(table));
    }

    if (name === "summarize_register") {
      const filename = args.filename;
      const register = String(args.register || "").trim();
      const topK = clampRegisterSummaryTopK(args.top_k);
      const includeBitfieldEvidence = args.include_bitfield_evidence !== false;

      if (!register) throw new Error("register is required");

      const summary = await summarizeRegister(filename, register, {
        topK,
        includeBitfieldEvidence,
      });

      return textResult(formatRegisterSummary(summary));
    }

    if (name === "find_register") {
      const filename = args.filename;
      const register = String(args.register || "").trim();
      const topK = clampTopK(args.top_k);

      if (!register) throw new Error("register is required");

      const { results: registerResults } = await searchRegistersIndex(filename, register, topK);
      if (registerResults.length) {
        return textResult(formatRegisterIndexResults(registerResults, register));
      }

      const queries = buildRegisterQueries(register);
      const results = await multiQuerySearch(filename, queries, topK);
      return textResult(
        [
          `No direct register-index match for "${register}". Falling back to chunk search.`,
          "",
          formatSearchResults(results, register),
        ].join("\n")
      );
    }

    if (name === "list_sequences") {
      const filename = args.filename;
      const filter = String(args.filter || "").trim();
      const topK = clampSequenceListTopK(args.top_k);

      const { sequencesIndex, results } = await listSequencesFromIndex(filename, {
        filter,
        topK,
      });

      return textResult(formatSequenceListResults(sequencesIndex, results, filter));
    }

    if (name === "get_sequence") {
      const filename = args.filename;
      const topic = String(args.topic || "").trim();
      const register = String(args.register || "").trim();

      if (!topic) {
        throw new Error("topic is required");
      }

      const result = await getSequenceFromIndex(filename, topic, {
        register,
        topK: args.top_k,
      });

      return textResult(formatPersistentSequenceResult(result));
    }

    if (name === "find_sequence") {
      const filename = args.filename;
      const topic = String(args.topic || "").trim();
      const register = String(args.register || "").trim();

      if (!topic) {
        throw new Error("topic is required");
      }

      const result = await findSequenceInIndex(filename, topic, {
        register,
        topK: args.top_k,
      });

      return textResult(formatSequenceResults(result));
    }

    if (name === "find_caution") {
      const filename = args.filename;
      const topic = String(args.topic || "").trim();
      const register = String(args.register || "").trim();

      if (!topic) {
        throw new Error("topic is required");
      }

      const result = await findCautionInIndex(filename, topic, {
        register,
        topK: args.top_k,
      });

      return textResult(formatCautionResults(result));
    }

    if (name === "list_cautions") {
      const filename = args.filename;
      const filter = String(args.filter || "").trim();
      const register = String(args.register || "").trim();
      const type = String(args.type || "").trim();
      const topK = clampCautionListTopK(args.top_k);

      const { cautionsIndex, results } = await listCautionsFromIndex(filename, {
        filter,
        register,
        type,
        topK,
      });

      return textResult(formatPersistentCautionList(cautionsIndex, results, { filter, register, type }));
    }

    if (name === "get_cautions_for_register") {
      const filename = args.filename;
      const register = String(args.register || "").trim();
      const filter = String(args.filter || "").trim();

      if (!register) {
        throw new Error("register is required");
      }

      const result = await getCautionsForRegister(filename, register, {
        filter,
        topK: args.top_k,
      });

      return textResult(formatCautionsForRegister(result));
    }

    if (name === "analyze_module") {
      const filename = args.filename;
      const moduleType = String(args.module_type || "").trim();
      const focus = String(args.focus || "").trim();
      const force = Boolean(args.force);

      const profile = await getModuleProfile(filename, {
        moduleType,
        focus,
        refresh: force,
      });

      const paths = await saveModuleProfile(profile);
      const formatted = formatModuleProfile(profile);
      return textResult([
        formatted,
        "",
        `Module profile JSON saved: ${paths.jsonPath}`,
        `Module profile text saved: ${paths.textPath}`,
      ].join("\n"));
    }

    if (name === "get_module_profile") {
      const filename = args.filename;
      const moduleType = String(args.module_type || "").trim();
      const focus = String(args.focus || "").trim();
      const refresh = Boolean(args.refresh);

      const profile = await getModuleProfile(filename, {
        moduleType,
        focus,
        refresh,
      });

      return textResult(formatModuleProfile(profile));
    }

    if (name === "list_driver_profiles") {
      const createDefault = args.create_default !== false;
      const profiles = await listDriverProfiles({ createDefault });
      return textResult(formatDriverProfilesList(profiles));
    }

    if (name === "driver_completeness_checklist") {
      const filename = args.filename;
      const subsystem = String(args.subsystem || "").trim();
      const driverFamily = String(args.driver_family || "").trim();
      const profile = String(args.profile || "").trim();
      const task = String(args.task || "").trim();
      const createDefault = args.create_default !== false;

      const checklist = await buildDriverCompletenessChecklist(filename, {
        subsystem,
        driverFamily,
        profile,
        task,
        createDefault,
        includeVisualEvidence: args.include_visual_evidence !== false,
        visualFilter: String(args.visual_filter || "").trim(),
        visualStatus: String(args.visual_status || "all").trim(),
        visualGate: String(args.visual_gate || "advisory").trim(),
      });

      return textResult(formatDriverCompletenessChecklist(checklist));
    }

    if (name === "prepare_driver_task") {
      const filename = args.filename;
      const task = String(args.task || "").trim();
      const moduleType = String(args.module_type || "").trim();
      const focusRegisters = normalizeStringArray(args.focus_registers);
      const focusBitfields = normalizeStringArray(args.focus_bitfields);

      if (!task) {
        throw new Error("task is required");
      }

      const plan = await buildDriverTaskPlan(filename, {
        task,
        moduleType,
        focusRegisters,
        focusBitfields,
        topRegisters: args.top_registers,
      });

      const formatted = formatDriverTaskPlan(plan);
      const taskPlanPath = safeDriverTaskPlanPath(filename);
      const taskPlanJsonPath = safeDriverTaskPlanJsonPath(filename);
      const taskPlanMarkdownPath = safeDriverTaskPlanMarkdownPath(filename);
      const evidenceContract = buildDriverTaskPlanEvidenceContract(plan);
      await atomicWriteFile(taskPlanPath, formatted, "utf-8");
      await atomicWriteJson(taskPlanJsonPath, {
        schemaVersion: DRIVER_ARTIFACT_SCHEMA_VERSION,
        serverVersion: SERVER_VERSION,
        artifact: "driver-task-plan",
        filename,
        createdAt: plan.createdAt || nowIso(),
        sourceFingerprint: plan.sourceFingerprint || sourceFingerprint(await getPdfSourceInfo(filename)),
        plan,
        evidenceContract,
        textPath: taskPlanPath,
        markdownPath: taskPlanMarkdownPath,
      });
      await atomicWriteFile(taskPlanMarkdownPath, formatted, "utf-8");
      const manifest = await writeArtifactManifest(filename, { buildStatus: "driver-task-plan-ready", notes: ["driver task plan updated"] });

      return textResult([
        formatted,
        "",
        `Driver task plan saved: ${taskPlanPath}`,
        `Driver task plan JSON saved: ${taskPlanJsonPath}`,
        `Driver task plan Markdown saved: ${taskPlanMarkdownPath}`,
        `Artifact manifest saved: ${safeArtifactManifestPath(filename)} (${manifest.health})`,
      ].join("\n"));
    }

    if (name === "source_review_prompt_pack") {
      const filename = args.filename;
      const pack = await buildSourceReviewPromptPack(filename, {
        subsystem: String(args.subsystem || "").trim(),
        driverFamily: String(args.driver_family || "").trim(),
        profile: String(args.profile || "").trim(),
        task: String(args.task || "").trim(),
        sourceFiles: normalizeStringArray(args.source_files),
        reviewDepth: String(args.review_depth || "standard").trim(),
        outputFormat: String(args.output_format || "report").trim(),
        createDefault: args.create_default !== false,
        includeVisualEvidence: args.include_visual_evidence !== false,
        visualFilter: String(args.visual_filter || "").trim(),
        visualStatus: String(args.visual_status || "all").trim(),
        visualGate: String(args.visual_gate || "advisory").trim(),
      });
      return textResult(formatSourceReviewPromptPack(pack));
    }

    if (name === "compare_driver_requirements") {
      const filename = args.filename;
      const comparison = await compareDriverRequirements(filename, {
        subsystem: String(args.subsystem || "").trim(),
        driverFamily: String(args.driver_family || "").trim(),
        profile: String(args.profile || "").trim(),
        task: String(args.task || "").trim(),
        sourceFiles: normalizeStringArray(args.source_files),
        sourceSummary: String(args.source_summary || "").trim(),
        implementedFeatures: normalizeStringArray(args.implemented_features),
        sourceObservations: normalizeStringArray(args.source_observations),
        missingFeatures: normalizeStringArray(args.missing_features),
        registerOperations: Array.isArray(args.register_operations) ? args.register_operations : [],
        createDefault: args.create_default !== false,
        includeVisualEvidence: args.include_visual_evidence !== false,
        visualFilter: String(args.visual_filter || "").trim(),
        visualStatus: String(args.visual_status || "all").trim(),
        visualGate: String(args.visual_gate || "advisory").trim(),
      });
      return textResult(formatCompareDriverRequirements(comparison));
    }

    if (name === "verify_register_usage") {
      const filename = args.filename;
      const register = String(args.register || "").trim();
      const operation = String(args.operation || "").trim();
      const bitfields = normalizeStringArray(args.bitfields);
      const accessType = String(args.access_type || "auto").trim();
      const intent = String(args.intent || "auto").trim();
      const sourceSnippet = String(args.source_snippet || "").trim();
      const topK = clampTopK(args.top_k);

      if (!register) throw new Error("register is required");
      if (!operation) throw new Error("operation is required");

      const verification = await verifyRegisterUsage(filename, {
        register,
        operation,
        bitfields,
        accessType,
        intent,
        sourceSnippet,
        topK,
      });

      return textResult(formatVerifyRegisterUsage(verification));
    }

    if (name === "build_driver_evidence_pack") {
      const filename = args.filename;
      const moduleType = String(args.module_type || "").trim();
      const focus = String(args.focus || "").trim();
      const mode = String(args.mode || DEFAULT_DRIVER_PACK_MODE).trim();
      const budgetMs = args.budget_ms;

      const pack = await buildDriverEvidencePack(filename, {
        moduleType,
        focus,
        mode,
        budgetMs,
        topRegisters: args.top_registers,
        topSummaries: args.top_summaries,
        includeVisualEvidence: args.include_visual_evidence !== false,
        visualFilter: String(args.visual_filter || "").trim(),
        visualStatus: String(args.visual_status || "all").trim(),
        visualGate: String(args.visual_gate || "advisory").trim(),
        visualTopK: args.visual_top_k,
      });

      const formatted = formatDriverEvidencePack(pack);
      const driverPackPath = safeDriverPackPath(filename);
      const driverPackJsonPath = safeDriverPackJsonPath(filename);
      const driverPackMarkdownPath = safeDriverPackMarkdownPath(filename);
      const evidenceContract = buildDriverEvidencePackContract(pack);
      await atomicWriteFile(driverPackPath, formatted, "utf-8");
      await atomicWriteJson(driverPackJsonPath, {
        schemaVersion: DRIVER_ARTIFACT_SCHEMA_VERSION,
        serverVersion: SERVER_VERSION,
        artifact: "driver-evidence-pack",
        filename,
        createdAt: pack.createdAt || nowIso(),
        sourceFingerprint: pack.sourceFingerprint || sourceFingerprint(await getPdfSourceInfo(filename)),
        pack,
        evidenceContract,
        textPath: driverPackPath,
        markdownPath: driverPackMarkdownPath,
      });
      await atomicWriteFile(driverPackMarkdownPath, formatted, "utf-8");
      const manifest = await writeArtifactManifest(filename, { buildStatus: "driver-pack-ready", notes: ["driver evidence pack updated"] });

      return textResult([
        formatted,
        "",
        `Driver evidence pack saved: ${driverPackPath}`,
        `Driver evidence pack JSON saved: ${driverPackJsonPath}`,
        `Driver evidence pack Markdown saved: ${driverPackMarkdownPath}`,
        `Artifact manifest saved: ${safeArtifactManifestPath(filename)} (${manifest.health})`,
      ].join("\n"));
    }

    if (name === "find_section") {
      const filename = args.filename;
      const section = String(args.section || "").trim();
      const topK = clampTopK(args.top_k);

      if (!section) throw new Error("section is required");

      const { results: sectionResults } = await searchSectionsIndex(filename, section, topK);
      if (sectionResults.length) {
        return textResult(formatSectionResults(sectionResults, section));
      }

      const queries = buildSectionQueries(section);
      const results = await multiQuerySearch(filename, queries, topK);
      return textResult(
        [
          `No direct section-index match for "${section}". Falling back to chunk search.`,
          "",
          formatSearchResults(results, section),
        ].join("\n")
      );
    }

    return errorResult(new Error(`Unknown tool: ${name}`));
  } catch (error) {
    console.error("Tool execution error:", error);
    return errorResult(error);
  }
});

async function runWorkerRebuildArtifactFromArg(encoded) {
  if (!encoded) throw new Error("Missing worker payload");
  const payload = JSON.parse(Buffer.from(String(encoded), "base64").toString("utf-8"));
  const filename = payload.filename;
  const artifact = normalizeArtifactName(payload.artifact);
  const options = payload.options || {};
  const jobId = String(payload.jobId || "").trim();

  await loadJobsStateFromDisk();
  let job = jobId ? jobs.get(jobId) : null;
  if (!job && jobId) {
    const now = nowIso();
    job = {
      id: jobId,
      type: "rebuild-artifact",
      filename,
      status: "queued",
      phase: "queued",
      message: "Worker recreated missing persistent job record",
      createdAt: now,
      createdMs: Date.now(),
      updatedAt: now,
      updatedMs: Date.now(),
      metadata: { artifact, worker: true, detached: true, recreated: true },
      log: [],
    };
    jobs.set(job.id, job);
  }

  try {
    if (job) {
      updateJob(job, { status: "running", phase: `worker-${artifact}`, message: "Detached external worker started", startedAt: nowIso(), startedMs: Date.now() });
      await flushJobsState();
    }

    const result = await rebuildArtifact(filename, artifact, {
      ...options,
      onProgress: null,
    });

    if (job) {
      updateJob(job, { status: "done", phase: "done", message: "Detached external worker completed", finishedAt: nowIso(), finishedMs: Date.now(), result: { ok: true, filename, artifact, result } });
      await flushJobsState();
    }
  } catch (error) {
    if (job) {
      updateJob(job, { status: "failed", phase: "worker-failed", message: "Detached external worker failed", finishedAt: nowIso(), finishedMs: Date.now(), error: error instanceof Error ? error.stack || error.message : String(error) });
      await flushJobsState();
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------------

await fs.mkdir(DOCUMENTS_DIR, { recursive: true });
await fs.mkdir(INDEX_DIR, { recursive: true });

if (process.argv[2] === "--worker-rebuild-artifact") {
  try {
    await runWorkerRebuildArtifactFromArg(process.argv[3]);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[2] === "--smoke") {
  console.log(JSON.stringify({
    ok: true,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    toolCount: tools.length,
    documentsDir: DOCUMENTS_DIR,
    indexDir: INDEX_DIR,
    manifestSchemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
  }, null, 2));
  process.exit(0);
}

await loadJobsStateFromDisk();

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`${SERVER_NAME} started`);
console.error(`Version: ${SERVER_VERSION}`);
console.error(`Documents folder: ${DOCUMENTS_DIR}`);
console.error(`Indexes folder: ${INDEX_DIR}`);
