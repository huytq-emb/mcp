import assert from "node:assert/strict";
import test from "node:test";
import { createEvidenceBundleV2, evidenceContractMissingFields, normalizeEvidenceContract, validateEvidenceBundleV2 } from "../../src/evidence/contract.js";
import { evidenceFactFromResult } from "../../src/workflows/evidence-orchestrator.js";

test("normalizeEvidenceContract maps legacy inference to inferences", () => {
  const contract = normalizeEvidenceContract({
    schemaVersion: 1,
    serverVersion: "test",
    filename: "manual.pdf",
    tool: "find_register",
    query: "WDTCR",
    inference: [{ statement: "candidate" }],
  });

  assert.equal(contract.input.query, "WDTCR");
  assert.equal(contract.inferences.length, 1);
  assert.deepEqual(evidenceContractMissingFields(contract), []);
});

test("EvidenceBundle v2 normalizes explicit pagination and validates direct structured fields", () => {
  const bundle = createEvidenceBundleV2({
    serverVersion: "unit",
    tool: "query_manual",
    filename: "manual.pdf",
    sourceFingerprint: "unit",
    input: { query: "DCTRL" },
    summary: {},
    facts: [],
    evidence: [{ id: "e1", kind: "register", statement: "DCTRL", page: 1, chunkId: "manual.pdf:p1:c0", sectionPath: [], boundingBox: [], sourceArtifact: "chunk-index", extractionMethod: "unit", confidence: "medium", verificationStatus: "candidate", relatedEntityIds: [], retrieval: { sourceChannels: ["unit"], reasons: ["unit"], rank: 1, query: "DCTRL" } }],
    inferences: [],
    conflicts: [],
    gaps: [],
    needsVerification: [],
    warnings: [],
    recommendedNextActions: [],
    pagination: { total: 3, returned: 1, truncated: true, nextCursor: "1" },
  });
  assert.equal(bundle.schemaVersion, 2);
  assert.equal(bundle.pagination.nextCursor, "1");
  assert.deepEqual(validateEvidenceBundleV2(bundle), { ok: true, errors: [] });
});

test("high extraction confidence alone cannot promote an entity to a fact", () => {
  const result = { entity: { id: "register:test", type: "register", canonicalName: "TEST", aliases: [], properties: {}, confidence: "high", verificationStatus: "candidate" }, evidence: { id: "evidence:test" } };
  assert.equal(evidenceFactFromResult(result), null);
  result.entity.verificationStatus = "verified";
  assert.deepEqual(evidenceFactFromResult(result).evidenceIds, ["evidence:test"]);
});

function validBundle() {
  return createEvidenceBundleV2({
    serverVersion: "unit",
    tool: "query_manual",
    filename: "manual.pdf",
    sourceFingerprint: "unit",
    input: { query: "DCTRL" },
    summary: {},
    facts: [{ id: "register:dctrl", kind: "register", canonicalName: "DCTRL", aliases: [], properties: {}, confidence: "high", verificationStatus: "verified", evidenceIds: ["e1"] }],
    evidence: [{ id: "e1", entityId: "register:dctrl", kind: "register", statement: "DCTRL", page: 1, chunkId: "manual.pdf:p1:c0", sectionPath: [], boundingBox: [], sourceArtifact: "chunk-index", extractionMethod: "unit", confidence: "high", verificationStatus: "verified", relatedEntityIds: ["register:dctrl"], retrieval: { entityId: "register:dctrl", sourceChannels: ["exact"], channelRanks: { exact: 1 }, reasons: ["exact"], rank: 1, query: "DCTRL" } }],
    inferences: [], conflicts: [], gaps: [], needsVerification: [], warnings: [], recommendedNextActions: [],
    pagination: { total: 1, returned: 1, truncated: false, nextCursor: null },
  });
}

test("EvidenceBundle v2 rejects duplicate IDs, dangling references, and invalid pagination", () => {
  const duplicateEvidence = structuredClone(validBundle());
  duplicateEvidence.evidence.push(structuredClone(duplicateEvidence.evidence[0]));
  duplicateEvidence.pagination.returned = 2;
  duplicateEvidence.pagination.total = 2;
  assert.equal(validateEvidenceBundleV2(duplicateEvidence).errors.some((error) => error.includes("duplicate evidence id")), true);

  const dangling = structuredClone(validBundle());
  dangling.facts[0].evidenceIds = ["missing"];
  assert.equal(validateEvidenceBundleV2(dangling).errors.some((error) => error.includes("references missing evidence")), true);

  const duplicateFacts = structuredClone(validBundle());
  duplicateFacts.facts.push(structuredClone(duplicateFacts.facts[0]));
  assert.equal(validateEvidenceBundleV2(duplicateFacts).errors.some((error) => error.includes("duplicate fact id")), true);

  const pagination = structuredClone(validBundle());
  pagination.pagination = { total: 0, returned: 2, truncated: false, nextCursor: "cursor" };
  const paginationErrors = validateEvidenceBundleV2(pagination).errors.join("; ");
  assert.match(paginationErrors, /returned must equal|total must be|truncated must match/);
});

test("EvidenceBundle v2 accepts bounded sparse-alias resolution provenance", () => {
  const bundle = validBundle();
  bundle.entities = [{
    id: "register:dctrl", type: "register", canonicalName: "DCTRL", displayName: "DCTRL", aliases: [], aliasVariants: ["DCTRL"],
    sourceLocations: [{ page: 1, chunkIds: ["manual.pdf:p1:c0"], sectionPath: [], boundingBox: [], sourceArtifact: "registers", extractionMethod: "unit", verificationStatus: "candidate", sourceScore: 50, resolutionStatus: "merged-sparse-alias" }],
    confidence: "medium", extractionMethod: "unit", verificationStatus: "candidate", properties: {},
  }];
  assert.deepEqual(validateEvidenceBundleV2(bundle), { ok: true, errors: [] });
});

test("EvidenceBundle v2 enforces figure, OCR, conflict, and action semantics", () => {
  const invalidFigure = structuredClone(validBundle());
  invalidFigure.evidence[0].kind = "figure";
  assert.equal(validateEvidenceBundleV2(invalidFigure).ok, false);

  const invalidOcr = structuredClone(validBundle());
  Object.assign(invalidOcr.evidence[0], { kind: "figure-ocr-locator", figureId: "p1_f001", extractionMethod: "ocr", verificationStatus: "candidate" });
  assert.equal(validateEvidenceBundleV2(invalidOcr).ok, false);

  const invalidConflict = structuredClone(validBundle());
  invalidConflict.conflicts = [{ id: "c1", entityId: "register:dctrl", field: "offset", values: ["0", "0"], pages: [1], reason: "conflict", verificationStatus: "conflicted", recommendedVerification: ["read page"] }];
  assert.equal(validateEvidenceBundleV2(invalidConflict).ok, false);

  const invalidAction = structuredClone(validBundle());
  invalidAction.recommendedNextActions = [{ tool: "unknown_tool", arguments: {}, reason: "invalid" }, { tool: "get_figure_context_pack", arguments: { filename: "manual.pdf" }, reason: "missing figure" }];
  assert.equal(validateEvidenceBundleV2(invalidAction).ok, false);
});
