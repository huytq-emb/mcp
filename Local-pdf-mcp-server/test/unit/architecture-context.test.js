import assert from "node:assert/strict";
import test from "node:test";
import { createAppContext } from "../../src/core/app-context.js";
import { createRuntimeConfig } from "../../src/core/runtime-config.js";
import {
  HIDDEN_COMPATIBILITY_TOOL_NAMES,
  createToolRegistry,
  validateToolRegistryContract,
} from "../../src/mcp/registry.js";

test("runtime config derives all writable paths from the supplied root", () => {
  const config = createRuntimeConfig({ rootDir: "C:/workspace/manual-server" });
  assert.match(config.paths.documentsDir, /manual-server[\\/]documents$/);
  assert.match(config.paths.driverProfileFragmentsDir, /driver_profiles[\\/]fragments$/);
});

test("app context supports dependency injection without startup side effects", () => {
  const fakeFs = {};
  const fakePdf = {};
  const context = createAppContext({ rootDir: "C:/workspace/manual-server", fs: fakeFs, pdfEngine: fakePdf });
  assert.equal(context.fs, fakeFs);
  assert.equal(context.pdfEngine, fakePdf);
  assert.ok(context.caches.json instanceof Map);
});

test("structured registry separates advertised and compatibility handlers", async () => {
  const definitions = [{
    name: "visible",
    description: "visible tool",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }];
  const registry = createToolRegistry({
    definitions,
    handlers: { visible: async () => "visible-result" },
    hiddenHandlers: { hidden: async () => "hidden-result" },
    expectedAdvertisedCount: 1,
  });
  assert.deepEqual(registry.advertisedNames, ["visible"]);
  assert.deepEqual(registry.hiddenNames, ["hidden"]);
  assert.equal(await registry.dispatchTool("hidden"), "hidden-result");
  assert.equal(validateToolRegistryContract(registry, { expectedAdvertisedCount: 1 }).ok, true);
});

test("Step 40 compatibility names remain explicit and stable", () => {
  assert.deepEqual(HIDDEN_COMPATIBILITY_TOOL_NAMES, [
    "mcp_server_ping",
    "pdf_index_status_lite",
    "index_status",
    "rebuild_artifact",
    "cancel_job",
    "cleanup_jobs",
  ]);
});
