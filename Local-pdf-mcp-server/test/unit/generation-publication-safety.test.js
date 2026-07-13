import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppContext } from "../../src/core/app-context.js";
import { withPathResolver } from "../../src/core/path-resolver.js";
import {
  atomicWriteJson,
  safeArtifactManifestPath,
} from "../../src/core/runtime-helpers.js";
import { contentSourceFingerprint } from "../../src/artifacts/manifest.js";
import {
  CORE_GENERATION_ARTIFACTS,
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
import { writeArtifactManifest } from "../../src/services/jobs.js";
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
  if (value.build) await discardStagedGeneration(value.build).catch(() => {});
  await fs.rm(value.root, { recursive: true, force: true });
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
