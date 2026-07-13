import crypto from "node:crypto";
import fs from "node:fs/promises";
import { ARTIFACT_DEPENDENCIES, contentSourceFingerprint } from "./manifest.js";
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
  atomicWriteJson,
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

async function loadArtifact(filename, key) {
  const pathFor = CORE_GENERATION_ARTIFACTS[key];
  if (!pathFor) throw new Error(`Unsupported generation artifact: ${key}`);
  const filePath = pathFor(filename);
  let value;
  try { value = JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { throw new Error(`Required artifact ${key} is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (value.filename !== filename) throw new Error(`Artifact ${key} belongs to ${value.filename || "an unknown file"}, not ${filename}.`);
  validateArtifactShape(key, value);
  return { key, filePath, value };
}

export async function stampCoreArtifactGenerations(filename, { source = null, chunkingVersion = 2 } = {}) {
  const loaded = {};
  for (const key of Object.keys(CORE_GENERATION_ARTIFACTS)) loaded[key] = await loadArtifact(filename, key);
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
    await atomicWriteJson(artifact.filePath, artifact.value);
  }
  return Object.fromEntries(Object.entries(loaded).map(([key, artifact]) => [key, artifact.value.generation]));
}

export async function loadAndValidateCoreArtifactGenerations(filename, { sourceFingerprint: expectedSourceFingerprint, requireChunkingVersion = 2, keys = Object.keys(CORE_GENERATION_ARTIFACTS) } = {}) {
  const requested = new Set(keys);
  for (const key of keys) for (const dependency of dependencyKeys(key)) requested.add(dependency);
  const loaded = {};
  for (const key of requested) loaded[key] = await loadArtifact(filename, key);
  for (const [key, artifact] of Object.entries(loaded)) {
    if (!expectedSourceFingerprint) throw new Error("A current PDF source fingerprint is required to validate index artifacts.");
    requireStrongSourceIdentity(artifact.value.source || artifact.value, `Artifact ${key}`);
    if (!/^size=\d+(?:\.\d+)?;sha256=[a-f0-9]{64}$/i.test(String(expectedSourceFingerprint))) {
      throw new Error("Current PDF source fingerprint has no SHA-256 content hash; strict generation validation requires a rebuild.");
    }
    const actualSource = artifactSourceFingerprint(artifact.value);
    if (actualSource !== expectedSourceFingerprint) throw new Error(`Artifact ${key} has a stale PDF source fingerprint (artifact=${actualSource}; current=${expectedSourceFingerprint}). Rebuild the index before using the evidence graph.`);
    const generation = artifact.value.generation;
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
