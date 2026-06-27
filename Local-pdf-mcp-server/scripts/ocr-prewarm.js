import path from "node:path";
import { runPythonWorker } from "../src/services/python-worker.js";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseModes(value) {
  const modes = String(value || "text,structure")
    .split(/[,\s;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return modes.length ? modes : ["text", "structure"];
}

const rootDir = process.cwd();
const cacheHome = path.resolve(argValue("cache", process.env.PADDLE_PDX_CACHE_HOME || path.join(rootDir, "indexes", "cache", "paddlex")));
const timeoutMs = Math.max(60_000, Number(argValue("timeout", "900000")));
const modes = parseModes(argValue("mode", "text,structure"));
const includeVl = hasFlag("include-vl");
const modelSource = argValue("model-source", "");
const checkSource = hasFlag("check-source");

const env = {
  PADDLE_PDX_CACHE_HOME: cacheHome,
};
if (!checkSource) env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK = "True";
if (modelSource) env.PADDLE_PDX_MODEL_SOURCE = modelSource;

console.log(`PaddleX cache: ${cacheHome}`);
console.log(`Modes: ${modes.join(", ")}${includeVl ? ", vl" : ""}`);
console.log(`Model source check: ${checkSource ? "enabled" : "disabled for prewarm"}`);
if (modelSource) console.log(`Preferred model source: ${modelSource}`);

const worker = await runPythonWorker({
  operation: "ocr.prewarm",
  allowedRoots: [],
  options: { modes, includeVl },
}, {
  timeoutMs,
  env,
});

const result = worker.result || {};
for (const item of result.results || []) {
  console.log(`${item.ok ? "OK" : "FAIL"} ${item.mode}: ${item.message || ""}`);
  if (item.hint) console.log(`  Hint: ${item.hint}`);
}

console.log("");
console.log("Machine summary JSON:");
console.log(JSON.stringify({
  ok: Boolean(result.ok),
  durationMs: worker.durationMs,
  cache: result.modelCache,
  results: result.results || [],
  warnings: result.warnings || [],
}, null, 2));

if (!result.ok) process.exitCode = 1;
