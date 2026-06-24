import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { DEFAULT_RUNTIME_CONFIG } from "../core/runtime-config.js";
import {
  DEFAULT_EXTRACTION_ENGINE,
  DEFAULT_PYTHON_OPERATIONS,
  PYTHON_WORKER_CANCEL_GRACE_MS,
  PYTHON_WORKER_DEFAULT_TIMEOUT_MS,
  PYTHON_WORKER_MAX_STDERR_BYTES,
  PYTHON_WORKER_MAX_STDOUT_LINE_BYTES,
  PYTHON_WORKER_PROTOCOL_VERSION,
} from "../core/runtime-constants.js";
import { ensureInsideRoot } from "../core/path-safety.js";

const WORKER_ARTIFACT_CONTRACTS = Object.freeze({
  pages: { schemaVersion: 1, countKey: "pageCount" },
  tables: { schemaVersion: 1, countKey: "tableCount" },
  registers: { schemaVersion: 1, countKey: "registerCount" },
  bitfields: { schemaVersion: 3, countKey: "bitfieldCount" },
  cautions: { schemaVersion: 1, countKey: "cautionCount" },
  figures: { schemaVersion: 1, countKey: "figureCount" },
  figure_ocr: { schemaVersion: 1, countKey: "figureOcrCount" },
});

const RETRYABLE_WORKER_CODES = new Set([
  "PYTHON_UNAVAILABLE", "WORKER_SPAWN_FAILED", "WORKER_TIMEOUT", "WORKER_EXITED",
]);

let cachedProbe = null;
const recentEngineEvents = [];

export class PythonWorkerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PythonWorkerError";
    this.code = code;
    this.details = details;
    this.retryable = RETRYABLE_WORKER_CODES.has(code);
  }
}

export function normalizeExtractionMode(value) {
  const mode = String(value || DEFAULT_EXTRACTION_ENGINE).trim().toLowerCase();
  return ["auto", "python", "node"].includes(mode) ? mode : DEFAULT_EXTRACTION_ENGINE;
}

export function configuredPythonOperations(env = process.env) {
  const raw = String(env.RENESAS_MCP_PYTHON_OPERATIONS || "").trim();
  return new Set((raw ? raw.split(",") : DEFAULT_PYTHON_OPERATIONS).map((value) => String(value).trim().toLowerCase()).filter(Boolean));
}

export function operationFamily(operation) {
  return String(operation || "").split(".")[0].toLowerCase();
}

export function pythonOperationEnabled(operation, options = {}) {
  const mode = normalizeExtractionMode(options.mode || process.env.RENESAS_MCP_EXTRACTION_ENGINE);
  if (mode === "node") return false;
  if (mode === "python") return true;
  return configuredPythonOperations(options.env).has(operationFamily(operation));
}

function realFile(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolvePythonInterpreter(options = {}) {
  const rootDir = path.resolve(options.rootDir || DEFAULT_RUNTIME_CONFIG.rootDir);
  const env = options.env || process.env;
  const explicit = String(options.pythonPath || env.RENESAS_MCP_PYTHON || env.PDF_TOOL_PYTHON || "").trim();
  const explicitSource = options.pythonPath || env.RENESAS_MCP_PYTHON ? "RENESAS_MCP_PYTHON" : "PDF_TOOL_PYTHON";
  if (explicit) {
    if (path.isAbsolute(explicit) && !realFile(explicit)) {
      return { available: false, command: explicit, argsPrefix: [], source: explicitSource, reason: "configured interpreter does not exist" };
    }
    return { available: true, command: explicit, argsPrefix: [], source: explicitSource };
  }
  const venv = path.join(rootDir, ".venv", "Scripts", "python.exe");
  if (realFile(venv)) return { available: true, command: venv, argsPrefix: [], source: "project-venv" };
  return { available: true, command: "python.exe", argsPrefix: [], source: "system-probe", unverified: true };
}

function appendBounded(current, value, limit) {
  const joined = `${current}${value}`;
  return Buffer.byteLength(joined, "utf8") <= limit ? joined : joined.slice(-limit);
}

export async function runPythonWorker(request, options = {}) {
  const rootDir = path.resolve(options.rootDir || DEFAULT_RUNTIME_CONFIG.rootDir);
  const interpreter = options.interpreter || resolvePythonInterpreter({ rootDir, env: options.env, pythonPath: options.pythonPath });
  if (!interpreter.available) throw new PythonWorkerError("PYTHON_UNAVAILABLE", interpreter.reason || "Python interpreter unavailable", { interpreter });
  const spawn = options.spawn || (await import("node:child_process")).spawn;
  const timeoutMs = Math.max(50, Number(options.timeoutMs || PYTHON_WORKER_DEFAULT_TIMEOUT_MS));
  const requestId = String(request.requestId || `python-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  const payload = { ...request, protocolVersion: PYTHON_WORKER_PROTOCOL_VERSION, requestId };
  const args = options.workerArgs || [...(interpreter.argsPrefix || []), "-m", "python_worker"];
  let child;
  try {
    child = spawn(interpreter.command, args, {
      cwd: rootDir,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1", ...(options.env || {}) },
    });
  } catch (error) {
    throw new PythonWorkerError("WORKER_SPAWN_FAILED", error.message, { interpreter });
  }

  options.onSpawn?.(child.pid);
  const events = [];
  const artifacts = [];
  let resultEvent = null;
  let errorEvent = null;
  let stderr = "";
  let settled = false;
  let timedOut = false;
  let oversizedLine = false;

  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk.toString("utf8"), PYTHON_WORKER_MAX_STDERR_BYTES);
    options.onStderr?.(chunk.toString("utf8"));
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (Buffer.byteLength(line, "utf8") > PYTHON_WORKER_MAX_STDOUT_LINE_BYTES) {
      oversizedLine = true;
      child.kill();
      return;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      errorEvent = { code: "PROTOCOL_ERROR", message: "Python worker wrote non-JSON data to stdout" };
      child.kill();
      return;
    }
    if (event.protocolVersion !== PYTHON_WORKER_PROTOCOL_VERSION || event.requestId !== requestId) {
      errorEvent = { code: "PROTOCOL_ERROR", message: "Python worker protocol/request ID mismatch" };
      child.kill();
      return;
    }
    events.push(event);
    if (event.type === "progress") options.onProgress?.(event);
    if (event.type === "artifact" && event.artifact) artifacts.push(event.artifact);
    if (event.type === "result") resultEvent = event;
    if (event.type === "error") errorEvent = event;
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, PYTHON_WORKER_CANCEL_GRACE_MS).unref?.();
  }, timeoutMs);

  const exit = await new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new PythonWorkerError("WORKER_SPAWN_FAILED", error.message, { interpreter })));
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.stdin.end(JSON.stringify(payload));
  }).finally(() => {
    settled = true;
    clearTimeout(timer);
    lines.close();
  });

  if (timedOut) throw new PythonWorkerError("WORKER_TIMEOUT", `Python worker exceeded ${timeoutMs} ms`, { stderr, exit });
  if (oversizedLine) throw new PythonWorkerError("PROTOCOL_ERROR", "Python worker stdout line exceeded limit", { stderr, exit });
  if (errorEvent) throw new PythonWorkerError(errorEvent.code || "EXTRACTION_FAILED", errorEvent.message || "Python worker failed", { stderr, exit, event: errorEvent });
  if (exit.code !== 0 || !resultEvent) throw new PythonWorkerError("WORKER_EXITED", `Python worker exited without a result (code=${exit.code}, signal=${exit.signal || "none"})`, { stderr, exit });
  return { requestId, pid: child.pid, interpreter, events, artifacts, result: resultEvent.result, durationMs: resultEvent.durationMs, metrics: resultEvent.metrics || {}, stderr };
}

export async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function readArtifactHeader(filePath, bytes = 512 * 1024) {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function headNumber(head, key) {
  const match = head.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
}

function headString(head, key) {
  const match = head.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\n\\r]*)"`));
  return match ? match[1] : "";
}

export async function validateWorkerArtifact(descriptor, options = {}) {
  const contract = WORKER_ARTIFACT_CONTRACTS[descriptor?.kind];
  if (!contract) throw new PythonWorkerError("ARTIFACT_VALIDATION_FAILED", `Unsupported worker artifact kind: ${descriptor?.kind || "missing"}`);
  const workerRoot = path.resolve(options.workerRoot);
  const tempPath = ensureInsideRoot(descriptor.tempPath, workerRoot, "worker artifact");
  const stat = await fsp.stat(tempPath);
  if (!stat.isFile() || stat.size <= 0) throw new PythonWorkerError("ARTIFACT_VALIDATION_FAILED", "Worker artifact is empty or not a file");
  if (Number(descriptor.sizeBytes) !== stat.size) throw new PythonWorkerError("ARTIFACT_VALIDATION_FAILED", "Worker artifact size mismatch");
  const digest = await sha256File(tempPath);
  if (digest !== descriptor.sha256) throw new PythonWorkerError("ARTIFACT_VALIDATION_FAILED", "Worker artifact SHA-256 mismatch");
  const head = await readArtifactHeader(tempPath);
  const schemaVersion = headNumber(head, "schemaVersion");
  const filename = headString(head, "filename");
  const count = headNumber(head, contract.countKey);
  const sourceSize = headNumber(head, "size");
  const sourceMtimeMs = headNumber(head, "mtimeMs");
  if (schemaVersion !== contract.schemaVersion || Number(descriptor.schemaVersion) !== contract.schemaVersion) {
    throw new PythonWorkerError("ARTIFACT_VALIDATION_FAILED", `Schema mismatch for ${descriptor.kind}`);
  }
  if (filename !== options.filename) throw new PythonWorkerError("ARTIFACT_VALIDATION_FAILED", `Filename mismatch for ${descriptor.kind}`);
  if (count !== Number(descriptor.count)) throw new PythonWorkerError("ARTIFACT_VALIDATION_FAILED", `Count mismatch for ${descriptor.kind}`);
  if (options.source) {
    if (sourceSize !== Number(options.source.size) || Math.abs(Number(sourceMtimeMs) - Number(options.source.mtimeMs)) > 1500) {
      throw new PythonWorkerError("ARTIFACT_VALIDATION_FAILED", `Source fingerprint mismatch for ${descriptor.kind}`);
    }
  }
  return { ...descriptor, tempPath, sizeBytes: stat.size, sha256: digest, schemaVersion, count };
}

export async function atomicPromoteWorkerArtifact(tempPath, targetPath) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const incoming = `${targetPath}.tmp-promote-${process.pid}-${Date.now()}`;
  const backup = `${targetPath}.backup-${process.pid}-${Date.now()}`;
  await fsp.copyFile(tempPath, incoming);
  let backedUp = false;
  try {
    try {
      await fsp.rename(targetPath, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fsp.rename(incoming, targetPath);
    if (backedUp) await fsp.rm(backup, { force: true });
  } catch (error) {
    await fsp.rm(incoming, { force: true }).catch(() => {});
    if (backedUp) await fsp.rename(backup, targetPath).catch(() => {});
    throw error;
  }
  return targetPath;
}

export function recordExtractionEngineEvent(event) {
  recentEngineEvents.push({ at: new Date().toISOString(), ...event });
  if (recentEngineEvents.length > 30) recentEngineEvents.splice(0, recentEngineEvents.length - 30);
}

export async function probePythonWorker(options = {}) {
  if (!options.force && cachedProbe && Date.now() - cachedProbe.checkedMs < 60_000) return cachedProbe;
  const mode = normalizeExtractionMode(options.mode || process.env.RENESAS_MCP_EXTRACTION_ENGINE);
  if (mode === "node") {
    cachedProbe = { available: false, ready: false, mode, selectedEngine: "node", reason: "Node engine forced", checkedMs: Date.now() };
    return cachedProbe;
  }
  try {
    const response = await runPythonWorker({ operation: "health", allowedRoots: [] }, { ...options, timeoutMs: options.timeoutMs || 10_000 });
    cachedProbe = { available: true, ready: true, mode, selectedEngine: "python", interpreter: response.interpreter, versions: response.result?.versions || {}, operations: response.result?.operations || [], enabledOperations: [...configuredPythonOperations(options.env)], checkedMs: Date.now() };
  } catch (error) {
    cachedProbe = { available: false, ready: false, mode, selectedEngine: mode === "python" ? "unavailable" : "node", reason: error.message, code: error.code || "PYTHON_UNAVAILABLE", enabledOperations: [...configuredPythonOperations(options.env)], checkedMs: Date.now() };
  }
  return cachedProbe;
}

export async function getHybridRuntimeStatus(options = {}) {
  const probe = await probePythonWorker(options);
  return { schemaVersion: 1, mode: probe.mode, selectedEngine: probe.selectedEngine, pythonReady: probe.ready, interpreter: probe.interpreter || null, versions: probe.versions || {}, enabledOperations: probe.enabledOperations || [], reason: probe.reason || "", recentEvents: recentEngineEvents.slice(-8) };
}

export function isRetryablePythonFailure(error) {
  return error instanceof PythonWorkerError && error.retryable;
}
