import fs from "node:fs/promises";
import path from "node:path";
import { createAppContext } from "../src/core/app-context.js";
import { wireRuntimePorts } from "../src/app/runtime-wiring.js";
import { compareSemanticRegression, evaluateCoverageQueries, evaluateSemanticGoldenDataset } from "../src/eval/semantic.js";
import { ensureSemanticManualReady, runSemanticRuntimeQuery } from "../src/eval/semantic-integration.js";
import { buildPdfIndex } from "../src/services/indexing.js";
import { loadEvidenceGraph } from "../src/services/evidence-graph.js";
import { queryManualEvidenceBundle } from "../src/workflows/evidence-orchestrator.js";
import { coverageQueriesFor } from "../eval/semantic/coverage-queries.js";

const root = process.cwd();
const semanticDir = path.join(root, "eval", "semantic");
const requireManuals = process.argv.includes("--require-manuals");
const writeReport = process.argv.includes("--write");
const datasets = (await fs.readdir(semanticDir))
  .filter((name) => name.endsWith(".json") && name !== "baseline.json")
  .sort()
  .map(async (name) => JSON.parse(await fs.readFile(path.join(semanticDir, name), "utf-8")));
const baseline = JSON.parse(await fs.readFile(path.join(semanticDir, "baseline.json"), "utf-8"));
const resolvedDatasets = await Promise.all(datasets);
const context = createAppContext();
wireRuntimePorts(context);
const reports = [];

for (const dataset of resolvedDatasets) {
  const filename = dataset.manual?.filename || "";
  const manualPath = path.join(root, "documents", filename);
  let lastIndexPhase = "";
  let readiness;
  try {
    readiness = await ensureSemanticManualReady({
      filename,
      manualPath,
      requireManuals,
      loadGraph: loadEvidenceGraph,
      buildIndex: (name, options) => buildPdfIndex(name, {
        ...options,
        onProgress: (progress) => {
          if (progress?.phase && progress.phase !== lastIndexPhase) {
            lastIndexPhase = progress.phase;
            console.log(`INDEXING: ${dataset.id}: ${progress.phase}`);
          }
        },
      }),
      onIndexing: () => console.log(`INDEXING: ${dataset.id}: evidence graph unavailable or stale; rebuilding core artifacts`),
    });
  } catch (error) {
    console.error(`FAIL ${dataset.id}: ${error instanceof Error ? error.message : String(error)}`);
    reports.push({ dataset: dataset.id, subsystem: dataset.subsystem, status: "fail", reason: error instanceof Error ? error.message : String(error) });
    continue;
  }
  if (readiness.status === "skipped") {
    const report = { dataset: dataset.id, subsystem: dataset.subsystem, status: "skipped", reason: "manual unavailable" };
    reports.push(report);
    console.log(`SKIPPED: ${dataset.id}: manual unavailable (${filename})`);
    continue;
  }
  const indexingDurationMs = readiness.indexingDurationMs;

  const coverageQueries = dataset.coverageQueries || coverageQueriesFor(dataset.subsystem);
  if (!Array.isArray(coverageQueries) || coverageQueries.length < 20) {
    throw new Error(`${dataset.id} must define at least 20 realistic coverageQueries for integration evaluation.`);
  }
  const caseResults = {};
  for (const testCase of dataset.cases || []) {
    caseResults[testCase.id] = await runSemanticRuntimeQuery({ filename, queryCase: testCase, indexingDurationMs, queryManual: queryManualEvidenceBundle });
  }
  const coverageResults = [];
  for (const queryCase of coverageQueries) coverageResults.push(await runSemanticRuntimeQuery({ filename, queryCase, indexingDurationMs, queryManual: queryManualEvidenceBundle }));
  const report = evaluateSemanticGoldenDataset(dataset, caseResults);
  const coverageCorrectness = evaluateCoverageQueries(coverageQueries, coverageResults);
  const runtimeErrors = [
    ...Object.entries(caseResults).filter(([, result]) => result.runtimeError).map(([id, result]) => `${id}: ${result.runtimeError}`),
    ...coverageResults.map((result, index) => [coverageQueries[index], result]).filter(([, result]) => result.runtimeError).map(([queryCase, result]) => `coverage ${queryCase.id || queryCase.query}: ${result.runtimeError}`),
  ];
  const regression = compareSemanticRegression(report.metrics, baseline[dataset.id] || {}, dataset.regressionTolerances || {});
  reports.push({ dataset: dataset.id, subsystem: dataset.subsystem, status: report.health === "ok" && regression.ok && !runtimeErrors.length && coverageCorrectness.correctnessRate === 1 ? "ok" : "fail", report, regression, runtimeErrors, coverageCorrectness, runtimePerformance: { queryCount: coverageResults.length, p95LatencyMs: coverageResults.sort((left, right) => left.latencyMs - right.latencyMs)[Math.max(0, Math.ceil(coverageResults.length * 0.95) - 1)]?.latencyMs || 0, peakRssMb: Math.max(0, ...coverageResults.map((result) => result.peakRssMb || 0)) } });
}

if (writeReport) {
  await fs.writeFile(path.join(root, "indexes", "semantic-integration-report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}\n`, "utf-8");
}

let failed = false;
for (const item of reports) {
  if (item.status === "skipped") {
    if (requireManuals) { console.error(`FAIL ${item.dataset}: manual unavailable in --require-manuals mode`); failed = true; }
    continue;
  }
  if (!item.report) { console.error(`FAIL ${item.dataset}: ${item.reason || "integration setup failed"}`); failed = true; continue; }
  console.log(`${item.status.toUpperCase()}: ${item.dataset}; golden Recall@5=${item.report.metrics.recallAt5}; golden MRR=${item.report.metrics.meanReciprocalRank}; coverage correctness=${item.coverageCorrectness.correctnessRate} (${item.coverageCorrectness.correctnessQueryCount} semantic, ${item.coverageCorrectness.runtimeOnlyQueryCount} runtime-only); runtime p95=${item.runtimePerformance.p95LatencyMs}ms`);
  for (const failure of [...item.report.failures, ...item.regression.failures, ...item.runtimeErrors, ...item.coverageCorrectness.failures.map((id) => `coverage ${id}: expectation not satisfied`)]) { console.error(`FAIL ${item.dataset}: ${failure}`); failed = true; }
  if (item.status !== "ok") failed = true;
}
if (failed) process.exit(1);
