import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createAppContext } from "../../src/core/app-context.js";
import { wireRuntimePorts } from "../../src/app/runtime-wiring.js";
import {
  atomicWriteJson,
  getPdfSourceInfo,
  safeArtifactManifestPath,
  safeBitfieldsIndexPath,
  safeCautionsIndexPath,
  safeEvidenceGraphPath,
  safeFiguresIndexPath,
  safeIndexPath,
  safePagesCachePath,
  safePdfPath,
  safeRegistersIndexPath,
  safeSectionsIndexPath,
  safeSequencesIndexPath,
  safeTablesIndexPath,
} from "../../src/core/runtime-helpers.js";
import {
  BITFIELD_INDEX_SCHEMA_VERSION,
  CAUTION_INDEX_SCHEMA_VERSION,
  FIGURE_INDEX_SCHEMA_VERSION,
  INDEX_SCHEMA_VERSION,
  PAGE_CACHE_SCHEMA_VERSION,
  REGISTER_INDEX_SCHEMA_VERSION,
  SECTION_INDEX_SCHEMA_VERSION,
  SEQUENCE_INDEX_SCHEMA_VERSION,
  TABLE_INDEX_SCHEMA_VERSION,
} from "../../src/core/runtime-constants.js";
import { stampCoreArtifactGenerations } from "../../src/artifacts/generation.js";
import { buildEvidenceGraph, getEvidenceGraphEntity, loadEvidenceGraph, validateEvidenceGraph } from "../../src/services/evidence-graph.js";
import { getManualEntityBundle, queryManualEvidenceBundle, readManualEvidenceBundle } from "../../src/workflows/evidence-orchestrator.js";

const filename = "unit-evidence-graph.pdf";
wireRuntimePorts(createAppContext());

async function setup() {
  await fs.writeFile(safePdfPath(filename), "%PDF-1.4\nunit graph\n", "utf-8");
  const source = await getPdfSourceInfo(filename);
  await atomicWriteJson(safePagesCachePath(filename), { schemaVersion: PAGE_CACHE_SCHEMA_VERSION, filename, source, pageCount: 2, pages: [{ page: 1, text: "DMA Control Register DCTRL" }, { page: 2, text: "Caution reserved bits" }] });
  await atomicWriteJson(safeIndexPath(filename), { schemaVersion: INDEX_SCHEMA_VERSION, filename, source, sourceSize: source.size, sourceModifiedMs: source.mtimeMs, pageCount: 2, chunkCount: 2, chunkingVersion: 2, chunks: [{ id: `${filename}:p1:c0`, page: 1, text: "DMA Control Register DMAC_DCTRL DCTRL", searchText: "dma control register dmac dctrl", headings: ["DMA registers"], symbols: ["DMAC_DCTRL", "DCTRL"], entityIds: [] }, { id: `${filename}:p2:c0`, page: 2, text: "Caution reserved bits", searchText: "caution reserved bits", headings: ["Usage notes"], symbols: [], entityIds: [] }] });
  await atomicWriteJson(safeSectionsIndexPath(filename), { schemaVersion: SECTION_INDEX_SCHEMA_VERSION, filename, source, sections: [{ id: "s1", title: "DMA registers", page: 1, level: 2 }] });
  await atomicWriteJson(safeRegistersIndexPath(filename), { schemaVersion: REGISTER_INDEX_SCHEMA_VERSION, filename, source, registers: [{ name: "DMAC_DCTRL", displayName: "DMA Control", aliases: ["DCTRL", "DMAC_CTRL_ALIAS"], pages: [1, 2], chunks: [{ id: `${filename}:p1:c0`, page: 1, score: 90 }, { id: `${filename}:p2:c0`, page: 2, score: 110 }], offsetAddresses: ["0300h", "0400h"], initialValues: ["0"], accessSizes: ["32"], confidence: 96, sourceKinds: ["register-table"] }] });
  await atomicWriteJson(safeBitfieldsIndexPath(filename), { schemaVersion: BITFIELD_INDEX_SCHEMA_VERSION, filename, source, bitfields: [{ register: "DCTRL", bitfield: "EN", pages: [1], bitRange: "0", access: "R/W", reset: "0", confidence: 92 }, { register: "DMA Control", bitfield: "MODE", pages: [1], bitRange: "2:1", access: "R/W", reset: "0", confidence: 88 }, { register: "MISSING_REG", bitfield: "UNKNOWN", pages: [2], bitRange: "3", access: "R/W", reset: "0", confidence: 70 }] });
  await atomicWriteJson(safeSequencesIndexPath(filename), { schemaVersion: SEQUENCE_INDEX_SCHEMA_VERSION, filename, source, sequences: [{ id: "dma-start", topic: "DMA start", pages: [1], confidence: "high", steps: [{ action: "set enable", register: "DCTRL", bitfield: "EN", value: "1" }] }] });
  await atomicWriteJson(safeCautionsIndexPath(filename), { schemaVersion: CAUTION_INDEX_SCHEMA_VERSION, filename, source, cautions: [{ id: "reserved", topic: "reserved bits", type: "reserved-bit", pages: [2], relatedRegisters: ["DMAC_CTRL_ALIAS"], confidence: "high", evidenceLines: ["Do not modify reserved bits."] }] });
  await atomicWriteJson(safeTablesIndexPath(filename), { schemaVersion: TABLE_INDEX_SCHEMA_VERSION, filename, source, tables: [{ id: "t1", kind: "register-table", pageStart: 1, pageEnd: 1, relatedRegisters: ["DMAC_DCTRL"] }] });
  await atomicWriteJson(safeFiguresIndexPath(filename), { schemaVersion: FIGURE_INDEX_SCHEMA_VERSION, filename, source, figures: [{ figure_id: "p1_f001", page: 1, caption: "Figure 1 DMA start flow", related_sequences: ["DMA start"] }] });
  await stampCoreArtifactGenerations(filename, { source, chunkingVersion: 2 });
}

async function cleanup() {
  for (const filePath of [safePdfPath(filename), safePagesCachePath(filename), safeIndexPath(filename), safeSectionsIndexPath(filename), safeRegistersIndexPath(filename), safeBitfieldsIndexPath(filename), safeSequencesIndexPath(filename), safeCautionsIndexPath(filename), safeTablesIndexPath(filename), safeFiguresIndexPath(filename), safeEvidenceGraphPath(filename), safeArtifactManifestPath(filename)]) await fs.rm(filePath, { force: true });
}

test("normalized evidence graph links entities and preserves conflicts", async () => {
  await setup();
  try {
    const graph = await buildEvidenceGraph(filename);
    assert.deepEqual(validateEvidenceGraph(graph), { ok: true, errors: [] });
    assert.equal(graph.artifactGenerations["chunk-index"].schemaVersion, INDEX_SCHEMA_VERSION);
    assert.equal(graph.artifactGenerations["chunk-index"].serverVersion, graph.serverVersion);
    assert.ok(graph.artifactGenerations.registers.dependencyFingerprints["chunk-index"]);
    assert.ok(graph.entities.some((entity) => entity.type === "register" && entity.canonicalName === "DMAC_DCTRL"));
    assert.ok(graph.relationships.some((relationship) => relationship.type === "register-has-bitfield"));
    const register = graph.entities.find((entity) => entity.type === "register");
    const linkedBitfieldIds = graph.relationships.filter((relationship) => relationship.type === "register-has-bitfield" && relationship.from === register.id).map((relationship) => relationship.to);
    assert.equal(linkedBitfieldIds.some((id) => graph.entities.find((entity) => entity.id === id)?.canonicalName === "EN"), true);
    assert.equal(linkedBitfieldIds.some((id) => graph.entities.find((entity) => entity.id === id)?.canonicalName === "MODE"), true);
    assert.ok(graph.relationships.some((relationship) => relationship.type === "register-has-caution" && relationship.from === register.id));
    assert.ok(graph.relationships.some((relationship) => relationship.type === "sequence-uses-register"));
    const sequence = graph.entities.find((entity) => entity.type === "sequence" && entity.canonicalName === "DMA start");
    assert.deepEqual(sequence.properties.stepSummaries, ["DMAC_DCTRL EN 1"]);
    const unresolved = graph.entities.find((entity) => entity.type === "bitfield" && entity.canonicalName === "UNKNOWN");
    assert.equal(unresolved.properties.registerResolutionStatus, "unresolved");
    assert.equal(unresolved.properties.unresolvedRegisterReference, "MISSING_REG");
    assert.equal(unresolved.verificationStatus, "conflicted");
    assert.ok(graph.conflicts.some((conflict) => conflict.field === "offset"));
    assert.ok(graph.chunkEntityIds[`${filename}:p1:c0`].includes(register.id));
    assert.ok(graph.pageEntityIds[1].includes(register.id));
    assert.ok(graph.symbolEntityIds.dctrl.includes(register.id));
    const loaded = await loadEvidenceGraph(filename);
    assert.equal(await loadEvidenceGraph(filename), loaded);
    const loadedRegister = loaded.entities.find((entity) => entity.type === "register");
    const detail = getEvidenceGraphEntity(loaded, loadedRegister.id);
    assert.equal(detail.relatedEntities.some((entity) => entity.type === "bitfield"), true);
    assert.equal(detail.conflicts.length, 1);
    const bundle = await queryManualEvidenceBundle({ filename, query: "DMAC_DCTRL", topK: 5 });
    assert.equal(bundle.schemaVersion, 2);
    assert.equal(bundle.evidence[0].relatedEntityIds.includes(loadedRegister.id), true);
    assert.equal(bundle.evidence[0].retrieval.sourceChannels.includes("exact"), true);
    assert.equal(bundle.evidence[0].retrieval.sourceChannels.includes("lexical"), true, JSON.stringify({ evidence: bundle.evidence, warnings: bundle.warnings }));
    assert.equal(bundle.evidence[0].retrieval.entityId, loadedRegister.id);
    assert.equal(bundle.evidence[0].retrieval.channelRanks.exact, 1);
    const aliasBundle = await queryManualEvidenceBundle({ filename, query: "DCTRL", topK: 5 });
    assert.equal(aliasBundle.evidence.some((item) => item.entityId === loadedRegister.id && item.retrieval.sourceChannels.includes("exact")), true);
    const entityBundle = await getManualEntityBundle({ filename, entityId: "dctrl" });
    assert.equal(entityBundle.entities.some((entity) => entity.id === loadedRegister.id), true);
    assert.equal(entityBundle.relationships.every((relation) => entityBundle.entities.some((entity) => entity.id === relation.from) && entityBundle.entities.some((entity) => entity.id === relation.to)), true);
    const figure = graph.entities.find((entity) => entity.type === "figure");
    const figureBundle = await readManualEvidenceBundle({ filename, entityId: figure.id });
    const figureEvidence = figureBundle.evidence.find((item) => item.kind === "figure");
    assert.equal(figureEvidence.figureId, "p1_f001");
    assert.equal(figureEvidence.chunkId, null);
    assert.equal(figureBundle.recommendedNextActions.some((action) => action.tool === "get_figure_context_pack" && action.arguments.figure_id === "p1_f001"), true);
  } finally {
    await cleanup();
  }
});

test("ambiguous aliases are conflicted rather than silently resolved", async () => {
  await setup();
  try {
    const registersPath = safeRegistersIndexPath(filename);
    const registers = JSON.parse(await fs.readFile(registersPath, "utf8"));
    registers.registers.push({ name: "ALT_DCTRL", aliases: ["DCTRL"], pages: [2], chunks: [{ id: `${filename}:p2:c0`, page: 2, score: 90 }], confidence: 90, sourceKinds: ["register-table"] });
    await atomicWriteJson(registersPath, registers);
    const source = await getPdfSourceInfo(filename);
    await stampCoreArtifactGenerations(filename, { source, chunkingVersion: 2 });
    const graph = await buildEvidenceGraph(filename);
    const resolved = getEvidenceGraphEntity(graph, "DCTRL");
    assert.ok(resolved.ambiguity);
    assert.equal(resolved.ambiguity.candidateEntityIds.length, 2);
    const en = graph.entities.find((entity) => entity.type === "bitfield" && entity.canonicalName === "EN");
    const ambiguousLinks = graph.relationships.filter((relationship) => relationship.type === "register-has-bitfield" && relationship.to === en.id);
    assert.equal(ambiguousLinks.length, 2);
    assert.equal(ambiguousLinks.every((relationship) => relationship.properties.resolutionStatus === "conflicted"), true);
    assert.ok(graph.conflicts.some((conflict) => conflict.entityId === en.id && conflict.field === "registerReference"));
    await assert.rejects(() => getManualEntityBundle({ filename, entityId: "DCTRL" }), /ambiguous/i);
  } finally {
    await cleanup();
  }
});

test("evidence graphs reject artifact content that no longer matches its generation", async () => {
  await setup();
  try {
    await buildEvidenceGraph(filename);
    const sectionsPath = safeSectionsIndexPath(filename);
    const sections = JSON.parse(await fs.readFile(sectionsPath, "utf8"));
    sections.sections[0].title = "mutated without regeneration";
    await atomicWriteJson(sectionsPath, sections);
    await assert.rejects(() => loadEvidenceGraph(filename), /generation|stale|incompatible/i);
  } finally {
    await cleanup();
  }
});

test("evidence graphs reject old chunking and mixed dependency generations", async () => {
  await setup();
  try {
    const indexPath = safeIndexPath(filename);
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    index.chunkingVersion = 1;
    await atomicWriteJson(indexPath, index);
    const source = await getPdfSourceInfo(filename);
    await stampCoreArtifactGenerations(filename, { source, chunkingVersion: 2 });
    await assert.rejects(() => buildEvidenceGraph(filename), /chunkingVersion=1/i);

    index.chunkingVersion = 2;
    await atomicWriteJson(indexPath, index);
    await stampCoreArtifactGenerations(filename, { source, chunkingVersion: 2 });
    const bitfieldsPath = safeBitfieldsIndexPath(filename);
    const bitfields = JSON.parse(await fs.readFile(bitfieldsPath, "utf8"));
    bitfields.generation.dependencyFingerprints.registers = "different-generation";
    await atomicWriteJson(bitfieldsPath, bitfields);
    await assert.rejects(() => buildEvidenceGraph(filename), /different registers generation/i);
  } finally {
    await cleanup();
  }
});

test("loadEvidenceGraph rebuilds compatible graph metadata but rejects a stale manifest", async () => {
  await setup();
  try {
    const graph = await buildEvidenceGraph(filename);
    const graphPath = safeEvidenceGraphPath(filename);
    const corrupted = { ...graph, schemaVersion: 0 };
    await atomicWriteJson(graphPath, corrupted);
    const rebuilt = await loadEvidenceGraph(filename, { buildIfMissing: true });
    assert.equal(rebuilt.schemaVersion, graph.schemaVersion);

    await atomicWriteJson(safeArtifactManifestPath(filename), { filename, source: { fingerprint: graph.sourceFingerprint }, staleArtifacts: ["registers"], artifacts: {} });
    await assert.rejects(() => loadEvidenceGraph(filename), /manifest marks graph dependencies stale/i);
  } finally {
    await cleanup();
  }
});

test("read_manual_evidence preserves explicit page and chunk selectors", async () => {
  await setup();
  try {
    const graph = await buildEvidenceGraph(filename);
    const register = graph.entities.find((entity) => entity.type === "register");
    const pageResult = await readManualEvidenceBundle({ filename, entityId: register.id, page: 2 });
    assert.ok(pageResult.evidence.length >= 1);
    assert.equal(pageResult.evidence.every((item) => item.page === 2), true);
    assert.equal(pageResult.evidence.some((item) => item.chunkId === `${filename}:p2:c0`), true);
    const chunkResult = await readManualEvidenceBundle({ filename, entityId: register.id, chunkId: `${filename}:p1:c0` });
    assert.ok(chunkResult.evidence.length >= 1);
    assert.equal(chunkResult.evidence.every((item) => item.chunkId === `${filename}:p1:c0`), true);
    const mismatch = await readManualEvidenceBundle({ filename, entityId: register.id, page: 2, chunkId: `${filename}:p1:c0` });
    assert.equal(mismatch.evidence.length, 0);
  } finally {
    await cleanup();
  }
});
