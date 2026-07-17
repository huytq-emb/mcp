#!/usr/bin/env node
import Ajv from "ajv";
import { ALL_TOOL_DEFINITIONS, HIDDEN_TOOL_DEFINITIONS, PUBLIC_TOOL_DEFINITIONS } from "../src/mcp/tool-definitions.js";
import { scanToolSchemaKeywords, TOP_LEVEL_FORBIDDEN_COMBINATORS } from "../src/mcp/schema-compatibility.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const groups = [
  ["public", PUBLIC_TOOL_DEFINITIONS],
  ["hidden", HIDDEN_TOOL_DEFINITIONS],
  ["all", ALL_TOOL_DEFINITIONS],
];
let failures = 0;

console.log(`Public tool count: ${PUBLIC_TOOL_DEFINITIONS.length}`);
PUBLIC_TOOL_DEFINITIONS.forEach((tool, index) => console.log(`${String(index).padStart(2, "0")} ${tool.name}`));

for (const [classification, tools] of groups) {
  console.log(`\n[${classification}] count=${tools.length}`);
  for (const tool of tools) {
    if (classification !== "all") {
      if (tool.inputSchema?.type !== "object") {
        console.log(`FAIL ${classification} ${tool.name}: inputSchema type is not object`);
        if (classification === "public") failures += 1;
      }
      try { ajv.compile(tool.inputSchema); }
      catch (error) {
        console.log(`FAIL ${classification} ${tool.name}: AJV compile failed: ${error.message}`);
        if (classification === "public") failures += 1;
      }
    }
    const hits = scanToolSchemaKeywords(tool);
    for (const hit of hits) {
      const level = hit.topLevel ? "top-level" : "nested";
      console.log(`${level} ${classification} ${tool.name}: ${hit.keyword} at ${hit.path}`);
      if (classification === "public" && hit.topLevel && TOP_LEVEL_FORBIDDEN_COMBINATORS.includes(hit.keyword)) failures += 1;
    }
  }
}

if (failures) {
  console.error(`\nSchema audit failed: ${failures} public top-level compatibility problem(s).`);
  process.exit(1);
}
console.log("\nSchema audit passed: no public tool has top-level oneOf, anyOf, or allOf.");
