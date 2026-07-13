import crypto from "node:crypto";
import fs from "node:fs/promises";
import { atomicWriteJson as atomicWriteJsonWithFs } from "../core/atomic-file.js";
import { getPathResolver, getPathResolverDependencies } from "../core/path-resolver.js";
import { ARTIFACT_DEPENDENCIES, ARTIFACT_MANIFEST_SCHEMA_VERSION, contentSourceFingerprint } from "./manifest.js";
import { requireStrongSourceIdentity } from "./source-identity.js";
import {
  BITFIELD_INDEX_SCHEMA_VERSION,
  CAUTION_INDEX_SCHEMA_VERSION,
  FIGURE_INDEX_SCHEMA_VERSION,
  INDEX_SCHEMA_VERSION,
  PAGE_CACHE_SCHEMA_VERSION,
  REGISTER_INDEX_SCHEMA_VERSION,
  SECTION_INDEX_SCHEMA_VERSION,
  SEQUENCE_INDEX_SCHEMA_VERSION,
  SERVER_VERSION,
  TABLE_INDEX_SCHEMA_VERSION,
} from "../core/runtime-constants.js";
import {
  safeBitfieldsIndexPath,
  safeCautionsIndexPath,
  safeFiguresIndexPath,
  safeIndexPath,
  safePagesCachePath,
  safeRegistersIndexPath,
  safeSectionsIndexPath,
  safeSequencesIndexPath,
  safeTablesIndexPath,
} from "../core/runtime-helpers.js";

const GENERATION_FILESYSTEM_ERROR_CODES = new Set(["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE", "ENOSPC", "EROFS"]);

function generationFs(options = {}) {
  const resolver = options.resolver || getPathResolver();
  return options.fs || getPathResolverDependencies(resolver).fs || fs;
}

function generationError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export function createGenerationChangedError(filename, detail = "") {
  return generationError(
    "ARTIFACT_GENERATION_CHANGED",
    `Artifact generation changed while reading ${filename}. Retry after the active index publication completes.${detail ? ` ${detail}` : ""}`,
  );
}

export function isGenerationChangedError(error) {
  return error?.code === "ARTIFACT_GENERATION_CHANGED";
}

export function createGenerationInvalidError(filename, detail, cause = null) {
  return generationError(
    "ARTIFACT_GENERATION_INVALID",
    `Committed artifact generation for ${filename} is invalid. ${detail}`,
    cause,
  );
}

function isGenerationFilesystemError(error) {
  return GENERATION_FILESYSTEM_ERROR_CODES.has(String(error?.code || error?.cause?.code || ""));
}
export const CORE_GENERATION_ARTIFACTS = Object.freeze({
  pages: safePagesCachePath,
  "chunk-index": safeIndexPath,
  sections: safeSectionsIndexPath,
  tables: safeTablesIndexPath,
  registers: safeRegistersIndexPath,
  bitfields: safeBitfieldsIndexPath,
  cautions: safeCautionsIndexPath,
  sequences: safeSequencesIndexPath,
  figures: safeFiguresIndexPath,
});

const CORE_GENERATION_RESOLVER_METHODS = Object.freeze({
  pages: "pages",
  "chunk-index": "chunkIndex",
  sections: "sections",
  tables: "tables",
  registers: "registers",
  bitfields: "bitfields",
  cautions: "cautions",
  sequences: "sequences",
  figures: "figures",
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function contentForFingerprint(value = {}) {
  const copy = structuredClone(value);
  delete copy.generation;
  delete copy.generatedAt;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy;
}

export function artifactSourceFingerprint(value = {}) {
  return contentSourceFingerprint(value.source || value);
}

export function artifactContentFingerprint(value = {}) {
  return digest(contentForFingerprint(value));
}

function dependencyKeys(key) {
  return (ARTIFACT_DEPENDENCIES[key] || []).filter((dependency) => Object.hasOwn(CORE_GENERATION_ARTIFACTS, dependency));
}

function generationFor(key, value, currentSourceFingerprint, dependencies, chunkingVersion) {
  return digest({
    artifact: key,
    sourceFingerprint: currentSourceFingerprint,
    schemaVersion: value.schemaVersion ?? null,
    producerVersion: SERVER_VERSION,
    chunkingVersion: key === "chunk-index" ? Number(value.chunkingVersion || chunkingVersion) : chunkingVersion,
    contentFingerprint: artifactContentFingerprint(value),
    dependencyFingerprints: dependencies,
  });
}

const artifactArrayKeys = Object.freeze({
  pages: "pages",
  "chunk-index": "chunks",
  sections: "sections",
  tables: "tables",
  registers: "registers",
  bitfields: "bitfields",
  cautions: "cautions",
  sequences: "sequences",
  figures: "figures",
});

const expectedSchemaVersions = Object.freeze({
  pages: PAGE_CACHE_SCHEMA_VERSION,
  "chunk-index": INDEX_SCHEMA_VERSION,
  sections: SECTION_INDEX_SCHEMA_VERSION,
  tables: TABLE_INDEX_SCHEMA_VERSION,
  registers: REGISTER_INDEX_SCHEMA_VERSION,
  bitfields: BITFIELD_INDEX_SCHEMA_VERSION,
  cautions: CAUTION_INDEX_SCHEMA_VERSION,
  sequences: SEQUENCE_INDEX_SCHEMA_VERSION,
  figures: FIGURE_INDEX_SCHEMA_VERSION,
});

function validateArtifactShape(key, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Artifact ${key} has an invalid JSON root; rebuild the index.`);
  }
  const arrayKey = artifactArrayKeys[key];
  if (arrayKey && !Array.isArray(value[arrayKey])) {
    throw new Error(`Artifact ${key} is missing its required ${arrayKey} array; rebuild the index.`);
  }
  if (value.schemaVersion !== expectedSchemaVersions[key]) {
    throw new Error(`Artifact ${key} uses schemaVersion=${value.schemaVersion ?? "missing"}; expected ${expectedSchemaVersions[key]}. Rebuild the index.`);
  }
}

export async function loadArtifact(filename, key, options = {}) {
  const pathFor = CORE_GENERATION_ARTIFACTS[key];
  if (!pathFor) throw new Error(`Unsupported generation artifact: ${key}`);
  const resolver = options.resolver || getPathResolver();
  const filePath = resolver[CORE_GENERATION_RESOLVER_METHODS[key]](filename);
  const fsOps = generationFs(options);
  let value;
  try { value = JSON.parse(await fsOps.readFile(filePath, "utf8")); }
  catch (error) {
    const wrapped = new Error(`Required artifact ${key} is unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    if (error?.code) wrapped.code = error.code;
    throw wrapped;
  }
  if (value.filename !== filename) throw new Error(`Artifact ${key} belongs to ${value.filename || "an unknown file"}, not ${filename}.`);
  validateArtifactShape(key, value);
  return { key, filePath, value };
}

export async function stampCoreArtifactGenerations(filename, options = {}) {
  const { source = null, chunkingVersion = 2 } = options;
  const fsOps = generationFs(options);
  const loaded = {};
  for (const key of Object.keys(CORE_GENERATION_ARTIFACTS)) {
    loaded[key] = await loadArtifact(filename, key, { ...options, fs: fsOps });
    if (loaded[key].value.artifactComplete !== true) loaded[key].value = { ...loaded[key].value, artifactComplete: true };
  }
  const currentSource = source || loaded["chunk-index"].value.source || loaded["chunk-index"].value;
  requireStrongSourceIdentity(currentSource, `Source for ${filename}`);
  const currentSourceFingerprint = contentSourceFingerprint(currentSource);
  for (const key of Object.keys(CORE_GENERATION_ARTIFACTS)) {
    const artifactSource = loaded[key].value.source || loaded[key].value;
    requireStrongSourceIdentity(artifactSource, `Artifact ${key}`);
    if (contentSourceFingerprint(artifactSource) !== currentSourceFingerprint) {
      throw new Error(`Artifact ${key} was produced from a different PDF source`);
    }
  }
  for (const key of Object.keys(CORE_GENERATION_ARTIFACTS)) {
    const artifact = loaded[key];
    const dependencies = Object.fromEntries(dependencyKeys(key).map((dependency) => [dependency, loaded[dependency].value.generation?.generationId || ""]));
    const generationId = generationFor(key, artifact.value, currentSourceFingerprint, dependencies, chunkingVersion);
    artifact.value.generation = {
      sourceFingerprint: currentSourceFingerprint,
      generationId,
      producerVersion: SERVER_VERSION,
      serverVersion: SERVER_VERSION,
      schemaVersion: artifact.value.schemaVersion,
      dependencyFingerprints: dependencies,
      chunkingVersion: key === "chunk-index" ? Number(artifact.value.chunkingVersion || chunkingVersion) : chunkingVersion,
    };
    await atomicWriteJsonWithFs(artifact.filePath, artifact.value, { fs: fsOps });
  }
  return Object.fromEntries(Object.entries(loaded).map(([key, artifact]) => [key, artifact.value.generation]));
}

export async function loadAndValidateCoreArtifactGenerations(filename, options = {}) {
  const {
    sourceFingerprint: expectedSourceFingerprint,
    requireChunkingVersion = 2,
    keys = Object.keys(CORE_GENERATION_ARTIFACTS),
  } = options;
  const fsOps = generationFs(options);
  const requested = new Set(keys);
  const dependencyQueue = [...keys];
  while (dependencyQueue.length) {
    const current = dependencyQueue.shift();
    for (const dependency of dependencyKeys(current)) {
      if (requested.has(dependency)) continue;
      requested.add(dependency);
      dependencyQueue.push(dependency);
    }
  }
  const loaded = {};
  for (const key of requested) loaded[key] = await loadArtifact(filename, key, { ...options, fs: fsOps });
  for (const [key, artifact] of Object.entries(loaded)) {
    if (!expectedSourceFingerprint) throw new Error("A current PDF source fingerprint is required to validate index artifacts.");
    requireStrongSourceIdentity(artifact.value.source || artifact.value, `Artifact ${key}`);
    if (!/^size=\d+(?:\.\d+)?;sha256=[a-f0-9]{64}$/i.test(String(expectedSourceFingerprint))) {
      throw new Error("Current PDF source fingerprint has no SHA-256 content hash; strict generation validation requires a rebuild.");
    }
    const actualSource = artifactSourceFingerprint(artifact.value);
    if (actualSource !== expectedSourceFingerprint) throw new Error(`Artifact ${key} has a stale PDF source fingerprint (artifact=${actualSource}; current=${expectedSourceFingerprint}). Rebuild the index before using the evidence graph.`);
    const generation = artifact.value.generation;
    if (artifact.value.artifactComplete !== true) {
      throw new Error(`Artifact ${key} is not marked complete. Rebuild the full index before reading it.`);
    }
    if (!generation?.generationId || generation.sourceFingerprint !== expectedSourceFingerprint) {
      throw new Error(`Artifact ${key} has no compatible generation metadata. This is a pre-EvidenceBundle-v2 index; run index_pdf to rebuild it.`);
    }
    if (generation.schemaVersion !== artifact.value.schemaVersion || generation.serverVersion !== SERVER_VERSION || generation.producerVersion !== SERVER_VERSION) {
      throw new Error(`Artifact ${key} generation metadata is incompatible with server ${SERVER_VERSION}; rebuild the index.`);
    }
    if (key === "chunk-index" && Number(artifact.value.chunkingVersion) !== requireChunkingVersion) {
      throw new Error(`Chunk index uses chunkingVersion=${artifact.value.chunkingVersion || "unknown"}; rebuild with hierarchical chunking version ${requireChunkingVersion}.`);
    }
    if (Number(generation.chunkingVersion) !== requireChunkingVersion) {
      throw new Error(`Artifact ${key} generation uses chunkingVersion=${generation.chunkingVersion || "unknown"}; rebuild all core artifacts with version ${requireChunkingVersion}.`);
    }
    for (const dependency of dependencyKeys(key)) {
      const expected = generation.dependencyFingerprints?.[dependency];
      const actual = loaded[dependency]?.value?.generation?.generationId;
      if (!expected || expected !== actual) {
        throw new Error(`Artifact ${key} was built against a different ${dependency} generation. Rebuild dependent artifacts before using the evidence graph.`);
      }
    }
    const dependencies = Object.fromEntries(dependencyKeys(key).map((dependency) => [dependency, loaded[dependency].value.generation?.generationId || ""]));
    const expectedGenerationId = generationFor(key, artifact.value, expectedSourceFingerprint, dependencies, requireChunkingVersion);
    if (generation.generationId !== expectedGenerationId) {
      throw new Error(`Artifact ${key} content or producer metadata does not match its generation ID. Rebuild the index before using the evidence graph.`);
    }
  }
  return Object.fromEntries(Object.entries(loaded).map(([key, artifact]) => [key, artifact.value]));
}

export async function loadReadyCommittedManifest(filename, options = {}) {
  const fsOps = generationFs(options);
  let manifest;
  try {
    const resolver = options.resolver || getPathResolver();
    manifest = JSON.parse(await fsOps.readFile(resolver.manifest(filename), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && options.allowMissing === true) return null;
    if (isGenerationFilesystemError(error)) throw error;
    throw createGenerationInvalidError(filename, `The ready manifest is unavailable or unreadable: ${error instanceof Error ? error.message : String(error)}`, error);
  }

  if (manifest.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) {
    throw createGenerationInvalidError(filename, `Manifest schemaVersion=${manifest.schemaVersion ?? "missing"}; expected ${ARTIFACT_MANIFEST_SCHEMA_VERSION}.`);
  }
  if (manifest.filename !== filename) {
    throw createGenerationInvalidError(filename, `The ready manifest belongs to ${manifest.filename || "an unknown file"}.`);
  }
  if (manifest.buildStatus !== "ready" || manifest.health === "fail") {
    const error = generationError(
      "ARTIFACT_GENERATION_INCOMPLETE",
      `Artifact generation for ${filename} is ${manifest.buildStatus || "not ready"}; readers must wait for or start a successful full rebuild.`,
    );
    error.manifest = manifest;
    throw error;
  }
  try {
    requireStrongSourceIdentity(manifest.source, `Committed manifest for ${filename}`);
    const sourceFingerprint = contentSourceFingerprint(manifest.source);
    if (manifest.source.fingerprint !== sourceFingerprint) throw new Error("manifest source fingerprint does not match its SHA-256 identity");
    if (!manifest.generation?.buildId) throw new Error("generation buildId is missing");
    if (manifest.generation.sourceFingerprint !== sourceFingerprint) throw new Error("generation source fingerprint does not match the manifest source");
    if (!manifest.generation.artifactGenerations || typeof manifest.generation.artifactGenerations !== "object" || Array.isArray(manifest.generation.artifactGenerations)) {
      throw new Error("artifact generation map is missing");
    }
    if (options.expectedSourceFingerprint && options.expectedSourceFingerprint !== sourceFingerprint) {
      throw new Error(`current PDF source fingerprint differs (manifest=${sourceFingerprint}; current=${options.expectedSourceFingerprint})`);
    }
  } catch (error) {
    throw createGenerationInvalidError(filename, error instanceof Error ? error.message : String(error), error);
  }
  return manifest;
}

async function loadCommittedCoreArtifactAttempt(filename, key, options, attempt) {
  const manifestBefore = await loadReadyCommittedManifest(filename, options);
  if (!manifestBefore) return null;
  await options.onReadStep?.({ step: "manifest-before", attempt, filename, key, manifest: structuredClone(manifestBefore) });

  let artifact = null;
  let validatedArtifacts = null;
  let validationError = null;
  try {
    validatedArtifacts = await loadAndValidateCoreArtifactGenerations(filename, {
      ...options,
      sourceFingerprint: manifestBefore.generation.sourceFingerprint,
      keys: [key],
    });
    artifact = validatedArtifacts[key];
  } catch (error) {
    if (isGenerationFilesystemError(error)) throw error;
    validationError = error;
  }
  await options.onReadStep?.({ step: "artifact", attempt, filename, key, artifact: artifact ? structuredClone(artifact) : null, error: validationError });

  const manifestAfter = await loadReadyCommittedManifest(filename, { ...options, allowMissing: true });
  if (!manifestAfter) throw createGenerationChangedError(filename, "The ready manifest disappeared during the read.");
  await options.onReadStep?.({ step: "manifest-after", attempt, filename, key, manifest: structuredClone(manifestAfter) });
  if (
    manifestAfter.generation.buildId !== manifestBefore.generation.buildId
    || manifestAfter.generation.sourceFingerprint !== manifestBefore.generation.sourceFingerprint
  ) {
    throw createGenerationChangedError(filename, `Observed build ${manifestBefore.generation.buildId}, then ${manifestAfter.generation.buildId}.`);
  }

  const expectedGenerationId = manifestBefore.generation.artifactGenerations?.[key];
  const afterGenerationId = manifestAfter.generation.artifactGenerations?.[key];
  const dependencyMismatch = validatedArtifacts && Object.entries(validatedArtifacts).some(([artifactKey, value]) => {
    const generationId = value.generation?.generationId;
    return !generationId
      || manifestBefore.generation.artifactGenerations?.[artifactKey] !== generationId
      || manifestAfter.generation.artifactGenerations?.[artifactKey] !== generationId;
  });
  if (validationError || dependencyMismatch || !expectedGenerationId || expectedGenerationId !== afterGenerationId || artifact?.generation?.generationId !== expectedGenerationId) {
    const error = createGenerationChangedError(filename, `Artifact ${key} did not remain bound to committed build ${manifestBefore.generation.buildId}.`);
    error.stableMismatchSignature = `${manifestBefore.generation.buildId}:${key}:${expectedGenerationId || "missing"}`;
    error.validationError = validationError;
    throw error;
  }
  return { artifact, manifest: manifestAfter };
}

export async function loadCommittedCoreArtifact(filename, key, options = {}) {
  if (!Object.hasOwn(CORE_GENERATION_ARTIFACTS, key)) throw new Error(`Unsupported generation artifact: ${key}`);
  const maxAttempts = Math.max(1, Math.min(5, Number(options.maxAttempts || 2)));
  let previousStableMismatch = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const snapshot = await loadCommittedCoreArtifactAttempt(filename, key, options, attempt);
      if (!snapshot) return null;
      return options.includeManifest === true ? snapshot : snapshot.artifact;
    } catch (error) {
      if (!isGenerationChangedError(error)) throw error;
      if (error.stableMismatchSignature && error.stableMismatchSignature === previousStableMismatch) {
        throw createGenerationInvalidError(
          filename,
          `Manifest build ${error.stableMismatchSignature.split(":")[0]} does not match artifact ${key}. Run index_pdf to publish a complete generation.`,
          error.validationError || error,
        );
      }
      previousStableMismatch = error.stableMismatchSignature || "";
      if (attempt >= maxAttempts) throw error;
    }
  }
  throw createGenerationChangedError(filename);
}

/** Return a committed core artifact for reuse, or null for ordinary incompatibility. */
export async function loadCommittedReusableCoreArtifact(filename, key, options = {}) {
  const fsOps = generationFs(options);
  const pathFor = CORE_GENERATION_ARTIFACTS[key];
  if (!pathFor) throw new Error(`Unsupported generation artifact: ${key}`);
  const resolver = options.resolver || getPathResolver();
  try {
    await fsOps.access(resolver[CORE_GENERATION_RESOLVER_METHODS[key]](filename));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return await loadCommittedCoreArtifact(filename, key, { ...options, fs: fsOps, allowMissing: true });
  } catch (error) {
    if (isGenerationFilesystemError(error)) throw error;
    if (["ARTIFACT_GENERATION_INCOMPLETE", "ARTIFACT_GENERATION_CHANGED", "ARTIFACT_GENERATION_INVALID"].includes(error?.code)) return null;
    throw error;
  }
}
