import { activateRuntimePortRegistry, bindRuntimePorts } from "../core/runtime-ports.js";

import * as module2 from "../services/indexing.js";
import * as module3 from "../domains/manual-intelligence.js";
import * as sequences from "../domains/sequences.js";
import * as cautionSearch from "../domains/caution-search.js";
import * as module4 from "../services/pdf.js";
import * as module5 from "../workflows/manual-workflow.js";
import * as module6 from "../services/search.js";
import * as module7 from "../workflows/driver-pack.js";
import * as module8 from "../domains/figures.js";
import * as module9 from "../workflows/source-review.js";
import * as module10 from "../services/doctor.js";
import * as module11 from "../domains/cautions.js";
import * as module12 from "../workflows/profiles.js";
import * as module13 from "../services/jobs.js";
import * as module14 from "../eval/runtime.js";
import * as module15 from "../domains/visual-evidence.js";
import * as tables from "../domains/tables.js";
import * as hybrid from "./hybrid-runtime.js";
import * as ocr from "../services/ocr.js";
import * as figureSemantics from "../domains/figure-semantics.js";

export function wireRuntimePorts(context) {
  const registry = context?.runtimePorts;
  if (!registry) throw new Error("context.runtimePorts is required");
  activateRuntimePortRegistry(registry);
  bindRuntimePorts({

    "buildBitFieldQueries": module6.buildBitFieldQueries,
    "buildBitfieldsIndex": module6.buildBitfieldsIndex,
    "buildCautionsIndex": module11.buildCautionsIndex,
    "buildFigureOcrWithPython": ocr.buildFigureOcrWithPython,
    "buildDriverCompletenessChecklist": module12.buildDriverCompletenessChecklist,
    "buildDriverEvidencePack": module7.buildDriverEvidencePack,
    "buildDriverTaskPlan": module7.buildDriverTaskPlan,
    "buildFiguresIndex": module8.buildFiguresIndex,
    "buildManualWorkflowPlan": module5.buildManualWorkflowPlan,
    "buildPagesCache": hybrid.buildPagesCacheHybrid,
    "buildPdfIndex": module2.buildPdfIndex,
    "buildRegisterQueries": module6.buildRegisterQueries,
    "buildRegistersIndex": module2.buildRegistersIndex,
    "buildSearchText": module2.buildSearchText,
    "buildSectionsIndex": module2.buildSectionsIndex,
    "buildSequencesIndex": sequences.buildSequencesIndex,
    "buildSourceReviewPromptPack": module9.buildSourceReviewPromptPack,
    "buildStructuredArtifacts": hybrid.tryBuildStructuredArtifactsHybrid,
    "buildTablesIndex": hybrid.buildTablesIndexHybrid,

    "cautionMatchesFilter": module11.cautionMatchesFilter,
    "chunkTypeAdjustmentForHybrid": module2.chunkTypeAdjustmentForHybrid,

    "clampDriverPackRegisters": cautionSearch.clampDriverPackRegisters,
    "clampDriverPackSummaries": cautionSearch.clampDriverPackSummaries,
    "clampDriverTaskRegisters": cautionSearch.clampDriverTaskRegisters,

    "classifyCautionLine": cautionSearch.classifyCautionLine,
    "collectDriverReviewVisualEvidence": module15.collectDriverReviewVisualEvidence,
    "collectRegisterContext": module6.collectRegisterContext,
    "collectSectionContext": sequences.collectSectionContext,

    "compareDriverRequirements": module12.compareDriverRequirements,

    "countWordOccurrences": module6.countWordOccurrences,
    "detectHeadings": module2.detectHeadings,
    "doctorOnePdf": module10.doctorOnePdf,
    "doctorPdfs": module10.doctorPdfs,
    "ensureDefaultDriverProfiles": module12.ensureDefaultDriverProfiles,
    "ensureDefaultEvalFixtureFiles": module14.ensureDefaultEvalFixtureFiles,
    "ensureDefaultEvalProfileFiles": module14.ensureDefaultEvalProfileFiles,
    "ensureEvalCasesFile": module14.ensureEvalCasesFile,

    "exactRegisterContextMatches": module7.exactRegisterContextMatches,
    "extractBitfieldTable": module3.extractBitfieldTable,
    "extractBitfieldTableFromIndex": module6.extractBitfieldTableFromIndex,
    "extractCautionEvidenceLines": cautionSearch.extractCautionEvidenceLines,
    "extractPdfPages": hybrid.extractPdfPagesHybrid,
    "extractRegisterTable": module3.extractRegisterTable,
    "extractRegisterRowsFromCoordinateTable": module3.extractRegisterRowsFromCoordinateTable,
    "extractTablesFromPages": module3.extractTablesFromPages,
    "extractTablesFromPagesEngine": hybrid.extractTablesFromPagesHybrid,
    "findCautionInIndex": cautionSearch.findCautionInIndex,
    "findFigure": module8.findFigure,
    "findSequenceInIndex": sequences.findSequenceInIndex,
    "flattenChecklistRequirements": module12.flattenChecklistRequirements,
    "formatCautionResults": cautionSearch.formatCautionResults,
    "formatChunkTypeStats": module2.formatChunkTypeStats,
    "formatCompareDriverRequirements": module12.formatCompareDriverRequirements,
    "formatDoctorReport": module10.formatDoctorReport,
    "formatDriverCompletenessChecklist": module12.formatDriverCompletenessChecklist,
    "formatDriverEvidencePack": module7.formatDriverEvidencePack,
    "formatDriverTaskPlan": module7.formatDriverTaskPlan,
    "formatDriverVisualEvidenceSection": module15.formatDriverVisualEvidenceSection,
    "formatEvalHealthReport": module5.formatEvalHealthReport,
    "formatExtractedBitfieldTable": module6.formatExtractedBitfieldTable,
    "formatExtractedRegisterTable": module3.formatExtractedRegisterTable,
    "formatHybridSearchResults": module6.formatHybridSearchResults,
    "formatManualWorkflowPlan": module5.formatManualWorkflowPlan,
    "formatModuleProfile": module12.formatModuleProfile,
    "formatPersistentCautionList": module11.formatPersistentCautionList,
    "formatRegisterIndexResults": module2.formatRegisterIndexResults,
    "formatRegisterListResults": module2.formatRegisterListResults,
    "formatSearchResults": module6.formatSearchResults,
    "formatSequenceListResults": sequences.formatSequenceListResults,
    "formatSourceReviewPromptPack": module9.formatSourceReviewPromptPack,
    "formatVerifyRegisterUsage": module7.formatVerifyRegisterUsage,
    "formatVisualEvidenceGateSection": module15.formatVisualEvidenceGateSection,
    "getCautionsForRegister": module11.getCautionsForRegister,
    "getBitfieldsIndex": module6.getBitfieldsIndex,
    "getChunkTypeStats": module2.getChunkTypeStats,
    "getFigureContext": module8.getFigureContext,
    "getFileStat": module14.getFileStat,
    "getModuleProfile": module12.getModuleProfile,
    "getPagesCache": module4.getPagesCache,
    "getPdfPageCount": hybrid.getPdfPageCountHybrid,

    "getRegistersIndex": module2.getRegistersIndex,
    "getSectionsIndex": module2.getSectionsIndex,
    "getSequenceFromIndex": sequences.getSequenceFromIndex,
    "groupRegistersForDriverPack": module7.groupRegistersForDriverPack,
    "hybridSearchPdf": module6.hybridSearchPdf,
    "inferModuleType": module7.inferModuleType,
    "isDoctorCoreCheck": module10.isDoctorCoreCheck,

    "isNonRegisterSignal": module2.isNonRegisterSignal,

    "likelyLinuxSubsystem": module7.likelyLinuxSubsystem,
    "lineContainsBitfield": module3.lineContainsBitfield,
    "listCautionsFromIndex": module11.listCautionsFromIndex,
    "listEvalFixtureFiles": module14.listEvalFixtureFiles,
    "listFigures": module8.listFigures,
    "listPdfFiles": module14.listPdfFiles,
    "listRegistersFromIndex": module2.listRegistersFromIndex,
    "listSequencesFromIndex": sequences.listSequencesFromIndex,
    "loadArtifactManifest": module13.loadArtifactManifest,
    "loadCautionsIndex": module11.loadCautionsIndex,
    "loadEvalCases": module14.loadEvalCases,
    "loadPagesCache": module4.loadPagesCache,
    "loadPdfDocument": module4.loadPdfDocument,
    "loadPdfIndex": module2.loadPdfIndex,
    "loadRegistersIndex": module2.loadRegistersIndex,
    "loadSectionsIndex": module2.loadSectionsIndex,
    "loadSequencesIndex": sequences.loadSequencesIndex,
    "loadTablesIndex": tables.loadTablesIndex,
    "looksLikeRegisterSymbol": module2.looksLikeRegisterSymbol,

    "mergeUniqueStrings": module12.mergeUniqueStrings,
    "multiQuerySearch": module7.multiQuerySearch,
    "normalizeBitFieldName": module6.normalizeBitFieldName,

    "normalizeRegisterName": module2.normalizeRegisterName,
    "normalizeReviewDepth": module9.normalizeReviewDepth,
    "normalizeReviewOutputFormat": module9.normalizeReviewOutputFormat,
    "normalizeSequenceTopic": sequences.normalizeSequenceTopic,
    "normalizeStringArray": module7.normalizeStringArray,

    "nowIso": module13.nowIso,

    "q": module5.q,
    "queryTablesIndex": tables.queryTablesIndex,
    "quoteForPromptCall": module9.quoteForPromptCall,

    "resolveDriverProfile": module12.resolveDriverProfile,
    "rebuildFigureSemanticsArtifact": figureSemantics.rebuildFigureSemanticsArtifact,
    "runEvalHealthCheck": module5.runEvalHealthCheck,

    "scoreCautionChunk": cautionSearch.scoreCautionChunk,
    "scoreSequenceEntry": sequences.scoreSequenceEntry,
    "scoreSimpleText": sequences.scoreSimpleText,
    "searchPdfIndex": module6.searchPdfIndex,
    "searchRegistersIndex": module2.searchRegistersIndex,
    "searchSectionsIndex": module6.searchSectionsIndex,
    "selectKeyRegistersForDriverPack": module7.selectKeyRegistersForDriverPack,

    "summarizeRegister": module3.summarizeRegister,
    "summarizeRegisterEntryFast": module3.summarizeRegisterEntryFast,
    "tokenizeQuery": module6.tokenizeQuery,
    "validateDriverProfileCatalog": module12.validateDriverProfileCatalog,
    "verifyRegisterUsage": module7.verifyRegisterUsage,
    "visualEvidenceDriverWarnings": module15.visualEvidenceDriverWarnings,
    "visualEvidenceGateNeedsVerification": module15.visualEvidenceGateNeedsVerification,
    "visualEvidenceGateSuggestedCalls": module15.visualEvidenceGateSuggestedCalls,
    "visualEvidenceGateWarnings": module15.visualEvidenceGateWarnings,
    "visualEvidenceToEvidenceContractItems": module15.visualEvidenceToEvidenceContractItems,

    "writeArtifactManifest": module13.writeArtifactManifest,
  }, registry);
  return registry;
}
