import fs from "fs";
import path from "path";
import { createRequire } from "module";
import {
  normalizeProfileNameArray,
  validateDriverProfileFragmentObject,
  validateDriverProfileObject,
} from "../src/driver-profiles/catalog.js";
import { HIDDEN_COMPATIBILITY_TOOL_NAMES, HIDDEN_TOOL_DEFINITIONS, PUBLIC_TOOL_DEFINITIONS } from "../src/mcp/tool-definitions.js";
import { validateToolRegistryContract } from "../src/mcp/registry.js";
import { createRuntimeToolRegistry } from "../src/mcp/runtime-registry.js";
import { SERVER_VERSION } from "../src/core/runtime-constants.js";

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

const criticalPublicTools = [
  "list_pdfs",
  "pdf_info",
  "doctor",
  "index_pdf",
  "mcp_control",
  "hybrid_search_pdf",
  "find_register",
  "extract_bitfield_table",
  "build_driver_evidence_pack",
  "verify_register_usage",
  "rebuild_figure_manifest",
  "search_figures",
  "get_figure_context_pack",
  "get_figure_image",
  "query_manual",
  "get_manual_entity",
  "read_manual_evidence",
  "collect_manual_evidence",
];
for (const name of criticalPublicTools) {
  if (!tools.includes(name)) failures.push(`Critical public tool missing from registry: ${name}`);
}
const hiddenDeprecatedTools = [
  "job_status",
  "list_jobs",
  "start_index_pdf",
  "validate_index",
  "run_eval",
  "list_eval_cases",
  "analyze_figure_semantics",
  "search_figure_semantics",
  "rebuild_figure_semantics",
];
for (const name of hiddenDeprecatedTools) {
  if (tools.includes(name)) failures.push(`Hidden/deprecated tool is advertised: ${name}`);
  if (!HIDDEN_COMPATIBILITY_TOOL_NAMES.includes(name)) failures.push(`Hidden/deprecated tool missing from hidden list: ${name}`);
}
const publicHiddenOverlap = tools.filter((name) => HIDDEN_COMPATIBILITY_TOOL_NAMES.includes(name));
if (publicHiddenOverlap.length) failures.push(`Public/hidden overlap: ${publicHiddenOverlap.join(", ")}`);
const hiddenDefinitionNames = HIDDEN_TOOL_DEFINITIONS.map((tool) => tool.name);
for (const name of HIDDEN_COMPATIBILITY_TOOL_NAMES) {
  if (!hiddenDefinitionNames.includes(name)) failures.push(`Hidden tool missing definition: ${name}`);
}
for (const definition of HIDDEN_TOOL_DEFINITIONS) {
  if (definition.inputSchema?.type !== "object") failures.push(`Hidden tool missing object input schema: ${definition.name}`);
}

const handlerImportHygieneFiles = [
  "src/mcp/handlers/control.js",
  "src/mcp/handlers/manual-evidence.js",
  "src/mcp/handlers/figures.js",
  "src/mcp/handlers/driver.js",
];
for (const rel of handlerImportHygieneFiles) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    failures.push(`Missing handler for import hygiene check: ${rel}`);
    continue;
  }
  const text = fs.readFileSync(full, "utf-8");
  const body = text.replace(/^(import[\s\S]*?;\s*)+/m, "");
  const importMatches = [...text.matchAll(/^import\s+\{([^}]+)\}\s+from\s+["'][^"']+["'];/gm)];
  for (const match of importMatches) {
    const specifiers = match[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (specifiers.length > 24) failures.push(`${rel} has an overly broad named import (${specifiers.length} specifiers)`);
    for (const specifier of specifiers) {
      const localName = specifier.split(/\s+as\s+/).pop().trim();
      if (localName && !new RegExp(`\\b${localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(body)) {
        failures.push(`${rel} imports unused symbol: ${localName}`);
      }
    }
  }
  for (const match of text.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+["'][^"']+["'];/gm)) {
    const localName = match[1];
    if (!new RegExp(`\\b${localName}\\b`).test(body)) failures.push(`${rel} imports unused default: ${localName}`);
  }
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
  "src/artifacts/generation.js",
  "src/bitfields/semantics.js",
  "src/driver-profiles/catalog.js",
  "src/evidence/contract.js",
  "src/services/evidence-graph.js",
  "src/workflows/evidence-orchestrator.js",
  "src/eval/semantic.js",
  "src/eval/semantic-integration.js",
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
  "scripts/semantic-integration-eval.js",
  "scripts/python-setup.js",
  "scripts/python-health.js",
  "scripts/python-test.js",
  "scripts/benchmark-extraction.js",
  "eval/golden/rzg3e-core.json",
  "eval/semantic/ethernet.json",
  "eval/semantic/dma.json",
  "eval/semantic/gpio.json",
  "eval/semantic/watchdog.json",
  "eval/semantic/pwm.json",
  "eval/semantic/usb.json",
  "eval/semantic/coverage-queries.js",
  "docs/EVIDENCE_BUNDLE_V2.md",
  "docs/TOOL_CLASSIFICATION.md",
]) {
  if (!fs.existsSync(path.join(root, rel))) failures.push(`Missing file: ${rel}`);
}

if (fs.existsSync(path.join(root, "eval", "semantic", "expected-results.json"))) {
  failures.push("eval/semantic/expected-results.json is forbidden: semantic integration must execute the real retrieval engine");
}

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
} catch (e) {
  failures.push(`Invalid package.json: ${e.message}`);
}
let pkgLock = null;
try {
  pkgLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf-8"));
} catch (e) {
  failures.push(`Invalid package-lock.json: ${e.message}`);
}

if (pkg) {
  if (pkg.version !== SERVER_VERSION) failures.push(`package.json version ${pkg.version || "missing"} must match SERVER_VERSION ${SERVER_VERSION}`);
  if (pkg.type !== "module") failures.push(`package.json type must be module for index.js ESM imports; got ${pkg.type || "missing"}`);
  for (const script of ["start", "health", "smoke", "test", "check", "static-health", "architecture-health", "startup-smoke", "test:unit", "test:eval", "test:profiles", "golden:bootstrap", "golden:seed-report", "golden:eval", "test:golden", "test:semantic", "test:semantic:unit", "test:semantic:integration", "test:tools", "python:setup", "python:health", "test:python", "test:hybrid", "benchmark:extraction"]) {
    if (!pkg.scripts?.[script]) failures.push(`Missing package script: ${script}`);
  }
  for (const dep of ["@modelcontextprotocol/sdk", "pdfjs-dist", "pdf-parse"]) {
    if (!pkg.dependencies?.[dep]) failures.push(`Missing dependency in package.json: ${dep}`);
  }
}
if (pkgLock) {
  if (pkgLock.version !== SERVER_VERSION) failures.push(`package-lock.json root version ${pkgLock.version || "missing"} must match SERVER_VERSION ${SERVER_VERSION}`);
  const rootPackageVersion = pkgLock.packages?.[""]?.version;
  if (rootPackageVersion !== SERVER_VERSION) failures.push(`package-lock.json package version ${rootPackageVersion || "missing"} must match SERVER_VERSION ${SERVER_VERSION}`);
}

const serverConfigPath = path.resolve(root, "..", "mcpServers", "my-server.yaml");
if (fs.existsSync(serverConfigPath)) {
  const configText = fs.readFileSync(serverConfigPath, "utf-8");
  const versionMatch = configText.match(/^version:\s*([^\r\n#]+)/m);
  const configVersion = versionMatch?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (configVersion !== SERVER_VERSION) failures.push(`mcpServers/my-server.yaml version ${configVersion || "missing"} must match SERVER_VERSION ${SERVER_VERSION}`);
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

for (const rel of ["driver_profiles", "driver_profiles/fragments", "eval/profiles", "eval/fixtures", "eval/golden", "eval/semantic"]) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !(rel === "eval/semantic" && ["baseline.json", "expected-results.json"].includes(f)))) {
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
