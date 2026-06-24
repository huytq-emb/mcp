import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const srcRoot = path.join(root, "src");
const failures = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.isFile() && entry.name.endsWith(".js") ? [full] : [];
  });
}

const files = walk(srcRoot);
const fileSet = new Set(files.map((file) => path.resolve(file)));
const graph = new Map(files.map((file) => [path.resolve(file), []]));
for (const file of files) {
  const source = fs.readFileSync(file, "utf-8");
  for (const match of source.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)) {
    if (!match[1].startsWith(".")) continue;
    const target = path.resolve(path.dirname(file), match[1]);
    if (fileSet.has(target)) graph.get(path.resolve(file)).push(target);
  }
}

let sequence = 0;
const indexes = new Map();
const lowLinks = new Map();
const stack = [];
const onStack = new Set();
const components = [];
function strongConnect(node) {
  indexes.set(node, sequence);
  lowLinks.set(node, sequence);
  sequence += 1;
  stack.push(node);
  onStack.add(node);
  for (const next of graph.get(node) || []) {
    if (!indexes.has(next)) {
      strongConnect(next);
      lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
    } else if (onStack.has(next)) {
      lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(next)));
    }
  }
  if (lowLinks.get(node) === indexes.get(node)) {
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    components.push(component);
  }
}
for (const file of graph.keys()) if (!indexes.has(file)) strongConnect(file);

const cycles = components.filter((component) => component.length > 1);
for (const cycle of cycles) {
  failures.push(`Import cycle: ${cycle.map((file) => path.relative(root, file).replace(/\\/g, "/")).sort().join(" -> ")}`);
}

function layerFor(file) {
  const relative = path.relative(srcRoot, file).replace(/\\/g, "/");
  if (relative.startsWith("app/")) return { name: "app", rank: 5 };
  if (relative.startsWith("mcp/")) return { name: "mcp", rank: 4 };
  if (relative.startsWith("workflows/") || relative === "eval/runtime.js") return { name: "workflow/eval", rank: 3 };
  if (relative.startsWith("domains/")) return { name: "domains", rank: 2 };
  if (relative.startsWith("services/")) return { name: "services", rank: 1 };
  return { name: "foundation", rank: 0 };
}

let layerViolations = 0;
for (const [file, dependencies] of graph) {
  const sourceLayer = layerFor(file);
  for (const dependency of dependencies) {
    const targetLayer = layerFor(dependency);
    if (sourceLayer.rank >= targetLayer.rank) continue;
    layerViolations += 1;
    failures.push(`Layer violation: ${path.relative(root, file).replace(/\\/g, "/")} (${sourceLayer.name}) imports ${path.relative(root, dependency).replace(/\\/g, "/")} (${targetLayer.name})`);
  }
}

const indexLines = fs.readFileSync(path.join(root, "index.js"), "utf-8").split(/\r?\n/).length;
if (indexLines > 80) failures.push(`index.js must remain a thin bootstrap (lines=${indexLines}, max=80)`);
if (/\bfunction\s+(?:build|load|search|find|format|render|extract)[A-Z]/.test(fs.readFileSync(path.join(root, "index.js"), "utf-8"))) {
  failures.push("index.js contains domain implementation");
}

const bootstrapUrl = new URL("../src/app/bootstrap.js", import.meta.url);
if (!fileURLToPath(bootstrapUrl).startsWith(root)) failures.push("Bootstrap path resolved outside project root");

console.log(`Architecture health: files=${files.length}, cycles=${cycles.length}, layerViolations=${layerViolations}, indexLines=${indexLines}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log("Architecture health: PASS");
