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
  additionalProperties: true,
  required: EVIDENCE_BUNDLE_V2_REQUIRED_FIELDS,
  properties: {
    schemaVersion: { const: 2 },
    serverVersion: { type: "string", minLength: 1 },
    tool: { type: "string", minLength: 1 },
    filename: { type: "string", minLength: 1 },
    sourceFingerprint: { type: "string", minLength: 1 },
    input: { type: "object" },
    summary: { type: "object" },
    facts: { type: "array" },
    evidence: { type: "array" },
    inferences: { type: "array" },
    conflicts: { type: "array" },
    gaps: { type: "array" },
    needsVerification: { type: "array" },
    warnings: { type: "array", items: { type: "string" } },
    recommendedNextActions: { type: "array" },
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
});

const validateEvidenceBundleV2Schema = new Ajv({ allErrors: true, strict: false }).compile(EVIDENCE_BUNDLE_V2_SCHEMA);

function array(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function boundedInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback;
}

export function normalizeEvidenceBundleV2(bundle = {}) {
  const evidence = array(bundle.evidence);
  const pagination = bundle.pagination || {};
  const total = boundedInteger(pagination.total, evidence.length);
  const returned = boundedInteger(pagination.returned, evidence.length);
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
    warnings: array(bundle.warnings).map((item) => String(item)),
    recommendedNextActions: array(bundle.recommendedNextActions),
    pagination: {
      total: Math.max(total, returned),
      returned: Math.min(returned, Math.max(total, returned)),
      truncated: Boolean(pagination.truncated),
      nextCursor: pagination.nextCursor === undefined ? null : (pagination.nextCursor === null ? null : String(pagination.nextCursor)),
    },
  };
}

export function validateEvidenceBundleV2(bundle = {}) {
  const valid = validateEvidenceBundleV2Schema(bundle);
  return {
    ok: Boolean(valid),
    errors: valid ? [] : (validateEvidenceBundleV2Schema.errors || []).map((error) => `${error.instancePath || "/"} ${error.message || "is invalid"}`),
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
