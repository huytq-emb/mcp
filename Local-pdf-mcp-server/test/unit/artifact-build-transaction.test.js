import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppContext } from "../../src/core/app-context.js";
import { withPathResolver } from "../../src/core/path-resolver.js";
import { ensureInsideRoot } from "../../src/core/path-safety.js";
import { assertArtifactPublicationReadable } from "../../src/core/runtime-helpers.js";
import { atomicWriteJson as writeArtifactJson } from "../../src/core/runtime-helpers.js";
import { replaceFileAtomic } from "../../src/core/atomic-file.js";
import { assertSameContentSource, isCompatibleBuildCheckpoint, readStableSourceIdentity } from "../../src/artifacts/source-identity.js";
import { stampCoreArtifactGenerations } from "../../src/artifacts/generation.js";
import { buildEvidenceGraph } from "../../src/services/evidence-graph.js";
import { writeArtifactManifest } from "../../src/services/jobs.js";
import { FULL_BUILD_ARTIFACT_KEYS, createStagedArtifactBuild, discardStagedGeneration, finalizeStagedGeneration, promoteStagedGeneration, validateCompleteStagedGeneration } from "../../src/services/artifact-build-transaction.js";
import { pythonWorkerAllowedRoots } from "../../src/app/hybrid-runtime.js";

async function fixture({ active = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-artifact-transaction-"));
  const context = createAppContext({ rootDir: root });
  const filename = "manual.pdf";
  await fs.mkdir(context.paths.documentsDir(), { recursive: true });
  await fs.mkdir(context.paths.indexDir(), { recursive: true });
  await fs.writeFile(context.paths.pdf(filename), "AAAA", "utf8");
  const source = await readStableSourceIdentity(context.paths.pdf(filename));
  const build = await withPathResolver(context.paths, () => createStagedArtifactBuild(filename, { source, buildId: `test-${Date.now()}-${Math.random().toString(16).slice(2)}` }));
  const oldBytes = new Map();
  for (const key of FULL_BUILD_ARTIFACT_KEYS) {
    const oldValue = Buffer.from(`old:${key}`);
    oldBytes.set(key, oldValue);
    if (active) await fs.writeFile(build.activePaths[key], oldValue);
    await fs.writeFile(build.stagedPaths[key], `new:${key}`);
  }
  const oldManifest = Buffer.from(JSON.stringify({ schemaVersion: 1, filename, buildStatus: "ready", health: "ok", marker: "old" }, null, 2));
  if (active) await fs.writeFile(build.activePaths.manifest, oldManifest);
  await fs.writeFile(build.stagedPaths.manifest, JSON.stringify({
    schemaVersion: 1,
    filename,
    buildStatus: "ready",
    health: "ok",
    generation: { buildId: build.id },
    marker: "new",
  }, null, 2));
  return { root, context, filename, source, build, oldBytes, oldManifest };
}

async function cleanup(value) {
  await discardStagedGeneration(value.build).catch(() => {});
  await fs.rm(value.root, { recursive: true, force: true });
}

test("staged builds allow the isolated Python worker output root", async () => {
  const value = await fixture();
  try {
    const roots = await withPathResolver(value.build.resolver, () => pythonWorkerAllowedRoots());
    const workerRoot = value.build.resolver.pythonWorkerTempDir();
    assert.equal(roots.includes(path.resolve(workerRoot)), true);
    assert.equal(roots.includes(path.resolve(value.build.stageDir)), true);
    assert.doesNotThrow(() => ensureInsideRoot(path.join(workerRoot, "request", "pages.json"), workerRoot, "worker artifact"));
  } finally { await cleanup(value); }
});

test("source-changed full-build staging discards failed bytes without publishing over the ready generation", async () => {
  const value = await fixture();
  try {
    await fs.writeFile(value.context.paths.pdf(value.filename), "BBBB", "utf8");
    const finalSource = await readStableSourceIdentity(value.context.paths.pdf(value.filename));
    assert.throws(() => assertSameContentSource(value.source, finalSource, value.filename), (error) => error?.code === "PDF_SOURCE_CHANGED");
    await discardStagedGeneration(value.build);
    for (const key of FULL_BUILD_ARTIFACT_KEYS) assert.deepEqual(await fs.readFile(value.build.activePaths[key]), value.oldBytes.get(key));
    assert.deepEqual(await fs.readFile(value.build.activePaths.manifest), value.oldManifest);
    assert.equal(JSON.parse(await fs.readFile(value.build.activePaths.manifest, "utf8")).buildStatus, "ready");
    await assert.rejects(fs.access(value.build.stageDir));
  } finally { await cleanup(value); }
});

test("promotion failure on the third artifact restores every previous byte including the ready manifest", async () => {
  const value = await fixture();
  let replacements = 0;
  try {
    await assert.rejects(promoteStagedGeneration(value.build, {
      replaceFile: async (incoming, target, options) => {
        replacements += 1;
        if (replacements === 3) throw Object.assign(new Error("Windows replacement denied"), { code: "EPERM" });
        return replaceFileAtomic(incoming, target, options);
      },
    }), /Windows replacement denied/);
    for (const key of FULL_BUILD_ARTIFACT_KEYS) assert.deepEqual(await fs.readFile(value.build.activePaths[key]), value.oldBytes.get(key), key);
    assert.deepEqual(await fs.readFile(value.build.activePaths.manifest), value.oldManifest);
  } finally { await cleanup(value); }
});

test("promotion without a previous generation removes new files and leaves a rejecting failure marker", async () => {
  const value = await fixture({ active: false });
  let replacements = 0;
  try {
    await assert.rejects(promoteStagedGeneration(value.build, {
      replaceFile: async (incoming, target, options) => {
        replacements += 1;
        if (replacements === 2) throw new Error("second artifact failed");
        return replaceFileAtomic(incoming, target, options);
      },
    }), /second artifact failed/);
    for (const key of FULL_BUILD_ARTIFACT_KEYS) await assert.rejects(fs.access(value.build.activePaths[key]), undefined, key);
    const manifest = JSON.parse(await fs.readFile(value.build.activePaths.manifest, "utf8"));
    assert.equal(manifest.buildStatus, "promotion_failed");
    await withPathResolver(value.context.paths, () => assert.rejects(assertArtifactPublicationReadable(value.filename), /promotion_failed/));
  } finally { await cleanup(value); }
});

test("rollback failure never restores a ready manifest over an uncertain artifact set", async () => {
  const value = await fixture();
  let replacements = 0;
  try {
    await assert.rejects(promoteStagedGeneration(value.build, {
      replaceFile: async (incoming, target, options) => {
        replacements += 1;
        if (replacements === 3) throw new Error("promotion failed");
        if (replacements === 4) throw new Error("rollback failed");
        return replaceFileAtomic(incoming, target, options);
      },
    }), /rollback operation/);
    const manifest = JSON.parse(await fs.readFile(value.build.activePaths.manifest, "utf8"));
    assert.equal(manifest.buildStatus, "promotion_failed");
    assert.equal(manifest.health, "fail");
  } finally { await cleanup(value); }
});

test("ready manifest is the final publication operation and incomplete readers are rejected", async () => {
  const value = await fixture();
  const order = [];
  try {
    await promoteStagedGeneration(value.build, { onPublish: (key) => order.push(key) });
    assert.equal(order.at(-1), "manifest:ready");
    assert.equal(JSON.parse(await fs.readFile(value.build.activePaths.manifest, "utf8")).marker, "new");
    await fs.writeFile(value.build.activePaths.manifest, JSON.stringify({ schemaVersion: 1, filename: value.filename, buildStatus: "incomplete" }));
    await withPathResolver(value.context.paths, () => assert.rejects(assertArtifactPublicationReadable(value.filename), /incomplete/));
  } finally { await cleanup(value); }
});

test("partial checkpoints require matching build and SHA identity while ignoring mtime-only changes", () => {
  const source = { size: 4, mtimeMs: 10, sha256: "a".repeat(64) };
  const checkpoint = { schemaVersion: 1, filename: "manual.pdf", buildId: "build-a", source };
  assert.equal(isCompatibleBuildCheckpoint(checkpoint, { filename: "manual.pdf", buildId: "build-a", source: { ...source, mtimeMs: 999 }, schemaVersion: 1 }), true);
  assert.equal(isCompatibleBuildCheckpoint(checkpoint, { filename: "manual.pdf", buildId: "build-b", source, schemaVersion: 1 }), false);
  assert.equal(isCompatibleBuildCheckpoint(checkpoint, { filename: "manual.pdf", buildId: "build-a", source: { ...source, sha256: "b".repeat(64) }, schemaVersion: 1 }), false);
});

test("complete staged generation validates schemas, SHA identity, dependency generations, graph, and manifest", async () => {
  const value = await fixture({ active: false });
  try {
    await withPathResolver(value.build.resolver, async () => {
      const base = { filename: value.filename, source: value.source };
      const artifacts = {
        pages: { ...base, schemaVersion: 1, pageCount: 1, pages: [{ page: 1, text: "" }] },
        "chunk-index": { ...base, schemaVersion: 3, chunkingVersion: 2, pageCount: 1, chunkCount: 0, chunks: [] },
        sections: { ...base, schemaVersion: 1, sectionCount: 0, sections: [] },
        tables: { ...base, schemaVersion: 1, tableCount: 0, tables: [] },
        registers: { ...base, schemaVersion: 1, registerCount: 0, registers: [] },
        bitfields: { ...base, schemaVersion: 3, bitfieldCount: 0, bitfields: [] },
        cautions: { ...base, schemaVersion: 1, cautionCount: 0, cautions: [] },
        sequences: { ...base, schemaVersion: 2, sequenceCount: 0, sequences: [] },
        figures: { ...base, schemaVersion: 1, figureCount: 0, figures: [] },
      };
      for (const [key, artifact] of Object.entries(artifacts)) await writeArtifactJson(value.build.stagedPaths[key], artifact);
      await stampCoreArtifactGenerations(value.filename, { source: value.source, chunkingVersion: 2 });
      await buildEvidenceGraph(value.filename);
      const preFinalizeGraph = JSON.parse(await fs.readFile(value.build.stagedPaths["evidence-graph"], "utf8"));
      const historicalLocation = preFinalizeGraph.entities.flatMap((entry) => entry.sourceLocations || [])[0];
      historicalLocation.sourceArtifact = path.join(path.dirname(value.build.stageDir), "previous-deleted-build", path.basename(value.build.stagedPaths.pages));
      await writeArtifactJson(value.build.stagedPaths["evidence-graph"], preFinalizeGraph);
      await writeArtifactManifest(value.filename, { source: value.source, buildStatus: "ready", clearStale: true });
      await finalizeStagedGeneration(value.build, { source: value.source });
      const finalizedGraph = JSON.parse(await fs.readFile(value.build.stagedPaths["evidence-graph"], "utf8"));
      assert.equal(finalizedGraph.entities.every((entry) => (entry.sourceLocations || []).every((location) => !String(location.sourceArtifact || "").startsWith(value.build.stageDir))), true);
      assert.equal(finalizedGraph.entities.flatMap((entry) => entry.sourceLocations || [])[0].sourceArtifact, value.build.activePaths.pages);
      const validated = await validateCompleteStagedGeneration(value.build, { source: { ...value.source, mtimeMs: value.source.mtimeMs + 10_000 } });
      assert.equal(validated.manifest.generation.buildId, value.build.id);
      assert.equal(validated.graph.generation.sourceFingerprint, validated.manifest.generation.sourceFingerprint);
    });
  } finally { await cleanup(value); }
});
