import fs from "node:fs/promises";
import path from "node:path";
import { compareSemanticRegression, evaluateSemanticGoldenDataset } from "../src/eval/semantic.js";

const root = process.cwd();
const semanticDir = path.join(root, "eval", "semantic");
const fixturePath = path.join(semanticDir, "expected-results.json");
const files = (await fs.readdir(semanticDir)).filter((name) => name.endsWith(".json") && name !== "expected-results.json" && name !== "baseline.json").sort();
const fixtures = JSON.parse(await fs.readFile(fixturePath, "utf-8"));
const baseline = JSON.parse(await fs.readFile(path.join(semanticDir, "baseline.json"), "utf-8"));
const reports = [];
for (const file of files) {
  const dataset = JSON.parse(await fs.readFile(path.join(semanticDir, file), "utf-8"));
  const report = evaluateSemanticGoldenDataset(dataset, fixtures[dataset.id] || {});
  const regression = compareSemanticRegression(report.metrics, baseline[dataset.id] || {}, dataset.regressionTolerances || {});
  reports.push({ dataset: dataset.id, subsystem: dataset.subsystem, ...report, regression });
}
for (const report of reports) {
  console.log(`${report.dataset}: ${report.health}; Recall@5=${report.metrics.recallAt5}; MRR=${report.metrics.meanReciprocalRank}; p95=${report.metrics.p95LatencyMs}ms`);
  for (const failure of [...report.failures, ...report.regression.failures]) console.error(`FAIL ${report.dataset}: ${failure}`);
}
if (process.argv.includes("--write")) {
  await fs.writeFile(path.join(root, "indexes", "semantic-eval-report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2)}\n`, "utf-8");
}
if (reports.some((report) => report.health !== "ok" || !report.regression.ok)) process.exit(1);
