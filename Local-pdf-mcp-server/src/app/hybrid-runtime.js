import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  DOCUMENTS_DIR,
  INDEX_DIR,
  PYTHON_WORKER_DEFAULT_TIMEOUT_MS,
} from "../core/runtime-constants.js";
import {
  getPdfSourceInfo,
  safeBitfieldsIndexPath,
  safeCautionsIndexPath,
  safePagesCachePath,
  safePagesPartialCachePath,
  safePdfPath,
  safeRegistersIndexPath,
  safeTablesIndexPath,
  safeTablesPartialIndexPath,
  pathExists,
} from "../core/runtime-helpers.js";
import * as nodePdf from "../services/pdf.js";
import * as nodeTables from "../domains/tables.js";
import * as nodeManual from "../domains/manual-intelligence.js";
import {
  PythonWorkerError,
  atomicPromoteWorkerArtifact,
  isRetryablePythonFailure,
  normalizeExtractionMode,
  pythonOperationEnabled,
  probePythonWorker,
  recordExtractionEngineEvent,
  runPythonWorker,
  validateWorkerArtifact,
} from "../services/python-worker.js";
import { validateHybridStructuredQuality } from "./hybrid-quality.js";

function createRequestId(operation) {
  return `${operation.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function prepareWorkerPaths(requestId) {
  const workerRoot = path.join(INDEX_DIR, ".workers", requestId);
  await fs.mkdir(workerRoot, { recursive: true });
  return { workerRoot, cancelPath: path.join(workerRoot, "cancel.requested") };
}

function engineMode(options = {}) {
  return normalizeExtractionMode(options.engine || options.extractionEngine || process.env.RENESAS_MCP_EXTRACTION_ENGINE);
}

async function runWithNodeFallback(operation, options, pythonRun, nodeRun) {
  const mode = engineMode(options);
  if (!pythonOperationEnabled(operation, { mode })) {
    recordExtractionEngineEvent({ operation, engine: "node", reason: mode === "node" ? "Node engine forced" : "operation awaiting Python parity" });
    const value = await nodeRun();
    if (value && typeof value === "object" && !value.producer) value.producer = { engine: "node", operation, reason: mode === "node" ? "Node engine forced" : "operation awaiting Python parity" };
    return value;
  }
  if (mode === "auto") {
    const probe = await probePythonWorker();
    if (!probe.ready) {
      recordExtractionEngineEvent({ operation, engine: "node", fallbackReason: probe.reason || "Python worker unavailable", code: probe.code || "PYTHON_UNAVAILABLE" });
      const value = await nodeRun();
      if (value && typeof value === "object") value.producer = { engine: "node", operation, fallbackReason: probe.reason || "Python worker unavailable", fallbackCode: probe.code || "PYTHON_UNAVAILABLE" };
      return value;
    }
  }
  try {
    const result = await pythonRun();
    recordExtractionEngineEvent({ operation, engine: "python", durationMs: result?.worker?.durationMs || null });
    if (result.value && typeof result.value === "object") result.value.producer = { engine: "python", operation, durationMs: result.worker?.durationMs || null, workerVersion: result.worker?.events?.find?.((event) => event.workerVersion)?.workerVersion || "1.0.0" };
    return result.value;
  } catch (error) {
    if (mode !== "auto" || !isRetryablePythonFailure(error)) throw error;
    recordExtractionEngineEvent({ operation, engine: "node", fallbackReason: error.message, code: error.code });
    options.onProgress?.({ phase: "python-fallback-node", current: 0, total: 0, unit: "", warning: error.message });
    const value = await nodeRun();
    if (value && typeof value === "object") value.producer = { engine: "node", operation, fallbackReason: error.message, fallbackCode: error.code };
    return value;
  }
}

async function runArtifactBuild({ filename, operation, kind, targetPath, options = {}, requestOptions = {} }) {
  const requestId = createRequestId(operation);
  const { workerRoot, cancelPath } = await prepareWorkerPaths(requestId);
  options.onWorkerContext?.({ requestId, workerRoot, cancelPath, operation });
  const tempPath = path.join(workerRoot, `${kind}.json`);
  const source = await getPdfSourceInfo(filename);
  try {
    const worker = await runPythonWorker({
      requestId,
      operation,
      allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
      inputs: { filename, pdfPath: safePdfPath(filename), ...(requestOptions.inputs || {}) },
      outputs: { artifactPath: tempPath, [`${kind}Path`]: tempPath, cancelPath, ...(requestOptions.outputs || {}) },
      options: requestOptions.options || {},
    }, {
      timeoutMs: options.timeoutMs || PYTHON_WORKER_DEFAULT_TIMEOUT_MS,
      onProgress: options.onProgress,
      onSpawn: options.onWorkerSpawn,
      onStderr: options.onWorkerStderr,
    });
    const descriptor = worker.artifacts.find((entry) => entry.kind === kind) || worker.result?.artifact;
    if (!descriptor) throw new PythonWorkerError("PROTOCOL_ERROR", `Python worker did not return ${kind} artifact metadata`);
    const validated = await validateWorkerArtifact(descriptor, { workerRoot, filename, source });
    await atomicPromoteWorkerArtifact(validated.tempPath, targetPath);
    const value = JSON.parse(await fs.readFile(targetPath, "utf8"));
    return { value, worker: { requestId, durationMs: worker.durationMs, interpreter: worker.interpreter, descriptor: validated, events: worker.events } };
  } finally {
    await fs.rm(workerRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function getPdfPageCountHybrid(filename, options = {}) {
  return runWithNodeFallback("pdf.inspect", options, async () => {
    const worker = await runPythonWorker({
      operation: "pdf.inspect", allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
      inputs: { filename, pdfPath: safePdfPath(filename) }, outputs: {}, options: {},
    }, { timeoutMs: 30_000 });
    return { value: Number(worker.result?.pageCount || 0), worker };
  }, () => nodePdf.getPdfPageCount(filename));
}

export async function extractPdfPagesHybrid(filename, options = {}) {
  return runWithNodeFallback("pages.extract", options, async () => {
    const worker = await runPythonWorker({
      operation: "pages.extract", allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
      inputs: { filename, pdfPath: safePdfPath(filename) }, outputs: {},
      options: { startPage: options.startPage, endPage: options.endPage },
    }, { timeoutMs: options.timeoutMs || 120_000, onProgress: options.onProgress });
    return { value: { filename, ...worker.result }, worker };
  }, () => nodePdf.extractPdfPages(filename, options));
}

export async function buildPagesCacheHybrid(filename, options = {}) {
  return runWithNodeFallback("pages.build", options, () => runArtifactBuild({
    filename, operation: "pages.build", kind: "pages", targetPath: safePagesCachePath(filename), options,
    requestOptions: { outputs: { checkpointPath: safePagesPartialCachePath(filename) }, options: { checkpointEvery: 50 } },
  }), () => nodePdf.buildPagesCache(filename, options));
}

export async function buildTablesIndexHybrid(filename, indexData, pageCache, sectionsIndex = null, options = {}) {
  return runWithNodeFallback("tables.build", options, () => runArtifactBuild({
    filename,
    operation: "tables.build",
    kind: "tables",
    targetPath: safeTablesIndexPath(filename),
    options,
    requestOptions: {
      inputs: { pagesPath: safePagesCachePath(filename) },
      outputs: { tablesCheckpointPath: safeTablesPartialIndexPath(filename) },
      options: { candidatePages: nodeTables.selectTableCandidatePages(pageCache, indexData, options) },
    },
  }), () => nodeTables.buildTablesIndex(filename, indexData, pageCache, sectionsIndex, options));
}

export async function extractTablesFromPagesHybrid(filename, options = {}) {
  if (options.preferArtifact !== false && await pathExists(safeTablesIndexPath(filename))) {
    return nodeManual.extractTablesFromPagesNode(filename, options);
  }
  return runWithNodeFallback("tables.extract", options, async () => {
    const startPage = Number(options.startPage || 1);
    const endPage = Number(options.endPage || startPage);
    const candidatePages = Array.from({ length: Math.max(0, endPage - startPage + 1) }, (_, index) => startPage + index);
    const worker = await runPythonWorker({
      operation: "tables.extract", allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
      inputs: { filename, pdfPath: safePdfPath(filename) }, outputs: {}, options: { candidatePages },
    }, { timeoutMs: options.timeoutMs || 120_000, onProgress: options.onProgress });
    return { value: { filename, pageCount: worker.result.pageCount, startPage, endPage, tables: worker.result.tables || [], source: "python-pymupdf-coordinate" }, worker };
  }, () => nodeManual.extractTablesFromPagesNode(filename, options));
}

export async function runStructuredBuildHybrid(filename, options = {}) {
  const requestId = createRequestId("structured.build");
  const { workerRoot, cancelPath } = await prepareWorkerPaths(requestId);
  options.onWorkerContext?.({ requestId, workerRoot, cancelPath, operation: "structured.build" });
  const targetPaths = {
    tables: safeTablesIndexPath(filename), registers: safeRegistersIndexPath(filename),
    bitfields: safeBitfieldsIndexPath(filename), cautions: safeCautionsIndexPath(filename),
  };
  const outputs = Object.fromEntries(Object.keys(targetPaths).map((kind) => [`${kind}Path`, path.join(workerRoot, `${kind}.json`)]));
  try {
    const worker = await runPythonWorker({
      requestId, operation: "structured.build", allowedRoots: [DOCUMENTS_DIR, INDEX_DIR],
      inputs: { filename, pdfPath: safePdfPath(filename), pagesPath: safePagesCachePath(filename) },
      outputs: { ...outputs, tablesCheckpointPath: safeTablesPartialIndexPath(filename), cancelPath }, options: { candidatePages: options.candidatePages || [] },
    }, { timeoutMs: options.timeoutMs || PYTHON_WORKER_DEFAULT_TIMEOUT_MS, onProgress: options.onProgress, onSpawn: options.onWorkerSpawn, onStderr: options.onWorkerStderr });
    const source = await getPdfSourceInfo(filename);
    const validated = [];
    for (const descriptor of worker.artifacts) validated.push(await validateWorkerArtifact(descriptor, { workerRoot, filename, source }));
    if (validated.length !== 4) throw new PythonWorkerError("ARTIFACT_VALIDATION_FAILED", "structured.build must return four validated artifacts");
    const values = {};
    for (const descriptor of validated) values[descriptor.kind] = JSON.parse(await fs.readFile(descriptor.tempPath, "utf8"));
    const quality = await validateHybridStructuredQuality({
      filename,
      values,
      descriptors: validated,
      worker,
      operation: "structured.build",
      requestId,
    });
    if (quality.report.health === "fail") {
      throw new PythonWorkerError("PYTHON_QUALITY_GATE_FAILED", "Python structured artifacts failed shadow quality gate", {
        reportPath: quality.paths.jsonPath,
        markdownPath: quality.paths.markdownPath,
        summary: quality.report.summary,
      });
    }
    for (const descriptor of validated) await atomicPromoteWorkerArtifact(descriptor.tempPath, targetPaths[descriptor.kind]);
    const producer = { engine: "python", operation: "structured.build", requestId, durationMs: worker.durationMs, workerVersion: worker.events.find((event) => event.workerVersion)?.workerVersion || "1.0.0" };
    for (const value of Object.values(values)) value.producer = producer;
    return { engine: "python", requestId, durationMs: worker.durationMs, artifacts: validated, ...values, producer };
  } finally {
    await fs.rm(workerRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function tryBuildStructuredArtifactsHybrid(filename, indexData, pageCache, sectionsIndex, options = {}) {
  const mode = engineMode(options);
  if (!pythonOperationEnabled("structured.build", { mode })) return null;
  try {
    const candidatePages = nodeTables.selectTableCandidatePages(pageCache, indexData, options);
    const result = await runStructuredBuildHybrid(filename, { ...options, candidatePages });
    recordExtractionEngineEvent({ operation: "structured.build", engine: "python", durationMs: result.durationMs });
    return result;
  } catch (error) {
    if (mode === "auto" && error?.code === "PYTHON_QUALITY_GATE_FAILED") {
      recordExtractionEngineEvent({ operation: "structured.build", engine: "node", fallbackReason: error.message, code: error.code, reportPath: error.details?.reportPath });
      options.onProgress?.({ phase: "python-structured-shadow-rejected", current: 0, total: 0, unit: "", warning: `${error.message}; see ${error.details?.reportPath || "hybrid quality report"}` });
      return null;
    }
    if (mode !== "auto" || !isRetryablePythonFailure(error)) throw error;
    recordExtractionEngineEvent({ operation: "structured.build", engine: "node", fallbackReason: error.message, code: error.code });
    options.onProgress?.({ phase: "python-structured-fallback-node", current: 0, total: 0, unit: "", warning: error.message });
    return null;
  }
}
