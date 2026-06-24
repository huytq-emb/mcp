import assert from "node:assert/strict";
import test from "node:test";
import {
  createHybridQualityReport,
  validateHybridArtifactSemantics,
} from "../../src/app/hybrid-quality.js";

function goodStructuredValues() {
  const table = {
    tableId: "register-table:p1-1:0",
    kind: "register-table",
    page: 1,
    pageStart: 1,
    pageEnd: 1,
    layout: { columnRoles: [{ column: 0, role: "register" }], roleMap: { register: { column: 0, role: "register" } } },
    rows: [{
      rowId: "p1:t0:r0",
      sourcePage: 1,
      cells: ["Register Name", "Abbreviation"],
      cellBboxes: [{ x: 0, y: 0, width: 1, height: 1 }],
    }],
  };
  return {
    tables: { schemaVersion: 1, filename: "manual.pdf", tableCount: 1, tables: [table] },
    registers: {
      schemaVersion: 1,
      filename: "manual.pdf",
      registerCount: 1,
      registers: [{ name: "WDTM_WDTRR", displayName: "WDTm_WDTRR", pages: [1], offsetAddresses: ["000h"], evidence: [{ page: 1 }] }],
    },
    bitfields: {
      schemaVersion: 3,
      filename: "manual.pdf",
      bitfieldCount: 1,
      bitfields: [{ register: "WDTm_WDTRR", bitfield: "AVEE", bitPositionRange: "7", bitRange: "7", pages: [1], mappingStatus: "resolved", evidence: [{ page: 1 }] }],
    },
    cautions: {
      schemaVersion: 1,
      filename: "manual.pdf",
      cautionCount: 1,
      cautions: [{ id: "caution:p1:l1", page: 1, text: "Do not write reserved bits.", type: "reserved-bits", evidence: [{ page: 1 }] }],
    },
  };
}

test("hybrid semantic gate accepts structured artifact shape", () => {
  const checks = validateHybridArtifactSemantics(goodStructuredValues());
  assert.equal(checks.some((check) => check.status === "fail"), false);
});

test("hybrid semantic gate rejects broken counts and missing bit position", () => {
  const values = goodStructuredValues();
  values.bitfields.bitfieldCount = 2;
  values.bitfields.bitfields[0].bitPositionRange = "unknown";
  const checks = validateHybridArtifactSemantics(values);
  assert.equal(checks.some((check) => check.status === "fail"), true);
  assert.match(checks.flatMap((check) => check.errors).join("\n"), /bitfieldCount|missing bit position/);
});

test("hybrid quality report decision follows failure status", () => {
  const pass = createHybridQualityReport({ filename: "manual.pdf", operation: "structured.build", checks: [{ name: "x", status: "pass", errors: [], warnings: [] }] });
  assert.equal(pass.decision, "promote");
  const fail = createHybridQualityReport({ filename: "manual.pdf", operation: "structured.build", checks: [{ name: "x", status: "fail", errors: ["bad"], warnings: [] }] });
  assert.equal(fail.decision, "reject");
});
