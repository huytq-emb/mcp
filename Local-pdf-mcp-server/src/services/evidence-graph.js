import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { sourceFingerprint } from "../artifacts/manifest.js";
import {
  CORE_GENERATION_ARTIFACTS,
  createGenerationChangedError,
  createGenerationInvalidError,
  loadAndValidateCoreArtifactGenerations,
  loadReadyCommittedManifest,
} from "../artifacts/generation.js";
import { getPathResolver, getPathResolverDependencies } from "../core/path-resolver.js";
import {
  atomicWriteJson,
  canonicalSymbol,
  getPdfSourceInfo,
  pathExists,
  readJsonCached,
  safeBitfieldsIndexPath,
  safeCautionsIndexPath,
  safeEvidenceGraphPath,
  safeFiguresIndexPath,
  safePagesCachePath,
  safeRegistersIndexPath,
  safeSectionsIndexPath,
  safeSequencesIndexPath,
  safeTablesIndexPath,
} from "../core/runtime-helpers.js";
import { EVIDENCE_GRAPH_SCHEMA_VERSION, SERVER_VERSION } from "../core/runtime-constants.js";

const GRAPH_ARTIFACTS = Object.freeze({
  pages: safePagesCachePath,
  "chunk-index": CORE_GENERATION_ARTIFACTS["chunk-index"],
  sections: safeSectionsIndexPath,
  registers: safeRegistersIndexPath,
  bitfields: safeBitfieldsIndexPath,
  sequences: safeSequencesIndexPath,
  cautions: safeCautionsIndexPath,
  tables: safeTablesIndexPath,
  figures: safeFiguresIndexPath,
});
const validatedGraphCache = new Map();

const GRAPH_RESOLVER_METHODS = Object.freeze({
  pages: "pages",
  "chunk-index": "chunkIndex",
  sections: "sections",
  registers: "registers",
  bitfields: "bitfields",
  sequences: "sequences",
  cautions: "cautions",
  tables: "tables",
  figures: "figures",
});

function graphCacheKey(filename, resolver = getPathResolver()) {
  return `${resolver.indexDir()}::${filename}`;
}

async function evidenceGraphCacheSignature(filename, graphPath, currentSourceFingerprint, fsOps = fs, resolver = getPathResolver()) {
  const files = [
    graphPath,
    resolver.manifest(filename),
    ...Object.values(GRAPH_RESOLVER_METHODS).map((method) => resolver[method](filename)),
  ];
  const signatures = await Promise.all(files.map(async (filePath) => {
    try {
      const stat = await fsOps.stat(filePath);
      return `${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${path.resolve(filePath)}:missing`;
    }
  }));
  return `${currentSourceFingerprint}|${signatures.join("|")}`;
}

function stablePart(value, fallback = "unknown") {
  const normalized = canonicalSymbol(value).toLowerCase();
  return normalized || fallback;
}

function stableId(type, ...parts) {
  return `${type}:${parts.map((part) => stablePart(part)).join(":")}`;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function aliasVariants(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const symbol = canonicalSymbol(text);
  return unique([text, text.toLowerCase(), text.toUpperCase(), symbol, symbol.toLowerCase()]);
}

function aliasLookupKeys(value) {
  return unique(aliasVariants(value).map((alias) => String(alias).trim().toLowerCase()).filter(Boolean));
}

function pagesFrom(value) {
  return unique((Array.isArray(value) ? value : [value])
    .map(Number)
    .filter((page) => Number.isFinite(page) && page > 0))
    .sort((a, b) => a - b);
}

function verificationStatus(value, fallback = "candidate") {
  const normalized = String(value || "").toLowerCase().replace(/[ _]+/g, "-");
  if (["verified", "high-confidence", "candidate", "conflicted", "rejected-noise", "visual-verification-required"].includes(normalized)) return normalized;
  if (normalized === "medium" || normalized === "low") return fallback;
  return fallback;
}

function confidence(value, fallback = "medium") {
  if (typeof value === "string" && ["high", "medium", "low"].includes(value.toLowerCase())) return value.toLowerCase();
  const score = Number(value);
  if (Number.isFinite(score)) return score >= 80 ? "high" : score >= 45 ? "medium" : "low";
  return fallback;
}

function locations({ pages = [], chunkIds = [], sectionPath = [], bbox = [], artifact, extractionMethod, verification = "candidate" } = {}) {
  const resolvedPages = pagesFrom(pages);
  const chunkPage = (chunk) => {
    if (Number.isFinite(Number(chunk?.page))) return Number(chunk.page);
    const id = typeof chunk === "string" ? chunk : (chunk?.id || chunk?.chunkId || "");
    const match = String(id).match(/:p(\d+):c\d+(?:$|:)/i);
    return match ? Number(match[1]) : null;
  };
  const normalizedChunks = (chunkIds || []).map((chunk) => ({
    id: typeof chunk === "string" ? chunk : (chunk?.id || chunk?.chunkId || ""),
    page: chunkPage(chunk),
  })).filter((chunk) => typeof chunk.id === "string" && chunk.id.trim());
  const resolvedChunkIds = unique(normalizedChunks.map((chunk) => chunk.id));
  const locationForPage = (page) => ({
    page,
    // A chunk with explicit provenance belongs only to that page. Chunks
    // without page metadata remain attached to every supplied page because
    // their provenance cannot be narrowed further.
    chunkIds: unique(normalizedChunks.filter((chunk) => chunk.page === null || chunk.page === page).map((chunk) => chunk.id)),
    sectionPath: Array.isArray(sectionPath) ? sectionPath.filter(Boolean) : [],
    boundingBox: Array.isArray(bbox) ? bbox : [],
    sourceArtifact: artifact || "",
    extractionMethod: extractionMethod || "artifact-import",
    verificationStatus: verificationStatus(verification),
  });
  return resolvedPages.length ? resolvedPages.map(locationForPage) : [{
    page: null,
    chunkIds: resolvedChunkIds,
    sectionPath: Array.isArray(sectionPath) ? sectionPath.filter(Boolean) : [],
    boundingBox: Array.isArray(bbox) ? bbox : [],
    sourceArtifact: artifact || "",
    extractionMethod: extractionMethod || "artifact-import",
    verificationStatus: verificationStatus(verification),
  }];
}

function entity({ id, type, canonicalName, aliases = [], sourceLocations = [], confidence: entityConfidence = "medium", extractionMethod, verificationStatus: status = "candidate", properties = {} }) {
  const displayName = String(canonicalName || id);
  const symbolEntity = type === "register";
  const normalizedAliases = unique(symbolEntity ? aliases.flatMap(aliasVariants) : aliases.map(String)).filter((alias) => alias !== displayName);
  return {
    id,
    type,
    canonicalName: displayName,
    displayName,
    aliases: normalizedAliases,
    aliasVariants: symbolEntity ? unique([displayName, ...normalizedAliases].flatMap(aliasVariants)) : unique([displayName, ...normalizedAliases]),
    sourceLocations,
    confidence: confidence(entityConfidence),
    extractionMethod: extractionMethod || "artifact-import",
    verificationStatus: verificationStatus(status),
    properties,
  };
}

const relationshipIdsByArray = new WeakMap();

function digestGeneration(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function addRelationship(relationships, from, to, type, properties = {}) {
  if (!from || !to) return;
  const id = `${type}:${from}->${to}`;
  let ids = relationshipIdsByArray.get(relationships);
  if (!ids) {
    ids = new Set();
    relationshipIdsByArray.set(relationships, ids);
  }
  if (ids.has(id)) return;
  ids.add(id);
  relationships.push({ id, from, to, type, properties });
}

function addConflict(conflicts, entityId, field, values, pages, reason) {
  const normalized = unique(values.map((value) => String(value || "").trim()).filter(Boolean));
  if (normalized.length < 2) return;
  conflicts.push({
    id: `conflict:${entityId}:${field}`,
    entityId,
    field,
    values: normalized,
    pages: pagesFrom(pages),
    reason,
    verificationStatus: "conflicted",
    recommendedVerification: pagesFrom(pages).map((page) => `read_pdf_pages(filename=..., start_page=${page}, end_page=${page})`),
  });
}

function sectionForPage(sections, page) {
  const candidates = (sections || []).filter((section) => Number(section.page) <= Number(page));
  return candidates.sort((left, right) => Number(right.page) - Number(left.page))[0] || null;
}

function normalizedPhrase(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function sequenceTopicConcepts(topic) {
  return normalizedPhrase(topic).split(" ").filter((term) => term.length >= 3).map((term) => [term]);
}

function sequenceEvidenceMatchesTopic(sequence) {
  const topic = normalizedPhrase(sequence.topic || sequence.title);
  if (!topic) return true;
  const evidence = normalizedPhrase([
    ...(sequence.chunks || []).flatMap((chunk) => [chunk.preview, ...(chunk.headings || []), ...(chunk.evidenceLines || [])]),
    ...(sequence.steps || []).map((step) => step.text || step.action || ""),
  ].join(" "));
  return evidence.includes(topic);
}

function extractGenericOrderedWriteSteps(chunks) {
  const steps = [];
  const valuePattern = "(?:0x[0-9a-f]+|[0-9a-f]+h|\\d+)";
  for (const chunk of chunks || []) {
    const lines = String(chunk.text || "").split("\n").map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const numbered = line.match(/^\s*(?:step\s*)?(\d+)[.):]\s*(.+)$/i);
      const connective = line.match(/^\s*(first|then|next|after|before|finally)[,:]?\s*(.+)$/i);
      const text = numbered?.[2] || connective?.[2] || line;
      const register = text.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0] || "";
      const values = [...text.matchAll(new RegExp(valuePattern, "gi"))].map((match) => match[0]);
      const isWrite = /\b(write|written|program|set|clear)\b/i.test(text);
      if (!isWrite || (!numbered && !connective && !/\b(?:first|then|after|before|->|→)\b/i.test(text))) continue;
      for (const value of values.slice(0, 2)) {
        steps.push({ id: `recovered-${steps.length + 1}`, action: text, text, register, value, page: Number(chunk.page) || null, chunkId: chunk.id || "", confidence: "low", explicitOrder: Boolean(numbered || connective) });
      }
    }
  }
  return steps;
}

function recoverSequenceFromSections(sequence, sections) {
  if (sequenceEvidenceMatchesTopic(sequence)) return null;
  const concepts = sequenceTopicConcepts(sequence.topic || sequence.title);
  if (!concepts.length) return null;
  const candidates = (sections || []).map((section) => {
    const sourceText = [section.title, section.text, section.preview, ...(section.evidenceLines || [])].filter(Boolean).join(" ");
    const text = normalizedPhrase(sourceText);
    if (!concepts.every((alternatives) => alternatives.some((term) => text.includes(term)))) return null;
    let score = Number(section.confidence || 0);
    if (/\b(operation|procedure|sequence)\b/.test(text)) score += 35;
    if (/\b(write|writing|written|order|then|first|after|before|next|step)\b/.test(text)) score += 30;
    if (/\b(?:0x[0-9a-f]+|[0-9a-f]+h|\d+)\b/i.test(sourceText)) score += 15;
    return { section, score };
  }).filter((item) => item && item.score >= 35);
  if (!candidates.length) return null;
  const pageScores = new Map();
  for (const candidate of candidates) pageScores.set(Number(candidate.section.page), (pageScores.get(Number(candidate.section.page)) || 0) + candidate.score);
  const rankedPages = [...pageScores].sort((left, right) => right[1] - left[1] || left[0] - right[0]).map(([page]) => page);
  const primaryPage = rankedPages[0];
  const pages = rankedPages.filter((page) => page === primaryPage || Math.abs(page - primaryPage) <= 1).slice(0, 4);
  const genericChunks = (sections || []).filter((section) => pages.includes(Number(section.page))).map((section) => ({
    id: section.id ? `section:${section.id}` : `section:p${section.page}`,
    page: section.page,
    text: [section.title, section.text, section.preview, ...(section.evidenceLines || [])].filter(Boolean).join("\n"),
    registers: section.registers || [],
  }));
  const genericSteps = extractGenericOrderedWriteSteps(genericChunks);
  // Prefer the shared, generic parser. Legacy heading-only hints are retained
  // as candidates only when no reliable ordered write was extracted.
  return { pages, primaryPage, candidates, steps: genericSteps.length ? genericSteps : [], recoveryStatus: genericSteps.length ? "candidate-ordered-write-extraction" : "candidate-needs-verification" };
}

function addRegisterLookup(lookup, registerEntity) {
  const names = unique([
    registerEntity.canonicalName,
    registerEntity.displayName,
    ...(registerEntity.aliases || []),
    ...(registerEntity.aliasVariants || []),
  ]);
  for (const name of names) {
    for (const key of aliasLookupKeys(name)) {
      const ids = lookup.get(key) || new Set();
      ids.add(registerEntity.id);
      lookup.set(key, ids);
    }
  }
}

function trustedRegisterAliases(register, canonicalName) {
  const canonical = canonicalSymbol(canonicalName);
  const parts = String(canonicalName || "").split("_").filter(Boolean);
  const canonicalFamily = canonicalSymbol(parts[0] || "").replace(/M$/, "");
  const knownGeneratedFamilies = new Set(["DMAC", "ETH", "GBETH", "GMAC", "GPT", "ICU", "PFC", "POEG", "USB2", "USB3", "WDT"]);
  const genericSuffixes = new Set(["BASE", "CTRL", "CONTROL", "GLOBAL", "REGISTER", "STATUS"]);
  const suffixes = new Set();
  for (let index = 1; index < parts.length; index += 1) {
    const suffix = canonicalSymbol(parts.slice(index).join("_"));
    if (suffix.length >= 3 && !genericSuffixes.has(suffix)) suffixes.add(suffix);
  }
  const candidates = unique([register.displayName, ...(register.aliases || []), ...suffixes]);
  return candidates.filter((alias) => {
    const normalized = canonicalSymbol(alias);
    if (!normalized) return false;
    const aliasParts = String(alias).split("_").filter(Boolean);
    const aliasFamily = canonicalSymbol(aliasParts[0] || "").replace(/M$/, "");
    if (aliasParts.length > 1 && knownGeneratedFamilies.has(aliasFamily) && aliasFamily !== canonicalFamily) return false;
    return true;
  });
}

function registerChunkSourceScore(chunk, canonicalName) {
  const rawScore = Number(chunk?.score || 0);
  const preview = String(chunk?.preview || "");
  const headings = (chunk?.headings || []).join("\n");
  const text = `${headings}\n${preview}`;
  let score = rawScore;
  if (canonicalSymbol(text).includes(canonicalSymbol(canonicalName))) score += 25;
  if (/\bAccess Size\b/i.test(text)) score += 55;
  if (/\b(?:Initial|Reset) Value\b/i.test(text)) score += 55;
  if (/\b(?:Offset )?Address\b/i.test(text)) score += 55;
  if (/\.{12,}\s*\d+/m.test(preview)) score -= 100;
  if (/\bheader area\b/i.test(headings) && !/\bAccess Size\b/i.test(preview)) score -= 50;
  return score;
}

function resolveRegisterReference({
  filename,
  registerName,
  sourceId,
  relationshipType,
  direction,
  pages,
  registerLookup,
  entities,
  relationships,
  conflicts,
}) {
  const keys = aliasLookupKeys(registerName);
  const candidateIds = unique(keys.flatMap((key) => [...(registerLookup.get(key) || [])]));
  const addResolvedRelationship = (registerId, resolutionStatus) => {
    const from = direction === "register-to-source" ? registerId : sourceId;
    const to = direction === "register-to-source" ? sourceId : registerId;
    addRelationship(relationships, from, to, relationshipType, {
      registerReference: String(registerName || ""),
      resolutionStatus,
      resolutionKeys: keys,
    });
  };
  if (candidateIds.length === 1) {
    addResolvedRelationship(candidateIds[0], "resolved");
    return { status: "resolved", candidateIds };
  }
  if (candidateIds.length > 1) {
    for (const candidateId of candidateIds) addResolvedRelationship(candidateId, "conflicted");
    const candidateNames = candidateIds.map((candidateId) => entities.find((entry) => entry.id === candidateId)?.canonicalName || candidateId);
    conflicts.push({
      id: `conflict:${sourceId}:register-reference:${stablePart(registerName)}`,
      entityId: sourceId,
      field: "registerReference",
      alias: String(registerName || ""),
      values: unique(candidateNames),
      pages: pagesFrom(pages),
      reason: `Register reference \"${registerName}\" resolves to multiple canonical registers.`,
      verificationStatus: "conflicted",
      recommendedVerification: pagesFrom(pages).map((page) => `read_pdf_pages(filename=..., start_page=${page}, end_page=${page})`),
    });
    return { status: "conflicted", candidateIds };
  }

  const sourceEntity = entities.find((entry) => entry.id === sourceId);
  if (sourceEntity) {
    sourceEntity.verificationStatus = "conflicted";
    sourceEntity.properties = {
      ...sourceEntity.properties,
      registerResolutionStatus: "unresolved",
      unresolvedRegisterReference: String(registerName || "unknown"),
      unresolvedRelationshipType: relationshipType,
      recommendedVerificationPages: pagesFrom(pages),
    };
  }
  return { status: "unresolved", candidateIds: [] };
}

function addAliasConflicts(entities, relationships, conflicts) {
  const aliases = new Map();
  for (const entry of entities) {
    if (entry.type !== "register") continue;
    for (const key of unique([entry.canonicalName, entry.displayName, ...(entry.aliases || []), ...(entry.aliasVariants || [])].flatMap(aliasLookupKeys))) {
      const entries = aliases.get(key) || [];
      entries.push(entry);
      aliases.set(key, entries);
    }
  }
  for (const [alias, entries] of aliases) {
    const distinct = unique(entries.map((entry) => entry.id));
    if (distinct.length < 2) continue;
    const values = entries.map((entry) => `${entry.type}:${entry.canonicalName}`);
    const pages = entries.flatMap((entry) => entry.sourceLocations || []).map((location) => location.page);
    const candidateEntityIds = unique(entries.map((entry) => entry.id));
    // Alias ambiguity is metadata about this lookup key, not a defect in the
    // canonical records. Relationships created through this alias are already
    // marked conflicted by resolveRegisterReference; canonical-ID links stay
    // valid and retain their original resolution status.
    conflicts.push({
      id: `alias-conflict:${alias}`,
      entityId: `alias-conflict:${alias}`,
      field: "alias",
      alias,
      candidateEntityIds,
      values: unique(values),
      pages: pagesFrom(pages),
      reason: `Alias \"${alias}\" resolves to multiple entities; use a canonical entity ID or qualified alias.`,
      verificationStatus: "conflicted",
      recommendedVerification: ["query_manual with a canonical register/module qualifier", "get_manual_entity with the canonical entity_id"],
    });
  }
}

function buildEntityReverseMaps(chunks, entities) {
  const entityChunkIds = {};
  const chunkEntityIds = {};
  const pageEntityIds = {};
  const symbolEntityIds = {};
  for (const entry of entities) {
    const ids = unique((entry.sourceLocations || []).flatMap((location) => location.chunkIds || []));
    if (ids.length) entityChunkIds[entry.id] = ids;
    for (const chunkId of ids) chunkEntityIds[chunkId] = unique([...(chunkEntityIds[chunkId] || []), entry.id]);
    for (const page of pagesFrom((entry.sourceLocations || []).map((location) => location.page))) {
      pageEntityIds[page] = unique([...(pageEntityIds[page] || []), entry.id]);
    }
    if (["register", "bitfield"].includes(entry.type)) {
      for (const key of unique([entry.canonicalName, entry.displayName, ...(entry.aliases || []), ...(entry.aliasVariants || [])].flatMap(aliasLookupKeys))) {
        if (!/^[a-z0-9_]{2,64}$/.test(key)) continue;
        symbolEntityIds[key] = unique([...(symbolEntityIds[key] || []), entry.id]);
      }
    }
  }
  return { chunkEntityIds, entityChunkIds, pageEntityIds, symbolEntityIds };
}

export function validateEvidenceGraph(graph = {}) {
  const errors = [];
  if (graph.schemaVersion !== EVIDENCE_GRAPH_SCHEMA_VERSION) errors.push(`schemaVersion must be ${EVIDENCE_GRAPH_SCHEMA_VERSION}`);
  if (!String(graph.filename || "").endsWith(".pdf")) errors.push("filename must be a PDF filename");
  if (!String(graph.sourceFingerprint || "")) errors.push("sourceFingerprint is required");
  if (!graph.generation?.generationId || graph.generation.sourceFingerprint !== graph.sourceFingerprint) errors.push("generation metadata is required and must match sourceFingerprint");
  if (!graph.artifactGenerations || typeof graph.artifactGenerations !== "object") errors.push("artifactGenerations is required");
  if (!graph.chunkEntityIds || typeof graph.chunkEntityIds !== "object" || !graph.entityChunkIds || typeof graph.entityChunkIds !== "object" || !graph.pageEntityIds || typeof graph.pageEntityIds !== "object" || !graph.symbolEntityIds || typeof graph.symbolEntityIds !== "object") errors.push("chunk/page/symbol entity reverse maps are required");
  if (!Array.isArray(graph.entities)) errors.push("entities must be an array");
  if (!Array.isArray(graph.relationships)) errors.push("relationships must be an array");
  if (!Array.isArray(graph.conflicts)) errors.push("conflicts must be an array");
  const ids = new Set();
  for (const entry of graph.entities || []) {
    if (!entry.id || !entry.type || !entry.canonicalName) errors.push("entity id, type, and canonicalName are required");
    if (ids.has(entry.id)) errors.push(`duplicate entity id: ${entry.id}`);
    ids.add(entry.id);
    if (!Array.isArray(entry.aliases) || !Array.isArray(entry.sourceLocations)) errors.push(`entity ${entry.id} has invalid aliases/sourceLocations`);
  }
  for (const relation of graph.relationships || []) {
    if (!ids.has(relation.from) || !ids.has(relation.to)) errors.push(`relationship ${relation.id || relation.type} has unknown endpoint`);
  }
  return { ok: errors.length === 0, errors };
}

export async function buildEvidenceGraph(filename) {
  const resolver = getPathResolver();
  validatedGraphCache.delete(graphCacheKey(filename, resolver));
  const source = await getPdfSourceInfo(filename, { includeHash: true });
  const currentSourceFingerprint = sourceFingerprint(source);
  const artifactValues = await loadAndValidateCoreArtifactGenerations(filename, {
    sourceFingerprint: currentSourceFingerprint,
    keys: Object.keys(GRAPH_ARTIFACTS),
  });
  const loaded = Object.fromEntries(Object.keys(GRAPH_ARTIFACTS).map((key) => [key, {
    path: CORE_GENERATION_ARTIFACTS[key](filename),
    data: artifactValues[key],
  }]));

  const sections = loaded.sections.data?.sections || [];
  const registers = loaded.registers.data?.registers || [];
  const bitfields = loaded.bitfields.data?.bitfields || [];
  const sequences = loaded.sequences.data?.sequences || [];
  const cautions = loaded.cautions.data?.cautions || [];
  const tables = loaded.tables.data?.tables || [];
  const figures = loaded.figures.data?.figures || [];
  const entities = [];
  const relationships = [];
  const conflicts = [];
  const documentId = stableId("document", filename);

  entities.push(entity({
    id: documentId,
    type: "document",
    canonicalName: filename,
    sourceLocations: locations({ artifact: "pdf", extractionMethod: "source-document", verification: "verified" }),
    confidence: "high",
    extractionMethod: "source-document",
    verificationStatus: "verified",
    properties: { pageCount: Number(loaded["chunk-index"].data.pageCount || 0), sourceFingerprint: currentSourceFingerprint },
  }));

  const pageIds = new Map();
  const pageCount = Number(loaded["chunk-index"].data.pageCount || 0);
  for (let page = 1; page <= pageCount; page += 1) {
    const id = stableId("page", filename, page);
    pageIds.set(page, id);
    entities.push(entity({
      id,
      type: "page",
      canonicalName: `page ${page}`,
      sourceLocations: locations({ pages: [page], artifact: loaded.pages.path, extractionMethod: "pages-cache", verification: "verified" }),
      confidence: "high",
      extractionMethod: "pages-cache",
      verificationStatus: "verified",
    }));
    addRelationship(relationships, documentId, id, "document-has-page");
  }

  const sectionIds = new Map();
  for (const section of sections) {
    const id = stableId("section", filename, section.id || `${section.page}-${section.title}`);
    sectionIds.set(section.id || `${section.page}-${section.title}`, id);
    entities.push(entity({
      id,
      type: "section",
      canonicalName: section.title || section.heading || "untitled section",
      aliases: section.aliases || [],
      sourceLocations: locations({ pages: [section.page], chunkIds: section.chunkIds || section.chunks || [], sectionPath: section.path || section.headings || [], artifact: loaded.sections.path, extractionMethod: "section-index", verification: section.confidence || "candidate" }),
      confidence: section.confidence || "medium",
      extractionMethod: "section-index",
      verificationStatus: section.verificationStatus || "candidate",
      properties: { level: section.level ?? null, number: section.number || "" },
    }));
    addRelationship(relationships, documentId, id, "document-has-section");
    if (pageIds.has(Number(section.page))) addRelationship(relationships, id, pageIds.get(Number(section.page)), "entity-is-mentioned-on-page");
  }

  const registerLookup = new Map();
  for (const register of registers) {
    const canonicalName = register.canonicalName || register.name || register.displayName;
    if (!canonicalName) continue;
    const id = stableId("register", filename, canonicalName);
    const trustedAliases = trustedRegisterAliases(register, canonicalName);
    const pages = pagesFrom(register.pages);
    const section = sectionForPage(sections, pages[0]);
    const registerChunkGroups = new Map();
    for (const chunk of register.chunks || []) {
      const chunkId = chunk?.id || chunk;
      const chunkPage = Number(chunk?.page || String(chunkId || "").match(/:p(\d+):/)?.[1]);
      if (!Number.isFinite(chunkPage) || !chunkId) continue;
      const group = registerChunkGroups.get(chunkPage) || { ids: [], score: 0 };
      group.ids.push(chunkId);
      group.score = Math.max(group.score, registerChunkSourceScore(chunk, canonicalName));
      registerChunkGroups.set(chunkPage, group);
    }
    const registerLocations = registerChunkGroups.size
      ? [...registerChunkGroups.entries()].flatMap(([page, group]) => locations({ pages: [page], chunkIds: group.ids, sectionPath: section ? [section.title] : [], artifact: loaded.registers.path, extractionMethod: register.sourceKinds?.join(",") || "register-index", verification: register.verificationStatus || "candidate" }).map((location) => ({ ...location, sourceScore: group.score })))
      : locations({ pages, sectionPath: section ? [section.title] : [], artifact: loaded.registers.path, extractionMethod: register.sourceKinds?.join(",") || "register-index", verification: register.verificationStatus || "candidate" });
    const registerEntity = entity({
      id,
      type: "register",
      canonicalName,
      aliases: trustedAliases,
      sourceLocations: registerLocations,
      confidence: register.confidence,
      extractionMethod: register.sourceKinds?.join(",") || "register-index",
      verificationStatus: register.verificationStatus || "candidate",
      properties: {
        offsets: unique(register.offsetAddresses || register.offsets || []),
        resetValues: unique(register.initialValues || register.resetValues || []),
        accessSizes: unique(register.accessSizes || []),
        descriptions: unique(register.descriptions || []),
      },
    });
    const existingAliasIds = unique(aliasLookupKeys(canonicalName).flatMap((key) => [...(registerLookup.get(key) || [])]));
    const existingAliasEntity = existingAliasIds.length === 1 ? entities.find((entry) => entry.id === existingAliasIds[0]) : null;
    const currentHasConcreteAddress = registerEntity.properties.offsets.some((value) => value && value !== "unknown")
      || registerEntity.properties.accessSizes.some((value) => value && value !== "unknown");
    const existingHasConcreteAddress = existingAliasEntity?.properties?.offsets?.some((value) => value && value !== "unknown")
      || existingAliasEntity?.properties?.accessSizes?.some((value) => value && value !== "unknown");
    const existingOwnsAlias = existingAliasEntity?.aliases?.some((alias) => canonicalSymbol(alias) === canonicalSymbol(canonicalName));
    if (existingAliasEntity && existingOwnsAlias && !currentHasConcreteAddress && existingHasConcreteAddress) {
      const locationKeys = new Set(existingAliasEntity.sourceLocations.map((location) => JSON.stringify(location)));
      for (const location of registerLocations) {
        const mergedLocation = { ...location, sourceScore: Math.min(Number(location.sourceScore || 0), 50), resolutionStatus: "merged-sparse-alias" };
        const key = JSON.stringify(mergedLocation);
        if (!locationKeys.has(key)) {
          existingAliasEntity.sourceLocations.push(mergedLocation);
          locationKeys.add(key);
        }
      }
      existingAliasEntity.aliases = unique([...existingAliasEntity.aliases, canonicalName, ...trustedAliases]);
      existingAliasEntity.aliasVariants = unique([...existingAliasEntity.aliasVariants, ...aliasVariants(canonicalName), ...trustedAliases.flatMap(aliasVariants)]);
      for (const page of pages) if (pageIds.has(page)) addRelationship(relationships, existingAliasEntity.id, pageIds.get(page), "entity-is-mentioned-on-page");
      continue;
    }
    entities.push(registerEntity);
    addRegisterLookup(registerLookup, registerEntity);
    addConflict(conflicts, id, "offset", register.offsetAddresses || register.offsets || [], pages, "Multiple offsets were extracted for the same register.");
    addConflict(conflicts, id, "reset", register.initialValues || register.resetValues || [], pages, "Multiple reset values were extracted for the same register.");
    addConflict(conflicts, id, "accessSize", register.accessSizes || [], pages, "Multiple access sizes were extracted for the same register.");
    addRelationship(relationships, documentId, id, "document-has-register");
    for (const page of pages) if (pageIds.has(page)) addRelationship(relationships, id, pageIds.get(page), "entity-is-mentioned-on-page");
    if (section) addRelationship(relationships, id, sectionIds.get(section.id || `${section.page}-${section.title}`), "register-is-defined-in-section");
  }

  const bitfieldIds = new Map();
  for (const bitfield of bitfields) {
    const registerName = bitfield.canonicalRegister || bitfield.register || bitfield.sourceRegister || "unresolved";
    const canonicalName = bitfield.canonicalBitfield || bitfield.bitfield || bitfield.name;
    if (!canonicalName) continue;
    const id = stableId("bitfield", filename, registerName, canonicalName);
    bitfieldIds.set(`${stablePart(registerName)}:${stablePart(canonicalName)}`, id);
    const pages = pagesFrom(bitfield.pages || bitfield.page);
    entities.push(entity({
      id,
      type: "bitfield",
      canonicalName,
      aliases: bitfield.aliases || [],
      sourceLocations: locations({ pages, chunkIds: bitfield.chunkIds || bitfield.chunks || [], artifact: loaded.bitfields.path, extractionMethod: bitfield.source || "bitfield-index", verification: bitfield.mappingStatus === "unresolved" ? "conflicted" : (bitfield.verificationStatus || "candidate") }),
      confidence: bitfield.confidence,
      extractionMethod: bitfield.source || "bitfield-index",
      verificationStatus: bitfield.mappingStatus === "unresolved" ? "conflicted" : (bitfield.verificationStatus || "candidate"),
      properties: { register: registerName, bitRange: bitfield.bitRange || bitfield.bitPositionRange || "", fieldBitRange: bitfield.fieldBitRange || "", access: bitfield.access || "", reset: bitfield.reset || bitfield.initialValue || "" },
    }));
    resolveRegisterReference({ filename, registerName, sourceId: id, relationshipType: "register-has-bitfield", direction: "register-to-source", pages, registerLookup, entities, relationships, conflicts });
    for (const page of pages) if (pageIds.has(page)) addRelationship(relationships, id, pageIds.get(page), "entity-is-mentioned-on-page");
  }

  for (const sequence of sequences) {
    const id = stableId("sequence", filename, sequence.id || sequence.topic || sequence.title);
    const recovered = recoverSequenceFromSections(sequence, sections);
    const pages = recovered ? pagesFrom([recovered.primaryPage, ...recovered.pages]) : pagesFrom(sequence.pages || sequence.page);
    const sequenceChunks = recovered ? [] : (sequence.chunks || []);
    const sequenceLocations = locations({ pages, chunkIds: sequenceChunks.map((chunk) => chunk.id || chunk), artifact: recovered ? loaded.sections.path : loaded.sequences.path, extractionMethod: recovered ? "section-sequence-recovery" : (sequence.source || "sequence-index"), verification: sequence.verificationStatus || "candidate" })
      .map((location) => recovered ? { ...location, sourceScore: Number(location.page) === recovered.primaryPage ? 100 : 0 } : location);
    const sequenceEntity = entity({
      id,
      type: "sequence",
      canonicalName: sequence.topic || sequence.title || id,
      aliases: sequence.aliases || [],
      sourceLocations: sequenceLocations,
      confidence: sequence.confidence || sequence.score,
      extractionMethod: recovered ? "section-sequence-recovery" : (sequence.source || "sequence-index"),
      verificationStatus: sequence.verificationStatus || "candidate",
      properties: { kind: sequence.kind || "generic", ...(recovered ? { recoveryStatus: recovered.recoveryStatus, sourceSectionIds: recovered.candidates.map((candidate) => candidate.section.id) } : {}) },
    });
    entities.push(sequenceEntity);
    addRelationship(relationships, documentId, id, "document-has-sequence");
    for (const page of pages) if (pageIds.has(page)) addRelationship(relationships, id, pageIds.get(page), "entity-is-mentioned-on-page");
    const steps = recovered?.steps?.length ? recovered.steps : (sequence.steps || sequence.sequenceSteps || []);
    const structuredSteps = [];
    let previousStep = null;
    for (const [index, step] of steps.entries()) {
      const stepId = stableId("sequence-step", filename, id, step.id || index + 1);
      const registerName = step.register || step.registerName || "";
      const stepEntity = entity({
        id: stepId,
        type: "sequence-step",
        canonicalName: step.action || step.text || `step ${index + 1}`,
        sourceLocations: locations({ pages: pagesFrom(step.page || pages), chunkIds: [step.chunkId], artifact: recovered ? loaded.sections.path : loaded.sequences.path, extractionMethod: recovered ? "section-sequence-recovery" : "sequence-index", verification: sequence.verificationStatus || "candidate" }),
        confidence: step.confidence || sequence.confidence || sequence.score,
        extractionMethod: recovered ? "section-sequence-recovery" : "sequence-index",
        verificationStatus: sequence.verificationStatus || "candidate",
        properties: { order: index + 1, register: registerName, bitfield: step.bitfield || "", value: step.value ?? null, condition: step.condition || "" },
      });
      entities.push(stepEntity);
      addRelationship(relationships, id, stepId, "sequence-has-step");
      if (previousStep) addRelationship(relationships, previousStep, stepId, "sequence-step-occurs-before");
      previousStep = stepId;
      if (registerName) {
        const resolution = resolveRegisterReference({ filename, registerName, sourceId: stepId, relationshipType: "sequence-uses-register", direction: "source-to-register", pages: pagesFrom(step.page || pages), registerLookup, entities, relationships, conflicts });
        if (resolution.status === "resolved") {
          const registerEntity = entities.find((entry) => entry.id === resolution.candidateIds[0]);
          if (registerEntity) stepEntity.properties.register = registerEntity.displayName || registerEntity.canonicalName;
        }
      }
      structuredSteps.push({ ...stepEntity.properties, summary: [stepEntity.properties.register, stepEntity.properties.bitfield, stepEntity.properties.value].filter((value) => value !== null && value !== "").join(" ") });
    }
    sequenceEntity.properties.steps = structuredSteps;
    sequenceEntity.properties.stepSummaries = structuredSteps.map((step) => step.summary);
  }

  for (const caution of cautions) {
    const id = stableId("caution", filename, caution.id || `${caution.type}-${caution.topic}`);
    const pages = pagesFrom(caution.pages || caution.page);
    entities.push(entity({
      id,
      type: "caution",
      canonicalName: caution.topic || caution.type || id,
      aliases: [caution.type].filter(Boolean),
      sourceLocations: locations({ pages, chunkIds: (caution.chunks || []).map((chunk) => chunk.id || chunk), artifact: loaded.cautions.path, extractionMethod: caution.source || "caution-index", verification: caution.verificationStatus || "candidate" }),
      confidence: caution.confidence || caution.score,
      extractionMethod: caution.source || "caution-index",
      verificationStatus: caution.verificationStatus || "candidate",
      properties: { type: caution.type || "general", riskForDriver: caution.riskForDriver || "", evidenceLines: caution.evidenceLines || [] },
    }));
    addRelationship(relationships, documentId, id, "document-has-caution");
    for (const registerName of caution.relatedRegisters || []) {
      resolveRegisterReference({ filename, registerName, sourceId: id, relationshipType: "register-has-caution", direction: "register-to-source", pages, registerLookup, entities, relationships, conflicts });
    }
    for (const page of pages) if (pageIds.has(page)) addRelationship(relationships, id, pageIds.get(page), "entity-is-mentioned-on-page");
  }

  for (const table of tables) {
    const id = stableId("table", filename, table.id || table.tableId || `${table.pageStart || table.page}-${table.caption || table.kind}`);
    const pages = pagesFrom([table.pageStart, table.pageEnd, table.page]);
    entities.push(entity({
      id,
      type: "table",
      canonicalName: table.caption || table.title || table.kind || id,
      aliases: [table.number, table.tableNumber].filter(Boolean),
      sourceLocations: locations({ pages, artifact: loaded.tables.path, extractionMethod: table.source || "layout-table-index", verification: table.verificationStatus || "candidate" }),
      confidence: table.confidence || "medium",
      extractionMethod: table.source || "layout-table-index",
      verificationStatus: table.verificationStatus || "candidate",
      properties: { kind: table.kind || "unknown", columnRoles: table.layout?.columnRoles || [] },
    }));
    for (const registerName of table.relatedRegisters || table.registers || []) {
      resolveRegisterReference({ filename, registerName, sourceId: id, relationshipType: "table-describes-register", direction: "source-to-register", pages, registerLookup, entities, relationships, conflicts });
    }
  }

  for (const figure of figures) {
    const id = stableId("figure", filename, figure.figure_id || figure.id || `${figure.page}-${figure.caption}`);
    const page = Number(figure.page || 0);
    entities.push(entity({
      id,
      type: "figure",
      canonicalName: figure.caption || figure.title || figure.figure_id || id,
      aliases: [figure.figure_id, figure.id, ...(figure.aliases || [])].filter(Boolean),
      sourceLocations: locations({ pages: [page], bbox: figure.bbox || [], artifact: loaded.figures.path, extractionMethod: figure.source || "figure-caption-index", verification: "visual-verification-required" }),
      confidence: figure.confidence || "medium",
      extractionMethod: figure.source || "figure-caption-index",
      verificationStatus: "visual-verification-required",
      properties: { kind: figure.kind || "figure", figureId: figure.figure_id || figure.id || id, imagePath: figure.image_path || "", visualSemanticsRequireImage: true },
    }));
    for (const sequenceName of figure.related_sequences || []) {
      const sequenceEntry = entities.find((candidate) => candidate.type === "sequence" && stablePart(candidate.canonicalName) === stablePart(sequenceName));
      if (sequenceEntry) addRelationship(relationships, id, sequenceEntry.id, "figure-illustrates-sequence");
    }
    for (const sequenceEntry of entities.filter((candidate) => candidate.type === "sequence" && (candidate.sourceLocations || []).some((location) => Number(location.page) === page))) {
      const figureText = normalizedPhrase(`${figure.caption || figure.title || ""} ${(figure.aliases || []).join(" ")}`);
      if (sequenceTopicConcepts(sequenceEntry.canonicalName).every((alternatives) => alternatives.some((term) => figureText.includes(term)))) {
        addRelationship(relationships, id, sequenceEntry.id, "figure-illustrates-sequence", { resolutionStatus: "same-page-topic-match" });
      }
    }
    if (pageIds.has(page)) addRelationship(relationships, id, pageIds.get(page), "entity-is-mentioned-on-page");
  }

  for (const conflict of conflicts) {
    const entityId = conflict.entityId;
    const candidate = entities.find((entry) => entry.id === entityId);
    if (candidate) candidate.verificationStatus = "conflicted";
  }
  addAliasConflicts(entities, relationships, conflicts);
  const entityMaps = buildEntityReverseMaps(loaded["chunk-index"].data.chunks, entities);

  const graph = {
    schemaVersion: EVIDENCE_GRAPH_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    sourceFingerprint: currentSourceFingerprint,
    artifacts: Object.fromEntries(Object.entries(loaded).map(([key, value]) => [key, value.path])),
    artifactGenerations: Object.fromEntries(Object.entries(loaded).map(([key, value]) => [key, value.data.generation])),
    ...entityMaps,
    entities,
    relationships,
    conflicts,
    warnings: [],
    entityCount: entities.length,
    relationshipCount: relationships.length,
    conflictCount: conflicts.length,
    counts: Object.fromEntries(["document", "page", "section", "register", "bitfield", "sequence", "sequence-step", "caution", "table", "figure"].map((type) => [type, entities.filter((entry) => entry.type === type).length])),
  };
  graph.generation = {
    generationId: digestGeneration({
      schemaVersion: graph.schemaVersion,
      sourceFingerprint: graph.sourceFingerprint,
      serverVersion: SERVER_VERSION,
      dependencyGenerations: Object.fromEntries(Object.entries(graph.artifactGenerations).map(([key, generation]) => [key, generation.generationId])),
    }),
    sourceFingerprint: graph.sourceFingerprint,
    producerVersion: SERVER_VERSION,
    dependencyGenerations: Object.fromEntries(Object.entries(graph.artifactGenerations).map(([key, generation]) => [key, generation.generationId])),
  };
  const validation = validateEvidenceGraph(graph);
  if (!validation.ok) throw new Error(`Evidence graph validation failed: ${validation.errors.join("; ")}`);
  const graphPath = safeEvidenceGraphPath(filename);
  await fs.mkdir(path.dirname(graphPath), { recursive: true });
  await atomicWriteJson(graphPath, graph);
  const cacheSignature = await evidenceGraphCacheSignature(filename, graphPath, currentSourceFingerprint, fs, resolver);
  validatedGraphCache.set(graphCacheKey(filename, resolver), { signature: cacheSignature, graph });
  return graph;
}

export async function loadEvidenceGraph(filename, options = {}) {
  const { buildIfMissing = false } = options;
  const resolver = options.resolver || getPathResolver();
  const fsOps = options.fs || getPathResolverDependencies(resolver).fs || fs;
  const filePath = resolver.evidenceGraph(filename);
  const source = await getPdfSourceInfo(filename, { includeHash: true });
  const currentSourceFingerprint = sourceFingerprint(source);
  const cacheKey = graphCacheKey(filename, resolver);
  const maxAttempts = Math.max(1, Math.min(5, Number(options.maxAttempts || 2)));
  let previousStableMismatch = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const manifestBefore = await loadReadyCommittedManifest(filename, {
      ...options,
      fs: fsOps,
      expectedSourceFingerprint: currentSourceFingerprint,
      allowMissing: true,
    });
    if (!manifestBefore) {
      let graphExists = true;
      try { await fsOps.access(filePath); }
      catch (error) {
        if (error?.code === "ENOENT") graphExists = false;
        else throw error;
      }
      if (!graphExists) {
        if (buildIfMissing) return buildEvidenceGraph(filename);
        throw new Error(`Evidence graph not found for ${filename}. Run index_pdf first or rebuild the evidence graph.`);
      }
      const legacySignature = await evidenceGraphCacheSignature(filename, filePath, currentSourceFingerprint, fsOps, resolver);
      const legacyCached = validatedGraphCache.get(cacheKey);
      if (legacyCached?.signature === legacySignature) return legacyCached.graph;
      const graph = JSON.parse(await fsOps.readFile(filePath, "utf8"));
      if (graph.schemaVersion !== EVIDENCE_GRAPH_SCHEMA_VERSION || graph.filename !== filename || graph.sourceFingerprint !== currentSourceFingerprint) {
        if (buildIfMissing) return buildEvidenceGraph(filename);
        throw new Error(`Incompatible evidence graph for ${filename}; full index rebuild required.`);
      }
      const validation = validateEvidenceGraph(graph);
      if (!validation.ok) throw new Error(`Evidence graph is invalid: ${validation.errors.join("; ")}`);
      const artifacts = await loadAndValidateCoreArtifactGenerations(filename, {
        sourceFingerprint: currentSourceFingerprint,
        keys: Object.keys(GRAPH_ARTIFACTS),
        fs: fsOps,
        resolver,
      });
      for (const key of Object.keys(GRAPH_ARTIFACTS)) {
        if (graph.artifactGenerations?.[key]?.generationId !== artifacts[key].generation?.generationId) {
          throw new Error(`Evidence graph has a stale ${key} dependency generation.`);
        }
      }
      validatedGraphCache.set(cacheKey, { signature: legacySignature, graph });
      return graph;
    }
    await options.onReadStep?.({ step: "manifest-before", attempt, filename, key: "evidence-graph", manifest: structuredClone(manifestBefore) });

    let graph = null;
    let artifacts = null;
    let validationError = null;
    try {
      graph = JSON.parse(await fsOps.readFile(filePath, "utf8"));
      if (graph.artifactComplete !== true) throw new Error("evidence graph is not marked complete");
      if (graph.schemaVersion !== EVIDENCE_GRAPH_SCHEMA_VERSION || graph.filename !== filename || graph.sourceFingerprint !== currentSourceFingerprint) {
        throw new Error("evidence graph schema, filename, or source fingerprint is incompatible");
      }
      if (!manifestBefore.generation.evidenceGraphGeneration || graph.generation?.generationId !== manifestBefore.generation.evidenceGraphGeneration) {
        throw new Error("evidence graph generation does not match the ready manifest");
      }
      artifacts = await loadAndValidateCoreArtifactGenerations(filename, {
        sourceFingerprint: currentSourceFingerprint,
        keys: Object.keys(GRAPH_ARTIFACTS),
        fs: fsOps,
        resolver,
      });
      for (const key of Object.keys(GRAPH_ARTIFACTS)) {
        const artifactGenerationId = artifacts[key].generation?.generationId;
        if (
          graph.artifactGenerations?.[key]?.generationId !== artifactGenerationId
          || manifestBefore.generation.artifactGenerations?.[key] !== artifactGenerationId
        ) throw new Error(`evidence graph has a stale ${key} dependency generation`);
      }
      const validation = validateEvidenceGraph(graph);
      if (!validation.ok) throw new Error(`evidence graph validation failed: ${validation.errors.join("; ")}`);
    } catch (error) {
      if (["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE", "ENOSPC", "EROFS"].includes(String(error?.code || error?.cause?.code || ""))) throw error;
      validationError = error;
    }
    await options.onReadStep?.({ step: "artifact", attempt, filename, key: "evidence-graph", artifact: graph ? structuredClone(graph) : null, error: validationError });

    const manifestAfter = await loadReadyCommittedManifest(filename, {
      ...options,
      fs: fsOps,
      expectedSourceFingerprint: currentSourceFingerprint,
      allowMissing: true,
    });
    if (!manifestAfter) throw createGenerationChangedError(filename, "The ready manifest disappeared while reading the evidence graph.");
    await options.onReadStep?.({ step: "manifest-after", attempt, filename, key: "evidence-graph", manifest: structuredClone(manifestAfter) });
    if (
      manifestAfter.generation.buildId !== manifestBefore.generation.buildId
      || manifestAfter.generation.sourceFingerprint !== manifestBefore.generation.sourceFingerprint
    ) {
      if (attempt >= maxAttempts) throw createGenerationChangedError(filename, `Observed build ${manifestBefore.generation.buildId}, then ${manifestAfter.generation.buildId}.`);
      continue;
    }
    const afterBindingMismatch = graph && (
      manifestAfter.generation.evidenceGraphGeneration !== graph.generation?.generationId
      || Object.keys(GRAPH_ARTIFACTS).some((key) => (
        manifestAfter.generation.artifactGenerations?.[key] !== artifacts?.[key]?.generation?.generationId
      ))
    );
    if (!validationError && afterBindingMismatch) {
      validationError = new Error("evidence graph or dependency generation does not match the final ready manifest snapshot");
    }
    if (validationError) {
      const signature = `${manifestBefore.generation.buildId}:evidence-graph:${manifestBefore.generation.evidenceGraphGeneration || "missing"}`;
      if (signature === previousStableMismatch) {
        throw createGenerationInvalidError(filename, `Manifest build ${manifestBefore.generation.buildId} does not match the evidence graph.`, validationError);
      }
      previousStableMismatch = signature;
      if (attempt >= maxAttempts) throw createGenerationChangedError(filename, "The evidence graph did not remain bound to the ready manifest.");
      continue;
    }
    return graph;
  }
  throw createGenerationChangedError(filename);
}

export function getEvidenceGraphEntity(graph, entityId) {
  const requested = String(entityId || "").trim();
  const entities = graph?.entities || [];
  const idMatch = entities.find((candidate) => candidate.id === requested);
  const matches = idMatch ? [idMatch] : entities.filter((candidate) => {
    const values = [candidate.canonicalName, candidate.displayName, ...(candidate.aliases || []), ...(candidate.aliasVariants || [])];
    return values.some((value) => aliasLookupKeys(value).some((key) => aliasLookupKeys(requested).includes(key)));
  });
  if (!matches.length) return null;
  if (matches.length > 1) {
    return {
      entity: null,
      relationships: [],
      relatedEntities: [],
      conflicts: (graph.conflicts || []).filter((conflict) => conflict.field === "alias" && (conflict.candidateEntityIds || []).some((id) => matches.some((candidate) => candidate.id === id))),
      ambiguity: { query: requested, candidateEntityIds: matches.map((candidate) => candidate.id), candidates: matches.map((candidate) => ({ id: candidate.id, type: candidate.type, canonicalName: candidate.canonicalName, displayName: candidate.displayName, aliases: candidate.aliases })) },
    };
  }
  const [entity] = matches;
  const relationships = (graph.relationships || []).filter((relationship) => relationship.from === entity.id || relationship.to === entity.id);
  const relatedIds = new Set(relationships.map((relationship) => relationship.from === entity.id ? relationship.to : relationship.from));
  return {
    entity,
    relationships,
    relatedEntities: (graph.entities || []).filter((candidate) => relatedIds.has(candidate.id)),
    conflicts: (graph.conflicts || []).filter((conflict) => conflict.entityId === entity.id),
  };
}
