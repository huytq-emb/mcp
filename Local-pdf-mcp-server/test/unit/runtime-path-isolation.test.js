import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppContext } from "../../src/core/app-context.js";
import { createRuntimeConfig, DEFAULT_RUNTIME_CONFIG } from "../../src/core/runtime-config.js";
import { createPathResolver } from "../../src/core/path-resolver.js";
import { wireRuntimePorts } from "../../src/app/runtime-wiring.js";
import { atomicWriteJson, safePagesCachePath, safePdfPath } from "../../src/core/runtime-helpers.js";
import { createToolRegistry } from "../../src/mcp/registry.js";
import { getJobStore } from "../../src/services/jobs.js";

test("custom runtime context isolates representative artifacts and Windows-style roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-runtime-paths-"));
  const filename = `isolation-${process.pid}-${Date.now()}.pdf`;
  const defaultPdf = path.join(DEFAULT_RUNTIME_CONFIG.paths.documentsDir, filename);
  const defaultPages = path.join(DEFAULT_RUNTIME_CONFIG.paths.indexDir, `${filename}.pages.json`);
  const context = createAppContext({ rootDir: root.replace(/\\/g, "/") });
  wireRuntimePorts(context);
  try {
    await fs.mkdir(context.paths.documentsDir(), { recursive: true });
    await fs.writeFile(safePdfPath(filename), "%PDF isolated", "utf8");
    await atomicWriteJson(safePagesCachePath(filename), { filename, pages: [] });
    assert.equal(path.relative(root, safePdfPath(filename)).startsWith(".."), false);
    assert.equal(path.relative(root, safePagesCachePath(filename)).startsWith(".."), false);
    await assert.rejects(fs.access(defaultPdf));
    await assert.rejects(fs.access(defaultPages));
    assert.match(context.paths.indexDir(), /[\\/]indexes$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("path resolver rejects PDF and job traversal", () => {
  const config = createRuntimeConfig({ rootDir: path.join(os.tmpdir(), "mcp-path-traversal") });
  const resolver = createPathResolver(config);
  assert.throws(() => resolver.pdf("../manual.pdf"), /directly inside|direct filename|path separators/i);
  assert.throws(() => resolver.pdf("..\\manual.pdf"), /directly inside|direct filename|path separators/i);
  assert.throws(() => resolver.job("../job"), /Invalid background job id/);
});

test("concurrent registries retain paths, runtime ports, filesystem, and clock", async () => {
  const [rootA, rootB] = await Promise.all([
    fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-a-")),
    fs.mkdtemp(path.join(os.tmpdir(), "mcp-registry-b-")),
  ]);
  const filename = `concurrent-${process.pid}-${Date.now()}.pdf`;
  const defaultArtifact = path.join(DEFAULT_RUNTIME_CONFIG.paths.indexDir, `${filename}.pages.json`);
  const openedA = [];
  const openedB = [];
  const trackingFs = (opened) => new Proxy(fs, {
    get(target, property) {
      if (property === "open") return async (filePath, ...args) => { opened.push(String(filePath)); return target.open(filePath, ...args); };
      return target[property];
    },
  });
  const contextA = createAppContext({ rootDir: rootA, fs: trackingFs(openedA), clock: { now: () => 111, nowIso: () => new Date(111).toISOString() } });
  const contextB = createAppContext({ rootDir: rootB, fs: trackingFs(openedB), clock: { now: () => 222, nowIso: () => new Date(222).toISOString() } });
  const definition = { name: "write_scoped", description: "test", inputSchema: { type: "object", properties: { delay: { type: "number" } }, additionalProperties: false } };
  const makeRegistry = (context, id) => createToolRegistry({
    context,
    definitions: [definition],
    handlers: { write_scoped: async ({ delay = 0 }) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      await atomicWriteJson(safePagesCachePath(filename), { filename, id });
      const store = getJobStore();
      const persisted = await store.createJob({ id: `context-${id}`, status: "queued", createdMs: 1, updatedMs: 0, metadata: {}, log: [] });
      return { root: store.paths.root(), clockNow: store.clock.now(), updatedMs: persisted.updatedMs };
    } },
  });
  try {
    wireRuntimePorts(contextA);
    const registryA = makeRegistry(contextA, "a");
    const first = registryA.dispatchTool("write_scoped", { delay: 30 });
    wireRuntimePorts(contextB);
    const registryB = makeRegistry(contextB, "b");
    const [resultA, resultB] = await Promise.all([first, registryB.dispatchTool("write_scoped")]);
    assert.equal(resultA.root, path.resolve(rootA));
    assert.equal(resultB.root, path.resolve(rootB));
    assert.equal(resultA.clockNow, 111);
    assert.equal(resultB.clockNow, 222);
    assert.equal(resultA.updatedMs, 111);
    assert.equal(resultB.updatedMs, 222);
    assert.deepEqual(JSON.parse(await fs.readFile(contextA.paths.pages(filename), "utf8")), { filename, id: "a", artifactComplete: true });
    assert.deepEqual(JSON.parse(await fs.readFile(contextB.paths.pages(filename), "utf8")), { filename, id: "b", artifactComplete: true });
    assert.equal(openedA.some((filePath) => filePath.startsWith(contextA.paths.jobsDir())), true);
    assert.equal(openedB.some((filePath) => filePath.startsWith(contextB.paths.jobsDir())), true);
    await assert.rejects(fs.access(defaultArtifact));
  } finally {
    await Promise.all([fs.rm(rootA, { recursive: true, force: true }), fs.rm(rootB, { recursive: true, force: true })]);
  }
});
