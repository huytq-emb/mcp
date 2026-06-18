import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { ensureDirectPdfFilename, ensureInsideRoot, safeArtifactPath } from "../../src/core/path-safety.js";

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
