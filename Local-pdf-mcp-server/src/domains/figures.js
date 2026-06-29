import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { appendEvidenceContract, atomicWriteJson, clampInteger, compactText, getPdfSourceInfo, isSamePdfSource, makeEvidence, makeEvidenceContract, makeInference, makeNeedsVerification, normalizeForSearch, pathExists, readJsonCached, safeFiguresIndexPath, safePagesCachePath, safeTablesIndexPath } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { DEFAULT_FIGURE_TOP_K, FIGURE_INDEX_SCHEMA_VERSION, MAX_FIGURE_TOP_K, SERVER_VERSION, MAX_RENDER_DPI, MIN_RENDER_DPI } from "../core/runtime-constants.js";
import { buildFiguresWithPython, ensureFigureLookupIndex, loadFigureOcrIndex, renderFigureOnDemand, ocrFigureOnDemand } from "../services/ocr.js";


const detectHeadings = createRuntimePort("detectHeadings");
const extractPdfPages = createRuntimePort("extractPdfPages");
const extractTablesFromPages = createRuntimePort("extractTablesFromPages");
const getPagesCache = createRuntimePort("getPagesCache");
const getPdfPageCount = createRuntimePort("getPdfPageCount");


const q = createRuntimePort("q");


const scoreSimpleText = createRuntimePort("scoreSimpleText");


const FIGURE_AGENT_INSTRUCTION = "Open image_path as an image and analyze the figure visually. Use the text context only as supporting evidence.";

function canonicalFigureId(page, ordinal) {
  return `p${Number(page || 0)}_f${String(Math.max(1, Number(ordinal || 1))).padStart(3, "0")}`;
}

function legacyFigureIds(figure = {}) {
  return [figure.figure_id, figure.id, figure.figureUid, figure.figure_uid, ...(figure.legacy_ids || []), ...(figure.aliases || [])]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function figureId(figure = {}, index = 0) {
  return String(figure.figure_id || canonicalFigureId(figure.page || 0, index + 1)).trim();
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

function normalizePathForMatch(value = "") {
  return String(value || "").replace(/\\/g, "/");
}

function isLegacyRenderPath(value = "") {
  const normalized = normalizePathForMatch(value);
  return /(^|\/)renders?\//i.test(normalized);
}

function isCanonicalFigureImagePath(value = "") {
  const normalized = normalizePathForMatch(value);
  return /(^|\/)indexes\/cache\/figure-images\//i.test(normalized);
}

function aiVisibleImagePath(value = "") {
  const candidate = String(value || "").trim();
  return candidate && isCanonicalFigureImagePath(candidate) && !isLegacyRenderPath(candidate) ? candidate : "";
}

async function imageAccessWithExists(localPath = "") {
  const access = imageAccess(localPath);
  access.exists = Boolean(access.local_path && await pathExists(access.local_path));
  return access;
}

function normalizeFigureRecord(filename, figure = {}, index = 0, source = null) {
  const canonical = /^p\d+_f\d{3}$/.test(String(figure.figure_id || "")) ? String(figure.figure_id) : canonicalFigureId(figure.page || 0, index + 1);
  const aliases = [...new Set(legacyFigureIds(figure).filter((alias) => alias && alias !== canonical))];
  const id = canonical;
  const img = aiVisibleImagePath(figure.image_path || "");
  const legacyIgnored = [figure.renderPath, figure.render_path, isLegacyRenderPath(figure.image_path) ? figure.image_path : ""].map((item) => String(item || "").trim()).filter(Boolean);
  return {
    schemaVersion: 1,
    filename,
    figure_id: id,
    id,
    legacy_ids: aliases,
    aliases,
    page: Number(figure.page || 0),
    bbox: Array.isArray(figure.bbox) ? figure.bbox : [],
    image_path: img,
    caption: String(figure.caption || figure.title || "").trim(),
    artifact_type: String(figure.artifact_type || "").trim() || undefined,
    number: String(figure.number || "").trim(),
    classificationReasons: Array.isArray(figure.classificationReasons) ? figure.classificationReasons : [],
    section_title: figureSectionTitle(figure),
    nearby_text_preview: figureNearbyPreview(figure),
    ocr_keywords: Array.isArray(figure.ocr_keywords) ? figure.ocr_keywords : [],
    related_registers: Array.isArray(figure.related_registers) ? figure.related_registers : [],
    related_bitfields: Array.isArray(figure.related_bitfields) ? figure.related_bitfields : [],
    related_cautions: Array.isArray(figure.related_cautions) ? figure.related_cautions : [],
    related_tables: Array.isArray(figure.related_tables) ? figure.related_tables : [],
    render: { status: img ? "ready" : "missing", mode: img ? String(figure.render?.mode || "") : "", dpi: Number(figure.render?.dpi || 0), width: Number(figure.render?.width || 0), height: Number(figure.render?.height || 0), mtimeMs: Number(figure.render?.mtimeMs || 0) },
    image_access: { local_path: img ? path.resolve(img) : "", mime_type: "image/png", exists: false, agent_should_open_as_image: true },
    legacy_render_path_ignored: legacyIgnored[0] || undefined,
    provenance: { sourceFingerprint: source ? `${Number(source.size || 0)}:${Math.round(Number(source.mtimeMs || 0))}` : String(figure.sourceFingerprint || ""), generatedAt: new Date().toISOString() },
    // Backward-compatible fields used by older tools.
    title: String(figure.title || figure.caption || "").trim(),
    source: String(figure.source || "").trim() || undefined,
    kind: String(figure.kind || figure.type || "figure").trim() || "figure",
    type: String(figure.type || figure.kind || "Figure").trim() || "Figure",
    headings: Array.isArray(figure.headings) ? figure.headings : [],
    contextLines: Array.isArray(figure.contextLines) ? figure.contextLines : [],
    contextPreview: figureNearbyPreview(figure),
    confidence: Number(figure.confidence || 50),
    searchText: normalizeForSearch([figure.caption, figure.title, figure.kind, figure.artifact_type, figureSectionTitle(figure), figureNearbyPreview(figure), ...(Array.isArray(figure.ocr_keywords) ? figure.ocr_keywords : [])].join("\n")),
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


function stableShortHash(text = "") {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex").slice(0, 12);
}

function tableCaptionId(filename, page, number, lineIndex, sourceFingerprint = "") {
  const normalizedNumber = normalizeFigureNumber(number || "table").toLowerCase() || "table";
  const fingerprint = stableShortHash([filename, page, normalizedNumber, lineIndex, sourceFingerprint].join("|"));
  return `tblcap-p${Number(page || 0)}-${normalizedNumber}-${fingerprint}`.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function cleanCaptionTitle(value = "") {
  return String(value || "").replace(/^[\s:.-]+/, "").replace(/\s+/g, " ").trim();
}

export function extractTableCaptionsFromPageText(pageText = "", pageNumber = 0, options = {}) {
  const filename = String(options.filename || "").trim();
  const sourceFingerprint = String(options.sourceFingerprint || "").trim();
  const headings = Array.isArray(options.headings) ? options.headings : [];
  const section_title = String(options.section_title || headings[0] || "").trim();
  const lines = String(pageText || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const captions = [];
  const captionRe = /^Table\s+((?:[A-Z]|[A-Z]?\d+)(?:[.\-]\d+)*(?:[A-Z])?)\s*(?:[:.\-]\s*)?(.{0,220})$/i;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(captionRe);
    if (!match) continue;
    const number = match[1];
    let title = cleanCaptionTitle(match[2] || "");
    if (title.length < 8 && lines[index + 1] && !captionRe.test(lines[index + 1]) && !/^(Figure|Fig\.?)\s+/i.test(lines[index + 1]) && lines[index + 1].length < 160) {
      title = cleanCaptionTitle(`${title} ${lines[index + 1]}`);
    }
    const contextStart = Math.max(0, index - 4);
    const contextEnd = Math.min(lines.length, index + 12);
    const contextLines = lines.slice(contextStart, contextEnd);
    const caption = `Table ${number}${title ? ` ${title}` : ""}`.replace(/\s+/g, " ").trim();
    captions.push({
      table_caption_id: tableCaptionId(filename, pageNumber, number, index, sourceFingerprint),
      filename,
      page: pageNumber,
      number,
      title,
      caption,
      section_title,
      headings,
      nearby_text_preview: compactText(contextLines.join("\n"), 1000),
      contextLines,
      lineIndex: index,
      source: "table-caption-regex",
      sourceFingerprint,
    });
  }
  return captions;
}

const VISUAL_TABLE_SIGNALS = [
  { kind: "bit-layout", label: "bit/data layout", patterns: [/\bbit(?:s|\s+position|\s+layout)?\b/i, /\bMSB\b/i, /\bLSB\b/i, /\breserved\s+bit\b/i, /\bpadding\b/i, /\bX\s+cell\b/i, /\bpacked|unpacked|endian\b/i, /\bfield\s+layout\b/i] },
  { kind: "format-diagram", label: "data/frame/protocol format", patterns: [/\b(?:data|frame|transfer|packet|protocol|word|sample|slot|bus)\s+format\b/i] },
  { kind: "timing-visual-table", label: "timing/transaction", patterns: [/\btiming|waveform|cycle|setup|hold|strobe|transaction\b/i, /\b(?:read|write)\s+cycle\b/i] },
  { kind: "layout-table", label: "channel/sample layout", patterns: [/\bchannel|left|right|Lch|Rch|mono|monaural|stereo|sample(?:\s+width)?|pixel|component\b/i] },
  { kind: "sequence-visual-table", label: "sequence/layout graphic", patterns: [/\bdiagram|layout|sequence|flow|arrow|block|state\s+transition|operation\s+sequence\b/i, /->|→|⇒/i] },
];

export function classifyVisualTableCaption(caption = {}) {
  const text = [caption.caption, caption.title, caption.nearby_text_preview, ...(caption.contextLines || [])].join("\n");
  const reasons = [];
  const hits = new Map();
  for (const group of VISUAL_TABLE_SIGNALS) {
    for (const pattern of group.patterns) {
      if (pattern.test(text)) {
        hits.set(group.kind, (hits.get(group.kind) || 0) + 1);
        reasons.push(`${group.label}: ${pattern.source}`);
      }
    }
  }
  if (!hits.size) return { artifact_type: "table-caption", kind: "table", confidence: 0, classificationReasons: [] };
  const captionOnly = [caption.caption, caption.title].join(" ");
  if (/\b(?:timing|waveform|read\s+cycle|write\s+cycle)\b/i.test(captionOnly)) hits.set("timing-visual-table", (hits.get("timing-visual-table") || 0) + 3);
  if (/\b(?:sequence|flow|operation\s+sequence|state\s+transition)\b/i.test(captionOnly)) hits.set("sequence-visual-table", (hits.get("sequence-visual-table") || 0) + 3);
  if (/\b(?:data|frame|transfer|packet|protocol|word|sample|slot|bus)\s+format\b/i.test(captionOnly)) hits.set("format-diagram", (hits.get("format-diagram") || 0) + 2);
  const priority = ["timing-visual-table", "sequence-visual-table", "bit-layout", "format-diagram", "layout-table"];
  const kind = priority.map((k) => [k, hits.get(k) || 0]).sort((a, b) => b[1] - a[1] || priority.indexOf(a[0]) - priority.indexOf(b[0]))[0][0] || "visual-table";
  const score = Math.min(95, 45 + [...hits.values()].reduce((a, b) => a + b, 0) * 10 + (hits.size > 1 ? 10 : 0));
  return { artifact_type: "visual-table", kind, confidence: score, classificationReasons: [...new Set(reasons)].slice(0, 12) };
}

export function visualTableRecordFromCaption(filename, caption, ordinal = 0, pageHeadings = []) {
  const cls = classifyVisualTableCaption(caption);
  if (cls.artifact_type !== "visual-table") return null;
  const id = figureIdFor(caption.page, ordinal, "Table", caption.number);
  const legacyId = legacyFigureIdFor(caption.page, ordinal, "Table", caption.number);
  const contextText = (caption.contextLines || []).join("\n");
  return {
    figure_id: id,
    id,
    legacy_ids: [caption.table_caption_id, legacyId].filter((v, i, a) => v && v !== id && a.indexOf(v) === i),
    aliases: [caption.table_caption_id, legacyId, `Table ${caption.number}`].filter(Boolean),
    filename,
    page: caption.page,
    type: "Table",
    number: caption.number,
    title: caption.title,
    caption: caption.caption,
    artifact_type: "visual-table",
    kind: cls.kind,
    section_title: caption.section_title || pageHeadings[0] || "",
    headings: caption.headings || pageHeadings || [],
    nearby_text_preview: caption.nearby_text_preview || compactText(contextText, 1000),
    contextLines: caption.contextLines || [],
    bbox: [],
    image_path: "",
    render: { status: "missing" },
    image_access: imageAccess(""),
    confidence: cls.confidence,
    classificationReasons: cls.classificationReasons,
    searchText: normalizeForSearch([caption.caption, caption.title, cls.kind, "visual-table table", caption.section_title, contextText].join("\n")),
    source: "visual-table-caption",
    lineIndex: caption.lineIndex,
    sourceFingerprint: caption.sourceFingerprint,
  };
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

export function legacyFigureIdFor(page, ordinal, type, number) {
  const prefix = /^table$/i.test(type) ? "tbl" : "fig";
  const num = normalizeFigureNumber(number);
  return `${prefix}-p${page}-${num || ordinal}`.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

export function figureIdFor(page, ordinal, type, number) {
  return canonicalFigureId(page, ordinal);
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
  const legacyId = legacyFigureIdFor(caption.page, ordinal, caption.type, caption.number);
  const confidence = Math.min(100,
    50 +
    (caption.source === "caption-regex" ? 25 : 8) +
    (kind !== "unknown" ? 15 : 0) +
    ((caption.title || "").length > 8 ? 6 : 0)
  );

  return {
    id,
    figure_id: id,
    legacy_ids: legacyId && legacyId !== id ? [legacyId] : [],
    aliases: legacyId && legacyId !== id ? [legacyId] : [],
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

function resultSourceFingerprint(source) {
  return source ? `${Number(source.size || 0)}:${Math.round(Number(source.mtimeMs || 0))}` : "";
}

function computeKindStats(figures = []) {
  return figures.reduce((acc, fig) => {
    const kind = fig.kind || fig.type || "unknown";
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {});
}

async function buildCaptionOnlyManifest(filename, pageCache = null, options = {}) {
  const cache = pageCache || await getPagesCache(filename, { buildIfMissing: true });
  const source = await getPdfSourceInfo(filename);
  const requestedPage = Number(options.page || 0);
  const pages = (cache.pages || []).filter((page) => !requestedPage || Number(page.page) === requestedPage);
  const figures = [];
  for (const page of pages) {
    let headings = [];
    try {
      headings = detectHeadings(page.text || "");
    } catch (error) {
      if (!/Runtime port is not wired: detectHeadings/.test(error instanceof Error ? error.message : String(error))) throw error;
      headings = [];
    }
    const captions = extractFigureCaptionsFromPageText(page.text || "", page.page);
    captions.forEach((caption, index) => {
      if (caption.type === "Table") {
        const tableCaption = extractTableCaptionsFromPageText(caption.caption, page.page, { filename, sourceFingerprint: resultSourceFingerprint(source), headings, section_title: headings[0] || "" })[0] || { ...caption, filename, table_caption_id: tableCaptionId(filename, page.page, caption.number, caption.lineIndex, resultSourceFingerprint(source)), section_title: headings[0] || "", headings, nearby_text_preview: compactText((caption.contextLines || []).join("\n"), 1000), sourceFingerprint: resultSourceFingerprint(source) };
        const visual = visualTableRecordFromCaption(filename, { ...tableCaption, contextLines: caption.contextLines || tableCaption.contextLines || [], nearby_text_preview: compactText((caption.contextLines || []).join("\n"), 1000) }, index + 1, headings);
        figures.push(visual || figureFromCaption(filename, caption, index + 1, headings));
      } else {
        figures.push(figureFromCaption(filename, caption, index + 1, headings));
      }
    });
    const existingTableKeys = new Set(captions.filter((c) => c.type === "Table").map((c) => `${c.page}:${normalizeFigureNumber(c.number).toLowerCase()}:${c.lineIndex}`));
    const tableCaptions = extractTableCaptionsFromPageText(page.text || "", page.page, { filename, sourceFingerprint: resultSourceFingerprint(source), headings, section_title: headings[0] || "" });
    tableCaptions.forEach((caption, index) => {
      const key = `${caption.page}:${normalizeFigureNumber(caption.number).toLowerCase()}:${caption.lineIndex}`;
      if (existingTableKeys.has(key)) return;
      const visual = visualTableRecordFromCaption(filename, caption, captions.length + index + 1, headings);
      if (visual) figures.push(visual);
    });
  }
  let result = {
    schemaVersion: FIGURE_INDEX_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source,
    sourceFingerprint: source ? `${Number(source.size || 0)}:${Math.round(Number(source.mtimeMs || 0))}` : "",
    pageCount: cache.pageCount,
    partial: Boolean(requestedPage),
    pagesIndexed: requestedPage ? [requestedPage] : (cache.pages || []).map((p) => Number(p.page || 0)).filter(Boolean),
    producer: { engine: "native-caption", manifestOnly: true, renderImages: false, runOcr: false, runVl: false, runSemantic: false },
    figures,
  };
  result = await normalizeFigureManifest(filename, result);
  result.figureCount = result.figures.length;
  result.kindStats = computeKindStats(result.figures);
  return result;
}

export async function buildFiguresIndex(filename, pageCache = null, options = {}) {
  if (options.usePython === true) {
    try {
      const pythonIndex = await buildFiguresWithPython(filename, { force: Boolean(options.force), manifestOnly: true, renderImages: false, runOcr: false, runVl: false, runSemantic: false });
      const normalizedPython = await normalizeFigureManifest(filename, pythonIndex);
      normalizedPython.producer = { ...(normalizedPython.producer || {}), manifestOnly: true, renderImages: false, runOcr: false, runVl: false, runSemantic: false };
      await atomicWriteJson(safeFiguresIndexPath(filename), normalizedPython).catch(() => {});
      await ensureFigureLookupIndex(filename, normalizedPython, { force: true }).catch(() => {});
      return normalizedPython;
    } catch {
      // Explicit Python extraction failed; fall back to metadata-only captions.
    }
  }

  const result = await buildCaptionOnlyManifest(filename, pageCache, options);
  if (!options.page) {
    await atomicWriteJson(safeFiguresIndexPath(filename), result);
    await ensureFigureLookupIndex(filename, result, { force: true }).catch(() => {});
  }
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
    if (!(data.figures || [])[0]?.figure_id || !(data.figures || [])[0]?.image_access || (data.figures || []).some((fig) => fig.renderPath || fig.render_path || isLegacyRenderPath(fig.image_path || "") || (fig.image_path && !isCanonicalFigureImagePath(fig.image_path)))) {
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
  if (options.buildIfMissing === true) return buildFiguresIndex(filename, null, { force: false });
  throw new Error(`Figures manifest not found for ${filename}. Run rebuild_figure_manifest(filename="${filename}") first.`);
}

export function figureMatchesFilter(figure, { filter = "", kind = "" } = {}) {
  const kindFilter = String(kind || "").trim().toLowerCase();
  if (kindFilter) {
    const candidates = [figure.kind, figure.type, figure.artifact_type, ...(figure.aliases || [])].map((v) => String(v || "").toLowerCase());
    if (kindFilter === "table") {
      if (!candidates.includes("table") && !candidates.includes("visual-table")) return false;
    } else if (!candidates.includes(kindFilter)) return false;
  }
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
  const index = await getFiguresIndex(filename, { buildIfMissing: Boolean(options.buildIfMissing) });
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
  const index = await getFiguresIndex(filename, { buildIfMissing: Boolean(options.buildIfMissing) });
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
  const index = await getFiguresIndex(filename, { buildIfMissing: Boolean(options.buildIfMissing) });
  const figureId = String(options.figureId || "").trim();
  const page = Number(options.page || 0);
  const query = String(options.query || "").trim();
  const includePages = clampInteger(options.includePages, 0, 0, 2);
  let figure = null;

  if (figureId) figure = (index.figures || []).find((item) => [item.figure_id, item.id, ...(item.legacy_ids || []), ...(item.aliases || [])].filter(Boolean).includes(figureId));
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
  const page = Number(options.page || 0);
  let pageCache;
  try {
    pageCache = await getPagesCache(filename, { buildIfMissing: true });
  } catch (error) {
    if (!/Runtime port is not wired: getPagesCache/.test(error instanceof Error ? error.message : String(error))) throw error;
    pageCache = await readJsonCached(safePagesCachePath(filename));
  }
  if (page) {
    const existing = await loadFiguresIndex(filename).catch(() => null);
    const pageIndex = await buildFiguresIndex(filename, pageCache, { force: Boolean(options.force), page });
    let merged;
    if (existing) {
      const preserved = (existing.figures || []).filter((fig) => Number(fig.page) !== page);
      merged = { ...existing, updatedAt: new Date().toISOString(), partial: Boolean(existing.partial), pagesIndexed: [...new Set([...(existing.pagesIndexed || []), page])], figures: [...preserved, ...(pageIndex.figures || [])].sort((a, b) => a.page - b.page || String(a.figure_id || a.id).localeCompare(String(b.figure_id || b.id))) };
      merged.figureCount = merged.figures.length;
      merged.kindStats = computeKindStats(merged.figures);
      merged = await normalizeFigureManifest(filename, merged);
    } else {
      merged = { ...pageIndex, partial: true, pagesIndexed: [page] };
    }
    await atomicWriteJson(safeFiguresIndexPath(filename), merged);
    await ensureFigureLookupIndex(filename, merged, { force: true }).catch(() => {});
    return { ok: true, filename, mode: "page-limited", page, manifest_path: safeFiguresIndexPath(filename), pageCount: merged.pageCount || 0, figureCount: merged.figureCount, updatedPageFigureCount: (pageIndex.figures || []).length, kindStats: merged.kindStats || {}, partial: Boolean(merged.partial), manifest: options.includeManifest ? merged : undefined };
  }
  const index = await buildFiguresIndex(filename, pageCache, { force: Boolean(options.force), usePython: Boolean(options.usePython) });
  return { ok: true, filename, mode: "full", page: null, manifest_path: safeFiguresIndexPath(filename), pageCount: index.pageCount || 0, figureCount: index.figureCount, updatedPageFigureCount: null, kindStats: index.kindStats || {}, partial: false, manifest: options.includeManifest ? index : undefined };
}

export async function searchFigures(filename, options = {}) {
  const query = String(options.query || "").trim();
  if (!query) throw new Error("query is required");
  const index = await getFiguresIndex(filename, { buildIfMissing: Boolean(options.buildIfMissing) });
  const page = Number(options.page || 0);
  const section = normalizeForSearch(options.section || "");
  const kind = String(options.kind || "").trim();
  const limit = clampInteger(options.limit ?? options.topK, DEFAULT_FIGURE_TOP_K, 1, MAX_FIGURE_TOP_K);
  const results = (index.figures || [])
    .filter((fig) => !page || Number(fig.page) === page)
    .filter((fig) => !section || normalizeForSearch(fig.section_title || "").includes(section))
    .filter((fig) => figureMatchesFilter(fig, { kind }))
    .map((fig) => ({ ...fig, match: scoreManifestFigure(fig, query) }))
    .filter((fig) => fig.match.score > 0)
    .sort((a, b) => b.match.score - a.match.score || a.page - b.page)
    .slice(0, limit)
    .map((fig) => ({ figure_id: fig.figure_id || fig.id, page: fig.page, caption: fig.caption, section_title: fig.section_title || "", image_path: aiVisibleImagePath(fig.image_path || ""), match_score: fig.match.score, match_reasons: fig.match.reasons, render: fig.render || { status: "missing" }, nearby_text_preview: fig.nearby_text_preview || fig.contextPreview || "", next_tool: "get_figure_context_pack" }));
  return { ok: true, filename, query, kind, next_tool: "get_figure_context_pack", results };
}

export async function listFigureManifest(filename, options = {}) {
  const index = await getFiguresIndex(filename, { buildIfMissing: Boolean(options.buildIfMissing) });
  const page = Number(options.page || 0);
  const section = normalizeForSearch(options.section || "");
  const kind = String(options.kind || "").trim();
  const limit = clampInteger(options.limit ?? options.topK, DEFAULT_FIGURE_TOP_K, 1, MAX_FIGURE_TOP_K);
  const results = (index.figures || [])
    .filter((fig) => !page || Number(fig.page) === page)
    .filter((fig) => !section || normalizeForSearch(fig.section_title || "").includes(section))
    .filter((fig) => figureMatchesFilter(fig, { kind }))
    .sort((a,b) => a.page - b.page || String(a.figure_id || a.id).localeCompare(String(b.figure_id || b.id)))
    .slice(0, limit)
    .map((fig) => ({ figure_id: fig.figure_id || fig.id, page: fig.page, caption: fig.caption, section_title: fig.section_title || "", image_path: aiVisibleImagePath(fig.image_path || ""), render: { status: fig.render?.status || "missing" }, nearby_text_preview: fig.nearby_text_preview || fig.contextPreview || "", next_tool: "get_figure_context_pack" }));
  return { ok: true, filename, manifest_path: safeFiguresIndexPath(filename), figureCount: index.figureCount, next_tool: "get_figure_context_pack", results };
}

export async function getFigureImage(filename, figureId, options = {}) {
  const dpi = clampInteger(options.dpi, 200, MIN_RENDER_DPI, MAX_RENDER_DPI);
  const render = await renderFigureOnDemand({ filename, figure_id: figureId, page: options.page, bbox: options.bbox, scale: Math.max(0.25, dpi / 100), force: Boolean(options.force) });
  const safeImagePath = aiVisibleImagePath(render.image_path || "");
  const access = await imageAccessWithExists(safeImagePath);
  const warnings = [...(render.warnings || [])];
  if (render.image_path && !safeImagePath) warnings.push("Renderer returned a non-canonical figure image path; it was suppressed from AI-visible output.");
  return { figure_id: render.figure_id || figureId || "", page: render.page || 0, bbox: render.bbox || [], caption: render.caption || "", image_path: safeImagePath, image_access: access, render: { status: render.ok && safeImagePath ? "ready" : "failed", mode: render.render?.mode || render.render_mode || "crop", reason: render.render?.reason || render.render_reason || "", dpi: Number(render.render?.dpi || dpi || 0), width: Number(render.render?.width || render.width || 0), height: Number(render.render?.height || render.height || 0), mtimeMs: access.exists ? Math.round((await fs.stat(access.local_path)).mtimeMs) : 0 }, ok: Boolean(render.ok && safeImagePath), warnings, message: render.message || "" };
}

function normalizeAnchorText(text = "") {
  return normalizeForSearch(String(text || "").replace(/[‐‑‒–—―]/g, "-")).replace(/\s+/g, " ").trim();
}

function normalizedOffset(haystack = "", needle = "") {
  const normalizedNeedle = normalizeAnchorText(needle);
  if (!normalizedNeedle) return -1;
  const chars = [];
  const offsets = [];
  for (let i = 0; i < haystack.length; i += 1) {
    const c = normalizeAnchorText(haystack[i]);
    if (!c) continue;
    chars.push(c);
    offsets.push(i);
  }
  const pos = chars.join("").indexOf(normalizedNeedle.replace(/\s+/g, ""));
  return pos >= 0 ? offsets[pos] : -1;
}

function anchorPageContext(text = "", figure = {}) {
  const caption = figure.caption || figure.title || "";
  let pos = caption ? text.indexOf(caption) : -1;
  if (pos >= 0) return { offset: pos, length: caption.length, method: "exact_caption", confidence: "high" };
  pos = normalizedOffset(text, caption);
  if (pos >= 0) return { offset: pos, length: caption.length, method: "normalized_caption", confidence: "high" };
  const num = figure.number ? String(figure.number) : (String(caption).match(/\b(?:Figure|Fig\.?|Table)\s+([A-Za-z]?\d+(?:[.-]\d+)*)/i)?.[0] || "");
  pos = num ? normalizedOffset(text, num) : -1;
  if (pos >= 0) return { offset: pos, length: String(num).length, method: "figure_number", confidence: "medium" };
  for (const line of figure.contextLines || []) {
    if (String(line).trim().length < 8) continue;
    pos = normalizedOffset(text, line);
    if (pos >= 0) return { offset: pos, length: String(line).length, method: "context_line", confidence: "medium" };
  }
  const keywords = splitTokens([caption, figure.section_title, figure.kind].join(" ")).filter((t) => t.length >= 4);
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`\\b${escaped}`, "i"));
    pos = match?.index ?? -1;
    if (pos >= 0) return { offset: pos, length: match[0].length, method: "keyword_original", confidence: "low" };
  }
  return { offset: Math.floor(text.length / 2), length: 0, method: "fallback", confidence: "low" };
}

function pageTextFromCache(cache, pageNumber) {
  const page = (cache?.pages || []).find((p) => Number(p.page || p.pageNumber || p.number) === Number(pageNumber));
  return page ? String(page.text || page.content || "") : "";
}

function isRuntimePortNotWired(error) {
  return /Runtime port .*not wired|not wired/i.test(String(error?.message || error || ""));
}

export async function getCachedOrExtractedPageText(filename, pageNumber) {
  const warnings = [];
  try {
    const cache = await getPagesCache(filename, { buildIfMissing: false });
    const text = pageTextFromCache(cache, pageNumber);
    if (text) return { text, source: "pages-cache", warning: "" };
  } catch (error) {
    if (!isRuntimePortNotWired(error)) warnings.push(`pages cache unavailable: ${String(error?.message || error).slice(0, 120)}`);
    try {
      const cache = await readJsonCached(safePagesCachePath(filename));
      const text = pageTextFromCache(cache, pageNumber);
      if (text) return { text, source: "pages-cache", warning: "" };
    } catch (readError) {
      if (!isRuntimePortNotWired(error)) warnings.push(`pages cache file unavailable: ${String(readError?.message || readError).slice(0, 120)}`);
    }
  }
  try {
    const pageData = await extractPdfPages(filename, { startPage: pageNumber, endPage: pageNumber });
    const text = String(pageData.pages?.[0]?.text || "");
    if (text) return { text, source: "single-page-extraction", warning: "" };
  } catch (error) {
    warnings.push(`single-page extraction unavailable: ${String(error?.message || error).slice(0, 120)}`);
  }
  return { text: "", source: "unavailable", warning: "page text unavailable", warnings };
}

export async function getFigureContextPack(filename, figureId, options = {}) {
  const index = await getFiguresIndex(filename, { buildIfMissing: Boolean(options.buildIfMissing) });
  const figure = (index.figures || []).find((f) => [f.figure_id, f.id, f.figureUid, f.figure_uid, ...(f.legacy_ids || []), ...(f.aliases || [])].filter(Boolean).includes(figureId));
  if (!figure) throw new Error(`Figure not found: ${figureId}`);
  const image = await getFigureImage(filename, figure.figure_id || figureId, { dpi: options.dpi ?? figure.render?.dpi ?? 200 });
  const pageText = await getCachedOrExtractedPageText(filename, figure.page);
  const text = pageText.text || "";
  const caption = figure.caption || "";
  const anchor = text ? anchorPageContext(text, figure) : { offset: 0, length: 0, method: "unavailable", confidence: "low" };
  const before = text ? text.slice(Math.max(0, anchor.offset - 2500), anchor.offset) : "";
  const afterStart = Math.min(text.length, anchor.offset + Math.max(anchor.length || 0, caption.length || 0));
  const after = text ? text.slice(afterStart, afterStart + 2500) : "";
  let ocr_text = [];
  if (options.include_ocr) {
    const ocrIndex = await loadFigureOcrIndex(filename).catch(() => null);
    const cached = (ocrIndex?.figures || []).find((f) => [f.figure_id, f.id, f.figureUid, f.figure_uid, ...(f.legacy_ids || []), ...(f.aliases || [])].filter(Boolean).includes(figureId));
    if (cached) ocr_text = cached.ocr_text || cached.items || [];
  }
  return { figure_id: figure.figure_id || figure.id, filename, page: figure.page, bbox: figure.bbox || [], image_path: image.image_path, image_access: image.image_access, caption, section_title: figure.section_title || "", page_text_before: compactText(before, 2500), page_text_after: compactText(after, 2500), context_anchor: anchor, nearby_tables: options.include_tables === false ? [] : (figure.related_tables || []), nearby_cautions: options.include_cautions === false ? [] : (figure.related_cautions || []), related_registers: figure.related_registers || [], related_bitfields: figure.related_bitfields || [], ocr_text, render: image.render, warnings: [...(image.warnings || []), ...(pageText.warning ? [pageText.warning] : []), ...((pageText.warnings || []).filter((w) => w && !String(w).includes("not wired")).slice(0, 2))], agent_instruction: image.render?.mode === "page_fallback" ? `${FIGURE_AGENT_INSTRUCTION} The image may be a full-page fallback because the exact figure bbox was unavailable.` : FIGURE_AGENT_INSTRUCTION };
}

export async function ocrFigureForSearch(filename, figureId, options = {}) {
  const result = await ocrFigureOnDemand({ filename, figure_id: figureId, engine: "auto", mode: "text", force: Boolean(options.force) });
  const text = result.plain_text || (result.ocr_text || []).map((i) => i.text || "").join(" ");
  const tokens = [...new Set(splitTokens(text))].slice(0, 200);
  let canonicalId = figureId;
  let artifactPath = "";
  if (result.ok) {
    const index = await getFiguresIndex(filename, { buildIfMissing: false });
    const pos = (index.figures || []).findIndex((f) => [f.figure_id, f.id, f.figureUid, f.figure_uid, ...(f.legacy_ids || []), ...(f.aliases || [])].filter(Boolean).includes(figureId));
    if (pos >= 0) {
      canonicalId = index.figures[pos].figure_id || index.figures[pos].id || figureId;
      artifactPath = path.join(path.dirname(safeFiguresIndexPath(filename)), `${filename}.${canonicalId}.ocr.txt`);
      await fs.writeFile(artifactPath, text, "utf-8").catch(() => {});
      index.figures[pos] = { ...index.figures[pos], ocr_keywords: tokens, ocr_status: "ready", ocr_updated_at: new Date().toISOString(), ocr_artifact_path: artifactPath };
      index.updatedAt = new Date().toISOString();
      await atomicWriteJson(safeFiguresIndexPath(filename), index);
      await ensureFigureLookupIndex(filename, index, { force: true }).catch(() => {});
    }
  }
  return { ok: Boolean(result.ok), figure_id: canonicalId, image_path: result.image_path || "", ocr: { text_original: text, text_normalized: normalizeForSearch(text), bbox: result.bbox || [], confidence: Number(result.confidence_avg || 0), tokens }, ocr_keywords: tokens, ocr_status: result.ok ? "ready" : "failed", ocr_artifact_path: artifactPath, warnings: result.warnings || [], message: result.message || "" };
}

export async function tableCoverageReport(filename, options = {}) {
  const index = await getFiguresIndex(filename, { buildIfMissing: Boolean(options.buildIfMissing) });
  let pageCache = null;
  try { pageCache = await getPagesCache(filename, { buildIfMissing: true }); }
  catch { pageCache = await readJsonCached(safePagesCachePath(filename)); }
  const source = await getPdfSourceInfo(filename).catch(() => index.source || null);
  const sourceFp = resultSourceFingerprint(source);
  const captions = [];
  for (const page of pageCache?.pages || []) {
    let headings = [];
    try { headings = detectHeadings(page.text || ""); } catch { headings = []; }
    captions.push(...extractTableCaptionsFromPageText(page.text || "", page.page, { filename, sourceFingerprint: sourceFp, headings, section_title: headings[0] || "" }));
  }
  const tablesIndex = await readJsonCached(safeTablesIndexPath(filename)).catch(() => null);
  const structuredTables = Array.isArray(tablesIndex?.tables) ? tablesIndex.tables : [];
  const visualTables = (index.figures || []).filter((fig) => fig.artifact_type === "visual-table" || fig.source === "visual-table-caption");
  const sameNumberPage = (item, caption) => Number(item.page || item.pageStart || 0) === Number(caption.page) && normalizeFigureNumber(item.number || item.tableNumber || item.caption || "").toLowerCase().includes(normalizeFigureNumber(caption.number).toLowerCase());
  const rows = captions.map((caption) => {
    const structured = structuredTables.find((table) => sameNumberPage(table, caption) || (Number(table.page || table.pageStart || 0) === Number(caption.page) && normalizeForSearch(table.caption || table.title || table.headerText || "").includes(normalizeForSearch(caption.title).slice(0, 30))));
    const visual = visualTables.find((fig) => Number(fig.page) === Number(caption.page) && normalizeFigureNumber(fig.number).toLowerCase() === normalizeFigureNumber(caption.number).toLowerCase());
    let status = "caption-only";
    let reason = "caption-detected-but-not-classified";
    if (structured) { status = "structured-table"; reason = "accepted-by-structured-table-index"; }
    else if (visual) { status = "visual-table"; reason = visual.render?.status === "failed" ? "render-missing" : "captioned-visual-table"; }
    return { caption: caption.caption, page: caption.page, number: caption.number, title: caption.title, structured_table_match: Boolean(structured), visual_table_match: Boolean(visual), status, reason };
  });
  return { ok: true, filename, captionCount: captions.length, structuredTableCount: structuredTables.length, visualTableCount: visualTables.length, manifest_path: safeFiguresIndexPath(filename), tables_path: safeTablesIndexPath(filename), rows };
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
  return makeEvidenceContract({ tool, filename, query, evidence, inference, needsVerification, warnings: ["Caption index is text-layer based; use it to locate visual pages, then verify the original PDF page."], recommendedNextTools: [`get_figure_context_pack(filename="${filename}", figure_id="<figure-id>")`, `read_pdf_pages(filename="${filename}", start_page=<page>, end_page=<page>)`] });
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
    lines.push(`- get_figure_context_pack(filename="${result.index.filename}", figure_id="${figure.id}")`);
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

  return appendEvidenceContract(lines.join("\n"), buildFigureEvidenceContract("get_figure_context_pack", result.filename, figure.caption, [figure]));
}
