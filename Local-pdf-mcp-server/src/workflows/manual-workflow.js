import { atomicWriteFile, ensureInsideRoot } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { INDEX_DIR, SERVER_VERSION, STEP40_COMPAT_MODE, STEP40_CONTROL_ACTIONS, STEP40_DIRECT_TOOL_COMPAT_NOTES, __dirname } from "../core/runtime-constants.js";
import { getHybridRuntimeStatus } from "../services/python-worker.js";
import { getOcrHealth } from "../services/ocr.js";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeDriverProfileHint } from "../driver-profiles/catalog.js";


const doctorOnePdf = createRuntimePort("doctorOnePdf");
const ensureDefaultDriverProfiles = createRuntimePort("ensureDefaultDriverProfiles");
const ensureDefaultEvalFixtureFiles = createRuntimePort("ensureDefaultEvalFixtureFiles");
const ensureDefaultEvalProfileFiles = createRuntimePort("ensureDefaultEvalProfileFiles");
const ensureEvalCasesFile = createRuntimePort("ensureEvalCasesFile");

const isDoctorCoreCheck = createRuntimePort("isDoctorCoreCheck");
const listEvalFixtureFiles = createRuntimePort("listEvalFixtureFiles");
const loadEvalCases = createRuntimePort("loadEvalCases");
const normalizeStringArray = createRuntimePort("normalizeStringArray");
const validateDriverProfileCatalog = createRuntimePort("validateDriverProfileCatalog");


// -----------------------------------------------------------------------------
// Step 39: workflow router and eval/static-hardening helpers
// -----------------------------------------------------------------------------

export function uniqueNonEmptyStrings(values) {
  return [...new Set(normalizeStringArray(values).map((v) => v.trim()).filter(Boolean))];
}

export function inferWorkflowFlags(taskText, moduleType, sourceFiles = []) {
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

export function q(value) {
  return JSON.stringify(value);
}

export function workflowCall(tool, args = {}, why = "") {
  return { tool, args, why };
}

export async function buildManualWorkflowPlan(options = {}) {
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
      coreHealth: report.coreHealth || report.health || "unknown",
      advisoryHealth: report.advisoryHealth || "ok",
      advisories: report.advisories || [],
      summary: report.summary || null,
      blockingChecks: (report.checks || []).filter((c) => isDoctorCoreCheck(c) && c.severity >= 2).map((c) => ({ name: c.name, status: c.status, message: c.message })),
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
      calls.push(workflowCall("rebuild_figure_manifest", { filename }, "Build/update canonical figure manifest before visual retrieval."));
      calls.push(workflowCall("search_figures", { filename, query: task, build_if_missing: true }, "Find candidate figures by caption/page/search metadata."));
      calls.push(workflowCall("get_figure_context_pack", { filename, figure_id: "<figure_id_from_search_figures>", include_ocr: false }, "Return image_path and supporting context; AI agent must open image_path visually before claiming semantic figure facts. OCR/page text is only supporting evidence, not semantic truth."));
      calls.push(workflowCall("extract_layout_tables_from_pages", { filename, start_page: "<page>", end_page: "<page>" }, "Use layout-aware extraction for wide manual tables as supporting evidence."));
      calls.push(workflowCall("visual_review_handoff_pack", { filename, task, pages: [] }, "Generate render/region instructions when text extraction is not trustworthy; AI visual inspection remains required for figure semantics."));
      calls.push(workflowCall("verify_visual_evidence", { filename, evidence_id: "<id>", status: "verified", note: "<human-checked table/figure meaning>" }, "Driver-critical table/figure evidence should be verified before use; OCR/page text may support but not replace visual review."));
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

export function formatManualWorkflowPlan(plan) {
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
    lines.push(`- Core health: ${plan.pdfHealth.coreHealth}`);
    lines.push(`- Advisory health: ${plan.pdfHealth.advisoryHealth}`);
    if (plan.pdfHealth.blockingChecks.length) {
      for (const check of plan.pdfHealth.blockingChecks) lines.push(`- Blocker: ${check.name}: ${check.message || check.status || "problem"}`);
    } else lines.push("- No blocking core check reported by doctor.");
    if ((plan.pdfHealth.advisories || []).length) {
      for (const advisory of plan.pdfHealth.advisories.slice(0, 5)) {
        const text = [...(advisory.advisories || []), ...(advisory.warnings || [])].filter(Boolean).join("; ") || advisory.status;
        lines.push(`- Advisory: ${advisory.name}: ${text}`);
      }
    }
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

export const TOOL_USAGE_CATALOG = {
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
  rebuild_figure_manifest: { when: "Build or refresh the canonical figure manifest before figure retrieval.", next: "search_figures", trust: "artifact builder" },
  search_figures: { when: "Find candidate figures by caption/page/search metadata; OCR is optional metadata only.", next: "get_figure_context_pack", trust: "figure retrieval candidate" },
  get_figure_context_pack: { when: "Collect figure metadata, surrounding text, and image_path for AI visual inspection.", next: "AI agent opens image_path visually", trust: "retrieval pack; visual meaning requires inspection" },
  build_figures_index: { when: "Hidden legacy compatibility alias for rebuild_figure_manifest; do not advertise in normal workflows.", next: "rebuild_figure_manifest -> search_figures -> get_figure_context_pack", trust: "deprecated compatibility" },
  find_figure: { when: "Hidden legacy compatibility alias for text-formatted figure search; prefer retrieval-first figure workflow.", next: "search_figures -> get_figure_context_pack", trust: "deprecated compatibility" },
  get_figure_context: { when: "Hidden legacy compatibility alias for text-formatted figure context; prefer context packs with image_path/image_access.", next: "search_figures -> get_figure_context_pack", trust: "deprecated compatibility" },
  render_figure: { when: "Hidden legacy compatibility path only; do not advertise in normal workflows.", next: "search_figures -> get_figure_context_pack", trust: "deprecated compatibility" },
  render_figure_page: { when: "Hidden legacy compatibility path only; prefer retrieval-first figure workflow before rendering whole pages.", next: "search_figures -> get_figure_context_pack", trust: "deprecated compatibility" },
  render_figure_region: { when: "Hidden legacy compatibility path only; prefer manifest-backed figure images/context packs.", next: "search_figures -> get_figure_context_pack", trust: "deprecated compatibility" },
  ocr_figure: { when: "Hidden legacy compatibility path only; OCR is optional search metadata, not semantic truth.", next: "ocr_figure_for_search only when search keywords need OCR", trust: "deprecated compatibility" },
  inspect_figure: { when: "Hidden legacy compatibility path only; prefer retrieval-first figure workflow.", next: "search_figures -> get_figure_context_pack", trust: "deprecated compatibility" },
  visual_review_handoff_pack: { when: "Prepare human/agent visual review for figures, pinmux, bit tables, timing diagrams.", next: "add_visual_evidence/verify_visual_evidence", trust: "handoff" },
  verify_visual_evidence: { when: "Mark visual/table evidence as verified/rejected/needs_verification.", next: "driver_completeness_checklist/source_review_prompt_pack", trust: "verified visual evidence if status=verified" },
  driver_completeness_checklist: { when: "Create subsystem/profile checklist for source review.", next: "source_review_prompt_pack", trust: "review contract" },
  build_driver_evidence_pack: { when: "Collect module-level manual anchors for driver review/debug.", next: "source_review_prompt_pack", trust: "evidence pack" },
  source_review_prompt_pack: { when: "Tell VS Code agent what source facts to extract and which MCP calls to make.", next: "verify_register_usage", trust: "workflow contract" },
  verify_register_usage: { when: "Verify a readl/writel/regmap/register operation from source against manual semantics.", next: "compare_driver_requirements", trust: "strongest register-operation evidence" },
  compare_driver_requirements: { when: "Final source-observation vs manual/profile matrix.", next: "final report/patch plan", trust: "synthesis; depends on source observations quality" },
  plan_manual_workflow: { when: "First tool when task is ambiguous or multi-step.", next: "follow recommendedCalls", trust: "router" },
  eval_health_check: { when: "After modifying MCP code/eval/profile files for eval/static health only.", next: "run_eval/npm test; use mcp_control(action=\"compat_report\") for control-plane compatibility", trust: "static hardening only" },
  run_eval: { when: "Run regression/smoke cases against a manual.", next: "fix failures or add fixtures", trust: "regression signal" },
};

const HIDDEN_USAGE_TOOLS = new Set([
  "build_figures_index",
  "find_figure",
  "get_figure_context",
  "inspect_figure",
  "render_figure",
  "render_figure_page",
  "render_figure_region",
  "ocr_figure",
]);

function visibleToolUsageNames() {
  return Object.keys(TOOL_USAGE_CATALOG).filter((key) => !HIDDEN_USAGE_TOOLS.has(key)).sort();
}

export function formatToolUsage(toolName = "", task = "") {
  const name = String(toolName || "").trim();
  const lines = ["MCP Tool Usage Guide"];
  if (task) lines.push(`Task context: ${task}`);
  lines.push("");
  if (name) {
    const entry = TOOL_USAGE_CATALOG[name];
    if (!entry) return [`MCP Tool Usage Guide`, `Unknown tool: ${name}`, "", `Available tools: ${visibleToolUsageNames().join(", ")}`].join("\n");
    lines.push(`${name}`);
    lines.push(`- when: ${entry.when}`);
    lines.push(`- next: ${entry.next}`);
    lines.push(`- trust: ${entry.trust}`);
    return lines.join("\n");
  }
  for (const key of visibleToolUsageNames()) {
    const entry = TOOL_USAGE_CATALOG[key];
    lines.push(`- ${key}: ${entry.when} Next: ${entry.next}. Trust: ${entry.trust}.`);
  }
  lines.push("", "Default driver-review flow: plan_manual_workflow -> doctor -> get_module_profile -> build_driver_evidence_pack -> source_review_prompt_pack -> verify_register_usage per source operation -> compare_driver_requirements.");
  lines.push("Canonical figure flow: rebuild_figure_manifest -> search_figures -> get_figure_context_pack -> AI agent opens image_path visually.");
  return lines.join("\n");
}

export function buildStep407CompatibilityReport() {
  return {
    schemaVersion: "step40.7.compatibility.v1",
    serverVersion: SERVER_VERSION,
    createdAt: new Date().toISOString(),
    mode: STEP40_COMPAT_MODE,
    health: "PASS",
    supportedInterface: "mcp_control(action=...)",
    deprecatedInterface: "eval_health_check(step40_action=...)",
    evalHealthRole: "eval_health_check is for eval/static health only",
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
      'mcp_control(action="ping")',
      'mcp_control(action="index_status_lite", filename="<manual>.pdf")',
      'mcp_control(action="rebuild_artifact", filename="<manual>.pdf", artifact="pages")',
      'mcp_control(action="job_status", job_id="<job_id>")',
      'mcp_control(action="list_jobs")'
    ]
  };
}

export function formatStep407CompatibilityReport(report) {
  const lines = [
    "Step 40.7 MCP compatibility report",
    `Server version: ${report.serverVersion}`,
    `Health: ${report.health}`,
    `Mode: ${report.mode}`,
    `Supported interface: ${report.supportedInterface}`,
    "",
    `Supported Step 40 actions via ${report.supportedInterface}:`,
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

export async function runEvalHealthCheck(options = {}) {
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
  const toolDefinitionsSource = await fs.readFile(path.join(__dirname, "src", "mcp", "tool-definitions.js"), "utf-8");
  const toolNames = [...toolDefinitionsSource.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
  const schemaCount = (toolDefinitionsSource.match(/inputSchema:\s*{\s*type:\s*"object"/gs) || []).length;
  const dupTools = toolNames.filter((n, i) => toolNames.indexOf(n) !== i);
  add("tool registry unique names", dupTools.length ? "fail" : "pass", dupTools.length ? `duplicates=${dupTools.join(",")}` : `tools=${toolNames.length}`);
  const handlersSource = await fs.readFile(path.join(__dirname, "src", "mcp", "runtime-handlers.js"), "utf-8");
  const missingHandlers = toolNames.filter((n) => !handlersSource.includes(`"${n}": handle_`));
  add("call handler coverage", missingHandlers.length ? "fail" : "pass", missingHandlers.length ? `missing=${missingHandlers.join(",")}` : `handlers=${toolNames.length}`);
  add("tool input schemas", schemaCount === toolNames.length ? "pass" : "fail", schemaCount === toolNames.length ? "all tools have object inputSchema" : `schemas=${schemaCount}; tools=${toolNames.length}`);
  try { await loadEvalCases({ createDefault, scope: "all", includeProfiles: true, includeFixtures, includeDisabled: true }); add("eval case loading", "pass", "manual cases/profiles/fixtures readable"); } catch (e) { add("eval case loading", "fail", e.message); }
  if (includeProfiles) {
    try {
      const catalog = await validateDriverProfileCatalog({ createDefault });
      add("driver profile loading", catalog.ok ? "pass" : "fail", catalog.ok ? `profiles=${catalog.profiles}, fragments=${catalog.fragments}` : catalog.failures.join("; "));
    } catch (e) {
      add("driver profile loading", "fail", e.message);
    }
  }
  if (includeFixtures) {
    try { const fixtures = await listEvalFixtureFiles(); add("eval fixture readability", "pass", `fixtures=${fixtures.length}`); } catch (e) { add("eval fixture readability", "fail", e.message); }
  }
  let pkg = null;
  try { pkg = JSON.parse(await fs.readFile(path.join(__dirname, "package.json"), "utf-8")); add("package.json", "pass", `test=${pkg.scripts?.test || "missing"}`); } catch (e) { add("package.json", "fail", e.message); }
  const extractionRuntime = await getHybridRuntimeStatus();
  add("hybrid extraction runtime", extractionRuntime.pythonReady || extractionRuntime.mode === "auto" ? "pass" : "fail", extractionRuntime.pythonReady ? `engine=python; version=${extractionRuntime.versions?.python || "unknown"}` : `engine=node-fallback; ${extractionRuntime.reason || "Python unavailable"}`);
  const figureOcrToolNames = ["render_figure", "ocr_figure", "inspect_figure"];
  const missingFigureOcrTools = figureOcrToolNames.filter((name) => !toolNames.includes(name) || !handlersSource.includes(`"${name}": handle_`));
  const ocrHealth = await getOcrHealth({ timeoutMs: 10_000 });
  const pymupdfVersion = ocrHealth.python?.versions?.pymupdf || ocrHealth.versions?.pymupdf || "";
  const renderCapable = ocrHealth.python?.ok !== false && Boolean(pymupdfVersion);
  add("figure_ocr_tools", missingFigureOcrTools.length ? "fail" : "pass", [
    missingFigureOcrTools.length ? `missing_tools=${missingFigureOcrTools.join(",")}` : "tools=render_figure,ocr_figure,inspect_figure",
    renderCapable ? `pymupdf=${pymupdfVersion}` : "pymupdf=unavailable",
    ocrHealth.ocr?.available ? `ocr=${ocrHealth.ocr.engine || "paddleocr"} available` : `ocr=optional-missing (${ocrHealth.ocr?.hint || "install requirements-ocr.txt"})`,
  ].join("; "));
  add("step40.7 compatibility mode", "pass", `mode=${STEP40_COMPAT_MODE}; supported=mcp_control(action=...); deprecated=eval_health_check(step40_action=...); hidden_direct_tools=6`);
  const summary = { total: checks.length, pass: checks.filter((c) => c.status === "pass").length, fail: checks.filter((c) => c.status === "fail").length };
  return { schemaVersion: "step39.eval-health.v1", serverVersion: SERVER_VERSION, createdAt: new Date().toISOString(), health: summary.fail ? "fail" : "pass", summary, extractionRuntime, checks };
}

export async function maybeWriteEvalHealthReport(report, writeReport = true) {
  if (!writeReport) return [];
  await fs.mkdir(INDEX_DIR, { recursive: true });
  const jsonPath = ensureInsideRoot(path.join(INDEX_DIR, "eval-health-report.json"), INDEX_DIR, "eval health report JSON");
  const textPath = ensureInsideRoot(path.join(INDEX_DIR, "eval-health-report.txt"), INDEX_DIR, "eval health report text");
  await atomicWriteFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  await atomicWriteFile(textPath, formatEvalHealthReport(report), "utf-8");
  return [jsonPath, textPath];
}

export function formatEvalHealthReport(report) {
  const lines = ["MCP Eval Health Check", `Created: ${report.createdAt}`, `Server version: ${report.serverVersion}`, `Health: ${report.health.toUpperCase()}`, `Summary: total=${report.summary.total}, pass=${report.summary.pass}, fail=${report.summary.fail}`, ""];
  for (const check of report.checks || []) lines.push(`- [${String(check.status).toUpperCase()}] ${check.name}: ${check.detail || ""}`);
  return lines.join("\n");
}
