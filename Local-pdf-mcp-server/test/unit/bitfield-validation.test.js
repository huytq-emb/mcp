import assert from "node:assert/strict";
import test from "node:test";
import { buildBitfieldConflicts, findBitfieldOverlaps, parseBitRange, validateBitfieldEntry } from "../../src/bitfields/validation.js";

const registers = { registers: [{ displayName: "CTRL", aliases: ["CTRL"], accessSizes: ["16 bits"] }] };

test("bitfield v3 validates range, field width, reset, and register width", () => {
  const result = validateBitfieldEntry({ register: "CTRL", bitfield: "MODE", bitPositionRange: "7:4", fieldBitRange: "3:0", access: "R/W", reset: "0h", mappingStatus: "direct", conflicts: [] }, registers);
  assert.equal(parseBitRange("7 to 4")?.width, 4);
  assert.equal(result.validationStatus, "valid");
  assert.equal(result.registerWidth, 16);
  assert.equal(result.fieldWidth, 4);
});

test("bitfield v3 reports conflicts and invalid widths", () => {
  const conflicts = buildBitfieldConflicts({ bitPositionRange: [{ value: "7:4" }, { value: "6:4" }] });
  const result = validateBitfieldEntry({ register: "CTRL", bitfield: "MODE", bitPositionRange: "17:14", fieldBitRange: "2:0", access: "R/W", reset: "8", mappingStatus: "direct", conflicts }, registers);
  assert.equal(result.validationStatus, "conflict");
  assert.match(result.validationIssues.join("\n"), /exceeds 16-bit register width/);
  assert.match(result.validationIssues.join("\n"), /differs from field-local width/);
});

test("bitfield overlap detection flags different fields sharing physical bits", () => {
  const overlaps = findBitfieldOverlaps([
    { id: "a", register: "CTRL", bitfield: "A", bitPositionRange: "7:4" },
    { id: "b", register: "CTRL", bitfield: "B", bitPositionRange: "5:2" },
  ]);
  assert.deepEqual(overlaps.get("a"), ["B"]);
  assert.deepEqual(overlaps.get("b"), ["A"]);
});
