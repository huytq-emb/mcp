import path from "node:path";
import fs from "node:fs/promises";
import { appendEvidenceContract, atomicWriteJson, clampInteger, compactText, getPdfSourceInfo, isSamePdfSource, makeEvidence, makeEvidenceContract, makeInference, makeNeedsVerification, normalizeForSearch, pathExists, readJsonCached, safeFiguresIndexPath } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { DEFAULT_FIGURE_TOP_K, FIGURE_INDEX_SCHEMA_VERSION, MAX_FIGURE_TOP_K, SERVER_VERSION } from "../core/runtime-constants.js";
import { buildFiguresWithPython, ensureFigureLookupIndex, loadFigureOcrIndex, renderFigureOnDemand, ocrFigureOnDemand } from "../services/ocr.js";


const detectHeadings = createRuntimePort("detectHeadings");
const extractPdfPages = createRuntimePort("extractPdfPages");
const extractTablesFromPages = createRuntimePort("extractTablesFromPages");
const getPagesCache = createRuntimePort("getPagesCache");
const getPdfPageCount = createRuntimePort("getPdfPageCount");


const q = createRuntimePort("q");


const scoreSimpleText = createRuntimePort("scoreSimpleText");


const FIGURE_AGENT_INSTRUCTION = "Open image_path as an image and analyze the figure visually. Use the text context only as supporting evidence.";

function figureId(figure = {}, index = 0) {
  return String(figure.figure_id || figure.id || figure.figureUid || figure.figure_uid || `p${String(figure.page || 0).padStart(4, "0")}_f${index + 1}`).trim();
}

function figureSectionTitle(figure = {}) {
  return String(figure.section_title || figure.sectionTitle || (figure.headings || [])[0] || "").trim();
}

function figureNearbyPreview(figure = {}) {
  return compactText(String(figure.nearby_text_preview || figure.contextPreview || (figure.contextLines || []).join("\n") || ""), 1000);
}

function imageAccess(localPath = "") {
  const abs = localPath ? path.resolve(localPath) : "";
  return { local_path: abs, mime_type: "image/png", exists: false, agent_should_open_as_image: true };
}

async function imageAccessWithExists(localPath = "") {
  const access = imageAccess(localPath);
  access.exists = Boolean(access.local_path && await pathExists(access.local_path));
  return access;
}

function normalizeFigureRecord(filename, figure = {}, index = 0, source = null) {
  const id = figureId(figure, index);
  const img = String(figure.image_path || figure.renderPath || figure.render_path || "");
  return {
    schemaVersion: 1,
    filename,
    figure_id: id,
    id,
    page: Number(figure.page || 0),
    bbox: Array.isArray(figure.bbox) ? figure.bbox : [],
    image_path: img,
    caption: String(figure.caption || figure.title || "").trim(),
    section_title: figureSectionTitle(figure),
    nearby_text_preview: figureNearbyPreview(figure),
    ocr_keywords: Array.isArray(figure.ocr_keywords) ? figure.ocr_keywords : [],
    related_registers: Array.isArray(figure.related_registers) ? figure.related_registers : [],
    related_bitfields: Array.isArray(figure.related_bitfields) ? figure.related_bitfields : [],
    related_cautions: Array.isArray(figure.related_cautions) ? figure.related_cautions : [],
    related_tables: Array.isArray(figure.related_tables) ? figure.related_tables : [],
    render: { status: img ? "ready" : "missing", dpi: Number(figure.render?.dpi || 0), width: Number(figure.render?.width || 0), height: Number(figure.render?.height || 0), mtimeMs: Number(figure.render?.mtimeMs || 0) },
    image_access: { local_path: img ? path.resolve(img) : "", mime_type: "image/png", exists: false, agent_should_open_as_image: true },
    provenance: { sourceFingerprint: source ? `${Number(source.size || 0)}:${Math.round(Number(source.mtimeMs || 0))}` : String(figure.sourceFingerprint || ""), generatedAt: new Date().toISOString() },
    // Backward-compatible fields used by older tools.
    title: String(figure.title || figure.caption || "").trim(),
    kind: String(figure.kind || figure.type || "figure").trim() || "figure",
    type: String(figure.type || figure.kind || "Figure").trim() || "Figure",
    headings: Array.isArray(figure.headings) ? figure.headings : [],
    contextLines: Array.isArray(figure.contextLines) ? figure.contextLines : [],
    contextPreview: figureNearbyPreview(figure),
    confidence: Number(figure.confidence || 50),
    searchText: normalizeForSearch([figure.caption, figure.title, figureSectionTitle(figure), figureNearbyPreview(figure)].join("\n")),
  };
}

async function normalizeFigureManifest(filename, index) {
  const source = index.source || await getPdfSourceInfo(filename).catch(() => null);
  const figures = [];
  for (const [i, fig] of (index.figures || []).entries()) {
    const rec = normalizeFigureRecord(filename, fig, i, source);
    if (rec.image_path) {
      rec.image_access = await imageAccessWithExists(rec.image_path);
      if (rec.image_access.exists) {
        const st = await fs.stat(rec.image_access.local_path).catch(() => null);
        rec.render.mtimeMs = st ? Math.round(st.mtimeMs) : rec.render.mtimeMs;
        rec.render.status = "ready";
      }
    }
    figures.push(rec);
  }
  return { ...index, schemaVersion: 1, filename, source, sourceFingerprint: source ? `${Number(source.size || 0)}:${Math.round(Number(source.mtimeMs || 0))}` : "", figureCount: figures.length, figures };
}

function splitTokens(text) {
  return normalizeForSearch(text).split(/\s+/).filter((t) => t.length >= 2);
}

function scoreManifestFigure(figure, query) {
  const tokens = splitTokens(query);
  const fields = {
    caption: normalizeForSearch(figure.caption || ""),
    section: normalizeForSearch(figure.section_title || ""),
    nearby: normalizeForSearch(figure.nearby_text_preview || figure.contextPreview || ""),
    ocr: normalizeForSearch((figure.ocr_keywords || []).join(" ")),
    related: normalizeForSearch([...(figure.related_registers || []), ...(figure.related_bitfields || []), ...(figure.related_cautions || []), ...(figure.related_tables || [])].join(" ")),
  };
  const reasons = [];
  let score = 0;
  for (const token of tokens) {
    if (fields.caption.split(/\s+/).includes(token)) { score += 12; reasons.push(`exact token in caption: ${token}`); }
    else if (fields.caption.includes(token)) { score += 8; reasons.push(`caption match: ${token}`); }
    if (fields.section.includes(token)) { score += 6; reasons.push(`section title match: ${token}`); }
    if (fields.nearby.includes(token)) { score += 3; reasons.push(`nearby text match: ${token}`); }
    if (fields.ocr.includes(token)) { score += 2; reasons.push(`cached OCR keyword match: ${token}`); }
    if (fields.related.includes(token)) { score += 4; reasons.push(`related evidence match: ${token}`); }
  }
  return { score, reasons: [...new Set(reasons)].slice(0, 12) };
}

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
    const pythonIndex = await buildFiguresWithPython(filename, { force: Boolean(options.force) });
    const normalizedPython = await normalizeFigureManifest(filename, pythonIndex);
    await atomicWriteJson(safeFiguresIndexPath(filename), normalizedPython).catch(() => {});
    await ensureFigureLookupIndex(filename, normalizedPython, { force: true }).catch(() => {});
    return normalizedPython;
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

  let result = {
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

  result = await normalizeFigureManifest(filename, result);
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
    if (!(data.figures || [])[0]?.figure_id || !(data.figures || [])[0]?.image_access) {
      const normalized = await normalizeFigureManifest(filename, data);
      await atomicWriteJson(filePath, normalized).catch(() => {});
      return normalized;
    }
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


export async function rebuildFigureManifest(filename, options = {}) {
  const pageCache = await getPagesCache(filename, { buildIfMissing: true });
  const index = await buildFiguresIndex(filename, pageCache, { force: Boolean(options.force) });
  return { ok: true, filename, manifest_path: safeFiguresIndexPath(filename), pageCount: index.pageCount || 0, figureCount: index.figureCount, kindStats: index.kindStats || {}, page: options.page || null, manifest: options.includeManifest ? index : undefined };
}

export async function searchFigures(filename, options = {}) {
  const query = String(options.query || "").trim();
  if (!query) throw new Error("query is required");
  const index = await getFiguresIndex(filename, { buildIfMissing: true });
  const page = Number(options.page || 0);
  const section = normalizeForSearch(options.section || "");
  const limit = clampInteger(options.limit ?? options.topK, DEFAULT_FIGURE_TOP_K, 1, MAX_FIGURE_TOP_K);
  const results = (index.figures || [])
    .filter((fig) => !page || Number(fig.page) === page)
    .filter((fig) => !section || normalizeForSearch(fig.section_title || "").includes(section))
    .map((fig) => ({ ...fig, match: scoreManifestFigure(fig, query) }))
    .filter((fig) => fig.match.score > 0)
    .sort((a, b) => b.match.score - a.match.score || a.page - b.page)
    .slice(0, limit)
    .map((fig) => ({ figure_id: fig.figure_id || fig.id, page: fig.page, caption: fig.caption, section_title: fig.section_title || "", image_path: fig.image_path || "", match_score: fig.match.score, match_reasons: fig.match.reasons, render: fig.render || { status: "missing" }, nearby_text_preview: fig.nearby_text_preview || fig.contextPreview || "" }));
  return { ok: true, filename, query, results };
}

export async function listFigureManifest(filename, options = {}) {
  const index = await getFiguresIndex(filename, { buildIfMissing: true });
  const page = Number(options.page || 0);
  const section = normalizeForSearch(options.section || "");
  const limit = clampInteger(options.limit ?? options.topK, DEFAULT_FIGURE_TOP_K, 1, MAX_FIGURE_TOP_K);
  const results = (index.figures || [])
    .filter((fig) => !page || Number(fig.page) === page)
    .filter((fig) => !section || normalizeForSearch(fig.section_title || "").includes(section))
    .sort((a,b) => a.page - b.page || String(a.figure_id || a.id).localeCompare(String(b.figure_id || b.id)))
    .slice(0, limit)
    .map((fig) => ({ figure_id: fig.figure_id || fig.id, page: fig.page, caption: fig.caption, section_title: fig.section_title || "", image_path: fig.image_path || "", render_status: fig.render?.status || "missing", nearby_text_preview: fig.nearby_text_preview || fig.contextPreview || "" }));
  return { ok: true, filename, manifest_path: safeFiguresIndexPath(filename), figureCount: index.figureCount, results };
}

export async function getFigureImage(filename, figureId, options = {}) {
  const dpi = Number(options.dpi || 200);
  const render = await renderFigureOnDemand({ filename, figure_id: figureId, page: options.page, bbox: options.bbox, scale: Math.max(0.25, dpi / 100), force: Boolean(options.force) });
  const access = await imageAccessWithExists(render.image_path || "");
  return { figure_id: render.figure_id || figureId || "", page: render.page || 0, bbox: render.bbox || [], caption: render.caption || "", image_path: render.image_path || "", image_access: access, render: { status: render.ok ? "ready" : "failed", dpi, width: Number(render.width || 0), height: Number(render.height || 0), mtimeMs: access.exists ? Math.round((await fs.stat(access.local_path)).mtimeMs) : 0 }, ok: Boolean(render.ok), warnings: render.warnings || [], message: render.message || "" };
}

export async function getFigureContextPack(filename, figureId, options = {}) {
  const index = await getFiguresIndex(filename, { buildIfMissing: true });
  const figure = (index.figures || []).find((f) => [f.figure_id, f.id, f.figureUid, f.figure_uid].filter(Boolean).includes(figureId));
  if (!figure) throw new Error(`Figure not found: ${figureId}`);
  const image = await getFigureImage(filename, figureId, { dpi: options.dpi || figure.render?.dpi || 200 });
  const pageData = await extractPdfPages(filename, { startPage: figure.page, endPage: figure.page });
  const text = pageData.pages?.[0]?.text || "";
  const caption = figure.caption || "";
  const pos = caption ? text.indexOf(caption) : -1;
  const before = pos >= 0 ? text.slice(Math.max(0, pos - 2500), pos) : text.slice(0, 2500);
  const after = pos >= 0 ? text.slice(pos + caption.length, pos + caption.length + 2500) : text.slice(2500, 5000);
  let ocr_text = [];
  if (options.include_ocr) {
    const ocrIndex = await loadFigureOcrIndex(filename).catch(() => null);
    const cached = (ocrIndex?.figures || []).find((f) => [f.figure_id, f.id, f.figureUid, f.figure_uid].filter(Boolean).includes(figureId));
    if (cached) ocr_text = cached.ocr_text || cached.items || [];
  }
  return { figure_id: figure.figure_id || figure.id, filename, page: figure.page, bbox: figure.bbox || [], image_path: image.image_path, image_access: image.image_access, caption, section_title: figure.section_title || "", page_text_before: compactText(before, 2500), page_text_after: compactText(after, 2500), nearby_tables: options.include_tables === false ? [] : (figure.related_tables || []), nearby_cautions: options.include_cautions === false ? [] : (figure.related_cautions || []), related_registers: figure.related_registers || [], related_bitfields: figure.related_bitfields || [], ocr_text, agent_instruction: FIGURE_AGENT_INSTRUCTION };
}

export async function ocrFigureForSearch(filename, figureId, options = {}) {
  const result = await ocrFigureOnDemand({ filename, figure_id: figureId, engine: "auto", mode: "text", force: Boolean(options.force) });
  const text = result.plain_text || (result.ocr_text || []).map((i) => i.text || "").join(" ");
  return { ok: Boolean(result.ok), figure_id: figureId, image_path: result.image_path || "", ocr: { text_original: text, text_normalized: normalizeForSearch(text), bbox: result.bbox || [], confidence: Number(result.confidence_avg || 0), tokens: splitTokens(text) }, warnings: result.warnings || [], message: result.message || "" };
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
