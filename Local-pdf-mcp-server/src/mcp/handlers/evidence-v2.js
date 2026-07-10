import { evidenceBundleResult } from "../../core/runtime-helpers.js";
import {
  collectManualEvidenceBundle,
  formatEvidenceBundle,
  getManualEntityBundle,
  queryManualEvidenceBundle,
  readManualEvidenceBundle,
} from "../../workflows/evidence-orchestrator.js";

async function handle_query_manual(args = {}) {
  const bundle = await queryManualEvidenceBundle({
    filename: args.filename,
    query: String(args.query || "").trim(),
    register: String(args.register || "").trim(),
    topK: args.top_k,
    cursor: args.cursor || null,
    includeOcr: Boolean(args.include_ocr),
  });
  return evidenceBundleResult(formatEvidenceBundle(bundle), bundle);
}

async function handle_get_manual_entity(args = {}) {
  const bundle = await getManualEntityBundle({ filename: args.filename, entityId: String(args.entity_id || "").trim() });
  return evidenceBundleResult(formatEvidenceBundle(bundle), bundle);
}

async function handle_read_manual_evidence(args = {}) {
  const bundle = await readManualEvidenceBundle({
    filename: args.filename,
    entityId: String(args.entity_id || "").trim(),
    chunkId: String(args.chunk_id || "").trim(),
    page: args.page,
  });
  return evidenceBundleResult(formatEvidenceBundle(bundle), bundle);
}

async function handle_collect_manual_evidence(args = {}) {
  const bundle = await collectManualEvidenceBundle({
    filename: args.filename,
    task: String(args.task || "").trim(),
    moduleType: String(args.module_type || "").trim(),
    depth: String(args.depth || "standard").trim(),
    evidenceTypes: Array.isArray(args.evidence_types) ? args.evidence_types : [],
    topK: args.top_k,
    cursor: args.cursor || null,
  });
  return evidenceBundleResult(formatEvidenceBundle(bundle), bundle);
}

export function createEvidenceV2Handlers(_context = null) {
  return Object.freeze({
    query_manual: handle_query_manual,
    get_manual_entity: handle_get_manual_entity,
    read_manual_evidence: handle_read_manual_evidence,
    collect_manual_evidence: handle_collect_manual_evidence,
  });
}
