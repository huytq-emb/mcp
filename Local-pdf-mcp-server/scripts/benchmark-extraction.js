import { performance } from "node:perf_hooks";
import fs from "node:fs";
import { extractPdfPages, getPdfPageCount, loadPdfDocument } from "../src/services/pdf.js";
import { extractTablesFromPagesNode } from "../src/domains/manual-intelligence.js";
import { runPythonWorker, getHybridRuntimeStatus } from "../src/services/python-worker.js";
import { DOCUMENTS_DIR, INDEX_DIR } from "../src/core/runtime-constants.js";
import { safePdfPath } from "../src/core/runtime-helpers.js";
import { createRuntimePortRegistry, activateRuntimePortRegistry, bindRuntimePorts } from "../src/core/runtime-ports.js";

const runtimePorts = createRuntimePortRegistry();
activateRuntimePortRegistry(runtimePorts);
bindRuntimePorts({ getPdfPageCount, loadPdfDocument }, runtimePorts);

const filenameArg = process.argv.find((value) => value.startsWith("--filename="));
const pagesArg = process.argv.find((value) => value.startsWith("--pages="));
const filename = filenameArg?.split("=").slice(1).join("=") || "r01uh1069ej0115-rzg3e.pdf";
const pageLimit = Math.max(10, Math.min(1000, Number(pagesArg?.split("=")[1] || 200)));
const tableStart = 843;
const tableEnd = 850;
if (!fs.existsSync(safePdfPath(filename))) throw new Error(`PDF not found: ${filename}`);
const health = await getHybridRuntimeStatus({ force: true });
if (!health.pythonReady) {
  console.log("Hybrid benchmark: SKIP (Python worker unavailable)");
  console.log(JSON.stringify(health, null, 2));
  process.exit(0);
}

const nodeStart = performance.now();
const nodeResult = await extractPdfPages(filename, { startPage: 1, endPage: pageLimit });
const nodeTables = await extractTablesFromPagesNode(filename, { startPage: tableStart, endPage: tableEnd, preferArtifact: false, minColumns: 2 });
const nodeMs = performance.now() - nodeStart;
const nodePeakRssBytes = process.memoryUsage().rss;
const pythonStart = performance.now();
const pythonResult = await runPythonWorker({
  operation: "pages.extract", allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
  inputs: { filename, pdfPath: safePdfPath(filename) }, outputs: {}, options: { startPage: 1, endPage: pageLimit },
});
const pythonTables = await runPythonWorker({
  operation: "tables.extract", allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
  inputs: { filename, pdfPath: safePdfPath(filename) }, outputs: {}, options: { candidatePages: Array.from({ length: tableEnd - tableStart + 1 }, (_, index) => tableStart + index) },
});
const pythonMs = performance.now() - pythonStart;
const report = {
  schemaVersion: 1, filename, pages: nodeResult.pages.length,
  tableCandidatePages: tableEnd - tableStart + 1,
  node: { elapsedMs: Math.round(nodeMs), pagesPerSecond: Math.round(nodeResult.pages.length / (nodeMs / 1000) * 100) / 100, tableCount: nodeTables.tables.length, peakRssBytes: nodePeakRssBytes },
  python: { elapsedMs: Math.round(pythonMs), pagesPerSecond: Math.round((pythonResult.result?.pages?.length || 0) / (pythonMs / 1000) * 100) / 100, candidatePagesPerSecond: Math.round((tableEnd - tableStart + 1) / ((pythonTables.durationMs || 1) / 1000) * 100) / 100, tableCount: pythonTables.result?.tables?.length || 0, peakRssBytes: Math.max(Number(pythonResult.metrics?.peakRssBytes || 0), Number(pythonTables.metrics?.peakRssBytes || 0)), outputSizeBytes: Buffer.byteLength(JSON.stringify(pythonResult.result || {})) + Buffer.byteLength(JSON.stringify(pythonTables.result || {})) },
  speedup: Math.round((nodeMs / pythonMs) * 100) / 100,
  target: 2,
  pass: nodeMs / pythonMs >= 2,
};
console.log("Hybrid extraction benchmark");
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--strict") && !report.pass) process.exit(1);
