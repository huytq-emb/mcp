import assert from "node:assert/strict";
import test from "node:test";
import { ensureSemanticManualReady, runSemanticRuntimeQuery } from "../../src/eval/semantic-integration.js";

test("semantic integration reports missing manuals and strict mode fails", async () => {
  const access = async () => { throw new Error("missing"); };
  const skipped = await ensureSemanticManualReady({ filename: "manual.pdf", manualPath: "missing", access, loadGraph: async () => {}, buildIndex: async () => {} });
  assert.deepEqual(skipped, { status: "skipped", reason: "manual unavailable", indexingDurationMs: 0 });
  await assert.rejects(() => ensureSemanticManualReady({ filename: "manual.pdf", manualPath: "missing", requireManuals: true, access, loadGraph: async () => {}, buildIndex: async () => {} }), /required manual unavailable/i);
});

test("semantic integration builds stale artifacts and measures indexing duration", async () => {
  let graphLoads = 0;
  let builds = 0;
  const times = [100, 137];
  const result = await ensureSemanticManualReady({
    filename: "manual.pdf",
    manualPath: "manual.pdf",
    access: async () => {},
    loadGraph: async () => { graphLoads += 1; if (graphLoads === 1) throw new Error("stale"); },
    buildIndex: async (filename, options) => { builds += 1; assert.equal(filename, "manual.pdf"); assert.equal(options.force, true); },
    now: () => times.shift(),
  });
  assert.deepEqual(result, { status: "ready", indexingDurationMs: 37, indexed: true });
  assert.equal(graphLoads, 2);
  assert.equal(builds, 1);
});

test("semantic integration uses the supplied strict manual validator before metadata access", async () => {
  let validations = 0;
  let legacyAccesses = 0;
  const result = await ensureSemanticManualReady({
    filename: "manual.pdf",
    manualPath: "manual.pdf",
    validateManual: async (filename) => { validations += 1; assert.equal(filename, "manual.pdf"); },
    access: async () => { legacyAccesses += 1; },
    loadGraph: async () => {},
    buildIndex: async () => {},
  });
  assert.equal(result.status, "ready");
  assert.equal(validations, 1);
  assert.equal(legacyAccesses, 0);
});

test("semantic integration executes the real query dependency and records latency and RSS", async () => {
  let received;
  const times = [10, 25];
  const rssValues = [100 * 1024 * 1024, 112 * 1024 * 1024];
  const result = await runSemanticRuntimeQuery({
    filename: "manual.pdf",
    queryCase: { query: "DCTRL offset", register: "DCTRL", topK: 12 },
    indexingDurationMs: 40,
    queryManual: async (args) => { received = args; return { facts: [], evidence: [{ id: "e1" }] }; },
    now: () => times.shift(),
    rss: () => rssValues.shift(),
  });
  assert.equal(received.query, "DCTRL offset");
  assert.equal(received.register, "DCTRL");
  assert.equal(received.topK, 12);
  assert.equal(result.latencyMs, 15);
  assert.equal(result.indexingDurationMs, 40);
  assert.equal(result.rssBeforeMb, 100);
  assert.equal(result.rssAfterMb, 112);
  assert.equal(result.peakRssMb, 112);
});

test("semantic integration reports a sampled in-query peak RSS", async () => {
  const values = [100, 150, 112].map((mb) => mb * 1024 * 1024);
  let sample;
  const result = await runSemanticRuntimeQuery({
    filename: "manual.pdf",
    queryCase: { query: "DCTRL" },
    rss: () => values.shift(),
    setIntervalFn: (callback) => { sample = callback; return "timer"; },
    clearIntervalFn: () => {},
    queryManual: async () => { sample(); return { facts: [], evidence: [] }; },
  });
  assert.equal(result.rssBeforeMb, 100);
  assert.equal(result.rssAfterMb, 112);
  assert.equal(result.peakRssMb, 150);
});

test("semantic integration exposes retrieval and negative-control failures", async () => {
  const failure = await runSemanticRuntimeQuery({ filename: "manual.pdf", queryCase: { query: "DCTRL" }, queryManual: async () => { throw new Error("retrieval failed"); } });
  assert.match(failure.runtimeError, /retrieval failed/);
  assert.deepEqual(failure.bundle, { facts: [], evidence: [] });
  const negative = await runSemanticRuntimeQuery({ filename: "manual.pdf", queryCase: { query: "missing", expectation: "negative" }, queryManual: async () => ({ facts: [], evidence: [{ id: "unexpected" }] }) });
  assert.equal(negative.runtimeError, undefined);
  const falseFact = await runSemanticRuntimeQuery({ filename: "manual.pdf", queryCase: { query: "missing", expectation: "negative" }, queryManual: async () => ({ facts: [{ id: "false" }], evidence: [] }) });
  assert.match(falseFact.runtimeError, /negative query returned meaningful evidence/);
});
