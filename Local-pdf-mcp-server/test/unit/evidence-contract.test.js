import assert from "node:assert/strict";
import test from "node:test";
import { createEvidenceBundleV2, evidenceContractMissingFields, normalizeEvidenceContract, validateEvidenceBundleV2 } from "../../src/evidence/contract.js";

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
    evidence: [{ id: "e1" }],
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
