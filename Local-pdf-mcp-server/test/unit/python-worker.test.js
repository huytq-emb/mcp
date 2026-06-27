import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppContext } from "../../src/core/app-context.js";
import { atomicWriteJson, safeFigureOcrIndexPath, safePdfPath } from "../../src/core/runtime-helpers.js";
import { wireRuntimePorts } from "../../src/app/runtime-wiring.js";
import {
  PythonWorkerError,
  isRetryablePythonFailure,
  pythonOperationEnabled,
  resolvePythonInterpreter,
  runPythonWorker,
  validateWorkerArtifact,
} from "../../src/services/python-worker.js";
import { cancelBackgroundJob, jobs, normalizeArtifactName } from "../../src/services/jobs.js";
import { formatOcrHealthReport } from "../../src/services/ocr.js";
import { searchFigureOcr } from "../../src/services/search.js";

const fakeWorker = path.resolve("test/fixtures/fake-python-worker.js");
const nodeInterpreter = { available: true, command: process.execPath, argsPrefix: [], source: "test" };

test("hybrid operation parity gate defaults to pages and allows explicit python mode", () => {
  assert.equal(pythonOperationEnabled("pages.build", { mode: "auto", env: {} }), true);
  assert.equal(pythonOperationEnabled("tables.build", { mode: "auto", env: {} }), false);
  assert.equal(pythonOperationEnabled("tables.build", { mode: "python", env: {} }), true);
  assert.equal(pythonOperationEnabled("pages.build", { mode: "node", env: {} }), false);
});

test("interpreter resolution prefers explicit path then project venv", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "renesas-python-resolve-"));
  const explicit = path.join(root, "explicit.exe");
  await fs.writeFile(explicit, "test");
  assert.equal(resolvePythonInterpreter({ rootDir: root, pythonPath: explicit }).source, "RENESAS_MCP_PYTHON");
  await fs.mkdir(path.join(root, ".venv", "Scripts"), { recursive: true });
  await fs.writeFile(path.join(root, ".venv", "Scripts", "python.exe"), "test");
  assert.equal(resolvePythonInterpreter({ rootDir: root, env: {} }).source, "project-venv");
  await fs.rm(root, { recursive: true, force: true });
});

test("JSONL runner keeps stderr separate and emits progress", async () => {
  const progress = [];
  const response = await runPythonWorker({ operation: "health", allowedRoots: [], options: { mode: "stderr" } }, {
    interpreter: nodeInterpreter, workerArgs: [fakeWorker], timeoutMs: 5000, onProgress: (event) => progress.push(event),
  });
  assert.equal(response.result.echo, "health");
  assert.equal(progress.length, 1);
  assert.match(response.stderr, /debug-only/);
});

test("JSONL runner rejects malformed stdout", async () => {
  await assert.rejects(
    runPythonWorker({ operation: "health", allowedRoots: [], options: { mode: "malformed" } }, { interpreter: nodeInterpreter, workerArgs: [fakeWorker], timeoutMs: 5000 }),
    (error) => error instanceof PythonWorkerError && error.code === "PROTOCOL_ERROR",
  );
});

test("JSONL runner rejects oversized stdout and enforces timeout", async () => {
  await assert.rejects(
    runPythonWorker({ operation: "health", allowedRoots: [], options: { mode: "oversized" } }, { interpreter: nodeInterpreter, workerArgs: [fakeWorker], timeoutMs: 5000 }),
    (error) => error instanceof PythonWorkerError && error.code === "PROTOCOL_ERROR",
  );
  await assert.rejects(
    runPythonWorker({ operation: "health", allowedRoots: [], options: { mode: "delay" } }, { interpreter: nodeInterpreter, workerArgs: [fakeWorker], timeoutMs: 80 }),
    (error) => error instanceof PythonWorkerError && error.code === "WORKER_TIMEOUT",
  );
});

test("job cancellation persists a worker sentinel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "renesas-worker-cancel-"));
  const cancelPath = path.join(root, "cancel.requested");
  jobs.set("cancel-test", { id: "cancel-test", type: "test", filename: "manual.pdf", status: "running", metadata: { cancelPath }, log: [] });
  cancelBackgroundJob("cancel-test", "test cancellation");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await fs.access(cancelPath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.match(await fs.readFile(cancelPath, "utf8"), /test cancellation/);
  jobs.delete("cancel-test");
  await fs.rm(root, { recursive: true, force: true });
});

test("artifact validation verifies schema filename count hash and source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "renesas-worker-artifact-"));
  const artifactPath = path.join(root, "pages.json");
  const artifact = { schemaVersion: 1, filename: "manual.pdf", source: { size: 10, mtimeMs: 20 }, pageCount: 1, pages: [{ page: 1, text: "hello" }] };
  const data = JSON.stringify(artifact);
  await fs.writeFile(artifactPath, data);
  const descriptor = { kind: "pages", tempPath: artifactPath, schemaVersion: 1, count: 1, sizeBytes: Buffer.byteLength(data), sha256: crypto.createHash("sha256").update(data).digest("hex") };
  const validated = await validateWorkerArtifact(descriptor, { workerRoot: root, filename: "manual.pdf", source: { size: 10, mtimeMs: 20 } });
  assert.equal(validated.count, 1);
  await assert.rejects(validateWorkerArtifact({ ...descriptor, sha256: "bad" }, { workerRoot: root, filename: "manual.pdf", source: { size: 10, mtimeMs: 20 } }), /SHA-256/);
  await fs.rm(root, { recursive: true, force: true });
});

test("semantic and schema worker failures are not retryable infrastructure fallbacks", () => {
  assert.equal(isRetryablePythonFailure(new PythonWorkerError("WORKER_TIMEOUT", "timeout")), true);
  assert.equal(isRetryablePythonFailure(new PythonWorkerError("PYTHON_QUALITY_GATE_FAILED", "quality gate failed")), false);
  assert.equal(isRetryablePythonFailure(new PythonWorkerError("ARTIFACT_VALIDATION_FAILED", "schema mismatch")), false);
});

test("figure OCR artifact aliases normalize without adding a public tool", () => {
  assert.equal(normalizeArtifactName("figure_ocr"), "figure_ocr");
  assert.equal(normalizeArtifactName("figure-ocr"), "figure_ocr");
  assert.equal(normalizeArtifactName("ocr"), "figure_ocr");
});

test("OCR health formatter reports optional dependency hints without failing core", () => {
  const text = formatOcrHealthReport({
    ok: true,
    node: { ok: true },
    python: { ok: true, versions: { pymupdf: "1.0-test" } },
    ocr: {
      enabled: false,
      engine: "paddleocr",
      available: false,
      reason: "missing dependency",
      hint: "Run: .\\.venv\\Scripts\\python.exe -m pip install -r requirements-ocr.txt",
      modelCache: { path: "C:\\workspace\\indexes\\cache\\paddlex", modelCount: 0, hint: "Run: npm.cmd run ocr:prewarm -- --mode=text,structure" },
    },
  });
  assert.match(text, /OCR health via eval_health_check: OK/);
  assert.match(text, /PaddleOCR: missing/);
  assert.match(text, /Cached PaddleX models: 0/);
  assert.match(text, /ocr:prewarm/);
  assert.match(text, /requirements-ocr\.txt/);
  assert.match(text, /Machine summary JSON/);
});

test("search can include cached figure OCR as supplemental evidence", async () => {
  wireRuntimePorts(createAppContext());
  const filename = `unit-figure-ocr-${Date.now()}.pdf`;
  const pdfPath = safePdfPath(filename);
  const ocrPath = safeFigureOcrIndexPath(filename);
  try {
    await fs.mkdir(path.dirname(pdfPath), { recursive: true });
    await fs.writeFile(pdfPath, "unit pdf bytes");
    const stat = await fs.stat(pdfPath);
    await atomicWriteJson(ocrPath, {
      schemaVersion: 1,
      filename,
      source: { size: stat.size, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString() },
      figures: [{
        figureUid: "p0001_f001",
        page: 1,
        caption: "Figure 1 DMA block diagram",
        ocrText: "DMAREQ DMAACK bus master",
        confidenceAvg: 0.91,
        sourceType: "figure_ocr",
      }],
    });
    const results = await searchFigureOcr(filename, "DMAREQ", 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].sourceType, "figure_ocr");
    assert.equal(results[0].figureUid, "p0001_f001");
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await fs.rm(ocrPath, { force: true }).catch(() => {});
  }
});
