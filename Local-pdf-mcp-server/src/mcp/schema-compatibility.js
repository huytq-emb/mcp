export const TOP_LEVEL_FORBIDDEN_COMBINATORS = Object.freeze(["oneOf", "anyOf", "allOf"]);
export const SCHEMA_AUDIT_KEYWORDS = Object.freeze([
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
  "definitions",
  "$defs",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
  "unevaluatedProperties",
  "contains",
  "prefixItems",
]);

function scanValue(value, path, hits) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanValue(item, `${path}/${index}`, hits));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    if (SCHEMA_AUDIT_KEYWORDS.includes(key)) hits.push({ keyword: key, path: childPath, topLevel: path === "inputSchema" });
    scanValue(child, childPath, hits);
  }
}

export function scanToolSchemaKeywords(tool) {
  const hits = [];
  scanValue(tool?.inputSchema, "inputSchema", hits);
  return hits;
}

export function validateAdvertisedToolSchemaCompatibility(definitions = [], { classification = "public" } = {}) {
  const errors = [];
  for (const tool of definitions || []) {
    for (const hit of scanToolSchemaKeywords(tool)) {
      if (hit.topLevel && TOP_LEVEL_FORBIDDEN_COMBINATORS.includes(hit.keyword)) {
        errors.push(`${classification} tool ${tool.name} has unsupported top-level ${hit.keyword} at ${hit.path}`);
      }
    }
  }
  if (errors.length) throw new Error(`Tool schema compatibility check failed:\n${errors.join("\n")}`);
  return true;
}
