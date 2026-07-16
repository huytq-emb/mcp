import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { evaluateCoverageExpectation } from "./semantic.js";

export async function ensureSemanticManualReady({
  filename,
  manualPath,
  requireManuals = false,
  loadGraph,
  buildIndex,
  onIndexing = () => {},
  validateManual,
  access = fs.access,
  now = () => performance.now(),
} = {}) {
  try {
    if (validateManual) await validateManual(filename);
    else await access(manualPath);
  } catch {
    if (requireManuals) throw new Error(`Required manual unavailable: ${filename}`);
    return { status: "skipped", reason: "manual unavailable", indexingDurationMs: 0 };
  }

  try {
    await loadGraph(filename);
    return { status: "ready", indexingDurationMs: 0, indexed: false };
  } catch {
    const started = now();
    onIndexing();
    await buildIndex(filename, { force: true });
    const indexingDurationMs = Math.max(0, Math.round(now() - started));
    await loadGraph(filename);
    return { status: "ready", indexingDurationMs, indexed: true };
  }
}

export async function runSemanticRuntimeQuery({
  filename,
  queryCase,
  indexingDurationMs = 0,
  queryManual,
  now = () => performance.now(),
  rss = () => process.memoryUsage().rss,
  sampleIntervalMs = 25,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const rssBefore = rss();
  let peakRss = rssBefore;
  const sample = () => { peakRss = Math.max(peakRss, rss()); };
  const timer = setIntervalFn(sample, Math.max(10, Number(sampleIntervalMs) || 25));
  const started = now();
  try {
    const bundle = await queryManual({
      filename,
      query: queryCase.query,
      register: queryCase.register || "",
      includeOcr: Boolean(queryCase.includeOcr),
      topK: Math.max(10, Number(queryCase.topK || 10)),
    });
    const rssAfter = rss();
    clearIntervalFn(timer);
    const expectation = typeof queryCase.expectation === "string" ? { type: queryCase.expectation } : queryCase.expectation;
    const negative = expectation?.type === "negative" ? evaluateCoverageExpectation(queryCase, { bundle }) : null;
    const negativeFailure = negative && !negative.passed ? "negative query returned meaningful evidence" : "";
    return {
      bundle,
      latencyMs: Math.max(0, Math.round(now() - started)),
      indexingDurationMs,
      rssBeforeMb: Math.round(rssBefore / (1024 * 1024)),
      rssAfterMb: Math.round(rssAfter / (1024 * 1024)),
      peakRssMb: Math.round(Math.max(peakRss, rssAfter) / (1024 * 1024)),
      ...(negativeFailure ? { runtimeError: negativeFailure } : {}),
    };
  } catch (error) {
    const rssAfter = rss();
    clearIntervalFn(timer);
    return {
      bundle: { facts: [], evidence: [] },
      latencyMs: Math.max(0, Math.round(now() - started)),
      indexingDurationMs,
      rssBeforeMb: Math.round(rssBefore / (1024 * 1024)),
      rssAfterMb: Math.round(rssAfter / (1024 * 1024)),
      peakRssMb: Math.round(Math.max(peakRss, rssAfter) / (1024 * 1024)),
      runtimeError: error instanceof Error ? error.message : String(error),
    };
  }
}
