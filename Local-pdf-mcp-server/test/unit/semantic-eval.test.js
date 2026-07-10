import assert from "node:assert/strict";
import test from "node:test";
import { compareSemanticRegression, evaluateSemanticGoldenDataset, validateSemanticGoldenDataset } from "../../src/eval/semantic.js";

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
