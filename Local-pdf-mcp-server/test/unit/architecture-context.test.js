import assert from "node:assert/strict";
import test from "node:test";
import { createAppContext } from "../../src/core/app-context.js";
import { wireRuntimePorts } from "../../src/app/runtime-wiring.js";
import { createRuntimeConfig } from "../../src/core/runtime-config.js";
import { appendEvidenceContract, textResult } from "../../src/core/runtime-helpers.js";
import { chunkPageHierarchically, nearestSectionForPage, scoreRegisterOccurrence } from "../../src/services/indexing.js";
import { findNearestRegisterForChunk } from "../../src/services/search.js";
import { HIDDEN_COMPATIBILITY_TOOL_NAMES } from "../../src/mcp/tool-definitions.js";
import { createToolRegistry, validateToolRegistryContract } from "../../src/mcp/registry.js";

test("runtime config derives all writable paths from the supplied root", () => {
  const config = createRuntimeConfig({ rootDir: "C:/workspace/manual-server" });
  assert.match(config.paths.documentsDir, /manual-server[\\/]documents$/);
  assert.match(config.paths.driverProfileFragmentsDir, /driver_profiles[\\/]fragments$/);
});

test("nearest section lookup is logarithmic and preserves deepest same-page headings", () => {
  const values = Array.from({ length: 10_000 }, (_, index) => ({
    id: `s${index}`,
    title: `Section ${index}`,
    page: index + 1,
    level: 1,
    type: "section",
  }));
  values.splice(7_777, 0,
    { id: "same-page-shallow", title: "Shallow", page: 7_778, level: 2, type: "section" },
    { id: "same-page-deep", title: "Deep", page: 7_778, level: 4, type: "section" });
  let numericReads = 0;
  const sections = new Proxy(values, {
    get(target, property, receiver) {
      if (/^\d+$/.test(String(property))) numericReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = nearestSectionForPage({ sections }, 7_778);
  assert.equal(result.id, "same-page-deep");
  assert.equal(numericReads < 100, true, `expected logarithmic lookup, read ${numericReads} entries`);
});

test("register scoring caches normalized chunk context across symbols", () => {
  let textReads = 0;
  const chunk = {
    get text() {
      textReads += 1;
      return "Register CTRL Address: 0x10 Description CTRL CTRL STAT";
    },
    headings: ["Register Description"],
    registers: ["CTRL"],
    symbols: ["CTRL", "STAT"],
  };
  const first = scoreRegisterOccurrence("CTRL", chunk);
  const second = scoreRegisterOccurrence("STAT", chunk);
  assert.equal(first > second, true);
  assert.equal(textReads, 1);
});

test("bitfield register fallback uses prepared page and name indexes", () => {
  wireRuntimePorts(createAppContext({ rootDir: "C:/workspace/bitfield-index-test" }));
  const target = { name: "CTRL", displayName: "CTRL", aliases: [], pages: [77], chunks: [] };
  const values = Array.from({ length: 10_000 }, (_, index) => ({ name: `REG${index}`, pages: [index], aliases: [], chunks: [] }));
  values.push(target);
  let numericReads = 0;
  const registers = new Proxy(values, {
    get(array, property, receiver) {
      if (/^\d+$/.test(String(property))) numericReads += 1;
      return Reflect.get(array, property, receiver);
    },
  });
  const result = findNearestRegisterForChunk({
    registers,
    registersByPage: new Map([[77, [target]]]),
    registersByName: new Map([["CTRL", [target]]]),
  }, { id: "chunk-77", page: 77, registers: ["CTRL"] });
  assert.equal(result, target);
  assert.equal(numericReads, 0);
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

test("hidden compatibility names remain explicit and stable", () => {
  for (const name of [
    "mcp_server_ping",
    "pdf_index_status_lite",
    "index_status",
    "rebuild_artifact",
    "cancel_job",
    "cleanup_jobs",
    "job_status",
    "list_jobs",
    "start_index_pdf",
    "validate_index",
    "run_eval",
    "list_eval_cases",
    "analyze_figure_semantics",
    "search_figure_semantics",
    "rebuild_figure_semantics",
  ]) {
    assert.equal(HIDDEN_COMPATIBILITY_TOOL_NAMES.includes(name), true, name);
  }
});

test("structured registry rejects an invalid direct EvidenceBundle v2", async () => {
  const registry = createToolRegistry({
    definitions: [{ name: "evidence", description: "evidence", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    handlers: { evidence: async () => ({ content: [], structuredContent: { schemaVersion: 2 } }) },
    hiddenHandlers: {},
    expectedAdvertisedCount: 1,
  });
  await assert.rejects(registry.dispatchTool("evidence", {}), /Invalid EvidenceBundle v2 returned by evidence/);
});

test("hierarchical chunking preserves register and caution blocks before character splitting", () => {
  const chunks = chunkPageHierarchically([
    "4.1 Register Description",
    "DMA Control Register (DMAC_DCTRL)",
    "Access Size: 32 bits",
    "Address: +0300h",
    "",
    "Caution: Do not change reserved bits while transfer is active.",
    "",
    "1. Disable the channel.",
    "2. Clear the status flag.",
  ].join("\n"), 300, 30);
  assert.equal(chunks.some((chunk) => chunk.chunkTypeHint === "register" && /DMAC_DCTRL/.test(chunk.text)), true);
  assert.equal(chunks.some((chunk) => chunk.chunkTypeHint === "caution" && /reserved bits/.test(chunk.text)), true);
  assert.equal(chunks.some((chunk) => chunk.chunkTypeHint === "procedure" && /Disable the channel/.test(chunk.text)), true);
});
