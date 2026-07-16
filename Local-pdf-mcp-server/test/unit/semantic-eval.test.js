import assert from "node:assert/strict";
import test from "node:test";
import { compareSemanticRegression, evaluateCoverageExpectation, evaluateSemanticGoldenDataset, validateSemanticGoldenDataset } from "../../src/eval/semantic.js";

const dataset = {
  schemaVersion: 1,
  type: "semantic-golden-dataset",
  id: "unit-dma",
  subsystem: "dma",
  manual: { filename: "unit.pdf", verification: { status: "manually-verified" } },
  cases: [{
    id: "dctrl",
    query: "What is DCTRL offset and LWCA field?",
    expectedFacts: [
      { id: "dctrl", kind: "register", canonicalName: "DCTRL", page: 4, offset: "0300h", reset: "0", accessSize: "32" },
      { id: "lwca", kind: "bitfield", canonicalName: "LWCA", page: 4, access: "R/W", reset: "0" },
    ],
  }],
  thresholds: { metrics: { recallAt5: { min: 1 }, bitfieldExactMatchAccuracy: { min: 1 }, unsupportedClaimRate: { max: 0 } } },
};

function sequenceEvaluationBundle({ orders = [], orderingRelationships = [] } = {}) {
  const stepNames = ["write A", "write B", "write C"];
  return {
    evidence: [{ id: "sequence-evidence", entityId: "sequence:target", kind: "sequence", canonicalName: "Target sequence", statement: "Target sequence", page: 2 }],
    entities: [
      { id: "sequence:target", type: "sequence", canonicalName: "Target sequence", properties: {}, aliases: [] },
      ...stepNames.map((name, index) => ({ id: `step:${String.fromCharCode(97 + index)}`, type: "sequence-step", canonicalName: name, properties: orders[index] === undefined ? {} : { order: orders[index] }, aliases: [] })),
    ],
    relationships: [
      ...stepNames.map((name, index) => ({ id: `has-${index + 1}`, from: "sequence:target", to: `step:${String.fromCharCode(97 + index)}`, type: "sequence-has-step", properties: {} })),
      ...orderingRelationships,
    ],
  };
}

function sequenceCoverageReport(bundle, expectedSteps = ["write A", "write B", "write C"]) {
  const sequenceDataset = {
    ...dataset,
    cases: [{ id: "sequence", query: "Target sequence", expectedFacts: [{ id: "target-sequence", kind: "sequence", canonicalName: "Target sequence", page: 2, sequenceSteps: expectedSteps }] }],
    thresholds: { metrics: {} },
  };
  return evaluateSemanticGoldenDataset(sequenceDataset, { sequence: { bundle } });
}

test("semantic evaluator scores facts, provenance, properties, and latency", () => {
  assert.deepEqual(validateSemanticGoldenDataset(dataset), { ok: true, errors: [] });
  const report = evaluateSemanticGoldenDataset(dataset, {
    dctrl: {
      latencyMs: 15,
      indexingDurationMs: 80,
      peakRssMb: 64,
      bundle: {
        facts: [
          { id: "dctrl", kind: "register", canonicalName: "DCTRL", properties: { offsets: ["0300h"], resets: ["0"], accessSizes: ["32"] }, evidenceIds: ["e1"] },
          { id: "lwca", kind: "bitfield", canonicalName: "LWCA", properties: { access: "R/W", reset: "0" }, evidenceIds: ["e2"] },
        ],
        evidence: [{ id: "e1", kind: "register", statement: "DCTRL", page: 4 }, { id: "e2", kind: "bitfield", statement: "LWCA", page: 4 }],
      },
    },
  });
  assert.equal(report.health, "ok");
  assert.equal(report.metrics.recallAt5, 1);
  assert.equal(report.metrics.offsetResetAccessExactMatchAccuracy, 1);
  assert.equal(report.metrics.p95LatencyMs, 15);
});

test("semantic regression gate rejects quality decreases and duplicate increases", () => {
  const regression = compareSemanticRegression(
    { recallAt5: 0.8, duplicateEvidenceRate: 0.2 },
    { recallAt5: 0.9, duplicateEvidenceRate: 0.1 },
    { recallAt5: 0.01, duplicateEvidenceRate: 0.01 },
  );
  assert.equal(regression.ok, false);
  assert.equal(regression.failures.length, 2);
});

test("semantic evaluator rejects invalid datasets and dangling fact evidence", () => {
  const invalid = { ...dataset, manual: { filename: "not-a-pdf" }, cases: [] };
  assert.equal(validateSemanticGoldenDataset(invalid).ok, false);
  const report = evaluateSemanticGoldenDataset(dataset, {
    dctrl: {
      bundle: {
        facts: [{ id: "dctrl", kind: "register", canonicalName: "DCTRL", properties: {}, evidenceIds: ["missing"] }],
        evidence: [],
      },
    },
  });
  assert.equal(report.metrics.unsupportedClaimRate, 1);
});

test("semantic evaluator fails incorrect verified pages and register properties", () => {
  const report = evaluateSemanticGoldenDataset(dataset, {
    dctrl: {
      bundle: {
        facts: [{ id: "dctrl", kind: "register", canonicalName: "DCTRL", properties: { offsets: ["9999h"], resets: ["1"], accessSizes: ["8"] }, evidenceIds: ["e1"] }],
        evidence: [{ id: "e1", kind: "register", statement: "DCTRL", page: 99 }],
      },
    },
  });
  assert.equal(report.health, "fail");
  assert.equal(report.metrics.evidencePageCorrectness, 0);
  assert.equal(report.metrics.offsetResetAccessExactMatchAccuracy, 0);
});

test("semantic MRR follows retrieval order even when facts contain the expected entity", () => {
  const eightRows = Array.from({ length: 8 }, (_, index) => ({ id: `e${index + 1}`, kind: "register", canonicalName: index === 7 ? "DCTRL" : `OTHER_${index}`, statement: index === 7 ? "DCTRL" : `OTHER_${index}`, page: 4, retrieval: { rank: index + 1 } }));
  const report = evaluateSemanticGoldenDataset(dataset, { dctrl: { bundle: { facts: [{ id: "dctrl", kind: "register", canonicalName: "DCTRL", aliases: [], properties: {}, confidence: "high", verificationStatus: "verified", evidenceIds: ["e8"] }], evidence: [...eightRows, { id: "b1", kind: "bitfield", canonicalName: "LWCA", statement: "LWCA", page: 4, retrieval: { rank: 9 } }] } } });
  // The register is rank 8 and the bitfield rank 9; verified facts never
  // promote either retrieval result to rank one.
  assert.equal(report.metrics.meanReciprocalRank, Number(((1 / 8 + 1 / 9) / 2).toFixed(6)));
});

test("hardware entities require exact canonical symbols or declared aliases", () => {
  assert.equal(evaluateCoverageExpectation({ expectation: { type: "entity", canonicalName: "EN", requiredEntityTypes: ["bitfield"] } }, { bundle: { evidence: [{ id: "e1", kind: "bitfield", canonicalName: "ENABLE", statement: "ENABLE", page: 1 }] } }).passed, false);
  assert.equal(evaluateCoverageExpectation({ expectation: { type: "entity", canonicalName: "EN", aliases: ["ENABLE"], requiredEntityTypes: ["bitfield"] } }, { bundle: { evidence: [{ id: "e1", kind: "bitfield", canonicalName: "ENABLE", statement: "ENABLE", page: 1 }] } }).passed, true);
});

test("sequence, caution, figure, and negative checks stay bound to their entities", () => {
  const bundle = {
    evidence: [{ id: "s", entityId: "sequence:target", kind: "sequence", canonicalName: "Target sequence", statement: "Target sequence", page: 2 }, { id: "c", entityId: "caution:other", kind: "caution", canonicalName: "Other caution", statement: "do not write", page: 2 }, { id: "f", entityId: "figure:other", kind: "figure", canonicalName: "Other figure", statement: "Other", page: 2, figureId: "fig-other" }],
    entities: [{ id: "sequence:target", type: "sequence", canonicalName: "Target sequence", properties: {}, aliases: [] }, { id: "sequence:other", type: "sequence", canonicalName: "Other sequence", properties: {}, aliases: [] }, { id: "step:other", type: "sequence-step", canonicalName: "write 1", properties: { order: 1 }, aliases: [] }, { id: "caution:other", type: "caution", canonicalName: "Other caution", properties: {}, aliases: [] }, { id: "figure:other", type: "figure", canonicalName: "Other figure", properties: { figureId: "fig-other", caption: "Other" }, aliases: [] }],
    relationships: [{ id: "r1", from: "sequence:other", to: "step:other", type: "sequence-has-step", properties: {} }],
  };
  const sequenceDataset = { ...dataset, cases: [{ ...dataset.cases[0], expectedFacts: [{ id: "target", kind: "sequence", canonicalName: "Target sequence", page: 2, sequenceSteps: ["write 1"], figureLocator: { figureId: "fig-target" } }] }], thresholds: { metrics: { sequenceStepCoverage: { min: 1 }, figureLocatorAccuracy: { min: 1 } } } };
  const report = evaluateSemanticGoldenDataset(sequenceDataset, { dctrl: { bundle } });
  assert.equal(report.metrics.sequenceStepCoverage, 0);
  assert.equal(report.metrics.figureLocatorAccuracy, 0);
  assert.equal(evaluateCoverageExpectation({ expectation: { type: "negative", forbiddenCanonicalNames: ["NO_SUCH_REG"], maxAcceptedRrfScore: 0.01, allowGenericCandidateEvidence: false } }, { bundle: { facts: [], evidence: [{ id: "e", entityId: "register:wrong", kind: "register", canonicalName: "REAL_REG", verificationStatus: "high-confidence", retrieval: { rrfScore: 0.5 } }] } }).passed, false);
  assert.equal(evaluateCoverageExpectation({ expectation: { type: "caution", requiredEntityTypes: ["caution"] } }, { bundle }).passed, true);
  assert.equal(evaluateCoverageExpectation({ expectation: { type: "caution", relatedEntityId: "register:target", requiredEntityTypes: ["caution"] } }, { bundle }).passed, false);
});

test("semantic text coverage requires the verified evidence page and preserves runtime-only reasons", () => {
  const query = { expectation: { type: "text", requiredText: "write 0b", allowedPages: [819], requiredEntityTypes: ["caution"] } };
  const matching = { bundle: { evidence: [{ id: "e1", kind: "caution", statement: "When writing to it, write 0b.", page: 819 }] } };
  const wrongPage = { bundle: { evidence: [{ id: "e1", kind: "caution", statement: "When writing to it, write 0b.", page: 900 }] } };
  assert.equal(evaluateCoverageExpectation(query, matching).passed, true);
  assert.equal(evaluateCoverageExpectation(query, wrongPage).passed, false);
  assert.deepEqual(
    evaluateCoverageExpectation({ expectation: { type: "runtime-only", reason: "manual-specific reason" } }, {}),
    { type: "runtime-only", evaluated: false, passed: true, reason: "manual-specific reason" },
  );
});

test("semantic sequence ordering accepts complete explicit and relationship orders", () => {
  assert.equal(sequenceCoverageReport(sequenceEvaluationBundle({ orders: [1, 2, 3] })).metrics.sequenceStepCoverage, 1);
  assert.equal(sequenceCoverageReport(sequenceEvaluationBundle({ orderingRelationships: [
    { id: "ab", from: "step:a", to: "step:b", type: "sequence-step-occurs-before", properties: {} },
    { id: "bc", from: "step:b", to: "step:c", type: "sequence-step-occurs-before", properties: {} },
  ] })).metrics.sequenceStepCoverage, 1);
});

test("semantic sequence ordering rejects duplicate, missing, partial, cyclic, disconnected, and reversed orders", () => {
  assert.equal(sequenceCoverageReport(sequenceEvaluationBundle({ orders: [1, 1, 3] })).metrics.sequenceStepCoverage, 0);
  assert.equal(sequenceCoverageReport(sequenceEvaluationBundle({ orders: [1, undefined, 3] })).metrics.sequenceStepCoverage, 0);
  assert.equal(sequenceCoverageReport(sequenceEvaluationBundle({ orderingRelationships: [
    { id: "ab", from: "step:a", to: "step:b", type: "sequence-step-occurs-before", properties: {} },
  ] })).metrics.sequenceStepCoverage, 0);
  assert.equal(sequenceCoverageReport(sequenceEvaluationBundle({ orderingRelationships: [
    { id: "ab", from: "step:a", to: "step:b", type: "sequence-step-occurs-before", properties: {} },
    { id: "ba", from: "step:b", to: "step:a", type: "sequence-step-occurs-before", properties: {} },
  ] })).metrics.sequenceStepCoverage, 0);
  assert.equal(sequenceCoverageReport(sequenceEvaluationBundle({ orderingRelationships: [
    { id: "ab", from: "step:a", to: "step:b", type: "sequence-step-occurs-before", properties: {} },
    { id: "bc", from: "step:b", to: "step:c", type: "sequence-step-occurs-before", properties: {} },
    { id: "dx", from: "step:outside", to: "step:a", type: "sequence-step-occurs-before", properties: {} },
  ] }), ["write C", "write B", "write A"]).metrics.sequenceStepCoverage, 0);
});

test("semantic caution matching checks every matching caution against the expected register relationship", () => {
  const baseBundle = {
    evidence: [{ id: "register-evidence", entityId: "register:b", kind: "register", canonicalName: "REGISTER_B", statement: "REGISTER_B", page: 2 }],
    entities: [
      { id: "register:a", type: "register", canonicalName: "REGISTER_A", properties: {}, aliases: [] },
      { id: "register:b", type: "register", canonicalName: "REGISTER_B", properties: {}, aliases: [] },
      { id: "caution:a", type: "caution", canonicalName: "Caution A", properties: { text: "reserved bits" }, aliases: [] },
      { id: "caution:b", type: "caution", canonicalName: "Caution B", properties: { text: "reserved bits" }, aliases: [] },
    ],
    relationships: [
      { id: "a", from: "register:a", to: "caution:a", type: "register-has-caution", properties: {} },
      { id: "b", from: "register:b", to: "caution:b", type: "register-has-caution", properties: {} },
    ],
  };
  const cautionDataset = {
    ...dataset,
    cases: [{ id: "register-b", query: "reserved bits for REGISTER_B", expectedFacts: [{ id: "register-b", kind: "register", entityId: "register:b", canonicalName: "REGISTER_B", page: 2, caution: "reserved bits" }] }],
    thresholds: { metrics: {} },
  };
  assert.equal(evaluateSemanticGoldenDataset(cautionDataset, { "register-b": { bundle: baseBundle } }).metrics.cautionRecall, 1);
  assert.equal(evaluateSemanticGoldenDataset(cautionDataset, { "register-b": { bundle: { ...baseBundle, entities: baseBundle.entities.filter((entity) => entity.id !== "caution:b"), relationships: baseBundle.relationships.filter((relationship) => relationship.id !== "b") } } }).metrics.cautionRecall, 0);
});
