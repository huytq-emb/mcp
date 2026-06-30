import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { PUBLIC_TOOL_DEFINITIONS, PUBLIC_TOOL_NAMES } from "../../src/mcp/tool-definitions.js";
import { HIDDEN_COMPATIBILITY_TOOL_NAMES } from "../../src/mcp/registry.js";
import { createRuntimeToolRegistry } from "../../src/mcp/runtime-registry.js";
import { createAppContext } from "../../src/core/app-context.js";
import { wireRuntimePorts } from "../../src/app/runtime-wiring.js";

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
];

const PUBLIC_FIGURE_TOOLS = [
  "rebuild_figure_manifest",
  "list_figures",
  "search_figures",
  "get_figure_image",
  "get_figure_context_pack",
  "ocr_figure_for_search",
];

test("public MCP catalog preserves names and schemas", () => {
  assert.equal(new Set(PUBLIC_TOOL_NAMES).size, PUBLIC_TOOL_DEFINITIONS.length);
  const digest = createHash("sha256").update(JSON.stringify(PUBLIC_TOOL_DEFINITIONS)).digest("hex");
  assert.match(digest, /^[a-f0-9]{64}$/);
  const healthTool = PUBLIC_TOOL_DEFINITIONS.find((tool) => tool.name === "eval_health_check");
  assert.equal(healthTool.inputSchema.properties.step40_action.description.includes("Deprecated"), true);
  assert.doesNotMatch(healthTool.description, /job|artifact|cache control/i);
  const controlTool = PUBLIC_TOOL_DEFINITIONS.find((tool) => tool.name === "mcp_control");
  assert.equal(controlTool.inputSchema.required.includes("action"), true);
  for (const action of ["ping", "compat_report", "index_status_lite", "ocr_health", "rebuild_artifact", "job_status", "list_jobs", "cancel_job", "cleanup_jobs", "cache_status", "cleanup_cache", "figure_cache_status", "cleanup_figure_cache"]) {
    assert.equal(controlTool.inputSchema.properties.action.enum.includes(action), true, action);
  }
  for (const name of PUBLIC_FIGURE_TOOLS) assert.equal(PUBLIC_TOOL_NAMES.includes(name), true, name);
  for (const name of REMOVED_PUBLIC_FIGURE_TOOLS) assert.equal(PUBLIC_TOOL_NAMES.includes(name), false, name);
  const contextPackTool = PUBLIC_TOOL_DEFINITIONS.find((tool) => tool.name === "get_figure_context_pack");
  assert.equal(contextPackTool.inputSchema.properties.dpi.type, "number");
});


test("public job helper descriptions point agents to mcp_control as preferred control plane", () => {
  const startIndex = PUBLIC_TOOL_DEFINITIONS.find((tool) => tool.name === "start_index_pdf");
  const jobStatus = PUBLIC_TOOL_DEFINITIONS.find((tool) => tool.name === "job_status");
  const listJobs = PUBLIC_TOOL_DEFINITIONS.find((tool) => tool.name === "list_jobs");

  assert.match(startIndex.description, /mcp_control\(action="job_status"/);
  assert.match(startIndex.description, /direct job_status/);
  assert.match(jobStatus.description, /Direct public helper/);
  assert.match(jobStatus.description, /preferred control-plane/);
  assert.match(listJobs.description, /Direct public helper/);
  assert.match(listJobs.description, /mcp_control\(action="list_jobs"/);
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

test("index.js remains a thin bootstrap and architecture graph is acyclic", async () => {
  const indexSource = await fs.readFile("index.js", "utf-8");
  assert.ok(indexSource.split(/\r?\n/).length <= 80);
  assert.doesNotMatch(indexSource, /function\s+(?:build|load|search|find|render|extract)[A-Z]/);
  const { stdout } = await execFileAsync(process.execPath, ["scripts/architecture-health.js"], { cwd: process.cwd() });
  assert.match(stdout, /Architecture health: PASS/);
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

test("worker CLI handles rebuild payload failures without missing refresh import", async () => {
  const encoded = Buffer.from(JSON.stringify({
    filename: "",
    artifact: "pages",
    options: {},
  }), "utf-8").toString("base64");
  await assert.rejects(
    execFileAsync(process.execPath, ["index.js", "--worker-rebuild-artifact", encoded], { cwd: process.cwd() }),
    (error) => error.code === 1 &&
      /filename is required/.test(error.stderr) &&
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
  assert.equal(report.notes.some((note) => /supported.*eval_health_check\(step40_action/i.test(note)), false);
});

test("mcp_control compat_report text uses supported control-plane wording", async () => {
  const registry = createRuntimeToolRegistry();
  const compat = await registry.dispatchTool("mcp_control", { action: "compat_report" });
  const text = compat.content[0].text;

  assert.match(text, /Supported interface: mcp_control\(action=\.\.\.\)/);
  assert.match(text, /Supported Step 40 actions via mcp_control/);
  assert.doesNotMatch(text, /Supported Step 40 actions via eval_health_check/);
});

test("hidden legacy control handlers fail fast when filename is missing", async () => {
  const registry = createRuntimeToolRegistry();

  await assert.rejects(
    registry.dispatchTool("rebuild_artifact", { artifact: "pages" }),
    (error) => /filename is required/.test(error.message) &&
      /deprecated rebuild_artifact/.test(error.message) &&
      /mcp_control\(action="rebuild_artifact"/.test(error.message),
  );

  await assert.rejects(
    registry.dispatchTool("pdf_index_status_lite", {}),
    (error) => /filename is required/.test(error.message) &&
      /deprecated pdf_index_status_lite/.test(error.message) &&
      /mcp_control\(action="index_status_lite"/.test(error.message),
  );

  await assert.rejects(
    registry.dispatchTool("index_status", {}),
    (error) => /filename is required/.test(error.message) &&
      /deprecated index_status/.test(error.message) &&
      /mcp_control\(action="index_status_lite"/.test(error.message),
  );
});

test("ultra-lite index status hints recommend mcp_control only", async () => {
  const registry = createRuntimeToolRegistry();
  const result = await registry.dispatchTool("mcp_control", { action: "index_status_lite", filename: "manual.pdf" });
  const text = result.content[0].text;
  assert.match(text, /mcp_control\(action="rebuild_artifact"/);
  assert.match(text, /mcp_control\(action="index_status_lite"/);
  assert.doesNotMatch(text, /eval_health_check\(step40_action/);
  assert.doesNotMatch(text, /\bindex_status\(filename=/);
  assert.doesNotMatch(text, /\brebuild_artifact\(\.\.\./);
});

test("hidden compatibility handlers warn while remaining unadvertised", async () => {
  const registry = createRuntimeToolRegistry();
  for (const name of REMOVED_PUBLIC_FIGURE_TOOLS) {
    assert.equal(registry.has(name), true, name);
    assert.equal(PUBLIC_TOOL_NAMES.includes(name), false, name);
  }
  const ping = await registry.dispatchTool("mcp_server_ping");
  assert.match(ping.content[0].text, /Deprecated compatibility path\. Prefer mcp_control\(action=\.\.\.\)\./);
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

test("explicit legacy figure tool usage lookup remains available with compatibility warning", async () => {
  const registry = createRuntimeToolRegistry();

  for (const toolName of REMOVED_PUBLIC_FIGURE_TOOLS) {
    const result = await registry.dispatchTool("explain_tool_usage", { tool_name: toolName });
    const text = result.content[0].text;

    assert.doesNotMatch(text, /Unknown tool/);
    assert.match(text, new RegExp(`\\b${toolName}\\b`));
    assert.match(text, /Hidden legacy compatibility path|legacy compatibility|deprecated/i);
    if (toolName === "build_figures_index") {
      assert.match(text, /rebuild_figure_manifest\s*->\s*search_figures\s*->\s*get_figure_context_pack/);
    } else if (toolName === "ocr_figure") {
      assert.match(text, /ocr_figure_for_search/);
    } else {
      assert.match(text, /search_figures\s*->\s*get_figure_context_pack/);
    }
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
  assert.match(text, /"include_layout_tables":true/);
  assert.match(text, /"include_render_commands":true/);
  assert.match(text, /"verification_note":/);
  assert.match(text, /"start_page":1/);
  assert.match(text, /"end_page":1/);
  assert.doesNotMatch(text, /"pages":\[\]/);
  assert.doesNotMatch(text, /"note":"<human-checked table\/figure meaning>"/);
  assert.doesNotMatch(text, /\bfind_figure\b/);
  assert.doesNotMatch(text, /\bget_figure_context\b/);
  assert.doesNotMatch(text, /\brender_figure\b/);
  assert.doesNotMatch(text, /\bocr_figure\b/);

  const rebuildIndex = text.indexOf("rebuild_figure_manifest");
  const searchIndex = text.indexOf("search_figures");
  const contextIndex = text.indexOf("get_figure_context_pack");
  assert.ok(rebuildIndex >= 0 && rebuildIndex < searchIndex && searchIndex < contextIndex);
});
