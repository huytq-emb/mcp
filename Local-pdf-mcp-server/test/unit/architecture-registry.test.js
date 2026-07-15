import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { HIDDEN_COMPATIBILITY_TOOL_NAMES, HIDDEN_TOOL_DEFINITIONS, PUBLIC_TOOL_DEFINITIONS, PUBLIC_TOOL_NAMES } from "../../src/mcp/tool-definitions.js";
import { createRuntimeToolRegistry } from "../../src/mcp/runtime-registry.js";
import { createAppContext } from "../../src/core/app-context.js";
import { atomicWriteJson } from "../../src/core/atomic-file.js";
import { withPathResolver } from "../../src/core/path-resolver.js";
import { wireRuntimePorts } from "../../src/app/runtime-wiring.js";
import { buildManualWorkflowPlan, validateWorkflowCalls } from "../../src/workflows/manual-workflow.js";
import { artifactPathsForStatus } from "../../src/services/jobs.js";
import { ARTIFACT_MANIFEST_SCHEMA_VERSION } from "../../src/artifacts/manifest.js";
import { withReleasedEvidenceGraph } from "../../src/mcp/handlers/manual-evidence.js";

const execFileAsync = promisify(execFile);
const REMOVED_PUBLIC_FIGURE_TOOLS = [
  "build_figures_index",
  "find_figure",
  "get_figure_context",
  "inspect_figure",
  "render_figure",
  "render_figure_page",
  "render_figure_region",
  "ocr_figure",
  "render_pdf_page",
  "render_pdf_region",
];

const PUBLIC_FIGURE_TOOLS = [
  "rebuild_figure_manifest",
  "search_figures",
  "get_figure_image",
  "get_figure_context_pack",
  "ocr_figure_for_search",
];

const HIDDEN_DIRECT_CALL_RE = /\b(?:driver_completeness_checklist|prepare_driver_task|visual_review_handoff_pack|extract_layout_tables_from_pages|extract_pinmux_table|find_sequence|find_caution|start_index_pdf|validate_index|job_status|list_jobs|eval_health_check|run_eval|get_visual_evidence|visual_evidence_verification_queue|verify_visual_evidence)\s*\(/;

test("advanced manual inspection releases the resident evidence graph before loading artifacts", async () => {
  const events = [];
  const wrapped = withReleasedEvidenceGraph(async (value) => {
    events.push(`handler:${value}`);
    return value.toUpperCase();
  }, () => { events.push("release"); });
  assert.equal(await wrapped("manual"), "MANUAL");
  assert.deepEqual(events, ["release", "handler:manual"]);
});

test("public MCP catalog preserves names and schemas", () => {
  assert.equal(new Set(PUBLIC_TOOL_NAMES).size, PUBLIC_TOOL_DEFINITIONS.length);
  const digest = createHash("sha256").update(JSON.stringify(PUBLIC_TOOL_DEFINITIONS)).digest("hex");
  assert.match(digest, /^[a-f0-9]{64}$/);
  const controlTool = PUBLIC_TOOL_DEFINITIONS.find((tool) => tool.name === "mcp_control");
  assert.equal(controlTool.inputSchema.required.includes("action"), true);
  for (const action of ["ping", "compat_report", "index_status_lite", "ocr_health", "rebuild_artifact", "job_status", "list_jobs", "cancel_job", "cleanup_jobs", "cache_status", "cleanup_cache", "figure_cache_status", "cleanup_figure_cache"]) {
    assert.equal(controlTool.inputSchema.properties.action.enum.includes(action), true, action);
  }
  for (const name of PUBLIC_FIGURE_TOOLS) assert.equal(PUBLIC_TOOL_NAMES.includes(name), true, name);
  for (const name of REMOVED_PUBLIC_FIGURE_TOOLS) assert.equal(PUBLIC_TOOL_NAMES.includes(name), false, name);
  for (const name of ["job_status", "list_jobs", "start_index_pdf", "validate_index", "run_eval", "list_eval_cases", "analyze_figure_semantics", "search_figure_semantics", "rebuild_figure_semantics"]) {
    assert.equal(PUBLIC_TOOL_NAMES.includes(name), false, name);
    assert.equal(HIDDEN_COMPATIBILITY_TOOL_NAMES.includes(name), true, name);
  }
  assert.equal(new Set(PUBLIC_TOOL_NAMES).intersection?.(new Set(HIDDEN_COMPATIBILITY_TOOL_NAMES))?.size || PUBLIC_TOOL_NAMES.filter((name) => HIDDEN_COMPATIBILITY_TOOL_NAMES.includes(name)).length, 0);
  const hiddenDefinitionNames = HIDDEN_TOOL_DEFINITIONS.map((tool) => tool.name);
  for (const name of HIDDEN_COMPATIBILITY_TOOL_NAMES) assert.equal(hiddenDefinitionNames.includes(name), true, name);
  for (const definition of HIDDEN_TOOL_DEFINITIONS) assert.equal(definition.inputSchema?.type, "object", definition.name);
  const contextPackTool = PUBLIC_TOOL_DEFINITIONS.find((tool) => tool.name === "get_figure_context_pack");
  assert.equal(contextPackTool.inputSchema.properties.dpi.type, "number");
  const figureImageTool = PUBLIC_TOOL_DEFINITIONS.find((tool) => tool.name === "get_figure_image");
  assert.deepEqual(figureImageTool.inputSchema.properties.transport.enum, ["metadata", "mcp_image", "image_url"]);
});


test("hidden job helper definitions point agents to mcp_control as preferred control plane", () => {
  const startIndex = HIDDEN_TOOL_DEFINITIONS.find((tool) => tool.name === "start_index_pdf");
  const jobStatus = HIDDEN_TOOL_DEFINITIONS.find((tool) => tool.name === "job_status");
  const listJobs = HIDDEN_TOOL_DEFINITIONS.find((tool) => tool.name === "list_jobs");

  assert.match(startIndex.description, /mcp_control\(action="job_status"/);
  assert.match(jobStatus.description, /preferred control-plane/);
  assert.match(listJobs.description, /mcp_control\(action="list_jobs"/);
  assert.doesNotMatch(startIndex.description, /public helper/i);
  assert.doesNotMatch(jobStatus.description, /public helper/i);
  assert.doesNotMatch(listJobs.description, /public helper/i);
});


test("runtime registry covers advertised and hidden compatibility handlers", async () => {
  const registry = createRuntimeToolRegistry();
  assert.equal(registry.advertisedCount, PUBLIC_TOOL_DEFINITIONS.length);
  assert.equal(registry.handlerCount, PUBLIC_TOOL_DEFINITIONS.length + HIDDEN_COMPATIBILITY_TOOL_NAMES.length);
  assert.deepEqual(registry.hiddenNames, HIDDEN_COMPATIBILITY_TOOL_NAMES);
  for (const name of [...PUBLIC_TOOL_NAMES, ...HIDDEN_COMPATIBILITY_TOOL_NAMES]) assert.equal(registry.has(name), true, name);
  const ping = await registry.dispatchTool("mcp_server_ping");
  assert.match(ping.content[0].text, /ping: OK/i);
  await assert.rejects(registry.dispatchTool("not_a_tool"), /Unknown tool/);
});

test("entrypoint and MCP assembly modules remain thin", async () => {
  const indexSource = await fs.readFile("index.js", "utf-8");
  assert.ok(indexSource.split(/\r?\n/).length <= 80);
  assert.doesNotMatch(indexSource, /function\s+(?:build|load|search|find|render|extract)[A-Z]/);
  const runtimeHandlersSource = await fs.readFile("src/mcp/runtime-handlers.js", "utf-8");
  assert.ok(runtimeHandlersSource.split(/\r?\n/).length <= 80);
  assert.doesNotMatch(runtimeHandlersSource, /async function handle_/);
  const toolDefinitionsSource = await fs.readFile("src/mcp/tool-definitions.js", "utf-8");
  assert.ok(toolDefinitionsSource.split(/\r?\n/).length <= 80);
  assert.match(toolDefinitionsSource, /tool-definitions\/catalog\.js/);
  const { stdout } = await execFileAsync(process.execPath, ["scripts/architecture-health.js"], { cwd: process.cwd() });
  assert.match(stdout, /Architecture health: PASS/);
});

test("registry is generic and does not import the concrete tool catalog", async () => {
  const source = await fs.readFile("src/mcp/registry.js", "utf-8");
  assert.doesNotMatch(source, /tool-definitions/);
  assert.doesNotMatch(source, /HIDDEN_TOOL_NAMES/);
});

test("architecture modules can be imported without starting the MCP transport", async () => {
  const code = 'import("./src/app/bootstrap.js").then(() => console.log("IMPORT_OK"))';
  const { stdout, stderr } = await execFileAsync(process.execPath, ["-e", code], { cwd: process.cwd() });
  assert.match(stdout, /IMPORT_OK/);
  assert.equal(stderr.trim(), "");
});

test("worker CLI preserves the missing-payload failure contract", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["index.js", "--worker-rebuild-artifact"], { cwd: process.cwd() }),
    (error) => error.code === 1 && /Missing worker payload/.test(error.stderr),
  );
});

test("worker CLI rejects payloads without a persistent job ID", async () => {
  const encoded = Buffer.from(JSON.stringify({
    filename: "",
    artifact: "pages",
    options: {},
  }), "utf-8").toString("base64");
  await assert.rejects(
    execFileAsync(process.execPath, ["index.js", "--worker-rebuild-artifact", encoded], { cwd: process.cwd() }),
    (error) => error.code === 1 &&
      /missing its persistent job ID/.test(error.stderr) &&
      !/refreshJobsStateFromDisk is not defined/.test(error.stderr),
  );
});


test("mcp_control validates required action arguments and eval_health_check step40 shim migrates", async () => {
  const registry = createRuntimeToolRegistry();
  const deprecated = await registry.dispatchTool("eval_health_check", { step40_action: "ping" });
  assert.match(deprecated.content[0].text, /Deprecated: use mcp_control\(action=\.\.\.\) instead/);
  assert.doesNotMatch(deprecated.content[0].text, /MCP control ping: OK/);

  await assert.rejects(
    registry.dispatchTool("mcp_control", { action: "rebuild_artifact" }),
    /filename is required for mcp_control\(action="rebuild_artifact"\)/,
  );
  await assert.rejects(
    registry.dispatchTool("mcp_control", { action: "job_status" }),
    /job_id is required for mcp_control\(action="job_status"\)/,
  );

  const compat = await registry.dispatchTool("mcp_control", { action: "compat_report", json: true });
  const report = JSON.parse(compat.content[0].text);
  assert.equal(report.supportedInterface, "mcp_control(action=...)");
  assert.equal(report.deprecatedInterface, "eval_health_check(step40_action=...)");
  assert.equal(report.replacements.job_status, 'mcp_control(action="job_status", job_id="...")');
  assert.match(report.replacements.figure_semantic_tools, /actual image/);
  assert.equal(report.notes.some((note) => /supported.*eval_health_check\(step40_action/i.test(note)), false);
});

test("mcp_control compat_report text uses supported control-plane wording", async () => {
  const registry = createRuntimeToolRegistry();
  const compat = await registry.dispatchTool("mcp_control", { action: "compat_report" });
  const text = compat.content[0].text;

  assert.match(text, /Supported interface: mcp_control\(action=\.\.\.\)/);
  assert.match(text, /Supported Step 40 actions via mcp_control/);
  assert.doesNotMatch(text, /Supported Step 40 actions via eval_health_check/);
  assert.match(text, /job_status -> mcp_control\(action="job_status"/);
  assert.match(text, /figure_semantic_tools -> .*actual image/);
});

test("hidden legacy control handlers fail fast when filename is missing", async () => {
  const registry = createRuntimeToolRegistry();

  await assert.rejects(
    registry.dispatchTool("rebuild_artifact", { artifact: "pages" }),
    /Invalid arguments for rebuild_artifact: \/filename must have required property/
  );

  await assert.rejects(
    registry.dispatchTool("pdf_index_status_lite", {}),
    /Invalid arguments for pdf_index_status_lite: \/filename must have required property/
  );

  await assert.rejects(
    registry.dispatchTool("index_status", {}),
    /Invalid arguments for index_status: \/filename must have required property/
  );
});

test("named hidden compatibility helpers remain hidden-callable with schema validation", async () => {
  const registry = createRuntimeToolRegistry();
  for (const name of ["prepare_driver_task", "extract_pinmux_table", "extract_layout_tables_from_pages", "list_figures"]) {
    assert.equal(PUBLIC_TOOL_NAMES.includes(name), false, name);
    assert.equal(HIDDEN_COMPATIBILITY_TOOL_NAMES.includes(name), true, name);
    assert.equal(registry.has(name), true, name);
    await assert.rejects(registry.dispatchTool(name, {}), new RegExp(`Invalid arguments for ${name}`));
  }
});

test("job cancellation refreshes persisted job state before canceling", async () => {
  const source = await fs.readFile("src/mcp/handlers/control.js", "utf-8");
  assert.match(source, /if \(action === "cancel_job"\) \{\s+await refreshJobsStateFromDisk\(\);\s+const jobId[\s\S]*?cancelBackgroundJob/);
  assert.match(source, /async function handle_cancel_job[\s\S]*?await refreshJobsStateFromDisk\(\);[\s\S]*?cancelBackgroundJob/);
});

test("index_status_lite performs bounded artifact checks and returns actionable state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-index-status-lite-"));
  try {
    const context = createAppContext({ rootDir: root });
    wireRuntimePorts(context);
    await fs.mkdir(context.paths.documentsDir(), { recursive: true });
    await fs.writeFile(context.paths.pdf("manual.pdf"), "%PDF-1.4\nstatus fixture\n", "utf8");
    const registry = createRuntimeToolRegistry({ context });
    const result = await registry.dispatchTool("mcp_control", { action: "index_status_lite", filename: "manual.pdf", json: true });
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.health, "WARN");
    assert.equal(status.pdf.size > 0, true);
    assert.equal(status.missing.includes("chunk-index"), true);
    assert.equal(status.artifacts.some((artifact) => artifact.key === "pages" && artifact.exists === false), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("index_status_lite JSON stays valid when persisted jobs contain large results and logs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-index-status-bounded-"));
  try {
    const context = createAppContext({ rootDir: root });
    wireRuntimePorts(context);
    await fs.mkdir(context.paths.documentsDir(), { recursive: true });
    await fs.mkdir(context.paths.jobsDir(), { recursive: true });
    await fs.writeFile(context.paths.pdf("manual.pdf"), "%PDF-1.4\nbounded status fixture\n", "utf8");
    for (let index = 0; index < 8; index += 1) {
      const id = `large-job-${index}`;
      await atomicWriteJson(context.paths.job(id), {
        id,
        type: "index-pdf",
        filename: "manual.pdf",
        status: "done",
        phase: "complete",
        createdMs: index + 1,
        updatedMs: index + 1,
        metadata: { artifact: "core", oversized: "m".repeat(10_000) },
        result: { oversized: "r".repeat(10_000) },
        log: Array.from({ length: 20 }, () => ({ message: "l".repeat(1_000) })),
      });
    }
    const registry = createRuntimeToolRegistry({ context });
    const result = await registry.dispatchTool("mcp_control", { action: "index_status_lite", filename: "manual.pdf", json: true });
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.relatedJobs.length, 8);
    assert.equal(status.relatedJobs.every((job) => job.result === undefined && job.log === undefined), true);
    assert.deepEqual(result.structuredContent, status);
    assert.equal(result.content[0].text.includes("Output truncated"), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("index_status_lite rejects a ready manifest from a different PDF generation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-index-status-stale-"));
  try {
    const context = createAppContext({ rootDir: root });
    wireRuntimePorts(context);
    await fs.mkdir(context.paths.documentsDir(), { recursive: true });
    const pdfBytes = Buffer.from("%PDF-1.4\nstale status fixture\n");
    await fs.writeFile(context.paths.pdf("manual.pdf"), pdfBytes);
    const entries = await withPathResolver(context.paths, () => artifactPathsForStatus("manual.pdf"));
    for (const entry of entries.filter((item) => !item.optional || item.key === "evidence-graph")) {
      await atomicWriteJson(entry.path, {
        schemaVersion: entry.schemaVersion,
        filename: "manual.pdf",
        ...(entry.countKey ? { [entry.countKey]: 1 } : {}),
        ...(entry.rootKey ? { [entry.rootKey]: [] } : {}),
      });
    }
    const staleFingerprint = `size=${pdfBytes.length};sha256=${"0".repeat(64)}`;
    await atomicWriteJson(context.paths.manifest("manual.pdf"), {
      schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
      filename: "manual.pdf",
      buildStatus: "ready",
      health: "ok",
      source: { size: pdfBytes.length, sha256: "0".repeat(64) },
      generation: { buildId: "old-build", sourceFingerprint: staleFingerprint, evidenceGraphGeneration: "old-graph" },
      artifacts: {},
      missingRequired: [],
      notes: [],
    });
    const registry = createRuntimeToolRegistry({ context });
    const result = await registry.dispatchTool("mcp_control", { action: "index_status_lite", filename: "manual.pdf", json: true });
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.health, "WARN");
    assert.equal(status.stale.includes("manifest-source"), true);
    assert.equal(status.stale.includes("manifest-generation-source"), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("removed legacy visual/render tools are absent from public and hidden runtime registries", async () => {
  const registry = createRuntimeToolRegistry();
  for (const name of REMOVED_PUBLIC_FIGURE_TOOLS) {
    assert.equal(PUBLIC_TOOL_NAMES.includes(name), false, name);
    assert.equal(HIDDEN_COMPATIBILITY_TOOL_NAMES.includes(name), false, name);
    assert.equal(registry.has(name), false, name);
    await assert.rejects(() => registry.dispatchTool(name, { filename: "manual.pdf" }), /Unknown tool/);
  }
});

test("default tool usage catalog hides legacy figure compatibility tools", async () => {
  const registry = createRuntimeToolRegistry();
  const result = await registry.dispatchTool("explain_tool_usage", {});
  const text = result.content[0].text;

  assert.doesNotMatch(text, /\brender_figure\b/);
  assert.doesNotMatch(text, /\bocr_figure\b/);
  assert.doesNotMatch(text, /\binspect_figure\b/);
  assert.doesNotMatch(text, /\bfind_figure\b/);
  assert.doesNotMatch(text, /\bget_figure_context\b/);
  assert.doesNotMatch(text, /\bbuild_figures_index\b/);
  assert.doesNotMatch(text, /\brender_figure_page\b/);
  assert.doesNotMatch(text, /\brender_figure_region\b/);

  assert.match(text, /\brebuild_figure_manifest\b/);
  assert.match(text, /\bsearch_figures\b/);
  assert.match(text, /\bget_figure_context_pack\b/);
});

test("explicit removed legacy visual tool usage lookup returns unknown", async () => {
  const registry = createRuntimeToolRegistry();
  for (const toolName of REMOVED_PUBLIC_FIGURE_TOOLS) {
    const result = await registry.dispatchTool("explain_tool_usage", { tool_name: toolName });
    assert.match(result.content[0].text, new RegExp(`Unknown tool: ${toolName}`));
    assert.doesNotMatch(result.content[0].text, /Debug\/compatibility only|deprecated compatibility/i);
  }
});
test("plan_manual_workflow recommends canonical figure flow for visual tasks", async () => {
  const context = createAppContext();
  wireRuntimePorts(context);
  const registry = createRuntimeToolRegistry({ context });
  const result = await registry.dispatchTool("plan_manual_workflow", {
    filename: "manual.pdf",
    task: "analyze timing diagram / figure",
    include_visual: true,
    include_eval: false,
  });
  const text = result.content[0].text;

  assert.match(text, /rebuild_figure_manifest/);
  assert.match(text, /search_figures/);
  assert.match(text, /get_figure_context_pack/);
  assert.match(text, /image_path/);
  assert.match(text, /include_ocr":false/);
  assert.match(text, /<figure_id_from_search_figures>/);
  assert.match(text, /"query":"analyze timing diagram \/ figure"/);
  assert.match(text, /add_visual_evidence/);
  assert.match(text, /visual_evidence_report/);
  assert.match(text, /metadata-only|open\/attach canonical image|actual opened\/attached PNG image input/);
  assert.match(text, /Do not claim visual analysis|do not claim visual analysis/i);
  assert.match(text, /"direct_visual_observations":/);
  assert.match(text, /"verification_status":"needs_verification"/);
  assert.match(text, /template — substitute placeholders before execution/);
  assert.doesNotMatch(text, /extract_tables_from_pages/);
  assert.doesNotMatch(text, /"start_page":1/);
  assert.doesNotMatch(text, /"end_page":1/);
  assert.doesNotMatch(text, /"pages":\[\]/);
  assert.doesNotMatch(text, /"note":"<human-checked table\/figure meaning>"/);
  assert.doesNotMatch(text, /\bfind_figure\b/);
  assert.doesNotMatch(text, /\bget_figure_context\b/);
  assert.doesNotMatch(text, /\brender_figure\b/);
  assert.doesNotMatch(text, /\bocr_figure\b/);
  assert.doesNotMatch(text, HIDDEN_DIRECT_CALL_RE);

  const rebuildIndex = text.indexOf("rebuild_figure_manifest");
  const searchIndex = text.indexOf("search_figures");
  const contextIndex = text.indexOf("get_figure_context_pack");
  const imageIndex = text.indexOf("get_figure_image");
  assert.ok(rebuildIndex >= 0 && rebuildIndex < searchIndex && searchIndex < contextIndex && contextIndex < imageIndex);
});


test("visual table planner uses visual-first workflow without render tools", async () => {
  const context = createAppContext();
  wireRuntimePorts(context);
  const registry = createRuntimeToolRegistry({ context });
  const result = await registry.dispatchTool("plan_manual_workflow", {
    filename: "rzv2h.pdf",
    task: "phân tích Table 8.2-5 Data Formats Handled in the SCU",
    include_visual: true,
    include_eval: false,
  });
  const text = result.content[0].text;

  for (const expected of ["rebuild_figure_manifest", "search_figures", "get_figure_context_pack", "image_path", "get_figure_image", "image_path alone is only a locator", "metadata-only", "open/attach the canonical image", "Do not claim visual analysis"]) {
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), expected);
  }
  for (const forbidden of ["render_pdf_page", "render_pdf_region", "render_figure_region", "render_figure_page", "render_figure", "ocr_figure"]) {
    assert.doesNotMatch(text, new RegExp(`\\b${forbidden}\\b`), forbidden);
  }
  assert.doesNotMatch(text, HIDDEN_DIRECT_CALL_RE);
  if (/read_pdf_pages/.test(text)) assert.match(text, /supporting|cross-check|locator/i);
});

test("workflow planner emits schema-valid calls and marks placeholders as templates", async () => {
  const context = createAppContext();
  wireRuntimePorts(context);
  const plan = await buildManualWorkflowPlan({
    filename: "manual.pdf",
    task: "review DMA interrupt clear timing figure",
    module_type: "dmaengine",
    include_visual: true,
    include_eval: false,
  });
  const validation = validateWorkflowCalls(plan.recommendedCalls, PUBLIC_TOOL_DEFINITIONS);
  assert.deepEqual(validation, { ok: true, errors: [] });
  const listRegisters = plan.recommendedCalls.find((call) => call.tool === "list_registers");
  assert.equal(Object.hasOwn(listRegisters.args, "filter"), true);
  assert.equal(Object.hasOwn(listRegisters.args, "query"), false);
  assert.equal(plan.recommendedCalls.some((call) => call.tool === "mcp_control"), false);
  assert.equal(plan.recommendedCalls.filter((call) => call.executable).every((call) => !JSON.stringify(call.args).includes("<")), true);
  assert.equal(plan.recommendedCalls.some((call) => call.tool === "get_figure_context_pack" && call.kind === "template"), true);
});

test("public workflow outputs do not recommend hidden direct helper calls", async () => {
  const context = createAppContext();
  wireRuntimePorts(context);
  const registry = createRuntimeToolRegistry({ context });
  const filename = "unit-public-surface.pdf";

  await registry.dispatchTool("add_visual_evidence", {
    filename,
    query: "reset timing visual evidence",
    page: 1,
    direct_visual_observations: ["reset timing label visible in the opened canonical image"],
    verification_status: "needs_verification",
  });

  const cases = [
    ["plan_manual_workflow", { filename, task: "review reset timing figure", module_type: "generic", include_visual: true, include_eval: true }],
    ["source_review_prompt_pack", { filename, task: "review reset timing figure", subsystem: "generic", visual_gate: "block_unverified" }],
    ["visual_evidence_report", { filename, filter: "reset timing", status: "all", include_entries: true }],
    ["compare_driver_requirements", { filename, subsystem: "generic", task: "review reset timing figure", source_observations: ["driver has reset path"], visual_gate: "block_unverified" }],
  ];

  for (const [tool, args] of cases) {
    const result = await registry.dispatchTool(tool, args);
    const text = result.content[0].text;
    assert.doesNotMatch(text, HIDDEN_DIRECT_CALL_RE, tool);
  }
});

test("compare_driver_requirements returns visual evidence gate blockers", async () => {
  const context = createAppContext();
  wireRuntimePorts(context);
  const registry = createRuntimeToolRegistry({ context });
  const filename = "unit-visual-gate.pdf";

  await registry.dispatchTool("add_visual_evidence", {
    filename,
    query: "clock reset sequence",
    page: 2,
    direct_visual_observations: ["clock/reset sequence arrows were visible in the opened canonical image"],
    verification_status: "needs_verification",
  });

  const result = await registry.dispatchTool("compare_driver_requirements", {
    filename,
    subsystem: "generic",
    task: "clock reset sequence review",
    visual_filter: "clock reset sequence",
    source_observations: ["driver deasserts reset after enabling clock"],
    visual_gate: "block_unverified",
  });
  const text = result.content[0].text;

  assert.match(text, /5b\. Visual evidence verification gate/);
  assert.match(text, /gate mode: block_unverified/);
  assert.match(text, /BLOCKERS:/);
  assert.match(text, /add_visual_evidence/);
  assert.doesNotMatch(text, HIDDEN_DIRECT_CALL_RE);
});

test("default tool usage catalog does not advertise render tools as normal visual workflow", async () => {
  const registry = createRuntimeToolRegistry();
  const result = await registry.dispatchTool("explain_tool_usage", {});
  const text = result.content[0].text;
  for (const forbidden of ["render_pdf_page", "render_pdf_region", "render_figure_region", "render_figure_page", "render_figure"]) {
    assert.doesNotMatch(text, new RegExp(`\\b${forbidden}\\b`), forbidden);
  }

  const explicit = await registry.dispatchTool("explain_tool_usage", { tool_name: "render_pdf_page" });
  assert.match(explicit.content[0].text, /Unknown tool: render_pdf_page/);
  assert.doesNotMatch(explicit.content[0].text, /Debug\/compatibility only|Prefer search_figures/);
});

test("get_figure_image default is RICA-safe metadata for canonical image_path", async () => {
  const imagePath = "indexes/cache/figure-images/unit-transport/test.png";
  await fs.mkdir("indexes/cache/figure-images/unit-transport", { recursive: true });
  await fs.writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lR9sWQAAAABJRU5ErkJggg==", "base64"));
  const registry = createRuntimeToolRegistry({ context: createAppContext() });
  const result = await registry.dispatchTool("get_figure_image", { image_path: imagePath });
  assert.equal(result.content.every((item) => item.type === "text"), true);
  assert.ok(result.content.some((item) => item.text.includes("metadata")));
  assert.ok(result.content.some((item) => item.text.includes("canonical_image_path")));
  assert.ok(result.content.some((item) => item.text.includes("NO_IMAGE_INPUT")));
  assert.equal(result.structuredContent.image_transport.canonical_image_path, imagePath);
  assert.equal(result.structuredContent.image_transport.file_exists, true);
  assert.equal(result.structuredContent.image_transport.mimeType, "image/png");
  assert.equal(JSON.stringify(result).includes('"type":"image"'), false);
  assert.equal(JSON.stringify(result).includes("data:image"), false);
  assert.equal(result.structuredContent.image_transport.mode, "metadata");
  assert.equal(result.structuredContent.image_transport.mcp_image_content_returned, false);
});

test("get_figure_image mcp_image transport returns MCP image content for canonical image_path", async () => {
  const imagePath = "indexes/cache/figure-images/unit-transport/test.png";
  await fs.mkdir("indexes/cache/figure-images/unit-transport", { recursive: true });
  await fs.writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lR9sWQAAAABJRU5ErkJggg==", "base64"));
  const registry = createRuntimeToolRegistry({ context: createAppContext() });
  const result = await registry.dispatchTool("get_figure_image", { image_path: imagePath, transport: "mcp_image" });
  assert.ok(result.content.some((item) => item.type === "image"));
  const image = result.content.find((item) => item.type === "image");
  assert.ok(image.data);
  assert.equal(image.mimeType, "image/png");
  assert.equal(result.structuredContent.image_transport.mode, "mcp_image");
  assert.equal(result.structuredContent.image_transport.mcp_image_content_returned, true);
  assert.equal(result.structuredContent.image_transport.experimental, true);
  assert.equal(result.structuredContent.image_transport.client_dependent, true);
  assert.equal(result.structuredContent.image_transport.not_guaranteed_to_reach_model_vision_input, true);
});

test("get_figure_image image_url transport returns data URI in structuredContent only", async () => {
  const imagePath = "indexes/cache/figure-images/unit-transport/test.png";
  await fs.mkdir("indexes/cache/figure-images/unit-transport", { recursive: true });
  await fs.writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lR9sWQAAAABJRU5ErkJggg==", "base64"));
  const registry = createRuntimeToolRegistry({ context: createAppContext() });
  const result = await registry.dispatchTool("get_figure_image", { image_path: imagePath, transport: "image_url" });
  assert.equal(result.content.every((item) => item.type === "text"), true);
  assert.equal(JSON.stringify(result.content).includes("data:image"), false);
  assert.equal(JSON.stringify(result).includes('"type":"image"'), false);
  assert.equal(result.structuredContent.image_transport.mode, "image_url");
  assert.equal(result.structuredContent.image_transport.imageUrl.url.startsWith("data:image/png;base64,"), true);
  assert.equal(result.structuredContent.image_transport.imageUrls[0].startsWith("data:image/png;base64,"), true);
  assert.equal(result.structuredContent.image_transport.mcp_image_content_returned, false);
  assert.equal(result.structuredContent.image_transport.experimental, true);
  assert.equal(result.structuredContent.image_transport.client_dependent, true);
  assert.equal(result.structuredContent.image_transport.not_guaranteed_to_reach_model_vision_input, true);
});

test("get_figure_image image_url transport rejects oversized data URI safely", async () => {
  const imagePath = "indexes/cache/figure-images/unit-transport/oversize.png";
  await fs.mkdir("indexes/cache/figure-images/unit-transport", { recursive: true });
  await fs.writeFile(imagePath, Buffer.alloc(32, 1));
  const registry = createRuntimeToolRegistry({ context: createAppContext() });
  const result = await registry.dispatchTool("get_figure_image", { image_path: imagePath, transport: "image_url", max_bytes: 4 });
  assert.equal(result.content.every((item) => item.type === "text"), true);
  assert.equal(JSON.stringify(result).includes("data:image"), false);
  assert.equal(JSON.stringify(result).includes('"type":"image"'), false);
  assert.equal(result.structuredContent.image_transport.mode, "image_url");
  assert.equal(result.structuredContent.image_transport.available, false);
  assert.equal(result.structuredContent.image_transport.reason, "image_too_large_for_data_uri_transport");
  assert.equal(result.structuredContent.image_transport.fallback_transport, "metadata");
});

test("get_figure_image missing canonical image is RICA-safe metadata only", async () => {
  const imagePath = "indexes/cache/figure-images/unit-transport/missing.png";
  await fs.rm(imagePath, { force: true });
  const registry = createRuntimeToolRegistry({ context: createAppContext() });
  const result = await registry.dispatchTool("get_figure_image", { image_path: imagePath });
  assert.equal(result.content.every((item) => item.type === "text"), true);
  assert.equal(JSON.stringify(result).includes('"type":"image"'), false);
  assert.equal(JSON.stringify(result).includes("data:image"), false);
  assert.equal(result.structuredContent.image_transport.mode, "metadata");
  assert.equal(result.structuredContent.image_transport.mcp_image_content_returned, false);
});
