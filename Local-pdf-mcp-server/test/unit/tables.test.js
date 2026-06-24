import assert from "node:assert/strict";
import test from "node:test";
import { canStitchTables, selectTableCandidatePages, stitchTablesAcrossPages } from "../../src/domains/tables.js";

function table(page, rows, options = {}) {
  return {
    page,
    kind: options.kind || "bitfield-table",
    confidence: 80,
    headerText: "Bit Bit Name Access Initial Value Description",
    columns: [0, 1, 2, 3, 4].map((index) => ({ index, x: index * 100 })),
    layout: {
      headerRowIndex: 0,
      columnRoles: ["bit", "bitfield", "access", "reset", "description"].map((role, index) => ({ column: index, x: index * 100, role })),
      warnings: [],
    },
    rows: rows.map((text, index) => ({ text, cells: text.split("|"), sourceCells: [], isHeaderCandidate: index === 0, y: 700 - index * 20 })),
  };
}

test("table candidate selection uses strong headers and neighboring pages", () => {
  const pages = [
    { page: 1, text: "Overview" },
    { page: 2, text: "Register Name Offset Address Initial Value Access Size" },
    { page: 3, text: "continuation" },
    { page: 4, text: "plain text" },
  ];
  assert.deepEqual(selectTableCandidatePages({ pageCount: 4, pages }, { chunks: [] }), [1, 2, 3]);
});

test("multi-page table stitching removes repeated headers and keeps row provenance", () => {
  const first = table(10, ["Bit|Bit Name|Access|Initial Value|Description", "7|EN|RW|0|Enable"]);
  const second = table(11, ["Bit|Bit Name|Access|Initial Value|Description", "6|IE|RW|0|Interrupt enable"]);
  assert.equal(canStitchTables(first, second), true);
  const [stitched] = stitchTablesAcrossPages([first, second]);
  assert.equal(stitched.pageStart, 10);
  assert.equal(stitched.pageEnd, 11);
  assert.equal(stitched.rows.length, 3);
  assert.equal(stitched.rows[2].sourcePage, 11);
  assert.match(stitched.tableId, /p10-11/);
});

test("tables with different column anchors are not stitched", () => {
  const first = table(10, ["Bit|Name|Access|Reset|Description", "7|EN|RW|0|Enable"]);
  const second = table(11, ["Bit|Name|Access|Reset|Description", "6|IE|RW|0|IRQ"]);
  second.columns = second.columns.map((column) => ({ ...column, x: column.x + 60 }));
  assert.equal(canStitchTables(first, second), false);
});
