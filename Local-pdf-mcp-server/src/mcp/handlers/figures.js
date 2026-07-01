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

async function handle_search_figures(args = {}, meta = {}) {
  const result = await searchFigures(args.filename, { query: args.query, page: args.page, section: args.section, kind: args.kind, limit: args.limit ?? args.top_k, buildIfMissing: Boolean(args.build_if_missing) });
  return jsonResult(result);
}

function mimeTypeForImagePath(imagePath = "") {
  const ext = path.extname(String(imagePath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

export function normalizeFigureImageTransport(value) {
  const raw = String(value || "metadata").trim().toLowerCase();
  if (raw === "mcp_image") return "mcp_image";
  if (raw === "image_url" || raw === "data_uri") return "image_url";
  return "metadata";
}

function normalizeFigureImageUrlMaxBytes(value) {
  const fallback = 6 * 1024 * 1024;
  const parsed = Number(value || process.env.RENESAS_MCP_IMAGE_URL_MAX_BYTES || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function handle_get_figure_image(args = {}, meta = {}) {
  const result = await getFigureImage(args.filename, String(args.figure_id || "").trim(), { dpi: args.dpi, image_path: args.image_path });
  const transport = normalizeFigureImageTransport(args.transport);
  const mimeType = mimeTypeForImagePath(result.image_path);
  if (!result.image_path || !result.image_access?.exists) {
    return jsonResult({
      ...result,
      image_transport: {
        available: false,
        mode: "metadata",
        mcp_image_content_returned: false,
        reason: "canonical_image_missing",
        client_action_required: "rebuild_figure_manifest_or_ensure_canonical_image_cache_exists",
        canonical_image_path: result.image_path || "",
        local_path: result.image_access?.local_path || "",
        mimeType
      }
    });
  }

  const statForMetadata = await fs.stat(result.image_access.local_path).catch(() => null);

  if (transport === "metadata") {
    const fileSize = statForMetadata?.size ?? 0;
    const text = [
      "Canonical figure image metadata is available.",
      `canonical_image_path: ${result.image_path}`,
      `local_path: ${result.image_access.local_path}`,
      "file_exists: true",
      `file_size_bytes: ${fileSize}`,
      `mime: ${mimeType}`,
      result.render?.width || result.render?.height ? `Dimensions: ${result.render.width || 0}x${result.render.height || 0}` : "Dimensions: unavailable",
      "",
      "Image transport mode: metadata (canonical path contract).",
      "This MCP tool can provide the canonical image path, but it cannot guarantee that your MCP client forwards image pixels to the model. For visual-semantic analysis, attach/open canonical_image_path as actual image input. If no actual image input is available, return NO_IMAGE_INPUT.",
      "Do not make visual semantic claims from OCR/caption/text/context metadata alone."
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        ...result,
        image_transport: {
          available: true,
          mode: "metadata",
          client_can_render_mcp_image: false,
          mcp_image_content_returned: false,
          client_action_required: "open_or_attach_local_image",
          canonical_image_path: result.image_path,
          local_path: result.image_access.local_path,
          file_exists: true,
          file_size_bytes: fileSize,
          mimeType,
          warning: "This MCP tool can provide the canonical image path, but it cannot guarantee that your MCP client forwards image pixels to the model. For visual-semantic analysis, attach/open canonical_image_path as actual image input. If no actual image input is available, return NO_IMAGE_INPUT."
        }
      }
    };
  }

  if (transport === "image_url") {
    const stat = await fs.stat(result.image_access.local_path);
    const maxBytes = normalizeFigureImageUrlMaxBytes(args.max_bytes);
    if (stat.size > maxBytes) {
      return {
        content: [{ type: "text", text: "Canonical image exists but is too large for experimental/client-dependent image_url transport. Use metadata and open/attach canonical_image_path as actual image input." }],
        structuredContent: {
          ...result,
          image_transport: {
            available: false,
            mode: "image_url",
            reason: "image_too_large_for_data_uri_transport",
            max_bytes: maxBytes,
            actual_bytes: stat.size,
            canonical_image_path: result.image_path,
            local_path: result.image_access.local_path,
            fallback_transport: "metadata"
          }
        }
      };
    }
    const data = await fs.readFile(result.image_access.local_path, { encoding: "base64" });
    const dataUri = `data:${mimeType};base64,${data}`;
    return {
      content: [
        {
          type: "text",
          text: [
            "Canonical figure image prepared as experimental/client-dependent imageUrl/data URI.",
            `Image path: ${result.image_path}`,
            `MIME: ${mimeType}`,
            "Image transport mode: image_url.",
            "The image data URI is available in structuredContent.image_transport.imageUrls, but this does not guarantee model vision input.",
            "RICA/VS Code may reduce MCP tool results to text-only; attach/open canonical_image_path as actual image input before visual-semantic claims.",
            "Do not answer from page_text/OCR/text extraction alone."
          ].join("\n")
        }
      ],
      structuredContent: {
        ...result,
        image_transport: {
          available: true,
          mode: "image_url",
          mimeType,
          mcp_image_content_returned: false,
          imageUrl: {
            url: dataUri
          },
          imageUrls: [
            dataUri
          ],
          canonical_image_path: result.image_path,
          local_path: result.image_access.local_path,
          client_action_required: "experimental_client_dependent_attach_or_open_canonical_image_path_as_actual_model_image_input",
          experimental: true,
          client_dependent: true,
          not_guaranteed_to_reach_model_vision_input: true
        }
      }
    };
  }

  const data = await fs.readFile(result.image_access.local_path, { encoding: "base64" });
  const text = [
    "Canonical figure image loaded as experimental/client-dependent MCP image content.",
    `Source: ${result.image_path}`,
    "Image transport mode: mcp_image.",
    "MCP image content is client-dependent and is not guaranteed to reach model vision input; RICA/VS Code may reduce tool results to text-only.",
    "image_path is only a locator; attach/open the actual PNG or otherwise confirm real image input before semantic claims.",
    "Do not answer from page_text/OCR/text extraction alone."
  ].join("\n");
  return {
    content: [
      { type: "text", text },
      { type: "image", data, mimeType }
    ],
    structuredContent: {
      ...result,
      image_transport: {
        available: true,
        mode: "mcp_image",
        client_can_render_mcp_image: true,
        mcp_image_content_returned: true,
        experimental: true,
        client_dependent: true,
        not_guaranteed_to_reach_model_vision_input: true,
        content_type: "mcp_image_content",
        mimeType,
        canonical_image_path: result.image_path,
        local_path: result.image_access.local_path
      }
    }
  };
}

async function handle_get_figure_context_pack(args = {}, meta = {}) {
  const result = await getFigureContextPack(args.filename, String(args.figure_id || "").trim(), {
    include_ocr: Boolean(args.include_ocr),
    include_tables: args.include_tables !== false,
    include_cautions: args.include_cautions !== false,
    dpi: args.dpi,
  });
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

async function handle_table_coverage_report(args = {}, meta = {}) {
  const result = await tableCoverageReport(args.filename, { buildIfMissing: Boolean(args.build_if_missing) });
  return jsonResult(result);
}

function figureSemanticArtifactSummary(artifact = null) {
  if (!artifact) return null;
  return {
    schemaVersion: artifact.schemaVersion,
    serverVersion: artifact.serverVersion,
    filename: artifact.filename,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    sourceFingerprint: artifact.sourceFingerprint,
    semanticCount: artifact.semanticCount,
  };
}

function figureSemanticSearchSummary(item = {}) {
  const { score, ...record } = item;
  const summary = figureSemanticSummary(record);
  return score === undefined ? summary : { score, ...summary };
}

async function handle_analyze_figure_semantics(args = {}, meta = {}) {
  const result = await analyzeFigureSemantics(args.filename, {
    ...args,
    generateOcr: args.generate_ocr,
  });
  return jsonResult({
    cached: Boolean(result.cached),
    artifact: figureSemanticArtifactSummary(result.artifact),
    record: figureSemanticSummary(result.record),
  });
}

async function handle_get_figure_semantics(args = {}, meta = {}) {
  const result = await getFigureSemantics(args.filename, String(args.figure_id || "").trim());
  return jsonResult({
    artifact: figureSemanticArtifactSummary(result.artifact),
    record: figureSemanticSummary(result.record),
  });
}

async function handle_list_figure_semantics(args = {}, meta = {}) {
  const result = await listFigureSemantics(args.filename, {
    page: args.page,
    figure_type: args.figure_type,
  });
  return jsonResult({
    filename: result.filename,
    semanticCount: result.semanticCount,
    artifact: figureSemanticArtifactSummary(result.artifact),
    records: (result.records || []).map((record) => figureSemanticSummary(record)),
  });
}

async function handle_search_figure_semantics(args = {}, meta = {}) {
  const result = await searchFigureSemantics(args.filename, {
    query: args.query,
    page: args.page,
    figure_type: args.figure_type,
  });
  return jsonResult({
    filename: result.filename,
    query: result.query,
    figure_type: result.figure_type,
    resultCount: result.resultCount,
    artifact: figureSemanticArtifactSummary(result.artifact),
    results: (result.results || []).map((item) => figureSemanticSearchSummary(item)),
  });
}

async function handle_rebuild_figure_semantics(args = {}, meta = {}) {
  const result = await rebuildFigureSemanticsArtifact(args.filename, {
    page: args.page,
    force: Boolean(args.force),
    generateOcr: args.generate_ocr,
  });
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
    });
    return textResult(formatVisualReviewHandoffPack(pack));
}

async function handle_check_pdf_renderers(args = {}, meta = {}) {
  const name = meta.name || "check_pdf_renderers";
    const availability = await detectPdfRenderers();
    return textResult(formatRendererAvailability(availability));
}

export function createFigureHandlers(_context = null) {
  return Object.freeze({
    "list_figures": handle_list_figures,
    "search_figures": handle_search_figures,
    "get_figure_image": handle_get_figure_image,
    "get_figure_context_pack": handle_get_figure_context_pack,
    "rebuild_figure_manifest": handle_rebuild_figure_manifest,
    "ocr_figure_for_search": handle_ocr_figure_for_search,
    "table_coverage_report": handle_table_coverage_report,
    "analyze_figure_semantics": handle_analyze_figure_semantics,
    "get_figure_semantics": handle_get_figure_semantics,
    "list_figure_semantics": handle_list_figure_semantics,
    "search_figure_semantics": handle_search_figure_semantics,
    "rebuild_figure_semantics": handle_rebuild_figure_semantics,
    "add_visual_evidence": handle_add_visual_evidence,
    "list_visual_evidence": handle_list_visual_evidence,
    "get_visual_evidence": handle_get_visual_evidence,
    "visual_evidence_report": handle_visual_evidence_report,
    "visual_evidence_verification_queue": handle_visual_evidence_verification_queue,
    "verify_visual_evidence": handle_verify_visual_evidence,
    "visual_review_handoff_pack": handle_visual_review_handoff_pack,
    "check_pdf_renderers": handle_check_pdf_renderers,
  });
}
