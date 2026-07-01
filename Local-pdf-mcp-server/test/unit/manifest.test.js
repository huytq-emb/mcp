import assert from "node:assert/strict";
import test from "node:test";
import { artifactDescendants, createArtifactManifest, formatManifestSummary, sourceFingerprint } from "../../src/artifacts/manifest.js";

test("sourceFingerprint uses size and mtime", () => {
  assert.equal(sourceFingerprint({ size: 10, mtimeMs: 20.2 }), "size=10;mtimeMs=20");
});

test("manifest marks rebuilt dependency descendants stale", () => {
  assert.deepEqual(new Set(artifactDescendants("tables")), new Set(["registers", "bitfields", "sequences", "cautions", "module-profile", "driver-pack", "driver-task-plan"]));
  const manifest = createArtifactManifest({
    filename: "manual.pdf",
    artifacts: [
      { key: "tables", exists: true, status: "ok", ok: true },
      { key: "registers", exists: true, status: "ok", ok: true },
    ],
    staleArtifacts: ["registers"],
  });
  assert.equal(manifest.artifacts.registers.status, "stale");
  assert.equal(manifest.health, "fail");
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
  assert.match(formatManifestSummary(manifest), /index_pdf\(filename="manual\.pdf", mode="background"\)/);
});
