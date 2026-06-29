import fs from "fs";
import path from "path";
import { createRequire } from "module";
import {
  normalizeProfileNameArray,
  validateDriverProfileFragmentObject,
  validateDriverProfileObject,
} from "../src/driver-profiles/catalog.js";
import { PUBLIC_TOOL_DEFINITIONS } from "../src/mcp/tool-definitions.js";
import { HIDDEN_COMPATIBILITY_TOOL_NAMES, validateToolRegistryContract } from "../src/mcp/registry.js";
import { createRuntimeToolRegistry } from "../src/mcp/runtime-registry.js";

const root = process.cwd();
const indexPath = path.join(root, "index.js");
const require = createRequire(import.meta.url);
const failures = [];
const registry = createRuntimeToolRegistry();
const tools = PUBLIC_TOOL_DEFINITIONS.map((tool) => tool.name);
const expectedAdvertisedCount = PUBLIC_TOOL_DEFINITIONS.length;
const contract = validateToolRegistryContract(registry, { expectedAdvertisedCount });

if (!contract.ok) failures.push(...contract.errors);
if (!tools.length) failures.push("No tools found in structured MCP catalog");
if (tools.length !== expectedAdvertisedCount) failures.push(`Tool registry must advertise exactly ${expectedAdvertisedCount} tools; found ${tools.length}`);
const duplicates = tools.filter((n, i) => tools.indexOf(n) !== i);
if (duplicates.length) failures.push(`Duplicate tools: ${[...new Set(duplicates)].join(", ")}`);

const missingHandlers = tools.filter((name) => !registry.has(name));
if (missingHandlers.length) failures.push(`Missing call handlers: ${missingHandlers.join(", ")}`);
const missingCompatibilityHandlers = HIDDEN_COMPATIBILITY_TOOL_NAMES.filter((name) => !registry.has(name));
if (missingCompatibilityHandlers.length) failures.push(`Missing compatibility handlers: ${missingCompatibilityHandlers.join(", ")}`);

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
  "rebuild_figure_manifest",
  "search_figures",
  "get_figure_context_pack",
];
for (const name of criticalTools) {
  if (!tools.includes(name)) failures.push(`Critical tool missing from registry: ${name}`);
}

for (const rel of ["driver_profiles", "driver_profiles/fragments", "eval", "eval/profiles", "eval/fixtures", "eval/golden"]) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) failures.push(`Missing directory: ${rel}`);
}

for (const rel of [
  "src/app/bootstrap.js",
  "src/app/runtime-wiring.js",
  "src/core/path-safety.js",
  "src/core/app-context.js",
  "src/core/runtime-config.js",
  "src/core/runtime-ports.js",
  "src/artifacts/manifest.js",
  "src/bitfields/semantics.js",
  "src/driver-profiles/catalog.js",
  "src/evidence/contract.js",
  "src/eval/golden.js",
  "src/mcp/registry.js",
  "src/mcp/runtime-registry.js",
  "src/mcp/server.js",
  "src/mcp/tool-definitions.js",
  "src/services/python-worker.js",
  "src/services/ocr.js",
  "src/app/hybrid-runtime.js",
  "python_worker/__main__.py",
  "python_worker/protocol.py",
  "python_worker/pdf_engine.py",
  "python_worker/extractors.py",
  "python_worker/figure_ocr.py",
  "requirements.txt",
  "requirements-ocr.txt",
  "workers/pdf_worker.py",
  "scripts/architecture-health.js",
  "scripts/startup-smoke.js",
  "scripts/eval-smoke.js",
  "scripts/profile-eval-smoke.js",
  "scripts/tool-smoke-rzg3e.js",
  "scripts/golden-bootstrap.js",
  "scripts/golden-seed-report.js",
  "scripts/golden-eval.js",
  "scripts/python-setup.js",
  "scripts/python-health.js",
  "scripts/python-test.js",
  "scripts/benchmark-extraction.js",
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
  for (const script of ["start", "health", "smoke", "test", "check", "static-health", "architecture-health", "startup-smoke", "test:unit", "test:eval", "test:profiles", "golden:bootstrap", "golden:seed-report", "golden:eval", "test:golden", "test:tools", "python:setup", "python:health", "test:python", "test:hybrid", "benchmark:extraction"]) {
    if (!pkg.scripts?.[script]) failures.push(`Missing package script: ${script}`);
  }
  for (const dep of ["@modelcontextprotocol/sdk", "pdfjs-dist", "pdf-parse"]) {
    if (!pkg.dependencies?.[dep]) failures.push(`Missing dependency in package.json: ${dep}`);
  }
}

const requirements = fs.readFileSync(path.join(root, "requirements.txt"), "utf-8");
if (/^\s*mcp(?:[=<>!~]|\s|$)/mi.test(requirements)) failures.push("requirements.txt must not install the Python MCP SDK");
for (const dependency of ["PyMuPDF", "orjson"]) if (!new RegExp(`^\\s*${dependency}`, "mi").test(requirements)) failures.push(`Missing Python extraction dependency: ${dependency}`);
for (const heavyDependency of ["paddleocr", "paddlepaddle", "Pillow"]) {
  if (new RegExp(`^\\s*${heavyDependency}`, "mi").test(requirements)) failures.push(`Optional OCR dependency must stay out of requirements.txt: ${heavyDependency}`);
}
const ocrRequirementsPath = path.join(root, "requirements-ocr.txt");
const ocrRequirements = fs.existsSync(ocrRequirementsPath) ? fs.readFileSync(ocrRequirementsPath, "utf-8") : "";
for (const dependency of ["paddleocr", "paddlepaddle", "Pillow"]) {
  if (!new RegExp(`^\\s*${dependency}`, "mi").test(ocrRequirements)) failures.push(`Missing optional OCR dependency in requirements-ocr.txt: ${dependency}`);
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

for (const rel of ["driver_profiles", "driver_profiles/fragments", "eval/profiles", "eval/fixtures", "eval/golden"]) {
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

const fragmentsDir = path.join(root, "driver_profiles", "fragments");
const fragmentNames = new Set();
if (fs.existsSync(fragmentsDir)) {
  for (const file of fs.readdirSync(fragmentsDir).filter((f) => f.endsWith(".json"))) {
    const full = path.join(fragmentsDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(full, "utf-8"));
      const name = file.replace(/\.json$/i, "");
      const validation = validateDriverProfileFragmentObject(data, `driver_profiles/fragments/${file}`);
      if (!validation.ok) failures.push(...validation.errors);
      fragmentNames.add(name);
    } catch (e) {
      failures.push(`Invalid JSON: driver_profiles/fragments/${file}: ${e.message}`);
    }
  }
}

const profilesDir = path.join(root, "driver_profiles");
if (fs.existsSync(profilesDir)) {
  for (const file of fs.readdirSync(profilesDir).filter((f) => f.endsWith(".json"))) {
    const full = path.join(profilesDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(full, "utf-8"));
      const validation = validateDriverProfileObject(data, `driver_profiles/${file}`);
      if (!validation.ok) failures.push(...validation.errors);
      for (const fragmentName of normalizeProfileNameArray(data.fragments || [])) {
        if (!fragmentNames.has(fragmentName)) failures.push(`driver_profiles/${file} references missing fragment: ${fragmentName}`);
      }
    } catch (e) {
      failures.push(`Invalid driver profile: driver_profiles/${file}: ${e.message}`);
    }
  }
}

console.log(`Static health: tools=${tools.length}, handlers=${tools.length - missingHandlers.length}`);
if (failures.length) {
  console.error(failures.map((f) => `FAIL: ${f}`).join("\n"));
  process.exit(1);
}
console.log("Static health: PASS");
