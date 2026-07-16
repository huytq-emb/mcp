import fs from "node:fs/promises";
import path from "node:path";
import { validateEvidenceBundleV2 } from "../evidence/contract.js";

const EVIDENCE_QUERY_TOOLS = new Set([
  "query_manual",
  "get_manual_entity",
  "read_manual_evidence",
  "collect_manual_evidence",
]);
const ADVANCED_TOOLS = new Set([
  "find_register",
  "find_bitfield",
  "get_sequence",
  "list_cautions",
  "extract_tables_from_pages",
  "find_section",
]);
const FIGURE_TOOLS = new Set([
  "rebuild_figure_manifest",
  "search_figures",
  "get_figure_context_pack",
  "get_figure_image",
]);
export const REQUIRED_MANUAL_STAGES = Object.freeze([
  "manualValidation",
  "doctorBefore",
  "indexing",
  "doctorAfter",
  "cacheBefore",
  "evidence",
  "advanced",
  "figure",
  "cacheAfter",
]);

function mb(bytes) {
  return Math.round((Number(bytes) || 0) / 1048576);
}

export function createManualMetrics(memoryUsage = {}) {
  const rss = mb(memoryUsage.rss);
  const heap = mb(memoryUsage.heapUsed);
  return {
    evidenceQueryLatenciesMs: [],
    controlLatenciesMs: [],
    advancedToolLatenciesMs: [],
    figureLatenciesMs: [],
    allToolLatenciesMs: [],
    processRssBeforeManualMb: rss,
    processRssAfterManualMb: rss,
    processPeakRssThroughManualMb: rss,
    processRssDeltaMb: 0,
    processHeapBeforeManualMb: heap,
    processHeapAfterManualMb: heap,
    processPeakHeapThroughManualMb: heap,
    processHeapDeltaMb: 0,
  };
}

export function recordToolLatency(metrics, tool, latencyMs) {
  const latency = Math.max(0, Number(latencyMs) || 0);
  metrics.allToolLatenciesMs.push(latency);
  if (EVIDENCE_QUERY_TOOLS.has(tool)) metrics.evidenceQueryLatenciesMs.push(latency);
  else if (ADVANCED_TOOLS.has(tool)) metrics.advancedToolLatenciesMs.push(latency);
  else if (FIGURE_TOOLS.has(tool)) metrics.figureLatenciesMs.push(latency);
  else metrics.controlLatenciesMs.push(latency);
}

export function recordProcessMemorySample(metrics, memoryUsage = {}) {
  metrics.processPeakRssThroughManualMb = Math.max(metrics.processPeakRssThroughManualMb || 0, mb(memoryUsage.rss));
  metrics.processPeakHeapThroughManualMb = Math.max(metrics.processPeakHeapThroughManualMb || 0, mb(memoryUsage.heapUsed));
}

export function finalizeManualMetrics(metrics, memoryAfter = {}, peakMemory = null) {
  if (peakMemory) recordProcessMemorySample(metrics, peakMemory);
  recordProcessMemorySample(metrics, memoryAfter);
  metrics.processRssAfterManualMb = mb(memoryAfter.rss);
  metrics.processRssDeltaMb = metrics.processRssAfterManualMb - metrics.processRssBeforeManualMb;
  metrics.processHeapAfterManualMb = mb(memoryAfter.heapUsed);
  metrics.processHeapDeltaMb = metrics.processHeapAfterManualMb - metrics.processHeapBeforeManualMb;
  metrics.evidenceQueryP50Ms = percentile(metrics.evidenceQueryLatenciesMs, 0.5);
  metrics.evidenceQueryP95Ms = percentile(metrics.evidenceQueryLatenciesMs, 0.95);
  metrics.allToolP50Ms = percentile(metrics.allToolLatenciesMs, 0.5);
  metrics.allToolP95Ms = percentile(metrics.allToolLatenciesMs, 0.95);
  return metrics;
}

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

export function parseDoctorSummary(text, filename) {
  let summary;
  try {
    summary = parseEmbeddedJson(text);
  } catch (error) {
    throw new Error(`doctor machine summary JSON is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!summary) throw new Error("doctor machine summary JSON is malformed or missing");
  if (!Array.isArray(summary.reports) || summary.reports.length < 1) {
    throw new Error("doctor machine summary reports must be a non-empty array");
  }
  const reports = summary.reports.filter((item) => item && item.filename === filename);
  if (reports.length !== 1) throw new Error(`doctor machine summary must contain exactly one report for ${filename}`);
  if (!Array.isArray(reports[0].checks)) throw new Error(`doctor report for ${filename} has no checks array`);
  return summary;
}

export function parseJobId(text) {
  return String(text || "").match(/Job ID:\s*([^\s]+)/i)?.[1] || "";
}

export function parseJobStatus(text) {
  return String(text || "").match(/^Status:\s*(queued|running|done|failed|cancelled)\s*$/im)?.[1]?.toLowerCase() || "unknown";
}

export function isTerminalJobStatus(status) {
  return ["done", "failed", "cancelled"].includes(String(status || "").toLowerCase());
}

export function deterministicBundleSignature(bundle = {}) {
  return JSON.stringify({
    facts: (bundle.facts || []).map((item) => item.id),
    evidence: (bundle.evidence || []).map((item) => [item.id, item.entityId || "", item.page, item.retrieval || null]),
    entities: (bundle.entities || []).map((item) => item.id),
    relationships: (bundle.relationships || []).map((item) => item.id),
    conflicts: (bundle.conflicts || []).map((item) => item.id),
    gaps: (bundle.gaps || []).map((item) => item.id),
    pagination: bundle.pagination || null,
  });
}

export function isPdfListed(text, filename) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] || "")
    .some((listed) => listed === filename);
}

export function selectPdfManuals(manuals, requestedFilename = "") {
  const requested = String(requestedFilename || "").trim();
  if (!requested) return manuals;
  if (requested !== path.basename(requested) || /[\\/]/.test(requested)) {
    throw new Error("--filename must be a PDF basename, not a path");
  }
  if (!requested.toLowerCase().endsWith(".pdf")) throw new Error("--filename must name a PDF file");
  const matches = manuals.filter((manual) => manual.filename.toLowerCase() === requested.toLowerCase());
  if (!matches.length) throw new Error(`manual selected by --filename was not found: ${requested}`);
  if (matches.length > 1) throw new Error(`manual basename selected by --filename is ambiguous: ${requested}`);
  return matches;
}

export function paginationDuplicateIds(first = {}, next = {}) {
  const duplicates = (collection) => {
    const firstIds = new Set((first[collection] || []).map((item) => item.id).filter(Boolean));
    return [...new Set((next[collection] || []).map((item) => item.id).filter((id) => id && firstIds.has(id)))];
  };
  return { evidence: duplicates("evidence"), entities: duplicates("entities") };
}

export function requiredStagesExecuted(stages = {}) {
  const missing = REQUIRED_MANUAL_STAGES.filter((stage) => stages[stage] !== "pass");
  return { ok: missing.length === 0, missing };
}

export function sharedProcessIsolationMetadata() {
  return {
    model: "shared-process-sequential",
    perManualIsolated: false,
    semantics: "Per-manual RSS and heap fields describe this runner process before, after, and through each manual; retained state from earlier manuals may be included.",
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function absolutePathKind(value) {
  if (path.win32.isAbsolute(value)) return path.win32;
  if (path.posix.isAbsolute(value)) return path.posix;
  return null;
}

function projectRelativePath(value, projectRoot) {
  const implementation = absolutePathKind(value);
  if (!implementation) return null;
  const rootImplementation = absolutePathKind(projectRoot);
  if (implementation !== rootImplementation) return null;
  const relative = implementation.relative(projectRoot, value);
  if (relative === "") return ".";
  if (relative.startsWith("..") || implementation.isAbsolute(relative)) return null;
  return relative.split(implementation.sep).join("/");
}

function sanitizeReportString(value, projectRoot, location, warnings) {
  const relative = projectRelativePath(value, projectRoot);
  if (relative !== null) return relative;
  if (absolutePathKind(value)) {
    warnings.push(`External absolute path omitted at ${location}.`);
    return "[external path unavailable]";
  }

  const slashValue = value.replaceAll("\\", "/");
  const slashRoot = String(projectRoot || "").replaceAll("\\", "/").replace(/\/$/, "");
  const rooted = slashRoot
    ? slashValue.replace(new RegExp(`${escapeRegExp(slashRoot)}(?:/|$)`, "ig"), "")
    : slashValue;
  const externalPath = /[A-Za-z]:\//.test(rooted)
    || /(^|[\s'"(=:])\/(?![\/\s])[^\s'"<>|]*/.test(rooted)
    || /(^|[\s'"(])\/\//.test(rooted);
  if (externalPath) {
    warnings.push(`Runtime message with an external absolute path omitted at ${location}.`);
    return "[runtime message omitted because it contained an external absolute path]";
  }
  return rooted === slashValue ? value : rooted;
}

export function sanitizeIntegrationReport(report, { projectRoot } = {}) {
  if (!projectRoot) throw new Error("sanitizeIntegrationReport requires projectRoot");
  const warnings = [];
  const visit = (value, location) => {
    if (typeof value === "string") return sanitizeReportString(value, projectRoot, location, warnings);
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${location}[${index}]`));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, location ? `${location}.${key}` : key)]));
  };
  const sanitized = visit(report, "report");
  sanitized.reportWarnings = [...(Array.isArray(sanitized.reportWarnings) ? sanitized.reportWarnings : []), ...warnings];
  return sanitized;
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
