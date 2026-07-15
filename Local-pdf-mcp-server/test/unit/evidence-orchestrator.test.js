import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBoundedQueryGraphContext,
  chunkEvidence,
  conflictVerificationActions,
  entityEvidence,
  exactGraphMatches,
  factsForEvidencePage,
  paginateEvidenceItems,
  prioritizeRequestedEntityTypes,
  projectedCautionRows,
  projectedSequenceRows,
  reciprocalRankFuse,
  shouldUseInProcessLexicalFusion,
  symbolVariantMatches,
  taskQuestions,
} from "../../src/workflows/evidence-orchestrator.js";

test("bounded query graph context keeps a returned sequence atomic when its steps exceed the limit", () => {
  const graph = {
    entities: [
      { id: "sequence:refresh", type: "sequence" },
      { id: "step:1", type: "sequence-step" },
      { id: "step:2", type: "sequence-step" },
      { id: "step:3", type: "sequence-step" },
      { id: "page:1", type: "page" },
    ],
    relationships: [
      { id: "s1", from: "sequence:refresh", to: "step:1", type: "sequence-has-step", properties: {} },
      { id: "s2", from: "sequence:refresh", to: "step:2", type: "sequence-has-step", properties: {} },
      { id: "s3", from: "sequence:refresh", to: "step:3", type: "sequence-has-step", properties: {} },
      { id: "order", from: "step:1", to: "step:2", type: "sequence-step-occurs-before", properties: {} },
      { id: "page", from: "sequence:refresh", to: "page:1", type: "entity-is-mentioned-on-page", properties: {} },
    ],
  };
  const context = buildBoundedQueryGraphContext(graph, [{ entityId: "sequence:refresh", relatedEntityIds: ["sequence:refresh"] }], { maxEntities: 3, maxRelationships: 10 });
  assert.deepEqual(context.entities.map((entity) => entity.id), ["sequence:refresh"]);
  assert.deepEqual(context.relationships, []);
  assert.equal(context.truncated, true);
  assert.deepEqual(context.skippedSequenceIds, ["sequence:refresh"]);
});

function sequenceContextGraph() {
  return {
    entities: [
      { id: "document:manual", type: "document" },
      { id: "page:7", type: "page" },
      { id: "sequence:refresh", type: "sequence" },
      { id: "step:1", type: "sequence-step" },
      { id: "step:2", type: "sequence-step" },
      { id: "register:wdtrr", type: "register" },
      { id: "figure:refresh", type: "figure" },
    ],
    relationships: [
      { id: "has-1", from: "sequence:refresh", to: "step:1", type: "sequence-has-step", properties: {} },
      { id: "has-2", from: "sequence:refresh", to: "step:2", type: "sequence-has-step", properties: {} },
      { id: "before", from: "step:1", to: "step:2", type: "sequence-step-occurs-before", properties: {} },
      { id: "uses", from: "step:1", to: "register:wdtrr", type: "sequence-uses-register", properties: {} },
      { id: "figure", from: "figure:refresh", to: "sequence:refresh", type: "figure-illustrates-sequence", properties: {} },
      { id: "page", from: "sequence:refresh", to: "page:7", type: "entity-is-mentioned-on-page", properties: {} },
    ],
  };
}

test("a sequence-step seed expands its complete parent sequence without document or page context", () => {
  const context = buildBoundedQueryGraphContext(sequenceContextGraph(), [{ entityId: "step:1", relatedEntityIds: ["step:1"] }], { maxEntities: 10, maxRelationships: 10 });
  assert.deepEqual(new Set(context.entities.map((entity) => entity.id)), new Set(["sequence:refresh", "step:1", "step:2", "register:wdtrr", "figure:refresh"]));
  assert.deepEqual(context.relationships.filter((relationship) => ["sequence-has-step", "sequence-step-occurs-before"].includes(relationship.type)).map((relationship) => relationship.id), ["has-1", "has-2", "before"]);
  assert.equal(context.entities.some((entity) => ["document", "page"].includes(entity.type)), false);
  assert.equal(context.relationships.every((relationship) => context.entities.some((entity) => entity.id === relationship.from) && context.entities.some((entity) => entity.id === relationship.to)), true);
  assert.equal(context.skippedSequenceIds.length, 0);
});

test("a sequence-step seed never leaks a partial parent sequence when its core cannot fit", () => {
  const context = buildBoundedQueryGraphContext(sequenceContextGraph(), [{ entityId: "step:1" }], { maxEntities: 2, maxRelationships: 10 });
  assert.deepEqual(context.entities.map((entity) => entity.id), ["step:1"]);
  assert.deepEqual(context.relationships, []);
  assert.deepEqual(context.skippedSequenceIds, ["sequence:refresh"]);
});

test("a fitting mandatory sequence core survives optional-context truncation", () => {
  const context = buildBoundedQueryGraphContext(sequenceContextGraph(), [{ entityId: "sequence:refresh" }], { maxEntities: 3, maxRelationships: 3 });
  assert.deepEqual(new Set(context.entities.map((entity) => entity.id)), new Set(["sequence:refresh", "step:1", "step:2"]));
  assert.deepEqual(context.relationships.map((relationship) => relationship.id), ["has-1", "has-2", "before"]);
  assert.equal(context.optionalContextTruncated, true);
  assert.equal(context.skippedSequenceIds.length, 0);
  assert.equal(context.truncated, true);
});

test("bounded graph context enforces entity and relationship caps for ranked evidence", () => {
  const seedGraph = {
    entities: ["seed", "one", "two", "three"].map((id) => ({ id: `register:${id}`, type: "register" })),
    relationships: [
      { id: "a", from: "register:seed", to: "register:one", type: "register-has-bitfield", properties: {} },
      { id: "b", from: "register:seed", to: "register:two", type: "register-has-bitfield", properties: {} },
      { id: "c", from: "register:seed", to: "register:three", type: "register-has-bitfield", properties: {} },
      { id: "c", from: "register:seed", to: "register:three", type: "register-has-bitfield", properties: {} },
    ],
  };
  const manySeeds = [{ entityId: "register:seed", relatedEntityIds: ["register:seed", "register:one", "register:two", "register:three"] }];
  for (const maxEntities of [2, 3, 4]) {
    const context = buildBoundedQueryGraphContext(seedGraph, manySeeds, { maxEntities, maxRelationships: 10 });
    assert.ok(context.entities.length <= maxEntities);
    assert.equal(context.skippedSeedEntityCount, 4 - maxEntities);
    assert.equal(context.relationships.every((relationship) => context.entities.some((entity) => entity.id === relationship.from) && context.entities.some((entity) => entity.id === relationship.to)), true);
  }
  for (const maxRelationships of [2, 3, 4]) {
    const context = buildBoundedQueryGraphContext(seedGraph, [{ entityId: "register:seed" }], { maxEntities: 10, maxRelationships });
    assert.ok(context.entities.length <= 10);
    assert.ok(context.relationships.length <= maxRelationships);
    assert.deepEqual(context.relationships.map((relationship) => relationship.id), context.relationships.map((relationship) => relationship.id).filter((id, index, ids) => ids.indexOf(id) === index));
  }
});

test("repeated graph-context queries reuse one derived adjacency index", () => {
  const base = sequenceContextGraph();
  let entityIterations = 0;
  let relationshipIterations = 0;
  const observe = (values, increment) => new Proxy(values, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) increment();
      return Reflect.get(target, property, receiver);
    },
  });
  const graph = {
    ...base,
    entities: observe(base.entities, () => { entityIterations += 1; }),
    relationships: observe(base.relationships, () => { relationshipIterations += 1; }),
  };
  const evidence = [{ entityId: "step:1" }];
  const first = buildBoundedQueryGraphContext(graph, evidence);
  const second = buildBoundedQueryGraphContext(graph, evidence);
  assert.deepEqual(second, first);
  assert.equal(entityIterations, 1);
  assert.equal(relationshipIterations, 1);
});

test("identical exact graph queries scan entity candidates once", () => {
  const values = Array.from({ length: 2_000 }, (_, index) => ({
    id: `register:${index}`,
    type: "register",
    canonicalName: index === 1999 ? "DMAC_DCTRL" : `OTHER_${index}`,
    aliases: index === 1999 ? ["DCTRL"] : [],
    properties: {},
    confidence: "high",
  }));
  let iterations = 0;
  const graph = {
    entities: new Proxy(values, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) iterations += 1;
        return Reflect.get(target, property, receiver);
      },
    }),
  };
  const first = exactGraphMatches(graph, "DMAC_DCTRL");
  const second = exactGraphMatches(graph, "DMAC_DCTRL");
  assert.equal(second, first);
  assert.equal(iterations, 1);
  assert.equal(second[0].entity.id, "register:1999");
});

test("exact graph retrieval is type-aware, searches structured evidence, and keeps qualified symbols indivisible", () => {
  const graph = { entities: [
    { id: "section:false-positive", type: "section", canonicalName: "DMAC status list 123", aliases: [], properties: { kind: "register chapter", number: "123" }, confidence: "high" },
    { id: "bitfield:module-name", type: "bitfield", canonicalName: "GBETH", aliases: [], properties: { register: "GLOBAL", bitRange: "42" }, confidence: "high" },
    { id: "bitfield:reserved", type: "bitfield", canonicalName: "RESERVED", aliases: [], properties: { register: "DMACm_DCTRL", bitRange: "31:8" }, confidence: "high" },
    { id: "caution:reserved", type: "caution", canonicalName: "DMA reserved bits", aliases: [], properties: { type: "reserved-bit", evidenceLines: ["DMA software must not modify reserved bits."] }, confidence: "high" },
    { id: "register:gbeth", type: "register", canonicalName: "ETHA_MACC", aliases: [], properties: { descriptions: ["GBETH Gigabit Ethernet MAC control block"] }, confidence: "high" },
    { id: "register:wdtrr", type: "register", canonicalName: "WDTm_WDTRR", aliases: ["WDTRR"], properties: {}, confidence: "high" },
    { id: "sequence:refresh", type: "sequence", canonicalName: "watchdog refresh", aliases: [], properties: { stepSummaries: ["WDTm_WDTRR 00h", "WDTm_WDTRR FFh"] }, confidence: "high" },
  ] };

  assert.deepEqual(exactGraphMatches(graph, "Find the nonexistent DMAC_ZZZ_NEVER_EXISTS_123 register."), []);
  assert.deepEqual(exactGraphMatches(graph, "Find the nonexistent GBETH_ZZZ_NEVER_EXISTS_123 register."), []);
  assert.equal(exactGraphMatches(graph, "What DMA reserved-bit cautions apply?")[0].entity.id, "caution:reserved");
  assert.equal(exactGraphMatches(graph, "Find GBETH, the Gigabit Ethernet block.")[0].entity.id, "register:gbeth");
  assert.equal(exactGraphMatches(graph, "Which value is written first to WDTm_WDTRR?").some((item) => item.entity.id === "sequence:refresh"), true);
});

test("requested entity types are promoted while retaining one exact hardware-symbol anchor", () => {
  const items = [
    { entity: { id: "register:dctrl", type: "register" }, retrievalReasons: ["exact symbol DMACM_DCTRL"] },
    { entity: { id: "section:dma", type: "section" }, retrievalReasons: ["lexical entity term dma"] },
    { entity: { id: "table:dctrl", type: "table" }, retrievalReasons: ["same-page neighborhood of ranked evidence"] },
  ];
  assert.deepEqual(prioritizeRequestedEntityTypes(items, "Locate the DMACm_DCTRL register table.").map((item) => item.entity.id), [
    "register:dctrl",
    "table:dctrl",
    "section:dma",
  ]);
});

test("section caution projection stays candidate-level and preserves source provenance", () => {
  const section = {
    id: "section:pfc-protection",
    type: "section",
    canonicalName: "Before changing GPIO multiplexed pin functions, write protection must be disabled",
    sourceLocations: [{ page: 239, chunkIds: ["manual.pdf:p239:c4"], sectionPath: ["PFC"], boundingBox: [], sourceArtifact: "sections.json", extractionMethod: "section-index", verificationStatus: "candidate" }],
    properties: {},
  };
  const rows = projectedCautionRows([{ entity: section, retrievalReasons: ["lexical entity term gpio", "lexical entity term multiplexed"] }], "What cautions apply before changing GPIO multiplexed pin functions?");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity.type, "caution");
  assert.equal(rows[0].entity.verificationStatus, "candidate");
  assert.equal(rows[0].evidence.kind, "caution");
  assert.equal(rows[0].evidence.page, 239);
  assert.equal(rows[0].evidence.sourceArtifact, "sections.json");
  assert.equal(rows[0].evidence.extractionMethod, "section-caution-semantic-projection");
});

test("entity evidence prefers corroborated locations when extraction scores are nearly tied", () => {
  const entity = {
    id: "register:wdtcr",
    type: "register",
    canonicalName: "WDTm_WDTCR",
    properties: {},
    sourceLocations: [
      { page: 1005, chunkIds: ["manual.pdf:p1005:c0"], sourceScore: 382 },
      { page: 1007, chunkIds: Array.from({ length: 8 }, (_, index) => `manual.pdf:p1007:c${index}`), sourceScore: 381 },
      { page: 27, chunkIds: Array.from({ length: 12 }, (_, index) => `manual.pdf:p27:c${index}`), sourceScore: 25 },
    ],
  };
  assert.equal(entityEvidence(entity).page, 1007);
});

test("section sequence projection remains an explicitly candidate locator", () => {
  const section = {
    id: "section:dma-start",
    type: "section",
    canonicalName: "Before enabling DMA, write the channel settings in this order",
    sourceLocations: [{ page: 819, chunkIds: [], sectionPath: ["DMAC"], boundingBox: [], sourceArtifact: "sections.json", extractionMethod: "section-index", verificationStatus: "candidate" }],
    properties: {},
  };
  const rows = projectedSequenceRows([{ entity: section, retrievalReasons: ["lexical entity term dma", "lexical entity term order"] }], "What is the DMA enable sequence?");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity.type, "sequence");
  assert.equal(rows[0].entity.verificationStatus, "candidate");
  assert.equal(rows[0].evidence.extractionMethod, "section-sequence-semantic-projection");
});

test("large graph lexical fusion guard is explicit and configurable", () => {
  assert.deepEqual(shouldUseInProcessLexicalFusion({ entityCount: 10, relationshipCount: 20 }, 75_000), {
    enabled: true,
    graphItems: 30,
    limit: 75_000,
  });
  assert.deepEqual(shouldUseInProcessLexicalFusion({ entityCount: 47_013, relationshipCount: 101_973 }, 75_000), {
    enabled: false,
    graphItems: 148_986,
    limit: 75_000,
  });
});

test("conflict verification actions are typed and omit conflicts without pages", () => {
  assert.deepEqual(conflictVerificationActions({ entityId: "register:dctrl", field: "offset", pages: [7] }, "manual.pdf"), [{
    tool: "read_pdf_pages",
    arguments: { filename: "manual.pdf", start_page: 7, end_page: 7 },
    reason: "Resolve offset conflict for register:dctrl.",
  }]);
  assert.deepEqual(conflictVerificationActions({ entityId: "register:dctrl", field: "offset", pages: [] }, "manual.pdf"), []);
});

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

test("RRF retains the distinct provenance location for every contributing channel", () => {
  const entity = { id: "register:dctrl", confidence: "high" };
  const fused = reciprocalRankFuse([
    { name: "exact", results: [{ entity, evidence: { id: "exact-evidence", page: 1, chunkId: "manual.pdf:p1:c0", sourceArtifact: "registers" } }] },
    { name: "lexical", results: [{ entity, evidence: { id: "lexical-evidence", page: 2, chunkId: "manual.pdf:p2:c0", sourceArtifact: "chunk-index" } }] },
  ]);
  assert.deepEqual(fused[0].channelEvidence, {
    exact: [{ id: "exact-evidence", page: 1, chunkId: "manual.pdf:p1:c0", sourceArtifact: "registers" }],
    lexical: [{ id: "lexical-evidence", page: 2, chunkId: "manual.pdf:p2:c0", sourceArtifact: "chunk-index" }],
  });
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
