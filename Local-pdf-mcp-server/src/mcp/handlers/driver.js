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

export function createDriverHandlers(_context = null) {
  return Object.freeze({
    "analyze_module": handle_analyze_module,
    "get_module_profile": handle_get_module_profile,
    "list_driver_profiles": handle_list_driver_profiles,
    "driver_completeness_checklist": handle_driver_completeness_checklist,
    "prepare_driver_task": handle_prepare_driver_task,
    "source_review_prompt_pack": handle_source_review_prompt_pack,
    "compare_driver_requirements": handle_compare_driver_requirements,
    "verify_register_usage": handle_verify_register_usage,
    "build_driver_evidence_pack": handle_build_driver_evidence_pack,
  });
}
