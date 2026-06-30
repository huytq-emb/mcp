import assert from "node:assert/strict";
import test from "node:test";
import { createAppContext } from "../../src/core/app-context.js";
import { createRuntimeConfig } from "../../src/core/runtime-config.js";
import { appendEvidenceContract, textResult } from "../../src/core/runtime-helpers.js";
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

test("runtime config accepts MCP root environment aliases with clear precedence", () => {
  const envOnly = createRuntimeConfig({ env: { PDF_MANUAL_MCP_ROOT: "C:/workspace/pdf-root" } });
  assert.match(envOnly.rootDir, /pdf-root$/);
  assert.match(envOnly.paths.indexDir, /pdf-root[\\/]indexes$/);

  const preferredEnv = createRuntimeConfig({
    env: {
      PDF_MANUAL_MCP_ROOT: "C:/workspace/pdf-root",
      RENESAS_MCP_ROOT: "C:/workspace/renesas-root",
    },
  });
  assert.match(preferredEnv.rootDir, /renesas-root$/);

  const optionRoot = createRuntimeConfig({
    rootDir: "C:/workspace/option-root",
    env: {
      PDF_MANUAL_MCP_ROOT: "C:/workspace/pdf-root",
      RENESAS_MCP_ROOT: "C:/workspace/renesas-root",
    },
  });
  assert.match(optionRoot.rootDir, /option-root$/);
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

test("structured registry validates advertised tool arguments before handlers run", async () => {
  let calls = 0;
  const registry = createToolRegistry({
    definitions: [{
      name: "visible",
      description: "visible tool",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
          top_k: { type: "number" },
        },
        required: ["filename"],
        additionalProperties: false,
      },
    }],
    handlers: {
      visible: async (args) => {
        calls += 1;
        return `ok:${args.filename}`;
      },
    },
    hiddenHandlers: { hidden: async (args) => `hidden:${args.extra}` },
    expectedAdvertisedCount: 1,
  });

  assert.equal(await registry.dispatchTool("visible", { filename: "manual.pdf", top_k: 2 }), "ok:manual.pdf");
  await assert.rejects(registry.dispatchTool("visible", { top_k: 2 }), /Invalid arguments for visible: \/filename/);
  await assert.rejects(registry.dispatchTool("visible", { filename: "manual.pdf", top_k: "2" }), /Invalid arguments for visible: \/top_k/);
  await assert.rejects(registry.dispatchTool("visible", { filename: "manual.pdf", extra: true }), /Invalid arguments for visible: \/extra/);
  assert.equal(calls, 1);
  assert.equal(await registry.dispatchTool("hidden", { extra: "allowed" }), "hidden:allowed");
});

test("structured registry validates hidden tool arguments when schema is known", async () => {
  let hiddenCalls = 0;
  const registry = createToolRegistry({
    definitions: [{ name: "visible", description: "visible", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    handlers: { visible: async () => "visible" },
    hiddenDefinitions: [{
      name: "hidden",
      description: "hidden compatibility tool",
      inputSchema: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"], additionalProperties: false },
    }],
    hiddenHandlers: { hidden: async (args) => { hiddenCalls += 1; return `hidden:${args.filename}`; } },
    expectedAdvertisedCount: 1,
  });
  assert.equal(await registry.dispatchTool("hidden", { filename: "manual.pdf" }), "hidden:manual.pdf");
  await assert.rejects(registry.dispatchTool("hidden", { extra: true }), /Invalid arguments for hidden: \/filename/);
  assert.equal(hiddenCalls, 1);
});

test("textResult exposes evidence contracts as structured content before truncation", () => {
  const contract = {
    schemaVersion: 1,
    serverVersion: "unit",
    tool: "unit_tool",
    filename: "manual.pdf",
    sourceFingerprint: "unit",
    input: { query: "unit" },
    evidence: [],
    inferences: [],
    needsVerification: [],
    warnings: [],
    recommendedNextTools: [],
    rule: "unit",
  };
  const result = textResult(appendEvidenceContract("x".repeat(35000), contract));
  assert.match(result.content[0].text, /Output truncated/);
  assert.deepEqual(result.structuredContent.evidenceContract, contract);
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
