import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createAppContext } from "../src/core/app-context.js";
import { atomicWriteFile, atomicWriteJson, getPdfSourceInfo } from "../src/core/runtime-helpers.js";
import { wireRuntimePorts } from "../src/app/runtime-wiring.js";
import { createRuntimeToolRegistry } from "../src/mcp/runtime-registry.js";
import { clearEvidenceGraphCache, loadEvidenceGraph } from "../src/services/evidence-graph.js";
import { loadFiguresIndex } from "../src/domains/figures.js";
import {
  CANCELLATION_CONFIRMATION_DEFAULTS,
  confirmJobCancellation,
  createIndexTimeoutError,
  createManualMetrics,
  deterministicBundleSignature,
  discoverPdfManuals,
  finalizeManualMetrics,
  figureSearchArguments,
  isPdfListed,
  paginationDuplicateIds,
  parseDoctorSummary,
  parseJobId,
  parseJobStatus,
  recordProcessMemorySample,
  recordToolLatency,
  requiredStagesExecuted,
  sanitizeIntegrationReport,
  selectPdfManuals,
  sharedProcessIsolationMetadata,
  validateCancellationConfirmationOptions,
  validateBundleForManual,
  validateUnknownQueryBundle,
} from "../src/eval/all-manual-integration.js";

const context = createAppContext();
wireRuntimePorts(context);
const registry = createRuntimeToolRegistry({ context });
const requireManuals = process.argv.includes("--require-manuals");
const writeReport = process.argv.includes("--write");
const forceAll = process.argv.includes("--force");
const traceMemory = process.argv.includes("--trace-memory");
const argument = (name, fallback) => {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value === undefined ? fallback : value;
};
const pollMs = Math.max(250, Number(argument("poll-ms", 2_000)) || 2_000);
const timeoutMs = Math.max(60_000, Number(argument("timeout-ms", 7_200_000)) || 7_200_000);
const cancellationConfirmationOptions = validateCancellationConfirmationOptions({
  timeoutMs: Number(argument("cancel-confirm-timeout-ms", CANCELLATION_CONFIRMATION_DEFAULTS.timeoutMs)),
  pollMs: Number(argument("cancel-confirm-poll-ms", CANCELLATION_CONFIRMATION_DEFAULTS.pollMs)),
});
const cancelConfirmTimeoutMs = cancellationConfirmationOptions.timeoutMs;
const cancelConfirmPollMs = cancellationConfirmationOptions.pollMs;
const largePageThreshold = Math.max(1, Number(argument("large-pages", 350)) || 350);
const filenameFilter = String(argument("filename", "") || "").trim();
const startedAt = new Date().toISOString();

function resultText(result) {
  return (result?.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function measuredTool(tool, args) {
  const memoryBefore = process.memoryUsage();
  const rssBefore = memoryBefore.rss;
  const heapBefore = memoryBefore.heapUsed;
  let peakRss = rssBefore;
  let peakHeap = heapBefore;
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
  }, 25);
  const started = performance.now();
  try {
    const result = await registry.dispatchTool(tool, args);
    const memoryAfter = process.memoryUsage();
    const rssAfter = memoryAfter.rss;
    return {
      ok: true,
      tool,
      args,
      result,
      text: resultText(result),
      latencyMs: Math.round(performance.now() - started),
      rssBeforeMb: Math.round(rssBefore / 1048576),
      rssAfterMb: Math.round(rssAfter / 1048576),
      peakRssMb: Math.round(Math.max(peakRss, rssAfter) / 1048576),
      heapBeforeMb: Math.round(heapBefore / 1048576),
      heapAfterMb: Math.round(memoryAfter.heapUsed / 1048576),
      peakHeapMb: Math.round(Math.max(peakHeap, memoryAfter.heapUsed) / 1048576),
    };
  } catch (error) {
    const memoryAfter = process.memoryUsage();
    const rssAfter = memoryAfter.rss;
    return {
      ok: false,
      tool,
      args,
      error: errorMessage(error),
      latencyMs: Math.round(performance.now() - started),
      rssBeforeMb: Math.round(rssBefore / 1048576),
      rssAfterMb: Math.round(rssAfter / 1048576),
      peakRssMb: Math.round(Math.max(peakRss, rssAfter) / 1048576),
      heapBeforeMb: Math.round(heapBefore / 1048576),
      heapAfterMb: Math.round(memoryAfter.heapUsed / 1048576),
      peakHeapMb: Math.round(Math.max(peakHeap, memoryAfter.heapUsed) / 1048576),
    };
  } finally {
    clearInterval(timer);
  }
}

async function requiredTool(row, tool, args) {
  const call = await measuredTool(tool, args);
  row.calls.push({ tool, args, ok: call.ok, latencyMs: call.latencyMs, error: call.error || "" });
  recordToolLatency(row.metrics, tool, call.latencyMs);
  if (traceMemory) console.log(`TOOL ${tool}: ${call.ok ? "ok" : "fail"}; ${call.latencyMs} ms; heap ${call.heapBeforeMb}->${call.heapAfterMb} MB (peak ${call.peakHeapMb}); RSS ${call.rssBeforeMb}->${call.rssAfterMb} MB (peak ${call.peakRssMb})`);
  if (!call.ok) throw new Error(`${tool} failed: ${call.error}`);
  return call;
}

function compactDoctor(call, filename) {
  return parseDoctorSummary(call.text, filename);
}

async function statusFor(row, filename) {
  const call = await requiredTool(row, "mcp_control", { action: "index_status_lite", filename, json: true });
  if (call.result.structuredContent) return call.result.structuredContent;
  try { return JSON.parse(call.text); }
  catch (error) { throw new Error(`index_status_lite returned invalid JSON: ${errorMessage(error)}`); }
}

function artifact(status, key) {
  return (status?.artifacts || []).find((item) => item.key === key);
}

function indexReady(status) {
  const required = ["pages", "chunk-index", "sections", "tables", "registers", "bitfields", "sequences", "cautions", "figures", "evidence-graph"];
  return status?.health === "OK"
    && status?.manifest?.buildStatus === "ready"
    && required.every((key) => artifact(status, key)?.ok === true);
}

function staleLockFromDoctor(doctor, filename) {
  const report = doctor?.reports?.find((item) => item.filename === filename);
  return report?.checks?.find((item) => item.name === "index build lock")?.status === "stale";
}

async function waitForJob(row, jobId) {
  const wallStarted = performance.now();
  const list = await requiredTool(row, "mcp_control", { action: "list_jobs" });
  if (!list.text.includes(jobId)) throw new Error(`mcp_control(list_jobs) omitted newly started job ${jobId}`);
  while (performance.now() - wallStarted <= timeoutMs) {
    const call = await requiredTool(row, "mcp_control", { action: "job_status", job_id: jobId });
    const status = parseJobStatus(call.text);
    row.indexing.lastJobStatus = status;
    if (status === "done") return Math.round(performance.now() - wallStarted);
    if (status === "failed" || status === "cancelled" || status === "unknown") {
      throw new Error(`background index job ${jobId} ended as ${status}: ${call.text.slice(0, 2000)}`);
    }
    await sleep(pollMs);
  }
  const confirmation = await confirmJobCancellation({
    cancellationAction: async () => {
      const call = await requiredTool(row, "mcp_control", {
        action: "cancel_job",
        job_id: jobId,
        reason: `All-manual integration timeout after ${timeoutMs} ms`,
      });
      return parseJobStatus(call.text);
    },
    statusReader: async () => {
      const call = await requiredTool(row, "mcp_control", { action: "job_status", job_id: jobId });
      return parseJobStatus(call.text);
    },
    timeoutMs: cancelConfirmTimeoutMs,
    pollMs: cancelConfirmPollMs,
    now: performance.now,
    sleep,
  });
  row.indexing.cancellation = confirmation;
  row.indexing.lastJobStatus = confirmation.finalStatus;
  throw createIndexTimeoutError({
    jobId,
    indexingTimeoutMs: timeoutMs,
    confirmationTimeoutMs: cancelConfirmTimeoutMs,
    confirmation,
  });
}

function sourcePage(entity) {
  return (entity?.sourceLocations || []).map((item) => Number(item.page)).find((page) => Number.isInteger(page) && page > 0) || 1;
}

function entityName(entity) {
  return String(entity?.canonicalName || entity?.displayName || "").trim();
}

function chooseExactEntity(graph) {
  const entities = graph?.entities || [];
  const nameCounts = new Map();
  for (const entity of entities) {
    const name = entityName(entity).toUpperCase();
    if (name) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  const score = (entity) => {
    const name = entityName(entity);
    let value = ({ register: 50, bitfield: 40, sequence: 30, caution: 20, table: 15, section: 10 })[entity.type] || 0;
    if (/^[A-Za-z][A-Za-z0-9_().-]{2,80}$/.test(name)) value += 20;
    if (nameCounts.get(name.toUpperCase()) === 1) value += 20;
    if (entity.verificationStatus === "verified") value += 10;
    if (/^(document|page|section|table|figure)$/i.test(name)) value -= 100;
    return value;
  };
  return entities.filter((entity) => entityName(entity)).sort((left, right) => score(right) - score(left))[0] || null;
}

function firstEntity(graph, type) {
  return (graph?.entities || []).find((entity) => entity.type === type && entityName(entity)) || null;
}

function validateAndRecordBundle(row, label, bundle) {
  const validation = validateBundleForManual(bundle, { filename: row.filename, pageCount: row.pageCount });
  row.evidence[label] = {
    ok: validation.ok,
    evidence: bundle?.evidence?.length || 0,
    facts: bundle?.facts?.length || 0,
    entities: bundle?.entities?.length || 0,
    conflicts: bundle?.conflicts?.length || 0,
    gaps: bundle?.gaps?.length || 0,
    needsVerification: bundle?.needsVerification?.length || 0,
    pagination: bundle?.pagination || null,
    errors: validation.errors,
  };
  if (!validation.ok) throw new Error(`${label} EvidenceBundle validation failed: ${validation.errors.join("; ")}`);
}

async function runEvidenceMatrix(row, graph) {
  const exactEntity = chooseExactEntity(graph);
  if (!exactEntity) throw new Error("indexed evidence graph contains no queryable entity");
  const exactSymbol = entityName(exactEntity);
  const section = firstEntity(graph, "section");
  const broadQuery = entityName(section) || exactSymbol;

  const broadCall = await requiredTool(row, "query_manual", { filename: row.filename, query: broadQuery, top_k: 10 });
  const broad = broadCall.result.structuredContent;
  validateAndRecordBundle(row, "broad", broad);
  if (!(broad.evidence || []).length) throw new Error(`broad query returned no evidence: ${broadQuery}`);

  const exactCalls = [];
  const exactQueryArguments = { filename: row.filename, query: exactSymbol, top_k: 10 };
  for (let index = 0; index < 5; index += 1) {
    const call = await requiredTool(row, "query_manual", { ...exactQueryArguments });
    const bundle = call.result.structuredContent;
    validateAndRecordBundle(row, index === 0 ? "exact" : `exactRepeat${index}`, bundle);
    exactCalls.push({ call, bundle });
  }
  const exactIds = exactCalls[0].bundle.evidence.slice(0, 5).map((item) => item.entityId || item.retrieval?.entityId).filter(Boolean);
  const hardwareExact = ["register", "bitfield", "sequence", "caution", "table", "section", "figure"].includes(exactEntity.type);
  if (hardwareExact && !exactIds.includes(exactEntity.id)) throw new Error(`exact entity ${exactEntity.id} was not in the top five results for ${exactSymbol}`);
  const lookupEntityId = exactIds[0] || exactEntity.id;
  const signatures = exactCalls.map(({ bundle }) => deterministicBundleSignature(bundle));
  if (new Set(signatures).size !== 1) throw new Error(`identical exact queries produced nondeterministic evidence ordering for ${exactSymbol}`);
  row.evidence.exact.deterministic = true;
  row.evidence.exact.entityId = lookupEntityId;
  row.evidence.exact.expectedEntityId = exactEntity.id;
  row.evidence.exact.hardwareExact = hardwareExact;
  row.evidence.exact.symbol = exactSymbol;
  row.metrics.coldEvidenceQueryMs = exactCalls[0].call.latencyMs;
  row.metrics.warmEvidenceQueryLatenciesMs = exactCalls.slice(1).map(({ call }) => call.latencyMs);
  row.metrics.coldWarmEvidenceQuery = {
    tool: "query_manual",
    arguments: exactQueryArguments,
    coldLatencyMs: row.metrics.coldEvidenceQueryMs,
    warmLatenciesMs: row.metrics.warmEvidenceQueryLatenciesMs,
  };

  const nonexistent = `ZZQV${Buffer.from(row.filename).toString("hex").slice(0, 20).toUpperCase()}X`;
  const negativeCall = await requiredTool(row, "query_manual", { filename: row.filename, query: nonexistent, top_k: 10 });
  const negative = negativeCall.result.structuredContent;
  validateAndRecordBundle(row, "nonexistent", negative);
  const negativeValidation = validateUnknownQueryBundle(negative);
  row.evidence.nonexistent.contextOnly = negativeValidation.contextualEvidence > 0;
  row.evidence.nonexistent.uncertainty = negativeValidation.uncertainty;
  if (!negativeValidation.ok) throw new Error(`nonexistent exact token was treated as resolved: ${negativeValidation.errors.join("; ")}`);

  const entityCall = await requiredTool(row, "get_manual_entity", { filename: row.filename, entity_id: lookupEntityId, top_k: 20 });
  validateAndRecordBundle(row, "entity", entityCall.result.structuredContent);
  const readCall = await requiredTool(row, "read_manual_evidence", { filename: row.filename, entity_id: lookupEntityId });
  validateAndRecordBundle(row, "read", readCall.result.structuredContent);
  for (const depth of ["quick", "deep"]) {
    const call = await requiredTool(row, "collect_manual_evidence", { filename: row.filename, task: `Verify ${exactSymbol} initialization, status, restrictions, and related sequence`, depth, top_k: 20 });
    validateAndRecordBundle(row, `collect_${depth}`, call.result.structuredContent);
  }

  const firstPage = await requiredTool(row, "query_manual", { filename: row.filename, query: exactSymbol, top_k: 2 });
  const firstBundle = firstPage.result.structuredContent;
  validateAndRecordBundle(row, "paginationFirst", firstBundle);
  if (firstBundle.pagination?.nextCursor) {
    const nextPage = await requiredTool(row, "query_manual", { filename: row.filename, query: exactSymbol, top_k: 2, cursor: firstBundle.pagination.nextCursor });
    const nextBundle = nextPage.result.structuredContent;
    validateAndRecordBundle(row, "paginationNext", nextBundle);
    const duplicates = paginationDuplicateIds(firstBundle, nextBundle);
    if (duplicates.evidence.length || duplicates.entities.length) {
      throw new Error(`pagination returned stable duplicates across pages: evidence=${duplicates.evidence.join(",") || "none"}; entities=${duplicates.entities.join(",") || "none"}`);
    }
  }

  return exactEntity;
}

function advancedSmokeTargets(graph, exactEntity) {
  const target = (type) => {
    const entity = firstEntity(graph, type);
    return entity ? { name: entityName(entity), page: sourcePage(entity), type: entity.type } : null;
  };
  return {
    register: target("register"),
    bitfield: target("bitfield"),
    sequence: target("sequence"),
    caution: target("caution"),
    table: target("table"),
    section: target("section"),
    exactEntityType: exactEntity?.type || "",
  };
}

async function smokeAdvanced(row, targets) {
  const checks = {};
  const run = async (key, tool, args) => {
    const call = await requiredTool(row, tool, args);
    checks[key] = { status: "pass", latencyMs: call.latencyMs };
  };
  const { register, bitfield, sequence, caution, table, section } = targets;
  if (register) await run("register", "find_register", { filename: row.filename, register: register.name, top_k: 8 }); else checks.register = { status: "not_applicable" };
  if (bitfield) await run("bitfield", "find_bitfield", { filename: row.filename, bitfield: bitfield.name, register: register?.name || "", top_k: 8 }); else checks.bitfield = { status: "not_applicable" };
  if (sequence) {
    await run("sequence", "get_sequence", { filename: row.filename, topic: sequence.name, register: register?.name || "", top_k: 10 });
  } else checks.sequence = { status: "not_applicable" };
  if (caution) await run("caution", "list_cautions", { filename: row.filename, filter: caution.name, top_k: 10 }); else checks.caution = { status: "not_applicable" };
  if (table) {
    const page = Math.min(row.pageCount, Math.max(1, table.page));
    await run("table", "extract_tables_from_pages", { filename: row.filename, start_page: page, end_page: page });
  } else checks.table = { status: "not_applicable" };
  if (section) await run("section", "find_section", { filename: row.filename, section: section.name, top_k: 8 }); else checks.section = { status: "not_applicable" };
  if (!checks.register && targets.exactEntityType === "register") checks.register = { status: "pass" };
  row.advanced = checks;
}

async function smokeFigures(row, status) {
  if (!artifact(status, "figures")?.ok) {
    row.figure = { status: "not_applicable", reason: "no valid figure manifest" };
    return;
  }
  let figures;
  try { figures = await loadFiguresIndex(row.filename); }
  catch {
    await requiredTool(row, "rebuild_figure_manifest", { filename: row.filename });
    figures = await loadFiguresIndex(row.filename);
  }
  const candidate = (figures?.figures || []).find((item) => item.figure_id || item.id);
  if (!candidate) {
    row.figure = { status: "not_applicable", reason: "manifest contains no figures" };
    return;
  }
  const figureId = candidate.figure_id || candidate.id;
  const query = String(candidate.caption || candidate.title || candidate.kind || "figure").trim().slice(0, 160) || "figure";
  const search = await requiredTool(row, "search_figures", figureSearchArguments(row.filename, query, 10));
  const searchData = search.result.structuredContent;
  if (!(searchData?.results || []).some((item) => (item.figure_id || item.id) === figureId)) throw new Error(`search_figures did not return selected figure ${figureId}`);
  const contextCall = await requiredTool(row, "get_figure_context_pack", { filename: row.filename, figure_id: figureId, include_ocr: false });
  const contextData = contextCall.result.structuredContent;
  if (contextData?.visual_contract?.semantic_truth_source !== "image_pixels") throw new Error("figure context pack violated the image-pixels trust contract");
  const imageCall = await requiredTool(row, "get_figure_image", { filename: row.filename, figure_id: figureId, transport: "metadata" });
  const imageData = imageCall.result.structuredContent;
  const canonicalPath = imageData?.canonical_image_path || imageData?.image_path || imageData?.local_path || "";
  const stat = canonicalPath ? await fs.stat(canonicalPath).catch(() => null) : null;
  const mime = imageData?.image_access?.mime_type || imageData?.mime_type || "";
  if (!stat?.isFile() || stat.size <= 0) throw new Error(`canonical figure image is missing or empty: ${canonicalPath || "no path"}`);
  if (mime !== "image/png") throw new Error(`canonical figure image MIME is ${mime || "missing"}, expected image/png`);
  row.figure = {
    status: "pass",
    figureId,
    page: candidate.page || null,
    canonicalImagePath: canonicalPath,
    bytes: stat.size,
    mime,
    actualImageInputSupplied: false,
    semanticStatus: "NO_IMAGE_INPUT",
  };
}

function finalMetrics(row) {
  finalizeManualMetrics(row.metrics, process.memoryUsage());
  row.metrics.cacheReused = Boolean(row.indexing.reused);
}

function markdownReport(report) {
  const lines = [
    "# All-manual integration report",
    "",
    `Generated: ${report.finishedAt}`,
    `Manuals: ${report.summary.total}; pass=${report.summary.pass}; fail=${report.summary.fail}; blocked=${report.summary.blocked}`,
    "",
    "| Manual | Pages | Mode | Doctor | Evidence | Register | Bitfield | Sequence | Table | Figure | Semantic correctness | Runtime coverage | Index ms | Evidence p50 ms | Evidence p95 ms | All-tool p50 ms | All-tool p95 ms | Process peak-through RSS MB | Status |",
    "| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const row of report.manuals) {
    lines.push(`| ${row.relativePath} | ${row.pageCount || 0} | ${row.indexing.mode || "n/a"} | ${row.doctor?.after?.coreHealth || row.doctor?.before?.coreHealth || "n/a"} | ${row.evidence?.exact?.ok ? "pass" : "fail"} | ${row.advanced?.register?.status || "n/a"} | ${row.advanced?.bitfield?.status || "n/a"} | ${row.advanced?.sequence?.status || "n/a"} | ${row.advanced?.table?.status || "n/a"} | ${row.figure?.status || "n/a"} | ${row.semanticCorrectness || "n/a"} | ${row.runtimeCoverageResult || "n/a"} | ${row.indexing.durationMs || 0} | ${row.metrics?.evidenceQueryP50Ms || 0} | ${row.metrics?.evidenceQueryP95Ms || 0} | ${row.metrics?.allToolP50Ms || 0} | ${row.metrics?.allToolP95Ms || 0} | ${row.metrics?.processPeakRssThroughManualMb || 0} | ${row.status} |`);
  }
  return `${lines.join("\n")}\n`;
}

const discovered = await discoverPdfManuals(context.paths.documentsDir());
let selectedManuals = [];
let selectionError = "";
try {
  selectedManuals = selectPdfManuals(discovered, filenameFilter);
} catch (error) {
  selectionError = errorMessage(error);
  console.error(`FAIL: ${selectionError}`);
  process.exitCode = 1;
}
const listed = await measuredTool("list_pdfs", {});
const report = {
  schemaVersion: 2,
  startedAt,
  finishedAt: "",
  options: {
    requireManuals,
    writeReport,
    forceAll,
    traceMemory,
    filenameFilter: filenameFilter || null,
    pollMs,
    timeoutMs,
    cancelConfirmTimeoutMs,
    cancelConfirmPollMs,
    largePageThreshold,
  },
  processIsolation: sharedProcessIsolationMetadata(),
  listPdfs: { ok: listed.ok, latencyMs: listed.latencyMs, error: listed.error || "" },
  errors: selectionError ? [selectionError] : [],
  manuals: [],
  summary: {},
};

if (!discovered.length && requireManuals) {
  console.error("FAIL: --require-manuals was specified but documents/ contains no PDFs");
  process.exitCode = 1;
}

for (const manual of selectedManuals) {
  const memoryAtStart = process.memoryUsage();
  const row = {
    filename: manual.filename,
    relativePath: manual.relativePath,
    sizeBytes: 0,
    pageCount: 0,
    classification: "unknown",
    sourceFingerprint: "",
    listedByPublicTool: listed.ok && isPdfListed(listed.text, manual.filename),
    indexing: { mode: "", reused: false, durationMs: 0, jobId: "", lastJobStatus: "", cancellation: null },
    doctor: {},
    evidence: {},
    advanced: {},
    figure: {},
    semanticCorrectness: "not_evaluated_by_runtime_runner",
    runtimeCoverageResult: "not_run",
    stages: Object.fromEntries([
      "manualValidation", "doctorBefore", "indexing", "doctorAfter", "cacheBefore",
      "evidence", "advanced", "figure", "cacheAfter",
    ].map((stage) => [stage, "not_run"])),
    metrics: createManualMetrics(memoryAtStart),
    calls: [],
    warnings: [],
    errors: [],
    status: "fail",
  };
  const memoryTimer = setInterval(() => recordProcessMemorySample(row.metrics, process.memoryUsage()), 25);
  report.manuals.push(row);
  console.log(`MANUAL START: ${manual.relativePath}`);
  try {
    if (manual.nested) throw new Error("nested PDF paths are discovered but the public direct-filename MCP contract cannot address them");
    if (manual.duplicateBasename) throw new Error("duplicate PDF basename is ambiguous under the public direct-filename MCP contract");
    if (!row.listedByPublicTool) throw new Error("list_pdfs did not advertise this discovered PDF");
    const source = await getPdfSourceInfo(row.filename, { includeHash: true, bypassCache: true });
    row.sizeBytes = source.size;
    row.sourceFingerprint = `size=${source.size};sha256=${source.sha256}`;
    const info = await requiredTool(row, "pdf_info", { filename: row.filename });
    if (!info.text.includes(`PDF: ${row.filename}`)) throw new Error("pdf_info returned mismatched filename");
    row.stages.manualValidation = "pass";
    const doctorBeforeCall = await requiredTool(row, "doctor", { filename: row.filename, write_report: false });
    const doctorBefore = compactDoctor(doctorBeforeCall, row.filename);
    row.doctor.before = doctorBefore;
    const doctorReport = doctorBefore.reports.find((item) => item.filename === row.filename);
    row.pageCount = Number(doctorReport?.checks?.find((item) => item.name === "pdf readability")?.pageCount || 0);
    if (!Number.isInteger(row.pageCount) || row.pageCount < 1) throw new Error("doctor did not report a valid page count");
    row.stages.doctorBefore = "pass";
    row.classification = row.pageCount > largePageThreshold ? "large" : row.pageCount > 100 ? "medium" : "small";
    const statusBefore = await statusFor(row, row.filename);
    row.indexing.statusBefore = { health: statusBefore.health, manifestStatus: statusBefore.manifest?.buildStatus || "missing" };
    const readyBefore = indexReady(statusBefore);
    if (readyBefore && !forceAll) {
      row.indexing.mode = "reuse";
      row.indexing.reused = true;
    } else {
      row.indexing.mode = row.classification === "large" ? "background" : "foreground";
      const indexStarted = performance.now();
      const indexCall = await requiredTool(row, "index_pdf", {
        filename: row.filename,
        mode: row.indexing.mode,
        force: true,
        force_lock: staleLockFromDoctor(doctorBefore, row.filename),
      });
      if (row.indexing.mode === "background") {
        row.indexing.jobId = parseJobId(indexCall.text);
        if (!row.indexing.jobId) throw new Error("background index_pdf response omitted Job ID");
        await waitForJob(row, row.indexing.jobId);
      }
      row.indexing.durationMs = Math.round(performance.now() - indexStarted);
    }
    const statusAfter = await statusFor(row, row.filename);
    row.indexing.statusAfter = { health: statusAfter.health, manifestStatus: statusAfter.manifest?.buildStatus || "missing" };
    if (!indexReady(statusAfter)) throw new Error(`index is not ready after build/reuse: health=${statusAfter.health}, manifest=${statusAfter.manifest?.buildStatus || "missing"}`);
    row.stages.indexing = "pass";
    const doctorAfterCall = await requiredTool(row, "doctor", { filename: row.filename, write_report: false });
    const doctorAfter = compactDoctor(doctorAfterCall, row.filename);
    row.doctor.after = doctorAfter;
    const finalDoctorReport = doctorAfter.reports.find((item) => item.filename === row.filename);
    if (finalDoctorReport?.coreHealth !== "ok") throw new Error(`doctor core health is ${finalDoctorReport?.coreHealth || "missing"} after indexing`);
    row.stages.doctorAfter = "pass";

    const cacheBefore = await requiredTool(row, "mcp_control", { action: "cache_status", filename: row.filename });
    row.cacheBefore = cacheBefore.result.structuredContent || null;
    row.stages.cacheBefore = "pass";
    let targets;
    {
      const graph = await loadEvidenceGraph(row.filename);
      const exactEntity = await runEvidenceMatrix(row, graph);
      targets = advancedSmokeTargets(graph, exactEntity);
    }
    row.stages.evidence = "pass";
    clearEvidenceGraphCache();
    await smokeAdvanced(row, targets);
    row.stages.advanced = "pass";
    await smokeFigures(row, statusAfter);
    row.stages.figure = "pass";
    const cacheAfter = await requiredTool(row, "mcp_control", { action: "cache_status", filename: row.filename });
    row.cacheAfter = cacheAfter.result.structuredContent || null;
    row.stages.cacheAfter = "pass";
    const stageValidation = requiredStagesExecuted(row.stages);
    if (!stageValidation.ok) throw new Error(`required manual stages were not executed: ${stageValidation.missing.join(", ")}`);
    row.runtimeCoverageResult = "evidence-bundle-v2-runtime-pass";
    row.status = "pass";
  } catch (error) {
    row.errors.push(errorMessage(error));
    row.status = error?.code === "INDEX_TIMEOUT" || /permission|EACCES|EPERM|ENOSPC/i.test(errorMessage(error)) ? "blocked" : "fail";
    console.error(`MANUAL ${row.status.toUpperCase()}: ${manual.relativePath}: ${errorMessage(error)}`);
  } finally {
    clearInterval(memoryTimer);
    finalMetrics(row);
    console.log(`MANUAL END: ${manual.relativePath}: ${row.status}`);
  }
}

report.finishedAt = new Date().toISOString();
report.summary = {
  total: report.manuals.length,
  pass: report.manuals.filter((row) => row.status === "pass").length,
  fail: report.manuals.filter((row) => row.status === "fail").length,
  blocked: report.manuals.filter((row) => row.status === "blocked").length,
  skipped: 0,
};

if (writeReport) {
  const jsonPath = path.join(context.paths.indexDir(), "all-manual-integration-report.json");
  const markdownPath = path.join(context.paths.indexDir(), "all-manual-integration-report.md");
  const sanitizedReport = sanitizeIntegrationReport(report, { projectRoot: context.config.rootDir });
  await atomicWriteJson(jsonPath, sanitizedReport);
  await atomicWriteFile(markdownPath, markdownReport(sanitizedReport), "utf8");
  console.log(`REPORT JSON: ${jsonPath}`);
  console.log(`REPORT MARKDOWN: ${markdownPath}`);
}

console.log(`ALL MANUALS: total=${report.summary.total}, pass=${report.summary.pass}, fail=${report.summary.fail}, blocked=${report.summary.blocked}, skipped=0`);
if (selectionError || report.summary.fail || report.summary.blocked || (requireManuals && !report.summary.total)) process.exitCode = 1;
