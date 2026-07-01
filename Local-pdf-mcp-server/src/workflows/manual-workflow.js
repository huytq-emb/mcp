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
    needsVisual: /pinmux|pfc|table\s+\d+(?:[.-]\d+)*|figure\s+\d+(?:[.-]\d+)*|layout|figure|diagram|mux|function|bảng|hình|timing|waveform|bit\s+(?:layout|arrangement)|\bmsb\b|\blsb\b|data\s+formats?\s+handled|format\s+handled|data\s+format|frame\s+format|word\s+format|visual\s+table/.test(text),
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
      calls.push(workflowCall("search_figures", { filename, query: task, build_if_missing: true }, "Find candidate visual artifacts only; this does not provide visual semantics."));
      calls.push(workflowCall("get_figure_context_pack", { filename, figure_id: "<figure_id_from_search_figures>", include_ocr: false }, "Get locator/support context. image_path alone is only a locator; do not claim visual analysis from text extraction only."));
      calls.push(workflowCall("get_figure_image", { filename, figure_id: "<figure_id_from_search_figures>" }, "Load canonical image metadata by default. For RICA use transport=\"image_url\" and bridge structuredContent.image_transport.imageUrls into model imageUrl parts; otherwise inspect MCP image content or open/attach canonical local image. Do not claim visual observation from path only."));
      calls.push(workflowCall("extract_layout_tables_from_pages", { filename, start_page: 1, end_page: 1 }, "Optional supporting/cross-check/locator evidence only. Replace page 1 with the page identified by search_figures/get_figure_context_pack; do not use as primary visual semantic source."));
      calls.push(workflowCall("visual_review_handoff_pack", { filename, query: task, task, include_layout_tables: true }, "Optional handoff around canonical visual workflow. Do not answer from text extraction only. Call get_figure_image; if metadata-only, open/attach canonical image before semantic claims."));
      calls.push(workflowCall("verify_visual_evidence", { filename, evidence_id: "<evidence_id_from_add_visual_evidence_or_visual_evidence_verification_queue>", status: "verified", verification_note: "<manual/text/register evidence used to verify the visual observation>" }, "Driver-critical table/figure evidence should be verified before use; OCR/page text may support but not replace visual review."));
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
    "For figures/visual tables/bit layouts/timing/data formats, use rebuild_figure_manifest -> search_figures -> get_figure_context_pack -> get_figure_image. Do not claim visual analysis from image_path string alone. The agent must inspect pixels returned by an image-capable client or open/attach the canonical image after metadata-only get_figure_image.",
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
  hybrid_search_pdf: { when: "Recall-oriented text search. Text extraction can locate visual tables, but must not be semantic truth; Visual/captioned tables live in .figures.json.", next: "For visual tables use search_figures -> get_figure_context_pack -> get_figure_image; otherwise read_pdf_pages/find_register/find_bitfield", trust: "locator/supporting only for visual content" },
  find_register: { when: "Locate a specific register or macro in the manual.", next: "summarize_register/find_bitfield/verify_register_usage", trust: "manual evidence candidate" },
  find_bitfield: { when: "Locate a bitfield/macro and candidate semantics.", next: "verify_register_usage", trust: "manual evidence candidate" },
  list_sequences: { when: "Find start/stop/reset/initialization sequences.", next: "get_sequence or verify_register_usage", trust: "sequence evidence" },
  list_cautions: { when: "Find restrictions/cautions/reserved-bit/clear-semantics notes.", next: "get_cautions_for_register", trust: "risk evidence" },
  extract_layout_tables_from_pages: { when: "Coordinate/text-item table extraction, not visual semantic truth. Visual/captioned tables live in .figures.json; structured text/layout tables live in .tables.json.", next: "search_figures -> get_figure_context_pack -> get_figure_image for visual/captioned tables", trust: "locator/supporting only for visual content" },
  rebuild_figure_manifest: { when: "Build or refresh the canonical figure manifest before figure retrieval.", next: "search_figures", trust: "artifact builder" },
  search_figures: { when: "Use this for Figure/Table/visual-table lookup. Visual/captioned tables live in .figures.json. This locates candidate visual artifacts; it does not provide visual semantics.", next: "get_figure_context_pack, then get_figure_image for metadata or opt-in image content", trust: "locator only" },
  get_figure_context_pack: { when: "Main visual-semantics entry point. Returns canonical image_path under indexes/cache/figure-images when possible; page/OCR text is locator/support only.", next: "call get_figure_image; if metadata-only, open/attach canonical image before semantic claims", trust: "image_content is semantic truth; image_path is locator only" },
  visual_review_handoff_pack: { when: "Optional handoff that prioritizes search_figures -> get_figure_context_pack -> get_figure_image metadata-first image review.", next: "call get_figure_image; for RICA use transport=\"image_url\" and bridge structuredContent.image_transport.imageUrls into model imageUrl parts; otherwise inspect MCP image content or open/attach the canonical image, then add_visual_evidence/verify_visual_evidence", trust: "handoff" },
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

const HIDDEN_USAGE_TOOLS = new Set();

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
  lines.push("Canonical figure/visual-table flow: rebuild_figure_manifest -> search_figures -> get_figure_context_pack -> get_figure_image. For RICA use get_figure_image(..., transport=\"image_url\") and require the client to bridge structuredContent.image_transport.imageUrls into model imageUrl parts; otherwise inspect MCP image content or open/attach canonical image. image_path is a locator only; do not claim visual observation from path only.");
  lines.push("Visual/captioned tables live in .figures.json; structured text/layout tables live in .tables.json; text extraction is locator/supporting only for visual semantics.");
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
  const canonicalFigureToolNames = ["rebuild_figure_manifest", "search_figures", "get_figure_context_pack", "get_figure_image", "ocr_figure_for_search"];
  const missingFigureTools = canonicalFigureToolNames.filter((name) => !toolNames.includes(name) || !handlersSource.includes(`"${name}": handle_`));
  const ocrHealth = await getOcrHealth({ timeoutMs: 10_000 });
  const pymupdfVersion = ocrHealth.python?.versions?.pymupdf || ocrHealth.versions?.pymupdf || "";
  const renderCapable = ocrHealth.python?.ok !== false && Boolean(pymupdfVersion);
  add("canonical_figure_tools", missingFigureTools.length ? "fail" : "pass", [
    missingFigureTools.length ? `missing_tools=${missingFigureTools.join(",")}` : "tools=rebuild_figure_manifest,search_figures,get_figure_context_pack,get_figure_image,ocr_figure_for_search",
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
