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
