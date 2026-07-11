import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";

export async function ensureSemanticManualReady({
  filename,
  manualPath,
  requireManuals = false,
  loadGraph,
  buildIndex,
  onIndexing = () => {},
  access = fs.access,
  now = () => performance.now(),
} = {}) {
  try {
    await access(manualPath);
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
} = {}) {
  const rssBefore = rss();
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
    const negativeFailure = queryCase.expectation === "negative" && (bundle.facts || []).length
      ? "negative query returned a supported fact"
      : "";
    return {
      bundle,
      latencyMs: Math.max(0, Math.round(now() - started)),
      indexingDurationMs,
      rssBeforeMb: Math.round(rssBefore / (1024 * 1024)),
      rssAfterMb: Math.round(rssAfter / (1024 * 1024)),
      peakRssMb: Math.round(Math.max(rssBefore, rssAfter) / (1024 * 1024)),
      ...(negativeFailure ? { runtimeError: negativeFailure } : {}),
    };
  } catch (error) {
    const rssAfter = rss();
    return {
      bundle: { facts: [], evidence: [] },
      latencyMs: Math.max(0, Math.round(now() - started)),
      indexingDurationMs,
      rssBeforeMb: Math.round(rssBefore / (1024 * 1024)),
      rssAfterMb: Math.round(rssAfter / (1024 * 1024)),
      peakRssMb: Math.round(Math.max(rssBefore, rssAfter) / (1024 * 1024)),
      runtimeError: error instanceof Error ? error.message : String(error),
    };
  }
}
