import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DRIVER_PACK_MODE, DEFAULT_INDEX_JOB_MODE, DOCUMENTS_DIR, DRIVER_ARTIFACT_SCHEMA_VERSION, LARGE_PDF_BACKGROUND_PAGE_THRESHOLD, MAX_PAGE_RANGE, SERVER_VERSION } from "../../core/runtime-constants.js";
import { formatManifestSummary, sourceFingerprint } from "../../artifacts/manifest.js";
import { atomicWriteFile, atomicWriteJson, clampBitfieldListTopK, clampChunkOverlap, clampChunkSize, clampRegisterListTopK, clampTopK, formatIndexStatusUltraMinimal, getIndexStatusUltraMinimal, getPdfSourceInfo, isIndexLockStale, jsonResult, pathExists, readIndexLock, safeArtifactManifestPath, safeBitfieldsIndexPath, safeCautionsIndexPath, safeDriverPackJsonPath, safeDriverPackMarkdownPath, safeDriverPackPath, safeDriverTaskPlanJsonPath, safeDriverTaskPlanMarkdownPath, safeDriverTaskPlanPath, safeFigureOcrIndexPath, safeFiguresIndexPath, safeHybridQualityReportJsonPath, safeHybridQualityReportMarkdownPath, safeIndexLockPath, safeIndexPath, safeJobsStatePath, safePagesCachePath, safePdfPath, safeRegistersIndexPath, safeSectionsIndexPath, safeSequencesIndexPath, textResult } from "../../core/runtime-helpers.js";
import { createRuntimePort } from "../../core/runtime-ports.js";
import { clampCautionListTopK, formatCautionsForRegister, formatPersistentCautionList, getCautionsForRegister, getCautionsIndex, listCautionsFromIndex, loadCautionsIndex, persistentCautionFallbackForRegister } from "../../domains/cautions.js";
import { formatFigureList, listFigures, listFigureManifest, searchFigures, getFigureImage, getFigureContextPack, rebuildFigureManifest, ocrFigureForSearch, tableCoverageReport } from "../../domains/figures.js";
import { analyzeFigureSemantics, figureSemanticSummary, getFigureSemantics, listFigureSemantics, rebuildFigureSemanticsArtifact, searchFigureSemantics } from "../../domains/figure-semantics.js";
import { clampRegisterSummaryTopK, extractBitfieldTable, extractPinmuxTable, extractRegisterTable, extractTablesFromPages, findBitfieldInIndex, formatBitfieldResults, formatExtractedPinmuxTable, formatExtractedRegisterTable, formatExtractedTables, formatLayoutExtractedTables, formatRegisterSummary, summarizeRegister } from "../../domains/manual-intelligence.js";
import { clampSequenceListTopK, findSequenceInIndex, formatPersistentSequenceResult, formatSequenceListResults, formatSequenceResults, getSequenceFromIndex, listSequencesFromIndex, loadSequencesIndex } from "../../domains/sequences.js";
import { findCautionInIndex, formatCautionResults } from "../../domains/caution-search.js";
import { detectPdfRenderers, formatRendererAvailability } from "../../domains/rendering.js";
import { detectVisualSemanticIntent, withVisualSemanticGuard } from "../../core/visual-guard.js";
import { addVisualEvidence, buildVisualEvidenceReport, buildVisualEvidenceVerificationQueue, buildVisualReviewHandoffPack, formatAddVisualEvidence, formatGetVisualEvidence, formatListVisualEvidence, formatVerifyVisualEvidence, formatVisualEvidenceReport, formatVisualEvidenceVerificationQueue, formatVisualReviewHandoffPack, getVisualEvidence, listVisualEvidence, updateVisualEvidenceVerification } from "../../domains/visual-evidence.js";
import { DEFAULT_GOLDEN_PROFILE } from "../../eval/golden.js";
import { formatEvalCases, formatEvalReport, getFileStat, listPdfFiles, loadEvalCases, maybeWriteEvalReport, runEvalSuite } from "../../eval/runtime.js";
import { doctorPdfs, formatDoctorReport, maybeWriteDoctorReports } from "../../services/doctor.js";
import { buildPdfIndex, formatChunkTypeStats, formatRegisterIndexResults, formatRegisterListResults, getChunkTypeStats, isIndexUsable, listRegistersFromIndex, loadPdfIndex, loadRegistersIndex, loadSectionsIndex, looksLikeRegisterSymbol, searchRegistersIndex } from "../../services/indexing.js";
import { advisoryHealthFromArtifactStatus, cancelBackgroundJob, cleanupBackgroundJobs, coreHealthFromArtifactStatus, formatIndexStatus, formatJobStatus, formatJobsList, getIndexStatus, jobs, normalizeArtifactName, nowIso, pdfInfoArtifactBlock, rebuildArtifact, refreshJobsStateFromDisk, startIndexPdfJob, startRebuildArtifactJob, writeArtifactManifest } from "../../services/jobs.js";
import { cleanupCache, cleanupFigureCache, formatOcrHealthReport, getCacheStatus, getFigureCacheStatus, getOcrHealth } from "../../services/ocr.js";
import { getHybridRuntimeStatus } from "../../services/python-worker.js";
import { loadPagesCache } from "../../services/pdf.js";
import { buildRegisterQueries, clampHybridTopK, formatBitfieldListResults, formatExtractedBitfieldTable, formatHybridSearchResults, formatSearchResults, formatSectionResults, hybridSearchPdf, listBitfieldsFromIndex, loadBitfieldsIndex, searchPdfIndex, searchSectionsIndex } from "../../services/search.js";
import { buildDriverEvidencePack, buildDriverEvidencePackContract, buildDriverTaskPlan, buildDriverTaskPlanEvidenceContract, buildSectionQueries, formatDriverEvidencePack, formatDriverTaskPlan, formatVerifyRegisterUsage, multiQuerySearch, normalizeStringArray, verifyRegisterUsage } from "../../workflows/driver-pack.js";
import { buildManualWorkflowPlan, buildStep407CompatibilityReport, formatEvalHealthReport, formatManualWorkflowPlan, formatStep407CompatibilityReport, formatToolUsage, maybeWriteEvalHealthReport, runEvalHealthCheck } from "../../workflows/manual-workflow.js";
import { buildDriverCompletenessChecklist, compareDriverRequirements, formatCompareDriverRequirements, formatDriverCompletenessChecklist, formatDriverProfilesList, formatModuleProfile, getModuleProfile, listDriverProfiles, saveModuleProfile } from "../../workflows/profiles.js";
import { buildSourceReviewPromptPack, formatSourceReviewPromptPack } from "../../workflows/source-review.js";
import { LEGACY_CONTROL_WARNING, legacyJsonResult, legacyTextResult, requireStringArg } from "./shared.js";

const extractPdfPages = createRuntimePort("extractPdfPages");
const getPdfPageCount = createRuntimePort("getPdfPageCount");

async function handle_list_pdfs(args = {}, meta = {}) {
  const name = meta.name || "list_pdfs";
    const pdfs = await listPdfFiles();
  
    if (!pdfs.length) {
      return textResult(
        [`No PDF files found.`, `Documents folder: ${DOCUMENTS_DIR}`].join("\n")
      );
    }
  
    return textResult(
      [`Available PDFs:`, "", ...pdfs.map((file) => `- ${file}`)].join("\n")
    );
}

async function handle_plan_manual_workflow(args = {}, meta = {}) {
  const name = meta.name || "plan_manual_workflow";
    const plan = await buildManualWorkflowPlan(args);
    return textResult(formatManualWorkflowPlan(plan));
}

async function handle_explain_tool_usage(args = {}, meta = {}) {
  const name = meta.name || "explain_tool_usage";
    return textResult(formatToolUsage(String(args.tool_name || "").trim(), String(args.task || "").trim()));
}

async function handle_mcp_control(args = {}, meta = {}) {
  const name = meta.name || "mcp_control";
    const action = String(args.action || "").trim().toLowerCase();
    if (action) {
      // Keep all control-plane actions behind the single public mcp_control tool
      // instead of advertising separate direct Step 40 tools.
      if (action === "ping") {
        return textResult([
          "MCP control ping: OK",
          `Server version: ${SERVER_VERSION}`,
          `Generated: ${nowIso()}`,
          "Transport: mcp_control(action=\"ping\")",
        ].join("\n"));
      }
      if (action === "compat_report") {
        const report = buildStep407CompatibilityReport();
        if (Boolean(args.json)) return textResult(JSON.stringify(report, null, 2));
        return textResult(formatStep407CompatibilityReport(report));
      }
      if (action === "index_status_lite") {
        const filename = requireStringArg(args, "filename", action);
        const status = getIndexStatusUltraMinimal(filename);
        if (Boolean(args.json)) return textResult(JSON.stringify(status, null, 2));
        return textResult(formatIndexStatusUltraMinimal(status));
      }
      if (action === "ocr_health") {
        const status = await getOcrHealth({ force: true });
        if (Boolean(args.json)) return textResult(JSON.stringify(status, null, 2));
        return textResult(formatOcrHealthReport(status));
      }
      if (action === "rebuild_artifact") {
        const filename = requireStringArg(args, "filename", action);
        const artifact = normalizeArtifactName(args.artifact || "pages");
        const job = await startRebuildArtifactJob(filename, artifact, {
          forceLock: Boolean(args.force_lock),
          force: Boolean(args.force),
          chunkSize: clampChunkSize(args.chunk_size),
          chunkOverlap: clampChunkOverlap(args.chunk_overlap, clampChunkSize(args.chunk_size)),
          allowFullRebuild: args.allow_full_rebuild === undefined ? true : Boolean(args.allow_full_rebuild),
          cascadeDependents: Boolean(args.cascade_dependents),
        });
        return textResult([
          `Started detached background artifact rebuild for ${filename}.`,
          `Artifact: ${artifact}`,
          `Job ID: ${job.id}`,
          `Status: ${job.status}`,
          `Mode: detached-worker via mcp_control`,
          "",
          `Poll via: mcp_control(action="job_status", job_id="${job.id}")`,
          `List via: mcp_control(action="list_jobs")`,
          `Persistent job state: ${safeJobsStatePath()}`,
        ].join("\n"));
      }
      if (action === "job_status") {
        await refreshJobsStateFromDisk();
        const jobId = requireStringArg(args, "job_id", action);
        const job = jobs.get(jobId);
        return textResult(formatJobStatus(job));
      }
      if (action === "list_jobs") {
        await refreshJobsStateFromDisk();
        return textResult(formatJobsList());
      }
      if (action === "cancel_job") {
        await refreshJobsStateFromDisk();
        const jobId = requireStringArg(args, "job_id", action);
        const job = cancelBackgroundJob(jobId, String(args.reason || "Cancelled by user").trim() || "Cancelled by user");
        if (!job) return textResult(`Job not found: ${jobId}`);
        return textResult(formatJobStatus(job));
      }
      if (action === "cleanup_jobs") {
        const statuses = Array.isArray(args.statuses) ? args.statuses.map(String) : undefined;
        const olderThanHours = Number(args.older_than_hours || 0);
        const removed = cleanupBackgroundJobs({ statuses, olderThanHours, includeRunning: Boolean(args.include_running) });
        return textResult([
          `Removed jobs: ${removed.length}`,
          ...removed.map((id) => `- ${id}`),
          "",
          `Remaining jobs: ${jobs.size}`,
          `Persistent job state: ${safeJobsStatePath()}`,
        ].join("\n"));
      }
      if (action === "cache_status") {
        requireStringArg(args, "filename", action);
        const status = await getCacheStatus(args);
        return jsonResult(status);
      }
      if (action === "cleanup_cache") {
        requireStringArg(args, "filename", action);
        const status = await cleanupCache(args);
        return jsonResult(status);
      }
      if (action === "figure_cache_status") {
        requireStringArg(args, "filename", action);
        const status = await getFigureCacheStatus(args);
        return jsonResult(status);
      }
      if (action === "cleanup_figure_cache") {
        requireStringArg(args, "filename", action);
        const status = await cleanupFigureCache(args);
        return jsonResult(status);
      }
      throw new Error(`Unknown mcp_control action: ${args.action}`);
    }
  
    throw new Error("mcp_control action is required");
}

async function handle_eval_health_check(args = {}, meta = {}) {
  const name = meta.name || "eval_health_check";
  if (Object.prototype.hasOwnProperty.call(args, "step40_action")) {
    return textResult("Deprecated: use mcp_control(action=...) instead.");
  }
  const report = await runEvalHealthCheck(args);
  const writeReport = args.write_report === undefined ? true : Boolean(args.write_report);
  const reportPaths = await maybeWriteEvalHealthReport(report, writeReport);
  return textResult([
    formatEvalHealthReport(report),
    reportPaths.length ? "" : null,
    ...reportPaths.map((p) => `Eval health report saved: ${p}`),
  ].filter(Boolean).join("\n"));
}

async function handle_list_eval_cases(args = {}, meta = {}) {
  const name = meta.name || "list_eval_cases";
    const caseId = String(args.case_id || "").trim();
    const createDefault = args.create_default !== false;
    const evalData = await loadEvalCases({
      createDefault,
      scope: String(args.scope || "all").trim(),
      moduleType: String(args.module_type || "").trim(),
      evalProfile: String(args.eval_profile || "").trim(),
      fixture: String(args.fixture || "").trim(),
      includeProfiles: true,
      includeFixtures: true,
      includeDisabled: args.include_disabled === undefined ? true : Boolean(args.include_disabled),
    });
    return textResult(formatEvalCases(evalData, caseId));
}

async function handle_run_eval(args = {}, meta = {}) {
  const name = meta.name || "run_eval";
    const filename = String(args.filename || "").trim();
    const caseId = String(args.case_id || "").trim();
    const moduleType = String(args.module_type || "").trim();
    const evalProfile = String(args.eval_profile || "").trim();
    const fixture = String(args.fixture || "").trim();
    const autoIndex = Boolean(args.auto_index);
    const writeReport = args.write_report === undefined ? true : Boolean(args.write_report);
    const createDefault = args.create_default !== false;
    const includeProfiles = args.include_profiles === undefined ? true : Boolean(args.include_profiles);
    const includeFixtures = args.include_fixtures === undefined ? true : Boolean(args.include_fixtures);
    const includeGolden = Boolean(args.include_golden);
    const goldenProfile = String(args.golden_profile || DEFAULT_GOLDEN_PROFILE).trim();
    const strictVerifiedOnly = args.strict_verified_only === undefined ? true : Boolean(args.strict_verified_only);
  
    const report = await runEvalSuite({
      filename,
      caseId,
      moduleType,
      evalProfile,
      fixture,
      autoIndex,
      createDefault,
      includeProfiles,
      includeFixtures,
      includeGolden,
      goldenProfile,
      strictVerifiedOnly,
    });
    const reportPaths = await maybeWriteEvalReport(report, writeReport);
  
    return textResult([
      formatEvalReport(report),
      reportPaths.length ? "" : null,
      ...reportPaths.map((p) => `Eval report saved: ${p}`),
    ].filter(Boolean).join("\n"));
}

async function handle_doctor_or_validate_index(args = {}, meta = {}) {
  const name = meta.name || "doctor";
    const filename = String(args.filename || "").trim();
    const strict = Boolean(args.strict);
    const defaultWrite = name === "doctor" && Boolean(filename);
    const writeReport = args.write_report === undefined ? defaultWrite : Boolean(args.write_report);
  
    const result = await doctorPdfs({
      filename,
      strict,
    });
    result.extractionRuntime = await getHybridRuntimeStatus();
    const reportPaths = await maybeWriteDoctorReports(result, writeReport);
    const formatted = formatDoctorReport(result, { includeDetails: true });
  
    return textResult([
      formatted,
      reportPaths.length ? "" : null,
      ...reportPaths.map((p) => `Doctor report saved: ${p}`),
    ].filter(Boolean).join("\n"));
}

async function handle_pdf_info(args = {}, meta = {}) {
  const name = meta.name || "pdf_info";
    const filename = args.filename;
    const filePath = safePdfPath(filename);
    const stat = await getFileStat(filename);
    const indexPath = safeIndexPath(filename);
    const lockPath = safeIndexLockPath(filename);
    const lockInfo = await readIndexLock(filename);
    const lockText = lockInfo
      ? [
          "Index build lock: yes",
          `Lock path: ${lockPath}`,
          `Created: ${lockInfo.createdAt || "unknown"}`,
          `PID: ${lockInfo.pid || "unknown"}`,
          `Stale: ${isIndexLockStale(lockInfo) ? "yes" : "no"}`,
        ].join("\n")
      : ["Index build lock: no", `Lock path: ${lockPath}`].join("\n");
  
    const status = await getIndexStatus(filename, { probePdf: false });
    const extractionRuntime = await getHybridRuntimeStatus();
    const artifactByKey = new Map((status.artifacts || []).map((artifact) => [artifact.key, artifact]));
    const coreHealth = coreHealthFromArtifactStatus(status.artifacts || []);
    const advisoryHealth = advisoryHealthFromArtifactStatus(status.artifacts || []);
    const pageCountText = `Pages: ${status.pdf.pageCount || "unknown"}${status.pdf.pageCountSource ? ` (${status.pdf.pageCountSource})` : ""}`;
    const indexText = pdfInfoArtifactBlock({
      artifact: artifactByKey.get("chunk-index"),
      label: "Index",
      readyLabel: "Indexed",
      statusLabel: "Index status",
      countLabel: "Chunks",
      pathLabel: "Index path",
      missingText: "Indexed: no",
    });
    const pagesCacheText = pdfInfoArtifactBlock({
      artifact: artifactByKey.get("pages"),
      label: "Pages cache",
      countLabel: "Cached pages",
      missingText: "Pages cache: no",
    });
    const sectionsIndexText = pdfInfoArtifactBlock({
      artifact: artifactByKey.get("sections"),
      label: "Sections index",
      countLabel: "Sections detected",
      missingText: "Sections index: no",
    });
    const registersIndexText = pdfInfoArtifactBlock({
      artifact: artifactByKey.get("registers"),
      label: "Registers index",
      countLabel: "Registers detected",
      missingText: "Registers index: no",
    });
    const tablesIndexText = pdfInfoArtifactBlock({
      artifact: artifactByKey.get("tables"),
      label: "Tables index",
      countLabel: "Tables detected",
      missingText: "Tables index: no",
    });
    const bitfieldsIndexText = pdfInfoArtifactBlock({
      artifact: artifactByKey.get("bitfields"),
      label: "Bitfields index",
      countLabel: "Bitfields detected",
      missingText: "Bitfields index: no",
    });
    const sequencesIndexText = pdfInfoArtifactBlock({
      artifact: artifactByKey.get("sequences"),
      label: "Sequences index",
      countLabel: "Sequences detected",
      missingText: "Sequences index: no",
    });
    const cautionsIndexText = pdfInfoArtifactBlock({
      artifact: artifactByKey.get("cautions"),
      label: "Cautions index",
      countLabel: "Cautions detected",
      missingText: "Cautions index: no",
    });
    const figureOcrText = pdfInfoArtifactBlock({
      artifact: artifactByKey.get("figure_ocr"),
      label: "Figure OCR index",
      countLabel: "OCR figure entries",
      pathLabel: "Figure OCR path",
      missingText: "Figure OCR index: no (optional)",
    });
    const moduleProfileText = pdfInfoArtifactBlock({
      artifact: artifactByKey.get("module-profile"),
      label: "Module profile",
      countLabel: "Module profiles",
      pathLabel: "Profile JSON path",
      missingText: "Module profile: no",
    });
  
    const artifactManifestPath = safeArtifactManifestPath(filename);
    const artifactManifest = status.manifest;
    const artifactManifestText = artifactManifest
      ? [formatManifestSummary(artifactManifest), `Manifest path: ${artifactManifestPath}`].join("\n")
      : [
          "Artifact manifest: no",
          `Manifest path: ${artifactManifestPath}`,
          `Next action: index_pdf(filename="${filename}", mode="background") for large manuals, then poll with mcp_control(action="job_status", job_id="...") and rerun pdf_info/doctor.`,
        ].join("\n");

    const hybridQualityJsonPath = safeHybridQualityReportJsonPath(filename);
    const hybridQualityMarkdownPath = safeHybridQualityReportMarkdownPath(filename);
    let hybridQualityText = [
      "Hybrid Python quality gate: no report yet",
      `Quality report JSON path: ${hybridQualityJsonPath}`,
      `Quality report Markdown path: ${hybridQualityMarkdownPath}`,
      "Next action: run a structured Python shadow build with RENESAS_MCP_PYTHON_OPERATIONS=pdf,pages,tables,structured.",
    ].join("\n");
    if (await pathExists(hybridQualityJsonPath)) {
      try {
        const report = JSON.parse(await fs.readFile(hybridQualityJsonPath, "utf-8"));
        hybridQualityText = [
          `Hybrid Python quality gate: ${String(report.health || "unknown").toUpperCase()}`,
          `Shadow decision: ${report.decision || "unknown"}`,
          `Operation: ${report.operation || "unknown"}`,
          `Generated: ${report.generatedAt || "unknown"}`,
          `Summary: pass=${report.summary?.pass || 0}, warn=${report.summary?.warn || 0}, fail=${report.summary?.fail || 0}`,
          `Quality report JSON path: ${hybridQualityJsonPath}`,
          `Quality report Markdown path: ${hybridQualityMarkdownPath}`,
        ].join("\n");
      } catch (error) {
        hybridQualityText = [
          "Hybrid Python quality gate: report unreadable",
          `Quality report JSON path: ${hybridQualityJsonPath}`,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        ].join("\n");
      }
    }

    const ocrHealth = await getOcrHealth();
    const ocrRuntimeText = [
      `OCR runtime: ${ocrHealth.ocr?.available ? "available" : "unavailable"}`,
      `OCR engine: ${ocrHealth.ocr?.engine || "paddleocr"}`,
      `OCR enabled: ${ocrHealth.ocr?.enabled ? "true" : "false"}`,
      ocrHealth.ocr?.reason ? `OCR note: ${ocrHealth.ocr.reason}` : null,
      ocrHealth.ocr?.hint ? `OCR install hint: ${ocrHealth.ocr.hint}` : null,
    ].filter(Boolean).join("\n");
  
    return textResult(
      [
        `PDF: ${filename}`,
        `Path: ${filePath}`,
        `Size: ${stat.size} bytes`,
        `Modified: ${stat.mtime.toISOString()}`,
        `Core health: ${coreHealth.toUpperCase()}`,
        `Advisory health: ${advisoryHealth.toUpperCase()}`,
        `Extraction engine: ${extractionRuntime.selectedEngine} (mode=${extractionRuntime.mode})`,
        `Python worker: ${extractionRuntime.pythonReady ? "ready" : `unavailable; Node fallback active${extractionRuntime.reason ? ` (${extractionRuntime.reason})` : ""}`}`,
        "",
        lockText,
        "",
        indexText,
        "",
        pagesCacheText,
        "",
        sectionsIndexText,
        "",
        tablesIndexText,
        "",
        registersIndexText,
        "",
        bitfieldsIndexText,
        "",
        sequencesIndexText,
        "",
        cautionsIndexText,
        "",
        figureOcrText,
        "",
        moduleProfileText,
        "",
        ocrRuntimeText,
        "",
        hybridQualityText,
        "",
        artifactManifestText,
      ].join("\n")
    );
}

async function handle_start_index_pdf(args = {}, meta = {}) {
  const name = meta.name || "start_index_pdf";
    const filename = args.filename;
    const force = Boolean(args.force);
    const forceLock = Boolean(args.force_lock);
    const chunkSize = clampChunkSize(args.chunk_size);
    const chunkOverlap = clampChunkOverlap(args.chunk_overlap, chunkSize);
    const indexPath = safeIndexPath(filename);
    const pdfStat = await getFileStat(filename);
  
    if (!force && (await pathExists(indexPath))) {
      try {
        const raw = await fs.readFile(indexPath, "utf-8");
        const indexData = JSON.parse(raw);
        if (isIndexUsable(indexData, pdfStat)) {
          return textResult([
            `Index already valid for ${filename}.`,
            `Pages: ${indexData.pageCount}`,
            `Chunks: ${indexData.chunkCount}`,
            `Created: ${indexData.createdAt}`,
            `No background job started. Use force=true to rebuild.`,
          ].join("\n"));
        }
      } catch {
        // fall through and start a job
      }
    }
  
    const job = await startIndexPdfJob(filename, { chunkSize, chunkOverlap, forceLock });
    return textResult([
      `Started background indexing job for ${filename}.`,
      `Job ID: ${job.id}`,
      `Status: ${job.status}`,
      `Mode: background`,
      "",
      `Poll: mcp_control(action="job_status", job_id="${job.id}")`,
      `List jobs: mcp_control(action="list_jobs")`,
      `Persistent job state: ${safeJobsStatePath()}`,
    ].join("\n"));
}

async function handle_job_status(args = {}, meta = {}) {
  const name = meta.name || "job_status";
    await refreshJobsStateFromDisk();
    const jobId = String(args.job_id || "").trim();
    const job = jobs.get(jobId);
    return textResult(formatJobStatus(job));
}

async function handle_list_jobs(args = {}, meta = {}) {
  const name = meta.name || "list_jobs";
    await refreshJobsStateFromDisk();
    return textResult(formatJobsList());
}

async function handle_cancel_job(args = {}, meta = {}) {
  const name = meta.name || "cancel_job";
  await refreshJobsStateFromDisk();
  const jobId = String(args.job_id || "").trim();
  if (!jobId) throw new Error("job_id is required");
  const job = cancelBackgroundJob(jobId, String(args.reason || "Cancelled by user").trim() || "Cancelled by user");
  if (!job) return legacyTextResult(LEGACY_CONTROL_WARNING, `Job not found: ${jobId}`);
  return legacyTextResult(LEGACY_CONTROL_WARNING, formatJobStatus(job));
}

async function handle_cleanup_jobs(args = {}, meta = {}) {
  const name = meta.name || "cleanup_jobs";
    const statuses = Array.isArray(args.statuses) ? args.statuses.map(String) : undefined;
    const olderThanHours = Number(args.older_than_hours || 0);
    const removed = cleanupBackgroundJobs({ statuses, olderThanHours, includeRunning: Boolean(args.include_running) });
    return legacyTextResult(LEGACY_CONTROL_WARNING, [
      `Removed jobs: ${removed.length}`,
      ...removed.map((id) => `- ${id}`),
      "",
      `Remaining jobs: ${jobs.size}`,
      `Persistent job state: ${safeJobsStatePath()}`,
    ].join("\n"));
}

async function handle_mcp_server_ping(args = {}, meta = {}) {
  const name = meta.name || "mcp_server_ping";
    return legacyTextResult(LEGACY_CONTROL_WARNING, `MCP server ping: OK\nServer version: ${SERVER_VERSION}\nGenerated: ${nowIso()}`);
}

async function handle_pdf_index_status_lite(args = {}, meta = {}) {
  const name = meta.name || "pdf_index_status_lite";
    const filename = String(args.filename || "").trim();
    if (!filename) {
      throw new Error(`filename is required for deprecated ${name}; prefer mcp_control(action="index_status_lite", filename="...")`);
    }
    const status = getIndexStatusUltraMinimal(filename);
    if (Boolean(args.json)) return legacyJsonResult(LEGACY_CONTROL_WARNING, status);
    return legacyTextResult(LEGACY_CONTROL_WARNING, formatIndexStatusUltraMinimal(status));
}

async function handle_index_status(args = {}, meta = {}) {
  const name = meta.name || "index_status";
    const filename = String(args.filename || "").trim();
    if (!filename) {
      throw new Error(`filename is required for deprecated ${name}; prefer mcp_control(action="index_status_lite", filename="...")`);
    }
    const details = Boolean(args.details);
    if (!details) {
      const status = getIndexStatusUltraMinimal(filename);
      if (Boolean(args.json)) return legacyJsonResult(LEGACY_CONTROL_WARNING, status);
      return legacyTextResult(LEGACY_CONTROL_WARNING, formatIndexStatusUltraMinimal(status));
    }
    await refreshJobsStateFromDisk();
    const status = await getIndexStatus(filename, { probePdf: Boolean(args.probe_pdf) });
    if (Boolean(args.json)) return legacyJsonResult(LEGACY_CONTROL_WARNING, status);
    return legacyTextResult(LEGACY_CONTROL_WARNING, formatIndexStatus(status));
}

async function handle_rebuild_artifact(args = {}, meta = {}) {
  const name = meta.name || "rebuild_artifact";
    const filename = String(args.filename || "").trim();
    if (!filename) {
      throw new Error('filename is required for deprecated rebuild_artifact; prefer mcp_control(action="rebuild_artifact", filename="...")');
    }
    const artifact = normalizeArtifactName(args.artifact);
    const forceLock = Boolean(args.force_lock);
    const force = Boolean(args.force);
    const chunkSize = clampChunkSize(args.chunk_size);
    const chunkOverlap = clampChunkOverlap(args.chunk_overlap, chunkSize);
    const allowFullRebuild = args.allow_full_rebuild === undefined ? true : Boolean(args.allow_full_rebuild);
    const cascadeDependents = Boolean(args.cascade_dependents);
    const backgroundDefault = ["all", "core", "chunk-index", "pages"].includes(artifact);
    const background = args.background === undefined ? backgroundDefault : Boolean(args.background);
  
    if (background) {
      const job = await startRebuildArtifactJob(filename, artifact, { forceLock, force, chunkSize, chunkOverlap, allowFullRebuild, cascadeDependents });
      return legacyTextResult(LEGACY_CONTROL_WARNING, [
        `Started background artifact rebuild for ${filename}.`,
        `Artifact: ${artifact}`,
        `Job ID: ${job.id}`,
        "",
        `Poll: mcp_control(action="job_status", job_id="${job.id}")`,
        `Check artifacts: mcp_control(action="index_status_lite", filename="${filename}")`,
      ].join("\n"));
    }
  
    const result = await rebuildArtifact(filename, artifact, { forceLock, force, chunkSize, chunkOverlap, allowFullRebuild, cascadeDependents });
    if (result.ok === false) {
      return legacyTextResult(LEGACY_CONTROL_WARNING, [
        `Artifact rebuild did not complete for ${filename}.`,
        `Artifact: ${artifact}`,
        `Error: ${result.error || "unknown"}`,
        result.hint ? `Hint: ${result.hint}` : null,
        "",
        "Machine summary JSON:",
        JSON.stringify(result, null, 2),
      ].filter(Boolean).join("\n"));
    }
    const status = await getIndexStatus(filename);
    return legacyTextResult(LEGACY_CONTROL_WARNING, [
      `Rebuilt artifact for ${filename}.`,
      `Artifact: ${artifact}`,
      `Rebuilt: ${result.rebuilt.join(", ")}`,
      `Counts: ${JSON.stringify(result.counts)}`,
      "",
      formatIndexStatus(status),
    ].join("\n"));
}

async function handle_index_pdf(args = {}, meta = {}) {
  const name = meta.name || "index_pdf";
    const filename = args.filename;
    const force = Boolean(args.force);
    const forceLock = Boolean(args.force_lock);
    const mode = String(args.mode || DEFAULT_INDEX_JOB_MODE).trim().toLowerCase();
    const indexPath = safeIndexPath(filename);
    const lockPath = safeIndexLockPath(filename);
    const pdfStat = await getFileStat(filename);
  
    if (!force && (await pathExists(indexPath))) {
      try {
        const raw = await fs.readFile(indexPath, "utf-8");
        const indexData = JSON.parse(raw);
  
        if (isIndexUsable(indexData, pdfStat)) {
          const pageCache = await loadPagesCache(filename) || { pages: [], pageCount: indexData.pageCount };
          const sectionsIndex = await loadSectionsIndex(filename) || { sectionCount: indexData.sectionCount || 0 };
          const registersIndex = await loadRegistersIndex(filename) || { registerCount: indexData.registerCount || 0 };
          const bitfieldsIndex = await loadBitfieldsIndex(filename) || { bitfieldCount: indexData.bitfieldCount || 0 };
          const sequencesIndex = await loadSequencesIndex(filename) || { sequenceCount: indexData.sequenceCount || 0 };
          const cautionsIndex = await loadCautionsIndex(filename) || { cautionCount: indexData.cautionCount || 0 };
          const pagesCachePath = safePagesCachePath(filename);
          const sectionsIndexPath = safeSectionsIndexPath(filename);
          const registersIndexPath = safeRegistersIndexPath(filename);
          const bitfieldsIndexPath = safeBitfieldsIndexPath(filename);
          const sequencesIndexPath = safeSequencesIndexPath(filename);
          const cautionsIndexPath = safeCautionsIndexPath(filename);
  
          return textResult(
            [
              `Index already exists for ${filename}.`,
              `Use force=true to rebuild.`,
              "",
              `Pages: ${indexData.pageCount}`,
              `Chunks: ${indexData.chunkCount}`,
              `Registers: ${registersIndex.registerCount}`,
              `Bitfields: ${bitfieldsIndex.bitfieldCount}`,
              `Sequences: ${sequencesIndex.sequenceCount}`,
              `Cautions: ${cautionsIndex.cautionCount}`,
              `Created: ${indexData.createdAt}`,
              "",
              `Pages cache: ready`,
              `Pages cache path: ${pagesCachePath}`,
              `Pages cached: ${pageCache.pages.length}`,
              "",
              `Sections index: ready`,
              `Sections index path: ${sectionsIndexPath}`,
              `Sections detected: ${sectionsIndex.sectionCount}`,
              "",
              `Registers index: ready`,
              `Registers index path: ${registersIndexPath}`,
        `Bitfields index path: ${bitfieldsIndexPath}`,
              `Registers detected: ${registersIndex.registerCount}`,
              "",
              `Bitfields index: ready`,
              `Bitfields index path: ${bitfieldsIndexPath}`,
              `Bitfields detected: ${bitfieldsIndex.bitfieldCount}`,
              "",
              `Sequences index: ready`,
              `Sequences index path: ${sequencesIndexPath}`,
              `Sequences detected: ${sequencesIndex.sequenceCount}`,
              "",
              `Cautions index: ready`,
              `Cautions index path: ${cautionsIndexPath}`,
              `Cautions detected: ${cautionsIndex.cautionCount}`,
            ].join("\n")
          );
        }
      } catch {
        // Broken index files are rebuilt below.
      }
    }
  
    const chunkSize = clampChunkSize(args.chunk_size);
    const chunkOverlap = clampChunkOverlap(args.chunk_overlap, chunkSize);
  
    let pageCount = 0;
    try { pageCount = await getPdfPageCount(filename); } catch { pageCount = 0; }
    const shouldBackground = mode === "background" || (mode !== "foreground" && pageCount >= LARGE_PDF_BACKGROUND_PAGE_THRESHOLD);
    if (shouldBackground) {
      const job = await startIndexPdfJob(filename, { chunkSize, chunkOverlap, forceLock });
      return textResult([
        `Indexing for ${filename} started as a background job to avoid MCP client timeout.`,
        `Pages: ${pageCount || "unknown"}`,
        `Threshold: ${LARGE_PDF_BACKGROUND_PAGE_THRESHOLD} pages`,
        `Job ID: ${job.id}`,
        "",
        `Poll: mcp_control(action="job_status", job_id="${job.id}")`,
        `Persistent job state: ${safeJobsStatePath()}`,
        `When done, rerun doctor(filename="${filename}") or mcp_control(action="index_status_lite", filename="${filename}").`,
        "",
        `To force blocking behavior anyway, call index_pdf(filename="${filename}", mode="foreground", force=${force ? "true" : "false"}).`,
      ].join("\n"));
    }
  
    const indexData = await buildPdfIndex(filename, {
      chunkSize,
      chunkOverlap,
      forceLock,
      reusePageCache: true,
    });
  
    const pagesCachePath = safePagesCachePath(filename);
    const sectionsIndexPath = safeSectionsIndexPath(filename);
    const registersIndexPath = safeRegistersIndexPath(filename);
    const bitfieldsIndexPath = safeBitfieldsIndexPath(filename);
    const sequencesIndexPath = safeSequencesIndexPath(filename);
    const cautionsIndexPath = safeCautionsIndexPath(filename);
    const bitfieldsIndex = await loadBitfieldsIndex(filename) || { bitfieldCount: indexData.bitfieldCount || 0 };
    const sequencesIndex = await loadSequencesIndex(filename) || { sequenceCount: indexData.sequenceCount || 0 };
    const cautionsIndex = await loadCautionsIndex(filename) || { cautionCount: indexData.cautionCount || 0 };
  
    return textResult(
      [
        `Indexed ${filename} successfully.`,
        `Pages: ${indexData.pageCount}`,
        `Chunks: ${indexData.chunkCount}`,
        `Sections detected: ${indexData.sectionCount}`,
        `Registers detected: ${indexData.registerCount}`,
        `Bitfields detected: ${indexData.bitfieldCount || bitfieldsIndex.bitfieldCount}`,
        `Sequences detected: ${indexData.sequenceCount || sequencesIndex.sequenceCount}`,
        `Cautions detected: ${indexData.cautionCount || cautionsIndex.cautionCount}`,
        `Chunk size: ${indexData.chunkSize}`,
        `Chunk overlap: ${indexData.chunkOverlap}`,
        `Created: ${indexData.createdAt}`,
        `Index path: ${indexPath}`,
        `Index lock path: ${lockPath}`,
        `Atomic write: enabled`,
        `Pages cache path: ${pagesCachePath}`,
        `Sections index path: ${sectionsIndexPath}`,
        `Registers index path: ${registersIndexPath}`,
        `Bitfields index path: ${bitfieldsIndexPath}`,
        `Sequences index path: ${sequencesIndexPath}`,
      ].join("\n")
    );
}

export function createControlHandlers(_context = null) {
  return Object.freeze({
    "list_pdfs": handle_list_pdfs,
    "plan_manual_workflow": handle_plan_manual_workflow,
    "explain_tool_usage": handle_explain_tool_usage,
    "eval_health_check": handle_eval_health_check,
    "mcp_control": handle_mcp_control,
    "list_eval_cases": handle_list_eval_cases,
    "run_eval": handle_run_eval,
    "doctor": handle_doctor_or_validate_index,
    "validate_index": handle_doctor_or_validate_index,
    "pdf_info": handle_pdf_info,
    "start_index_pdf": handle_start_index_pdf,
    "job_status": handle_job_status,
    "list_jobs": handle_list_jobs,
    "cancel_job": handle_cancel_job,
    "cleanup_jobs": handle_cleanup_jobs,
    "mcp_server_ping": handle_mcp_server_ping,
    "pdf_index_status_lite": handle_pdf_index_status_lite,
    "index_status": handle_index_status,
    "rebuild_artifact": handle_rebuild_artifact,
    "index_pdf": handle_index_pdf,
  });
}
