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

async function handle_search_pdf(args = {}, meta = {}) {
  const name = meta.name || "search_pdf";
    const filename = args.filename;
    const query = String(args.query || "").trim();
    const topK = clampTopK(args.top_k);
  
    if (!query) throw new Error("query is required");
  
    const { results } = await searchPdfIndex(filename, query, topK);
    return textResult(withVisualSemanticGuard(formatSearchResults(results, query), query, { filename, query, mode: "search" }));
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
  
    return textResult(withVisualSemanticGuard(formatHybridSearchResults(payload), query, { filename, query, mode: "search" }));
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
    const guardInput = [String(args.query || args.task || ""), text].filter(Boolean).join("\n");
    const body = [
      `Source: ${source}`,
      `Range: ${start}-${end}`,
      "",
      text || `No extractable text found from page ${start} to page ${end}.`,
    ].join("\n");
    return textResult(withVisualSemanticGuard(body, guardInput, { filename, mode: "read" }));
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
  
    const guardInput = [String(args.query || args.task || ""), chunk.text || ""].filter(Boolean).join("\n");
    return textResult(withVisualSemanticGuard(
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
      ].join("\n"), guardInput, { filename, mode: "read" })
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

async function handle_extract_layout_tables_from_pages(args = {}, meta = {}) {
  const name = meta.name || "extract_layout_tables_from_pages";
    const filename = args.filename;
    const startPage = Number(args.start_page);
    const endPage = Number(args.end_page);
    const minColumns = Number(args.min_columns || 2);
    const kind = String(args.kind || "auto").trim();
  
    const tables = await extractTablesFromPages(filename, { startPage, endPage, minColumns });
    const formatted = formatLayoutExtractedTables(tables, kind);
    const guardInput = [String(args.query || args.task || ""), formatted].filter(Boolean).join("\n");
    return textResult(withVisualSemanticGuard(formatted, guardInput, { filename, mode: "layout-table", force: detectVisualSemanticIntent(guardInput).triggered }));
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

export function createManualEvidenceHandlers(_context = null) {
  return Object.freeze({
    "search_pdf": handle_search_pdf,
    "hybrid_search_pdf": handle_hybrid_search_pdf,
    "chunk_type_stats": handle_chunk_type_stats,
    "read_pdf_pages": handle_read_pdf_pages,
    "read_pdf_chunk": handle_read_pdf_chunk,
    "list_registers": handle_list_registers,
    "find_bitfield": handle_find_bitfield,
    "list_bitfields": handle_list_bitfields,
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
    "find_section": handle_find_section,
  });
}
