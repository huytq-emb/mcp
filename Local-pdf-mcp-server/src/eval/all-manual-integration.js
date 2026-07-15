import fs from "node:fs/promises";
import path from "node:path";
import { validateEvidenceBundleV2 } from "../evidence/contract.js";

export async function discoverPdfManuals(documentsDir, options = {}) {
  const fsOps = options.fs || fs;
  const root = path.resolve(documentsDir);
  const manuals = [];

  async function visit(directory) {
    const entries = await fsOps.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
        const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
        manuals.push({
          filename: entry.name,
          relativePath,
          absolutePath,
          nested: relativePath.includes("/"),
        });
      }
    }
  }

  try { await visit(root); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const counts = new Map();
  for (const manual of manuals) counts.set(manual.filename.toLowerCase(), (counts.get(manual.filename.toLowerCase()) || 0) + 1);
  return manuals.map((manual) => ({ ...manual, duplicateBasename: counts.get(manual.filename.toLowerCase()) > 1 }));
}

export function percentile(values, fraction) {
  const sorted = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function figureSearchArguments(filename, query, limit = 10) {
  return { filename, query, limit };
}

export function parseEmbeddedJson(text, marker = "Machine summary JSON:") {
  const input = String(text || "");
  const markerIndex = marker ? input.lastIndexOf(marker) : 0;
  if (marker && markerIndex < 0) return null;
  const start = input.indexOf("{", markerIndex + (marker ? marker.length : 0));
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const character = input[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(input.slice(start, index + 1));
    }
  }
  return null;
}

export function parseJobId(text) {
  return String(text || "").match(/Job ID:\s*([^\s]+)/i)?.[1] || "";
}

export function parseJobStatus(text) {
  return String(text || "").match(/^Status:\s*(queued|running|done|failed|cancelled)\s*$/im)?.[1]?.toLowerCase() || "unknown";
}

export function deterministicBundleSignature(bundle = {}) {
  return JSON.stringify({
    facts: (bundle.facts || []).map((item) => item.id),
    evidence: (bundle.evidence || []).map((item) => [item.id, item.entityId || "", item.page, item.retrieval?.rank]),
    entities: (bundle.entities || []).map((item) => item.id),
    relationships: (bundle.relationships || []).map((item) => item.id),
    conflicts: (bundle.conflicts || []).map((item) => item.id),
    gaps: (bundle.gaps || []).map((item) => item.id),
  });
}

export function validateBundleForManual(bundle, { filename, pageCount } = {}) {
  const errors = [];
  const contract = validateEvidenceBundleV2(bundle);
  if (!contract.ok) errors.push(...contract.errors);
  if (bundle?.filename !== filename) errors.push(`bundle filename mismatch: ${bundle?.filename || "missing"}`);
  for (const collection of ["facts", "evidence", "entities", "relationships", "conflicts", "gaps"]) {
    const ids = (bundle?.[collection] || []).map((item) => item.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) errors.push(`duplicate ${collection} IDs`);
  }
  const evidenceIds = new Set((bundle?.evidence || []).map((item) => item.id));
  for (const fact of bundle?.facts || []) {
    for (const evidenceId of fact.evidenceIds || []) if (!evidenceIds.has(evidenceId)) errors.push(`fact ${fact.id} references missing evidence ${evidenceId}`);
  }
  for (const item of bundle?.evidence || []) {
    if (item.page !== null && (!Number.isInteger(item.page) || item.page < 1 || item.page > pageCount)) {
      errors.push(`evidence ${item.id} has out-of-bounds page ${item.page}`);
    }
    if (!Number.isInteger(item.retrieval?.rank) || item.retrieval.rank < 0) errors.push(`evidence ${item.id} has invalid retrieval rank`);
  }
  for (const conflict of bundle?.conflicts || []) {
    for (const page of conflict.pages || []) if (page < 1 || page > pageCount) errors.push(`conflict ${conflict.id} has out-of-bounds page ${page}`);
  }
  const pagination = bundle?.pagination || {};
  if (pagination.returned !== (bundle?.evidence || []).length) errors.push("pagination.returned does not match evidence length");
  if (pagination.total < pagination.returned) errors.push("pagination.total is smaller than returned");
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateUnknownQueryBundle(bundle = {}) {
  const errors = [];
  if ((bundle.facts || []).length) errors.push("unknown query returned semantic facts");
  if ((bundle.entities || []).length) errors.push("unknown query returned resolved entities");
  const contextualEvidence = (bundle.evidence || []).length;
  const uncertainty = (bundle.gaps || []).length + (bundle.needsVerification || []).length;
  if (contextualEvidence && !uncertainty) errors.push("unknown query returned contextual evidence without an explicit uncertainty marker");
  return { ok: errors.length === 0, errors, contextualEvidence, uncertainty };
}
