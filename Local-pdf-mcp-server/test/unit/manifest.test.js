import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactManifest, formatManifestSummary, sourceFingerprint } from "../../src/artifacts/manifest.js";

test("sourceFingerprint uses size and mtime", () => {
  assert.equal(sourceFingerprint({ size: 10, mtimeMs: 20.2 }), "size=10;mtimeMs=20");
});

test("createArtifactManifest reports missing required artifacts", () => {
  const manifest = createArtifactManifest({
    filename: "manual.pdf",
    serverVersion: "test",
    source: { size: 10, mtimeMs: 20 },
    artifacts: [
      { key: "pages", status: "ok", ok: true, count: 3 },
      { key: "chunk-index", status: "missing", ok: false },
    ],
  });

  assert.equal(manifest.health, "fail");
  assert.deepEqual(manifest.missingRequired, ["chunk-index"]);
  assert.match(formatManifestSummary(manifest), /start_index_pdf/);
});
