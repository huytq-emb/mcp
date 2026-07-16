import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { ensureDirectPdfFilename, ensureInsideRoot, ensureRegularFileInsideRoot, safeArtifactPath } from "../../src/core/path-safety.js";
import { isIndexLockStale } from "../../src/core/runtime-helpers.js";
import { createRuntimeConfig } from "../../src/core/runtime-config.js";
import { createPathResolver, registerPathResolverDependencies, withPathResolver } from "../../src/core/path-resolver.js";
import { loadPdfDocument } from "../../src/services/pdf.js";

test("ensureDirectPdfFilename accepts direct PDF filenames", () => {
  assert.equal(ensureDirectPdfFilename("r01uh1069ej0115-rzg3e.pdf"), "r01uh1069ej0115-rzg3e.pdf");
});

test("ensureDirectPdfFilename rejects traversal and non-PDF names", () => {
  assert.throws(() => ensureDirectPdfFilename("../manual.pdf"), /Invalid filename/);
  assert.throws(() => ensureDirectPdfFilename("nested/manual.pdf"), /Invalid filename/);
  assert.throws(() => ensureDirectPdfFilename("manual.txt"), /Only \.pdf/);
});

test("safeArtifactPath stays inside the artifact root", () => {
  const root = path.resolve("indexes");
  const artifact = safeArtifactPath(root, "manual.pdf", ".manifest.json", "manifest");
  assert.equal(artifact, path.join(root, "manual.pdf.manifest.json"));
});

test("ensureInsideRoot rejects paths outside root", () => {
  const root = path.resolve("indexes");
  assert.throws(() => ensureInsideRoot(path.resolve("documents/manual.pdf"), root, "test"), /Invalid test path/);
});

test("ensureRegularFileInsideRoot rejects PDF symlinks and reparse points before reads", async () => {
  const root = path.resolve("C:/manual-root");
  const candidate = path.join(root, "manual.pdf");
  const fsOps = {
    lstat: async () => ({ isSymbolicLink: () => true, isFile: () => true }),
    realpath: async (value) => value,
  };
  await assert.rejects(
    ensureRegularFileInsideRoot(candidate, root, "PDF", fsOps),
    /symbolic links and reparse points are not allowed/,
  );
});

test("PDF.js entry rejects a symlink before reading PDF bytes", async () => {
  const resolver = createPathResolver(createRuntimeConfig({ rootDir: "C:/strict-pdf-entry" }));
  registerPathResolverDependencies(resolver, {
    fs: {
      lstat: async () => ({ isSymbolicLink: () => true, isFile: () => true }),
      realpath: async (value) => value,
    },
  });
  await withPathResolver(resolver, () => assert.rejects(
    loadPdfDocument("manual.pdf"),
    /symbolic links and reparse points are not allowed/,
  ));
});

test("PDF worker, renderer, OCR, evaluator, and benchmark entry paths use strict validation", async () => {
  const files = [
    "src/app/hybrid-runtime.js",
    "src/domains/rendering.js",
    "src/services/ocr.js",
    "src/services/pdf.js",
    "src/eval/semantic-integration.js",
    "scripts/benchmark-extraction.js",
  ];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    assert.doesNotMatch(source, /pdfPath:\s*safePdfPath\(/, `${file} passes a lexical-only PDF path to a reader`);
  }
});

test("index locks from absent PIDs are stale immediately while a live recent lock is preserved", () => {
  const now = Date.now();
  assert.equal(isIndexLockStale({ pid: 2_147_483_647, createdAtMs: now }, now), true);
  assert.equal(isIndexLockStale({ pid: process.pid, createdAtMs: now }, now), false);
});
