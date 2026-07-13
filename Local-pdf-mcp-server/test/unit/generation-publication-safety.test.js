import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppContext } from "../../src/core/app-context.js";
import { withPathResolver } from "../../src/core/path-resolver.js";
import { bindRuntimePorts, withRuntimePortRegistry } from "../../src/core/runtime-ports.js";
import {
  atomicWriteJson,
  safeArtifactManifestPath,
} from "../../src/core/runtime-helpers.js";
import { contentSourceFingerprint } from "../../src/artifacts/manifest.js";
import {
  CORE_GENERATION_ARTIFACTS,
  loadCommittedCoreArtifact,
  loadCommittedReusableCoreArtifact,
  loadAndValidateCoreArtifactGenerations,
  stampCoreArtifactGenerations,
} from "../../src/artifacts/generation.js";
import { assertSameContentSource, readStableSourceIdentity } from "../../src/artifacts/source-identity.js";
import {
  FULL_BUILD_ARTIFACT_KEYS,
  createStagedArtifactBuild,
  discardStagedGeneration,
  finalizeStagedGeneration,
  promoteStagedGeneration,
  seedStagedPagesCache,
  validateCompleteStagedGeneration,
} from "../../src/services/artifact-build-transaction.js";
import { buildEvidenceGraph, loadEvidenceGraph } from "../../src/services/evidence-graph.js";
import { rebuildArtifact, writeArtifactManifest } from "../../src/services/jobs.js";
import { ensureFigureLookupIndex, loadFigureLookupIndex, loadPythonFiguresIndex, resolveFigureTarget } from "../../src/services/ocr.js";
import { loadPagesCache } from "../../src/services/pdf.js";
import { loadPdfIndex, loadRegistersIndex, loadSectionsIndex } from "../../src/services/indexing.js";
import { loadTablesIndex } from "../../src/domains/tables.js";
import { loadBitfieldsIndex } from "../../src/services/search.js";
import { loadCautionsIndex } from "../../src/domains/cautions.js";
import { loadSequencesIndex } from "../../src/domains/sequences.js";
import { loadFiguresIndex } from "../../src/domains/figures.js";

function coreArtifacts(filename, source, { pageText = "page A", bbox = [1, 2, 30, 40] } = {}) {
  const base = { filename, source };
  return {
    pages: { ...base, schemaVersion: 1, pageCount: 1, pages: [{ page: 1, text: pageText }] },
    "chunk-index": { ...base, schemaVersion: 3, chunkingVersion: 2, pageCount: 1, chunkCount: 0, chunks: [] },
    sections: { ...base, schemaVersion: 1, sectionCount: 0, sections: [] },
    tables: { ...base, schemaVersion: 1, tableCount: 0, tables: [] },
    registers: { ...base, schemaVersion: 1, registerCount: 0, registers: [] },
    bitfields: { ...base, schemaVersion: 3, bitfieldCount: 0, bitfields: [] },
    cautions: { ...base, schemaVersion: 1, cautionCount: 0, cautions: [] },
    sequences: { ...base, schemaVersion: 2, sequenceCount: 0, sequences: [] },
    figures: {
      ...base,
      schemaVersion: 1,
      pageCount: 1,
      figureCount: 1,
      figures: [{ id: "p1_f001", figure_id: "p1_f001", page: 1, caption: "Figure 1", bbox }],
    },
  };
}

async function createRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-generation-safety-"));
  const context = createAppContext({ rootDir: root });
  const filename = "manual.pdf";
  await fs.mkdir(context.paths.documentsDir(), { recursive: true });
  await fs.mkdir(context.paths.indexDir(), { recursive: true });
  await fs.writeFile(context.paths.pdf(filename), "same-pdf-content", "utf8");
  const source = await readStableSourceIdentity(context.paths.pdf(filename));
  return { root, context, filename, source };
}

async function writeCoreGeneration(resolver, filename, source, options = {}) {
  return withPathResolver(resolver, async () => {
    const artifacts = coreArtifacts(filename, source, options);
    for (const [key, artifact] of Object.entries(artifacts)) {
      await atomicWriteJson(CORE_GENERATION_ARTIFACTS[key](filename), artifact);
    }
    await stampCoreArtifactGenerations(filename, { source, chunkingVersion: 2 });
    return loadAndValidateCoreArtifactGenerations(filename, {
      sourceFingerprint: contentSourceFingerprint(source),
    });
  });
}

async function createReadyPagesFixture() {
  const value = await createRoot();
  const artifacts = await writeCoreGeneration(value.context.paths, value.filename, value.source);
  const sourceFingerprint = contentSourceFingerprint(value.source);
  await withPathResolver(value.context.paths, () => atomicWriteJson(safeArtifactManifestPath(value.filename), {
    schemaVersion: 1,
    filename: value.filename,
    buildStatus: "ready",
    health: "ok",
    source: { ...value.source, fingerprint: sourceFingerprint },
    generation: {
      buildId: "committed-pages",
      sourceFingerprint,
      artifactGenerations: { pages: artifacts.pages.generation.generationId },
    },
    artifacts: { pages: { key: "pages", status: "ok", ok: true } },
  }));
  const build = await withPathResolver(value.context.paths, () => createStagedArtifactBuild(value.filename, {
    source: value.source,
    buildId: `pages-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  }));
  return { ...value, artifacts, build };
}

async function createCompleteBuild(value, { bbox, pageText = "page A", buildId } = {}) {
  const build = await withPathResolver(value.context.paths, () => createStagedArtifactBuild(value.filename, {
    source: value.source,
    buildId: buildId || `complete-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  }));
  await writeCoreGeneration(build.resolver, value.filename, value.source, { bbox, pageText });
  await withPathResolver(build.resolver, async () => {
    await buildEvidenceGraph(value.filename);
    await writeArtifactManifest(value.filename, { source: value.source, buildStatus: "ready", clearStale: true });
    await finalizeStagedGeneration(build, { source: value.source });
    await validateCompleteStagedGeneration(build, { source: value.source });
  });
  return build;
}

async function cleanup(value) {
  for (const build of new Set([value.build, value.buildA, value.buildB].filter(Boolean))) {
    await discardStagedGeneration(build).catch(() => {});
  }
  await fs.rm(value.root, { recursive: true, force: true });
}

async function stagedSnapshot(build) {
  return new Map(await Promise.all([...FULL_BUILD_ARTIFACT_KEYS, "manifest"].map(async (key) => [
    key,
    await fs.readFile(build.stagedPaths[key]),
  ])));
}

async function installSnapshot(build, snapshot, { incompleteFirst = false } = {}) {
  if (incompleteFirst) {
    const ready = JSON.parse(snapshot.get("manifest").toString("utf8"));
    await fs.writeFile(build.activePaths.manifest, JSON.stringify({ ...ready, buildStatus: "incomplete", health: "fail" }));
  }
  for (const key of FULL_BUILD_ARTIFACT_KEYS) await fs.writeFile(build.activePaths[key], snapshot.get(key));
  await fs.writeFile(build.activePaths.manifest, snapshot.get("manifest"));
}

async function twoGenerationFixture() {
  const value = await createRoot();
  const buildA = await createCompleteBuild(value, { pageText: "generation A", bbox: [1, 2, 30, 40], buildId: "read-a" });
  const snapshotA = await stagedSnapshot(buildA);
  await promoteStagedGeneration(buildA);
  await discardStagedGeneration(buildA);
  const buildB = await createCompleteBuild(value, { pageText: "generation B", bbox: [5, 6, 70, 80], buildId: "read-b" });
  const snapshotB = await stagedSnapshot(buildB);
  return { ...value, buildA, buildB, snapshotA, snapshotB };
}

test("pages reuse accepts only the ready committed generation and ignores mtime-only source changes", async () => {
  const value = await createReadyPagesFixture();
  try {
    const before = await fs.readFile(value.build.activePaths.pages);
    const now = new Date(Date.now() + 20_000);
    await fs.utimes(value.context.paths.pdf(value.filename), now, now);
    assert.equal(await seedStagedPagesCache(value.build), true);
    assert.deepEqual(await fs.readFile(value.build.stagedPaths.pages), before);
  } finally { await cleanup(value); }
});

test("pages reuse rejects uncommitted, mismatched, modified, incomplete, and incompatible artifacts", async (t) => {
  const cases = [
    ["missing manifest", async (value) => fs.rm(value.build.activePaths.manifest, { force: true })],
    ["legacy manifest", async (value) => {
      const manifest = JSON.parse(await fs.readFile(value.build.activePaths.manifest, "utf8"));
      delete manifest.generation;
      await fs.writeFile(value.build.activePaths.manifest, JSON.stringify(manifest));
    }],
    ["unreadable manifest", async (value) => fs.writeFile(value.build.activePaths.manifest, "{broken")],
    ["incomplete manifest", async (value) => {
      const manifest = JSON.parse(await fs.readFile(value.build.activePaths.manifest, "utf8"));
      manifest.buildStatus = "incomplete";
      await fs.writeFile(value.build.activePaths.manifest, JSON.stringify(manifest));
    }],
    ["promotion_failed manifest", async (value) => {
      const manifest = JSON.parse(await fs.readFile(value.build.activePaths.manifest, "utf8"));
      manifest.buildStatus = "promotion_failed";
      await fs.writeFile(value.build.activePaths.manifest, JSON.stringify(manifest));
    }],
    ["failed manifest", async (value) => {
      const manifest = JSON.parse(await fs.readFile(value.build.activePaths.manifest, "utf8"));
      manifest.buildStatus = "failed";
      await fs.writeFile(value.build.activePaths.manifest, JSON.stringify(manifest));
    }],
    ["failed manifest health", async (value) => {
      const manifest = JSON.parse(await fs.readFile(value.build.activePaths.manifest, "utf8"));
      manifest.health = "fail";
      await fs.writeFile(value.build.activePaths.manifest, JSON.stringify(manifest));
    }],
    ["different manifest source", async (value) => {
      const manifest = JSON.parse(await fs.readFile(value.build.activePaths.manifest, "utf8"));
      manifest.source.sha256 = "b".repeat(64);
      manifest.source.fingerprint = `size=${manifest.source.size};sha256=${"b".repeat(64)}`;
      manifest.generation.sourceFingerprint = manifest.source.fingerprint;
      await fs.writeFile(value.build.activePaths.manifest, JSON.stringify(manifest));
    }],
    ["mismatched manifest generation", async (value) => {
      const manifest = JSON.parse(await fs.readFile(value.build.activePaths.manifest, "utf8"));
      manifest.generation.artifactGenerations.pages = "0".repeat(64);
      await fs.writeFile(value.build.activePaths.manifest, JSON.stringify(manifest));
    }],
    ["modified pages content", async (value) => {
      const pages = JSON.parse(await fs.readFile(value.build.activePaths.pages, "utf8"));
      pages.pages[0].text = "tampered after generation stamp";
      await fs.writeFile(value.build.activePaths.pages, JSON.stringify(pages));
    }],
    ["missing pages generation", async (value) => {
      const pages = JSON.parse(await fs.readFile(value.build.activePaths.pages, "utf8"));
      delete pages.generation;
      await fs.writeFile(value.build.activePaths.pages, JSON.stringify(pages));
    }],
    ["incompatible pages schema", async (value) => {
      const pages = JSON.parse(await fs.readFile(value.build.activePaths.pages, "utf8"));
      pages.schemaVersion = 999;
      await fs.writeFile(value.build.activePaths.pages, JSON.stringify(pages));
    }],
    ["artifactComplete missing", async (value) => {
      const pages = JSON.parse(await fs.readFile(value.build.activePaths.pages, "utf8"));
      delete pages.artifactComplete;
      await fs.writeFile(value.build.activePaths.pages, JSON.stringify(pages));
    }],
    ["artifactComplete false", async (value) => {
      const pages = JSON.parse(await fs.readFile(value.build.activePaths.pages, "utf8"));
      pages.artifactComplete = false;
      await fs.writeFile(value.build.activePaths.pages, JSON.stringify(pages));
    }],
    ["incompatible producer", async (value) => {
      const pages = JSON.parse(await fs.readFile(value.build.activePaths.pages, "utf8"));
      pages.generation.producerVersion = "0.0.0";
      await fs.writeFile(value.build.activePaths.pages, JSON.stringify(pages));
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const value = await createReadyPagesFixture();
      try {
        await mutate(value);
        assert.equal(await seedStagedPagesCache(value.build), false);
        await assert.rejects(fs.access(value.build.stagedPaths.pages));
      } finally { await cleanup(value); }
    });
  }
});

test("figure lookup is invalidated on commit and rebuilt only for the committed figures generation", async () => {
  const value = await createRoot();
  try {
    const buildA = await createCompleteBuild(value, { bbox: [1, 2, 30, 40], buildId: "generation-a" });
    await promoteStagedGeneration(buildA);
    await discardStagedGeneration(buildA);
    const lookupA = await withPathResolver(value.context.paths, () => ensureFigureLookupIndex(value.filename, null, { force: true }));
    const lookupABytes = await fs.readFile(value.context.paths.figureLookup(value.filename));
    assert.deepEqual(lookupA.byId.p1_f001.bbox, [1, 2, 30, 40]);

    const buildB = await createCompleteBuild(value, { bbox: [5, 6, 70, 80], buildId: "generation-b" });
    await promoteStagedGeneration(buildB);
    await discardStagedGeneration(buildB);
    await assert.rejects(fs.access(value.context.paths.figureLookup(value.filename)));
    const lookupB = await withPathResolver(value.context.paths, () => ensureFigureLookupIndex(value.filename));
    assert.deepEqual(lookupB.byId.p1_f001.bbox, [5, 6, 70, 80]);
    assert.notEqual(lookupB.figureGenerationId, lookupA.figureGenerationId);

    await fs.writeFile(value.context.paths.figureLookup(value.filename), lookupABytes);
    assert.equal(await withPathResolver(value.context.paths, () => loadFigureLookupIndex(value.filename)), null);
    const resolved = await withPathResolver(value.context.paths, () => resolveFigureTarget(value.filename, { figure_id: "p1_f001" }));
    assert.deepEqual(resolved.bbox, [5, 6, 70, 80]);
    assert.equal(resolved.lookup_cache_hit, true);
  } finally { await cleanup(value); }
});

test("figure lookup and figures roll back together when promotion fails after figures replacement", async () => {
  const value = await createRoot();
  try {
    const buildA = await createCompleteBuild(value, { bbox: [1, 2, 30, 40], buildId: "rollback-a" });
    await promoteStagedGeneration(buildA);
    await discardStagedGeneration(buildA);
    await withPathResolver(value.context.paths, () => ensureFigureLookupIndex(value.filename, null, { force: true }));
    const oldFigures = await fs.readFile(value.context.paths.figures(value.filename));
    const oldLookup = await fs.readFile(value.context.paths.figureLookup(value.filename));

    const buildB = await createCompleteBuild(value, { bbox: [5, 6, 70, 80], buildId: "rollback-b" });
    await assert.rejects(promoteStagedGeneration(buildB, {
      onPublish: async (key) => { if (key === "evidence-graph") throw new Error("injected after figures"); },
    }), /injected after figures/);
    assert.deepEqual(await fs.readFile(value.context.paths.figures(value.filename)), oldFigures);
    assert.deepEqual(await fs.readFile(value.context.paths.figureLookup(value.filename)), oldLookup);
    await discardStagedGeneration(buildB);
  } finally { await cleanup(value); }
});

test("source verification immediately before ready commit rolls back and preserves the previous generation", async () => {
  const value = await createRoot();
  try {
    const buildA = await createCompleteBuild(value, { bbox: [1, 2, 30, 40], buildId: "commit-a" });
    await promoteStagedGeneration(buildA);
    await discardStagedGeneration(buildA);
    const oldBytes = new Map(await Promise.all([...FULL_BUILD_ARTIFACT_KEYS, "manifest"].map(async (key) => [key, await fs.readFile(key === "manifest" ? value.context.paths.manifest(value.filename) : buildA.activePaths[key])])));

    const buildB = await createCompleteBuild(value, { bbox: [5, 6, 70, 80], buildId: "commit-b" });
    await assert.rejects(promoteStagedGeneration(buildB, {
      onPublish: async (key) => {
        if (key === "figures") await fs.writeFile(value.context.paths.pdf(value.filename), "different-content", "utf8");
      },
      verifyBeforeCommit: async () => assertSameContentSource(
        value.source,
        await readStableSourceIdentity(value.context.paths.pdf(value.filename)),
        value.filename,
      ),
    }), (error) => error?.code === "PDF_SOURCE_CHANGED");
    for (const key of FULL_BUILD_ARTIFACT_KEYS) assert.deepEqual(await fs.readFile(buildB.activePaths[key]), oldBytes.get(key), key);
    assert.deepEqual(await fs.readFile(buildB.activePaths.manifest), oldBytes.get("manifest"));
    await discardStagedGeneration(buildB);
  } finally { await cleanup(value); }
});

test("source verification before publication makes no active changes and same-content mtime changes still commit", async () => {
  const value = await createRoot();
  try {
    const buildA = await createCompleteBuild(value, { bbox: [1, 2, 30, 40], buildId: "prepublish-a" });
    await promoteStagedGeneration(buildA);
    await discardStagedGeneration(buildA);
    const oldManifest = await fs.readFile(value.context.paths.manifest(value.filename));
    const buildB = await createCompleteBuild(value, { bbox: [5, 6, 70, 80], buildId: "prepublish-b" });
    await fs.writeFile(value.context.paths.pdf(value.filename), "different-content", "utf8");
    await assert.rejects(promoteStagedGeneration(buildB, {
      verifyBeforePublish: async () => assertSameContentSource(value.source, await readStableSourceIdentity(value.context.paths.pdf(value.filename)), value.filename),
    }), (error) => error?.code === "PDF_SOURCE_CHANGED");
    assert.deepEqual(await fs.readFile(value.context.paths.manifest(value.filename)), oldManifest);
    await discardStagedGeneration(buildB);

    await fs.writeFile(value.context.paths.pdf(value.filename), "same-pdf-content", "utf8");
    const buildC = await createCompleteBuild(value, { bbox: [9, 10, 90, 100], buildId: "mtime-c" });
    const later = new Date(Date.now() + 30_000);
    await fs.utimes(value.context.paths.pdf(value.filename), later, later);
    await promoteStagedGeneration(buildC, {
      verifyBeforeCommit: async () => assertSameContentSource(value.source, await readStableSourceIdentity(value.context.paths.pdf(value.filename)), value.filename),
    });
    assert.equal(JSON.parse(await fs.readFile(value.context.paths.manifest(value.filename), "utf8")).generation.buildId, "mtime-c");
    await discardStagedGeneration(buildC);
  } finally { await cleanup(value); }
});

test("all transactional artifact loaders surface incomplete publication state", async () => {
  const value = await createRoot();
  try {
    await fs.writeFile(value.context.paths.manifest(value.filename), JSON.stringify({
      schemaVersion: 1,
      filename: value.filename,
      buildStatus: "incomplete",
      health: "fail",
    }));
    const loaders = [
      loadPagesCache,
      loadPdfIndex,
      loadSectionsIndex,
      loadTablesIndex,
      loadRegistersIndex,
      loadBitfieldsIndex,
      loadCautionsIndex,
      loadSequencesIndex,
      loadFiguresIndex,
      loadPythonFiguresIndex,
      loadEvidenceGraph,
      loadFigureLookupIndex,
    ];
    for (const loader of loaders) {
      await withPathResolver(value.context.paths, () => assert.rejects(
        loader(value.filename),
        (error) => error?.code === "ARTIFACT_GENERATION_INCOMPLETE",
        loader.name,
      ));
    }
  } finally { await cleanup(value); }
});

test("generation-consistent readers retry across successful publication for every transactional loader", async () => {
  const value = await twoGenerationFixture();
  try {
    const manifestB = JSON.parse(value.snapshotB.get("manifest").toString("utf8"));
    const loaders = [
      ["pages", loadPagesCache],
      ["chunk-index", loadPdfIndex],
      ["sections", loadSectionsIndex],
      ["tables", loadTablesIndex],
      ["registers", loadRegistersIndex],
      ["bitfields", loadBitfieldsIndex],
      ["cautions", loadCautionsIndex],
      ["sequences", loadSequencesIndex],
      ["figures", loadFiguresIndex],
      ["evidence-graph", loadEvidenceGraph],
    ];
    for (const [key, loader] of loaders) {
      await installSnapshot(value.buildA, value.snapshotA);
      let published = false;
      const artifact = await withPathResolver(value.context.paths, () => loader(value.filename, {
        maxAttempts: 2,
        onReadStep: async ({ step, attempt }) => {
          if (!published && attempt === 1 && step === "manifest-before") {
            published = true;
            await installSnapshot(value.buildB, value.snapshotB, { incompleteFirst: true });
          }
        },
      }));
      const expectedGenerationId = key === "evidence-graph"
        ? manifestB.generation.evidenceGraphGeneration
        : manifestB.generation.artifactGenerations[key];
      assert.equal(artifact.generation.generationId, expectedGenerationId, key);
    }
  } finally { await cleanup(value); }
});

test("committed reader never returns transient pages from a failed promotion rollback", async () => {
  const value = await twoGenerationFixture();
  try {
    const manifestB = JSON.parse(value.snapshotB.get("manifest").toString("utf8"));
    let replaced = false;
    let rolledBack = false;
    const pages = await withPathResolver(value.context.paths, () => loadCommittedCoreArtifact(value.filename, "pages", {
      expectedSourceFingerprint: contentSourceFingerprint(value.source),
      maxAttempts: 2,
      onReadStep: async ({ step, attempt }) => {
        if (attempt === 1 && step === "manifest-before" && !replaced) {
          replaced = true;
          await fs.writeFile(value.buildA.activePaths.manifest, JSON.stringify({ ...manifestB, buildStatus: "incomplete", health: "fail" }));
          await fs.writeFile(value.buildA.activePaths.pages, value.snapshotB.get("pages"));
        } else if (attempt === 1 && step === "artifact" && !rolledBack) {
          rolledBack = true;
          await fs.writeFile(value.buildA.activePaths.pages, value.snapshotA.get("pages"));
          await fs.writeFile(value.buildA.activePaths.manifest, value.snapshotA.get("manifest"));
        }
      },
    }));
    assert.equal(pages.pages[0].text, "generation A");
    assert.equal(pages.generation.generationId, JSON.parse(value.snapshotA.get("manifest")).generation.artifactGenerations.pages);
  } finally { await cleanup(value); }
});

test("reader retries when the ready manifest changes after artifact bytes are read", async () => {
  const value = await twoGenerationFixture();
  try {
    let published = false;
    const pages = await withPathResolver(value.context.paths, () => loadCommittedCoreArtifact(value.filename, "pages", {
      expectedSourceFingerprint: contentSourceFingerprint(value.source),
      maxAttempts: 2,
      onReadStep: async ({ step, attempt }) => {
        if (!published && attempt === 1 && step === "artifact") {
          published = true;
          await installSnapshot(value.buildB, value.snapshotB, { incompleteFirst: true });
        }
      },
    }));
    assert.equal(pages.pages[0].text, "generation B");
  } finally { await cleanup(value); }
});

test("continuous committed publication retries are bounded", async () => {
  const value = await twoGenerationFixture();
  try {
    let useB = true;
    let attempts = 0;
    await assert.rejects(withPathResolver(value.context.paths, () => loadCommittedCoreArtifact(value.filename, "pages", {
      expectedSourceFingerprint: contentSourceFingerprint(value.source),
      maxAttempts: 2,
      onReadStep: async ({ step }) => {
        if (step !== "manifest-before") return;
        attempts += 1;
        await installSnapshot(value.buildA, useB ? value.snapshotB : value.snapshotA, { incompleteFirst: true });
        useB = !useB;
      },
    })), (error) => error?.code === "ARTIFACT_GENERATION_CHANGED");
    assert.equal(attempts, 2);
  } finally { await cleanup(value); }
});

test("staged pages are written from validated bytes rather than recopied from the active path", async () => {
  const value = await createReadyPagesFixture();
  try {
    const activePages = JSON.parse(await fs.readFile(value.build.activePaths.pages, "utf8"));
    const tampered = { ...activePages, pages: [{ page: 1, text: "standalone replacement X" }] };
    assert.equal(await seedStagedPagesCache(value.build, {
      afterReusableArtifactValidated: async () => fs.writeFile(value.build.activePaths.pages, JSON.stringify(tampered)),
    }), true);
    const stagedPages = JSON.parse(await fs.readFile(value.build.stagedPaths.pages, "utf8"));
    assert.equal(stagedPages.pages[0].text, "page A");
    assert.equal(JSON.parse(await fs.readFile(value.build.activePaths.pages, "utf8")).pages[0].text, "standalone replacement X");
    for (const key of Object.keys(CORE_GENERATION_ARTIFACTS).filter((key) => key !== "pages")) {
      await fs.copyFile(value.build.activePaths[key], value.build.stagedPaths[key]);
    }
    await withPathResolver(value.build.resolver, () => stampCoreArtifactGenerations(value.filename, {
      source: value.source,
      chunkingVersion: 2,
      fs: value.build.fs,
    }));
    const restamped = JSON.parse(await fs.readFile(value.build.stagedPaths.pages, "utf8"));
    assert.equal(restamped.pages[0].text, "page A");
  } finally { await cleanup(value); }
});

test("generation validation and page staging consistently use the injected filesystem", async () => {
  const value = await createReadyPagesFixture();
  try {
    const manifestPath = value.context.paths.manifest(value.filename);
    const pagesPath = value.context.paths.pages(value.filename);
    const virtualFiles = new Map([
      [manifestPath, await fs.readFile(manifestPath)],
      [pagesPath, await fs.readFile(pagesPath)],
    ]);
    await fs.rm(manifestPath, { force: true });
    await fs.rm(pagesPath, { force: true });
    const calls = [];
    const virtualFs = {
      access: async (filePath) => { calls.push(["access", String(filePath)]); if (!virtualFiles.has(String(filePath))) throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      readFile: async (filePath, encoding) => {
        calls.push(["readFile", String(filePath)]);
        const data = virtualFiles.get(String(filePath));
        if (!data) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return encoding ? data.toString(encoding) : Buffer.from(data);
      },
    };
    const reusable = await withPathResolver(value.context.paths, () => loadCommittedReusableCoreArtifact(value.filename, "pages", {
      expectedSourceFingerprint: contentSourceFingerprint(value.source),
      fs: virtualFs,
      resolver: value.context.paths,
    }));
    assert.equal(reusable.pages[0].text, "page A");
    assert.ok(calls.some(([operation, filePath]) => operation === "access" && filePath === pagesPath));
    assert.ok(calls.filter(([operation]) => operation === "readFile").length >= 3);

    for (const [code, failingOperation] of [["EACCES", "access"], ["EIO", "manifest"], ["ENOSPC", "artifact"]]) {
      const failingFs = {
        access: async () => { if (failingOperation === "access") throw Object.assign(new Error(code), { code }); },
        readFile: async (filePath, encoding) => {
          if (failingOperation === "manifest" && String(filePath) === manifestPath) throw Object.assign(new Error(code), { code });
          if (failingOperation === "artifact" && String(filePath) === pagesPath) throw Object.assign(new Error(code), { code });
          const data = virtualFiles.get(String(filePath));
          return encoding ? data.toString(encoding) : Buffer.from(data);
        },
      };
      await assert.rejects(withPathResolver(value.context.paths, () => loadCommittedReusableCoreArtifact(value.filename, "pages", {
        expectedSourceFingerprint: contentSourceFingerprint(value.source),
        fs: failingFs,
        resolver: value.context.paths,
      })), (error) => error?.code === code, code);
    }

    const incompatibleFiles = new Map(virtualFiles);
    const incompatibleManifest = JSON.parse(incompatibleFiles.get(manifestPath).toString("utf8"));
    incompatibleManifest.generation.artifactGenerations.pages = "0".repeat(64);
    incompatibleFiles.set(manifestPath, Buffer.from(JSON.stringify(incompatibleManifest)));
    const incompatibleFs = {
      access: async () => {},
      readFile: async (filePath, encoding) => {
        const data = incompatibleFiles.get(String(filePath));
        return encoding ? data.toString(encoding) : Buffer.from(data);
      },
    };
    assert.equal(await withPathResolver(value.context.paths, () => loadCommittedReusableCoreArtifact(value.filename, "pages", {
      expectedSourceFingerprint: contentSourceFingerprint(value.source),
      fs: incompatibleFs,
      resolver: value.context.paths,
    })), null);
  } finally { await cleanup(value); }

  const stagedValue = await createReadyPagesFixture();
  try {
    await discardStagedGeneration(stagedValue.build);
    const calls = [];
    const proxyFs = new Proxy(fs, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== "function") return value;
        return async (...args) => {
          calls.push(String(property));
          return value(...args);
        };
      },
    });
    const build = await withPathResolver(stagedValue.context.paths, () => createStagedArtifactBuild(stagedValue.filename, {
      source: stagedValue.source,
      buildId: "injected-page-stage",
      fs: proxyFs,
    }));
    stagedValue.build = build;
    assert.equal(await seedStagedPagesCache(build), true);
    assert.ok(calls.includes("access"));
    assert.ok(calls.includes("readFile"));
    assert.ok(calls.includes("open") || calls.includes("writeFile"));
    assert.ok(calls.includes("rename"));
    assert.equal(calls.includes("copyFile"), false);
  } finally { await cleanup(stagedValue); }
});

test("standalone pages rebuild invalidates the ready generation before replacing bytes", async () => {
  const value = await createRoot();
  try {
    const buildA = await createCompleteBuild(value, { pageText: "generation A", buildId: "standalone-a" });
    await promoteStagedGeneration(buildA);
    await discardStagedGeneration(buildA);
    const registry = value.context.runtimePorts;
    bindRuntimePorts({
      buildPagesCache: async () => {
        const pages = {
          schemaVersion: 1,
          filename: value.filename,
          source: value.source,
          pageCount: 1,
          pages: [{ page: 1, text: "standalone pages X" }],
        };
        await atomicWriteJson(value.context.paths.pages(value.filename), pages);
        return pages;
      },
    }, registry);
    let releaseInvalidation;
    let observedInvalidation;
    const invalidated = new Promise((resolve) => { observedInvalidation = resolve; });
    const pause = new Promise((resolve) => { releaseInvalidation = resolve; });
    const rebuild = withPathResolver(value.context.paths, () => withRuntimePortRegistry(
      registry,
      () => rebuildArtifact(value.filename, "pages", {
        afterManifestInvalidated: async () => {
          observedInvalidation();
          await pause;
        },
      }),
    ));
    await invalidated;
    await withPathResolver(value.context.paths, () => assert.rejects(
      loadPagesCache(value.filename),
      (error) => error?.code === "ARTIFACT_GENERATION_INCOMPLETE",
    ));
    releaseInvalidation();
    await rebuild;
    const blockedManifest = JSON.parse(await fs.readFile(value.context.paths.manifest(value.filename), "utf8"));
    assert.equal(blockedManifest.buildStatus, "incomplete");
    assert.equal(blockedManifest.staleArtifacts.includes("chunk-index"), true);
    assert.equal(JSON.parse(await fs.readFile(value.context.paths.pages(value.filename), "utf8")).pages[0].text, "standalone pages X");

    const buildB = await createCompleteBuild(value, { pageText: "generation B", buildId: "standalone-b" });
    await promoteStagedGeneration(buildB);
    await discardStagedGeneration(buildB);
    const committed = await withPathResolver(value.context.paths, () => loadPagesCache(value.filename));
    assert.equal(committed.pages[0].text, "generation B");
  } finally { await cleanup(value); }
});
