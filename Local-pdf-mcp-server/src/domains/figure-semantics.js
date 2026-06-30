import { createHash } from "node:crypto";
import { FIGURE_SEMANTIC_SCHEMA_VERSION, SERVER_VERSION } from "../core/runtime-constants.js";
import {
  atomicWriteJson,
  compactText as runtimeCompactText,
  ensurePdfFilename,
  getPdfSourceInfo,
  isSamePdfSource,
  pathExists,
  readJsonCached,
  safeFigureOcrIndexPath,
  safeFigureSemanticIndexPath,
  safeFiguresIndexPath,
  safePagesCachePath,
} from "../core/runtime-helpers.js";
import { sourceFingerprint } from "../artifacts/manifest.js";
import { getFiguresIndex } from "./figures.js";
import { loadPagesCache } from "../services/pdf.js";
import { loadFigureOcrIndex, ocrFigureOnDemand } from "../services/ocr.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { classifyFigureType } from "../figure/figureTypeClassifier.js";
import { normalizeOcrBlocks } from "../figure/ocrNormalization.js";
import { parseTimingDiagram } from "../figure/timingDiagramParser.js";
import { parseSequenceDiagram } from "../figure/sequenceDiagramParser.js";
import { parseStateMachine } from "../figure/stateMachineParser.js";
import { parseBlockDiagram } from "../figure/blockDiagramParser.js";
import {
  bundleText,
  compactText,
  extractCounterNames,
  extractHardwareTokens,
  extractRegisterNames,
  extractSignalNames,
  extractValueTokens,
  normalizeConfidence,
  normalizeSearchText,
  sourceEvidence,
  splitSemanticLines,
  uniqueBy,
} from "../figure/semanticUtils.js";

const extractPdfPages = createRuntimePort("extractPdfPages");

function nowIso() {
  return new Date().toISOString();
}

function bboxKey(bbox = []) {
  return Array.isArray(bbox) ? bbox.map((value) => Math.round(Number(value || 0) * 10) / 10).join(",") : "";
}

function generatedFigureId(page, bbox = []) {
  const hash = createHash("sha1").update(`${page}:${bboxKey(bbox)}`).digest("hex").slice(0, 8);
  return `p${String(Number(page || 0)).padStart(4, "0")}_bbox_${hash}`;
}

function figureIds(figure = {}) {
  return [figure.figure_id, figure.id, figure.figureUid, figure.figure_uid].map((item) => String(item || "").trim()).filter(Boolean);
}

function bboxSimilar(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
  return a.every((value, index) => Math.abs(Number(value) - Number(b[index])) <= 2);
}

async function pageTextFor(filename, page) {
  const pageNumber = Number(page || 0);
  if (!pageNumber) return { text: "", source: "" };
  const cached = await loadPagesCache(filename).catch(() => null);
  const cachedPage = cached?.pages?.find((item) => Number(item.page) === pageNumber);
  if (cachedPage) return { text: String(cachedPage.text || ""), source: safePagesCachePath(filename) };
  try {
    const extracted = await extractPdfPages(filename, { startPage: pageNumber, endPage: pageNumber });
    return { text: String(extracted.pages?.[0]?.text || ""), source: "extractPdfPages" };
  } catch {
    return { text: "", source: "" };
  }
}

function captionFromPageText(pageText = "", figure = {}) {
  const existing = String(figure.caption || figure.title || "").trim();
  if (existing) return existing;
  const lines = String(pageText || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^Figure\s+\S+/i.test(lines[index])) continue;
    const collected = [lines[index]];
    for (let next = index + 1; next < lines.length && collected.length < 4; next += 1) {
      if (/^(?:Table|No\.|R01|Rev\.|Page\s+\d+)\b/i.test(lines[next])) break;
      collected.push(lines[next]);
    }
    return compactText(collected.join(" "), 600);
  }
  return "";
}

async function resolveSemanticTarget(filename, args = {}) {
  ensurePdfFilename(filename);
  const figureId = String(args.figure_id || args.figureId || "").trim();
  const requestedPage = Number(args.page || 0);
  const requestedBbox = Array.isArray(args.bbox) ? args.bbox.map(Number) : [];
  let index = null;
  try {
    index = await getFiguresIndex(filename, { buildIfMissing: true });
  } catch {
    index = null;
  }

  let figure = null;
  if (figureId && index?.figures) {
    figure = index.figures.find((item) => figureIds(item).includes(figureId)) || null;
  }
  if (!figure && requestedPage && requestedBbox.length === 4 && index?.figures) {
    figure = index.figures.find((item) => Number(item.page) === requestedPage && bboxSimilar(item.bbox, requestedBbox)) || null;
  }
  if (!figure && requestedPage && index?.figures) {
    const pageFigures = index.figures.filter((item) => Number(item.page) === requestedPage);
    figure = pageFigures[0] || null;
  }

  const page = Number(figure?.page || requestedPage || 0);
  const rawBbox = Array.isArray(figure?.bbox) && figure.bbox.length ? figure.bbox : requestedBbox;
  const bbox = Array.isArray(rawBbox) ? rawBbox.map(Number) : [];
  const hasValidBbox = bbox.length === 4 && bbox.every((value) => Number.isFinite(Number(value)));
  if (!page || (!hasValidBbox && !figure && !requestedPage)) {
    throw new Error("Provide figure_id from list_figures/find_figure, or both page and bbox=[x0,y0,x1,y1].");
  }

  const id = figureId || figureIds(figure)[0] || (hasValidBbox ? generatedFigureId(page, bbox) : `p${String(page).padStart(4, "0")}_page`);
  return {
    figure: figure || null,
    figure_id: id,
    page,
    bbox: hasValidBbox ? bbox.map((value) => Math.round(Number(value) * 100) / 100) : [],
    kind: figure?.kind || figure?.type || "",
    caption: String(figure?.caption || "").trim(),
    title: String(figure?.title || "").trim(),
  };
}

export async function loadFigureSemanticIndex(filename) {
  const filePath = safeFigureSemanticIndexPath(filename);
  if (!(await pathExists(filePath))) return null;
  try {
    const data = await readJsonCached(filePath);
    if (data.schemaVersion !== FIGURE_SEMANTIC_SCHEMA_VERSION) return null;
    if (data.filename !== filename) return null;
    if (!Array.isArray(data.records)) return null;
    const source = await getPdfSourceInfo(filename);
    if (data.source && !isSamePdfSource(data.source, source)) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeFigureSemanticIndex(filename, records = [], source = null) {
  const pdfSource = source || await getPdfSourceInfo(filename);
  const byId = new Map();
  for (const record of records) {
    if (!record?.figure_id) continue;
    byId.set(record.figure_id, record);
  }
  const sorted = [...byId.values()].sort((a, b) => Number(a.page || 0) - Number(b.page || 0) || String(a.figure_id).localeCompare(String(b.figure_id)));
  const artifact = {
    schemaVersion: FIGURE_SEMANTIC_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: sorted[0]?.createdAt || nowIso(),
    updatedAt: nowIso(),
    source: pdfSource,
    sourceFingerprint: sourceFingerprint(pdfSource),
    semanticCount: sorted.length,
    records: sorted,
  };
  await atomicWriteJson(safeFigureSemanticIndexPath(filename), artifact);
  return artifact;
}

function ocrBlocksFromFigureOcrEntry(entry = {}) {
  if (Array.isArray(entry.ocr_text)) return entry.ocr_text;
  if (Array.isArray(entry.tokens)) {
    return entry.tokens.map((token) => ({
      text: token.text || token.label || token.value || "",
      bbox: token.bbox || token.box || [],
      confidence: token.confidence ?? token.score ?? entry.confidenceAvg ?? entry.confidence_avg,
    }));
  }
  const text = String(entry.ocrText || entry.ocr_text || "").trim();
  if (!text) return [];
  return splitSemanticLines(text).map((line) => ({
    text: line,
    bbox: [],
    confidence: entry.confidenceAvg ?? entry.confidence_avg ?? 0.65,
  }));
}

async function figureOcrEvidence(filename, target, options = {}) {
  const warnings = [];
  let ocrBlocks = [];
  let plainText = "";
  let imagePath = "";
  let ocrPath = "";
  let semanticEvidencePath = "";
  let cacheHit = false;

  const ocrIndex = await loadFigureOcrIndex(filename).catch(() => null);
  const indexed = ocrIndex?.figures?.find((entry) => {
    const id = entry.figureUid || entry.figure_uid || entry.id || "";
    return id === target.figure_id || (Number(entry.page) === target.page && bboxSimilar(entry.bbox, target.bbox));
  });
  if (indexed && !options.force) {
    ocrBlocks = ocrBlocksFromFigureOcrEntry(indexed);
    plainText = String(indexed.ocrText || indexed.ocr_text || ocrBlocks.map((block) => block.text).join(" ")).trim();
    imagePath = indexed.renderPath || indexed.render_path || "";
    ocrPath = safeFigureOcrIndexPath(filename);
    cacheHit = true;
  }

  if (!ocrBlocks.length && options.generateOcr !== false) {
    const args = target.figure_id
      ? { filename, figure_id: target.figure_id, mode: "text", engine: "auto", force: Boolean(options.force) }
      : { filename, page: target.page, bbox: target.bbox, mode: "text", engine: "auto", force: Boolean(options.force) };
    const result = await ocrFigureOnDemand(args).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      ocr_text: [],
      warnings: [error instanceof Error ? error.message : String(error)],
    }));
    if (Array.isArray(result.ocr_text)) ocrBlocks = result.ocr_text;
    plainText = String(result.plain_text || ocrBlocks.map((block) => block.text).join(" ")).trim();
    imagePath = result.image_path || imagePath;
    ocrPath = result.raw_artifact?.path || ocrPath;
    semanticEvidencePath = result.semantic_cache_path || "";
    cacheHit = Boolean(result.cache_hit);
    if (result.ok === false && result.message) warnings.push(result.message);
    warnings.push(...(Array.isArray(result.warnings) ? result.warnings : []));
  }

  return {
    ocrBlocks,
    plainText,
    imagePath,
    ocrPath,
    semanticEvidencePath,
    cacheHit,
    warnings: uniqueBy(warnings, (item) => item),
  };
}

function entitiesFromText(text = "", normalizedOcrBlocks = [], meta = {}) {
  const entities = [];
  const add = (name, kind, evidenceText, confidence = 0.55) => {
    if (!name) return;
    entities.push({
      name,
      kind,
      bbox: [],
      confidence: normalizeConfidence(confidence),
      source_evidence: [sourceEvidence({ source: "semantic_text", text: evidenceText || name, page: meta.page, figureId: meta.figureId, bbox: meta.bbox, confidence })],
    });
  };

  for (const register of extractRegisterNames(text)) add(register, "register", text, 0.58);
  for (const counter of extractCounterNames(text)) add(counter, "counter", text, 0.6);
  for (const signal of extractSignalNames(text)) add(signal, "signal", text, 0.56);
  for (const value of extractValueTokens(text).slice(0, 24)) add(value, "value", value, 0.52);
  for (const block of normalizedOcrBlocks) {
    for (const token of block.tokens || []) {
      add(token.text, token.token_type, block.text_original || block.text_normalized, block.confidence);
    }
  }

  return uniqueBy(entities, (entity) => `${entity.kind}|${entity.name.toUpperCase()}`).slice(0, 120);
}

function mergeWarnings(...groups) {
  return uniqueBy(groups.flat().filter(Boolean), (item) => item).slice(0, 40);
}

function semanticRecordFromInputs({ filename, source, target, pageText, pageTextSource, ocrEvidence, force = false } = {}) {
  const caption = captionFromPageText(pageText, { caption: target.caption, title: target.title });
  const normalizedOcrBlocks = normalizeOcrBlocks(ocrEvidence.ocrBlocks || []);
  const input = {
    filename,
    page: target.page,
    figureId: target.figure_id,
    bbox: target.bbox,
    title: target.title || caption,
    caption,
    kind: target.kind,
    pageText,
    contextText: pageText,
    ocrBlocks: normalizedOcrBlocks,
  };
  const text = bundleText(input);
  const classifier = classifyFigureType(input);
  const meta = { page: target.page, figureId: target.figure_id, bbox: target.bbox };

  const timing = classifier.figure_type === "timing_diagram" || /\b(?:timing|waveform|edge|input capture|counter cleared|saw wave|GTIO|GTCNT)\b/i.test(text)
    ? parseTimingDiagram(input)
    : { signals: [], events: [], register_actions: [], counter_actions: [], timeline: [], engineering_inferences: [], uncertainties: [], warnings: [] };
  const sequence = classifier.figure_type === "sequence_diagram" || /^\s*(?:step\s*)?\d{1,3}[\).:-]|\bNo\.\s+Step\s+Name\s+Description\b/im.test(text)
    ? parseSequenceDiagram(input)
    : { actors: [], sequence_steps: [], edges: [], uncertainties: [], warnings: [] };
  const state = classifier.figure_type === "state_machine"
    ? parseStateMachine(input)
    : { states: [], transitions: [], uncertainties: [], warnings: [] };
  const block = classifier.figure_type === "block_diagram"
    ? parseBlockDiagram(input)
    : { blocks: [], ports: [], edges: [], uncertainties: [], warnings: [] };

  const entities = entitiesFromText(text, normalizedOcrBlocks, meta);
  const signals = timing.signals.length
    ? timing.signals
    : entities.filter((entity) => entity.kind === "signal" || entity.kind === "counter").map((entity) => ({
      name: entity.name,
      kind: entity.kind === "counter" ? "counter" : "unknown",
      bbox: entity.bbox || [],
      confidence: entity.confidence,
      source_evidence: entity.source_evidence || [],
    }));

  const classifierInferenceEvidence = classifier.evidence?.[0] || sourceEvidence({ source: pageTextSource || "page_text", text: caption || runtimeCompactText(text, 240), page: target.page, figureId: target.figure_id, bbox: target.bbox, confidence: classifier.confidence });
  const engineeringInferences = [
    {
      statement: `Figure classified as ${classifier.figure_type}.`,
      confidence: classifier.confidence,
      source_evidence: [classifierInferenceEvidence],
      reasons: classifier.reasons || [],
    },
    ...(timing.engineering_inferences || []),
  ];

  const uncertainties = mergeWarnings(
    timing.uncertainties,
    sequence.uncertainties,
    state.uncertainties,
    block.uncertainties,
    classifier.figure_type === "unknown" ? ["Figure type is unknown; semantic extraction is limited to normalized text/entity evidence."] : [],
    ocrEvidence.ocrBlocks?.length ? [] : ["OCR text for the figure crop is unavailable or empty; semantics may rely on caption/page text only."],
  );

  return {
    schemaVersion: FIGURE_SEMANTIC_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    figure_id: target.figure_id,
    page: target.page,
    bbox: target.bbox,
    figure_type: classifier.figure_type,
    confidence: Math.min(0.92, Math.max(classifier.confidence, timing.events.length || timing.register_actions.length ? 0.64 : 0.2)),
    source_artifacts: {
      ocr: ocrEvidence.ocrPath || "",
      layout: safeFiguresIndexPath(filename),
      vl: "",
      image: ocrEvidence.imagePath || "",
      page_text: pageTextSource || "",
      semantic_evidence: ocrEvidence.semanticEvidencePath || "",
    },
    title: target.title || "",
    caption,
    classifier,
    ocr_blocks: normalizedOcrBlocks.slice(0, 120),
    entities,
    signals: uniqueBy(signals, (signal) => signal.name.toUpperCase()).slice(0, 80),
    events: timing.events || [],
    edges: [...(sequence.edges || []), ...(block.edges || [])].slice(0, 160),
    sequence_steps: sequence.sequence_steps || [],
    states: state.states || [],
    transitions: state.transitions || [],
    blocks: block.blocks || [],
    ports: block.ports || [],
    register_actions: timing.register_actions || [],
    counter_actions: timing.counter_actions || [],
    timeline: timing.timeline || [],
    engineering_inferences: uniqueBy(engineeringInferences, (item) => item.statement).slice(0, 80),
    uncertainties,
    warnings: mergeWarnings(ocrEvidence.warnings, timing.warnings, sequence.warnings, state.warnings, block.warnings),
    provenance: {
      generatedBy: "local-pdf-mcp-server.figure-semantics",
      sourceFingerprint: sourceFingerprint(source),
      cached_ocr: Boolean(ocrEvidence.cacheHit),
      force,
    },
  };
}

export async function analyzeFigureSemantics(filename, args = {}) {
  ensurePdfFilename(filename);
  const force = Boolean(args.force);
  const target = await resolveSemanticTarget(filename, args);
  const source = await getPdfSourceInfo(filename);
  const existing = await loadFigureSemanticIndex(filename);
  if (!force && existing) {
    const cached = existing.records.find((record) => record.figure_id === target.figure_id);
    if (cached) return { record: cached, artifact: existing, cached: true };
  }

  const pageText = await pageTextFor(filename, target.page);
  const requestedGenerateOcr = args.generateOcr ?? args.generate_ocr;
  const generateOcr = requestedGenerateOcr === undefined
    ? Array.isArray(target.bbox) && target.bbox.length === 4
    : Boolean(requestedGenerateOcr);
  const ocrEvidence = await figureOcrEvidence(filename, target, {
    force,
    generateOcr,
  });
  const record = semanticRecordFromInputs({
    filename,
    source,
    target,
    pageText: pageText.text,
    pageTextSource: pageText.source,
    ocrEvidence,
    force,
  });

  const records = existing?.records?.filter((item) => item.figure_id !== record.figure_id) || [];
  records.push(record);
  const artifact = await writeFigureSemanticIndex(filename, records, source);
  return { record, artifact, cached: false };
}

export async function getFigureSemantics(filename, figureId) {
  ensurePdfFilename(filename);
  const id = String(figureId || "").trim();
  if (!id) throw new Error("figure_id is required");
  const artifact = await loadFigureSemanticIndex(filename);
  if (!artifact) throw new Error(`Figure semantic artifact not found for ${filename}. Run analyze_figure_semantics first.`);
  const record = artifact.records.find((item) => item.figure_id === id);
  if (!record) throw new Error(`Figure semantic record not found: ${id}`);
  return { artifact, record };
}

export async function listFigureSemantics(filename, options = {}) {
  ensurePdfFilename(filename);
  const artifact = await loadFigureSemanticIndex(filename);
  if (!artifact) return { filename, records: [], semanticCount: 0, artifact: null };
  const page = Number(options.page || 0);
  const figureType = String(options.figureType || options.figure_type || "").trim();
  const records = artifact.records.filter((record) => {
    if (page && Number(record.page) !== page) return false;
    if (figureType && record.figure_type !== figureType) return false;
    return true;
  });
  return { filename, records, semanticCount: records.length, artifact };
}

export async function searchFigureSemantics(filename, options = {}) {
  ensurePdfFilename(filename);
  const query = String(options.query || "").trim();
  if (!query) throw new Error("query is required");
  const listed = await listFigureSemantics(filename, options);
  const q = normalizeSearchText(query);
  const results = listed.records
    .map((record) => {
      const haystack = normalizeSearchText([
        record.figure_id,
        record.figure_type,
        record.caption,
        record.title,
        ...(record.entities || []).map((item) => item.name),
        ...(record.signals || []).map((item) => item.name),
        ...(record.blocks || []).map((item) => item.name),
        ...(record.states || []).map((item) => item.name),
        ...(record.register_actions || []).map((item) => `${item.register} ${item.action} ${item.value || ""}`),
        ...(record.counter_actions || []).map((item) => `${item.counter} ${item.action}`),
        ...(record.sequence_steps || []).map((item) => item.source_text || item.action || ""),
        ...(record.engineering_inferences || []).map((item) => item.statement),
      ].join("\n"));
      const exact = haystack.includes(q) ? 50 : 0;
      const tokens = q.split(/\s+/).filter(Boolean);
      const tokenScore = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 10 : 0), 0);
      return { record, score: exact + tokenScore + Math.round(Number(record.confidence || 0) * 10) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(a.record.page || 0) - Number(b.record.page || 0))
    .map((item) => ({ score: item.score, ...item.record }));
  return { filename, query, figure_type: options.figureType || options.figure_type || "", results, resultCount: results.length, artifact: listed.artifact };
}

export async function rebuildFigureSemanticsArtifact(filename, options = {}) {
  ensurePdfFilename(filename);
  const pageFilter = Number(options.page || 0);
  const force = Boolean(options.force);
  const source = await getPdfSourceInfo(filename);
  const figuresIndex = await getFiguresIndex(filename, { buildIfMissing: true });
  const figures = (figuresIndex.figures || []).filter((figure) => !pageFilter || Number(figure.page) === pageFilter);
  const total = figures.length;
  const records = [];
  const existing = force ? null : await loadFigureSemanticIndex(filename);
  const existingById = new Map((existing?.records || []).map((record) => [record.figure_id, record]));

  let current = 0;
  for (const figure of figures) {
    current += 1;
    if (options.onProgress && (current === 1 || current === total || current % 10 === 0)) {
      options.onProgress({ phase: "rebuild-figure-semantics", current, total, unit: "figures" });
    }
    const id = figureIds(figure)[0];
    if (!force && existingById.has(id)) {
      records.push(existingById.get(id));
      continue;
    }
    const requestedGenerateOcr = options.generateOcr ?? options.generate_ocr;
    const figureHasBbox = Array.isArray(figure.bbox) && figure.bbox.length === 4;
    const result = await analyzeFigureSemantics(filename, {
      figure_id: id,
      force,
      generateOcr: requestedGenerateOcr === undefined ? Boolean(pageFilter && figureHasBbox) : Boolean(requestedGenerateOcr),
    });
    records.push(result.record);
  }

  if (!figures.length && pageFilter) {
    const pageText = await pageTextFor(filename, pageFilter);
    const target = {
      figure_id: `p${String(pageFilter).padStart(4, "0")}_page`,
      page: pageFilter,
      bbox: [],
      title: "",
      caption: captionFromPageText(pageText.text, {}),
      kind: "page",
    };
    const record = semanticRecordFromInputs({
      filename,
      source,
      target,
      pageText: pageText.text,
      pageTextSource: pageText.source,
      ocrEvidence: { ocrBlocks: [], plainText: "", warnings: ["No figure index entry found for page; semantic record is page-text only."] },
      force,
    });
    records.push(record);
  }

  const keep = pageFilter
    ? (existing?.records || []).filter((record) => Number(record.page) !== pageFilter)
    : [];
  const artifact = await writeFigureSemanticIndex(filename, [...keep, ...records], source);
  return {
    ok: true,
    artifact: "figure_semantic",
    rebuilt: ["figure_semantic"],
    counts: { figure_semantic: records.length, semanticCount: artifact.semanticCount },
    path: safeFigureSemanticIndexPath(filename),
    page: pageFilter || null,
  };
}

export function figureSemanticSummary(record = {}) {
  return {
    schemaVersion: record.schemaVersion,
    filename: record.filename,
    figure_id: record.figure_id,
    page: record.page,
    bbox: record.bbox || [],
    figure_type: record.figure_type,
    confidence: record.confidence,
    source_artifacts: record.source_artifacts || {},
    entities: (record.entities || []).slice(0, 24),
    signals: record.signals || [],
    events: record.events || [],
    edges: record.edges || [],
    sequence_steps: record.sequence_steps || [],
    states: record.states || [],
    transitions: record.transitions || [],
    blocks: record.blocks || [],
    ports: record.ports || [],
    register_actions: record.register_actions || [],
    counter_actions: record.counter_actions || [],
    engineering_inferences: record.engineering_inferences || [],
    uncertainties: record.uncertainties || [],
    warnings: record.warnings || [],
  };
}
