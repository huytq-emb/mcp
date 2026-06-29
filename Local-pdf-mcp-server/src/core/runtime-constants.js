import path from "node:path";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";

export const __dirname = DEFAULT_RUNTIME_CONFIG.rootDir;
export const __filename = path.join(__dirname, "index.js");
export const DOCUMENTS_DIR = DEFAULT_RUNTIME_CONFIG.paths.documentsDir;
export const INDEX_DIR = DEFAULT_RUNTIME_CONFIG.paths.indexDir;
export const EVAL_DIR = DEFAULT_RUNTIME_CONFIG.paths.evalDir;
export const EVAL_PROFILES_DIR = DEFAULT_RUNTIME_CONFIG.paths.evalProfilesDir;
export const EVAL_FIXTURES_DIR = DEFAULT_RUNTIME_CONFIG.paths.evalFixturesDir;
export const DRIVER_PROFILES_DIR = DEFAULT_RUNTIME_CONFIG.paths.driverProfilesDir;
export const DRIVER_PROFILE_FRAGMENTS_DIR = DEFAULT_RUNTIME_CONFIG.paths.driverProfileFragmentsDir;
export const RENDERS_DIR = DEFAULT_RUNTIME_CONFIG.paths.rendersDir;

export const SERVER_NAME = "local-pdf-mcp-server";
export const SERVER_VERSION = "7.1.0";
export const STEP40_COMPAT_MODE = "mcp-control-plane";
export const STEP40_DIRECT_TOOL_COMPAT_NOTES = [
  "Step 40 direct tool names were observed to be cancelled by some VS Code AI-agent MCP clients even when the server and handler registry were healthy.",
  "The supported Step 40 interface is mcp_control(action=...).",
  "eval_health_check(step40_action=...) is deprecated and now returns only a migration message.",
  "Direct Step 40 tools remain hidden/internal compatibility paths only and must not be advertised."
];
export const STEP40_CONTROL_ACTIONS = [
  "ping",
  "compat_report",
  "index_status_lite",
  "ocr_health",
  "rebuild_artifact",
  "job_status",
  "list_jobs",
  "cancel_job",
  "cleanup_jobs",
  "cache_status",
  "cleanup_cache",
  "figure_cache_status",
  "cleanup_figure_cache"
];
export const EVIDENCE_CONTRACT_SCHEMA_VERSION = 1;
export const EVAL_CASES_SCHEMA_VERSION = 1;
export const EVAL_PROFILE_SCHEMA_VERSION = 1;
export const EVAL_FIXTURE_SCHEMA_VERSION = 1;
export const DRIVER_PROFILE_SCHEMA_VERSION = 1;
export const VISUAL_EVIDENCE_SCHEMA_VERSION = 1;
export const DRIVER_ARTIFACT_SCHEMA_VERSION = 1;

export const DEFAULT_CHUNK_SIZE = 2600;
export const DEFAULT_CHUNK_OVERLAP = 450;
export const MIN_CHUNK_SIZE = 800;
export const MAX_CHUNK_SIZE = 12000;

export const DEFAULT_TOP_K = 8;
export const MAX_TOP_K = 30;

export const DEFAULT_HYBRID_TOP_K = 12;
export const MAX_HYBRID_TOP_K = 40;
export const HYBRID_MIN_SCORE = 20;
export const HYBRID_CANDIDATE_LIMIT = 420;
export const HYBRID_BM25_K1 = 1.35;
export const HYBRID_BM25_B = 0.72;
export const HYBRID_BM25_WEIGHT = 24;
export const HYBRID_PROXIMITY_WINDOW = 18;
export const HYBRID_PROXIMITY_WEIGHT = 28;

export const DEFAULT_REGISTER_LIST_TOP_K = 80;
export const MAX_REGISTER_LIST_TOP_K = 200;

export const DEFAULT_REGISTER_SUMMARY_CHUNKS = 10;
export const MAX_REGISTER_SUMMARY_CHUNKS = 24;
export const MAX_REGISTER_SUMMARY_BITFIELDS = 60;

export const DEFAULT_BITFIELD_LIST_TOP_K = 80;
export const MAX_BITFIELD_LIST_TOP_K = 240;
export const MAX_BITFIELD_TABLE_ROWS = 120;

export const DEFAULT_TABLE_PAGE_RANGE = 4;
export const MAX_TABLE_PAGE_RANGE = 8;
export const MAX_EXTRACTED_TABLES = 12;
export const MAX_TABLE_ROWS_PER_TABLE = 80;
export const MAX_TABLE_COLUMNS = 16;

export const DEFAULT_SEQUENCE_TOP_K = 10;
export const MAX_SEQUENCE_TOP_K = 30;
export const MAX_SEQUENCE_EVIDENCE_LINES = 10;
export const DEFAULT_SEQUENCE_INDEX_TOPICS = 40;
export const DEFAULT_SEQUENCE_LIST_TOP_K = 80;
export const MAX_SEQUENCE_LIST_TOP_K = 200;
export const MAX_SEQUENCE_INDEX_RESULTS_PER_TOPIC = 8;

export const DEFAULT_CAUTION_TOP_K = 10;
export const MAX_CAUTION_TOP_K = 30;
export const MAX_CAUTION_EVIDENCE_LINES = 12;

export const DEFAULT_DRIVER_PACK_REGISTERS = 24;
export const MAX_DRIVER_PACK_REGISTERS = 80;
export const DEFAULT_DRIVER_PACK_SUMMARIES = 8;
export const MAX_DRIVER_PACK_SUMMARIES = 24;
export const DEFAULT_DRIVER_PACK_SEQUENCE_TOPICS = 10;
export const DEFAULT_DRIVER_PACK_CAUTION_TOPICS = 10;
export const DEFAULT_DRIVER_PACK_MODE = "adaptive";
export const DRIVER_PACK_FAST_SEQUENCE_LIMIT = 12;
export const DRIVER_PACK_FAST_CAUTION_LIMIT = 12;
export const DEFAULT_DRIVER_PACK_BUDGET_MS = 25000;
export const MIN_DRIVER_PACK_BUDGET_MS = 5000;
export const MAX_DRIVER_PACK_BUDGET_MS = 120000;
export const DRIVER_PACK_BUDGET_SAFETY_MS = 1500;
export const DRIVER_PACK_FULL_MIN_BUDGET_MS = 60000;
export const DEFAULT_DRIVER_TASK_REGISTERS = 12;
export const MAX_DRIVER_TASK_REGISTERS = 40;
export const DEFAULT_DRIVER_TASK_BUDGET_MS = 25000;
export const MAX_DRIVER_TASK_HINTS = 12;

export const INDEX_LOCK_SCHEMA_VERSION = 1;
export const INDEX_LOCK_STALE_MS = 30 * 60 * 1000;
export const ATOMIC_WRITE_RETRY_MS = 50;
export const MAX_EVAL_CASES = 200;

export const LARGE_PDF_BACKGROUND_PAGE_THRESHOLD = 350;
export const MAX_ACTIVE_JOBS = 2;
export const JOB_HISTORY_LIMIT = 40;
export const JOB_LOG_LIMIT = 80;
export const JOBS_STATE_SCHEMA_VERSION = 1;
export const JOBS_STATE_WRITE_DELAY_MS = 250;
// Give the MCP transport a chance to flush the tool response before heavy
// background work starts. setTimeout(..., 0) can still let PDF extraction begin
// before some clients receive the response, causing opaque "tool call canceled"
// failures on large manuals.
function parseBackgroundJobStartDelayMs(env = process.env) {
  const raw = env.RENESAS_MCP_BACKGROUND_JOB_START_DELAY_MS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return 5000;
  const value = Number(String(raw).trim());
  return Number.isFinite(value) && value >= 0 ? value : 5000;
}
export const BACKGROUND_JOB_START_DELAY_MS = parseBackgroundJobStartDelayMs();
export const WORKER_JOB_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
export const DEFAULT_INDEX_JOB_MODE = "auto";
export const PYTHON_WORKER_PROTOCOL_VERSION = 1;
export const PYTHON_WORKER_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const PYTHON_WORKER_CANCEL_GRACE_MS = 3000;
export const PYTHON_WORKER_MAX_STDOUT_LINE_BYTES = 1024 * 1024;
export const PYTHON_WORKER_MAX_STDERR_BYTES = 256 * 1024;
export const DEFAULT_EXTRACTION_ENGINE = "auto";
// Tables/semantic builders stay behind the parity gate until their RZ/G3E
// golden results match the established Node artifacts.
export const DEFAULT_PYTHON_OPERATIONS = ["pdf", "pages"];

// index_status must be a cheap health probe. Do not JSON.parse large index/page
// artifacts just to report whether they exist; read only a small header window
// and fall back to full parse only for tiny files.
export const STATUS_FAST_READ_BYTES = 256 * 1024;
export const STATUS_FULL_PARSE_MAX_BYTES = 512 * 1024;

export const DEFAULT_CAUTION_LIST_TOP_K = 80;
export const MAX_CAUTION_LIST_TOP_K = 200;
export const DEFAULT_FIGURE_TOP_K = 40;
export const MAX_FIGURE_TOP_K = 200;

export const MIN_RENDER_DPI = 72;
export const DEFAULT_RENDER_DPI = 160;
export const MAX_RENDER_DPI = 300;
export const RENDER_COMMAND_TIMEOUT_MS = 120000;
export const MAX_RENDER_PAGE_RANGE = 1;
export const DEFAULT_CAUTION_INDEX_TOPICS = 36;
export const MAX_CAUTION_INDEX_RESULTS_PER_TOPIC = 10;

export const DEFAULT_PAGE_RANGE = 5;
export const MAX_PAGE_RANGE = 20;

export const MAX_TOOL_OUTPUT_CHARS = 30000;
export const MAX_PREVIEW_CHARS = 1200;
export const PAGE_CACHE_SCHEMA_VERSION = 1;
export const SECTION_INDEX_SCHEMA_VERSION = 1;
export const REGISTER_INDEX_SCHEMA_VERSION = 1;
export const TABLE_INDEX_SCHEMA_VERSION = 1;
export const BITFIELD_INDEX_SCHEMA_VERSION = 3;
export const SEQUENCE_INDEX_SCHEMA_VERSION = 2;
export const CAUTION_INDEX_SCHEMA_VERSION = 1;
export const FIGURE_INDEX_SCHEMA_VERSION = 1;
export const FIGURE_OCR_SCHEMA_VERSION = 1;
export const MODULE_PROFILE_SCHEMA_VERSION = 1;
export const MAX_TEXT_ITEM_GAP_SPACES = 12;

export const INDEX_SCHEMA_VERSION = 3;
