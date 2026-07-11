import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVANCED_MANUAL_INSPECTION_TOOL_NAMES,
  CONTROL_TOOL_NAMES,
  HIDDEN_COMPATIBILITY_TOOL_NAMES,
  PRIMARY_EVIDENCE_TOOL_NAMES,
  PRIMARY_PUBLIC_TOOL_NAMES,
  TOOL_CLASSIFICATION,
} from "../../src/mcp/tool-definitions/catalog.js";

test("public tool generations are explicit, disjoint, and preserve compatibility handlers", () => {
  const publicGenerations = [...PRIMARY_EVIDENCE_TOOL_NAMES, ...ADVANCED_MANUAL_INSPECTION_TOOL_NAMES, ...CONTROL_TOOL_NAMES];
  assert.equal(new Set(publicGenerations).size, publicGenerations.length);
  assert.deepEqual([...new Set(publicGenerations)].sort(), [...PRIMARY_PUBLIC_TOOL_NAMES].sort());
  assert.deepEqual(TOOL_CLASSIFICATION.compatibility, HIDDEN_COMPATIBILITY_TOOL_NAMES);
  assert.deepEqual(PRIMARY_EVIDENCE_TOOL_NAMES.slice(0, 4), ["query_manual", "get_manual_entity", "read_manual_evidence", "collect_manual_evidence"]);
  assert.equal(PRIMARY_EVIDENCE_TOOL_NAMES.includes("get_figure_image"), true);
  assert.equal(CONTROL_TOOL_NAMES.includes("mcp_control"), true);
});
