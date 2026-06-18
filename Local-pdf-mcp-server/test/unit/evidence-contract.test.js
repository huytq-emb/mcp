import assert from "node:assert/strict";
import test from "node:test";
import { evidenceContractMissingFields, normalizeEvidenceContract } from "../../src/evidence/contract.js";

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
