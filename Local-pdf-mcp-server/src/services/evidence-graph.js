import fs from "node:fs/promises";
import path from "node:path";
import { sourceFingerprint } from "../artifacts/manifest.js";
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
  safeIndexPath,
  safeRegistersIndexPath,
  safeSectionsIndexPath,
  safeSequencesIndexPath,
  safeTablesIndexPath,
} from "../core/runtime-helpers.js";
import { EVIDENCE_GRAPH_SCHEMA_VERSION, SERVER_VERSION } from "../core/runtime-constants.js";

const GRAPH_ARTIFACTS = Object.freeze({
  chunks: safeIndexPath,
  sections: safeSectionsIndexPath,
  registers: safeRegistersIndexPath,
  bitfields: safeBitfieldsIndexPath,
  sequences: safeSequencesIndexPath,
  cautions: safeCautionsIndexPath,
  tables: safeTablesIndexPath,
  figures: safeFiguresIndexPath,
});

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

function pagesFrom(value) {
  return unique((Array.isArray(value) ? value : [value])
    .map(Number)
    .filter((page) => Number.isFinite(page) && page > 0))
    .sort((a, b) => a - b);
}

function verificationStatus(value, fallback = "candidate") {
  const normalized = String(value || "").toLowerCase().replace(/[ _]+/g, "-");
  if (["verified", "high-confidence", "candidate", "conflicted", "rejected-noise", "visual-verification-required"].includes(normalized)) return normalized;
  if (normalized === "high") return "high-confidence";
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
  return resolvedPages.length ? resolvedPages.map((page) => ({
    page,
    chunkIds: unique(chunkIds),
    sectionPath: Array.isArray(sectionPath) ? sectionPath.filter(Boolean) : [],
    boundingBox: Array.isArray(bbox) ? bbox : [],
    sourceArtifact: artifact || "",
    extractionMethod: extractionMethod || "artifact-import",
    verificationStatus: verificationStatus(verification),
  })) : [{
    page: null,
    chunkIds: unique(chunkIds),
    sectionPath: Array.isArray(sectionPath) ? sectionPath.filter(Boolean) : [],
    boundingBox: Array.isArray(bbox) ? bbox : [],
    sourceArtifact: artifact || "",
    extractionMethod: extractionMethod || "artifact-import",
    verificationStatus: verificationStatus(verification),
  }];
}

function entity({ id, type, canonicalName, aliases = [], sourceLocations = [], confidence: entityConfidence = "medium", extractionMethod, verificationStatus: status = "candidate", properties = {} }) {
  return {
    id,
    type,
    canonicalName: String(canonicalName || id),
    aliases: unique(aliases.map(String)).filter((alias) => alias !== canonicalName),
    sourceLocations,
    confidence: confidence(entityConfidence),
    extractionMethod: extractionMethod || "artifact-import",
    verificationStatus: verificationStatus(status),
    properties,
  };
}

async function readOptional(pathFor, filename, warnings, key) {
  const filePath = pathFor(filename);
  if (!(await pathExists(filePath))) {
    warnings.push(`${key} artifact is missing`);
    return { path: filePath, data: null };
  }
  try {
    return { path: filePath, data: await readJsonCached(filePath) };
  } catch (error) {
    warnings.push(`${key} artifact is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return { path: filePath, data: null };
  }
}

const relationshipIdsByArray = new WeakMap();

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

export function validateEvidenceGraph(graph = {}) {
  const errors = [];
  if (graph.schemaVersion !== EVIDENCE_GRAPH_SCHEMA_VERSION) errors.push(`schemaVersion must be ${EVIDENCE_GRAPH_SCHEMA_VERSION}`);
  if (!String(graph.filename || "").endsWith(".pdf")) errors.push("filename must be a PDF filename");
  if (!String(graph.sourceFingerprint || "")) errors.push("sourceFingerprint is required");
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
  const warnings = [];
  const source = await getPdfSourceInfo(filename);
  const loaded = {};
  for (const [key, pathFor] of Object.entries(GRAPH_ARTIFACTS)) {
    loaded[key] = await readOptional(pathFor, filename, warnings, key);
  }

  const chunks = loaded.chunks.data?.chunks || [];
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
    properties: { pageCount: Number(loaded.chunks.data?.pageCount || 0), sourceFingerprint: sourceFingerprint(source) },
  }));

  const pageIds = new Map();
  const pageCount = Number(loaded.chunks.data?.pageCount || 0);
  for (let page = 1; page <= pageCount; page += 1) {
    const id = stableId("page", filename, page);
    pageIds.set(page, id);
    entities.push(entity({
      id,
      type: "page",
      canonicalName: `page ${page}`,
      sourceLocations: locations({ pages: [page], artifact: loaded.chunks.path, extractionMethod: "pages-cache", verification: "verified" }),
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

  const registerIds = new Map();
  for (const register of registers) {
    const canonicalName = register.canonicalName || register.name || register.displayName;
    if (!canonicalName) continue;
    const id = stableId("register", filename, canonicalName);
    registerIds.set(stablePart(canonicalName), id);
    const pages = pagesFrom(register.pages);
    const section = sectionForPage(sections, pages[0]);
    const registerChunkGroups = new Map();
    for (const chunk of register.chunks || []) {
      const chunkId = chunk?.id || chunk;
      const chunkPage = Number(chunk?.page || String(chunkId || "").match(/:p(\d+):/)?.[1]);
      if (!Number.isFinite(chunkPage) || !chunkId) continue;
      const group = registerChunkGroups.get(chunkPage) || { ids: [], score: 0 };
      group.ids.push(chunkId);
      group.score = Math.max(group.score, Number(chunk?.score || 0));
      registerChunkGroups.set(chunkPage, group);
    }
    const registerLocations = registerChunkGroups.size
      ? [...registerChunkGroups.entries()].flatMap(([page, group]) => locations({ pages: [page], chunkIds: group.ids, sectionPath: section ? [section.title] : [], artifact: loaded.registers.path, extractionMethod: register.sourceKinds?.join(",") || "register-index", verification: register.verificationStatus || "candidate" }).map((location) => ({ ...location, sourceScore: group.score })))
      : locations({ pages, sectionPath: section ? [section.title] : [], artifact: loaded.registers.path, extractionMethod: register.sourceKinds?.join(",") || "register-index", verification: register.verificationStatus || "candidate" });
    entities.push(entity({
      id,
      type: "register",
      canonicalName,
      aliases: [register.displayName, ...(register.aliases || [])],
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
    }));
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
    const registerId = registerIds.get(stablePart(registerName));
    if (registerId) addRelationship(relationships, registerId, id, "register-has-bitfield");
    for (const page of pages) if (pageIds.has(page)) addRelationship(relationships, id, pageIds.get(page), "entity-is-mentioned-on-page");
  }

  for (const sequence of sequences) {
    const id = stableId("sequence", filename, sequence.id || sequence.topic || sequence.title);
    const pages = pagesFrom(sequence.pages || sequence.page);
    entities.push(entity({
      id,
      type: "sequence",
      canonicalName: sequence.topic || sequence.title || id,
      aliases: sequence.aliases || [],
      sourceLocations: locations({ pages, chunkIds: (sequence.chunks || []).map((chunk) => chunk.id || chunk), artifact: loaded.sequences.path, extractionMethod: sequence.source || "sequence-index", verification: sequence.verificationStatus || "candidate" }),
      confidence: sequence.confidence || sequence.score,
      extractionMethod: sequence.source || "sequence-index",
      verificationStatus: sequence.verificationStatus || "candidate",
      properties: { kind: sequence.kind || "generic" },
    }));
    addRelationship(relationships, documentId, id, "document-has-sequence");
    for (const page of pages) if (pageIds.has(page)) addRelationship(relationships, id, pageIds.get(page), "entity-is-mentioned-on-page");
    const steps = sequence.steps || sequence.sequenceSteps || [];
    let previousStep = null;
    for (const [index, step] of steps.entries()) {
      const stepId = stableId("sequence-step", filename, id, step.id || index + 1);
      const registerName = step.register || step.registerName || "";
      entities.push(entity({
        id: stepId,
        type: "sequence-step",
        canonicalName: step.action || step.text || `step ${index + 1}`,
        sourceLocations: locations({ pages: pagesFrom(step.page || pages), chunkIds: [step.chunkId], artifact: loaded.sequences.path, extractionMethod: "sequence-index", verification: sequence.verificationStatus || "candidate" }),
        confidence: step.confidence || sequence.confidence || sequence.score,
        extractionMethod: "sequence-index",
        verificationStatus: sequence.verificationStatus || "candidate",
        properties: { order: index + 1, register: registerName, bitfield: step.bitfield || "", value: step.value ?? null, condition: step.condition || "" },
      }));
      addRelationship(relationships, id, stepId, "sequence-has-step");
      if (previousStep) addRelationship(relationships, previousStep, stepId, "sequence-step-occurs-before");
      previousStep = stepId;
      const registerId = registerIds.get(stablePart(registerName));
      if (registerId) addRelationship(relationships, stepId, registerId, "sequence-uses-register");
    }
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
      const registerId = registerIds.get(stablePart(registerName));
      if (registerId) addRelationship(relationships, registerId, id, "register-has-caution");
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
      const registerId = registerIds.get(stablePart(registerName));
      if (registerId) addRelationship(relationships, id, registerId, "table-describes-register");
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
      properties: { kind: figure.kind || "figure", figureId: figure.figure_id || figure.id || "", imagePath: figure.image_path || "", visualSemanticsRequireImage: true },
    }));
    for (const sequenceName of figure.related_sequences || []) {
      const sequenceEntry = entities.find((candidate) => candidate.type === "sequence" && stablePart(candidate.canonicalName) === stablePart(sequenceName));
      if (sequenceEntry) addRelationship(relationships, id, sequenceEntry.id, "figure-illustrates-sequence");
    }
    if (pageIds.has(page)) addRelationship(relationships, id, pageIds.get(page), "entity-is-mentioned-on-page");
  }

  for (const conflict of conflicts) {
    const entityId = conflict.entityId;
    const candidate = entities.find((entry) => entry.id === entityId);
    if (candidate) candidate.verificationStatus = "conflicted";
  }

  const graph = {
    schemaVersion: EVIDENCE_GRAPH_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    sourceFingerprint: sourceFingerprint(source),
    artifacts: Object.fromEntries(Object.entries(loaded).map(([key, value]) => [key, value.path])),
    entities,
    relationships,
    conflicts,
    warnings: unique(warnings),
    entityCount: entities.length,
    relationshipCount: relationships.length,
    conflictCount: conflicts.length,
    counts: Object.fromEntries(["document", "page", "section", "register", "bitfield", "sequence", "sequence-step", "caution", "table", "figure"].map((type) => [type, entities.filter((entry) => entry.type === type).length])),
  };
  const validation = validateEvidenceGraph(graph);
  if (!validation.ok) throw new Error(`Evidence graph validation failed: ${validation.errors.join("; ")}`);
  await fs.mkdir(path.dirname(safeEvidenceGraphPath(filename)), { recursive: true });
  await atomicWriteJson(safeEvidenceGraphPath(filename), graph);
  return graph;
}

export async function loadEvidenceGraph(filename, { buildIfMissing = false } = {}) {
  const filePath = safeEvidenceGraphPath(filename);
  if (!(await pathExists(filePath))) {
    if (buildIfMissing) return buildEvidenceGraph(filename);
    throw new Error(`Evidence graph not found for ${filename}. Run index_pdf first or rebuild the evidence graph.`);
  }
  const graph = await readJsonCached(filePath);
  const source = await getPdfSourceInfo(filename);
  if (graph.schemaVersion !== EVIDENCE_GRAPH_SCHEMA_VERSION || graph.filename !== filename || graph.sourceFingerprint !== sourceFingerprint(source)) {
    if (buildIfMissing) return buildEvidenceGraph(filename);
    throw new Error(`Evidence graph is stale or incompatible for ${filename}. Rebuild the graph after indexing.`);
  }
  const validation = validateEvidenceGraph(graph);
  if (!validation.ok) throw new Error(`Evidence graph is invalid: ${validation.errors.join("; ")}`);
  return graph;
}

export function getEvidenceGraphEntity(graph, entityId) {
  const entity = (graph?.entities || []).find((candidate) => candidate.id === entityId || candidate.aliases?.includes(entityId));
  if (!entity) return null;
  const relationships = (graph.relationships || []).filter((relationship) => relationship.from === entity.id || relationship.to === entity.id);
  const relatedIds = new Set(relationships.map((relationship) => relationship.from === entity.id ? relationship.to : relationship.from));
  return {
    entity,
    relationships,
    relatedEntities: (graph.entities || []).filter((candidate) => relatedIds.has(candidate.id)),
    conflicts: (graph.conflicts || []).filter((conflict) => conflict.entityId === entity.id),
  };
}
