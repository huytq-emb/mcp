import { appendEvidenceContract, atomicWriteJson, clampInteger, compactText, confidenceLevel, ensurePdfFilename, getPdfSourceInfo, makeEvidence, makeEvidenceContract, makeInference, makeNeedsVerification, normalizeForSearch, pathExists, safeVisualEvidencePath } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { DEFAULT_FIGURE_TOP_K, SERVER_VERSION, VISUAL_EVIDENCE_SCHEMA_VERSION } from "../core/runtime-constants.js";
import fs from "node:fs/promises";
import path from "node:path";
import { sourceFingerprint } from "../artifacts/manifest.js";


const findFigure = createRuntimePort("findFigure");
const getFigureContext = createRuntimePort("getFigureContext");

const listFigures = createRuntimePort("listFigures");


const normalizeRegisterName = createRuntimePort("normalizeRegisterName");
const normalizeReviewDepth = createRuntimePort("normalizeReviewDepth");
const normalizeReviewOutputFormat = createRuntimePort("normalizeReviewOutputFormat");
const normalizeStringArray = createRuntimePort("normalizeStringArray");

const quoteForPromptCall = createRuntimePort("quoteForPromptCall");

const scoreSimpleText = createRuntimePort("scoreSimpleText");


// -----------------------------------------------------------------------------
// Step 32: visual review handoff pack
// -----------------------------------------------------------------------------

export function normalizeVisualDiagramType(value) {
  const raw = String(value || "auto").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const allowed = new Set(["auto", "clock_tree", "timing", "block_diagram", "reset_flow", "interrupt_route", "pinmux", "sequence", "table", "other"]);
  return allowed.has(raw) ? raw : "auto";
}

export function inferVisualDiagramType(query = "", kind = "") {
  const text = normalizeForSearch(`${query} ${kind}`);
  if (/clock|pll|oscillator|clk|clock tree|clock distribution/.test(text)) return "clock_tree";
  if (/timing|waveform|read timing|write timing|setup|hold|cycle|pulse width/.test(text)) return "timing";
  if (/block diagram|configuration diagram|module configuration|overview diagram/.test(text)) return "block_diagram";
  if (/reset|power|standby|resume|suspend|initialization flow|setting flow/.test(text)) return "reset_flow";
  if (/interrupt|irq|intc|icu|route|routing|event/.test(text)) return "interrupt_route";
  if (/pin|pinmux|pfc|pmc|ioport|port function|multiplexed/.test(text)) return "pinmux";
  if (/sequence|flow|procedure|operation flow|setting flow/.test(text)) return "sequence";
  if (/table|register table|function assignment|configuration overview/.test(text)) return "table";
  return "other";
}

export function visualReviewDepthRules(depth) {
  const d = normalizeReviewDepth(depth);
  if (d === "quick") {
    return [
      "Find the most likely figure/table page and inspect caption/context first.",
      "Render only the top candidate or the supplied page/figure_id.",
      "Extract only the facts needed for the current task and mark the rest as needsVerification.",
    ];
  }
  if (d === "deep") {
    return [
      "Search figure captions, nearby section text, and layout tables for all relevant visual candidates.",
      "Render full page and at least one cropped/zoomed region for each important candidate.",
      "Separate facts read directly from visual evidence from inferences based on caption/context.",
      "Cross-check visual evidence against register/bitfield/sequence/caution tools before proposing a patch.",
      "If the diagram is ambiguous, request a tighter render_pdf_region crop rather than guessing.",
    ];
  }
  return [
    "Find the relevant figure/table candidates from captions/context.",
    "Get figure context and render the best candidate page/region.",
    "Extract concrete visual facts and list ambiguity explicitly.",
    "Use manual text/register tools to verify any driver-relevant conclusion.",
  ];
}

export function visualReviewOutputRules(format) {
  const f = normalizeReviewOutputFormat(format);
  if (f === "debug_plan") {
    return [
      "Final output must be a debug plan with hypotheses, visual evidence, manual-text evidence, and tests.",
      "Do not turn a diagram interpretation into a code change without a verification call or explicit uncertainty.",
    ];
  }
  if (f === "patch_plan") {
    return [
      "Final output must be a patch plan grouped by source file/function.",
      "Every hardware-register or DTS/pinctrl/clock/reset change must reference the relevant visual/manual evidence and remaining verification gaps.",
    ];
  }
  if (f === "checklist") {
    return [
      "Final output must be a checklist: visual evidence found / source impact / manual verification / needsVerification.",
    ];
  }
  return [
    "Final output must be a structured visual-review report.",
    "Use sections: visual target, evidence gathered, extracted facts, source-code implications, uncertainties, next actions.",
  ];
}

export function buildVisualReviewExtractionSchema(diagramType) {
  const common = {
    visual_target: "<caption/page/query being reviewed>",
    figure_id: "<figure id if available>",
    page: "<page number>",
    rendered_files: ["<full page or cropped render output paths>"],
    direct_visual_observations: ["<facts visible in the rendered figure/diagram>"],
    caption_context_facts: ["<facts from caption or nearby text>"],
    manual_text_cross_checks: ["<read_pdf_pages/get_figure_context/extract_layout_tables evidence>"],
    source_implications: ["<what this means for driver/DTS/source review>"],
    needs_verification: ["<ambiguities or facts not proven visually/manual-textually>"],
  };

  if (diagramType === "clock_tree") {
    return { ...common, clocks: ["<clock name/source/divider/gate relationship>"], reset_or_power_domains: ["<domain/reset relation if visible>"] };
  }
  if (diagramType === "timing") {
    return { ...common, signals: ["<signal name>"], edges: ["<edge/phase relationship>"], timing_constraints: ["<setup/hold/min/max/cycle timing>"], units: ["<ns/cycles/clock units>"] };
  }
  if (diagramType === "interrupt_route") {
    return { ...common, interrupt_sources: ["<source flag/signal>"], routing: ["<route/mux/controller relation>"], clear_or_mask_semantics: ["<status clear/mask relation if visible>"] };
  }
  if (diagramType === "pinmux") {
    return { ...common, pins: ["<pin/port>"], functions: ["<alternate function/peripheral signal>"], selectors: ["<PFC/PMC/mux select value if visible>"] };
  }
  if (diagramType === "reset_flow" || diagramType === "sequence") {
    return { ...common, steps: ["<ordered step>"], conditions: ["<precondition/poll/wait condition>"], registers_or_bits: ["<register/bit involved>"] };
  }
  if (diagramType === "block_diagram") {
    return { ...common, blocks: ["<block/module>"], connections: ["<signal/data/clock/reset connection>"], interfaces: ["<bus/peripheral interface>"] };
  }
  if (diagramType === "table") {
    return { ...common, table_roles: ["<columns/semantic roles>"], extracted_rows: ["<row facts>"], ambiguous_cells: ["<cells requiring manual check>"] };
  }
  return common;
}

export function figureCandidateCommandLines(filename, figure, options = {}) {
  const page = Number(figure?.page || options.page || 0);
  const figureId = figure?.id || "<figure-id>";
  const query = quoteForPromptCall(options.query || figure?.caption || "visual target");
  const includeLayout = options.includeLayoutTables !== false;
  const includeRender = options.includeRenderCommands !== false;
  const lines = [];
  if (figure?.id) {
    lines.push(`get_figure_context_pack(filename="${filename}", figure_id="${figureId}")`);
    if (includeRender) {
      lines.push(`open image_path from get_figure_context_pack visually`);
    }
  } else if (page) {
    lines.push(`search_figures(filename="${filename}", query="${query}", limit=5) then get_figure_context_pack(filename="${filename}", figure_id="<figure-id>")`);
    if (includeRender) {
      lines.push(`open image_path from get_figure_context_pack visually`);
    }
  }
  if (page) {
    lines.push(`read_pdf_pages(filename="${filename}", start_page=${page}, end_page=${page})`);
    if (includeLayout) lines.push(`extract_layout_tables_from_pages(filename="${filename}", start_page=${Math.max(1, page - 1)}, end_page=${page + 1}, kind="all")`);
  }
  return lines;
}

export async function buildVisualReviewHandoffPack(filename, options = {}) {
  ensurePdfFilename(filename);
  const query = String(options.query || "").trim();
  const figureId = String(options.figureId || "").trim();
  const page = Number(options.page || 0);
  const kind = String(options.kind || "").trim();
  const task = String(options.task || query || "visual manual evidence review").trim();
  const reviewDepth = normalizeReviewDepth(options.reviewDepth);
  const outputFormat = normalizeReviewOutputFormat(options.outputFormat);
  const includeLayoutTables = options.includeLayoutTables !== false;
  const includeRenderCommands = options.includeRenderCommands !== false;
  const topK = clampInteger(options.topK, 6, 1, DEFAULT_FIGURE_TOP_K);

  let diagramType = normalizeVisualDiagramType(options.diagramType);
  if (diagramType === "auto") diagramType = inferVisualDiagramType(`${query} ${task}`, kind);

  let figures = [];
  let context = null;
  let searchResult = null;
  const warnings = [];

  try {
    if (figureId || page) {
      context = await getFigureContext(filename, { figureId, page, query, includePages: 1, includeLayoutTables });
      figures = [context.figure];
    } else if (query) {
      searchResult = await findFigure(filename, { query, kind, topK });
      figures = searchResult.results || [];
      if (figures[0]) {
        context = await getFigureContext(filename, { figureId: figures[0].id, includePages: 1, includeLayoutTables }).catch((error) => {
          warnings.push(`Could not get context for top figure: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
      }
    } else {
      const listed = await listFigures(filename, { kind, topK });
      searchResult = listed;
      figures = listed.results || [];
    }
  } catch (error) {
    warnings.push(`Figure search/context failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const primaryFigure = context?.figure || figures[0] || null;
  const workflow = [
    `search_figures(filename="${filename}", query="${quoteForPromptCall(query || task)}", kind="${quoteForPromptCall(kind)}", limit=${topK})`,
  ];
  if (primaryFigure) workflow.push(...figureCandidateCommandLines(filename, primaryFigure, { query, includeLayoutTables, includeRenderCommands }));
  else if (page) workflow.push(...figureCandidateCommandLines(filename, null, { page, query, includeLayoutTables, includeRenderCommands }));
  else {
    workflow.push(`list_figures(filename="${filename}", filter="${quoteForPromptCall(query || task)}", kind="${quoteForPromptCall(kind)}", top_k=${topK})`);
    workflow.push(`get_figure_context_pack(filename="${filename}", figure_id="<figure-id>")`);
    if (includeRenderCommands) workflow.push(`open image_path from get_figure_context_pack visually`);
  }

  return {
    filename,
    createdAt: new Date().toISOString(),
    task,
    query,
    kind,
    diagramType,
    reviewDepth,
    outputFormat,
    sourceFiles: normalizeStringArray(options.sourceFiles),
    figures,
    primaryFigure,
    context,
    searchResult,
    workflow,
    depthRules: visualReviewDepthRules(reviewDepth),
    outputRules: visualReviewOutputRules(outputFormat),
    extractionSchema: buildVisualReviewExtractionSchema(diagramType),
    approvalRules: [
      "Do not infer driver behavior solely from a rendered diagram; cross-check with manual text/register/bitfield/sequence/caution evidence.",
      "When a visual edge/arrow/timing relation is unclear, request a tighter render_pdf_region/render_figure_region crop instead of guessing.",
      "Separate direct visual observations from caption/context text and from engineering inference.",
      "For code or DTS changes, map each visual fact to source impact and list remaining needsVerification.",
    ],
    warnings,
  };
}

export function buildVisualReviewHandoffContract(pack) {
  const evidence = (pack.figures || []).slice(0, 10).map((figure) => makeEvidence({
    source: "figures-index",
    evidenceType: figure.kind || "figure-caption",
    page: figure.page,
    quote: figure.caption || figure.title,
    confidence: figure.confidence || "medium",
    name: figure.id,
    field: pack.diagramType,
    tool: "visual_review_handoff_pack",
  }));

  const inference = [makeInference({
    statement: `Generated visual-review workflow for diagramType=${pack.diagramType}`,
    basis: pack.query || pack.task || (pack.primaryFigure ? pack.primaryFigure.caption : "figure/list context"),
    confidence: pack.primaryFigure ? "medium" : "low",
    risk: "Visual-review handoff pack guides analysis but does not itself interpret the rendered image.",
  })];

  const needsVerification = [makeNeedsVerification({
    item: "Rendered visual content",
    reason: "The pack creates the workflow and suggested render commands. The agent/user must inspect generated PNG/JPG/SVG outputs and record direct visual observations.",
    suggestedTools: pack.workflow.filter((line) => /render_figure|render_pdf|get_figure|read_pdf|extract_layout/.test(line)).slice(0, 8),
  })];

  return makeEvidenceContract({
    tool: "visual_review_handoff_pack",
    filename: pack.filename,
    query: pack.query || pack.task,
    evidence,
    inference,
    needsVerification,
    warnings: pack.warnings || [],
    recommendedNextTools: pack.workflow || [],
  });
}

export function formatVisualReviewHandoffPack(pack) {
  const lines = [];
  lines.push("Visual Review Handoff Pack");
  lines.push(`File: ${pack.filename}`);
  lines.push(`Created: ${pack.createdAt}`);
  lines.push(`Task: ${pack.task}`);
  lines.push(`Query: ${pack.query || "not specified"}`);
  lines.push(`Kind filter: ${pack.kind || "none"}`);
  lines.push(`Diagram type: ${pack.diagramType}`);
  lines.push(`Review depth: ${pack.reviewDepth}`);
  lines.push(`Output format: ${pack.outputFormat}`);
  if ((pack.sourceFiles || []).length) lines.push(`Source files: ${pack.sourceFiles.join(", ")}`);
  for (const warning of pack.warnings || []) lines.push(`Warning: ${warning}`);
  lines.push("");

  lines.push("1. Candidate figures/tables");
  if ((pack.figures || []).length) {
    lines.push("| # | ID | Page | Kind | Caption | Score/Conf |");
    lines.push("|---:|---|---:|---|---|---:|");
    (pack.figures || []).slice(0, 10).forEach((figure, index) => {
      lines.push(`| ${index + 1} | ${figure.id} | ${figure.page} | ${figure.kind} | ${String(figure.caption || figure.title || "").replace(/\|/g, "/").slice(0, 140)} | ${figure.matchScore || figure.confidence || 0} |`);
    });
  } else {
    lines.push("- No candidate figures found yet. Use the workflow commands below to search/list figures.");
  }
  lines.push("");

  if (pack.context?.figure) {
    lines.push("2. Primary figure context");
    lines.push(`- ID: ${pack.context.figure.id}`);
    lines.push(`- Page: ${pack.context.figure.page}`);
    lines.push(`- Kind: ${pack.context.figure.kind}`);
    lines.push(`- Caption: ${pack.context.figure.caption}`);
    if ((pack.context.figure.contextLines || []).length) {
      lines.push("- Caption-near context:");
      for (const line of pack.context.figure.contextLines.slice(0, 10)) lines.push(`  - ${line}`);
    }
    lines.push("");
  }

  lines.push("3. Mandatory visual-review workflow");
  for (const call of pack.workflow || []) lines.push(`- ${call}`);
  lines.push("");

  lines.push("4. Prompt to give the VS Code AI agent");
  lines.push("```");
  lines.push("You are reviewing hardware-manual visual evidence using the local PDF MCP server.");
  lines.push(`Manual PDF: ${pack.filename}`);
  lines.push(`Task: ${pack.task}`);
  lines.push(`Visual target/query: ${pack.query || "<discover relevant figure/table/diagram>"}`);
  lines.push(`Expected diagram type: ${pack.diagramType}`);
  if ((pack.sourceFiles || []).length) {
    lines.push("Also inspect these source/DTS files in the VS Code workspace:");
    for (const file of pack.sourceFiles) lines.push(`- ${file}`);
  }
  lines.push("");
  lines.push("Mandatory MCP workflow:");
  for (const call of pack.workflow || []) lines.push(`- ${call}`);
  lines.push("");
  lines.push("When you inspect rendered images, fill this extraction schema:");
  lines.push(JSON.stringify(pack.extractionSchema, null, 2));
  lines.push("");
  lines.push("Depth rules:");
  for (const rule of pack.depthRules || []) lines.push(`- ${rule}`);
  lines.push("");
  lines.push("Output rules:");
  for (const rule of pack.outputRules || []) lines.push(`- ${rule}`);
  lines.push("");
  lines.push("Approval rules:");
  for (const rule of pack.approvalRules || []) lines.push(`- ${rule}`);
  lines.push("```");
  lines.push("");

  lines.push("5. Extraction schema");
  lines.push(JSON.stringify(pack.extractionSchema, null, 2));
  lines.push("");
  lines.push("6. Approval rules");
  for (const rule of pack.approvalRules || []) lines.push(`- ${rule}`);

  return appendEvidenceContract(lines.join("\n"), buildVisualReviewHandoffContract(pack));
}


// -----------------------------------------------------------------------------
// Step 33: persisted visual evidence helpers
// -----------------------------------------------------------------------------

export function normalizeVisualEvidenceStatus(value) {
  const raw = String(value || "needs_verification").trim().toLowerCase();
  if (["observed", "needs_verification", "verified", "rejected"].includes(raw)) return raw;
  return "needs_verification";
}

export function visualEvidenceId(page = 0) {
  const pagePart = Number.isFinite(Number(page)) && Number(page) > 0 ? `p${Number(page)}` : "pna";
  return `ve-${pagePart}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function compactStringArray(values, maxItems = 40, maxChars = 360) {
  return normalizeStringArray(values).slice(0, maxItems).map((item) => compactText(item, maxChars));
}

export function normalizePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

export function flattenVisualExtractedItems(value) {
  const obj = normalizePlainObject(value);
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val)) {
      for (const item of val) lines.push(`${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`);
    } else if (val && typeof val === "object") {
      lines.push(`${key}: ${JSON.stringify(val)}`);
    } else if (val !== undefined && val !== null && String(val).trim()) {
      lines.push(`${key}: ${String(val)}`);
    }
  }
  return lines;
}

export async function loadVisualEvidenceIndex(filename) {
  const filePath = safeVisualEvidencePath(filename);
  if (!(await pathExists(filePath))) {
    return {
      schemaVersion: VISUAL_EVIDENCE_SCHEMA_VERSION,
      serverVersion: SERVER_VERSION,
      filename,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: [],
    };
  }
  const raw = await fs.readFile(filePath, "utf-8");
  const data = JSON.parse(raw);
  if (data.schemaVersion !== VISUAL_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported visual evidence schemaVersion ${data.schemaVersion}; expected ${VISUAL_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(data.entries)) data.entries = [];
  return data;
}

export async function visualEvidenceSourceMetadata(filename) {
  try {
    const source = await getPdfSourceInfo(filename);
    return {
      size: Number(source.size || 0),
      mtimeMs: Number(source.mtimeMs || 0),
      mtime: source.mtime || source.modified || "",
      fingerprint: sourceFingerprint(source),
    };
  } catch {
    return null;
  }
}

export async function saveVisualEvidenceIndex(filename, data) {
  data.schemaVersion = VISUAL_EVIDENCE_SCHEMA_VERSION;
  data.serverVersion = SERVER_VERSION;
  data.filename = filename;
  data.updatedAt = new Date().toISOString();
  if (!data.createdAt) data.createdAt = data.updatedAt;
  if (!Array.isArray(data.entries)) data.entries = [];
  const source = await visualEvidenceSourceMetadata(filename);
  if (source) data.source = source;
  await atomicWriteJson(safeVisualEvidencePath(filename), data);
  return data;
}

export async function resolveVisualEvidenceFigure(filename, { figureId = "", page = 0, query = "" } = {}) {
  if (!figureId && !page && !query) return null;
  try {
    const result = await getFigureContext(filename, { figureId, page, query, includePages: 0, includeLayoutTables: false });
    return result.figure || null;
  } catch {
    return null;
  }
}

export async function addVisualEvidence(filename, options = {}) {
  ensurePdfFilename(filename);
  const page = Number(options.page || 0);
  let diagramType = normalizeVisualDiagramType(options.diagramType || "auto");
  const query = String(options.query || "").trim();
  const figureId = String(options.figureId || "").trim();
  const figure = await resolveVisualEvidenceFigure(filename, { figureId, page, query });
  if (diagramType === "auto") diagramType = inferVisualDiagramType(`${query} ${figure?.caption || ""}`, figure?.kind || "");
  const source = await visualEvidenceSourceMetadata(filename);

  const entry = {
    id: visualEvidenceId(page || figure?.page || 0),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    filename,
    source,
    figureId: figureId || figure?.id || "",
    page: Number.isFinite(page) && page > 0 ? page : (figure?.page || null),
    query,
    diagramType,
    figure: figure ? {
      id: figure.id,
      page: figure.page,
      kind: figure.kind,
      caption: figure.caption || figure.title || "",
    } : null,
    renderedPath: String(options.renderedPath || "").trim(),
    renderedRegion: normalizePlainObject(options.renderedRegion),
    directVisualObservations: compactStringArray(options.directVisualObservations, 80),
    captionContextFacts: compactStringArray(options.captionContextFacts, 80),
    extractedItems: normalizePlainObject(options.extractedItems),
    engineeringInferences: compactStringArray(options.engineeringInferences, 80),
    sourceImplications: compactStringArray(options.sourceImplications, 80),
    uncertainties: compactStringArray(options.uncertainties, 80),
    relatedRegisters: compactStringArray(options.relatedRegisters, 60, 160),
    relatedBitfields: compactStringArray(options.relatedBitfields, 80, 160),
    sourceFiles: compactStringArray(options.sourceFiles, 80, 220),
    tags: compactStringArray(options.tags, 40, 80),
    verificationStatus: normalizeVisualEvidenceStatus(options.verificationStatus),
    confidence: confidenceLevel(options.confidence || "medium"),
    notes: compactText(String(options.notes || ""), 1000),
  };

  if (!entry.directVisualObservations.length && !entry.captionContextFacts.length && !flattenVisualExtractedItems(entry.extractedItems).length && !entry.engineeringInferences.length) {
    entry.uncertainties.push("No direct visual observations or extracted items were supplied when this evidence entry was created.");
    entry.verificationStatus = "needs_verification";
  }

  const index = await loadVisualEvidenceIndex(filename);
  index.entries.push(entry);
  await saveVisualEvidenceIndex(filename, index);
  return { filename, index, entry, path: safeVisualEvidencePath(filename) };
}

export function visualEvidenceSearchText(entry) {
  return normalizeForSearch([
    entry.id,
    entry.figureId,
    entry.query,
    entry.diagramType,
    entry.figure?.caption,
    entry.renderedPath,
    ...(entry.directVisualObservations || []),
    ...(entry.captionContextFacts || []),
    ...flattenVisualExtractedItems(entry.extractedItems),
    ...(entry.engineeringInferences || []),
    ...(entry.sourceImplications || []),
    ...(entry.uncertainties || []),
    ...(entry.relatedRegisters || []),
    ...(entry.relatedBitfields || []),
    ...(entry.sourceFiles || []),
    ...(entry.tags || []),
    entry.verificationStatus,
  ].filter(Boolean).join(" "));
}

export function filterVisualEvidenceEntries(entries, options = {}) {
  const filter = normalizeForSearch(options.filter || "");
  const diagramType = String(options.diagramType || "").trim().toLowerCase();
  const status = String(options.status || "").trim().toLowerCase();
  const page = Number(options.page || 0);
  return (entries || []).filter((entry) => {
    if (diagramType && String(entry.diagramType || "").toLowerCase() !== diagramType) return false;
    if (status && String(entry.verificationStatus || "").toLowerCase() !== status) return false;
    if (Number.isFinite(page) && page > 0 && Number(entry.page || 0) !== page) return false;
    if (filter && !visualEvidenceSearchText(entry).includes(filter)) return false;
    return true;
  });
}

export async function listVisualEvidence(filename, options = {}) {
  const index = await loadVisualEvidenceIndex(filename);
  const topK = clampInteger(options.topK, 20, 1, 200);
  const results = filterVisualEvidenceEntries(index.entries, options)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, topK);
  return { filename, path: safeVisualEvidencePath(filename), index, results, filter: options.filter || "" };
}

export async function getVisualEvidence(filename, evidenceId) {
  const index = await loadVisualEvidenceIndex(filename);
  const entry = (index.entries || []).find((item) => item.id === evidenceId);
  if (!entry) throw new Error(`Visual evidence entry not found: ${evidenceId}`);
  return { filename, path: safeVisualEvidencePath(filename), index, entry };
}

export function buildVisualEvidenceRecommendedTools(filename, entry) {
  const tools = [];
  if (entry.figureId) tools.push(`get_figure_context_pack(filename="${filename}", figure_id="${entry.figureId}")`);
  else if (entry.page) tools.push(`search_figures(filename="${filename}", query="${quoteForPromptCall(entry.query || entry.figure?.caption || "")}", limit=5) then get_figure_context_pack(filename="${filename}", figure_id="<figure-id>")`);
  if (entry.page) tools.push(`read_pdf_pages(filename="${filename}", start_page=${entry.page}, end_page=${entry.page})`);
  if (entry.page) tools.push(`open image_path from get_figure_context_pack visually`);
  for (const reg of (entry.relatedRegisters || []).slice(0, 3)) {
    tools.push(`verify_register_usage(filename="${filename}", register="${quoteForPromptCall(reg)}", operation="<operation related to visual evidence>", access_type="auto", intent="auto")`);
  }
  return tools.slice(0, 10);
}

export function buildVisualEvidenceContract(tool, filename, entries, query = "") {
  const selected = (entries || []).slice(0, 10);
  const evidence = selected.map((entry) => makeEvidence({
    source: "visual-evidence-index",
    evidenceType: entry.diagramType || "visual-evidence",
    page: entry.page,
    quote: (entry.directVisualObservations || [])[0] || (entry.captionContextFacts || [])[0] || entry.figure?.caption || entry.query || entry.id,
    confidence: entry.confidence || "medium",
    name: entry.id,
    field: entry.verificationStatus,
    tool,
  }));
  const inference = selected.flatMap((entry) => (entry.engineeringInferences || []).slice(0, 2).map((text) => makeInference({
    statement: text,
    basis: entry.id,
    confidence: entry.confidence || "medium",
    risk: "Stored engineering inference; verify against manual text/register evidence before using in driver changes.",
  }))).slice(0, 12);
  const needsVerification = selected.filter((entry) => entry.verificationStatus !== "verified").map((entry) => makeNeedsVerification({
    item: `${entry.id} (${entry.diagramType})`,
    reason: entry.uncertainties?.length ? entry.uncertainties.join("; ") : "Visual evidence is not marked verified.",
    suggestedTools: buildVisualEvidenceRecommendedTools(filename, entry),
  })).slice(0, 12);
  return makeEvidenceContract({
    tool,
    filename,
    query,
    evidence,
    inference,
    needsVerification,
    warnings: ["Visual evidence entries are user/agent observations from rendered pages. Cross-check critical driver facts with manual text/register/bitfield/sequence/caution tools."],
    recommendedNextTools: selected.flatMap((entry) => buildVisualEvidenceRecommendedTools(filename, entry)).slice(0, 12),
  });
}

export function formatVisualEvidenceEntry(entry, detailed = true) {
  const lines = [];
  lines.push(`- ${entry.id}`);
  lines.push(`  page: ${entry.page || "unknown"}`);
  lines.push(`  diagramType: ${entry.diagramType}`);
  lines.push(`  status: ${entry.verificationStatus}`);
  lines.push(`  confidence: ${entry.confidence}`);
  const supportSummary = verificationSupportSummary(entry);
  if (supportSummary.supportingEvidenceCount || supportSummary.supportingToolCallCount || supportSummary.verificationHistoryCount) {
    lines.push(`  verification support: evidence=${supportSummary.supportingEvidenceCount}, tool_calls=${supportSummary.supportingToolCallCount}, history=${supportSummary.verificationHistoryCount}`);
    if (supportSummary.lastVerifiedAt) lines.push(`  verifiedAt: ${supportSummary.lastVerifiedAt}`);
  }
  if (entry.figureId) lines.push(`  figure: ${entry.figureId}${entry.figure?.caption ? ` - ${entry.figure.caption}` : ""}`);
  if (entry.renderedPath) lines.push(`  rendered: ${entry.renderedPath}`);
  if ((entry.tags || []).length) lines.push(`  tags: ${entry.tags.join(", ")}`);
  if (!detailed) return lines;
  if ((entry.directVisualObservations || []).length) {
    lines.push("  direct visual observations:");
    for (const item of entry.directVisualObservations) lines.push(`    - ${item}`);
  }
  if ((entry.captionContextFacts || []).length) {
    lines.push("  caption/context facts:");
    for (const item of entry.captionContextFacts) lines.push(`    - ${item}`);
  }
  const extracted = flattenVisualExtractedItems(entry.extractedItems);
  if (extracted.length) {
    lines.push("  extracted items:");
    for (const item of extracted.slice(0, 30)) lines.push(`    - ${item}`);
  }
  if ((entry.engineeringInferences || []).length) {
    lines.push("  engineering inferences:");
    for (const item of entry.engineeringInferences) lines.push(`    - ${item}`);
  }
  if ((entry.sourceImplications || []).length) {
    lines.push("  source implications:");
    for (const item of entry.sourceImplications) lines.push(`    - ${item}`);
  }
  if ((entry.uncertainties || []).length) {
    lines.push("  uncertainties / needs verification:");
    for (const item of entry.uncertainties) lines.push(`    - ${item}`);
  }
  if ((entry.relatedRegisters || []).length) lines.push(`  related registers: ${entry.relatedRegisters.join(", ")}`);
  if ((entry.relatedBitfields || []).length) lines.push(`  related bitfields: ${entry.relatedBitfields.join(", ")}`);
  if ((entry.sourceFiles || []).length) lines.push(`  source files: ${entry.sourceFiles.join(", ")}`);
  if (entry.notes) lines.push(`  notes: ${entry.notes}`);
  return lines;
}

export function formatAddVisualEvidence(result) {
  const { filename, path: filePath, entry, index } = result;
  const lines = [];
  lines.push("Visual Evidence Added");
  lines.push(`File: ${filename}`);
  lines.push(`Evidence ID: ${entry.id}`);
  lines.push(`Page: ${entry.page || "unknown"}`);
  lines.push(`Diagram type: ${entry.diagramType}`);
  lines.push(`Status: ${entry.verificationStatus}`);
  lines.push(`Confidence: ${entry.confidence}`);
  lines.push(`Store: ${filePath}`);
  lines.push(`Total entries: ${index.entries.length}`);
  lines.push("");
  lines.push(...formatVisualEvidenceEntry(entry, true));
  lines.push("");
  lines.push("Suggested next calls:");
  for (const call of buildVisualEvidenceRecommendedTools(filename, entry)) lines.push(`- ${call}`);
  return appendEvidenceContract(lines.join("\n"), buildVisualEvidenceContract("add_visual_evidence", filename, [entry], entry.query));
}

export function formatListVisualEvidence(result) {
  const lines = [];
  lines.push("Visual Evidence Entries");
  lines.push(`File: ${result.filename}`);
  lines.push(`Store: ${result.path}`);
  lines.push(`Total stored: ${result.index.entries.length}`);
  lines.push(`Shown: ${result.results.length}`);
  if (result.filter) lines.push(`Filter: ${result.filter}`);
  lines.push("");
  if (!result.results.length) lines.push("- No visual evidence entries matched.");
  else for (const entry of result.results) lines.push(...formatVisualEvidenceEntry(entry, false));
  return appendEvidenceContract(lines.join("\n"), buildVisualEvidenceContract("list_visual_evidence", result.filename, result.results, result.filter));
}

export function formatGetVisualEvidence(result) {
  const lines = [];
  lines.push("Visual Evidence Entry");
  lines.push(`File: ${result.filename}`);
  lines.push(`Store: ${result.path}`);
  lines.push("");
  lines.push(...formatVisualEvidenceEntry(result.entry, true));
  lines.push("");
  lines.push("Suggested next calls:");
  for (const call of buildVisualEvidenceRecommendedTools(result.filename, result.entry)) lines.push(`- ${call}`);
  return appendEvidenceContract(lines.join("\n"), buildVisualEvidenceContract("get_visual_evidence", result.filename, [result.entry], result.entry.id));
}

export async function buildVisualEvidenceReport(filename, options = {}) {
  const index = await loadVisualEvidenceIndex(filename);
  const topK = clampInteger(options.topK, 50, 1, 300);
  const entries = filterVisualEvidenceEntries(index.entries, options)
    .sort((a, b) => String(a.diagramType || "").localeCompare(String(b.diagramType || "")) || Number(a.page || 0) - Number(b.page || 0))
    .slice(0, topK);
  const byType = new Map();
  const byStatus = new Map();
  for (const entry of entries) {
    byType.set(entry.diagramType || "unknown", (byType.get(entry.diagramType || "unknown") || 0) + 1);
    byStatus.set(entry.verificationStatus || "unknown", (byStatus.get(entry.verificationStatus || "unknown") || 0) + 1);
  }
  return { filename, path: safeVisualEvidencePath(filename), index, entries, byType, byStatus, includeEntries: options.includeEntries !== false, filter: options.filter || "" };
}

export function formatVisualEvidenceReport(report) {
  const lines = [];
  lines.push("Visual Evidence Report");
  lines.push(`File: ${report.filename}`);
  lines.push(`Store: ${report.path}`);
  lines.push(`Total stored: ${report.index.entries.length}`);
  lines.push(`Included: ${report.entries.length}`);
  if (report.filter) lines.push(`Filter: ${report.filter}`);
  lines.push("");
  lines.push("Summary by diagram type:");
  if (!report.byType.size) lines.push("- none");
  for (const [type, count] of report.byType.entries()) lines.push(`- ${type}: ${count}`);
  lines.push("");
  lines.push("Summary by status:");
  if (!report.byStatus.size) lines.push("- none");
  for (const [status, count] of report.byStatus.entries()) lines.push(`- ${status}: ${count}`);
  lines.push("");
  lines.push("Driver-review usage rule:");
  lines.push("- Direct visual observations may guide review, but critical register/bitfield/sequence facts must still be verified with manual text/table tools.");
  lines.push("- Engineering inferences from visual evidence must not be treated as hardware facts unless verification_status=verified and supporting manual evidence exists.");
  lines.push("");
  if (report.includeEntries) {
    lines.push("Entries:");
    if (!report.entries.length) lines.push("- No matching visual evidence entries.");
    for (const entry of report.entries) {
      lines.push(...formatVisualEvidenceEntry(entry, true));
      lines.push("");
    }
  } else {
    lines.push("Entries omitted. Use include_entries=true or get_visual_evidence for details.");
  }
  lines.push("Machine summary JSON:");
  lines.push(JSON.stringify({
    filename: report.filename,
    totalStored: report.index.entries.length,
    included: report.entries.length,
    byType: Object.fromEntries(report.byType.entries()),
    byStatus: Object.fromEntries(report.byStatus.entries()),
    entries: report.entries.slice(0, 40).map((entry) => ({ id: entry.id, page: entry.page, figureId: entry.figureId, diagramType: entry.diagramType, status: entry.verificationStatus, confidence: entry.confidence, tags: entry.tags })),
  }, null, 2));
  return appendEvidenceContract(lines.join("\n"), buildVisualEvidenceContract("visual_evidence_report", report.filename, report.entries, report.filter));
}

// -----------------------------------------------------------------------------
// Step 35: visual evidence verification status workflow
// -----------------------------------------------------------------------------

export function normalizeSupportingEvidenceItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 80).map((item) => {
    if (typeof item === "string") {
      return { type: "other", quote: compactText(item, 800) };
    }
    if (!item || typeof item !== "object") return null;
    return {
      type: compactText(String(item.type || "other"), 80),
      tool: compactText(String(item.tool || ""), 120),
      page: Number.isFinite(Number(item.page)) && Number(item.page) > 0 ? Number(item.page) : null,
      register: compactText(String(item.register || ""), 120),
      bitfield: compactText(String(item.bitfield || ""), 120),
      quote: compactText(String(item.quote || ""), 1200),
      note: compactText(String(item.note || ""), 1200),
    };
  }).filter(Boolean).filter((item) => item.quote || item.note || item.tool || item.register || item.bitfield || item.page);
}

export function visualEvidenceVerificationRequirements(entry) {
  const text = normalizeForSearch([
    entry.diagramType,
    entry.query,
    entry.figure?.caption,
    ...(entry.directVisualObservations || []),
    ...(entry.engineeringInferences || []),
    ...(entry.sourceImplications || []),
    ...(entry.relatedRegisters || []),
    ...(entry.relatedBitfields || []),
    ...(entry.tags || []),
  ].filter(Boolean).join(" "));

  const requirements = [];
  requirements.push("Confirm the figure/table caption and surrounding manual text with get_figure_context or read_pdf_pages.");

  if (/register|bit|field|w1c|w0c|clear|reserved|status|control/.test(text) || (entry.relatedRegisters || []).length) {
    requirements.push("Verify affected register/bitfield semantics with verify_register_usage or extract_bitfield_table.");
  }
  if (/sequence|flow|reset|start|stop|enable|disable|order|wait|poll/.test(text)) {
    requirements.push("Verify operation order with get_sequence and surrounding page text.");
  }
  if (/caution|restriction|reserved|prohibited|undefined|only when|must/.test(text)) {
    requirements.push("Verify restrictions with get_cautions_for_register or find_caution.");
  }
  if (/clock|pll|divider|gate|mstp|module clock/.test(text)) {
    requirements.push("Cross-check clock source/divider/gate assumptions against manual text and clock/reset registers.");
  }
  if (/timing|setup|hold|cycle|edge|waveform/.test(text)) {
    requirements.push("Cross-check timing constraints against caption/table text and numeric timing notes.");
  }
  if (/pinmux|pfc|pmc|ioport|port|pin|function|selector/.test(text)) {
    requirements.push("Cross-check pin/function selector values with extract_pinmux_table and page text.");
  }
  if (/interrupt|irq|route|mask|status/.test(text)) {
    requirements.push("Cross-check interrupt routing/status/clear semantics with sequence/caution/register evidence.");
  }

  return [...new Set(requirements)];
}

export function visualEvidenceVerificationSuggestedTools(filename, entry) {
  const tools = [];
  if (entry.figureId) tools.push(`get_figure_context_pack(filename="${filename}", figure_id="${entry.figureId}")`);
  else if (entry.page) tools.push(`search_figures(filename="${filename}", query="${quoteForPromptCall(entry.query || entry.figure?.caption || "")}", limit=5) then get_figure_context_pack(filename="${filename}", figure_id="<figure-id>")`);
  if (entry.page) tools.push(`read_pdf_pages(filename="${filename}", start_page=${entry.page}, end_page=${entry.page})`);
  if (entry.page && /pinmux|pfc|pmc|pin|port|function|selector/i.test(visualEvidenceSearchText(entry))) {
    tools.push(`extract_pinmux_table(filename="${filename}", start_page=${entry.page}, end_page=${entry.page}, filter="${quoteForPromptCall(entry.query || "pin function")}")`);
  }
  if (entry.page) tools.push(`extract_layout_tables_from_pages(filename="${filename}", start_page=${entry.page}, end_page=${entry.page}, kind="auto")`);
  for (const reg of (entry.relatedRegisters || []).slice(0, 4)) {
    tools.push(`verify_register_usage(filename="${filename}", register="${quoteForPromptCall(reg)}", operation="<operation supported by ${entry.id}>", access_type="auto", intent="auto")`);
    tools.push(`get_cautions_for_register(filename="${filename}", register="${quoteForPromptCall(reg)}")`);
  }
  if (/sequence|flow|reset|start|stop|enable|disable|order|wait|poll/i.test(visualEvidenceSearchText(entry))) {
    tools.push(`get_sequence(filename="${filename}", topic="${quoteForPromptCall(entry.query || entry.diagramType || "visual sequence")}")`);
  }
  return [...new Set(tools)].slice(0, 14);
}

export function verificationSupportSummary(entry) {
  const support = Array.isArray(entry.supportingEvidence) ? entry.supportingEvidence : [];
  const calls = Array.isArray(entry.supportingToolCalls) ? entry.supportingToolCalls : [];
  const history = Array.isArray(entry.verificationHistory) ? entry.verificationHistory : [];
  return {
    supportingEvidenceCount: support.length,
    supportingToolCallCount: calls.length,
    verificationHistoryCount: history.length,
    lastVerifiedAt: entry.verifiedAt || "",
  };
}

export async function updateVisualEvidenceVerification(filename, evidenceId, options = {}) {
  ensurePdfFilename(filename);
  const status = normalizeVisualEvidenceStatus(options.status);
  const index = await loadVisualEvidenceIndex(filename);
  const entry = (index.entries || []).find((item) => item.id === evidenceId);
  if (!entry) throw new Error(`Visual evidence entry not found: ${evidenceId}`);

  const supportingEvidence = normalizeSupportingEvidenceItems(options.supportingEvidence);
  const supportingToolCalls = compactStringArray(options.supportingToolCalls, 80, 600);
  const resolvedUncertainties = compactStringArray(options.resolvedUncertainties, 80, 400);
  const remainingUncertainties = compactStringArray(options.remainingUncertainties, 80, 400);
  const note = compactText(String(options.verificationNote || options.notes || ""), 2000);
  const allowWithoutSupport = Boolean(options.allowWithoutSupport);

  if (status === "verified" && !allowWithoutSupport && !supportingEvidence.length && !supportingToolCalls.length) {
    throw new Error("status=verified requires supporting_evidence or supporting_tool_calls. Use status=observed/needs_verification, or set allow_without_support=true only for exceptional cases.");
  }

  const beforeStatus = entry.verificationStatus || "needs_verification";
  if (!Array.isArray(entry.supportingEvidence)) entry.supportingEvidence = [];
  if (!Array.isArray(entry.supportingToolCalls)) entry.supportingToolCalls = [];
  if (!Array.isArray(entry.verificationHistory)) entry.verificationHistory = [];

  entry.verificationStatus = status;
  if (options.confidence) entry.confidence = confidenceLevel(options.confidence);
  entry.updatedAt = new Date().toISOString();
  if (status === "verified") entry.verifiedAt = entry.updatedAt;
  if (status === "rejected") entry.rejectedAt = entry.updatedAt;

  entry.supportingEvidence.push(...supportingEvidence.map((item) => ({ ...item, addedAt: entry.updatedAt })));
  entry.supportingToolCalls.push(...supportingToolCalls);

  if (remainingUncertainties.length) entry.uncertainties = remainingUncertainties;
  else if (resolvedUncertainties.length && Array.isArray(entry.uncertainties)) {
    const resolvedSet = new Set(resolvedUncertainties.map((item) => normalizeForSearch(item)));
    entry.uncertainties = entry.uncertainties.filter((item) => !resolvedSet.has(normalizeForSearch(item)));
  }

  const tagsToAdd = compactStringArray(options.tagsToAdd, 40, 80);
  if (tagsToAdd.length) entry.tags = [...new Set([...(entry.tags || []), ...tagsToAdd])];
  if (note) entry.notes = [entry.notes || "", `Verification note (${entry.updatedAt}): ${note}`].filter(Boolean).join("\n").slice(0, 5000);

  const historyItem = {
    at: entry.updatedAt,
    from: beforeStatus,
    to: status,
    confidence: entry.confidence || "medium",
    reviewer: compactText(String(options.reviewer || ""), 120),
    note,
    supportingEvidenceCount: supportingEvidence.length,
    supportingToolCallCount: supportingToolCalls.length,
    resolvedUncertainties,
    remainingUncertainties,
  };
  entry.verificationHistory.push(historyItem);

  await saveVisualEvidenceIndex(filename, index);
  return { filename, path: safeVisualEvidencePath(filename), index, entry, historyItem, supportSummary: verificationSupportSummary(entry) };
}

export async function buildVisualEvidenceVerificationQueue(filename, options = {}) {
  const index = await loadVisualEvidenceIndex(filename);
  const topK = clampInteger(options.topK, 30, 1, 200);
  const includeObserved = options.includeObserved !== false;
  const includeRejected = Boolean(options.includeRejected);
  const entries = filterVisualEvidenceEntries(index.entries, options)
    .filter((entry) => {
      const status = entry.verificationStatus || "needs_verification";
      if (status === "verified") return false;
      if (status === "observed") return includeObserved;
      if (status === "rejected") return includeRejected;
      return true;
    })
    .map((entry) => ({
      ...entry,
      verificationRequirements: visualEvidenceVerificationRequirements(entry),
      suggestedTools: visualEvidenceVerificationSuggestedTools(filename, entry),
      supportSummary: verificationSupportSummary(entry),
    }))
    .sort((a, b) => {
      const order = { needs_verification: 0, observed: 1, rejected: 2 };
      const ao = order[a.verificationStatus] ?? 3;
      const bo = order[b.verificationStatus] ?? 3;
      if (ao !== bo) return ao - bo;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    })
    .slice(0, topK);
  return { filename, path: safeVisualEvidencePath(filename), index, entries, filter: options.filter || "" };
}

export function buildVisualEvidenceVerificationContract(tool, filename, entries, query = "") {
  const evidence = (entries || []).slice(0, 10).map((entry) => makeEvidence({
    source: "visual-evidence-verification-workflow",
    evidenceType: entry.diagramType || "visual-evidence",
    page: entry.page || undefined,
    quote: `${entry.id}: status=${entry.verificationStatus}; requirements=${(entry.verificationRequirements || visualEvidenceVerificationRequirements(entry)).slice(0, 2).join(" | ")}`,
    confidence: entry.confidence || "medium",
    name: entry.id,
    field: entry.verificationStatus,
    tool,
  }));
  const needsVerification = (entries || []).filter((entry) => entry.verificationStatus !== "verified").slice(0, 12).map((entry) => makeNeedsVerification({
    item: `${entry.id} (${entry.diagramType || "visual"})`,
    reason: (entry.verificationRequirements || visualEvidenceVerificationRequirements(entry)).join("; "),
    suggestedTools: entry.suggestedTools || visualEvidenceVerificationSuggestedTools(filename, entry),
  }));
  return makeEvidenceContract({
    tool,
    filename,
    query,
    evidence,
    inference: [],
    needsVerification,
    warnings: ["Step 35 only changes verification workflow/status. Verified visual evidence must still retain supporting manual evidence for auditability."],
    recommendedNextTools: (entries || []).flatMap((entry) => entry.suggestedTools || visualEvidenceVerificationSuggestedTools(filename, entry)).slice(0, 16),
  });
}

export function formatVisualEvidenceVerificationQueue(result) {
  const lines = [];
  lines.push("Visual Evidence Verification Queue");
  lines.push(`File: ${result.filename}`);
  lines.push(`Store: ${result.path}`);
  lines.push(`Total stored: ${result.index.entries.length}`);
  lines.push(`Queue entries: ${result.entries.length}`);
  if (result.filter) lines.push(`Filter: ${result.filter}`);
  lines.push("");
  if (!result.entries.length) {
    lines.push("- No visual evidence entries require verification for this filter.");
  }
  for (const entry of result.entries) {
    lines.push(`- ${entry.id}: page ${entry.page || "unknown"}, type=${entry.diagramType}, status=${entry.verificationStatus}, confidence=${entry.confidence}`);
    if (entry.figure?.caption) lines.push(`  caption: ${compactText(entry.figure.caption, 220)}`);
    if (entry.query) lines.push(`  query: ${entry.query}`);
    if ((entry.uncertainties || []).length) lines.push(`  uncertainties: ${(entry.uncertainties || []).slice(0, 3).join("; ")}`);
    lines.push(`  support: evidence=${entry.supportSummary.supportingEvidenceCount}, tool_calls=${entry.supportSummary.supportingToolCallCount}, history=${entry.supportSummary.verificationHistoryCount}`);
    lines.push("  verification requirements:");
    for (const req of (entry.verificationRequirements || []).slice(0, 8)) lines.push(`    - ${req}`);
    lines.push("  suggested MCP calls:");
    for (const call of (entry.suggestedTools || []).slice(0, 8)) lines.push(`    - ${call}`);
    lines.push(`  update: verify_visual_evidence(filename="${result.filename}", evidence_id="${entry.id}", status="verified", supporting_evidence=[...], supporting_tool_calls=[...])`);
  }
  return appendEvidenceContract(lines.join("\n"), buildVisualEvidenceVerificationContract("visual_evidence_verification_queue", result.filename, result.entries, result.filter));
}

export function formatVerifyVisualEvidence(result) {
  const { filename, path: filePath, entry, historyItem, supportSummary } = result;
  const lines = [];
  lines.push("Visual Evidence Verification Updated");
  lines.push(`File: ${filename}`);
  lines.push(`Store: ${filePath}`);
  lines.push(`Evidence ID: ${entry.id}`);
  lines.push(`Status: ${historyItem.from} -> ${historyItem.to}`);
  lines.push(`Confidence: ${entry.confidence}`);
  lines.push(`Updated: ${historyItem.at}`);
  if (entry.verifiedAt) lines.push(`Verified at: ${entry.verifiedAt}`);
  if (entry.rejectedAt) lines.push(`Rejected at: ${entry.rejectedAt}`);
  lines.push(`Support summary: evidence=${supportSummary.supportingEvidenceCount}, tool_calls=${supportSummary.supportingToolCallCount}, history=${supportSummary.verificationHistoryCount}`);
  if (historyItem.note) lines.push(`Note: ${historyItem.note}`);
  lines.push("");
  lines.push(...formatVisualEvidenceEntry(entry, true));
  if ((entry.supportingEvidence || []).length) {
    lines.push("");
    lines.push("Supporting evidence:");
    for (const item of (entry.supportingEvidence || []).slice(-12)) {
      lines.push(`- ${item.type || "other"}${item.tool ? ` via ${item.tool}` : ""}${item.page ? ` page ${item.page}` : ""}${item.register ? ` register ${item.register}` : ""}${item.bitfield ? ` bitfield ${item.bitfield}` : ""}`);
      if (item.quote) lines.push(`  quote: ${item.quote}`);
      if (item.note) lines.push(`  note: ${item.note}`);
    }
  }
  if ((entry.supportingToolCalls || []).length) {
    lines.push("");
    lines.push("Supporting tool calls:");
    for (const call of (entry.supportingToolCalls || []).slice(-12)) lines.push(`- ${call}`);
  }
  lines.push("");
  lines.push("Remaining suggested calls:");
  for (const call of visualEvidenceVerificationSuggestedTools(filename, entry).slice(0, 8)) lines.push(`- ${call}`);

  return appendEvidenceContract(lines.join("\n"), buildVisualEvidenceVerificationContract("verify_visual_evidence", filename, [entry], entry.id));
}

// -----------------------------------------------------------------------------
// Step 34: integrate persisted visual evidence into driver review workflow
// -----------------------------------------------------------------------------

export function visualEvidenceDriverSearchText(entry) {
  return normalizeForSearch([
    entry.id,
    entry.figureId,
    entry.page ? `page ${entry.page}` : "",
    entry.query,
    entry.diagramType,
    entry.figure?.caption,
    ...(entry.directVisualObservations || []),
    ...(entry.captionContextFacts || []),
    ...flattenVisualExtractedItems(entry.extractedItems),
    ...(entry.engineeringInferences || []),
    ...(entry.sourceImplications || []),
    ...(entry.uncertainties || []),
    ...(entry.relatedRegisters || []),
    ...(entry.relatedBitfields || []),
    ...(entry.sourceFiles || []),
    ...(entry.tags || []),
    entry.verificationStatus,
  ].filter(Boolean).join("\n"));
}

export function scoreVisualEvidenceForDriver(entry, filterText = "", context = {}) {
  const haystack = visualEvidenceDriverSearchText(entry);
  const filter = normalizeForSearch(filterText || "");
  const moduleType = normalizeForSearch(context.moduleType || "");
  const registers = normalizeStringArray(context.registers || []).map(normalizeRegisterName).filter(Boolean);
  const sourceFiles = normalizeStringArray(context.sourceFiles || []).map(normalizeForSearch).filter(Boolean);

  let score = 0;
  if (filter) score += scoreSimpleText(haystack, filter);
  if (moduleType && haystack.includes(moduleType)) score += 20;
  if (entry.verificationStatus === "verified") score += 45;
  else if (entry.verificationStatus === "observed") score += 25;
  else if (entry.verificationStatus === "needs_verification") score += 10;
  if (entry.confidence === "high") score += 20;
  else if (entry.confidence === "medium") score += 10;

  const entryRegs = new Set((entry.relatedRegisters || []).map(normalizeRegisterName));
  for (const reg of registers) {
    if (entryRegs.has(reg) || haystack.includes(normalizeForSearch(reg))) score += 35;
  }
  for (const file of sourceFiles) {
    if (file && haystack.includes(file)) score += 20;
  }
  if (/clock|reset|timing|interrupt|pinmux|sequence|flow|block|diagram/.test(haystack)) score += 8;
  return score;
}

export async function collectRelevantVisualEvidence(filename, options = {}) {
  const include = options.include !== false;
  if (!include) return [];
  const topK = clampInteger(options.topK, 8, 1, 30);
  let index;
  try {
    index = await loadVisualEvidenceIndex(filename);
  } catch {
    return [];
  }
  const entries = Array.isArray(index.entries) ? index.entries : [];
  if (!entries.length) return [];

  const filterParts = [
    options.filter,
    options.task,
    options.focus,
    options.moduleType,
    ...(normalizeStringArray(options.tags || [])),
    ...(normalizeStringArray(options.registers || [])),
    ...(normalizeStringArray(options.sourceFiles || [])),
  ].filter(Boolean);
  const filterText = filterParts.join(" ");
  const explicitFilter = normalizeForSearch(options.filter || "");
  const filtered = filterVisualEvidenceEntries(entries, {
    filter: explicitFilter || "",
    diagramType: options.diagramType || "",
    status: options.status || "",
    page: options.page || 0,
  });

  const candidates = (explicitFilter ? filtered : entries)
    .map((entry) => ({
      ...entry,
      driverReviewScore: scoreVisualEvidenceForDriver(entry, filterText, {
        moduleType: options.moduleType,
        registers: options.registers,
        sourceFiles: options.sourceFiles,
      }),
    }))
    .filter((entry) => explicitFilter || entry.driverReviewScore > 0 || !filterText)
    .sort((a, b) => {
      if (Number(b.driverReviewScore || 0) !== Number(a.driverReviewScore || 0)) return Number(b.driverReviewScore || 0) - Number(a.driverReviewScore || 0);
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    })
    .slice(0, topK);

  return candidates;
}

export function summarizeVisualEvidenceForDriver(entries, limit = 8) {
  return (entries || []).slice(0, limit).map((entry) => ({
    id: entry.id,
    page: entry.page,
    figureId: entry.figureId,
    diagramType: entry.diagramType,
    status: entry.verificationStatus,
    confidence: entry.confidence,
    score: entry.driverReviewScore || 0,
    caption: entry.figure?.caption || "",
    renderedPath: entry.renderedPath || "",
    observations: (entry.directVisualObservations || []).slice(0, 3),
    sourceImplications: (entry.sourceImplications || []).slice(0, 3),
    uncertainties: (entry.uncertainties || []).slice(0, 3),
    relatedRegisters: (entry.relatedRegisters || []).slice(0, 8),
    relatedBitfields: (entry.relatedBitfields || []).slice(0, 8),
    tags: (entry.tags || []).slice(0, 8),
  }));
}

export function visualEvidenceDriverWarnings(entries) {
  const warnings = [];
  if (!(entries || []).length) return warnings;
  const unverified = entries.filter((entry) => entry.verificationStatus !== "verified");
  if (unverified.length) warnings.push(`${unverified.length} visual evidence entr${unverified.length === 1 ? "y is" : "ies are"} not verified; treat as review guidance, not hardware fact.`);
  const hasInference = entries.some((entry) => (entry.engineeringInferences || []).length || (entry.sourceImplications || []).length);
  if (hasInference) warnings.push("Visual engineering inferences/source implications must be cross-checked with register/bitfield/sequence/caution evidence before patch approval.");
  return warnings;
}


export function normalizeVisualEvidenceStatusFilter(value) {
  const raw = String(value || "all").trim().toLowerCase();
  if (["all", "verified", "unverified", "needs_verification", "observed", "rejected"].includes(raw)) return raw;
  return "all";
}

export function normalizeVisualEvidenceGateMode(value) {
  const raw = String(value || "advisory").trim().toLowerCase();
  if (["advisory", "verified_only", "block_unverified"].includes(raw)) return raw;
  return "advisory";
}

export function visualEvidenceEntryStatus(entry) {
  return String(entry?.verificationStatus || "needs_verification").trim().toLowerCase() || "needs_verification";
}

export function visualEvidenceEntryMatchesStatus(entry, statusFilter = "all") {
  const status = visualEvidenceEntryStatus(entry);
  const filter = normalizeVisualEvidenceStatusFilter(statusFilter);
  if (filter === "all") return true;
  if (filter === "unverified") return status !== "verified" && status !== "rejected";
  return status === filter;
}

export function visualEvidenceGateRequirements(options = {}) {
  const statusFilter = normalizeVisualEvidenceStatusFilter(options.status || options.visualStatus || "all");
  const gate = normalizeVisualEvidenceGateMode(options.gate || options.visualGate || "advisory");
  const requireVerified = Boolean(options.requireVerified || options.visualRequireVerified) || gate === "verified_only" || gate === "block_unverified" || statusFilter === "verified";
  return { statusFilter, gate, requireVerified };
}

export function visualEvidenceGateWarnings(gate = {}) {
  const warnings = [];
  if (!gate || !Array.isArray(gate.allEntries)) return warnings;
  if (gate.statusFilter === "verified" && gate.entries.length === 0 && gate.allEntries.length > 0) {
    warnings.push(`visual_status=verified selected no entries, but ${gate.allEntries.length} related visual evidence entr${gate.allEntries.length === 1 ? "y exists" : "ies exist"} with non-verified or rejected status.`);
  }
  if (gate.requireVerified && gate.unverifiedEntries.length) {
    warnings.push(`${gate.unverifiedEntries.length} related visual evidence entr${gate.unverifiedEntries.length === 1 ? "y is" : "ies are"} not verified and must be resolved before approving visual-dependent driver conclusions.`);
  }
  if (gate.rejectedEntries.length && gate.statusFilter === "all") {
    warnings.push(`${gate.rejectedEntries.length} rejected visual evidence entr${gate.rejectedEntries.length === 1 ? "y" : "ies"} matched this review context; do not use rejected observations as support.`);
  }
  return warnings;
}

export async function collectDriverReviewVisualEvidence(filename, options = {}) {
  const requirements = visualEvidenceGateRequirements(options);
  const topK = clampInteger(options.topK, 8, 1, 30);
  const allEntries = await collectRelevantVisualEvidence(filename, {
    ...options,
    status: "",
    topK: Math.max(topK, 30),
  });

  const verifiedEntries = allEntries.filter((entry) => visualEvidenceEntryStatus(entry) === "verified");
  const unverifiedEntries = allEntries.filter((entry) => {
    const status = visualEvidenceEntryStatus(entry);
    return status !== "verified" && status !== "rejected";
  });
  const rejectedEntries = allEntries.filter((entry) => visualEvidenceEntryStatus(entry) === "rejected");

  let entries;
  if (requirements.gate === "verified_only") entries = verifiedEntries;
  else entries = allEntries.filter((entry) => visualEvidenceEntryMatchesStatus(entry, requirements.statusFilter));
  entries = entries.slice(0, topK);

  const blockers = [];
  if (requirements.requireVerified && unverifiedEntries.length) {
    blockers.push({
      kind: "unverified_visual_evidence",
      count: unverifiedEntries.length,
      evidenceIds: unverifiedEntries.slice(0, 12).map((entry) => entry.id),
      reason: "Related visual evidence is not verified. Cross-check with manual/register/bitfield/sequence/caution evidence or mark it rejected/not applicable before approving visual-dependent driver conclusions.",
    });
  }
  if (requirements.statusFilter === "verified" && !verifiedEntries.length && allEntries.length) {
    blockers.push({
      kind: "no_verified_visual_evidence",
      count: allEntries.length,
      evidenceIds: allEntries.slice(0, 12).map((entry) => entry.id),
      reason: "visual_status=verified was requested, but only non-verified/rejected visual evidence matched the review context.",
    });
  }

  return {
    enabled: options.include !== false,
    statusFilter: requirements.statusFilter,
    gate: requirements.gate,
    requireVerified: requirements.requireVerified,
    entries,
    allEntries: allEntries.slice(0, Math.max(topK, 12)),
    verifiedEntries: verifiedEntries.slice(0, topK),
    unverifiedEntries: unverifiedEntries.slice(0, Math.max(topK, 12)),
    rejectedEntries: rejectedEntries.slice(0, topK),
    blockers,
    warnings: visualEvidenceGateWarnings({
      statusFilter: requirements.statusFilter,
      gate: requirements.gate,
      requireVerified: requirements.requireVerified,
      entries,
      allEntries,
      unverifiedEntries,
      rejectedEntries,
    }),
  };
}

export function visualEvidenceGateSuggestedCalls(filename, gate = {}) {
  const calls = [];
  for (const entry of (gate.unverifiedEntries || []).slice(0, 6)) {
    calls.push(`get_visual_evidence(filename="${filename}", evidence_id="${entry.id}")`);
    calls.push(`visual_evidence_verification_queue(filename="${filename}", filter="${quoteForPromptCall(entry.query || entry.figure?.caption || entry.diagramType || entry.id)}", top_k=10)`);
    calls.push(`verify_visual_evidence(filename="${filename}", evidence_id="${entry.id}", status="verified", supporting_evidence=[...], supporting_tool_calls=[...])`);
  }
  if (!calls.length) calls.push(`visual_evidence_report(filename="${filename}", status="verified", include_entries=true)`);
  return [...new Set(calls)].slice(0, 18);
}

export function visualEvidenceGateNeedsVerification(gate = {}, filename = "") {
  const items = [];
  for (const blocker of gate.blockers || []) {
    items.push(makeNeedsVerification({
      item: blocker.kind,
      reason: blocker.reason,
      suggestedTools: visualEvidenceGateSuggestedCalls(filename, gate),
    }));
  }
  for (const entry of (gate.unverifiedEntries || []).slice(0, 8)) {
    items.push(makeNeedsVerification({
      item: `${entry.id} (${entry.diagramType || "visual"}, status=${entry.verificationStatus || "needs_verification"})`,
      reason: "Related visual evidence matched this driver-review context but is not verified.",
      suggestedTools: [
        `get_visual_evidence(filename="${filename}", evidence_id="${entry.id}")`,
        `verify_visual_evidence(filename="${filename}", evidence_id="${entry.id}", status="verified", supporting_evidence=[...], supporting_tool_calls=[...])`,
      ],
    }));
  }
  return items;
}

export function formatVisualEvidenceGateSection(gate = {}, filename = "") {
  const lines = ["Visual evidence verification gate"];
  if (!gate || gate.enabled === false) {
    lines.push("- Visual evidence was disabled for this driver-review tool call.");
    return lines;
  }
  lines.push(`- status filter: ${gate.statusFilter || "all"}`);
  lines.push(`- gate mode: ${gate.gate || "advisory"}`);
  lines.push(`- require verified: ${gate.requireVerified ? "yes" : "no"}`);
  lines.push(`- selected entries: ${(gate.entries || []).length}`);
  lines.push(`- related verified entries: ${(gate.verifiedEntries || []).length}`);
  lines.push(`- related unverified entries: ${(gate.unverifiedEntries || []).length}`);
  if ((gate.blockers || []).length) {
    lines.push("- BLOCKERS:");
    for (const blocker of gate.blockers) {
      lines.push(`  - ${blocker.kind}: ${blocker.reason}`);
      if ((blocker.evidenceIds || []).length) lines.push(`    evidence: ${blocker.evidenceIds.join(", ")}`);
    }
    lines.push("- Required action: verify or reject the blocking visual evidence before approving driver conclusions that depend on it.");
  } else if (gate.requireVerified) {
    lines.push("- Gate result: PASS for currently matched visual evidence.");
  } else {
    lines.push("- Gate result: advisory only; unverified visual evidence is shown as guidance, not proof.");
  }
  if ((gate.unverifiedEntries || []).length) {
    lines.push("- Suggested verification calls:");
    for (const call of visualEvidenceGateSuggestedCalls(filename, gate).slice(0, 8)) lines.push(`  - ${call}`);
  }
  return lines;
}

export function formatDriverVisualEvidenceSection(entries, filename, title = "Relevant visual evidence") {
  const lines = [title];
  if (!(entries || []).length) {
    lines.push("- No persisted visual evidence matched this driver-review context.");
    lines.push(`- Suggested: visual_review_handoff_pack(filename="${filename}", query="<clock/timing/reset/pinmux/interrupt topic>")`);
    return lines;
  }
  for (const entry of entries.slice(0, 10)) {
    lines.push(`- ${entry.id}: page ${entry.page || "unknown"}, type=${entry.diagramType || "unknown"}, status=${entry.verificationStatus || "unknown"}, confidence=${entry.confidence || "unknown"}, score=${entry.driverReviewScore || 0}`);
    if (entry.figure?.caption) lines.push(`  caption: ${compactText(entry.figure.caption, 240)}`);
    if (entry.renderedPath) lines.push(`  render: ${entry.renderedPath}`);
    for (const obs of (entry.directVisualObservations || []).slice(0, 2)) lines.push(`  visual: ${obs}`);
    for (const imp of (entry.sourceImplications || []).slice(0, 2)) lines.push(`  source implication: ${imp}`);
    for (const unc of (entry.uncertainties || []).slice(0, 2)) lines.push(`  uncertainty: ${unc}`);
    const regs = (entry.relatedRegisters || []).slice(0, 6).join(", ");
    if (regs) lines.push(`  related registers: ${regs}`);
    lines.push(`  suggested: get_visual_evidence(filename="${filename}", evidence_id="${entry.id}")`);
  }
  lines.push(`- Summary/report: visual_evidence_report(filename="${filename}", include_entries=true)`);
  return lines;
}

export function visualEvidenceToEvidenceContractItems(entries, toolName) {
  return (entries || []).slice(0, 8).map((entry) => makeEvidence({
    source: "visual-evidence-index",
    evidenceType: `visual-${entry.diagramType || "diagram"}`,
    page: entry.page || undefined,
    quote: (entry.directVisualObservations || [])[0] || (entry.captionContextFacts || [])[0] || entry.figure?.caption || entry.query || entry.id,
    confidence: entry.confidence || "medium",
    name: entry.id,
    tool: toolName,
  }));
}
