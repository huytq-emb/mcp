import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic, atomicWriteJson } from "../core/atomic-file.js";
import { getPathResolver, getPathResolverDependencies, registerPathResolverDependencies, withPathResolver } from "../core/path-resolver.js";
import { EVIDENCE_GRAPH_SCHEMA_VERSION } from "../core/runtime-constants.js";
import { loadAndValidateCoreArtifactGenerations, loadCommittedReusableCoreArtifact } from "../artifacts/generation.js";
import { ARTIFACT_MANIFEST_SCHEMA_VERSION, contentSourceFingerprint } from "../artifacts/manifest.js";
import { assertSameContentSource, requireStrongSourceIdentity } from "../artifacts/source-identity.js";
import { validateEvidenceGraph } from "./evidence-graph.js";

const ARTIFACT_METHODS = Object.freeze({
  pages: "pages",
  "chunk-index": "chunkIndex",
  sections: "sections",
  tables: "tables",
  registers: "registers",
  bitfields: "bitfields",
  cautions: "cautions",
  sequences: "sequences",
  figures: "figures",
  "figure-lookup": "figureLookup",
  "evidence-graph": "evidenceGraph",
  manifest: "manifest",
  "pages-partial": "pagesPartial",
  "tables-partial": "tablesPartial",
});

export const FULL_BUILD_ARTIFACT_KEYS = Object.freeze([
  "pages",
  "chunk-index",
  "sections",
  "tables",
  "registers",
  "bitfields",
  "cautions",
  "sequences",
  "figures",
  "evidence-graph",
]);

const PARTIAL_ARTIFACT_KEYS = Object.freeze(["pages-partial", "tables-partial"]);

function safeBuildId(value = "") {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(normalized)) throw new Error(`Invalid artifact build id: ${value || "<empty>"}`);
  return normalized;
}

function buildIdNow() {
  return `build-${Date.now()}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
}

async function exists(fsOps, filePath) {
  try { await fsOps.stat(filePath); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function createStagedResolver(baseResolver, stageDir, buildId) {
  const stagedPath = (method) => (filename) => {
    const activePath = baseResolver[method](filename);
    return path.join(stageDir, path.basename(activePath));
  };
  const roots = Object.freeze({ ...(baseResolver.roots || {}), indexDir: stageDir });
  return Object.freeze({
    ...baseResolver,
    roots,
    indexDir: () => stageDir,
    chunkIndex: stagedPath("chunkIndex"),
    pages: stagedPath("pages"),
    pagesPartial: stagedPath("pagesPartial"),
    sections: stagedPath("sections"),
    tables: stagedPath("tables"),
    tablesPartial: stagedPath("tablesPartial"),
    registers: stagedPath("registers"),
    bitfields: stagedPath("bitfields"),
    sequences: stagedPath("sequences"),
    cautions: stagedPath("cautions"),
    figures: stagedPath("figures"),
    figureLookup: stagedPath("figureLookup"),
    evidenceGraph: stagedPath("evidenceGraph"),
    manifest: stagedPath("manifest"),
    artifactBuildId: buildId,
    jobRuntimeScope: baseResolver.jobRuntimeScope || baseResolver,
  });
}

export async function createStagedArtifactBuild(filename, options = {}) {
  const resolver = options.resolver || getPathResolver();
  const dependencies = getPathResolverDependencies(resolver);
  const fsOps = options.fs || dependencies.fs || fs;
  const buildId = safeBuildId(options.buildId || buildIdNow());
  requireStrongSourceIdentity(options.source, `Source for staged build ${buildId}`);
  // Calling each active resolver method performs the existing filename and
  // root-containment validation before any staging path is constructed.
  const activePaths = Object.fromEntries(Object.entries(ARTIFACT_METHODS).map(([key, method]) => [key, resolver[method](filename)]));
  const stageDir = path.join(resolver.indexDir(), ".builds", buildId);
  const stagedResolver = createStagedResolver(resolver, stageDir, buildId);
  registerPathResolverDependencies(stagedResolver, { fs: fsOps, clock: dependencies.clock });
  const stagedPaths = Object.fromEntries(Object.entries(ARTIFACT_METHODS).map(([key, method]) => [key, stagedResolver[method](filename)]));
  await fsOps.mkdir(stageDir, { recursive: true });
  return {
    id: buildId,
    filename,
    source: structuredClone(options.source),
    resolver: stagedResolver,
    activeResolver: resolver,
    fs: fsOps,
    stageDir,
    activePaths,
    stagedPaths,
  };
}

export async function seedStagedPagesCache(build, options = {}) {
  const sourceFingerprint = contentSourceFingerprint(build.source);
  const reusable = await withPathResolver(build.activeResolver, () => loadCommittedReusableCoreArtifact(
    build.filename,
    "pages",
    { expectedSourceFingerprint: sourceFingerprint, fs: build.fs },
  ));
  if (!reusable) return false;
  const stagedValue = structuredClone(reusable);
  await options.afterReusableArtifactValidated?.({ artifact: structuredClone(reusable), build });
  await atomicWriteJson(build.stagedPaths.pages, stagedValue, { fs: build.fs });
  return true;
}

function activeArtifactPathsForGraph(build, graph = {}) {
  return Object.fromEntries(Object.keys(graph.artifacts || {}).map((key) => [key, build.activePaths[key] || graph.artifacts[key]]));
}

export async function finalizeStagedGeneration(build, { source } = {}) {
  const finalSource = source || build.source;
  assertSameContentSource(build.source, finalSource, build.filename);
  const graph = JSON.parse(await build.fs.readFile(build.stagedPaths["evidence-graph"], "utf8"));
  graph.artifacts = activeArtifactPathsForGraph(build, graph);
  await atomicWriteJson(build.stagedPaths["evidence-graph"], graph, { fs: build.fs });

  const manifest = JSON.parse(await build.fs.readFile(build.stagedPaths.manifest, "utf8"));
  for (const [key, entry] of Object.entries(manifest.artifacts || {})) {
    if (build.activePaths[key]) entry.path = build.activePaths[key];
  }
  manifest.buildStatus = "ready";
  manifest.generation = {
    buildId: build.id,
    sourceFingerprint: contentSourceFingerprint(finalSource),
    artifactGenerations: Object.fromEntries(
      Object.entries(graph.artifactGenerations || {}).map(([key, generation]) => [key, generation?.generationId || ""]),
    ),
    evidenceGraphGeneration: graph.generation?.generationId || "",
  };
  await atomicWriteJson(build.stagedPaths.manifest, manifest, { fs: build.fs });
  return { graph, manifest };
}

export async function validateCompleteStagedGeneration(build, { source } = {}) {
  const finalSource = source || build.source;
  assertSameContentSource(build.source, finalSource, build.filename);
  const expectedSourceFingerprint = contentSourceFingerprint(finalSource);
  for (const key of [...FULL_BUILD_ARTIFACT_KEYS, "manifest"]) {
    if (!(await exists(build.fs, build.stagedPaths[key]))) throw new Error(`Staged build ${build.id} is missing required artifact ${key}`);
  }

  return withPathResolver(build.resolver, async () => {
    const artifacts = await loadAndValidateCoreArtifactGenerations(build.filename, {
      sourceFingerprint: expectedSourceFingerprint,
      keys: FULL_BUILD_ARTIFACT_KEYS.filter((key) => key !== "evidence-graph"),
      fs: build.fs,
    });
    const graph = JSON.parse(await build.fs.readFile(build.stagedPaths["evidence-graph"], "utf8"));
    if (graph.schemaVersion !== EVIDENCE_GRAPH_SCHEMA_VERSION || graph.filename !== build.filename) throw new Error("Staged evidence graph has an incompatible schema or filename");
    if (graph.sourceFingerprint !== expectedSourceFingerprint) throw new Error("Staged evidence graph has a stale PDF source fingerprint");
    const graphValidation = validateEvidenceGraph(graph);
    if (!graphValidation.ok) throw new Error(`Staged evidence graph validation failed: ${graphValidation.errors.join("; ")}`);
    for (const key of Object.keys(graph.artifactGenerations || {})) {
      if (graph.artifactGenerations[key]?.generationId !== artifacts[key]?.generation?.generationId) {
        throw new Error(`Staged evidence graph has a mismatched ${key} generation dependency`);
      }
    }

    const manifest = JSON.parse(await build.fs.readFile(build.stagedPaths.manifest, "utf8"));
    if (manifest.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION || manifest.filename !== build.filename) throw new Error("Staged artifact manifest has an incompatible schema or filename");
    if (manifest.buildStatus !== "ready" || manifest.health === "fail") throw new Error("Staged artifact manifest is not ready");
    if (manifest.source?.fingerprint !== expectedSourceFingerprint) throw new Error("Staged artifact manifest has a stale PDF source fingerprint");
    if (manifest.generation?.buildId !== build.id || manifest.generation?.sourceFingerprint !== expectedSourceFingerprint) throw new Error("Staged artifact manifest does not describe this build generation");
    if (manifest.generation?.evidenceGraphGeneration !== graph.generation?.generationId) throw new Error("Staged manifest and evidence graph generations are inconsistent");
    for (const key of FULL_BUILD_ARTIFACT_KEYS) {
      const entry = manifest.artifacts?.[key];
      if (!entry?.ok || entry.status !== "ok") throw new Error(`Staged manifest does not mark required artifact ${key} as valid`);
      if (key !== "evidence-graph" && manifest.generation.artifactGenerations?.[key] !== artifacts[key]?.generation?.generationId) {
        throw new Error(`Staged manifest has a mismatched ${key} generation`);
      }
    }
    return { artifacts, graph, manifest };
  });
}

async function snapshotTargets(build, keys) {
  const rollbackDir = path.join(build.stageDir, ".rollback");
  await build.fs.mkdir(rollbackDir, { recursive: true });
  const snapshots = new Map();
  for (const key of keys) {
    const targetPath = build.activePaths[key];
    const present = await exists(build.fs, targetPath);
    const backupPath = path.join(rollbackDir, `${key.replace(/[^A-Za-z0-9.-]+/g, "-")}.backup`);
    if (present) await build.fs.copyFile(targetPath, backupPath);
    snapshots.set(key, { key, targetPath, present, backupPath });
  }
  return snapshots;
}

async function replaceFromFile(build, sourcePath, targetPath, key, options) {
  const incomingPath = `${targetPath}.incoming-${build.id}-${crypto.randomBytes(4).toString("hex")}`;
  await build.fs.copyFile(sourcePath, incomingPath);
  const replace = options.replaceFile || replaceFileAtomic;
  await replace(incomingPath, targetPath, { fs: build.fs, ...(options.replaceOptions || {}) });
  await options.onPublish?.(key, targetPath);
}

async function restoreSnapshot(build, snapshot, options) {
  if (!snapshot.present) {
    await build.fs.rm(snapshot.targetPath, { force: true });
    return;
  }
  await replaceFromFile(build, snapshot.backupPath, snapshot.targetPath, `rollback:${snapshot.key}`, options);
}

export async function promoteStagedGeneration(build, options = {}) {
  const publishKeys = [...FULL_BUILD_ARTIFACT_KEYS];
  const derivedInvalidationKeys = ["figure-lookup"];
  const snapshotKeys = [...publishKeys, ...PARTIAL_ARTIFACT_KEYS, ...derivedInvalidationKeys, "manifest"];
  const snapshots = await snapshotTargets(build, snapshotKeys);
  const previousManifest = snapshots.get("manifest");
  let publicationStarted = false;
  try {
    const readyManifest = JSON.parse(await build.fs.readFile(build.stagedPaths.manifest, "utf8"));
    if (readyManifest.buildStatus !== "ready" || readyManifest.generation?.buildId !== build.id) throw new Error("Refusing to promote a staged generation without its ready commit manifest");
    await options.verifyBeforePublish?.();
    const incompleteManifest = {
      ...readyManifest,
      buildStatus: "incomplete",
      health: "fail",
      notes: [...(readyManifest.notes || []), `generation ${build.id} promotion in progress; readers must retry`],
    };
    await atomicWriteJson(build.activePaths.manifest, incompleteManifest, { fs: build.fs });
    publicationStarted = true;
    await options.onPublish?.("manifest:incomplete", build.activePaths.manifest);

    for (const key of publishKeys) await replaceFromFile(build, build.stagedPaths[key], build.activePaths[key], key, options);
    for (const key of PARTIAL_ARTIFACT_KEYS) {
      await build.fs.rm(build.activePaths[key], { force: true });
      await options.onPublish?.(key, build.activePaths[key]);
    }
    for (const key of derivedInvalidationKeys) {
      await build.fs.rm(build.activePaths[key], { force: true });
      await options.onPublish?.(`${key}:invalidated`, build.activePaths[key]);
    }
    // The source verifier runs after the last active artifact mutation and
    // immediately before the ready commit marker is installed.
    await options.verifyBeforeCommit?.();
    // This is the generation commit point. No active artifact is modified
    // after the ready manifest is atomically installed.
    await replaceFromFile(build, build.stagedPaths.manifest, build.activePaths.manifest, "manifest:ready", options);
    return readyManifest;
  } catch (error) {
    if (!publicationStarted) throw error;
    const rollbackErrors = [];
    for (const key of [...publishKeys, ...PARTIAL_ARTIFACT_KEYS, ...derivedInvalidationKeys].reverse()) {
      try { await restoreSnapshot(build, snapshots.get(key), options); }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    try {
      if (previousManifest.present && rollbackErrors.length === 0) await restoreSnapshot(build, previousManifest, options);
      else {
        await atomicWriteJson(build.activePaths.manifest, {
          schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
          filename: build.filename,
          buildStatus: "promotion_failed",
          health: "fail",
          source: { ...build.source, fingerprint: contentSourceFingerprint(build.source) },
          generation: { buildId: build.id, sourceFingerprint: contentSourceFingerprint(build.source) },
          artifacts: {},
          missingRequired: [...FULL_BUILD_ARTIFACT_KEYS],
          notes: [previousManifest.present
            ? `Staged generation promotion failed and the previous generation could not be fully restored: ${error instanceof Error ? error.message : String(error)}`
            : `Staged generation promotion failed and no previous committed manifest existed: ${error instanceof Error ? error.message : String(error)}`],
        }, { fs: build.fs });
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length) {
      error.rollbackErrors = rollbackErrors;
      error.message = `${error.message}; ${rollbackErrors.length} rollback operation(s) also failed`;
    }
    throw error;
  }
}

export async function discardStagedGeneration(build) {
  await build.fs.rm(build.stageDir, { recursive: true, force: true });
  const buildsDir = path.dirname(build.stageDir);
  try { await build.fs.rmdir(buildsDir); } catch { /* Other builds may still exist. */ }
}
