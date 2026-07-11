import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkEvidence,
  factsForEvidencePage,
  paginateEvidenceItems,
  reciprocalRankFuse,
  symbolVariantMatches,
  taskQuestions,
} from "../../src/workflows/evidence-orchestrator.js";

test("evidence pagination covers first, middle, final, empty, and request-bound cursors", () => {
  const items = Array.from({ length: 5 }, (_, index) => ({ id: `e${index + 1}` }));
  const first = paginateEvidenceItems(items, 2, null, "query-a");
  assert.deepEqual(first.rows.map((item) => item.id), ["e1", "e2"]);
  assert.equal(first.pagination.truncated, true);
  const middle = paginateEvidenceItems(items, 2, first.pagination.nextCursor, "query-a");
  assert.deepEqual(middle.rows.map((item) => item.id), ["e3", "e4"]);
  const final = paginateEvidenceItems(items, 2, middle.pagination.nextCursor, "query-a");
  assert.deepEqual(final.rows.map((item) => item.id), ["e5"]);
  assert.deepEqual(final.pagination, { total: 5, returned: 1, truncated: false, nextCursor: null });
  assert.deepEqual(paginateEvidenceItems([], 2, null, "empty").pagination, { total: 0, returned: 0, truncated: false, nextCursor: null });
  assert.throws(() => paginateEvidenceItems(items, 2, first.pagination.nextCursor, "query-b"), /does not match/i);
  assert.throws(() => paginateEvidenceItems(items, 2, "not-a-cursor", "query-a"), /invalid pagination cursor/i);
});

test("facts spanning pages retain only evidence returned on the current page", () => {
  const facts = [{ id: "register:dctrl", kind: "register", evidenceIds: ["e1", "e3"] }];
  assert.deepEqual(factsForEvidencePage(facts, [{ id: "e1" }, { id: "e2" }])[0].evidenceIds, ["e1"]);
  assert.deepEqual(factsForEvidencePage(facts, [{ id: "e3" }])[0].evidenceIds, ["e3"]);
  assert.deepEqual(factsForEvidencePage(facts, []), []);
});

test("OCR figure locators preserve figure identity without reusing chunk IDs", () => {
  const evidence = chunkEvidence({ id: "ocr-row", figureUid: "p843_f001", page: 843, sourceType: "figure_ocr", ocrText: "DMA flow" }, { query: "DMA figure" });
  assert.equal(evidence.kind, "figure-ocr-locator");
  assert.equal(evidence.figureId, "p843_f001");
  assert.equal(evidence.chunkId, null);
  assert.equal(evidence.extractionMethod, "optional-ocr-search-metadata");
  assert.equal(evidence.verificationStatus, "visual-verification-required");
});

test("entity-level RRF accumulates exact, lexical, and graph channel ranks", () => {
  const entity = { id: "register:dctrl", confidence: "high" };
  const evidence = { id: "e1", relatedEntityIds: [entity.id], confidence: "high" };
  const fused = reciprocalRankFuse([
    { name: "exact", results: [{ entity, evidence, retrievalReasons: ["exact symbol"] }] },
    { name: "lexical", results: [{ entity, evidence, retrievalReasons: ["linked chunk"] }] },
    { name: "graph", results: [{ entity, evidence, retrievalReasons: ["relationship"] }] },
  ]);
  assert.equal(fused.length, 1);
  assert.deepEqual(fused[0].sourceChannels, ["exact", "lexical", "graph"]);
  assert.deepEqual(fused[0].channelRanks, { exact: 1, lexical: 1, graph: 1 });
  assert.ok(fused[0].score > 3 / 62);
});

test("RRF contributes only once per entity in each retrieval channel", () => {
  const entity = { id: "register:dctrl", confidence: "high" };
  const evidence = { id: "e1", relatedEntityIds: [entity.id], confidence: "high" };
  const fused = reciprocalRankFuse([{ name: "lexical", results: [
    { entity, evidence, retrievalReasons: ["first chunk"] },
    { entity, evidence, retrievalReasons: ["duplicate linked chunk"] },
  ] }]);
  assert.equal(fused.length, 1);
  assert.equal(fused[0].channelRanks.lexical, 1);
  assert.equal(fused[0].score, 1 / 61);
});

test("symbol variants require a complete segment instead of a shared module prefix", () => {
  assert.equal(symbolVariantMatches("DMACM_CRSA_N", "DMACM_DCTRL", "register"), false);
  assert.equal(symbolVariantMatches("WDTM_WDTRCR", "WDTM_WDTCR", "register"), false);
  assert.equal(symbolVariantMatches("PFC_PWPR", "PWPR", "register"), true);
  assert.equal(symbolVariantMatches("FIGURE_6_3_GBETH", "GBETH", "figure"), true);
});

test("task decomposition ignores generic English and Vietnamese words and honors implemented evidence types", () => {
  const graph = { entities: [{ id: "register:dctrl", type: "register", canonicalName: "DMAC_DCTRL", aliases: ["DCTRL"], aliasVariants: ["DMAC_DCTRL", "DCTRL"] }] };
  const english = taskQuestions("Review Linux Ethernet driver completeness for DCTRL", "ethernet", ["register", "bitfield", "table", "caution", "figure"], graph);
  assert.deepEqual(english.filter((question) => question.category === "symbol").map((question) => question.query), ["DCTRL"]);
  assert.equal(english.some((question) => question.category === "caution"), true);
  assert.equal(english.some((question) => question.category === "figure"), true);
  assert.equal(english.some((question) => question.category === "register"), true);
  assert.equal(english.some((question) => question.category === "bitfield"), true);
  assert.equal(english.some((question) => question.category === "table"), true);
  const vietnamese = taskQuestions("Đánh giá trình điều khiển Linux và hỗ trợ DCTRL", "dmaengine", [], graph);
  assert.deepEqual(vietnamese.filter((question) => question.category === "symbol").map((question) => question.query), ["DCTRL"]);
});
