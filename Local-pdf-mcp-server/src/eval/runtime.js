import { atomicWriteFile, clampTopK, pathExists, safeEvalCasesPath, safeEvalFixturePath, safeEvalProfilePath, safeEvalReportJsonPath, safeEvalReportMarkdownPath, safeEvalReportTextPath, safePdfPath } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { DEFAULT_DRIVER_TASK_BUDGET_MS, DOCUMENTS_DIR, DRIVER_PROFILES_DIR, EVAL_CASES_SCHEMA_VERSION, EVAL_DIR, EVAL_FIXTURES_DIR, EVAL_FIXTURE_SCHEMA_VERSION, EVAL_PROFILES_DIR, EVAL_PROFILE_SCHEMA_VERSION, MAX_EVAL_CASES, RENDERS_DIR, SERVER_VERSION, __dirname } from "../core/runtime-constants.js";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_GOLDEN_PROFILE, evaluateGoldenProfile, formatGoldenReport } from "./golden.js";
import { normalizeDriverProfileHint, sanitizeDriverProfileName } from "../driver-profiles/catalog.js";


const buildDriverCompletenessChecklist = createRuntimePort("buildDriverCompletenessChecklist");
const buildDriverEvidencePack = createRuntimePort("buildDriverEvidencePack");
const buildDriverTaskPlan = createRuntimePort("buildDriverTaskPlan");
const buildManualWorkflowPlan = createRuntimePort("buildManualWorkflowPlan");
const buildPdfIndex = createRuntimePort("buildPdfIndex");
const buildRegisterQueries = createRuntimePort("buildRegisterQueries");
const buildSourceReviewPromptPack = createRuntimePort("buildSourceReviewPromptPack");

const compareDriverRequirements = createRuntimePort("compareDriverRequirements");
const doctorOnePdf = createRuntimePort("doctorOnePdf");
const doctorPdfs = createRuntimePort("doctorPdfs");
const extractBitfieldTable = createRuntimePort("extractBitfieldTable");
const extractRegisterTable = createRuntimePort("extractRegisterTable");
const formatChunkTypeStats = createRuntimePort("formatChunkTypeStats");
const formatCompareDriverRequirements = createRuntimePort("formatCompareDriverRequirements");
const formatDoctorReport = createRuntimePort("formatDoctorReport");
const formatDriverCompletenessChecklist = createRuntimePort("formatDriverCompletenessChecklist");
const formatDriverEvidencePack = createRuntimePort("formatDriverEvidencePack");
const formatDriverTaskPlan = createRuntimePort("formatDriverTaskPlan");
const formatEvalHealthReport = createRuntimePort("formatEvalHealthReport");
const formatExtractedBitfieldTable = createRuntimePort("formatExtractedBitfieldTable");
const formatExtractedRegisterTable = createRuntimePort("formatExtractedRegisterTable");
const formatHybridSearchResults = createRuntimePort("formatHybridSearchResults");
const formatManualWorkflowPlan = createRuntimePort("formatManualWorkflowPlan");
const formatModuleProfile = createRuntimePort("formatModuleProfile");
const formatPersistentCautionList = createRuntimePort("formatPersistentCautionList");
const formatRegisterIndexResults = createRuntimePort("formatRegisterIndexResults");
const formatRegisterListResults = createRuntimePort("formatRegisterListResults");
const formatSearchResults = createRuntimePort("formatSearchResults");
const formatSequenceListResults = createRuntimePort("formatSequenceListResults");
const formatSourceReviewPromptPack = createRuntimePort("formatSourceReviewPromptPack");
const formatVerifyRegisterUsage = createRuntimePort("formatVerifyRegisterUsage");
const getChunkTypeStats = createRuntimePort("getChunkTypeStats");
const getModuleProfile = createRuntimePort("getModuleProfile");
const hybridSearchPdf = createRuntimePort("hybridSearchPdf");
const listCautionsFromIndex = createRuntimePort("listCautionsFromIndex");
const listRegistersFromIndex = createRuntimePort("listRegistersFromIndex");
const listSequencesFromIndex = createRuntimePort("listSequencesFromIndex");
const multiQuerySearch = createRuntimePort("multiQuerySearch");
const normalizeStringArray = createRuntimePort("normalizeStringArray");

const runEvalHealthCheck = createRuntimePort("runEvalHealthCheck");


const searchRegistersIndex = createRuntimePort("searchRegistersIndex");
const verifyRegisterUsage = createRuntimePort("verifyRegisterUsage");


// -----------------------------------------------------------------------------
// Internal eval suite
// -----------------------------------------------------------------------------

export function defaultEvalCases() {
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

export function defaultEvalProfiles() {
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

export function defaultEvalFixtures() {
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

export async function ensureDefaultEvalProfileFiles(createDefault = true) {
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

export async function ensureDefaultEvalFixtureFiles(createDefault = true) {
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

export async function readEvalJsonFile(filePath, expectedSchemaVersion, sourceLabel) {
  const raw = await fs.readFile(filePath, "utf-8");
  const data = JSON.parse(raw);
  if (data.schemaVersion !== expectedSchemaVersion) {
    throw new Error(`${sourceLabel} schema mismatch: expected ${expectedSchemaVersion}, got ${data.schemaVersion ?? "unknown"}`);
  }
  if (!Array.isArray(data.cases)) throw new Error(`${sourceLabel} must contain a cases array`);
  return data;
}

export async function listEvalProfileFiles() {
  await fs.mkdir(EVAL_PROFILES_DIR, { recursive: true });
  const files = await fs.readdir(EVAL_PROFILES_DIR);
  return files.filter((file) => file.toLowerCase().endsWith(".json")).sort((a, b) => a.localeCompare(b));
}

export async function listEvalFixtureFiles() {
  await fs.mkdir(EVAL_FIXTURES_DIR, { recursive: true });
  const files = await fs.readdir(EVAL_FIXTURES_DIR);
  return files.filter((file) => file.toLowerCase().endsWith(".json")).sort((a, b) => a.localeCompare(b));
}

export function annotateEvalCases(cases, source, meta = {}) {
  return (cases || []).map((testCase) => ({
    ...testCase,
    source,
    sourceMeta: meta,
  }));
}

export function normalizeEvalScope(value) {
  const scope = String(value || "all").trim().toLowerCase();
  return ["all", "generic", "profiles", "fixtures"].includes(scope) ? scope : "all";
}

export function evalCaseAppliesToRuntime(testCase, runtime, options = {}) {
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

export function uniqueEvalCases(cases) {
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

export async function loadEvalCasesFromFiles(options = {}) {
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

export async function ensureEvalCasesFile(createDefault = true) {
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

export async function loadEvalCases(options = {}) {
  return loadEvalCasesFromFiles(options);
}

export function materializeEvalArgs(args, runtime) {
  const text = JSON.stringify(args || {});
  const materialized = text
    .replaceAll("${filename}", runtime.filename || "")
    .replaceAll("${module_type}", runtime.moduleType || "")
    .replaceAll("${eval_profile}", runtime.evalProfile || "")
    .replaceAll("${driver_family}", runtime.driverFamily || "")
    .replaceAll("${task}", runtime.task || "");
  return JSON.parse(materialized);
}

export function evalAssertText(output, assertions = {}) {
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

export async function executeEvalCaseTool(tool, args, runtime) {
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
      mode: String(args.mode || "fast").trim(),
      budgetMs: args.budget_ms || DEFAULT_DRIVER_TASK_BUDGET_MS,
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
      includeHybrid: Boolean(args.include_hybrid),
      budgetMs: args.budget_ms || DEFAULT_DRIVER_TASK_BUDGET_MS,
    });
    return formatVerifyRegisterUsage(verification);
  }

  return `SKIP: unsupported eval tool "${tool}"`;
}

export async function maybeAutoIndexForEval(filename, autoIndex) {
  if (!autoIndex) return { autoIndexed: false, reason: "auto_index disabled" };

  const report = await doctorOnePdf(filename, { strict: false });
  const coreNames = new Set(["chunk index", "pages cache", "sections index", "registers index", "bitfields index", "sequences index", "cautions index"]);
  const coreProblem = (report.checks || []).some((check) => coreNames.has(check.name) && check.severity >= 2);
  if (!coreProblem) return { autoIndexed: false, reason: "core indexes already usable" };

  await buildPdfIndex(filename, { force: true, forceLock: false });
  return { autoIndexed: true, reason: "rebuilt missing/broken core indexes" };
}

export async function runEvalSuite(options = {}) {
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

export function formatEvalCases(evalData, caseId = "") {
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

export function formatEvalReport(report) {
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

export async function maybeWriteEvalReport(report, writeReport = true) {
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

export async function listPdfFiles() {
  await fs.mkdir(DOCUMENTS_DIR, { recursive: true });
  const files = await fs.readdir(DOCUMENTS_DIR);

  return files
    .filter((file) => file.toLowerCase().endsWith(".pdf"))
    .sort((a, b) => a.localeCompare(b));
}

export async function getFileStat(filename) {
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
