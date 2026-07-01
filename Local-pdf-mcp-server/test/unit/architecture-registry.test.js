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
  "render_pdf_page",
  "render_pdf_region",
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
  const figureImageTool = PUBLIC_TOOL_DEFINITIONS.find((tool) => tool.name === "get_figure_image");
  assert.deepEqual(figureImageTool.inputSchema.properties.transport.enum, ["metadata", "mcp_image", "image_url"]);
  const semanticTool = PUBLIC_TOOL_DEFINITIONS.find((tool) => tool.name === "analyze_figure_semantics");
  assert.match(semanticTool.description, /caption\/page-text\/OCR-derived semantic hints/);
  assert.match(semanticTool.description, /does not inspect image pixels/);
  assert.match(semanticTool.description, /visual-semantic truth/);
  assert.match(semanticTool.description, /NO_IMAGE_INPUT/);
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
  assert.match(text, /"include_layout_tables":true/);
  assert.match(text, /metadata-only|open\/attach canonical image|actual opened\/attached PNG image input/);
  assert.match(text, /Do not claim visual analysis|do not claim visual analysis/i);
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

  for (const expected of ["rebuild_figure_manifest", "search_figures", "get_figure_context_pack", "image_path", "get_figure_image", "image_path alone is only a locator", "metadata-only", "open/attach canonical image", "Do not claim visual analysis"]) {
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), expected);
  }
  for (const forbidden of ["render_pdf_page", "render_pdf_region", "render_figure_region", "render_figure_page", "render_figure", "ocr_figure"]) {
    assert.doesNotMatch(text, new RegExp(`\\b${forbidden}\\b`), forbidden);
  }
  if (/read_pdf_pages/.test(text)) assert.match(text, /supporting|cross-check|locator/i);
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
