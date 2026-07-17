import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { createRuntimeToolRegistry } from "../../src/mcp/runtime-registry.js";
import { ALL_TOOL_DEFINITIONS, HIDDEN_TOOL_DEFINITIONS, PUBLIC_TOOL_DEFINITIONS } from "../../src/mcp/tool-definitions.js";
import { scanToolSchemaKeywords, validateAdvertisedToolSchemaCompatibility } from "../../src/mcp/schema-compatibility.js";

const forbiddenTopLevel = ["oneOf", "anyOf", "allOf"];

test("public tool schemas are Databricks-compatible object schemas", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const tool of PUBLIC_TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema?.type, "object", `${tool.name} must have object inputSchema`);
    for (const keyword of forbiddenTopLevel) {
      assert.equal(Object.hasOwn(tool.inputSchema, keyword), false, `${tool.name} has unsupported top-level ${keyword}`);
    }
    assert.doesNotThrow(() => ajv.compile(tool.inputSchema), `${tool.name} inputSchema must compile with AJV`);
  }
});

test("tool names and public/hidden classification are disjoint", () => {
  const publicNames = PUBLIC_TOOL_DEFINITIONS.map((tool) => tool.name);
  const hiddenNames = HIDDEN_TOOL_DEFINITIONS.map((tool) => tool.name);
  assert.equal(new Set(publicNames).size, publicNames.length, "public tool names must be unique");
  assert.equal(new Set(hiddenNames).size, hiddenNames.length, "hidden tool names must be unique");
  assert.deepEqual(publicNames.filter((name) => hiddenNames.includes(name)), []);
  assert.equal(ALL_TOOL_DEFINITIONS.length, publicNames.length + hiddenNames.length);
});

test("registry advertises the catalog definitions without incompatible wrapping", () => {
  const registry = createRuntimeToolRegistry();
  assert.equal(registry.advertisedCount, PUBLIC_TOOL_DEFINITIONS.length);
  assert.deepEqual(registry.definitions.map((tool) => tool.name), PUBLIC_TOOL_DEFINITIONS.map((tool) => tool.name));
  validateAdvertisedToolSchemaCompatibility(registry.definitions, { classification: "public" });
});

test("compatibility preflight reports public top-level combinators with tool and path", () => {
  assert.throws(
    () => validateAdvertisedToolSchemaCompatibility([{ name: "bad_tool", inputSchema: { type: "object", anyOf: [] } }], { classification: "public" }),
    /public tool bad_tool has unsupported top-level anyOf at inputSchema\/anyOf/,
  );
});

test("schema keyword scanner distinguishes top-level and nested keywords", () => {
  const hits = scanToolSchemaKeywords({ name: "nested", inputSchema: { type: "object", properties: { value: { oneOf: [{ type: "string" }] } } } });
  assert.deepEqual(hits, [{ keyword: "oneOf", path: "inputSchema/properties/value/oneOf", topLevel: false }]);
});
