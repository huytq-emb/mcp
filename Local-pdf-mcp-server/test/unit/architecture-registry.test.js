import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { PUBLIC_TOOL_DEFINITIONS, PUBLIC_TOOL_NAMES } from "../../src/mcp/tool-definitions.js";
import { HIDDEN_COMPATIBILITY_TOOL_NAMES } from "../../src/mcp/registry.js";
import { createRuntimeToolRegistry } from "../../src/mcp/runtime-registry.js";

const execFileAsync = promisify(execFile);
const TOOL_CATALOG_SHA256 = "ec3a6ba8fba9d8552d836fe3da74496101fe5ecfdbf78fea80e6f22a14dc21ec";

test("public MCP catalog preserves all 63 names and schemas", () => {
  assert.equal(PUBLIC_TOOL_DEFINITIONS.length, 63);
  assert.equal(new Set(PUBLIC_TOOL_NAMES).size, 63);
  const digest = createHash("sha256").update(JSON.stringify(PUBLIC_TOOL_DEFINITIONS)).digest("hex");
  assert.equal(digest, TOOL_CATALOG_SHA256);
  const healthTool = PUBLIC_TOOL_DEFINITIONS.find((tool) => tool.name === "eval_health_check");
  assert.equal(healthTool.inputSchema.properties.cascade_dependents.type, "boolean");
  assert.equal(healthTool.inputSchema.properties.kind.type, "string");
  assert.equal(healthTool.inputSchema.properties.stale_by_source.type, "boolean");
  for (const name of ["render_figure", "ocr_figure", "inspect_figure"]) assert.equal(PUBLIC_TOOL_NAMES.includes(name), true, name);
});

test("runtime registry covers advertised and hidden compatibility handlers", async () => {
  const registry = createRuntimeToolRegistry();
  assert.equal(registry.advertisedCount, 63);
  assert.equal(registry.handlerCount, 69);
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
