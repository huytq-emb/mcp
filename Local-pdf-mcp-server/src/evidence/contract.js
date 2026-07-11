import Ajv from "ajv";

export const EVIDENCE_CONTRACT_REQUIRED_FIELDS = [
  "schemaVersion",
  "serverVersion",
  "filename",
  "sourceFingerprint",
  "tool",
  "input",
  "evidence",
  "inferences",
  "needsVerification",
  "warnings",
  "recommendedNextTools",
];

export const EVIDENCE_BUNDLE_V2_REQUIRED_FIELDS = [
  "schemaVersion",
  "serverVersion",
  "tool",
  "filename",
  "sourceFingerprint",
  "input",
  "summary",
  "facts",
  "evidence",
  "inferences",
  "conflicts",
  "gaps",
  "needsVerification",
  "warnings",
  "recommendedNextActions",
  "pagination",
];

export const EVIDENCE_BUNDLE_V2_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: EVIDENCE_BUNDLE_V2_REQUIRED_FIELDS,
  properties: {
    schemaVersion: { const: 2 },
    serverVersion: { type: "string", minLength: 1 },
    tool: { type: "string", minLength: 1 },
    filename: { type: "string", minLength: 1 },
    sourceFingerprint: { type: "string", minLength: 1 },
    input: { type: "object", additionalProperties: true },
    summary: { type: "object", additionalProperties: true },
    facts: { type: "array", items: { $ref: "#/$defs/fact" } },
    evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
    inferences: { type: "array", items: { $ref: "#/$defs/inference" } },
    conflicts: { type: "array", items: { $ref: "#/$defs/conflict" } },
    gaps: { type: "array", items: { $ref: "#/$defs/gap" } },
    needsVerification: { type: "array", items: { $ref: "#/$defs/verificationNeed" } },
    warnings: { type: "array", items: { type: "string" } },
    recommendedNextActions: { type: "array", items: { $ref: "#/$defs/nextAction" } },
    entities: { type: "array", items: { $ref: "#/$defs/entity" } },
    relationships: { type: "array", items: { $ref: "#/$defs/relationship" } },
    pagination: {
      type: "object",
      required: ["total", "returned", "truncated", "nextCursor"],
      properties: {
        total: { type: "integer", minimum: 0 },
        returned: { type: "integer", minimum: 0 },
        truncated: { type: "boolean" },
        nextCursor: { type: ["string", "null"] },
      },
      additionalProperties: false,
    },
  },
  $defs: {
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    verificationStatus: { type: "string", enum: ["verified", "high-confidence", "candidate", "conflicted", "rejected-noise", "visual-verification-required"] },
    location: {
      type: "object", additionalProperties: false,
      required: ["page", "chunkIds", "sectionPath", "boundingBox", "sourceArtifact", "extractionMethod", "verificationStatus"],
      properties: {
        page: { type: ["integer", "null"], minimum: 1 }, chunkIds: { type: "array", items: { type: "string" } }, sectionPath: { type: "array", items: { type: "string" } }, boundingBox: { type: "array" }, sourceArtifact: { type: "string" }, extractionMethod: { type: "string" }, verificationStatus: { $ref: "#/$defs/verificationStatus" }, sourceScore: { type: "number" },
      },
    },
    entity: {
      type: "object", additionalProperties: false,
      required: ["id", "type", "canonicalName", "displayName", "aliases", "aliasVariants", "sourceLocations", "confidence", "extractionMethod", "verificationStatus", "properties"],
      properties: {
        id: { type: "string", minLength: 1 }, type: { type: "string", minLength: 1 }, canonicalName: { type: "string", minLength: 1 }, displayName: { type: "string", minLength: 1 }, aliases: { type: "array", items: { type: "string" } }, aliasVariants: { type: "array", items: { type: "string" } }, sourceLocations: { type: "array", items: { $ref: "#/$defs/location" } }, confidence: { $ref: "#/$defs/confidence" }, extractionMethod: { type: "string", minLength: 1 }, verificationStatus: { $ref: "#/$defs/verificationStatus" }, properties: { type: "object", additionalProperties: true },
      },
    },
    relationship: {
      type: "object", additionalProperties: false,
      required: ["id", "from", "to", "type", "properties"],
      properties: { id: { type: "string", minLength: 1 }, from: { type: "string", minLength: 1 }, to: { type: "string", minLength: 1 }, type: { type: "string", minLength: 1 }, properties: { type: "object", additionalProperties: true } },
    },
    evidence: {
      type: "object", additionalProperties: false,
      required: ["id", "kind", "statement", "page", "chunkId", "sectionPath", "boundingBox", "sourceArtifact", "extractionMethod", "confidence", "verificationStatus", "relatedEntityIds", "retrieval"],
      properties: {
        id: { type: "string", minLength: 1 }, entityId: { type: "string", minLength: 1 }, kind: { type: "string", minLength: 1 }, canonicalName: { type: "string", minLength: 1 }, statement: { type: "string" }, properties: { type: "object", additionalProperties: true }, page: { type: ["integer", "null"], minimum: 1 }, chunkId: { type: ["string", "null"] }, figureId: { type: "string", minLength: 1 }, imagePath: { type: "string" }, sectionPath: { type: "array", items: { type: "string" } }, boundingBox: { type: "array" }, sourceArtifact: { type: "string" }, extractionMethod: { type: "string", minLength: 1 }, confidence: { $ref: "#/$defs/confidence" }, verificationStatus: { $ref: "#/$defs/verificationStatus" }, relatedEntityIds: { type: "array", items: { type: "string", minLength: 1 } }, retrieval: { type: "object", additionalProperties: false, required: ["sourceChannels", "reasons", "rank", "query"], properties: { entityId: { type: "string", minLength: 1 }, sourceChannels: { type: "array", items: { type: "string" } }, channelRanks: { type: "object", additionalProperties: { type: "integer", minimum: 1 } }, channelEvidence: { type: "object", additionalProperties: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "page", "chunkId", "sourceArtifact"], properties: { id: { type: "string", minLength: 1 }, page: { type: ["integer", "null"] }, chunkId: { type: ["string", "null"] }, sourceArtifact: { type: "string" } } } } }, reasons: { type: "array", items: { type: "string" } }, rank: { type: "integer", minimum: 0 }, query: { type: "string" }, rrfScore: { type: "number" } } },
      },
      allOf: [
        { if: { properties: { kind: { enum: ["figure", "figure-ocr-locator"] } } }, then: { required: ["figureId"] } },
        { if: { properties: { kind: { const: "figure-ocr-locator" } }, required: ["kind"] }, then: { properties: { extractionMethod: { const: "optional-ocr-search-metadata" }, verificationStatus: { const: "visual-verification-required" } } } },
      ],
    },
    fact: { type: "object", additionalProperties: false, required: ["id", "kind", "canonicalName", "aliases", "properties", "confidence", "verificationStatus", "evidenceIds"], properties: { id: { type: "string", minLength: 1 }, kind: { type: "string", minLength: 1 }, canonicalName: { type: "string", minLength: 1 }, aliases: { type: "array", items: { type: "string" } }, properties: { type: "object", additionalProperties: true }, confidence: { $ref: "#/$defs/confidence" }, verificationStatus: { enum: ["verified", "high-confidence"] }, evidenceIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } } },
    inference: { type: "object", additionalProperties: false, required: ["statement", "basis", "confidence", "risk"], properties: { statement: { type: "string", minLength: 1 }, basis: { type: "string", minLength: 1 }, confidence: { $ref: "#/$defs/confidence" }, risk: { type: "string", minLength: 1 } } },
    conflict: { type: "object", additionalProperties: false, required: ["id", "entityId", "field", "values", "pages", "reason", "verificationStatus", "recommendedVerification"], properties: { id: { type: "string", minLength: 1 }, entityId: { type: "string", minLength: 1 }, field: { type: "string", minLength: 1 }, alias: { type: "string" }, candidateEntityIds: { type: "array", items: { type: "string", minLength: 1 } }, values: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string", minLength: 1 } }, pages: { type: "array", items: { type: "integer", minimum: 1 } }, reason: { type: "string", minLength: 1 }, verificationStatus: { const: "conflicted" }, recommendedVerification: { type: "array", items: { type: "string" } } } },
    gap: { type: "object", additionalProperties: false, required: ["item", "reason", "recommendedAction"], properties: { item: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 }, recommendedAction: { type: "string", minLength: 1 } } },
    verificationNeed: { type: "object", additionalProperties: false, required: ["item", "reason", "recommendedActions"], properties: { item: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 }, recommendedActions: { type: "array", items: { type: "string", minLength: 1 } } } },
    nextAction: { type: "object", additionalProperties: false, required: ["tool", "arguments", "reason"], properties: { tool: { type: "string", enum: ["query_manual", "get_manual_entity", "read_manual_evidence", "read_pdf_pages", "read_pdf_chunk", "extract_bitfield_table", "get_figure_context_pack", "get_figure_image", "search_figures", "mcp_control"] }, arguments: { type: "object", additionalProperties: true }, reason: { type: "string", minLength: 1 } } },
  },
});

const validateEvidenceBundleV2Schema = new Ajv({ allErrors: true, strict: false }).compile(EVIDENCE_BUNDLE_V2_SCHEMA);

function array(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeEvidenceBundleV2(bundle = {}) {
  const evidence = array(bundle.evidence);
  const pagination = bundle.pagination || {};
  const total = pagination.total === undefined ? evidence.length : pagination.total;
  const returned = pagination.returned === undefined ? evidence.length : pagination.returned;
  return {
    schemaVersion: 2,
    serverVersion: String(bundle.serverVersion || "unknown"),
    tool: String(bundle.tool || ""),
    filename: String(bundle.filename || ""),
    sourceFingerprint: String(bundle.sourceFingerprint || "unknown"),
    input: bundle.input && typeof bundle.input === "object" && !Array.isArray(bundle.input) ? bundle.input : {},
    summary: bundle.summary && typeof bundle.summary === "object" && !Array.isArray(bundle.summary) ? bundle.summary : {},
    facts: array(bundle.facts),
    evidence,
    inferences: array(bundle.inferences),
    conflicts: array(bundle.conflicts),
    gaps: array(bundle.gaps),
    needsVerification: array(bundle.needsVerification),
    warnings: array(bundle.warnings),
    recommendedNextActions: array(bundle.recommendedNextActions),
    ...(Array.isArray(bundle.entities) ? { entities: bundle.entities } : {}),
    ...(Array.isArray(bundle.relationships) ? { relationships: bundle.relationships } : {}),
    pagination: {
      total,
      returned,
      truncated: pagination.truncated === undefined ? false : pagination.truncated,
      nextCursor: pagination.nextCursor === undefined ? null : pagination.nextCursor,
    },
  };
}

export function validateEvidenceBundleV2(bundle = {}) {
  const valid = validateEvidenceBundleV2Schema(bundle);
  const errors = valid ? [] : (validateEvidenceBundleV2Schema.errors || []).map((error) => `${error.instancePath || "/"} ${error.message || "is invalid"}`);
  const evidenceIds = new Set();
  for (const item of bundle.evidence || []) {
    if (evidenceIds.has(item.id)) errors.push(`duplicate evidence id: ${item.id}`);
    evidenceIds.add(item.id);
  }
  const factIds = new Set();
  for (const fact of bundle.facts || []) {
    if (factIds.has(fact.id)) errors.push(`duplicate fact id: ${fact.id}`);
    factIds.add(fact.id);
  }
  const conflictIds = new Set();
  for (const conflict of bundle.conflicts || []) {
    if (conflictIds.has(conflict.id)) errors.push(`duplicate conflict id: ${conflict.id}`);
    conflictIds.add(conflict.id);
    if (new Set(conflict.values || []).size < 2) errors.push(`conflict ${conflict.id} must contain at least two distinct values`);
  }
  if (Number(bundle.pagination?.returned) !== (bundle.evidence || []).length) errors.push("pagination.returned must equal evidence.length");
  if (Number(bundle.pagination?.total) < Number(bundle.pagination?.returned)) errors.push("pagination.total must be greater than or equal to pagination.returned");
  if (Boolean(bundle.pagination?.truncated) !== (bundle.pagination?.nextCursor !== null && bundle.pagination?.nextCursor !== undefined)) errors.push("pagination.truncated must match whether nextCursor is present");
  for (const fact of bundle.facts || []) for (const evidenceId of fact.evidenceIds || []) if (!evidenceIds.has(evidenceId)) errors.push(`fact ${fact.id} references missing evidence: ${evidenceId}`);
  if (Array.isArray(bundle.entities)) {
    const entityIds = new Set();
    for (const entity of bundle.entities) {
      if (entityIds.has(entity.id)) errors.push(`duplicate entity id: ${entity.id}`);
      entityIds.add(entity.id);
    }
    const relationshipIds = new Set();
    for (const relation of bundle.relationships || []) {
      if (relationshipIds.has(relation.id)) errors.push(`duplicate relationship id: ${relation.id}`);
      relationshipIds.add(relation.id);
    }
    for (const relation of bundle.relationships || []) if (!entityIds.has(relation.from) || !entityIds.has(relation.to)) errors.push(`relationship ${relation.id} references an entity outside this bundle`);
    for (const item of bundle.evidence || []) for (const entityId of item.relatedEntityIds || []) if (!entityIds.has(entityId)) errors.push(`evidence ${item.id} references an entity outside this bundle`);
  }
  for (const action of bundle.recommendedNextActions || []) {
    if (["get_figure_context_pack", "get_figure_image"].includes(action.tool) && !String(action.arguments?.figure_id || "").trim()) errors.push(`${action.tool} action requires a non-empty figure_id`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function createEvidenceBundleV2(bundle = {}) {
  const normalized = normalizeEvidenceBundleV2(bundle);
  const validation = validateEvidenceBundleV2(normalized);
  if (!validation.ok) throw new Error(`Invalid EvidenceBundle v2: ${validation.errors.join("; ")}`);
  return normalized;
}

export function normalizeEvidenceContract(contract = {}) {
  const inferenceItems = contract.inferences || contract.inference || [];
  return {
    schemaVersion: contract.schemaVersion,
    serverVersion: contract.serverVersion,
    filename: contract.filename || "",
    sourceFingerprint: contract.sourceFingerprint || "unknown",
    tool: contract.tool || "",
    input: contract.input || {
      query: contract.query || "",
    },
    evidence: Array.isArray(contract.evidence) ? contract.evidence : [],
    inferences: Array.isArray(inferenceItems) ? inferenceItems : [],
    needsVerification: Array.isArray(contract.needsVerification) ? contract.needsVerification : [],
    warnings: Array.isArray(contract.warnings) ? contract.warnings : [],
    recommendedNextTools: Array.isArray(contract.recommendedNextTools) ? contract.recommendedNextTools : [],
    rule: contract.rule || "Manual evidence and verified visual evidence can support driver facts; search-only evidence is only a lead until verified.",
  };
}

export function evidenceContractMissingFields(contract = {}) {
  return EVIDENCE_CONTRACT_REQUIRED_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(contract, field));
}
