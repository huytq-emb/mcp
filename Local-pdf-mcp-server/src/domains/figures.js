import { appendEvidenceContract, atomicWriteJson, clampInteger, compactText, getPdfSourceInfo, isSamePdfSource, makeEvidence, makeEvidenceContract, makeInference, makeNeedsVerification, normalizeForSearch, pathExists, readJsonCached, safeFiguresIndexPath } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { DEFAULT_FIGURE_TOP_K, FIGURE_INDEX_SCHEMA_VERSION, MAX_FIGURE_TOP_K, SERVER_VERSION } from "../core/runtime-constants.js";
import { buildFiguresWithPython, ensureFigureLookupIndex } from "../services/ocr.js";


const detectHeadings = createRuntimePort("detectHeadings");
const extractPdfPages = createRuntimePort("extractPdfPages");
const extractTablesFromPages = createRuntimePort("extractTablesFromPages");
const getPagesCache = createRuntimePort("getPagesCache");
const getPdfPageCount = createRuntimePort("getPdfPageCount");


const q = createRuntimePort("q");


const scoreSimpleText = createRuntimePort("scoreSimpleText");

// -----------------------------------------------------------------------------
// Step 31A: figure/caption index and visual-context helpers
// -----------------------------------------------------------------------------

export function classifyFigureKind(type, captionText = "", contextText = "") {
  const text = normalizeForSearch(`${type} ${captionText} ${contextText}`);
  if (/clock\s*tree|clock\s*distribution|clock\s*generation|pll|oscillator/.test(text)) return "clock-tree";
  if (/timing|waveform|read\s*cycle|write\s*cycle|setup\s*time|hold\s*time|t\s*[a-z0-9]+/.test(text)) return "timing-diagram";
  if (/block\s*diagram|module\s*configuration|configuration\s*diagram|overview\s*diagram/.test(text)) return "block-diagram";
  if (/flow|sequence|procedure|setting\s*flow|operation\s*flow|example\s*flow/.test(text)) return "flow-sequence";
  if (/pin\s*function|pinmux|pin\s*mux|multiplexed\s*pin|pfc|ioport|port\s*function/.test(text)) return "pinmux";
  if (/register|bit\s*field|offset|access\s*size|initial\s*value/.test(text)) return "register-table";
  if (/interrupt|irq|vector|routing|event\s*link|intc/.test(text)) return "interrupt";
  if (/reset|standby|power\s*state|low\s*power/.test(text)) return "reset-power";
  if (/^table\b/i.test(String(type || ""))) return "table";
  if (/^fig/i.test(String(type || ""))) return "figure";
  return "unknown";
}

export function normalizeFigureNumber(value = "") {
  return String(value || "").trim().replace(/[^A-Za-z0-9_.-]+/g, "");
}

export function figureIdFor(page, ordinal, type, number) {
  const prefix = /^table$/i.test(type) ? "tbl" : "fig";
  const num = normalizeFigureNumber(number);
  return `${prefix}-p${page}-${num || ordinal}`.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

export function extractFigureCaptionsFromPageText(pageText = "", pageNumber = 0) {
  const lines = String(pageText || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const captions = [];
  const captionRe = /^(Figure|Fig\.?|Table)\s+([A-Za-z]?\d+(?:[.\-]\d+)*(?:[A-Za-z])?)\s*[:.\-]?\s*(.{0,220})$/i;
  const softVisualRe = /\b(clock\s*tree|timing\s*diagram|waveform|block\s*diagram|setting\s*flow|operation\s*flow|example\s*flow|multiplexed\s*pin\s*configuration|pin\s*function\s*configuration)\b/i;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let match = line.match(captionRe);
    if (match) {
      const type = /^fig/i.test(match[1]) ? "Figure" : "Table";
      let title = String(match[3] || "").trim();
      // Common PDF extraction issue: caption title spills into following short line.
      if (title.length < 12 && lines[index + 1] && !captionRe.test(lines[index + 1]) && lines[index + 1].length < 160) {
        title = `${title} ${lines[index + 1]}`.trim();
      }
      const contextStart = Math.max(0, index - 4);
      const contextEnd = Math.min(lines.length, index + 6);
      const contextLines = lines.slice(contextStart, contextEnd);
      captions.push({
        page: pageNumber,
        lineIndex: index,
        type,
        number: match[2],
        title,
        caption: `${type} ${match[2]} ${title}`.replace(/\s+/g, " ").trim(),
        contextLines,
        source: "caption-regex",
      });
      continue;
    }

    if (softVisualRe.test(line) && !/^(section|chapter)\b/i.test(line)) {
      const contextStart = Math.max(0, index - 3);
      const contextEnd = Math.min(lines.length, index + 5);
      captions.push({
        page: pageNumber,
        lineIndex: index,
        type: "Visual",
        number: "",
        title: line,
        caption: line,
        contextLines: lines.slice(contextStart, contextEnd),
        source: "visual-keyword",
      });
    }
  }

  return captions;
}

export function figureFromCaption(filename, caption, ordinal = 0, pageHeadings = []) {
  const contextText = (caption.contextLines || []).join("\n");
  const kind = classifyFigureKind(caption.type, caption.caption, contextText);
  const id = figureIdFor(caption.page, ordinal, caption.type, caption.number);
  const confidence = Math.min(100,
    50 +
    (caption.source === "caption-regex" ? 25 : 8) +
    (kind !== "unknown" ? 15 : 0) +
    ((caption.title || "").length > 8 ? 6 : 0)
  );

  return {
    id,
    filename,
    page: caption.page,
    type: caption.type,
    number: caption.number || "",
    title: caption.title || "",
    caption: caption.caption || caption.title || "",
    kind,
    lineIndex: caption.lineIndex,
    headings: pageHeadings || [],
    contextLines: caption.contextLines || [],
    contextPreview: compactText(contextText, 1000),
    searchText: normalizeForSearch([caption.caption, caption.title, kind, ...(pageHeadings || []), contextText].join("\n")),
    source: caption.source,
    confidence,
  };
}

export async function buildFiguresIndex(filename, pageCache = null, options = {}) {
  try {
    return await buildFiguresWithPython(filename, { force: Boolean(options.force) });
  } catch {
    // Python figure-region extraction is preferred, but figures remain
    // optional-advisory. Fall back to native caption indexing when the worker
    // is unavailable so the rest of the MCP pipeline stays usable.
  }

  const cache = pageCache || await getPagesCache(filename);
  const source = await getPdfSourceInfo(filename);
  const figures = [];

  for (const page of cache.pages || []) {
    const headings = detectHeadings(page.text || "");
    const captions = extractFigureCaptionsFromPageText(page.text || "", page.page);
    captions.forEach((caption, index) => figures.push(figureFromCaption(filename, caption, index + 1, headings)));
  }

  const byId = new Map();
  for (const figure of figures) {
    let id = figure.id;
    let suffix = 2;
    while (byId.has(id)) {
      id = `${figure.id}-${suffix}`;
      suffix += 1;
    }
    byId.set(id, { ...figure, id });
  }

  const result = {
    schemaVersion: FIGURE_INDEX_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    pageCount: cache.pageCount,
    figureCount: byId.size,
    kindStats: [...byId.values()].reduce((acc, fig) => {
      acc[fig.kind] = (acc[fig.kind] || 0) + 1;
      return acc;
    }, {}),
    figures: [...byId.values()],
  };

  await atomicWriteJson(safeFiguresIndexPath(filename), result);
  await ensureFigureLookupIndex(filename, result, { force: true }).catch(() => {});
  return result;
}

export async function loadFiguresIndex(filename) {
  const filePath = safeFiguresIndexPath(filename);
  if (!(await pathExists(filePath))) return null;
  try {
    const data = await readJsonCached(filePath);
    if (data.schemaVersion !== FIGURE_INDEX_SCHEMA_VERSION) return null;
    if (data.filename !== filename) return null;
    if (!Array.isArray(data.figures)) return null;
    const source = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(data.source, source)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function getFiguresIndex(filename, options = {}) {
  const existing = await loadFiguresIndex(filename);
  if (existing) return existing;
  if (options.buildIfMissing === true) return buildFiguresIndex(filename);
  throw new Error(`Figures/captions index not found for ${filename}. Run build_figures_index or index_pdf/start_index_pdf first.`);
}

export function figureMatchesFilter(figure, { filter = "", kind = "" } = {}) {
  const kindFilter = String(kind || "").trim().toLowerCase();
  if (kindFilter && String(figure.kind || "").toLowerCase() !== kindFilter && String(figure.type || "").toLowerCase() !== kindFilter) return false;
  const f = normalizeForSearch(filter || "");
  if (!f) return true;
  return normalizeForSearch([figure.caption, figure.title, figure.kind, figure.contextPreview, ...(figure.headings || [])].join("\n")).includes(f);
}

export function scoreFigureCandidate(figure, query = "") {
  const q = String(query || "").trim();
  if (!q) return Number(figure.confidence || 0);
  return Number(figure.confidence || 0) + scoreSimpleText([figure.caption, figure.title, figure.kind, figure.contextPreview, ...(figure.headings || [])].join("\n"), q);
}

export async function listFigures(filename, options = {}) {
  const index = await getFiguresIndex(filename, { buildIfMissing: true });
  const filter = String(options.filter || "").trim();
  const kind = String(options.kind || "").trim();
  const topK = clampInteger(options.topK, DEFAULT_FIGURE_TOP_K, 1, MAX_FIGURE_TOP_K);
  const results = (index.figures || [])
    .filter((figure) => figureMatchesFilter(figure, { filter, kind }))
    .sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return String(a.id).localeCompare(String(b.id));
    })
    .slice(0, topK);
  return { index, results, filter, kind, topK };
}

export async function findFigure(filename, options = {}) {
  const query = String(options.query || "").trim();
  if (!query) throw new Error("query is required");
  const index = await getFiguresIndex(filename, { buildIfMissing: true });
  const kind = String(options.kind || "").trim();
  const topK = clampInteger(options.topK, DEFAULT_FIGURE_TOP_K, 1, MAX_FIGURE_TOP_K);
  const results = (index.figures || [])
    .filter((figure) => figureMatchesFilter(figure, { kind }))
    .map((figure) => ({ ...figure, matchScore: scoreFigureCandidate(figure, query) }))
    .filter((figure) => figure.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore || a.page - b.page)
    .slice(0, topK);
  return { index, results, query, kind, topK };
}

export async function getFigureContext(filename, options = {}) {
  const index = await getFiguresIndex(filename, { buildIfMissing: true });
  const figureId = String(options.figureId || "").trim();
  const page = Number(options.page || 0);
  const query = String(options.query || "").trim();
  const includePages = clampInteger(options.includePages, 0, 0, 2);
  let figure = null;

  if (figureId) figure = (index.figures || []).find((item) => item.id === figureId);
  if (!figure && page) {
    const pageFigures = (index.figures || []).filter((item) => Number(item.page) === page);
    if (query) figure = pageFigures.map((item) => ({ ...item, matchScore: scoreFigureCandidate(item, query) })).sort((a, b) => b.matchScore - a.matchScore)[0] || null;
    else figure = pageFigures[0] || null;
  }
  if (!figure && query) {
    const found = await findFigure(filename, { query, topK: 1 });
    figure = found.results[0] || null;
  }
  if (!figure) throw new Error("Figure/table context not found. Provide figure_id from list_figures/find_figure, or pass page/query.");

  const pageCount = index.pageCount || await getPdfPageCount(filename);
  const startPage = Math.max(1, figure.page - includePages);
  const endPage = Math.min(pageCount, figure.page + includePages);
  const pageData = await extractPdfPages(filename, { startPage, endPage });
  let layoutTables = null;
  if (options.includeLayoutTables) {
    try {
      layoutTables = await extractTablesFromPages(filename, { startPage, endPage, minColumns: 2 });
      layoutTables.tables = (layoutTables.tables || []).slice(0, 8).map((table) => ({
        page: table.page,
        kind: table.kind,
        confidence: table.confidence,
        columns: table.columns,
        headerText: table.headerText,
        previewRows: (table.rows || []).slice(0, 6),
      }));
    } catch (error) {
      layoutTables = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { filename, figure, startPage, endPage, pages: pageData.pages || [], layoutTables };
}

export function buildFigureEvidenceContract(tool, filename, query, figures) {
  const evidence = (figures || []).slice(0, 20).map((figure) => makeEvidence({
    source: "figures-index",
    evidenceType: figure.kind || figure.type || "figure-caption",
    page: figure.page,
    quote: figure.caption || figure.title,
    confidence: figure.confidence || "medium",
    name: figure.id,
    field: figure.kind,
    tool,
  }));
  const inference = [makeInference({ statement: "Figure/visual context is inferred from PDF text captions and nearby text, not from image OCR or vision rendering.", basis: "PDF text layer captions", confidence: "medium", risk: "If the visual object has no extractable caption/text, it may be missed." })];
  const needsVerification = [makeNeedsVerification({ item: "Visual content inside the actual figure/diagram", reason: "Step 31A locates captions/context but does not inspect raster/vector graphics visually.", suggestedTools: ["read_pdf_pages(...)", "extract_layout_tables_from_pages(...)", "open the PDF page visually if the diagram itself is required"] })];
  return makeEvidenceContract({ tool, filename, query, evidence, inference, needsVerification, warnings: ["Caption index is text-layer based; use it to locate visual pages, then verify the original PDF page."], recommendedNextTools: [`get_figure_context(filename="${filename}", figure_id="<figure-id>")`, `read_pdf_pages(filename="${filename}", start_page=<page>, end_page=<page>)`] });
}

export function formatFigureList(result, mode = "list") {
  const rows = result.results || [];
  const lines = [];
  lines.push(mode === "find" ? "Figure/Table Search Results" : "Figure/Table Candidates");
  lines.push(`File: ${result.index.filename}`);
  lines.push(`Figures indexed: ${result.index.figureCount}`);
  lines.push(`Kind stats: ${JSON.stringify(result.index.kindStats || {})}`);
  if (result.query) lines.push(`Query: ${result.query}`);
  if (result.filter) lines.push(`Filter: ${result.filter}`);
  if (result.kind) lines.push(`Kind filter: ${result.kind}`);
  lines.push(`Shown: ${rows.length}`);
  lines.push("Reliability: caption/context index only; it locates candidate visual pages but does not OCR or interpret the image/vector itself.");
  lines.push("");

  if (!rows.length) {
    lines.push("No figure/table candidates found.");
    lines.push("Suggested: search_pdf(filename=..., query=\"Figure clock tree timing diagram block diagram\") or read relevant section pages.");
    return appendEvidenceContract(lines.join("\n"), buildFigureEvidenceContract(mode === "find" ? "find_figure" : "list_figures", result.index.filename, result.query || result.filter || "", []));
  }

  lines.push("| # | ID | Page | Kind | Caption | Score/Conf | Context |");
  lines.push("|---:|---|---:|---|---|---:|---|");
  rows.forEach((figure, index) => {
    lines.push(`| ${index + 1} | ${figure.id} | ${figure.page} | ${figure.kind} | ${String(figure.caption || figure.title).replace(/\|/g, "/").slice(0, 140)} | ${figure.matchScore || figure.confidence || 0} | ${String(figure.contextPreview || "").replace(/\|/g, "/").slice(0, 160)} |`);
  });

  lines.push("", "Suggested follow-up:");
  for (const figure of rows.slice(0, 8)) {
    lines.push(`- get_figure_context(filename="${result.index.filename}", figure_id="${figure.id}", include_pages=1, include_layout_tables=true)`);
  }

  return appendEvidenceContract(lines.join("\n"), buildFigureEvidenceContract(mode === "find" ? "find_figure" : "list_figures", result.index.filename, result.query || result.filter || "", rows));
}

export function formatFigureContext(result) {
  const figure = result.figure;
  const lines = [];
  lines.push("Figure/Table Context");
  lines.push(`File: ${result.filename}`);
  lines.push(`Figure ID: ${figure.id}`);
  lines.push(`Page: ${figure.page}`);
  lines.push(`Kind: ${figure.kind}`);
  lines.push(`Caption: ${figure.caption}`);
  lines.push(`Source: ${figure.source}`);
  lines.push(`Confidence: ${figure.confidence}`);
  if ((figure.headings || []).length) lines.push(`Headings: ${figure.headings.join(" | ")}`);
  lines.push("");
  lines.push("Caption-near context:");
  for (const line of figure.contextLines || []) lines.push(`- ${line}`);
  lines.push("");
  lines.push(`Page text range: ${result.startPage}-${result.endPage}`);
  for (const page of result.pages || []) {
    lines.push("", `--- Page ${page.page} text preview ---`);
    lines.push(compactText(page.text || "", 3500));
  }

  if (result.layoutTables) {
    lines.push("", "Layout table candidates on context pages:");
    if (result.layoutTables.error) lines.push(`- Error: ${result.layoutTables.error}`);
    else {
      for (const table of result.layoutTables.tables || []) {
        lines.push(`- Page ${table.page}, kind=${table.kind}, confidence=${table.confidence}, header=${compactText(table.headerText || "", 180)}`);
        for (const row of table.previewRows || []) lines.push(`  row: ${compactText(row.text || "", 220)}`);
      }
    }
  }

  lines.push("", "Suggested next steps:");
  lines.push(`- read_pdf_pages(filename="${result.filename}", start_page=${figure.page}, end_page=${figure.page})`);
  lines.push(`- extract_layout_tables_from_pages(filename="${result.filename}", start_page=${result.startPage}, end_page=${result.endPage}, kind="all")`);
  lines.push("- If the actual graphic content is required, open/render the original PDF page visually; this tool only indexes text/captions around it.");

  return appendEvidenceContract(lines.join("\n"), buildFigureEvidenceContract("get_figure_context", result.filename, figure.caption, [figure]));
}
