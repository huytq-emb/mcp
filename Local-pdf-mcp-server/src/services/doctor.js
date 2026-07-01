import { atomicWriteFile, atomicWriteJson, getPdfSourceInfo, isIndexLockStale, isSamePdfSource, pathExists, readIndexLock, safeArtifactManifestPath, safeBitfieldsIndexPath, safeCautionsIndexPath, safeDoctorReportJsonPath, safeDoctorReportMarkdownPath, safeDoctorReportPath, safeDriverPackPath, safeDriverTaskPlanPath, safeFigureOcrIndexPath, safeFiguresIndexPath, safeHybridQualityReportJsonPath, safeIndexLockPath, safeIndexPath, safeModuleProfileJsonPath, safeModuleProfileTextPath, safePagesCachePath, safePdfPath, safeRegistersIndexPath, safeSectionsIndexPath, safeSequencesIndexPath, safeTablesIndexPath, safeVisualEvidencePath } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { BITFIELD_INDEX_SCHEMA_VERSION, CAUTION_INDEX_SCHEMA_VERSION, FIGURE_INDEX_SCHEMA_VERSION, FIGURE_OCR_SCHEMA_VERSION, INDEX_DIR, INDEX_SCHEMA_VERSION, MODULE_PROFILE_SCHEMA_VERSION, PAGE_CACHE_SCHEMA_VERSION, REGISTER_INDEX_SCHEMA_VERSION, SECTION_INDEX_SCHEMA_VERSION, SEQUENCE_INDEX_SCHEMA_VERSION, TABLE_INDEX_SCHEMA_VERSION, VISUAL_EVIDENCE_SCHEMA_VERSION } from "../core/runtime-constants.js";
import fs from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_MANIFEST_SCHEMA_VERSION, formatManifestSummary, sourceFingerprint } from "../artifacts/manifest.js";
import { getOcrHealth } from "./ocr.js";


const getFileStat = createRuntimePort("getFileStat");
const getPdfPageCount = createRuntimePort("getPdfPageCount");


const listPdfFiles = createRuntimePort("listPdfFiles");
const loadArtifactManifest = createRuntimePort("loadArtifactManifest");


// -----------------------------------------------------------------------------
// Doctor / index validation
// -----------------------------------------------------------------------------

export function doctorStatusSeverity(status) {
  const table = {
    ok: 0,
    advisory: 1,
    missing_optional: 1,
    warning: 1,
    missing: 2,
    stale: 3,
    incompatible: 3,
    broken: 4,
    error: 4,
  };
  return table[status] ?? 2;
}

export function doctorStatusIcon(status) {
  if (status === "ok") return "OK";
  if (status === "advisory" || status === "missing_optional") return "INFO";
  if (status === "warning") return "WARN";
  return "FAIL";
}

export function doctorCheck(name, status, details = {}) {
  return {
    name,
    status,
    severity: doctorStatusSeverity(status),
    ...details,
    errors: details.errors || [],
    warnings: details.warnings || [],
    advisories: details.advisories || [],
  };
}

export async function readJsonForDoctor(filePath, expectedSchemaVersion, label) {
  if (!(await pathExists(filePath))) {
    return doctorCheck(label, "missing", { path: filePath });
  }

  try {
    const stat = await fs.stat(filePath);
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    const warnings = [];
    const errors = [];

    if (expectedSchemaVersion !== undefined && data.schemaVersion !== expectedSchemaVersion) {
      errors.push(`schema mismatch: expected ${expectedSchemaVersion}, got ${data.schemaVersion ?? "unknown"}`);
    }

    return doctorCheck(label, errors.length ? "incompatible" : "ok", {
      path: filePath,
      sizeBytes: stat.size,
      modified: stat.mtime.toISOString(),
      data,
      schemaVersion: data.schemaVersion,
      createdAt: data.createdAt,
      errors,
      warnings,
    });
  } catch (error) {
    return doctorCheck(label, "broken", {
      path: filePath,
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }
}

export async function readJsonHeaderForDoctor(filePath, expectedSchemaVersion, label, maxBytes = 131072) {
  if (!(await pathExists(filePath))) return doctorCheck(label, "missing", { path: filePath, errors: ["artifact is missing"], fast: true });
  try {
    const handle = await fs.open(filePath, "r");
    let head = "";
    let stat = null;
    try {
      stat = await handle.stat();
      const buffer = Buffer.alloc(Math.min(Number(stat.size || 0), maxBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await handle.close();
    }
    const schemaVersion = Number(head.match(/"schemaVersion"\s*:\s*(\d+)/)?.[1]);
    const filenameMatch = head.match(/"filename"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const filename = filenameMatch ? JSON.parse(`"${filenameMatch[1]}"`) : "";
    if (!Number.isFinite(schemaVersion)) return doctorCheck(label, "incompatible", { path: filePath, fast: true, sizeBytes: stat.size, errors: ["schemaVersion missing from artifact header"] });
    if (schemaVersion !== expectedSchemaVersion) return doctorCheck(label, "incompatible", { path: filePath, fast: true, sizeBytes: stat.size, schemaVersion, errors: [`schema mismatch: expected ${expectedSchemaVersion}, got ${schemaVersion}`] });
    return doctorCheck(label, "ok", { path: filePath, fast: true, sizeBytes: stat.size, schemaVersion, data: { schemaVersion, filename } });
  } catch (error) {
    return doctorCheck(label, "broken", { path: filePath, fast: true, errors: [error instanceof Error ? error.message : String(error)] });
  }
}

export async function readTextArtifactForDoctor(filePath, label, optional = true) {
  if (!(await pathExists(filePath))) {
    return doctorCheck(label, optional ? "missing_optional" : "missing", { path: filePath });
  }

  try {
    const stat = await fs.stat(filePath);
    return doctorCheck(label, "ok", {
      path: filePath,
      sizeBytes: stat.size,
      modified: stat.mtime.toISOString(),
    });
  } catch (error) {
    return doctorCheck(label, "broken", {
      path: filePath,
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }
}

export async function readHybridQualityReportForDoctor(filename, strict = false) {
  const filePath = safeHybridQualityReportJsonPath(filename);
  if (!(await pathExists(filePath))) {
    return doctorCheck("hybrid Python quality gate", "ok", {
      path: filePath,
      advisories: ["no shadow quality report yet; run structured Python shadow build to generate one"],
    });
  }
  try {
    const stat = await fs.stat(filePath);
    const data = JSON.parse(await fs.readFile(filePath, "utf-8"));
    const health = String(data.health || "unknown").toLowerCase();
    const status = health === "pass" ? "ok" : strict ? "warning" : "ok";
    const messages = [];
    if (health !== "pass") {
      messages.push(`last shadow decision=${data.decision || "unknown"}; health=${health}`);
      for (const check of data.checks || []) {
        for (const error of check.errors || []) messages.push(`${check.name}: ${error}`);
      }
    }
    return doctorCheck("hybrid Python quality gate", status, {
      path: filePath,
      sizeBytes: stat.size,
      modified: stat.mtime.toISOString(),
      data,
      advisories: status === "advisory" ? messages.slice(0, 8) : [],
      warnings: status === "warning" ? messages.slice(0, 8) : [],
    });
  } catch (error) {
    return doctorCheck("hybrid Python quality gate", strict ? "warning" : "ok", {
      path: filePath,
      advisories: strict ? [] : [error instanceof Error ? error.message : String(error)],
      warnings: strict ? [error instanceof Error ? error.message : String(error)] : [],
    });
  }
}

export function markCheck(check, status, message, field = "errors") {
  check.status = status;
  check.severity = doctorStatusSeverity(status);
  check[field] = check[field] || [];
  if (message) check[field].push(message);
  return check;
}

export function addCheckAdvisory(check, message) {
  check.advisories = check.advisories || [];
  if (message) check.advisories.push(message);
  return check;
}

export function validateFilenameForDoctor(check, filename) {
  if (!check.data) return check;
  if (check.data.filename && check.data.filename !== filename) {
    return markCheck(check, "incompatible", `filename mismatch: expected ${filename}, got ${check.data.filename}`);
  }
  return check;
}

export function validateSourceForDoctor(check, currentSource, kind, options = {}) {
  if (!check.data || check.status === "broken" || check.status === "missing") return check;
  const strict = Boolean(options.strict);

  if (kind === "chunk-index") {
    const sourceSize = Number(check.data.sourceSize);
    const sourceMtime = Number(check.data.sourceModifiedMs);
    if (sourceSize !== Number(currentSource.size)) {
      return markCheck(check, "stale", `source size mismatch: index ${sourceSize}, current ${currentSource.size}`);
    }
    if (!Number.isFinite(sourceMtime) || Math.abs(sourceMtime - Number(currentSource.mtimeMs)) >= 1500) {
      return markCheck(check, "stale", `source mtime mismatch: index ${sourceMtime}, current ${currentSource.mtimeMs}`);
    }
    return check;
  }

  if (check.data.source && !isSamePdfSource(check.data.source, currentSource)) {
    return markCheck(check, "stale", "PDF source metadata differs from current PDF");
  }

  if (!check.data.source && !["module-profile"].includes(kind)) {
    if (!strict && kind === "visualEvidence") {
      addCheckAdvisory(check, "missing source metadata on legacy visual evidence; not a core index blocker");
    } else {
      markCheck(check, check.status === "ok" ? "warning" : check.status, "missing source metadata", "warnings");
    }
  }

  return check;
}

export function validateShapeForDoctor(check, kind) {
  if (!check.data || check.status === "missing" || check.status === "broken") return check;
  const d = check.data;

  const expectArray = (field) => {
    if (!Array.isArray(d[field])) markCheck(check, "incompatible", `missing/invalid array: ${field}`);
  };
  const expectNumber = (field) => {
    if (!Number.isFinite(Number(d[field]))) markCheck(check, check.status === "ok" ? "warning" : check.status, `missing/invalid number: ${field}`, "warnings");
  };

  if (kind === "chunk-index") {
    expectArray("chunks");
    expectNumber("pageCount");
    expectNumber("chunkCount");
    if (Array.isArray(d.chunks) && Number(d.chunkCount) !== d.chunks.length) {
      markCheck(check, "warning", `chunkCount mismatch: declared ${d.chunkCount}, actual ${d.chunks.length}`, "warnings");
    }
  } else if (kind === "pages") {
    expectArray("pages");
    expectNumber("pageCount");
    if (Array.isArray(d.pages) && Number(d.pageCount) !== d.pages.length) {
      markCheck(check, "warning", `pageCount mismatch: declared ${d.pageCount}, actual ${d.pages.length}`, "warnings");
    }
  } else if (kind === "sections") {
    expectArray("sections");
    if (Array.isArray(d.sections) && Number(d.sectionCount) !== d.sections.length) {
      markCheck(check, "warning", `sectionCount mismatch: declared ${d.sectionCount}, actual ${d.sections.length}`, "warnings");
    }
  } else if (kind === "tables") {
    expectArray("tables");
    expectNumber("candidatePageCount");
    expectNumber("scannedPageCount");
    if (Array.isArray(d.tables) && Number(d.tableCount) !== d.tables.length) {
      markCheck(check, "warning", `tableCount mismatch: declared ${d.tableCount}, actual ${d.tables.length}`, "warnings");
    }
  } else if (kind === "registers") {
    expectArray("registers");
    if (Array.isArray(d.registers) && Number(d.registerCount) !== d.registers.length) {
      markCheck(check, "warning", `registerCount mismatch: declared ${d.registerCount}, actual ${d.registers.length}`, "warnings");
    }
  } else if (kind === "bitfields") {
    expectArray("bitfields");
    if (Array.isArray(d.bitfields) && Number(d.bitfieldCount) !== d.bitfields.length) {
      markCheck(check, "warning", `bitfieldCount mismatch: declared ${d.bitfieldCount}, actual ${d.bitfields.length}`, "warnings");
    }
  } else if (kind === "sequences") {
    expectArray("sequences");
    if (Array.isArray(d.sequences) && Number(d.sequenceCount) !== d.sequences.length) {
      markCheck(check, "warning", `sequenceCount mismatch: declared ${d.sequenceCount}, actual ${d.sequences.length}`, "warnings");
    }
  } else if (kind === "cautions") {
    expectArray("cautions");
    if (Array.isArray(d.cautions) && Number(d.cautionCount) !== d.cautions.length) {
      markCheck(check, "warning", `cautionCount mismatch: declared ${d.cautionCount}, actual ${d.cautions.length}`, "warnings");
    }
  } else if (kind === "figures") {
    expectArray("figures");
    if (Array.isArray(d.figures) && Number(d.figureCount) !== d.figures.length) {
      markCheck(check, "warning", `figureCount mismatch: declared ${d.figureCount}, actual ${d.figures.length}`, "warnings");
    }
  } else if (kind === "visualEvidence") {
    expectArray("entries");
  } else if (kind === "module-profile") {
    if (!d.moduleType) markCheck(check, "warning", "module profile missing moduleType", "warnings");
    if (!d.linuxSubsystem) markCheck(check, "warning", "module profile missing linuxSubsystem", "warnings");
  } else if (kind === "artifact-manifest") {
    if (!d.source || !d.source.fingerprint) markCheck(check, "warning", "manifest missing source fingerprint", "warnings");
    if (!d.artifacts || typeof d.artifacts !== "object") markCheck(check, "incompatible", "manifest missing artifacts object");
    if (!d.dependencyGraph || typeof d.dependencyGraph !== "object") markCheck(check, "warning", "manifest missing dependencyGraph", "warnings");
  }

  return check;
}

export function addCrossIndexWarnings(report) {
  const byName = new Map(report.checks.map((check) => [check.name, check]));
  const chunk = byName.get("chunk index");
  const pages = byName.get("pages cache");
  const sections = byName.get("sections index");
  const registers = byName.get("registers index");
  const bitfields = byName.get("bitfields index");
  const sequences = byName.get("sequences index");
  const cautions = byName.get("cautions index");

  if (chunk?.data && pages?.data && Number.isFinite(Number(chunk.data.pageCount)) && Number.isFinite(Number(pages.data.pageCount)) && Number(chunk.data.pageCount) !== Number(pages.data.pageCount)) {
    markCheck(chunk, "warning", `cross-check: chunk index pageCount ${chunk.data.pageCount} != pages cache pageCount ${pages.data.pageCount}`, "warnings");
  }
  if (chunk?.data && sections?.data && Number(chunk.data.sectionCount || 0) !== Number(sections.data.sectionCount || 0)) {
    markCheck(chunk, "warning", `cross-check: section count differs (${chunk.data.sectionCount || 0} vs ${sections.data.sectionCount || 0})`, "warnings");
  }
  if (chunk?.data && registers?.data && Number(chunk.data.registerCount || 0) !== Number(registers.data.registerCount || 0)) {
    markCheck(chunk, "warning", `cross-check: register count differs (${chunk.data.registerCount || 0} vs ${registers.data.registerCount || 0})`, "warnings");
  }
  if (chunk?.data && bitfields?.data && Number(chunk.data.bitfieldCount || 0) !== Number(bitfields.data.bitfieldCount || 0)) {
    markCheck(chunk, "warning", `cross-check: bitfield count differs (${chunk.data.bitfieldCount || 0} vs ${bitfields.data.bitfieldCount || 0})`, "warnings");
  }
  if (chunk?.data && sequences?.data && Number(chunk.data.sequenceCount || 0) !== Number(sequences.data.sequenceCount || 0)) {
    markCheck(chunk, "warning", `cross-check: sequence count differs (${chunk.data.sequenceCount || 0} vs ${sequences.data.sequenceCount || 0})`, "warnings");
  }
  if (chunk?.data && cautions?.data && Number(chunk.data.cautionCount || 0) !== Number(cautions.data.cautionCount || 0)) {
    markCheck(chunk, "warning", `cross-check: caution count differs (${chunk.data.cautionCount || 0} vs ${cautions.data.cautionCount || 0})`, "warnings");
  }
}

export const DOCTOR_CORE_CHECK_NAMES = new Set([
  "pdf file",
  "pdf readability",
  "artifact manifest",
  "chunk index",
  "pages cache",
  "sections index",
  "registers index",
  "bitfields index",
  "sequences index",
  "cautions index",
]);

export function doctorHealthFromSeverity(severity) {
  if (severity >= 2) return "fail";
  if (severity >= 1) return "warn";
  return "ok";
}

export function mergeDoctorHealth(...healthValues) {
  if (healthValues.includes("fail")) return "fail";
  if (healthValues.includes("warn")) return "warn";
  return "ok";
}

export function isDoctorCoreCheck(check) {
  return DOCTOR_CORE_CHECK_NAMES.has(check.name);
}

export function summarizeDoctorHealthDetails(checks, strict = false) {
  const coreChecks = checks.filter(isDoctorCoreCheck);
  const optionalChecks = checks.filter((check) => !isDoctorCoreCheck(check));
  const coreMax = Math.max(...coreChecks.map((check) => check.severity), 0);
  const optionalMax = Math.max(...optionalChecks.map((check) => check.severity), 0);
  const coreHealth = doctorHealthFromSeverity(coreMax);
  const advisoryHealth = doctorHealthFromSeverity(optionalMax);

  return {
    health: strict ? mergeDoctorHealth(coreHealth, advisoryHealth) : coreHealth,
    coreHealth,
    advisoryHealth,
    advisories: optionalChecks
      .filter((check) => check.severity >= 1 || (check.advisories || []).length)
      .map((check) => ({
        name: check.name,
        status: check.status,
        warnings: check.warnings || [],
        advisories: check.advisories || [],
        errors: check.errors || [],
      })),
  };
}

export function summarizeDoctorHealth(checks, strict = false) {
  return summarizeDoctorHealthDetails(checks, strict).health;
}

export async function doctorOnePdf(filename, options = {}) {
  const strict = Boolean(options.strict);
  const deep = strict || Boolean(options.deep);
  const checks = [];
  let currentSource = null;
  let pageCount = null;

  try {
    const filePath = safePdfPath(filename);
    const stat = await getFileStat(filename);
    currentSource = await getPdfSourceInfo(filename);
    checks.push(doctorCheck("pdf file", "ok", {
      path: filePath,
      sizeBytes: stat.size,
      modified: stat.mtime.toISOString(),
    }));
  } catch (error) {
    checks.push(doctorCheck("pdf file", "error", {
      errors: [error instanceof Error ? error.message : String(error)],
    }));
    return {
      filename,
      createdAt: new Date().toISOString(),
      strict,
      health: "fail",
      coreHealth: "fail",
      advisoryHealth: "ok",
      summary: summarizeDoctorChecks(checks),
      advisories: [],
      checks,
      recommendations: [`Verify that ${filename} exists in the documents folder.`],
    };
  }

  try {
    pageCount = await getPdfPageCount(filename);
    checks.push(doctorCheck("pdf readability", "ok", { pageCount }));
  } catch (error) {
    checks.push(doctorCheck("pdf readability", "error", {
      errors: [error instanceof Error ? error.message : String(error)],
    }));
  }

  const lockInfo = await readIndexLock(filename);
  if (lockInfo) {
    const stale = isIndexLockStale(lockInfo);
    checks.push(doctorCheck("index build lock", stale ? "stale" : "warning", {
      path: safeIndexLockPath(filename),
      createdAt: lockInfo.createdAt || "unknown",
      pid: lockInfo.pid || "unknown",
      stale,
      recommendation: stale
        ? "Remove stale lock or run index_pdf with force_lock=true if no index build is running."
        : "Another index_pdf may be running. Wait until it finishes before rebuilding.",
    }));
  } else {
    checks.push(doctorCheck("index build lock", "ok", {
      path: safeIndexLockPath(filename),
      details: "no active lock",
    }));
  }

  const jsonSpecs = [
    ["artifact manifest", safeArtifactManifestPath(filename), ARTIFACT_MANIFEST_SCHEMA_VERSION, "artifact-manifest"],
    ["chunk index", safeIndexPath(filename), INDEX_SCHEMA_VERSION, "chunk-index"],
    ["pages cache", safePagesCachePath(filename), PAGE_CACHE_SCHEMA_VERSION, "pages"],
    ["sections index", safeSectionsIndexPath(filename), SECTION_INDEX_SCHEMA_VERSION, "sections"],
    ["tables index", safeTablesIndexPath(filename), TABLE_INDEX_SCHEMA_VERSION, "tables"],
    ["registers index", safeRegistersIndexPath(filename), REGISTER_INDEX_SCHEMA_VERSION, "registers"],
    ["bitfields index", safeBitfieldsIndexPath(filename), BITFIELD_INDEX_SCHEMA_VERSION, "bitfields"],
    ["sequences index", safeSequencesIndexPath(filename), SEQUENCE_INDEX_SCHEMA_VERSION, "sequences"],
    ["cautions index", safeCautionsIndexPath(filename), CAUTION_INDEX_SCHEMA_VERSION, "cautions"],
    ["figures index", safeFiguresIndexPath(filename), FIGURE_INDEX_SCHEMA_VERSION, "figures"],
    ["figure OCR index", safeFigureOcrIndexPath(filename), FIGURE_OCR_SCHEMA_VERSION, "figure-ocr"],
    ["visual evidence", safeVisualEvidencePath(filename), VISUAL_EVIDENCE_SCHEMA_VERSION, "visualEvidence", true],
    ["module profile", safeModuleProfileJsonPath(filename), MODULE_PROFILE_SCHEMA_VERSION, "module-profile"],
  ];

  for (const [name, filePath, schema, kind] of jsonSpecs) {
    const useFastHeader = !deep && !["artifact-manifest", "module-profile", "visualEvidence"].includes(kind);
    let check = useFastHeader ? await readJsonHeaderForDoctor(filePath, schema, name) : await readJsonForDoctor(filePath, schema, name);
    check = validateFilenameForDoctor(check, filename);
    if (!useFastHeader) check = validateShapeForDoctor(check, kind);
    if (!useFastHeader && currentSource && check.data) check = validateSourceForDoctor(check, currentSource, kind, { strict });

    if (kind === "module-profile" && check.status === "missing") {
      check.status = strict ? "missing" : "missing_optional";
      check.severity = doctorStatusSeverity(check.status);
    }

    if (kind === "figures" && check.status === "missing") {
      check.status = "missing_optional";
      check.severity = doctorStatusSeverity(check.status);
    }

    if (kind === "figure-ocr" && check.status === "missing") {
      check.status = "missing_optional";
      check.severity = doctorStatusSeverity(check.status);
    }

    checks.push(check);
  }

  const ocrHealth = await getOcrHealth();
  checks.push(doctorCheck("OCR runtime", "ok", {
    advisories: ocrHealth.ocr?.available
      ? [`PaddleOCR available; mode=${ocrHealth.ocr.engine || "paddleocr"}`]
      : [`PaddleOCR unavailable; ${ocrHealth.ocr?.hint || "install optional OCR dependencies to enable figure OCR"}`],
    data: ocrHealth,
  }));

  checks.push(await readTextArtifactForDoctor(safeModuleProfileTextPath(filename), "module profile text", !strict));
  checks.push(await readTextArtifactForDoctor(safeDriverPackPath(filename), "driver evidence pack", !strict));
  checks.push(await readTextArtifactForDoctor(safeDriverTaskPlanPath(filename), "driver task plan", true));
  checks.push(await readHybridQualityReportForDoctor(filename, strict));

  const report = {
    filename,
    createdAt: new Date().toISOString(),
    strict,
    deep,
    pageCount,
    manifest: await loadArtifactManifest(filename),
    checks,
    recommendations: [],
  };

  addCrossIndexWarnings(report);
  Object.assign(report, summarizeDoctorHealthDetails(report.checks, strict));
  report.summary = summarizeDoctorChecks(report.checks);
  report.recommendations = buildDoctorRecommendations(report);

  return report;
}

export function summarizeDoctorChecks(checks) {
  const summary = { ok: 0, warning: 0, missing: 0, stale: 0, incompatible: 0, broken: 0, error: 0, missing_optional: 0 };
  for (const check of checks || []) {
    summary[check.status] = (summary[check.status] || 0) + 1;
  }
  return summary;
}

export function buildDoctorRecommendations(report) {
  const recommendations = [];
  const byName = new Map(report.checks.map((check) => [check.name, check]));
  const coreProblem = report.checks.some((check) => isDoctorCoreCheck(check) && ["missing", "stale", "incompatible", "broken", "error"].includes(check.status));

  if (coreProblem) {
    recommendations.push(`Run index_pdf(filename="${report.filename}", mode="background", force=true) for large manuals, then poll with mcp_control(action="job_status", job_id="..."). For small manuals, index_pdf(filename="${report.filename}", mode="foreground", force=true) is also valid.`);
  }
  if (["missing", "missing_optional", "stale", "incompatible", "broken"].includes(byName.get("module profile")?.status)) {
    recommendations.push(`Run analyze_module(filename="${report.filename}") to rebuild the module profile.`);
  }
  if (["missing_optional", "missing", "broken"].includes(byName.get("driver evidence pack")?.status)) {
    recommendations.push(`Run build_driver_evidence_pack(filename="${report.filename}") before asking the agent to write/review driver code.`);
  }
  if (["missing_optional", "missing", "broken"].includes(byName.get("driver task plan")?.status)) {
    recommendations.push(`Run source_review_prompt_pack(filename="${report.filename}", task="<your driver task>") before a specific debug/feature task.`);
  }
  if (!recommendations.length) recommendations.push("No immediate action required. Index artifacts look usable.");
  return recommendations;
}

export async function doctorPdfs(options = {}) {
  const filename = String(options.filename || "").trim();
  const files = filename ? [filename] : await listPdfFiles();
  const reports = [];

  for (const file of files) {
    reports.push(await doctorOnePdf(file, options));
  }

  return {
    createdAt: new Date().toISOString(),
    strict: Boolean(options.strict),
    checkedCount: reports.length,
    health: reports.some((r) => r.health === "fail") ? "fail" : reports.some((r) => r.health === "warn") ? "warn" : "ok",
    coreHealth: reports.some((r) => r.coreHealth === "fail") ? "fail" : reports.some((r) => r.coreHealth === "warn") ? "warn" : "ok",
    advisoryHealth: reports.some((r) => r.advisoryHealth === "fail") ? "fail" : reports.some((r) => r.advisoryHealth === "warn") ? "warn" : "ok",
    reports,
  };
}

export function stripDoctorDataForOutput(check) {
  const { data, ...rest } = check;
  return rest;
}

export function formatDoctorReport(result, options = {}) {
  const includeDetails = options.includeDetails !== false;
  const lines = [];

  lines.push("MCP Manual Server Doctor");
  lines.push(`Created: ${result.createdAt}`);
  lines.push(`Overall health: ${result.health.toUpperCase()}`);
  lines.push(`Core health: ${(result.coreHealth || result.health || "unknown").toUpperCase()}`);
  lines.push(`Advisory health: ${(result.advisoryHealth || "ok").toUpperCase()}`);
  lines.push(`PDFs checked: ${result.checkedCount}`);
  lines.push(`Strict mode: ${result.strict ? "yes" : "no"}`);
  if (result.extractionRuntime) {
    lines.push(`Extraction engine: ${result.extractionRuntime.selectedEngine} (mode=${result.extractionRuntime.mode})`);
    lines.push(`Python worker: ${result.extractionRuntime.pythonReady ? "ready" : "unavailable; Node fallback active"}`);
    if (result.extractionRuntime.reason) lines.push(`Python advisory: ${result.extractionRuntime.reason}`);
  }
  lines.push("");

  for (const report of result.reports || []) {
    lines.push(`## ${report.filename}`);
    lines.push(`Health: ${report.health.toUpperCase()}`);
    lines.push(`Core health: ${(report.coreHealth || report.health || "unknown").toUpperCase()}`);
    lines.push(`Advisory health: ${(report.advisoryHealth || "ok").toUpperCase()}`);
    if (report.pageCount) lines.push(`Pages: ${report.pageCount}`);
    lines.push(formatManifestSummary(report.manifest));
    lines.push("Checks:");

    for (const check of report.checks || []) {
      lines.push(`- [${doctorStatusIcon(check.status)}] ${check.name}: ${check.status}`);
      if (check.path) lines.push(`  path: ${check.path}`);
      if (check.createdAt) lines.push(`  created: ${check.createdAt}`);
      if (check.sizeBytes !== undefined) lines.push(`  size: ${check.sizeBytes} bytes`);
      for (const advisory of check.advisories || []) lines.push(`  advisory: ${advisory}`);
      for (const warning of check.warnings || []) lines.push(`  warning: ${warning}`);
      for (const error of check.errors || []) lines.push(`  error: ${error}`);
    }

    if ((report.advisories || []).length) {
      lines.push("Advisories:");
      for (const advisory of report.advisories) {
        const messages = [
          ...(advisory.advisories || []),
          ...(advisory.warnings || []),
          ...(advisory.errors || []),
        ].filter(Boolean).join("; ") || advisory.status;
        lines.push(`- ${advisory.name}: ${messages}`);
      }
    }

    lines.push("Recommendations:");
    for (const rec of report.recommendations || []) lines.push(`- ${rec}`);
    lines.push("");
  }

  const compact = {
    health: result.health,
    coreHealth: result.coreHealth || result.health,
    advisoryHealth: result.advisoryHealth || "ok",
    checkedCount: result.checkedCount,
    extractionRuntime: result.extractionRuntime || null,
    reports: (result.reports || []).map((report) => ({
      filename: report.filename,
      health: report.health,
      coreHealth: report.coreHealth || report.health,
      advisoryHealth: report.advisoryHealth || "ok",
      summary: report.summary,
      advisories: report.advisories || [],
      manifest: report.manifest ? {
        health: report.manifest.health,
        sourceFingerprint: report.manifest.source?.fingerprint,
        missingRequired: report.manifest.missingRequired,
      } : null,
      checks: includeDetails ? report.checks.map(stripDoctorDataForOutput) : undefined,
      recommendations: report.recommendations,
    })),
  };

  lines.push("Machine summary JSON:");
  lines.push(JSON.stringify(compact, null, 2));

  return lines.join("\n");
}

export async function maybeWriteDoctorReports(result, writeReport) {
  if (!writeReport) return [];
  await fs.mkdir(INDEX_DIR, { recursive: true });
  const paths = [];
  for (const report of result.reports || []) {
    const single = {
      createdAt: result.createdAt,
      strict: result.strict,
      checkedCount: 1,
      health: report.health,
      coreHealth: report.coreHealth || report.health,
      advisoryHealth: report.advisoryHealth || "ok",
      extractionRuntime: result.extractionRuntime || null,
      reports: [report],
    };
    const filePath = safeDoctorReportPath(report.filename);
    const jsonPath = safeDoctorReportJsonPath(report.filename);
    const markdownPath = safeDoctorReportMarkdownPath(report.filename);
    const formatted = formatDoctorReport(single);
    await atomicWriteFile(filePath, formatted, "utf-8");
    await atomicWriteJson(jsonPath, single);
    await atomicWriteFile(markdownPath, formatted, "utf-8");
    paths.push(filePath, jsonPath, markdownPath);
  }
  return paths;
}
