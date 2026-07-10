import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  atomicWriteJson,
  getPdfSourceInfo,
  safeBitfieldsIndexPath,
  safeCautionsIndexPath,
  safeEvidenceGraphPath,
  safeFiguresIndexPath,
  safeIndexPath,
  safePdfPath,
  safeRegistersIndexPath,
  safeSectionsIndexPath,
  safeSequencesIndexPath,
  safeTablesIndexPath,
} from "../../src/core/runtime-helpers.js";
import { buildEvidenceGraph, getEvidenceGraphEntity, loadEvidenceGraph, validateEvidenceGraph } from "../../src/services/evidence-graph.js";
import { queryManualEvidenceBundle } from "../../src/workflows/evidence-orchestrator.js";

const filename = "unit-evidence-graph.pdf";

async function setup() {
  await fs.writeFile(safePdfPath(filename), "%PDF-1.4\nunit graph\n", "utf-8");
  const source = await getPdfSourceInfo(filename);
  await atomicWriteJson(safeIndexPath(filename), { filename, source, pageCount: 2, chunks: [{ id: `${filename}:p1:c0`, page: 1, text: "DMA Control Register DCTRL", headings: ["DMA registers"] }, { id: `${filename}:p2:c0`, page: 2, text: "Caution reserved bits", headings: ["Usage notes"] }] });
  await atomicWriteJson(safeSectionsIndexPath(filename), { filename, source, sections: [{ id: "s1", title: "DMA registers", page: 1, level: 2 }] });
  await atomicWriteJson(safeRegistersIndexPath(filename), { filename, source, registers: [{ name: "DMAC_DCTRL", aliases: ["DCTRL"], pages: [1], chunks: [{ id: `${filename}:p1:c0` }], offsetAddresses: ["0300h", "0400h"], initialValues: ["0"], accessSizes: ["32"], confidence: 96, sourceKinds: ["register-table"] }] });
  await atomicWriteJson(safeBitfieldsIndexPath(filename), { filename, source, bitfields: [{ register: "DMAC_DCTRL", bitfield: "EN", pages: [1], bitRange: "0", access: "R/W", reset: "0", confidence: 92 }] });
  await atomicWriteJson(safeSequencesIndexPath(filename), { filename, source, sequences: [{ id: "dma-start", topic: "DMA start", pages: [1], confidence: "high", steps: [{ action: "set enable", register: "DMAC_DCTRL", bitfield: "EN", value: "1" }] }] });
  await atomicWriteJson(safeCautionsIndexPath(filename), { filename, source, cautions: [{ id: "reserved", topic: "reserved bits", type: "reserved-bit", pages: [2], relatedRegisters: ["DMAC_DCTRL"], confidence: "high", evidenceLines: ["Do not modify reserved bits."] }] });
  await atomicWriteJson(safeTablesIndexPath(filename), { filename, source, tables: [{ id: "t1", kind: "register-table", pageStart: 1, pageEnd: 1, relatedRegisters: ["DMAC_DCTRL"] }] });
  await atomicWriteJson(safeFiguresIndexPath(filename), { filename, source, figures: [{ figure_id: "p1_f001", page: 1, caption: "Figure 1 DMA start flow", related_sequences: ["DMA start"] }] });
}

async function cleanup() {
  for (const filePath of [safePdfPath(filename), safeIndexPath(filename), safeSectionsIndexPath(filename), safeRegistersIndexPath(filename), safeBitfieldsIndexPath(filename), safeSequencesIndexPath(filename), safeCautionsIndexPath(filename), safeTablesIndexPath(filename), safeFiguresIndexPath(filename), safeEvidenceGraphPath(filename)]) await fs.rm(filePath, { force: true });
}

test("normalized evidence graph links entities and preserves conflicts", async () => {
  await setup();
  try {
    const graph = await buildEvidenceGraph(filename);
    assert.deepEqual(validateEvidenceGraph(graph), { ok: true, errors: [] });
    assert.ok(graph.entities.some((entity) => entity.type === "register" && entity.canonicalName === "DMAC_DCTRL"));
    assert.ok(graph.relationships.some((relationship) => relationship.type === "register-has-bitfield"));
    assert.ok(graph.relationships.some((relationship) => relationship.type === "sequence-uses-register"));
    assert.ok(graph.conflicts.some((conflict) => conflict.field === "offset"));
    const loaded = await loadEvidenceGraph(filename);
    const register = loaded.entities.find((entity) => entity.type === "register");
    const detail = getEvidenceGraphEntity(loaded, register.id);
    assert.equal(detail.relatedEntities.some((entity) => entity.type === "bitfield"), true);
    assert.equal(detail.conflicts.length, 1);
    const bundle = await queryManualEvidenceBundle({ filename, query: "DMAC_DCTRL", topK: 5 });
    assert.equal(bundle.schemaVersion, 2);
    assert.equal(bundle.evidence[0].relatedEntityIds.includes(register.id), true);
    assert.equal(bundle.evidence[0].retrieval.sourceChannels.includes("exact"), true);
  } finally {
    await cleanup();
  }
});
