import fs from "fs";
import path from "path";
import { createRequire } from "module";

const root = process.cwd();
const indexPath = path.join(root, "index.js");
const source = fs.readFileSync(indexPath, "utf-8");
const require = createRequire(import.meta.url);

const toolMatches = [...source.matchAll(/name:\s*"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
const firstToolsArray = source.indexOf("const tools = [");
const handlersMarker = source.indexOf("// Tool handlers");
const toolSource = source.slice(firstToolsArray, handlersMarker > firstToolsArray ? handlersMarker : source.length);
const tools = [...toolSource.matchAll(/name:\s*"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
const failures = [];

if (!tools.length) failures.push("No tools found in const tools array");
if (tools.length < 60) failures.push(`Tool registry unexpectedly small: ${tools.length} tools`);
const duplicates = tools.filter((n, i) => tools.indexOf(n) !== i);
if (duplicates.length) failures.push(`Duplicate tools: ${[...new Set(duplicates)].join(", ")}`);

const missingHandlers = tools.filter((n) => !source.includes(`name === "${n}"`));
if (missingHandlers.length) failures.push(`Missing call handlers: ${missingHandlers.join(", ")}`);

const criticalTools = [
  "list_pdfs",
  "pdf_info",
  "doctor",
  "validate_index",
  "eval_health_check",
  "start_index_pdf",
  "index_pdf",
  "hybrid_search_pdf",
  "find_register",
  "extract_bitfield_table",
  "prepare_driver_task",
  "build_driver_evidence_pack",
  "verify_register_usage",
];
for (const name of criticalTools) {
  if (!tools.includes(name)) failures.push(`Critical tool missing from registry: ${name}`);
}

for (const rel of ["driver_profiles", "eval", "eval/profiles", "eval/fixtures", "eval/golden"]) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) failures.push(`Missing directory: ${rel}`);
}

for (const rel of [
  "src/core/path-safety.js",
  "src/artifacts/manifest.js",
  "src/evidence/contract.js",
  "src/eval/golden.js",
  "scripts/startup-smoke.js",
  "scripts/eval-smoke.js",
  "scripts/golden-bootstrap.js",
  "scripts/golden-eval.js",
  "eval/golden/rzg3e-core.json",
]) {
  if (!fs.existsSync(path.join(root, rel))) failures.push(`Missing file: ${rel}`);
}

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
} catch (e) {
  failures.push(`Invalid package.json: ${e.message}`);
}

if (pkg) {
  if (pkg.type !== "module") failures.push(`package.json type must be module for index.js ESM imports; got ${pkg.type || "missing"}`);
  for (const script of ["start", "health", "smoke", "test", "check", "static-health", "startup-smoke", "test:unit", "test:eval", "golden:bootstrap", "golden:eval", "test:golden"]) {
    if (!pkg.scripts?.[script]) failures.push(`Missing package script: ${script}`);
  }
  for (const dep of ["@modelcontextprotocol/sdk", "pdfjs-dist", "pdf-parse"]) {
    if (!pkg.dependencies?.[dep]) failures.push(`Missing dependency in package.json: ${dep}`);
  }
}

const dependencyProbes = [
  "@modelcontextprotocol/sdk/server/index.js",
  "pdfjs-dist/legacy/build/pdf.mjs",
  "pdf-parse",
];
for (const probe of dependencyProbes) {
  try {
    require.resolve(probe);
  } catch (e) {
    failures.push(`Dependency not resolvable: ${probe}. Run npm.cmd ci. (${e.code || e.message})`);
  }
}

for (const rel of ["driver_profiles", "eval/profiles", "eval/fixtures", "eval/golden"]) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const full = path.join(dir, file);
    try {
      const data = JSON.parse(fs.readFileSync(full, "utf-8"));
      if (!Object.prototype.hasOwnProperty.call(data, "schemaVersion")) failures.push(`Missing schemaVersion: ${rel}/${file}`);
    } catch (e) {
      failures.push(`Invalid JSON: ${rel}/${file}: ${e.message}`);
    }
  }
}

console.log(`Static health: tools=${tools.length}, handlers=${tools.length - missingHandlers.length}`);
if (failures.length) {
  console.error(failures.map((f) => `FAIL: ${f}`).join("\n"));
  process.exit(1);
}
console.log("Static health: PASS");
