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
