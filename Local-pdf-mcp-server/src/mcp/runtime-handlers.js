import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DRIVER_PACK_MODE, DEFAULT_INDEX_JOB_MODE, DOCUMENTS_DIR, DRIVER_ARTIFACT_SCHEMA_VERSION, LARGE_PDF_BACKGROUND_PAGE_THRESHOLD, MAX_PAGE_RANGE, SERVER_VERSION } from "../core/runtime-constants.js";
import { formatManifestSummary, sourceFingerprint } from "../artifacts/manifest.js";
import { atomicWriteFile, atomicWriteJson, clampBitfieldListTopK, clampChunkOverlap, clampChunkSize, clampRegisterListTopK, clampTopK, formatIndexStatusUltraMinimal, getIndexStatusUltraMinimal, getPdfSourceInfo, isIndexLockStale, jsonResult, pathExists, readIndexLock, safeArtifactManifestPath, safeBitfieldsIndexPath, safeCautionsIndexPath, safeDriverPackJsonPath, safeDriverPackMarkdownPath, safeDriverPackPath, safeDriverTaskPlanJsonPath, safeDriverTaskPlanMarkdownPath, safeDriverTaskPlanPath, safeFigureOcrIndexPath, safeFiguresIndexPath, safeHybridQualityReportJsonPath, safeHybridQualityReportMarkdownPath, safeIndexLockPath, safeIndexPath, safeJobsStatePath, safePagesCachePath, safePdfPath, safeRegistersIndexPath, safeSectionsIndexPath, safeSequencesIndexPath, textResult } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { clampCautionListTopK, formatCautionsForRegister, formatPersistentCautionList, getCautionsForRegister, getCautionsIndex, listCautionsFromIndex, loadCautionsIndex, persistentCautionFallbackForRegister } from "../domains/cautions.js";
import { findFigure, formatFigureContext, formatFigureList, getFigureContext, listFigures, listFigureManifest, searchFigures, getFigureImage, getFigureContextPack, rebuildFigureManifest, ocrFigureForSearch } from "../domains/figures.js";
import { clampRegisterSummaryTopK, extractBitfieldTable, extractPinmuxTable, extractRegisterTable, extractTablesFromPages, findBitfieldInIndex, formatBitfieldResults, formatExtractedPinmuxTable, formatExtractedRegisterTable, formatExtractedTables, formatLayoutExtractedTables, formatRegisterSummary, summarizeRegister } from "../domains/manual-intelligence.js";
import { clampSequenceListTopK, findSequenceInIndex, formatPersistentSequenceResult, formatSequenceListResults, formatSequenceResults, getSequenceFromIndex, listSequencesFromIndex, loadSequencesIndex } from "../domains/sequences.js";
import { findCautionInIndex, formatCautionResults } from "../domains/caution-search.js";
import { detectPdfRenderers, formatRegionRenderResult, formatRenderFigureRegionResult, formatRenderFigureResult, formatRenderResult, formatRendererAvailability, renderFigurePage, renderFigureRegion, renderPdfPage, renderPdfRegion } from "../domains/rendering.js";
import { addVisualEvidence, buildVisualEvidenceReport, buildVisualEvidenceVerificationQueue, buildVisualReviewHandoffPack, formatAddVisualEvidence, formatGetVisualEvidence, formatListVisualEvidence, formatVerifyVisualEvidence, formatVisualEvidenceReport, formatVisualEvidenceVerificationQueue, formatVisualReviewHandoffPack, getVisualEvidence, listVisualEvidence, updateVisualEvidenceVerification } from "../domains/visual-evidence.js";
import { DEFAULT_GOLDEN_PROFILE } from "../eval/golden.js";
import { formatEvalCases, formatEvalReport, getFileStat, listPdfFiles, loadEvalCases, maybeWriteEvalReport, runEvalSuite } from "../eval/runtime.js";
import { doctorPdfs, formatDoctorReport, maybeWriteDoctorReports } from "../services/doctor.js";
import { buildPdfIndex, formatChunkTypeStats, formatRegisterIndexResults, formatRegisterListResults, getChunkTypeStats, isIndexUsable, listRegistersFromIndex, loadPdfIndex, loadRegistersIndex, loadSectionsIndex, looksLikeRegisterSymbol, searchRegistersIndex } from "../services/indexing.js";
import { advisoryHealthFromArtifactStatus, cancelBackgroundJob, cleanupBackgroundJobs, coreHealthFromArtifactStatus, formatIndexStatus, formatJobStatus, formatJobsList, getIndexStatus, jobs, normalizeArtifactName, nowIso, pdfInfoArtifactBlock, rebuildArtifact, refreshJobsStateFromDisk, startIndexPdfJob, startRebuildArtifactJob, writeArtifactManifest } from "../services/jobs.js";
import { cleanupCache, cleanupFigureCache, formatOcrHealthReport, getCacheStatus, getFigureCacheStatus, getOcrHealth, inspectFigureOnDemand, ocrFigureOnDemand, renderFigureOnDemand } from "../services/ocr.js";
import { getHybridRuntimeStatus } from "../services/python-worker.js";
import { loadPagesCache } from "../services/pdf.js";
import { buildRegisterQueries, clampHybridTopK, formatBitfieldListResults, formatExtractedBitfieldTable, formatHybridSearchResults, formatSearchResults, formatSectionResults, hybridSearchPdf, listBitfieldsFromIndex, loadBitfieldsIndex, searchPdfIndex, searchSectionsIndex } from "../services/search.js";
import { buildDriverEvidencePack, buildDriverEvidencePackContract, buildDriverTaskPlan, buildDriverTaskPlanEvidenceContract, buildSectionQueries, formatDriverEvidencePack, formatDriverTaskPlan, formatVerifyRegisterUsage, multiQuerySearch, normalizeStringArray, verifyRegisterUsage } from "../workflows/driver-pack.js";
import { buildManualWorkflowPlan, buildStep407CompatibilityReport, formatEvalHealthReport, formatManualWorkflowPlan, formatStep407CompatibilityReport, formatToolUsage, maybeWriteEvalHealthReport, runEvalHealthCheck } from "../workflows/manual-workflow.js";
import { buildDriverCompletenessChecklist, compareDriverRequirements, formatCompareDriverRequirements, formatDriverCompletenessChecklist, formatDriverProfilesList, formatModuleProfile, getModuleProfile, listDriverProfiles, saveModuleProfile } from "../workflows/profiles.js";
import { buildSourceReviewPromptPack, formatSourceReviewPromptPack } from "../workflows/source-review.js";

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

async function handle_eval_health_check(args = {}, meta = {}) {
  const name = meta.name || "eval_health_check";
    const step40Action = String(args.step40_action || "health").trim().toLowerCase();
    if (step40Action && step40Action !== "health") {
      // Step 40.6: route status/job actions through eval_health_check because
      // some VS Code AI-agent MCP clients keep cancelling newly-added tool
      // names even when older tools are callable. This reuses the known-good
      // eval_health_check transport path and avoids adding more tool names.
      if (step40Action === "ping") {
        return textResult([
          "MCP server ping via eval_health_check: OK",
          `Server version: ${SERVER_VERSION}`,
          `Generated: ${nowIso()}`,
          "Transport: eval_health_check(step40_action=ping)",
        ].join("\n"));
      }
      if (step40Action === "compat_report") {
        const report = buildStep407CompatibilityReport();
        if (Boolean(args.json)) return textResult(JSON.stringify(report, null, 2));
        return textResult(formatStep407CompatibilityReport(report));
      }
      if (step40Action === "index_status_lite") {
        const status = getIndexStatusUltraMinimal(args.filename);
        if (Boolean(args.json)) return textResult(JSON.stringify(status, null, 2));
        return textResult(formatIndexStatusUltraMinimal(status));
      }
      if (step40Action === "ocr_health") {
        const status = await getOcrHealth({ force: true });
        if (Boolean(args.json)) return textResult(JSON.stringify(status, null, 2));
        return textResult(formatOcrHealthReport(status));
      }
      if (step40Action === "rebuild_artifact") {
        const filename = args.filename;
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
          `Mode: detached-worker via eval_health_check`,
          "",
          `Poll via: eval_health_check(step40_action="job_status", job_id="${job.id}")`,
          `List via: eval_health_check(step40_action="list_jobs")`,
          `Persistent job state: ${safeJobsStatePath()}`,
        ].join("\n"));
      }
      if (step40Action === "job_status") {
        await refreshJobsStateFromDisk();
        const jobId = String(args.job_id || "").trim();
        const job = jobs.get(jobId);
        return textResult(formatJobStatus(job));
      }
      if (step40Action === "list_jobs") {
        await refreshJobsStateFromDisk();
        return textResult(formatJobsList());
      }
      if (step40Action === "cancel_job") {
        const jobId = String(args.job_id || "").trim();
        if (!jobId) throw new Error("job_id is required");
        const job = cancelBackgroundJob(jobId, String(args.reason || "Cancelled by user").trim() || "Cancelled by user");
        if (!job) return textResult(`Job not found: ${jobId}`);
        return textResult(formatJobStatus(job));
      }
      if (step40Action === "cleanup_jobs") {
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
      if (step40Action === "cache_status") {
        const status = await getCacheStatus(args);
        return jsonResult(status);
      }
      if (step40Action === "cleanup_cache") {
        const status = await cleanupCache(args);
        return jsonResult(status);
      }
      if (step40Action === "figure_cache_status") {
        const status = await getFigureCacheStatus(args);
        return jsonResult(status);
      }
      if (step40Action === "cleanup_figure_cache") {
        const status = await cleanupFigureCache(args);
        return jsonResult(status);
      }
      throw new Error(`Unknown eval_health_check step40_action: ${args.step40_action}`);
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
          `Next action: start_index_pdf(filename="${filename}") for large manuals, then rerun pdf_info/doctor.`,
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
      `Poll: job_status(job_id="${job.id}")`,
      `List jobs: list_jobs()`,
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
    const jobId = String(args.job_id || "").trim();
    if (!jobId) throw new Error("job_id is required");
    const job = cancelBackgroundJob(jobId, String(args.reason || "Cancelled by user").trim() || "Cancelled by user");
    if (!job) return textResult(`Job not found: ${jobId}`);
    return textResult(formatJobStatus(job));
}

async function handle_cleanup_jobs(args = {}, meta = {}) {
  const name = meta.name || "cleanup_jobs";
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

async function handle_mcp_server_ping(args = {}, meta = {}) {
  const name = meta.name || "mcp_server_ping";
    return textResult(`MCP server ping: OK\nServer version: ${SERVER_VERSION}\nGenerated: ${nowIso()}`);
}

async function handle_pdf_index_status_lite(args = {}, meta = {}) {
  const name = meta.name || "pdf_index_status_lite";
    const status = getIndexStatusUltraMinimal(args.filename);
    if (Boolean(args.json)) return textResult(JSON.stringify(status, null, 2));
    return textResult(formatIndexStatusUltraMinimal(status));
}

async function handle_index_status(args = {}, meta = {}) {
  const name = meta.name || "index_status";
    const filename = args.filename;
    const details = Boolean(args.details);
    if (!details) {
      const status = getIndexStatusUltraMinimal(filename);
      if (Boolean(args.json)) return textResult(JSON.stringify(status, null, 2));
      return textResult(formatIndexStatusUltraMinimal(status));
    }
    await refreshJobsStateFromDisk();
    const status = await getIndexStatus(filename, { probePdf: Boolean(args.probe_pdf) });
    if (Boolean(args.json)) return textResult(JSON.stringify(status, null, 2));
    return textResult(formatIndexStatus(status));
}

async function handle_rebuild_artifact(args = {}, meta = {}) {
  const name = meta.name || "rebuild_artifact";
    const filename = args.filename;
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
      return textResult([
        `Started background artifact rebuild for ${filename}.`,
        `Artifact: ${artifact}`,
        `Job ID: ${job.id}`,
        "",
        `Poll: job_status(job_id="${job.id}")`,
        `Check artifacts: index_status(filename="${filename}")`,
      ].join("\n"));
    }
  
    const result = await rebuildArtifact(filename, artifact, { forceLock, force, chunkSize, chunkOverlap, allowFullRebuild, cascadeDependents });
    if (result.ok === false) {
      return textResult([
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
    return textResult([
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
        `Poll: job_status(job_id="${job.id}")`,
        `Persistent job state: ${safeJobsStatePath()}`,
        `When done, rerun doctor(filename="${filename}") or validate_index(filename="${filename}").`,
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

async function handle_search_pdf(args = {}, meta = {}) {
  const name = meta.name || "search_pdf";
    const filename = args.filename;
    const query = String(args.query || "").trim();
    const topK = clampTopK(args.top_k);
  
    if (!query) throw new Error("query is required");
  
    const { results } = await searchPdfIndex(filename, query, topK);
    return textResult(formatSearchResults(results, query));
}

async function handle_hybrid_search_pdf(args = {}, meta = {}) {
  const name = meta.name || "hybrid_search_pdf";
    const filename = args.filename;
    const query = String(args.query || "").trim();
    const register = String(args.register || "").trim();
    const intent = String(args.intent || "auto").trim() || "auto";
    const topK = clampHybridTopK(args.top_k);
  
    if (!query) throw new Error("query is required");
  
    const payload = await hybridSearchPdf(filename, query, {
      register,
      intent,
      topK,
    });
  
    return textResult(formatHybridSearchResults(payload));
}

async function handle_chunk_type_stats(args = {}, meta = {}) {
  const name = meta.name || "chunk_type_stats";
    const filename = args.filename;
    const includeExamples = args.include_examples !== false;
    const stats = await getChunkTypeStats(filename, { includeExamples });
    return textResult(formatChunkTypeStats(stats));
}

async function handle_read_pdf_pages(args = {}, meta = {}) {
  const name = meta.name || "read_pdf_pages";
    const filename = args.filename;
  
    let start = Math.floor(Number(args.start_page));
    let end = Math.floor(Number(args.end_page));
  
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error("start_page and end_page must be numbers");
    }
  
    if (start < 1) start = 1;
    if (end < start) end = start;
    if (end - start + 1 > MAX_PAGE_RANGE) end = start + MAX_PAGE_RANGE - 1;
  
    const pageCache = await loadPagesCache(filename);
    let selectedPages = [];
    let source = "pages cache";
  
    if (pageCache) {
      if (start > pageCache.pageCount) start = pageCache.pageCount;
      end = Math.min(end, pageCache.pageCount);
      selectedPages = pageCache.pages.filter((page) => page.page >= start && page.page <= end);
    } else {
      // Timeout-safe fallback: extract only requested pages, do not build full .pages.json.
      const partial = await extractPdfPages(filename, { startPage: start, endPage: end });
      selectedPages = partial.pages || [];
      source = "direct page extraction; full pages cache not built";
    }
  
    const text = selectedPages.map((p) => `--- Page ${p.page} ---\n${p.text}`).join("\n\n");
  
    return textResult([
      `Source: ${source}`,
      `Range: ${start}-${end}`,
      "",
      text || `No extractable text found from page ${start} to page ${end}.`,
    ].join("\n"));
}

async function handle_read_pdf_chunk(args = {}, meta = {}) {
  const name = meta.name || "read_pdf_chunk";
    const filename = args.filename;
    const chunkId = String(args.chunk_id || "").trim();
  
    if (!chunkId) throw new Error("chunk_id is required");
  
    const indexData = await loadPdfIndex(filename);
    const chunk = indexData.chunks.find((candidate) => candidate.id === chunkId);
  
    if (!chunk) {
      return textResult(
        [
          `Chunk not found: ${chunkId}`,
          `File: ${filename}`,
          "Use search_pdf, find_register, find_bitfield, or find_section to get valid chunk IDs.",
        ].join("\n")
      );
    }
  
    return textResult(
      [
        `ID: ${chunk.id}`,
        `File: ${chunk.filename}`,
        `Page: ${chunk.page}`,
        `Chunk: ${chunk.chunkIndex}`,
        `Headings: ${
          chunk.headings && chunk.headings.length
            ? chunk.headings.join(" | ")
            : "none"
        }`,
        `Registers: ${
          chunk.registers && chunk.registers.length
            ? chunk.registers.join(", ")
            : "none"
        }`,
        `Bit fields / symbols: ${
          chunk.bitFields && chunk.bitFields.length
            ? chunk.bitFields.slice(0, 60).join(", ")
            : "none"
        }`,
        "",
        chunk.text,
      ].join("\n")
    );
}

async function handle_list_registers(args = {}, meta = {}) {
  const name = meta.name || "list_registers";
    const filename = args.filename;
    const filter = String(args.filter || "").trim();
    const topK = clampRegisterListTopK(args.top_k);
    const includeLowConfidence = Boolean(args.include_low_confidence);
  
    const { registerIndex, results } = await listRegistersFromIndex(filename, {
      filter,
      topK,
      includeLowConfidence,
    });
  
    return textResult(formatRegisterListResults(registerIndex, results, filter));
}

async function handle_find_bitfield(args = {}, meta = {}) {
  const name = meta.name || "find_bitfield";
    const filename = args.filename;
    const bitfield = String(args.bitfield || "").trim();
    const register = String(args.register || "").trim();
    const topK = clampTopK(args.top_k);
  
    if (!bitfield) throw new Error("bitfield is required");
  
    const result = await findBitfieldInIndex(filename, bitfield, {
      register,
      topK,
    });
  
    return textResult(formatBitfieldResults(result));
}

async function handle_list_bitfields(args = {}, meta = {}) {
  const name = meta.name || "list_bitfields";
    const filename = args.filename;
    const register = String(args.register || "").trim();
    const filter = String(args.filter || "").trim();
    const topK = clampBitfieldListTopK(args.top_k);
    const includeLowConfidence = Boolean(args.include_low_confidence);
  
    const { bitfieldsIndex, results } = await listBitfieldsFromIndex(filename, {
      register,
      filter,
      topK,
      includeLowConfidence,
    });
  
    return textResult(formatBitfieldListResults(bitfieldsIndex, results, {
      register,
      filter,
    }));
}

async function handle_build_figures_index(args = {}, meta = {}) {
  const name = meta.name || "build_figures_index";
    const filename = args.filename;
    const result = await rebuildFigureManifest(filename, { force: Boolean(args.force) });
    return textResult([
      `Built figures/captions manifest for ${filename}.`,
      `Compatibility note: build_figures_index is a legacy alias; prefer rebuild_figure_manifest for new clients.`,
      `Path: ${result.manifest_path || safeFiguresIndexPath(filename)}`,
      `Pages: ${result.pageCount || 0}`,
      `Figures/captions: ${result.figureCount || 0}`,
      `Kind stats: ${JSON.stringify(result.kindStats || {})}`,
      "",
      `Next: list_figures(filename="${filename}") or search_figures(filename="${filename}", query="...")`,
    ].join("\n"));
}

async function handle_list_figures(args = {}, meta = {}) {
  const name = meta.name || "list_figures";
    const filename = args.filename;
    if (args.page || args.section || args.limit) return jsonResult(await listFigureManifest(filename, { page: args.page, section: args.section, limit: args.limit ?? args.top_k, buildIfMissing: Boolean(args.build_if_missing) }));
    const result = await listFigures(filename, {
      filter: String(args.filter || "").trim(),
      kind: String(args.kind || "").trim(),
      topK: args.top_k,
      buildIfMissing: Boolean(args.build_if_missing),
    });
    return textResult(formatFigureList(result, "list"));
}

async function handle_find_figure(args = {}, meta = {}) {
  const name = meta.name || "find_figure";
    const filename = args.filename;
    const result = await findFigure(filename, {
      query: String(args.query || "").trim(),
      kind: String(args.kind || "").trim(),
      topK: args.top_k,
    });
    return textResult(formatFigureList(result, "find"));
}


async function handle_search_figures(args = {}, meta = {}) {
  const result = await searchFigures(args.filename, { query: args.query, page: args.page, section: args.section, limit: args.limit ?? args.top_k, buildIfMissing: Boolean(args.build_if_missing) });
  return jsonResult(result);
}

async function handle_get_figure_image(args = {}, meta = {}) {
  const result = await getFigureImage(args.filename, String(args.figure_id || "").trim(), { dpi: args.dpi });
  return jsonResult(result);
}

async function handle_get_figure_context_pack(args = {}, meta = {}) {
  const result = await getFigureContextPack(args.filename, String(args.figure_id || "").trim(), { include_ocr: Boolean(args.include_ocr), include_tables: args.include_tables !== false, include_cautions: args.include_cautions !== false });
  return jsonResult(result);
}

async function handle_rebuild_figure_manifest(args = {}, meta = {}) {
  const result = await rebuildFigureManifest(args.filename, { page: args.page, force: Boolean(args.force) });
  return jsonResult(result);
}

async function handle_ocr_figure_for_search(args = {}, meta = {}) {
  const result = await ocrFigureForSearch(args.filename, String(args.figure_id || "").trim(), { force: Boolean(args.force) });
  return jsonResult(result);
}

async function handle_add_visual_evidence(args = {}, meta = {}) {
  const name = meta.name || "add_visual_evidence";
    const filename = args.filename;
    const result = await addVisualEvidence(filename, {
      figureId: String(args.figure_id || "").trim(),
      page: args.page,
      query: String(args.query || "").trim(),
      diagramType: String(args.diagram_type || "auto").trim(),
      renderedPath: String(args.rendered_path || "").trim(),
      renderedRegion: args.rendered_region || {},
      directVisualObservations: normalizeStringArray(args.direct_visual_observations),
      captionContextFacts: normalizeStringArray(args.caption_context_facts),
      extractedItems: args.extracted_items || {},
      engineeringInferences: normalizeStringArray(args.engineering_inferences),
      sourceImplications: normalizeStringArray(args.source_implications),
      uncertainties: normalizeStringArray(args.uncertainties),
      relatedRegisters: normalizeStringArray(args.related_registers),
      relatedBitfields: normalizeStringArray(args.related_bitfields),
      sourceFiles: normalizeStringArray(args.source_files),
      tags: normalizeStringArray(args.tags),
      verificationStatus: String(args.verification_status || "needs_verification").trim(),
      confidence: String(args.confidence || "medium").trim(),
      notes: String(args.notes || "").trim(),
    });
    return textResult(formatAddVisualEvidence(result));
}

async function handle_list_visual_evidence(args = {}, meta = {}) {
  const name = meta.name || "list_visual_evidence";
    const filename = args.filename;
    const result = await listVisualEvidence(filename, {
      filter: String(args.filter || "").trim(),
      diagramType: String(args.diagram_type || "").trim(),
      page: args.page,
      status: String(args.status || "").trim(),
      topK: args.top_k,
    });
    return textResult(formatListVisualEvidence(result));
}

async function handle_get_visual_evidence(args = {}, meta = {}) {
  const name = meta.name || "get_visual_evidence";
    const filename = args.filename;
    const result = await getVisualEvidence(filename, String(args.evidence_id || "").trim());
    return textResult(formatGetVisualEvidence(result));
}

async function handle_visual_evidence_report(args = {}, meta = {}) {
  const name = meta.name || "visual_evidence_report";
    const filename = args.filename;
    const report = await buildVisualEvidenceReport(filename, {
      filter: String(args.filter || "").trim(),
      diagramType: String(args.diagram_type || "").trim(),
      status: String(args.status || "").trim(),
      includeEntries: args.include_entries !== false,
      topK: args.top_k,
    });
    return textResult(formatVisualEvidenceReport(report));
}

async function handle_visual_evidence_verification_queue(args = {}, meta = {}) {
  const name = meta.name || "visual_evidence_verification_queue";
    const filename = args.filename;
    const result = await buildVisualEvidenceVerificationQueue(filename, {
      filter: String(args.filter || "").trim(),
      diagramType: String(args.diagram_type || "").trim(),
      page: args.page,
      includeObserved: args.include_observed !== false,
      includeRejected: Boolean(args.include_rejected),
      topK: args.top_k,
    });
    return textResult(formatVisualEvidenceVerificationQueue(result));
}

async function handle_verify_visual_evidence(args = {}, meta = {}) {
  const name = meta.name || "verify_visual_evidence";
    const filename = args.filename;
    const result = await updateVisualEvidenceVerification(filename, String(args.evidence_id || "").trim(), {
      status: String(args.status || "needs_verification").trim(),
      confidence: String(args.confidence || "").trim(),
      verificationNote: String(args.verification_note || "").trim(),
      supportingEvidence: Array.isArray(args.supporting_evidence) ? args.supporting_evidence : [],
      supportingToolCalls: normalizeStringArray(args.supporting_tool_calls),
      resolvedUncertainties: normalizeStringArray(args.resolved_uncertainties),
      remainingUncertainties: normalizeStringArray(args.remaining_uncertainties),
      tagsToAdd: normalizeStringArray(args.tags_to_add),
      notes: String(args.notes || "").trim(),
      reviewer: String(args.reviewer || "").trim(),
      allowWithoutSupport: Boolean(args.allow_without_support),
    });
    return textResult(formatVerifyVisualEvidence(result));
}

async function handle_visual_review_handoff_pack(args = {}, meta = {}) {
  const name = meta.name || "visual_review_handoff_pack";
    const filename = args.filename;
    const pack = await buildVisualReviewHandoffPack(filename, {
      query: String(args.query || "").trim(),
      figureId: String(args.figure_id || "").trim(),
      page: args.page,
      kind: String(args.kind || "").trim(),
      diagramType: String(args.diagram_type || "auto").trim(),
      task: String(args.task || "").trim(),
      sourceFiles: normalizeStringArray(args.source_files),
      reviewDepth: String(args.review_depth || "standard").trim(),
      outputFormat: String(args.output_format || "report").trim(),
      topK: args.top_k,
      includeLayoutTables: args.include_layout_tables !== false,
      includeRenderCommands: args.include_render_commands !== false,
    });
    return textResult(formatVisualReviewHandoffPack(pack));
}

async function handle_get_figure_context(args = {}, meta = {}) {
  const name = meta.name || "get_figure_context";
    const filename = args.filename;
    const result = await getFigureContext(filename, {
      figureId: String(args.figure_id || "").trim(),
      page: args.page,
      query: String(args.query || "").trim(),
      includePages: args.include_pages,
      includeLayoutTables: Boolean(args.include_layout_tables),
    });
    return textResult(formatFigureContext(result));
}

async function handle_check_pdf_renderers(args = {}, meta = {}) {
  const name = meta.name || "check_pdf_renderers";
    const availability = await detectPdfRenderers();
    return textResult(formatRendererAvailability(availability));
}

async function handle_render_pdf_region(args = {}, meta = {}) {
  const name = meta.name || "render_pdf_region";
    const filename = args.filename;
    const result = await renderPdfRegion(filename, {
      page: args.page,
      x: args.x,
      y: args.y,
      width: args.width,
      height: args.height,
      unit: args.unit || "percent",
      margin: args.margin,
      zoom: args.zoom,
      dpi: args.dpi,
      format: args.format || "png",
      renderer: args.renderer || "auto",
      fallbackFullPage: Boolean(args.fallback_full_page),
    });
    return textResult(formatRegionRenderResult(result));
}

async function handle_render_figure_region(args = {}, meta = {}) {
  const name = meta.name || "render_figure_region";
    const filename = args.filename;
    const result = await renderFigureRegion(filename, {
      figureId: String(args.figure_id || "").trim(),
      page: args.page,
      query: String(args.query || "").trim(),
      region: String(args.region || "auto").trim(),
      x: args.x,
      y: args.y,
      width: args.width,
      height: args.height,
      unit: args.unit || "percent",
      margin: args.margin,
      zoom: args.zoom,
      dpi: args.dpi,
      format: args.format || "png",
      renderer: args.renderer || "auto",
      includeContext: args.include_context !== false,
    });
    return textResult(formatRenderFigureRegionResult(result));
}

async function handle_render_pdf_page(args = {}, meta = {}) {
  const name = meta.name || "render_pdf_page";
    const filename = args.filename;
    const result = await renderPdfPage(filename, {
      page: args.page,
      dpi: args.dpi,
      format: args.format || "png",
      renderer: args.renderer || "auto",
      fallbackTextSvg: args.fallback_text_svg !== false,
    });
    return textResult(formatRenderResult(result));
}

async function handle_render_figure_page(args = {}, meta = {}) {
  const name = meta.name || "render_figure_page";
    const filename = args.filename;
    const result = await renderFigurePage(filename, {
      figureId: String(args.figure_id || "").trim(),
      page: args.page,
      query: String(args.query || "").trim(),
      dpi: args.dpi,
      format: args.format || "png",
      renderer: args.renderer || "auto",
      includeContext: args.include_context !== false,
    });
    return textResult(formatRenderFigureResult(result));
}

async function handle_render_figure(args = {}, meta = {}) {
  const name = meta.name || "render_figure";
    const result = await renderFigureOnDemand({
      filename: args.filename,
      figure_id: String(args.figure_id || "").trim(),
      page: args.page,
      bbox: args.bbox,
      scale: args.scale || (args.dpi ? Number(args.dpi) / 100 : undefined),
      force: Boolean(args.force),
    });
    return jsonResult(result);
}

async function handle_ocr_figure(args = {}, meta = {}) {
  const name = meta.name || "ocr_figure";
    const result = await ocrFigureOnDemand({
      filename: args.filename,
      figure_id: String(args.figure_id || "").trim(),
      page: args.page,
      bbox: args.bbox,
      engine: String(args.engine || "auto").trim(),
      mode: args.mode === undefined ? undefined : String(args.mode || "").trim(),
      force: Boolean(args.force),
    });
    return jsonResult(result);
}

async function handle_inspect_figure(args = {}, meta = {}) {
  const name = meta.name || "inspect_figure";
    const result = await inspectFigureOnDemand({
      filename: args.filename,
      figure_id: String(args.figure_id || "").trim(),
      page: args.page,
      bbox: args.bbox,
      mode: String(args.mode || "auto").trim(),
      parser: args.parser === undefined ? undefined : String(args.parser || "").trim(),
      include_context: args.include_context,
      context_pages: args.context_pages,
      force: Boolean(args.force),
    });
    return jsonResult(result);
}

async function handle_extract_layout_tables_from_pages(args = {}, meta = {}) {
  const name = meta.name || "extract_layout_tables_from_pages";
    const filename = args.filename;
    const startPage = Number(args.start_page);
    const endPage = Number(args.end_page);
    const minColumns = Number(args.min_columns || 2);
    const kind = String(args.kind || "auto").trim();
  
    const tables = await extractTablesFromPages(filename, { startPage, endPage, minColumns });
    return textResult(formatLayoutExtractedTables(tables, kind));
}

async function handle_extract_tables_from_pages(args = {}, meta = {}) {
  const name = meta.name || "extract_tables_from_pages";
    const filename = args.filename;
    const startPage = Number(args.start_page);
    const endPage = Number(args.end_page);
    const minColumns = Number(args.min_columns || 3);
  
    const tables = await extractTablesFromPages(filename, {
      startPage,
      endPage,
      minColumns,
    });
  
    return textResult(formatExtractedTables(tables));
}

async function handle_extract_pinmux_table(args = {}, meta = {}) {
  const name = meta.name || "extract_pinmux_table";
    const filename = args.filename;
    const startPage = args.start_page === undefined ? undefined : Number(args.start_page);
    const endPage = args.end_page === undefined ? undefined : Number(args.end_page);
    const minColumns = Number(args.min_columns || 2);
    const filter = String(args.filter || "").trim();
    const pin = String(args.pin || "").trim();
    const functionName = String(args.function || "").trim();
    const topK = clampRegisterListTopK(args.top_k);
    const table = await extractPinmuxTable(filename, { startPage, endPage, minColumns, filter, pin, functionName, topK });
    return textResult(formatExtractedPinmuxTable(table));
}

async function handle_extract_register_table(args = {}, meta = {}) {
  const name = meta.name || "extract_register_table";
    const filename = args.filename;
    const startPage = args.start_page === undefined ? undefined : Number(args.start_page);
    const endPage = args.end_page === undefined ? undefined : Number(args.end_page);
    const filter = String(args.filter || "").trim();
    const topK = clampRegisterListTopK(args.top_k);
  
    const table = await extractRegisterTable(filename, {
      startPage,
      endPage,
      filter,
      topK,
    });
  
    return textResult(formatExtractedRegisterTable(table));
}

async function handle_extract_bitfield_table(args = {}, meta = {}) {
  const name = meta.name || "extract_bitfield_table";
    const filename = args.filename;
    const register = String(args.register || "").trim();
    const topK = clampBitfieldListTopK(args.top_k);
  
    if (!register) throw new Error("register is required");
  
    const table = await extractBitfieldTable(filename, register, { topK });
    return textResult(formatExtractedBitfieldTable(table));
}

async function handle_summarize_register(args = {}, meta = {}) {
  const name = meta.name || "summarize_register";
    const filename = args.filename;
    const register = String(args.register || "").trim();
    const topK = clampRegisterSummaryTopK(args.top_k);
    const includeBitfieldEvidence = args.include_bitfield_evidence !== false;
  
    if (!register) throw new Error("register is required");
  
    const summary = await summarizeRegister(filename, register, {
      topK,
      includeBitfieldEvidence,
    });
  
    return textResult(formatRegisterSummary(summary));
}

async function handle_find_register(args = {}, meta = {}) {
  const name = meta.name || "find_register";
    const filename = args.filename;
    const register = String(args.register || "").trim();
    const topK = clampTopK(args.top_k);
  
    if (!register) throw new Error("register is required");
  
    const { results: registerResults } = await searchRegistersIndex(filename, register, topK);
    if (registerResults.length) {
      return textResult(formatRegisterIndexResults(registerResults, register));
    }
  
    const queries = buildRegisterQueries(register);
    const results = await multiQuerySearch(filename, queries, topK);
    return textResult(
      [
        `No direct register-index match for "${register}". Falling back to chunk search.`,
        "",
        formatSearchResults(results, register),
      ].join("\n")
    );
}

async function handle_list_sequences(args = {}, meta = {}) {
  const name = meta.name || "list_sequences";
    const filename = args.filename;
    const filter = String(args.filter || "").trim();
    const topK = clampSequenceListTopK(args.top_k);
  
    const { sequencesIndex, results } = await listSequencesFromIndex(filename, {
      filter,
      topK,
    });
  
    return textResult(formatSequenceListResults(sequencesIndex, results, filter));
}

async function handle_get_sequence(args = {}, meta = {}) {
  const name = meta.name || "get_sequence";
    const filename = args.filename;
    const topic = String(args.topic || "").trim();
    const register = String(args.register || "").trim();
  
    if (!topic) {
      throw new Error("topic is required");
    }
  
    const result = await getSequenceFromIndex(filename, topic, {
      register,
      topK: args.top_k,
    });
  
    return textResult(formatPersistentSequenceResult(result));
}

async function handle_find_sequence(args = {}, meta = {}) {
  const name = meta.name || "find_sequence";
    const filename = args.filename;
    const topic = String(args.topic || "").trim();
    const register = String(args.register || "").trim();
  
    if (!topic) {
      throw new Error("topic is required");
    }
  
    const persistent = await getSequenceFromIndex(filename, topic, {
      register,
      topK: args.top_k,
      allowFallback: false,
    });
    if (persistent.persistentMatches?.length) {
      return textResult(formatPersistentSequenceResult(persistent));
    }
  
    const result = await findSequenceInIndex(filename, topic, {
      register,
      topK: args.top_k,
    });
  
    return textResult(formatSequenceResults(result));
}

async function handle_find_caution(args = {}, meta = {}) {
  const name = meta.name || "find_caution";
    const filename = args.filename;
    const topic = String(args.topic || "").trim();
    const register = String(args.register || "").trim();
  
    if (!topic) {
      throw new Error("topic is required");
    }
  
    const persistent = await listCautionsFromIndex(filename, {
      filter: topic,
      register,
      topK: args.top_k,
    });
    if (persistent.results.length) {
      return textResult(formatPersistentCautionList(persistent.cautionsIndex, persistent.results, { filter: topic, register }));
    }
  
    const registerLikeTopic = !register && looksLikeRegisterSymbol(topic) ? topic : register;
    if (registerLikeTopic) {
      const cautionsIndex = await getCautionsIndex(filename);
      const fallbackResults = await persistentCautionFallbackForRegister(cautionsIndex, registerLikeTopic, {
        filter: register ? topic : "reserved bits write timing clear status flag",
        topK: args.top_k,
        filterExplicit: Boolean(register),
      });
      if (fallbackResults.length) {
        return textResult(formatCautionsForRegister({
          filename,
          register: registerLikeTopic,
          filter: register ? topic : "",
          cautionsIndex,
          results: fallbackResults,
          fallback: null,
          fallbackMode: "persistent-general",
        }));
      }
    }
  
    const result = await findCautionInIndex(filename, topic, {
      register,
      topK: args.top_k,
    });
  
    return textResult(formatCautionResults(result));
}

async function handle_list_cautions(args = {}, meta = {}) {
  const name = meta.name || "list_cautions";
    const filename = args.filename;
    const filter = String(args.filter || "").trim();
    const register = String(args.register || "").trim();
    const type = String(args.type || "").trim();
    const topK = clampCautionListTopK(args.top_k);
  
    const { cautionsIndex, results } = await listCautionsFromIndex(filename, {
      filter,
      register,
      type,
      topK,
    });
  
    return textResult(formatPersistentCautionList(cautionsIndex, results, { filter, register, type }));
}

async function handle_get_cautions_for_register(args = {}, meta = {}) {
  const name = meta.name || "get_cautions_for_register";
    const filename = args.filename;
    const register = String(args.register || "").trim();
    const filter = String(args.filter || "").trim();
    const includeDynamicFallback = Boolean(args.include_dynamic_fallback);
  
    if (!register) {
      throw new Error("register is required");
    }
  
    const result = await getCautionsForRegister(filename, register, {
      filter,
      topK: args.top_k,
      includeDynamicFallback,
    });
  
    return textResult(formatCautionsForRegister(result));
}

async function handle_analyze_module(args = {}, meta = {}) {
  const name = meta.name || "analyze_module";
    const filename = args.filename;
    const moduleType = String(args.module_type || "").trim();
    const focus = String(args.focus || "").trim();
    const force = Boolean(args.force);
  
    const profile = await getModuleProfile(filename, {
      moduleType,
      focus,
      refresh: force,
    });
  
    const paths = await saveModuleProfile(profile);
    const formatted = formatModuleProfile(profile);
    return textResult([
      formatted,
      "",
      `Module profile JSON saved: ${paths.jsonPath}`,
      `Module profile text saved: ${paths.textPath}`,
    ].join("\n"));
}

async function handle_get_module_profile(args = {}, meta = {}) {
  const name = meta.name || "get_module_profile";
    const filename = args.filename;
    const moduleType = String(args.module_type || "").trim();
    const focus = String(args.focus || "").trim();
    const refresh = Boolean(args.refresh);
  
    const profile = await getModuleProfile(filename, {
      moduleType,
      focus,
      refresh,
    });
  
    return textResult(formatModuleProfile(profile));
}

async function handle_list_driver_profiles(args = {}, meta = {}) {
  const name = meta.name || "list_driver_profiles";
    const createDefault = args.create_default !== false;
    const profiles = await listDriverProfiles({ createDefault });
    return textResult(formatDriverProfilesList(profiles));
}

async function handle_driver_completeness_checklist(args = {}, meta = {}) {
  const name = meta.name || "driver_completeness_checklist";
    const filename = args.filename;
    const subsystem = String(args.subsystem || "").trim();
    const driverFamily = String(args.driver_family || "").trim();
    const profile = String(args.profile || "").trim();
    const task = String(args.task || "").trim();
    const createDefault = args.create_default !== false;
  
    const checklist = await buildDriverCompletenessChecklist(filename, {
      subsystem,
      driverFamily,
      profile,
      task,
      createDefault,
      includeVisualEvidence: args.include_visual_evidence !== false,
      visualFilter: String(args.visual_filter || "").trim(),
      visualStatus: String(args.visual_status || "all").trim(),
      visualGate: String(args.visual_gate || "advisory").trim(),
    });
  
    return textResult(formatDriverCompletenessChecklist(checklist));
}

async function handle_prepare_driver_task(args = {}, meta = {}) {
  const name = meta.name || "prepare_driver_task";
    const filename = args.filename;
    const task = String(args.task || "").trim();
    const moduleType = String(args.module_type || "").trim();
    const focusRegisters = normalizeStringArray(args.focus_registers);
    const focusBitfields = normalizeStringArray(args.focus_bitfields);
    const mode = String(args.mode || "adaptive").trim();
    const budgetMs = args.budget_ms;
  
    if (!task) {
      throw new Error("task is required");
    }
  
    const plan = await buildDriverTaskPlan(filename, {
      task,
      moduleType,
      focusRegisters,
      focusBitfields,
      topRegisters: args.top_registers,
      mode,
      budgetMs,
    });
  
    const formatted = formatDriverTaskPlan(plan);
    const taskPlanPath = safeDriverTaskPlanPath(filename);
    const taskPlanJsonPath = safeDriverTaskPlanJsonPath(filename);
    const taskPlanMarkdownPath = safeDriverTaskPlanMarkdownPath(filename);
    const evidenceContract = buildDriverTaskPlanEvidenceContract(plan);
    await atomicWriteFile(taskPlanPath, formatted, "utf-8");
    await atomicWriteJson(taskPlanJsonPath, {
      schemaVersion: DRIVER_ARTIFACT_SCHEMA_VERSION,
      serverVersion: SERVER_VERSION,
      artifact: "driver-task-plan",
      filename,
      createdAt: plan.createdAt || nowIso(),
      sourceFingerprint: plan.sourceFingerprint || sourceFingerprint(await getPdfSourceInfo(filename)),
      plan,
      evidenceContract,
      textPath: taskPlanPath,
      markdownPath: taskPlanMarkdownPath,
    });
    await atomicWriteFile(taskPlanMarkdownPath, formatted, "utf-8");
    const manifest = await writeArtifactManifest(filename, { buildStatus: "driver-task-plan-ready", notes: ["driver task plan updated"] });
  
    return textResult([
      formatted,
      "",
      `Driver task plan saved: ${taskPlanPath}`,
      `Driver task plan JSON saved: ${taskPlanJsonPath}`,
      `Driver task plan Markdown saved: ${taskPlanMarkdownPath}`,
      `Artifact manifest saved: ${safeArtifactManifestPath(filename)} (${manifest.health})`,
    ].join("\n"));
}

async function handle_source_review_prompt_pack(args = {}, meta = {}) {
  const name = meta.name || "source_review_prompt_pack";
    const filename = args.filename;
    const pack = await buildSourceReviewPromptPack(filename, {
      subsystem: String(args.subsystem || "").trim(),
      driverFamily: String(args.driver_family || "").trim(),
      profile: String(args.profile || "").trim(),
      task: String(args.task || "").trim(),
      sourceFiles: normalizeStringArray(args.source_files),
      reviewDepth: String(args.review_depth || "standard").trim(),
      outputFormat: String(args.output_format || "report").trim(),
      createDefault: args.create_default !== false,
      includeVisualEvidence: args.include_visual_evidence !== false,
      visualFilter: String(args.visual_filter || "").trim(),
      visualStatus: String(args.visual_status || "all").trim(),
      visualGate: String(args.visual_gate || "advisory").trim(),
    });
    return textResult(formatSourceReviewPromptPack(pack));
}

async function handle_compare_driver_requirements(args = {}, meta = {}) {
  const name = meta.name || "compare_driver_requirements";
    const filename = args.filename;
    const comparison = await compareDriverRequirements(filename, {
      subsystem: String(args.subsystem || "").trim(),
      driverFamily: String(args.driver_family || "").trim(),
      profile: String(args.profile || "").trim(),
      task: String(args.task || "").trim(),
      sourceFiles: normalizeStringArray(args.source_files),
      sourceSummary: String(args.source_summary || "").trim(),
      implementedFeatures: normalizeStringArray(args.implemented_features),
      sourceObservations: normalizeStringArray(args.source_observations),
      missingFeatures: normalizeStringArray(args.missing_features),
      registerOperations: Array.isArray(args.register_operations) ? args.register_operations : [],
      createDefault: args.create_default !== false,
      includeVisualEvidence: args.include_visual_evidence !== false,
      visualFilter: String(args.visual_filter || "").trim(),
      visualStatus: String(args.visual_status || "all").trim(),
      visualGate: String(args.visual_gate || "advisory").trim(),
    });
    return textResult(formatCompareDriverRequirements(comparison));
}

async function handle_verify_register_usage(args = {}, meta = {}) {
  const name = meta.name || "verify_register_usage";
    const filename = args.filename;
    const register = String(args.register || "").trim();
    const operation = String(args.operation || "").trim();
    const bitfields = normalizeStringArray(args.bitfields);
    const accessType = String(args.access_type || "auto").trim();
    const intent = String(args.intent || "auto").trim();
    const sourceSnippet = String(args.source_snippet || "").trim();
    const topK = clampTopK(args.top_k);
    const includeHybrid = Boolean(args.include_hybrid);
    const budgetMs = args.budget_ms;
  
    if (!register) throw new Error("register is required");
    if (!operation) throw new Error("operation is required");
  
    const verification = await verifyRegisterUsage(filename, {
      register,
      operation,
      bitfields,
      accessType,
      intent,
      sourceSnippet,
      topK,
      includeHybrid,
      budgetMs,
    });
  
    return textResult(formatVerifyRegisterUsage(verification));
}

async function handle_build_driver_evidence_pack(args = {}, meta = {}) {
  const name = meta.name || "build_driver_evidence_pack";
    const filename = args.filename;
    const moduleType = String(args.module_type || "").trim();
    const focus = String(args.focus || "").trim();
    const mode = String(args.mode || DEFAULT_DRIVER_PACK_MODE).trim();
    const budgetMs = args.budget_ms;
  
    const pack = await buildDriverEvidencePack(filename, {
      moduleType,
      focus,
      mode,
      budgetMs,
      topRegisters: args.top_registers,
      topSummaries: args.top_summaries,
      includeVisualEvidence: args.include_visual_evidence !== false,
      visualFilter: String(args.visual_filter || "").trim(),
      visualStatus: String(args.visual_status || "all").trim(),
      visualGate: String(args.visual_gate || "advisory").trim(),
      visualTopK: args.visual_top_k,
    });
  
    const formatted = formatDriverEvidencePack(pack);
    const driverPackPath = safeDriverPackPath(filename);
    const driverPackJsonPath = safeDriverPackJsonPath(filename);
    const driverPackMarkdownPath = safeDriverPackMarkdownPath(filename);
    const evidenceContract = buildDriverEvidencePackContract(pack);
    await atomicWriteFile(driverPackPath, formatted, "utf-8");
    await atomicWriteJson(driverPackJsonPath, {
      schemaVersion: DRIVER_ARTIFACT_SCHEMA_VERSION,
      serverVersion: SERVER_VERSION,
      artifact: "driver-evidence-pack",
      filename,
      createdAt: pack.createdAt || nowIso(),
      sourceFingerprint: pack.sourceFingerprint || sourceFingerprint(await getPdfSourceInfo(filename)),
      pack,
      evidenceContract,
      textPath: driverPackPath,
      markdownPath: driverPackMarkdownPath,
    });
    await atomicWriteFile(driverPackMarkdownPath, formatted, "utf-8");
    const manifest = await writeArtifactManifest(filename, { buildStatus: "driver-pack-ready", notes: ["driver evidence pack updated"] });
  
    return textResult([
      formatted,
      "",
      `Driver evidence pack saved: ${driverPackPath}`,
      `Driver evidence pack JSON saved: ${driverPackJsonPath}`,
      `Driver evidence pack Markdown saved: ${driverPackMarkdownPath}`,
      `Artifact manifest saved: ${safeArtifactManifestPath(filename)} (${manifest.health})`,
    ].join("\n"));
}

async function handle_find_section(args = {}, meta = {}) {
  const name = meta.name || "find_section";
    const filename = args.filename;
    const section = String(args.section || "").trim();
    const topK = clampTopK(args.top_k);
  
    if (!section) throw new Error("section is required");
  
    const { results: sectionResults } = await searchSectionsIndex(filename, section, topK);
    if (sectionResults.length) {
      return textResult(formatSectionResults(sectionResults, section));
    }
  
    const queries = buildSectionQueries(section);
    const results = await multiQuerySearch(filename, queries, topK);
    return textResult(
      [
        `No direct section-index match for "${section}". Falling back to chunk search.`,
        "",
        formatSearchResults(results, section),
      ].join("\n")
    );
}

export function createRuntimeHandlers(_context = null) {
  return Object.freeze({
    "list_pdfs": handle_list_pdfs,
    "plan_manual_workflow": handle_plan_manual_workflow,
    "explain_tool_usage": handle_explain_tool_usage,
    "eval_health_check": handle_eval_health_check,
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
    "search_pdf": handle_search_pdf,
    "hybrid_search_pdf": handle_hybrid_search_pdf,
    "chunk_type_stats": handle_chunk_type_stats,
    "read_pdf_pages": handle_read_pdf_pages,
    "read_pdf_chunk": handle_read_pdf_chunk,
    "list_registers": handle_list_registers,
    "find_bitfield": handle_find_bitfield,
    "list_bitfields": handle_list_bitfields,
    "build_figures_index": handle_build_figures_index,
    "list_figures": handle_list_figures,
    "find_figure": handle_find_figure,
    "search_figures": handle_search_figures,
    "get_figure_image": handle_get_figure_image,
    "get_figure_context_pack": handle_get_figure_context_pack,
    "rebuild_figure_manifest": handle_rebuild_figure_manifest,
    "ocr_figure_for_search": handle_ocr_figure_for_search,
    "add_visual_evidence": handle_add_visual_evidence,
    "list_visual_evidence": handle_list_visual_evidence,
    "get_visual_evidence": handle_get_visual_evidence,
    "visual_evidence_report": handle_visual_evidence_report,
    "visual_evidence_verification_queue": handle_visual_evidence_verification_queue,
    "verify_visual_evidence": handle_verify_visual_evidence,
    "visual_review_handoff_pack": handle_visual_review_handoff_pack,
    "get_figure_context": handle_get_figure_context,
    "check_pdf_renderers": handle_check_pdf_renderers,
    "render_pdf_region": handle_render_pdf_region,
    "render_figure_region": handle_render_figure_region,
    "render_pdf_page": handle_render_pdf_page,
    "render_figure_page": handle_render_figure_page,
    "render_figure": handle_render_figure,
    "ocr_figure": handle_ocr_figure,
    "inspect_figure": handle_inspect_figure,
    "extract_layout_tables_from_pages": handle_extract_layout_tables_from_pages,
    "extract_tables_from_pages": handle_extract_tables_from_pages,
    "extract_pinmux_table": handle_extract_pinmux_table,
    "extract_register_table": handle_extract_register_table,
    "extract_bitfield_table": handle_extract_bitfield_table,
    "summarize_register": handle_summarize_register,
    "find_register": handle_find_register,
    "list_sequences": handle_list_sequences,
    "get_sequence": handle_get_sequence,
    "find_sequence": handle_find_sequence,
    "find_caution": handle_find_caution,
    "list_cautions": handle_list_cautions,
    "get_cautions_for_register": handle_get_cautions_for_register,
    "analyze_module": handle_analyze_module,
    "get_module_profile": handle_get_module_profile,
    "list_driver_profiles": handle_list_driver_profiles,
    "driver_completeness_checklist": handle_driver_completeness_checklist,
    "prepare_driver_task": handle_prepare_driver_task,
    "source_review_prompt_pack": handle_source_review_prompt_pack,
    "compare_driver_requirements": handle_compare_driver_requirements,
    "verify_register_usage": handle_verify_register_usage,
    "build_driver_evidence_pack": handle_build_driver_evidence_pack,
    "find_section": handle_find_section,
  });
}
