import { appendEvidenceContract, atomicWriteJson, canonicalSymbol, clampBitfieldListTopK, clampInteger, clampTopK, escapeRegExp, evidenceFromChunk, getPdfSourceInfo, isSamePdfSource, makeEvidence, makeEvidenceContract, makeInference, makeNeedsVerification, normalizeForSearch, normalizeText, pathExists, readJsonCached, safeBitfieldsIndexPath, safeFigureOcrIndexPath } from "../core/runtime-helpers.js";
import { withVisualSemanticGuard } from "../core/visual-guard.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { BITFIELD_INDEX_SCHEMA_VERSION, DEFAULT_HYBRID_TOP_K, DEFAULT_PAGE_RANGE, DEFAULT_TOP_K, HYBRID_BM25_B, HYBRID_BM25_K1, HYBRID_BM25_WEIGHT, HYBRID_CANDIDATE_LIMIT, HYBRID_MIN_SCORE, HYBRID_PROXIMITY_WEIGHT, HYBRID_PROXIMITY_WINDOW, INDEX_DIR, MAX_BITFIELD_TABLE_ROWS, MAX_HYBRID_TOP_K, MAX_PREVIEW_CHARS, MAX_TOP_K, SERVER_VERSION } from "../core/runtime-constants.js";
import fs from "node:fs/promises";
import { isLikelyBitfieldName, parseBitfieldSemantics, resolveBitfieldRegisterMapping } from "../bitfields/semantics.js";
import { buildBitfieldConflicts, findBitfieldOverlaps, findRegisterEntry, validateBitfieldEntry } from "../bitfields/validation.js";


const buildSearchText = createRuntimePort("buildSearchText");

const cautionMatchesFilter = createRuntimePort("cautionMatchesFilter");
const chunkTypeAdjustmentForHybrid = createRuntimePort("chunkTypeAdjustmentForHybrid");


const getRegistersIndex = createRuntimePort("getRegistersIndex");
const getSectionsIndex = createRuntimePort("getSectionsIndex");

const lineContainsBitfield = createRuntimePort("lineContainsBitfield");
const loadCautionsIndex = createRuntimePort("loadCautionsIndex");
const loadPdfIndex = createRuntimePort("loadPdfIndex");
const loadSequencesIndex = createRuntimePort("loadSequencesIndex");
const looksLikeRegisterSymbol = createRuntimePort("looksLikeRegisterSymbol");


const normalizeRegisterName = createRuntimePort("normalizeRegisterName");


const q = createRuntimePort("q");


const scoreSequenceEntry = createRuntimePort("scoreSequenceEntry");
const scoreSimpleText = createRuntimePort("scoreSimpleText");
const searchRegistersIndex = createRuntimePort("searchRegistersIndex");


// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------

export function tokenizeQuery(query) {
  const raw = String(query || "").trim();
  const normalized = normalizeForSearch(raw);
  const canonical = canonicalSymbol(raw);

  const terms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);

  const symbolTerms = raw
    .split(/[\s,;:/()\[\]{}]+/)
    .map(canonicalSymbol)
    .filter((term) => term.length >= 2);

  return {
    raw,
    normalized,
    canonical,
    terms: [...new Set(terms)],
    symbolTerms: [...new Set(symbolTerms)],
  };
}

export function countWordOccurrences(text, term) {
  if (!term) return 0;
  const escaped = escapeRegExp(term);
  return (text.match(new RegExp(`\\b${escaped}\\b`, "g")) || []).length;
}

export function countLooseOccurrences(text, term) {
  if (!term) return 0;
  return text.split(term).length - 1;
}

export function scoreChunk(chunk, query) {
  const q = tokenizeQuery(query);
  if (!q.normalized && !q.canonical) return 0;

  const rawText = buildSearchText(chunk);
  const text = chunk.searchText || normalizeForSearch(rawText);
  const symbols = new Set((chunk.symbols || []).map(canonicalSymbol));
  const headingText = normalizeForSearch((chunk.headings || []).join("\n"));
  const registerText = normalizeForSearch((chunk.registers || []).join("\n"));
  const bitFieldText = normalizeForSearch((chunk.bitFields || []).join("\n"));

  let score = 0;

  if (q.normalized) {
    if (text.includes(q.normalized)) score += 70;
    if (headingText.includes(q.normalized)) score += 45;
    if (registerText.includes(q.normalized)) score += 90;
    if (bitFieldText.includes(q.normalized)) score += 60;
  }

  if (q.canonical) {
    if (symbols.has(q.canonical)) score += 120;

    for (const symbol of symbols) {
      if (symbol.includes(q.canonical) || q.canonical.includes(symbol)) score += 25;
    }
  }

  for (const symbolTerm of q.symbolTerms) {
    if (symbols.has(symbolTerm)) score += 60;
  }

  for (const term of q.terms) {
    const exactCount = countWordOccurrences(text, term);
    const looseCount = countLooseOccurrences(text, term);

    score += exactCount * 10;
    score += looseCount * 2;

    if (headingText.includes(term)) score += 12;
    if (registerText.includes(term)) score += 20;
    if (bitFieldText.includes(term)) score += 14;
  }

  // Prefer register-description style chunks in hardware manuals.
  if (/\bAddress\s*:?\b/i.test(rawText)) score += 8;
  if (/\bOffset\s*:?\b/i.test(rawText)) score += 5;
  if (/\bAccess\s+Size\s*:?\b/i.test(rawText)) score += 8;
  if (/\bInitial\s+Value\s*:?\b/i.test(rawText)) score += 8;
  if (/\bBit\s+Name\b/i.test(rawText)) score += 10;
  if (/\bDescription\b/i.test(rawText)) score += 3;

  return score;
}

export function isFigureOcrQuery(query, intents = []) {
  const text = normalizeForSearch(query);
  const intentSet = new Set((intents || []).map((intent) => String(intent || "").toLowerCase()));
  if (intentSet.has("figure") || intentSet.has("diagram")) return true;
  return /\b(figure|fig|diagram|block diagram|flow|sequence|clock tree|timing|waveform|image|ocr)\b/i.test(text);
}

export async function loadFigureOcrForSearch(filename) {
  const filePath = safeFigureOcrIndexPath(filename);
  if (!(await pathExists(filePath))) return null;
  try {
    const data = await readJsonCached(filePath);
    if (data.schemaVersion !== 1) return null;
    if (data.filename !== filename) return null;
    if (!Array.isArray(data.figures)) return null;
    const source = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(data.source, source)) return null;
    return data;
  } catch {
    return null;
  }
}

export function scoreFigureOcrEntry(entry, query, { boost = false } = {}) {
  const text = [
    entry.ocrText || entry.ocr_text || "",
    entry.caption || "",
    entry.figureUid || entry.figure_uid || "",
    "figure diagram image OCR",
  ].join("\n");
  const base = scoreSimpleText(text, query);
  if (base <= 0) return 0;
  const confidence = Number(entry.confidenceAvg ?? entry.confidence_avg ?? 0);
  const confidenceBonus = Number.isFinite(confidence) ? Math.round(confidence * 12) : 0;
  const penalty = boost ? 18 : 42;
  return Math.max(1, Math.round(base + confidenceBonus - penalty));
}

export async function searchFigureOcr(filename, query, topK = DEFAULT_TOP_K, options = {}) {
  const artifact = await loadFigureOcrForSearch(filename);
  if (!artifact) return [];
  const k = clampTopK(topK);
  const boost = Boolean(options.boost || isFigureOcrQuery(query, options.intents || []));
  return (artifact.figures || [])
    .map((entry) => {
      const figureUid = entry.figureUid || entry.figure_uid || entry.id || "";
      const text = String(entry.ocrText || entry.ocr_text || "").trim();
      return {
        id: `figure_ocr:${figureUid || entry.page || "unknown"}`,
        filename,
        page: Number(entry.page || 0),
        chunkIndex: "figure_ocr",
        chunkType: "figure_ocr",
        sourceType: "figure_ocr",
        source_type: "figure_ocr",
        figureUid,
        figure_uid: figureUid,
        caption: entry.caption || "",
        confidenceAvg: entry.confidenceAvg ?? entry.confidence_avg ?? null,
        score: scoreFigureOcrEntry(entry, query, { boost }),
        text,
        headings: entry.caption ? [entry.caption] : [],
        registers: [],
        bitFields: [],
        symbols: [],
        noiseScore: 0,
        contentScore: Math.min(100, Math.max(0, text.length ? 65 : 0)),
        renderPath: entry.renderPath || entry.render_path || "",
        hybridReasons: ["figure OCR supplemental evidence"],
        hybridEvidenceLines: text ? [normalizeText(text).slice(0, 240)] : [],
      };
    })
    .filter((entry) => entry.score > 0 && entry.text)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.page - b.page;
    })
    .slice(0, k);
}

export async function searchPdfIndex(filename, query, topK = DEFAULT_TOP_K) {
  const indexData = await loadPdfIndex(filename);
  const k = clampTopK(topK);

  const nativeResults = indexData.chunks
    .map((chunk) => ({
      ...chunk,
      score: scoreChunk(chunk, query),
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, k);
  const ocrResults = await searchFigureOcr(filename, query, k, { boost: isFigureOcrQuery(query) });
  const results = [...nativeResults, ...ocrResults]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return String(a.chunkIndex).localeCompare(String(b.chunkIndex));
    })
    .slice(0, k);

  return {
    indexData,
    results,
  };
}

export function clampHybridTopK(value) {
  return clampInteger(value, DEFAULT_HYBRID_TOP_K, 1, MAX_HYBRID_TOP_K);
}

export const HYBRID_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from",
  "how", "i", "if", "in", "into", "is", "it", "me", "of", "on", "or",
  "please", "the", "this", "to", "use", "using", "what", "when", "where",
  "which", "with", "write", "read", "get", "set", "find"
]);

export const HYBRID_SYNONYM_GROUPS = [
  ["start", "enable", "activate", "run", "kick", "trigger", "seten", "tstart", "issue", "pending"],
  ["stop", "disable", "halt", "terminate", "abort", "pause", "suspend", "clren", "clrrq"],
  ["clear", "ack", "acknowledge", "reset flag", "clear flag", "clear status", "w1c", "w0c", "write one", "write zero"],
  ["interrupt", "irq", "isr", "event", "interrupt request", "interrupt status"],
  ["error", "fault", "abnormal", "bus error", "err", "overflow", "underflow"],
  ["initialize", "initialise", "initialization", "initialisation", "init", "setup", "configure", "configuration", "setting"],
  ["reset", "software reset", "module reset", "swrst", "rst", "reset release"],
  ["status", "flag", "state", "condition", "result"],
  ["register", "reg", "abbreviation", "offset", "address", "initial value", "reset value", "access size"],
  ["bitfield", "bit field", "field", "bit", "mask", "shift", "bit name"],
  ["caution", "note", "restriction", "prohibited", "forbidden", "undefined", "invalid", "reserved", "do not", "must not"],
  ["transfer complete", "transfer end", "tc", "end", "completion", "done"],
  ["read modify write", "rmw", "preserve", "reserved bits", "write back", "mask"],
];

export const HYBRID_SYMBOL_ALIAS_GROUPS = [
  ["IRQ", "INT", "INTERRUPT"],
  ["ERR", "ER", "ERROR"],
  ["TC", "TRANSFERCOMPLETE", "TRANSFEREND", "END"],
  ["EN", "ENABLE", "SETEN", "START"],
  ["DIS", "DISABLE", "CLREN", "STOP"],
  ["SUS", "SUSPEND", "SUSPENDED"],
  ["RST", "RESET", "SWRST"],
  ["STAT", "STATUS", "SR"],
  ["CTRL", "CONTROL", "CR"],
  ["CFG", "CONFIG", "CONFIGURATION"],
];

export const HYBRID_SYNONYM_MAP = buildHybridSynonymMap(HYBRID_SYNONYM_GROUPS);
export const HYBRID_SYMBOL_ALIAS_MAP = buildHybridSymbolAliasMap(HYBRID_SYMBOL_ALIAS_GROUPS);

export function classifyHybridIntents(query, forcedIntent = "auto") {
  const normalized = normalizeForSearch(query);
  const canonical = canonicalSymbol(query);
  const intents = new Set();

  const forced = String(forcedIntent || "auto").trim().toLowerCase();
  if (forced && forced !== "auto") intents.add(forced);

  if (/\b(register|offset|address|initial value|reset value|access size|abbreviation)\b/i.test(normalized)) intents.add("register");
  if (/\b(bit|bits|bitfield|field|mask|bit name|r\/w|rw|write only|read only)\b/i.test(normalized)) intents.add("bitfield");
  if (/\b(sequence|procedure|flow|operation|step|steps|before|after|start|stop|enable|disable|init|initialize|configuration|configure|reset|clear|interrupt|irq|error)\b/i.test(normalized)) intents.add("sequence");
  if (/\b(caution|note|restriction|prohibited|forbidden|undefined|invalid|reserved|must|do not|only when|write 1|write one|write 0|write zero|w1c|w0c)\b/i.test(normalized)) intents.add("caution");
  if (/\b(section|chapter|paragraph|overview|description)\b/i.test(normalized)) intents.add("section");
  if (/\b(table|list of registers|register list|register map|column|row)\b/i.test(normalized)) intents.add("table");

  if (/\b(init|initial|initialize|initialization|setup|setting|configure|configuration)\b/i.test(normalized)) intents.add("init");
  if (/\b(start|enable|run|trigger|request|activate|resume|seten|tstart)\b/i.test(normalized) || /SETEN|TSTART/.test(canonical)) intents.add("start");
  if (/\b(stop|disable|halt|suspend|pause|cancel|terminate|abort|clren|clrrq)\b/i.test(normalized) || /CLREN|CLRRQ|SUSP/.test(canonical)) intents.add("stop");
  if (/\b(clear|ack|acknowledge|status|flag|complete|completion|done|end|w1c|w0c|write 1|write one|write 0|write zero)\b/i.test(normalized)) intents.add("clear");
  if (/\b(reset|software reset|swrst|module reset|rst)\b/i.test(normalized) || /SWRST|RESET/.test(canonical)) intents.add("reset");
  if (/\b(interrupt|irq|request|event|status)\b/i.test(normalized)) intents.add("irq");
  if (/\b(error|err|fault|bus error|overflow|underflow|abnormal)\b/i.test(normalized)) intents.add("error");

  if (!intents.size) intents.add("generic");
  return [...intents];
}

export function buildHybridIntentTerms(intents) {
  const terms = new Set();
  const add = (...values) => {
    for (const value of values) {
      const normalized = normalizeForSearch(value);
      if (!normalized) continue;
      for (const term of normalized.split(/\s+/)) {
        if (term.length > 1 && !HYBRID_STOP_WORDS.has(term)) terms.add(term);
      }
    }
  };

  for (const intent of intents) {
    if (intent === "register") add("register", "register name", "abbreviation", "offset", "address", "initial value", "reset value", "access size");
    if (intent === "bitfield") add("bit", "bit name", "bit field", "field", "mask", "description", "r w", "read only", "write only");
    if (intent === "sequence" || intent === "init") add("sequence", "procedure", "operation", "setting", "initial", "initialize", "configure", "configuration", "before", "after");
    if (intent === "start") add("start", "enable", "run", "trigger", "request", "activate", "resume", "seten", "tstart");
    if (intent === "stop") add("stop", "disable", "halt", "suspend", "pause", "terminate", "abort", "clren", "clrrq");
    if (intent === "clear") add("clear", "status", "flag", "acknowledge", "write 1", "write one", "write 0", "write zero", "w1c", "w0c", "end", "complete");
    if (intent === "reset") add("reset", "software reset", "module reset", "swrst", "rst");
    if (intent === "irq") add("interrupt", "irq", "event", "request", "status", "enable interrupt", "interrupt status");
    if (intent === "error") add("error", "fault", "bus error", "abnormal", "overflow", "underflow", "err");
    if (intent === "caution") add("caution", "note", "restriction", "prohibited", "forbidden", "undefined", "invalid", "reserved", "must", "do not", "only when");
    if (intent === "section") add("section", "chapter", "overview", "description", "operation", "register description");
    if (intent === "table") add("table", "row", "column", "register name", "abbreviation", "offset address", "access size", "bit name");
  }

  return [...terms];
}

export function buildHybridSynonymMap(groups) {
  const map = new Map();
  for (const group of groups || []) {
    const expanded = new Set();
    for (const phrase of group) {
      const normalizedPhrase = normalizeForSearch(phrase);
      if (normalizedPhrase) expanded.add(normalizedPhrase);
      for (const token of normalizedPhrase.split(/\s+/)) {
        if (token && !HYBRID_STOP_WORDS.has(token)) expanded.add(token);
      }
    }
    const values = [...expanded];
    for (const value of values) {
      if (!map.has(value)) map.set(value, new Set());
      for (const alias of values) if (alias !== value) map.get(value).add(alias);
    }
  }
  return map;
}

export function buildHybridSymbolAliasMap(groups) {
  const map = new Map();
  for (const group of groups || []) {
    const values = [...new Set(group.map(canonicalSymbol).filter(Boolean))];
    for (const value of values) {
      if (!map.has(value)) map.set(value, new Set());
      for (const alias of values) if (alias !== value) map.get(value).add(alias);
    }
  }
  return map;
}

export function expandHybridSynonyms(terms, limit = 120) {
  const expanded = new Set();
  for (const term of terms || []) {
    const normalized = normalizeForSearch(term);
    if (!normalized || HYBRID_STOP_WORDS.has(normalized)) continue;
    expanded.add(normalized);
    const aliases = HYBRID_SYNONYM_MAP.get(normalized);
    if (aliases) for (const alias of aliases) expanded.add(alias);
  }
  return [...expanded].slice(0, limit);
}

export function expandHybridSymbolAliases(symbolTerms, limit = 80) {
  const expanded = new Set();
  for (const symbol of symbolTerms || []) {
    const canonical = canonicalSymbol(symbol);
    if (!canonical) continue;
    expanded.add(canonical);
    const aliases = HYBRID_SYMBOL_ALIAS_MAP.get(canonical);
    if (aliases) for (const alias of aliases) expanded.add(alias);

    // Common hardware-manual convention: CHCTRL, CHSTAT, DST_END, etc.
    if (canonical.includes("INT")) expanded.add(canonical.replace(/INT/g, "IRQ"));
    if (canonical.includes("IRQ")) expanded.add(canonical.replace(/IRQ/g, "INT"));
    if (canonical.includes("CTRL")) expanded.add(canonical.replace(/CTRL/g, "CONTROL"));
    if (canonical.includes("STAT")) expanded.add(canonical.replace(/STAT/g, "STATUS"));
  }
  return [...expanded].slice(0, limit);
}

export function hybridTermWeight(term, hybrid) {
  if (!term) return 1;
  if ((hybrid.terms || []).includes(term)) return 2.4;
  if ((hybrid.importantTerms || []).includes(term)) return 2.0;
  if ((hybrid.intentTerms || []).includes(term)) return 1.15;
  return 0.9;
}

export function tokenizeHybridText(text) {
  return normalizeForSearch(text)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1 && !HYBRID_STOP_WORDS.has(term));
}

export function uniqueArray(values, limit = 200) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }

  return previous[b.length];
}

export function fuzzySimilarity(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right) return 0;
  if (left === right) return 1;
  const maxLength = Math.max(left.length, right.length);
  if (maxLength <= 2) return 0;
  return 1 - levenshteinDistance(left, right) / maxLength;
}

export function buildHybridQuery(query, options = {}) {
  const q = tokenizeQuery(query);
  const intents = classifyHybridIntents(query, options.intent || "auto");
  const intentTerms = buildHybridIntentTerms(intents);
  const queryTerms = q.terms.filter((term) => !HYBRID_STOP_WORDS.has(term));
  const synonymTerms = expandHybridSynonyms([...queryTerms, ...intentTerms], 140);
  const symbolAliasTerms = expandHybridSymbolAliases(q.symbolTerms, 80);
  const symbolAliasTextTerms = symbolAliasTerms.map((term) => normalizeForSearch(term)).filter(Boolean);
  const allTerms = uniqueArray([...queryTerms, ...intentTerms, ...synonymTerms, ...symbolAliasTextTerms], 140);
  const importantTerms = uniqueArray([...queryTerms, ...q.symbolTerms.map((term) => normalizeForSearch(term)).filter(Boolean), ...symbolAliasTextTerms], 90);

  return {
    raw: q.raw,
    normalized: q.normalized,
    canonical: q.canonical,
    terms: queryTerms,
    intentTerms,
    synonymTerms,
    allTerms,
    importantTerms,
    symbolTerms: q.symbolTerms,
    symbolAliasTerms,
    intents,
    register: String(options.register || "").trim(),
    registerCanonical: normalizeRegisterName(options.register || ""),
  };
}

export async function buildHybridContext(filename, hybrid) {
  const context = {
    registerMatches: [],
    sectionMatches: [],
    sequenceMatches: [],
    cautionMatches: [],
    relatedChunkIds: new Set(),
    relatedPages: new Set(),
    relatedRegisters: new Set(),
  };

  if (hybrid.register) {
    try {
      const { results } = await searchRegistersIndex(filename, hybrid.register, 6);
      context.registerMatches = results;
      for (const entry of results) {
        for (const page of entry.pages || []) context.relatedPages.add(page);
        for (const chunk of entry.chunks || []) {
          if (chunk.id) context.relatedChunkIds.add(chunk.id);
          if (chunk.page) context.relatedPages.add(chunk.page);
        }
        context.relatedRegisters.add(entry.name);
        for (const alias of entry.aliases || []) context.relatedRegisters.add(alias);
      }
    } catch {
      // Register index is optional for hybrid search.
    }
  }

  try {
    const { results } = await searchSectionsIndex(filename, hybrid.raw, 8);
    context.sectionMatches = results;
    for (const section of results.slice(0, 5)) {
      if (section.page) context.relatedPages.add(section.page);
    }
  } catch {
    // Section index is optional for hybrid search.
  }

  if (hybrid.intents.some((intent) => ["sequence", "init", "start", "stop", "clear", "reset", "irq", "error"].includes(intent))) {
    try {
      const sequencesIndex = await loadSequencesIndex(filename);
      if (!sequencesIndex) throw new Error("sequences index not available");
      context.sequenceMatches = (sequencesIndex.sequences || [])
        .map((sequence) => ({
          ...sequence,
          score: scoreSequenceEntry(sequence, hybrid.raw, hybrid.register),
        }))
        .filter((sequence) => sequence.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      for (const sequence of context.sequenceMatches) {
        for (const page of sequence.pages || []) context.relatedPages.add(page);
        for (const chunk of sequence.chunks || []) {
          if (chunk.id) context.relatedChunkIds.add(chunk.id);
          if (chunk.page) context.relatedPages.add(chunk.page);
        }
        for (const reg of sequence.relatedRegisters || []) context.relatedRegisters.add(reg);
      }
    } catch {
      // Sequence index is optional for hybrid search.
    }
  }

  if (hybrid.intents.some((intent) => ["caution", "clear", "reset", "irq", "error"].includes(intent))) {
    try {
      const cautionsIndex = await loadCautionsIndex(filename);
      if (!cautionsIndex) throw new Error("cautions index not available");
      context.cautionMatches = (cautionsIndex.cautions || [])
        .filter((caution) => cautionMatchesFilter(caution, hybrid.raw, hybrid.register, ""))
        .map((caution) => ({
          ...caution,
          score: scoreSimpleText([
            caution.topic,
            caution.type,
            caution.riskForDriver,
            ...(caution.evidenceLines || []),
            ...(caution.relatedRegisters || []),
          ].join("\n"), hybrid.raw),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      for (const caution of context.cautionMatches) {
        for (const page of caution.pages || []) context.relatedPages.add(page);
        for (const chunk of caution.chunks || []) {
          if (chunk.id) context.relatedChunkIds.add(chunk.id);
          if (chunk.page) context.relatedPages.add(chunk.page);
        }
        for (const reg of caution.relatedRegisters || []) context.relatedRegisters.add(reg);
      }
    } catch {
      // Caution index is optional for hybrid search.
    }
  }

  return context;
}

export function extractHybridEvidenceLines(text, hybrid, maxLines = 6) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => normalizeText(line))
    .filter((line) => line.length >= 3);

  const evidence = [];
  const terms = uniqueArray([...hybrid.importantTerms, ...hybrid.allTerms], 40);

  for (const line of lines) {
    const normalized = normalizeForSearch(line);
    if (!normalized) continue;

    let score = 0;
    if (hybrid.normalized && normalized.includes(hybrid.normalized)) score += 80;
    for (const term of terms) {
      if (normalized.includes(term)) score += hybrid.importantTerms.includes(term) ? 14 : 6;
    }
    if (hybrid.registerCanonical && canonicalSymbol(line).includes(hybrid.registerCanonical)) score += 40;
    if (score <= 0) continue;

    evidence.push({ line, score });
  }

  return evidence
    .sort((a, b) => b.score - a.score)
    .map((item) => item.line)
    .filter((line, index, arr) => arr.indexOf(line) === index)
    .slice(0, maxLines);
}

export function buildHybridCorpusStats(chunks, hybrid) {
  const terms = uniqueArray([...(hybrid.allTerms || []), ...(hybrid.importantTerms || [])], 160);
  const documents = [];
  const documentFrequency = new Map();
  let totalLength = 0;

  for (const chunk of chunks || []) {
    const tokens = tokenizeHybridText(buildSearchText(chunk));
    const tokenCounts = new Map();
    for (const token of tokens) tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    totalLength += tokens.length;
    documents.push({ id: chunk.id, length: tokens.length || 1, tokenCounts });

    for (const term of terms) {
      if (tokenCounts.has(term)) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  return {
    documentCount: Math.max(1, documents.length),
    averageLength: documents.length ? Math.max(1, totalLength / documents.length) : 1,
    terms,
    documentFrequency,
    documents: new Map(documents.map((doc) => [doc.id, doc])),
  };
}

export function scoreHybridBm25(chunk, hybrid, stats) {
  if (!stats || !stats.documents) return { score: 0, hits: 0 };
  const doc = stats.documents.get(chunk.id);
  if (!doc) return { score: 0, hits: 0 };

  let score = 0;
  let hits = 0;
  const N = stats.documentCount;
  const avgdl = stats.averageLength;
  const dl = doc.length || 1;

  for (const term of stats.terms || []) {
    const tf = doc.tokenCounts.get(term) || 0;
    if (!tf) continue;
    const df = stats.documentFrequency.get(term) || 0;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const numerator = tf * (HYBRID_BM25_K1 + 1);
    const denominator = tf + HYBRID_BM25_K1 * (1 - HYBRID_BM25_B + HYBRID_BM25_B * dl / avgdl);
    score += idf * (numerator / denominator) * hybridTermWeight(term, hybrid);
    hits++;
  }

  return {
    score: Math.round(score * HYBRID_BM25_WEIGHT),
    hits,
  };
}

export function tokenPositions(tokens, terms) {
  const wanted = new Set(terms || []);
  const positions = new Map();
  tokens.forEach((token, index) => {
    if (!wanted.has(token)) return;
    if (!positions.has(token)) positions.set(token, []);
    positions.get(token).push(index);
  });
  return positions;
}

export function scoreHybridProximity(rawText, hybrid) {
  const queryTerms = uniqueArray((hybrid.importantTerms || []).filter((term) => term.length > 1), 24);
  if (queryTerms.length < 2) return { score: 0, pairs: 0 };

  const tokens = tokenizeHybridText(rawText);
  const positions = tokenPositions(tokens, queryTerms);
  const presentTerms = queryTerms.filter((term) => positions.has(term));
  if (presentTerms.length < 2) return { score: 0, pairs: 0 };

  let bestDistance = Number.POSITIVE_INFINITY;
  let pairCount = 0;
  for (let i = 0; i < presentTerms.length; i++) {
    for (let j = i + 1; j < presentTerms.length; j++) {
      const left = positions.get(presentTerms[i]) || [];
      const right = positions.get(presentTerms[j]) || [];
      for (const a of left.slice(0, 12)) {
        for (const b of right.slice(0, 12)) {
          const distance = Math.abs(a - b);
          if (distance <= HYBRID_PROXIMITY_WINDOW) {
            pairCount++;
            if (distance < bestDistance) bestDistance = distance;
          }
        }
      }
    }
  }

  if (!pairCount) return { score: 0, pairs: 0 };
  const closeness = Math.max(0, HYBRID_PROXIMITY_WINDOW - Math.min(bestDistance, HYBRID_PROXIMITY_WINDOW));
  return {
    score: Math.min(120, pairCount * 8 + closeness * HYBRID_PROXIMITY_WEIGHT / HYBRID_PROXIMITY_WINDOW),
    pairs: pairCount,
  };
}

export function scoreHybridSymbolAliases(chunk, hybrid) {
  const chunkSymbols = new Set((chunk.symbols || []).map(canonicalSymbol));
  const chunkCanonical = canonicalSymbol([
    ...(chunk.registers || []),
    ...(chunk.bitFields || []),
    ...(chunk.headings || []),
    chunk.text || "",
  ].join("\n"));

  let score = 0;
  let hits = 0;
  for (const alias of hybrid.symbolAliasTerms || []) {
    if (!alias) continue;
    if (chunkSymbols.has(alias) || chunkCanonical.includes(alias)) {
      score += 45;
      hits++;
    }
  }

  return { score: Math.min(score, 180), hits };
}

export function scoreHybridChunk(chunk, hybrid, context) {
  const rawText = buildSearchText(chunk);
  const text = chunk.searchText || normalizeForSearch(rawText);
  const textTokens = uniqueArray(tokenizeHybridText(rawText), 500);
  const textTokenSet = new Set(textTokens);
  const symbols = new Set((chunk.symbols || []).map(canonicalSymbol));
  const registerText = normalizeForSearch((chunk.registers || []).join(" "));
  const bitFieldText = normalizeForSearch((chunk.bitFields || []).join(" "));
  const headingText = normalizeForSearch((chunk.headings || []).join(" "));
  const rawLower = String(chunk.text || "").toLowerCase();

  let score = scoreChunk(chunk, hybrid.raw);
  const reasons = [];

  const chunkTypeAdjustment = chunkTypeAdjustmentForHybrid(chunk, hybrid);
  if (chunkTypeAdjustment.score) score += chunkTypeAdjustment.score;
  for (const reason of chunkTypeAdjustment.reasons) reasons.push(reason);

  const bm25 = scoreHybridBm25(chunk, hybrid, context.bm25Stats);
  if (bm25.score > 0) {
    score += bm25.score;
    reasons.push(`bm25 ${bm25.score}/${bm25.hits}`);
  }

  const proximity = scoreHybridProximity(rawText, hybrid);
  if (proximity.score > 0) {
    score += proximity.score;
    reasons.push(`proximity ${Math.round(proximity.score)}/${proximity.pairs}`);
  }

  const aliasScore = scoreHybridSymbolAliases(chunk, hybrid);
  if (aliasScore.score > 0) {
    score += aliasScore.score;
    reasons.push(`symbol aliases ${aliasScore.hits}`);
  }

  if (hybrid.normalized && text.includes(hybrid.normalized)) {
    score += 130;
    reasons.push("exact phrase");
  }

  if (hybrid.canonical && symbols.has(hybrid.canonical)) {
    score += 160;
    reasons.push("exact symbol");
  }

  let importantHits = 0;
  for (const term of hybrid.importantTerms) {
    if (!term) continue;
    if (textTokenSet.has(term) || text.includes(term)) importantHits++;
  }

  const coverage = hybrid.importantTerms.length ? importantHits / hybrid.importantTerms.length : 0;
  if (coverage > 0) {
    score += Math.round(coverage * 120);
    reasons.push(`query coverage ${Math.round(coverage * 100)}%`);
  }

  let intentHits = 0;
  for (const term of hybrid.allTerms) {
    if (!term) continue;
    if (textTokenSet.has(term)) {
      intentHits++;
      score += 4;
    } else if (text.includes(term)) {
      intentHits++;
      score += 2;
    }
  }
  if (intentHits) reasons.push(`expanded terms ${intentHits}`);

  let fuzzyHits = 0;
  const fuzzyTerms = hybrid.importantTerms.filter((term) => term.length >= 4).slice(0, 12);
  for (const term of fuzzyTerms) {
    if (textTokenSet.has(term)) continue;
    if (textTokens.some((candidate) => Math.abs(candidate.length - term.length) <= 2 && fuzzySimilarity(term, candidate) >= 0.86)) {
      fuzzyHits++;
      score += 12;
    }
  }
  if (fuzzyHits) reasons.push(`fuzzy terms ${fuzzyHits}`);

  if (hybrid.registerCanonical) {
    const chunkCanonicalText = canonicalSymbol([
      chunk.text || "",
      ...(chunk.registers || []),
      ...(chunk.headings || []),
      ...(chunk.bitFields || []),
    ].join("\n"));

    if (chunkCanonicalText.includes(hybrid.registerCanonical)) {
      score += 170;
      reasons.push("register context");
    }
  }

  if (context.relatedChunkIds.has(chunk.id)) {
    score += 180;
    reasons.push("persistent-index related chunk");
  }

  if (context.relatedPages.has(chunk.page)) {
    score += 45;
    reasons.push("persistent-index related page");
  }

  for (const reg of context.relatedRegisters) {
    const canonicalReg = normalizeRegisterName(reg);
    if (canonicalReg && symbols.has(canonicalReg)) {
      score += 30;
      reasons.push("related register symbol");
      break;
    }
  }

  if (hybrid.intents.includes("register")) {
    if (/\b(Register Name|Abbreviation|Offset Address|Address|Initial Value|Access Size)\b/i.test(rawText)) {
      score += 70;
      reasons.push("register-table language");
    }
  }

  if (hybrid.intents.includes("bitfield")) {
    if (/\b(Bit Name|Bit|Description|R\/W|Initial Value|Access)\b/i.test(rawText)) {
      score += 70;
      reasons.push("bitfield-table language");
    }
  }

  if (hybrid.intents.some((intent) => ["sequence", "init", "start", "stop", "clear", "reset", "irq", "error"].includes(intent))) {
    if (/\b(sequence|procedure|operation|setting|start|stop|enable|disable|clear|reset|interrupt|status|request|error)\b/i.test(rawText)) {
      score += 60;
      reasons.push("operation-flow language");
    }
    if (/\b(before|after|when|must|should|first|then|following|steps?)\b/i.test(rawText)) {
      score += 35;
      reasons.push("ordering language");
    }
  }

  if (hybrid.intents.includes("caution")) {
    if (/\b(Caution|Note|Restriction|Prohibited|Forbidden|Undefined|Invalid|Reserved|must|do not|only when)\b/i.test(rawText)) {
      score += 90;
      reasons.push("caution language");
    }
    if (/write\s+(?:1|one|0|zero)|write-?1|write-?0|W1C|W0C/i.test(rawText)) {
      score += 55;
      reasons.push("clear/write semantics");
    }
  }

  if (hybrid.intents.includes("section") && headingText) {
    score += 25;
    reasons.push("heading match candidate");
  }

  if (hybrid.intents.includes("table")) {
    const tableSignals = (rawText.match(/\b(Register Name|Abbreviation|Offset|Bit Name|Access Size|Initial Value|Description)\b/gi) || []).length;
    if (tableSignals) {
      score += Math.min(tableSignals * 16, 90);
      reasons.push("table signals");
    }
  }

  // Very short chunks with many keyword hits are usually headings/tables and can be useful,
  // but empty/noisy chunks should not dominate.
  if (String(chunk.text || "").length < 80) score -= 25;
  if (/\b(Revision|Contents|Index)\b/i.test(rawText) && !hybrid.intents.includes("section")) score -= 20;

  const evidenceLines = extractHybridEvidenceLines(chunk.text || "", hybrid, 6);
  if (evidenceLines.length) {
    score += Math.min(evidenceLines.length * 10, 40);
    reasons.push("evidence lines");
  }

  return {
    score: Math.round(score),
    reasons: uniqueArray(reasons, 12),
    evidenceLines,
  };
}

export async function hybridSearchPdf(filename, query, options = {}) {
  const indexData = await loadPdfIndex(filename);
  const topK = clampHybridTopK(options.topK);
  const hybrid = buildHybridQuery(query, {
    intent: options.intent || "auto",
    register: options.register || "",
  });

  const context = await buildHybridContext(filename, hybrid);
  context.pageCount = indexData.pageCount;
  const candidateChunks = await selectHybridCandidateChunks(filename, indexData, hybrid, context, topK);
  context.candidateCount = candidateChunks.length;
  context.fullChunkCount = (indexData.chunks || []).length;
  context.bm25Stats = buildHybridCorpusStats(candidateChunks, hybrid);

  const nativeResults = candidateChunks
    .map((chunk) => {
      const scored = scoreHybridChunk(chunk, hybrid, context);
      return {
        ...chunk,
        score: scored.score,
        hybridReasons: scored.reasons,
        hybridEvidenceLines: scored.evidenceLines,
      };
    })
    .filter((chunk) => chunk.score >= HYBRID_MIN_SCORE)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, topK);
  const ocrResults = await searchFigureOcr(filename, query, topK, { boost: isFigureOcrQuery(query, hybrid.intents), intents: hybrid.intents });
  const results = [...nativeResults, ...ocrResults]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return String(a.chunkIndex).localeCompare(String(b.chunkIndex));
    })
    .slice(0, topK);

  return {
    filename,
    query,
    intent: hybrid.intents,
    register: hybrid.register,
    expandedTerms: hybrid.allTerms,
    context,
    results,
  };
}

export async function selectHybridCandidateChunks(filename, indexData, hybrid, context, topK) {
  const chunks = indexData.chunks || [];
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const candidates = new Map();
  const add = (chunk) => {
    if (!chunk?.id || candidates.has(chunk.id)) return;
    if (chunk.sourceType === "figure_ocr" || chunk.source_type === "figure_ocr") return;
    candidates.set(chunk.id, chunk);
  };

  try {
    const searchTopK = Math.min(MAX_TOP_K, Math.max(topK * 24, 80));
    const { results } = await searchPdfIndex(filename, hybrid.raw, searchTopK);
    for (const chunk of results) add(chunk);
  } catch {
    // Full fallback below keeps hybrid search usable if lexical search is unavailable.
  }

  for (const id of context.relatedChunkIds || []) add(byId.get(id));
  if (context.relatedPages?.size) {
    for (const chunk of chunks) {
      if (context.relatedPages.has(Number(chunk.page))) add(chunk);
      if (candidates.size >= HYBRID_CANDIDATE_LIMIT) break;
    }
  }

  if (candidates.size < Math.max(topK * 4, 24)) {
    for (const chunk of chunks) {
      const raw = buildSearchText(chunk);
      const text = chunk.searchText || normalizeForSearch(raw);
      const canonical = canonicalSymbol(raw);
      const termHit = (hybrid.importantTerms || []).some((term) => term && text.includes(term));
      const symbolHit = (hybrid.symbolTerms || []).some((term) => term && canonical.includes(term));
      if (termHit || symbolHit) add(chunk);
      if (candidates.size >= HYBRID_CANDIDATE_LIMIT) break;
    }
  }

  const selected = [...candidates.values()].slice(0, HYBRID_CANDIDATE_LIMIT);
  return selected.length ? selected : chunks;
}


export function buildHybridSearchEvidenceContract(payload) {
  const evidence = [];
  const inference = [];
  const needsVerification = [];
  for (const result of (payload.results || []).slice(0, 10)) {
    const quote = (result.hybridEvidenceLines || [])[0] || result.text || "";
    if (result.sourceType === "figure_ocr" || result.source_type === "figure_ocr") {
      evidence.push(makeEvidence({
        page: result.page,
        chunkId: result.figureUid || result.id,
        section: result.caption || "figure OCR",
        quote,
        confidence: "low",
        source: "figure_ocr",
        tool: "hybrid_search_pdf",
        artifact: safeFigureOcrIndexPath(payload.filename),
      }));
      inference.push(makeInference({
        statement: `Figure OCR ${result.figureUid || result.id} is a supplemental match for the query.`,
        basis: quote,
        confidence: "low",
        risk: "OCR text is supplemental and may misread diagram labels; verify against the rendered figure and native manual context.",
      }));
    } else {
      evidence.push(evidenceFromChunk(result, quote, { tool: "hybrid_search_pdf", confidence: result.score || "medium", name: (result.registers || [])[0] || "" }));
      inference.push(makeInference({
        statement: `Chunk ${result.id} is relevant to query because: ${(result.hybridReasons || []).join(", ") || "hybrid score"}`,
        basis: quote,
        confidence: result.score || "medium",
        risk: "Hybrid search rank is not a hardware fact; verify exact register/bit/sequence details with specialized tools.",
      }));
    }
  }
  if ((payload.results || []).length) {
    needsVerification.push(makeNeedsVerification({
      item: "Exact register offsets / bit positions / clear semantics from hybrid results",
      reason: "hybrid_search_pdf ranks candidate chunks only; it does not prove exact table values.",
      suggestedTools: ["extract_register_table(...) or find_register(...) for offsets", "extract_bitfield_table(...) or find_bitfield(...) for bit fields", "get_sequence(...) for operation order", "get_cautions_for_register(...) for restrictions"],
    }));
    if ((payload.results || []).some((result) => result.sourceType === "figure_ocr" || result.source_type === "figure_ocr")) {
      needsVerification.push(makeNeedsVerification({
        item: "OCR-derived figure labels and diagram relationships",
        reason: "Figure OCR is supplemental only and can misread small labels or connector names.",
        suggestedTools: ["search_figures(...)", "get_figure_context_pack(...)", "read_pdf_pages(...) around the figure page"],
      }));
    }
  }
  const hasFigureOcrEvidence = (payload.results || []).some((result) => result.sourceType === "figure_ocr" || result.source_type === "figure_ocr");
  return makeEvidenceContract({
    tool: "hybrid_search_pdf",
    filename: payload.filename,
    query: payload.query,
    evidence,
    inference,
    needsVerification,
    warnings: [
      "Hybrid search is retrieval/ranking only; do not treat ranked chunks as final hardware facts.",
      hasFigureOcrEvidence ? "Figure OCR evidence is supplemental and must not replace native PDF text/table evidence." : "",
    ],
    recommendedNextTools: [
      `read_pdf_chunk(filename="${payload.filename}", chunk_id="<chunk-id>")`,
      hasFigureOcrEvidence ? `get_figure_context_pack(filename="${payload.filename}", figure_id="<figure-id>")` : "",
      hasFigureOcrEvidence ? `open the image_path returned by get_figure_context_pack visually` : "",
      `extract_bitfield_table(filename="${payload.filename}", register="<register>")`,
      `get_cautions_for_register(filename="${payload.filename}", register="<register>")`,
    ],
  });
}

export function formatHybridSearchResults(payload) {
  const { filename, query, intent, register, expandedTerms, context, results } = payload;

  const guardQuery = query;
  const header = [
    `Hybrid search results for "${query}"`,
    `File: ${filename}`,
    `Intent: ${intent.join(", ")}`,
    register ? `Register context: ${register}` : "Register context: none",
    `Expanded terms: ${expandedTerms.slice(0, 30).join(", ") || "none"}`,
    `Ranking: exact + BM25 + synonym + symbol-alias + proximity + fuzzy + chunkType/noise + persistent-index boosts`,
    `Index boosts: sections=${context.sectionMatches.length}, registers=${context.registerMatches.length}, sequences=${context.sequenceMatches.length}, cautions=${context.cautionMatches.length}`,
    `Candidate chunks scored: ${context.candidateCount || results.length}/${context.fullChunkCount || context.pageCount || "unknown"}`,
  ];

  if (!results.length) {
    const text = [
      ...header,
      "",
      "No hybrid results found.",
      "Suggested next steps:",
      "- Try a shorter query.",
      "- Pass register=... if the question is about a specific register.",
      "- Use search_pdf for exact register/bit names.",
      "- Use find_sequence/find_caution for very specific operation or restriction queries.",
    ].join("\n");
    return withVisualSemanticGuard(appendEvidenceContract(text, buildHybridSearchEvidenceContract(payload)), guardQuery, { query: guardQuery, filename, mode: "search" });
  }

  const resultLines = results.map((result, index) => {
    const preview = normalizeText(result.text || "").slice(0, MAX_PREVIEW_CHARS);
    const evidence = (result.hybridEvidenceLines || [])
      .slice(0, 5)
      .map((line) => `   - ${line}`)
      .join("\n") || "   - none";
    if (result.sourceType === "figure_ocr" || result.source_type === "figure_ocr") {
      return [
        `Result ${index + 1}`,
        `ID: ${result.id}`,
        `File: ${result.filename}`,
        `Page: ${result.page}`,
        `Source type: figure_ocr (supplemental OCR evidence)`,
        `Figure UID: ${result.figureUid || result.figure_uid || "unknown"}`,
        `Caption: ${result.caption || "none"}`,
        `Hybrid score: ${result.score}`,
        `OCR confidence avg: ${result.confidenceAvg ?? "n/a"}`,
        `Reasons: ${(result.hybridReasons || []).join(", ") || "figure OCR match"}`,
        "Evidence lines:",
        evidence,
        `Suggested figure context: get_figure_context_pack(filename="${result.filename}", figure_id="${result.figureUid || result.figure_uid || result.id}")`,
        `Suggested page read: read_pdf_pages(filename="${result.filename}", start_page=${result.page}, end_page=${Math.min(result.page + DEFAULT_PAGE_RANGE - 1, payload.context?.pageCount || result.page + DEFAULT_PAGE_RANGE - 1)})`,
        "Verification: OCR-derived; verify labels against the rendered figure/manual page before using as driver fact.",
        "Preview:",
        `${preview}${(result.text || "").length > MAX_PREVIEW_CHARS ? "..." : ""}`,
      ].join("\n");
    }

    return [
      `Result ${index + 1}`,
      `ID: ${result.id}`,
      `File: ${result.filename}`,
      `Page: ${result.page}`,
      `Chunk: ${result.chunkIndex}`,
      `Hybrid score: ${result.score}`,
      `Chunk type: ${result.chunkType || "unknown"}; noise=${result.noiseScore ?? "n/a"}; content=${result.contentScore ?? "n/a"}`,
      `Reasons: ${(result.hybridReasons || []).join(", ") || "none"}`,
      `Headings: ${result.headings && result.headings.length ? result.headings.join(" | ") : "none"}`,
      `Registers: ${result.registers && result.registers.length ? result.registers.join(", ") : "none"}`,
      `Bit fields / symbols: ${result.bitFields && result.bitFields.length ? result.bitFields.slice(0, 30).join(", ") : "none"}`,
      "Evidence lines:",
      evidence,
      `Suggested chunk read: read_pdf_chunk(filename="${result.filename}", chunk_id="${result.id}")`,
      `Suggested page read: read_pdf_pages(filename="${result.filename}", start_page=${result.page}, end_page=${Math.min(result.page + DEFAULT_PAGE_RANGE - 1, payload.context?.pageCount || result.page + DEFAULT_PAGE_RANGE - 1)})`,
      "Preview:",
      `${preview}${(result.text || "").length > MAX_PREVIEW_CHARS ? "..." : ""}`,
    ].join("\n");
  });

  const contextLines = [];
  if (context.sectionMatches.length) {
    contextLines.push("Section hints:");
    for (const section of context.sectionMatches.slice(0, 5)) {
      contextLines.push(`- ${section.title} (page ${section.page}, score ${section.score})`);
    }
  }
  if (context.sequenceMatches.length) {
    contextLines.push("Sequence hints:");
    for (const sequence of context.sequenceMatches.slice(0, 5)) {
      contextLines.push(`- ${sequence.topic} [${sequence.kind || "generic"}] pages ${(sequence.pages || []).join(", ") || "unknown"}`);
    }
  }
  if (context.cautionMatches.length) {
    contextLines.push("Caution hints:");
    for (const caution of context.cautionMatches.slice(0, 5)) {
      contextLines.push(`- ${caution.topic} [${caution.type || "general"}] pages ${(caution.pages || []).join(", ") || "unknown"}`);
    }
  }

  const text = [
    ...header,
    "",
    ...resultLines,
    contextLines.length ? "\n---\n\nPersistent-index hints\n" + contextLines.join("\n") : "",
  ].filter(Boolean).join("\n\n---\n\n");
  return withVisualSemanticGuard(appendEvidenceContract(text, buildHybridSearchEvidenceContract(payload)), guardQuery, { query: guardQuery, filename, mode: "search" });
}

export function scoreSection(section, query) {
  const q = tokenizeQuery(query);
  if (!q.normalized && !q.canonical) return 0;

  const title = section.searchText || normalizeForSearch(section.title);
  const canonicalTitle = section.canonicalTitle || canonicalSymbol(section.title);
  let score = 0;

  if (q.normalized) {
    if (title === q.normalized) score += 140;
    if (title.includes(q.normalized)) score += 95;
  }

  if (q.canonical && canonicalTitle.includes(q.canonical)) {
    score += 55;
  }

  for (const term of q.terms) {
    if (countWordOccurrences(title, term)) score += 18;
    if (title.includes(term)) score += 8;
  }

  for (const symbolTerm of q.symbolTerms) {
    if (canonicalTitle.includes(symbolTerm)) score += 18;
  }

  if (section.type === "numbered") score += 12;
  if (section.type === "appendix") score += 8;
  if (/\b(Register|Description|Operation|Interrupt|Clock|Reset|Caution|Note|Restriction)\b/i.test(section.title)) {
    score += 10;
  }

  return score;
}

export async function searchSectionsIndex(filename, query, topK = DEFAULT_TOP_K) {
  const sectionsIndex = await getSectionsIndex(filename);
  const k = clampTopK(topK);

  const results = sectionsIndex.sections
    .map((section) => ({
      ...section,
      pageCount: sectionsIndex.pageCount,
      score: scoreSection(section, query),
    }))
    .filter((section) => section.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.level - b.level;
    })
    .slice(0, k);

  return {
    sectionsIndex,
    results,
  };
}

export function formatSectionResults(results, query) {
  if (!results.length) {
    return `No section-index results found for "${query}".`;
  }

  return [
    `Section index results for "${query}"`,
    "",
    ...results.map((section, index) =>
      [
        `Result ${index + 1}`,
        `ID: ${section.id}`,
        `File: ${section.filename}`,
        `Title: ${section.title}`,
        `Page: ${section.page}`,
        `Level: ${section.level}`,
        `Type: ${section.type}`,
        `Confidence: ${section.confidence}`,
        `Score: ${section.score}`,
        `Suggested read: read_pdf_pages(filename="${section.filename}", start_page=${section.page}, end_page=${Math.min(section.page + DEFAULT_PAGE_RANGE - 1, section.pageCount || section.page + DEFAULT_PAGE_RANGE - 1)})`,
      ].join("\n")
    ),
  ].join("\n\n---\n\n");
}

export function formatSearchResults(results, query) {
  if (!results.length) {
    return withVisualSemanticGuard([
      `No results found for "${query}".`,
      "",
      "Suggested next steps:",
      "- Check the exact PDF filename with list_pdfs.",
      "- Run index_pdf with force=true if the PDF changed.",
      "- Try a shorter query, register abbreviation, bit name, or section title.",
    ].join("\n"), query, { query, mode: "search" });
  }

  return withVisualSemanticGuard(results
    .map((result, index) => {
      const text = String(result.text || "");
      const preview = normalizeText(text).slice(0, MAX_PREVIEW_CHARS);
      const truncated = text.length > MAX_PREVIEW_CHARS ? "..." : "";

      if (result.sourceType === "figure_ocr" || result.source_type === "figure_ocr") {
        return [
          `Result ${index + 1}`,
          `ID: ${result.id}`,
          `File: ${result.filename}`,
          `Page: ${result.page}`,
          `Source type: figure_ocr (supplemental OCR evidence)`,
          `Figure UID: ${result.figureUid || result.figure_uid || "unknown"}`,
          `Caption: ${result.caption || "none"}`,
          `Score: ${result.score}`,
          `OCR confidence avg: ${result.confidenceAvg ?? "n/a"}`,
          `Suggested page verification: read_pdf_pages(filename="${result.filename}", start_page=${result.page}, end_page=${result.page})`,
          "Verification: OCR-derived; verify against the figure/manual before using as a driver fact.",
          "Preview:",
          `${preview}${truncated}`,
        ].join("\n");
      }

      return [
        `Result ${index + 1}`,
        `ID: ${result.id}`,
        `File: ${result.filename}`,
        `Page: ${result.page}`,
        `Chunk: ${result.chunkIndex}`,
        `Score: ${result.score}`,
        `Chunk type: ${result.chunkType || "unknown"}; noise=${result.noiseScore ?? "n/a"}; content=${result.contentScore ?? "n/a"}`,
        `Headings: ${
          result.headings && result.headings.length
            ? result.headings.join(" | ")
            : "none"
        }`,
        `Registers: ${
          result.registers && result.registers.length
            ? result.registers.join(", ")
            : "none"
        }`,
        `Bit fields / symbols: ${
          result.bitFields && result.bitFields.length
            ? result.bitFields.slice(0, 30).join(", ")
            : "none"
        }`,
        "Preview:",
        `${preview}${truncated}`,
      ].join("\n");
    })
    .join("\n\n---\n\n"), query, { query, mode: "search" });
}

export function buildRegisterQueries(register) {
  const raw = String(register || "").trim();
  const upper = raw.toUpperCase();
  const queries = new Set();

  if (!raw) return [];

  queries.add(raw);
  queries.add(upper);

  const withoutCommonPrefix = raw
    .replace(/^[A-Z0-9]+m_/i, "")
    .replace(/^(GBETH|ETH|GMAC|WDT|GPT|POEG|ICU)_/i, "");

  if (withoutCommonPrefix && withoutCommonPrefix !== raw) {
    queries.add(withoutCommonPrefix);
  }

  const commonPrefixes = ["GBETHm_", "ETH_", "GMAC_", "WDT_", "GPT_", "POEG_", "ICU_"];
  for (const prefix of commonPrefixes) {
    if (!upper.startsWith(prefix.toUpperCase())) {
      queries.add(`${prefix}${withoutCommonPrefix || raw}`);
    }
  }

  queries.add(`${raw} Register`);
  queries.add(`${raw} register description`);
  queries.add(`${raw} Address`);
  queries.add(`${raw} Offset`);
  queries.add(`${raw} Initial Value`);
  queries.add(`${raw} Bit Name`);
  queries.add(`${raw} bits`);

  return [...queries].filter(Boolean);
}

export function normalizeBitFieldName(bitfield) {
  return canonicalSymbol(bitfield);
}

export function buildBitFieldQueries(bitfield, register = "") {
  const rawBitfield = String(bitfield || "").trim();
  const rawRegister = String(register || "").trim();
  const queries = new Set();

  if (!rawBitfield) return [];

  queries.add(rawBitfield);
  queries.add(rawBitfield.toUpperCase());
  queries.add(`${rawBitfield} Bit Name`);
  queries.add(`${rawBitfield} bit field`);
  queries.add(`${rawBitfield} Description`);
  queries.add(`${rawBitfield} Initial Value`);

  if (rawRegister) {
    queries.add(`${rawRegister} ${rawBitfield}`);
    queries.add(`${rawRegister} ${rawBitfield} Bit Name`);
    queries.add(`${rawRegister} ${rawBitfield} Description`);
  }

  return [...queries].filter(Boolean);
}

export function collectRegisterContext(registerResults) {
  const chunkIds = new Set();
  const pages = new Set();
  const names = new Set();

  for (const entry of registerResults || []) {
    for (const name of [entry.name, entry.displayName, ...(entry.aliases || [])]) {
      const canonical = normalizeRegisterName(name);
      if (canonical) names.add(canonical);
    }

    for (const page of entry.pages || []) {
      if (Number.isFinite(Number(page))) pages.add(Number(page));
    }

    for (const chunk of entry.chunks || []) {
      if (chunk.id) chunkIds.add(chunk.id);
      if (Number.isFinite(Number(chunk.page))) pages.add(Number(chunk.page));
    }
  }

  return { chunkIds, pages, names };
}


export function isLikelyBitfieldCandidate(symbol, registerEntry = null) {
  const raw = String(symbol || "").trim();
  const value = normalizeBitFieldName(raw);
  if (!isLikelyBitfieldName(raw, registerEntry)) return false;

  if (registerEntry) {
    const registerNames = [
      registerEntry.name,
      registerEntry.displayName,
      registerEntry.canonicalName,
      ...(registerEntry.aliases || []),
    ].map(normalizeRegisterName).filter(Boolean);
    if (registerNames.includes(value)) return false;
  }

  // Long register-looking names usually belong in registers, not bitfields.
  if (looksLikeRegisterSymbol(raw) && value.length > 8 && /(?:CTRL|STAT|CFG|DCTRL|CHCTRL|CHSTAT|REGISTER|DMAC|GBETH|GPT|WDT)/.test(value)) {
    return false;
  }

  return true;
}

export function extractBitRangeFromLine(line, bitfield) {
  return parseBitfieldSemantics(line, bitfield).bitRange;
}

export function extractAccessFromLine(line) {
  return parseBitfieldSemantics(line).access;
}

export function extractResetFromLine(line) {
  return parseBitfieldSemantics(line).reset;
}

export function classifyBitfieldEvidenceLine(line) {
  const text = String(line || "");
  const tags = [];
  if (/\bBit\s+Name\b|\bbits?\b|\bb[0-9]+\b|\[[0-9]+(?::[0-9]+)?\]/i.test(text)) tags.push("bit-table");
  if (/\bDescription\b|\b0\s*[:=]|\b1\s*[:=]|\bSet\b|\bCleared\b/i.test(text)) tags.push("description");
  if (/\bR\/W\b|\bR\/O\b|\bW\/O\b|\bW1C\b|\bW0C\b|\bAccess\b/i.test(text)) tags.push("access");
  if (/\bInitial\s+Value\b|\bReset\s+Value\b/i.test(text)) tags.push("reset");
  if (/\bCaution\b|\bNote\b|\bReserved\b|\bUndefined\b|\bProhibited\b/i.test(text)) tags.push("risk");
  return tags;
}

export function scoreBitfieldCandidate({ symbol, evidenceLines, registerEntry, chunk, source }) {
  let score = 0;
  const value = normalizeBitFieldName(symbol);

  if (source === "chunk-bitfields") score += 45;
  if (source === "evidence-line") score += 75;
  if (source === "symbol-index") score += 25;
  if (registerEntry) score += 25;

  if (value.length <= 5) score += 8;
  if (value.length >= 2 && value.length <= 16) score += 12;
  if (/^(SET|CLR|CL|EN|DIS|ST|SUS|RST|SW|IRQ|INT|ERR|END|TC|TE|RE)/.test(value)) score += 16;

  for (const line of evidenceLines || []) {
    const tags = classifyBitfieldEvidenceLine(line);
    score += tags.length * 18;
    if (lineContainsBitfield(line, value, symbol)) score += 10;
  }

  const text = String(chunk?.text || "");
  if (/\bBit\s+Name\b/i.test(text)) score += 20;
  if (/\bDescription\b/i.test(text)) score += 8;
  if (/\bRegister\s+Name\b/i.test(text) && !/\bBit\s+Name\b/i.test(text)) score -= 25;

  return Math.max(1, Math.round(score));
}

export function chooseBestBitfieldEvidence(lines, bitfield) {
  const canonical = normalizeBitFieldName(bitfield);
  const selected = [];

  for (const line of lines || []) {
    if (!line || !lineContainsBitfield(line, canonical, bitfield)) continue;
    selected.push(line.slice(0, 600));
    if (selected.length >= 8) break;
  }

  return selected;
}

export function buildBitfieldEntryKey(registerName, bitfield) {
  return `${normalizeRegisterName(registerName || "GLOBAL")}::${normalizeBitFieldName(bitfield)}`;
}

export function bestSemanticsFromEvidence(bitfield, evidenceLines = []) {
  const best = {
    bitPositionRange: "unknown",
    fieldBitRange: "unknown",
    bitRange: "unknown",
    access: "unknown",
    reset: "unknown",
  };
  for (const line of evidenceLines || []) {
    const parsed = parseBitfieldSemantics(line, bitfield);
    if (best.bitPositionRange === "unknown" && parsed.bitPositionRange !== "unknown") best.bitPositionRange = parsed.bitPositionRange;
    if (best.fieldBitRange === "unknown" && parsed.fieldBitRange !== "unknown") best.fieldBitRange = parsed.fieldBitRange;
    if (best.access === "unknown" && parsed.access !== "unknown") best.access = parsed.access;
    if (best.reset === "unknown" && parsed.reset !== "unknown") best.reset = parsed.reset;
  }
  best.bitRange = best.bitPositionRange !== "unknown" ? best.bitPositionRange : best.fieldBitRange;
  return best;
}

export function knownBitfieldValue(value) {
  return Boolean(value) && String(value).toLowerCase() !== "unknown";
}

function bitfieldEvidenceSource(candidate) {
  const source = {
    source: candidate.source || "heuristic",
    page: Number(candidate.page || candidate.chunk?.page || 0) || null,
    tableId: candidate.tableId || null,
    rowId: candidate.rowId || null,
    chunkId: candidate.chunk?.id || null,
    quote: String(candidate.evidenceLines?.[0] || candidate.description || "").slice(0, 300),
    confidence: Math.max(1, Math.min(100, Math.round(candidate.confidence || candidate.score || 1))),
  };
  source.evidenceId = [source.source, source.page || "p", source.tableId || source.chunkId || "source", source.rowId || "row"].join(":");
  return source;
}

function mergeValueCandidates(existing = {}, candidate = {}, source = {}) {
  const merged = {};
  for (const field of ["bitPositionRange", "fieldBitRange", "access", "reset", "register"]) {
    const current = [...(existing[field] || [])];
    const value = field === "register" ? candidate.register : candidate[field];
    if (knownBitfieldValue(value)) {
      const key = `${String(value)}|${source.page}|${source.tableId}|${source.chunkId}`;
      if (!current.some((item) => String(item.value) === String(value) && item.evidenceId === source.evidenceId)) current.push({ value, evidenceId: source.evidenceId });
    }
    merged[field] = current.slice(0, 24);
  }
  return merged;
}

export function findNearestRegisterForChunk(registerIndex, chunk) {
  if (!registerIndex || !Array.isArray(registerIndex.registers) || !chunk) return null;
  const chunkRegisters = new Set((chunk.registers || []).map(normalizeRegisterName));
  const chunkId = chunk.id;
  const page = Number(chunk.page);

  let best = null;
  let bestScore = 0;

  for (const entry of registerIndex.registers) {
    let score = 0;
    const names = [entry.name, entry.displayName, entry.canonicalName, ...(entry.aliases || [])]
      .map(normalizeRegisterName)
      .filter(Boolean);

    if (names.some((name) => chunkRegisters.has(name))) score += 100;
    if ((entry.chunks || []).some((c) => c.id === chunkId)) score += 140;
    if ((entry.pages || []).map(Number).includes(page)) score += 35;

    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

export function updateBitfieldCandidate(map, candidate, registerIndex = null) {
  const mapping = resolveBitfieldRegisterMapping(candidate, registerIndex || {});
  const registerName = mapping.register || candidate.register || "GLOBAL";
  const bitfield = candidate.bitfield;
  if (!isLikelyBitfieldCandidate(bitfield, candidate.registerEntry)) return;

  const key = buildBitfieldEntryKey(registerName, bitfield);
  const existing = map.get(key);
  const evidenceLines = [...new Set([...(existing?.evidenceLines || []), ...(candidate.evidenceLines || [])])].slice(0, 12);
  const evidenceSemantics = bestSemanticsFromEvidence(bitfield, evidenceLines);
  const pages = [...new Set([...(existing?.pages || []), candidate.page].filter((p) => Number.isFinite(Number(p))).map(Number))].sort((a, b) => a - b);
  const chunks = new Map();

  for (const chunk of existing?.chunks || []) {
    if (chunk.id) chunks.set(chunk.id, chunk);
  }
  if (candidate.chunk?.id) {
    chunks.set(candidate.chunk.id, {
      id: candidate.chunk.id,
      page: candidate.chunk.page,
      chunkIndex: candidate.chunk.chunkIndex,
      score: candidate.chunk.score || candidate.score || 0,
      headings: (candidate.chunk.headings || []).slice(0, 4),
      preview: normalizeText(candidate.chunk.text || "").slice(0, 500),
    });
  }

  const bitRange = existing?.bitRange && existing.bitRange !== "unknown"
    ? existing.bitRange
    : (knownBitfieldValue(candidate.bitRange) ? candidate.bitRange : knownBitfieldValue(evidenceSemantics.bitRange) ? evidenceSemantics.bitRange : "unknown");
  const access = existing?.access && existing.access !== "unknown"
    ? existing.access
    : (knownBitfieldValue(candidate.access) ? candidate.access : knownBitfieldValue(evidenceSemantics.access) ? evidenceSemantics.access : "unknown");
  const reset = existing?.reset && existing.reset !== "unknown"
    ? existing.reset
    : (knownBitfieldValue(candidate.reset) ? candidate.reset : knownBitfieldValue(evidenceSemantics.reset) ? evidenceSemantics.reset : "unknown");
  const bitPositionRange = existing?.bitPositionRange && existing.bitPositionRange !== "unknown"
    ? existing.bitPositionRange
    : (knownBitfieldValue(candidate.bitPositionRange) ? candidate.bitPositionRange : knownBitfieldValue(evidenceSemantics.bitPositionRange) ? evidenceSemantics.bitPositionRange : bitRange || "unknown");
  const fieldBitRange = existing?.fieldBitRange && existing.fieldBitRange !== "unknown"
    ? existing.fieldBitRange
    : (knownBitfieldValue(candidate.fieldBitRange) ? candidate.fieldBitRange : knownBitfieldValue(evidenceSemantics.fieldBitRange) ? evidenceSemantics.fieldBitRange : "unknown");

  const score = Math.max(existing?.score || 0, candidate.score || 0) + Math.min(evidenceLines.length * 3, 24);
  const evidenceSource = bitfieldEvidenceSource({ ...candidate, register: registerName });
  const sources = [...(existing?.sources || [])];
  const sourceKey = evidenceSource.evidenceId;
  if (!sources.some((source) => source.evidenceId === sourceKey)) sources.push(evidenceSource);
  const valueCandidates = mergeValueCandidates(existing?.valueCandidates, { ...candidate, register: registerName }, evidenceSource);

  map.set(key, {
    id: `${candidate.filename}:bf:${key}`,
    filename: candidate.filename,
    register: registerName,
    sourceRegister: candidate.sourceRegister || candidate.register || existing?.sourceRegister || registerName,
    canonicalRegister: normalizeRegisterName(registerName),
    bitfield,
    canonicalBitfield: normalizeBitFieldName(bitfield),
    bitRange: bitPositionRange !== "unknown" ? bitPositionRange : bitRange,
    bitPositionRange,
    fieldBitRange,
    access,
    reset,
    mappingStatus: mapping.mappingStatus || existing?.mappingStatus || "unresolved",
    mappingConfidence: Math.max(existing?.mappingConfidence || 0, mapping.mappingConfidence || 0),
    mappingReasons: [...new Set([...(existing?.mappingReasons || []), ...(mapping.mappingReasons || [])])].slice(0, 8),
    description: candidate.description || existing?.description || "candidate bit-field evidence; verify against the original bit table",
    pages,
    chunks: [...chunks.values()].slice(0, 12),
    evidenceLines,
    source: [...new Set([existing?.source, candidate.source].filter(Boolean))].join(", ") || "heuristic",
    confidence: Math.max(existing?.confidence || 0, candidate.confidence || 0, Math.min(95, score)),
    score,
    aliases: [...new Set([...(existing?.aliases || []), candidate.bitfield].filter(Boolean))],
    sources: sources.slice(0, 8),
    valueCandidates,
  });
}

export function registerForBitfieldTable(table, registerIndex) {
  const page = Number(table.pageStart || table.page || 0);
  const entries = (registerIndex?.registersByPage?.get?.(page)) || (registerIndex?.registers || []).filter((entry) => (entry.pages || []).map(Number).includes(page));
  const header = canonicalSymbol([table.headerText, ...(table.rows || []).slice(0, 3).map((row) => row.text)].join(" "));
  const matches = entries.filter((entry) => [entry.name, entry.displayName, ...(entry.aliases || [])].map(canonicalSymbol).some((name) => name && header.includes(name)));
  if (matches.length === 1) return matches[0];
  return entries.length === 1 ? entries[0] : null;
}

export function collectBitfieldCandidatesFromTables(filename, tablesIndex, registerIndex, map) {
  for (const table of tablesIndex?.tables || []) {
    if (table.kind !== "bitfield-table") continue;
    const registerEntry = registerForBitfieldTable(table, registerIndex);
    const registerName = registerEntry?.displayName || registerEntry?.name || "GLOBAL";
    for (const row of table.rows || []) {
      if (row.isHeaderCandidate) continue;
      const cells = { ...(row.cellsByRole || {}) };
      for (const column of table.layout?.columnRoles || []) {
        if (!column.role || column.role === "unknown" || cells[column.role]) continue;
        const value = row.cells?.[column.column];
        if (value) cells[column.role] = value;
      }
      const fieldCell = String(cells.bitfield || "").trim();
      const bitfield = fieldCell.replace(/\s*\[[0-9]+(?::[0-9]+)?\]\s*$/, "").trim();
      if (!isLikelyBitfieldCandidate(bitfield, registerEntry)) continue;
      const context = [cells.bit, fieldCell, cells.access, cells.reset, cells.description, row.text].filter(Boolean).join(" | ");
      const semantics = parseBitfieldSemantics(context, bitfield);
      const candidate = {
        filename,
        register: registerName,
        sourceRegister: registerName,
        registerEntry,
        bitfield,
        bitRange: semantics.bitRange,
        bitPositionRange: semantics.bitPositionRange,
        fieldBitRange: semantics.fieldBitRange,
        access: semantics.access,
        reset: semantics.reset,
        description: cells.description || row.text || "coordinate table row",
        page: Number(row.sourcePage || table.pageStart || table.page || 0),
        tableId: table.tableId,
        rowId: row.rowId,
        evidenceLines: [context.slice(0, 700)],
        source: "tables-index",
        score: 150,
        confidence: Math.max(80, Number(table.confidence || 0)),
      };
      updateBitfieldCandidate(map, candidate, registerIndex);
    }
  }
}

export function finalizeBitfieldEntry(entry, registerIndex) {
  const conflicts = buildBitfieldConflicts(entry.valueCandidates);
  const validation = validateBitfieldEntry({ ...entry, conflicts }, registerIndex);
  const provenance = {};
  for (const field of ["bitPositionRange", "fieldBitRange", "access", "reset", "register"]) {
    const selected = field === "register" ? entry.register : entry[field];
    provenance[field] = {
      value: selected || "unknown",
      evidenceIds: (entry.valueCandidates?.[field] || []).filter((candidate) => String(candidate.value) === String(selected)).map((candidate) => candidate.evidenceId).filter(Boolean).slice(0, 8),
    };
  }
  const { valueCandidates, ...compactEntry } = entry;
  return { ...compactEntry, conflicts, provenance, ...validation };
}

export function shouldRetainBitfieldEntry(entry) {
  if (entry.validationStatus === "valid" || entry.validationStatus === "conflict") return true;
  const known = (value) => knownBitfieldValue(value);
  const criticalKnown = [entry.bitPositionRange, entry.access, entry.reset].filter(known).length;
  const fromTable = (entry.sources || []).some((source) => source.source === "tables-index");
  if (fromTable && known(entry.bitPositionRange)) return true;
  return entry.mappingStatus !== "unresolved" && criticalKnown >= 2 && Number(entry.confidence || 0) >= 50;
}

export function collectBitfieldCandidatesFromChunk(filename, chunk, registerEntry, map, registerIndex = null) {
  const registerName = registerEntry?.name || registerEntry?.displayName || "GLOBAL";
  const lines = String(chunk.text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const chunkBitfields = new Set([...(chunk.bitFields || []), ...(chunk.symbols || [])]);

  for (const symbol of chunkBitfields) {
    if (!isLikelyBitfieldCandidate(symbol, registerEntry)) continue;
    const evidenceLines = chooseBestBitfieldEvidence(lines, symbol);
    if (!evidenceLines.length && registerName === "GLOBAL") continue;

    const bestLine = evidenceLines[0] || "";
    const semantics = parseBitfieldSemantics(bestLine, symbol);
    const candidate = {
      filename,
      register: registerName,
      sourceRegister: registerName,
      registerEntry,
      bitfield: symbol,
      bitRange: semantics.bitRange,
      bitPositionRange: semantics.bitPositionRange,
      fieldBitRange: semantics.fieldBitRange,
      access: semantics.access !== "unknown" ? semantics.access : extractAccessFromLine(bestLine),
      reset: semantics.reset !== "unknown" ? semantics.reset : extractResetFromLine(bestLine),
      description: bestLine || "symbol detected near register context",
      page: chunk.page,
      chunk,
      evidenceLines,
      source: "chunk-bitfields",
    };
    candidate.score = scoreBitfieldCandidate({ ...candidate, source: candidate.source });
    candidate.confidence = Math.min(95, candidate.score);
    updateBitfieldCandidate(map, candidate, registerIndex);
  }

  // Also parse rows/lines that look like bit table rows, because PDF text extraction sometimes
  // does not put the field name into chunk.bitFields cleanly.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\b(Bit\s+Name|Description|Initial\s+Value|Access|R\/W|R\/O|W\/O|W1C|W0C|b[0-9]+|\[[0-9]+(?::[0-9]+)?\])\b/i.test(line)) {
      continue;
    }

    const context = [lines[i - 1], line, lines[i + 1]].filter(Boolean).join(" / ");
    const symbols = (context.match(/\b[A-Z][A-Z0-9_]{1,31}\b/g) || [])
      .filter((symbol) => isLikelyBitfieldCandidate(symbol, registerEntry));

    for (const symbol of symbols.slice(0, 12)) {
      const semantics = parseBitfieldSemantics(context, symbol);
      const candidate = {
        filename,
        register: registerName,
        sourceRegister: registerName,
        registerEntry,
        bitfield: symbol,
        bitRange: semantics.bitRange,
        bitPositionRange: semantics.bitPositionRange,
        fieldBitRange: semantics.fieldBitRange,
        access: semantics.access !== "unknown" ? semantics.access : extractAccessFromLine(context),
        reset: semantics.reset !== "unknown" ? semantics.reset : extractResetFromLine(context),
        description: context.slice(0, 500),
        page: chunk.page,
        chunk,
        evidenceLines: [context.slice(0, 700)],
        source: "evidence-line",
      };
      candidate.score = scoreBitfieldCandidate({ ...candidate, source: candidate.source });
      candidate.confidence = Math.min(98, candidate.score);
      updateBitfieldCandidate(map, candidate, registerIndex);
    }
  }
}

export async function buildBitfieldsIndex(filename, indexData = null, registersIndex = null, tablesIndex = null) {
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const source = await getPdfSourceInfo(filename);
  const pdfIndex = indexData || await loadPdfIndex(filename);
  const regIndex = registersIndex || await getRegistersIndex(filename);
  const candidates = new Map();
  const registerMappingIndex = {
    ...regIndex,
    registersByPage: new Map(),
  };

  const directRegisterChunkIds = new Map();
  for (const entry of regIndex.registers || []) {
    for (const page of entry.pages || []) {
      const pageNumber = Number(page);
      if (!Number.isFinite(pageNumber)) continue;
      if (!registerMappingIndex.registersByPage.has(pageNumber)) registerMappingIndex.registersByPage.set(pageNumber, []);
      registerMappingIndex.registersByPage.get(pageNumber).push(entry);
    }
    for (const chunk of entry.chunks || []) {
      if (chunk.id) directRegisterChunkIds.set(chunk.id, entry);
    }
  }

  collectBitfieldCandidatesFromTables(filename, tablesIndex, registerMappingIndex, candidates);

  for (const chunk of pdfIndex.chunks || []) {
    const registerEntry = directRegisterChunkIds.get(chunk.id) || findNearestRegisterForChunk(regIndex, chunk);
    collectBitfieldCandidatesFromChunk(filename, chunk, registerEntry, candidates, registerMappingIndex);
  }

  const extractedBitfields = [...candidates.values()]
    .map((entry, index) => ({
      ...finalizeBitfieldEntry(entry, regIndex),
      id: `${filename}:bf${index}`,
      evidenceLines: (entry.evidenceLines || []).slice(0, 4).map((line) => String(line).slice(0, 500)),
      chunks: (entry.chunks || []).slice(0, 6).map((chunk) => ({ id: chunk.id, page: chunk.page, chunkIndex: chunk.chunkIndex, score: chunk.score })),
      description: String(entry.description || "").slice(0, 300),
      mappingReasons: (entry.mappingReasons || []).slice(0, 4),
      confidence: Math.max(1, Math.min(100, Math.round(entry.confidence || entry.score || 1))),
      score: Math.round(entry.score || entry.confidence || 1),
    }));
  const bitfields = extractedBitfields
    .filter(shouldRetainBitfieldEntry)
    .sort((a, b) => {
      if (a.canonicalRegister !== b.canonicalRegister) return a.canonicalRegister.localeCompare(b.canonicalRegister);
      if (b.score !== a.score) return b.score - a.score;
      return a.canonicalBitfield.localeCompare(b.canonicalBitfield);
    });

  const overlaps = findBitfieldOverlaps(bitfields);
  for (const entry of bitfields) {
    const overlapFields = overlaps.get(entry.id) || [];
    if (!overlapFields.length) continue;
    entry.validationStatus = "needs_verification";
    entry.validationIssues = [...new Set([...(entry.validationIssues || []), `overlaps fields: ${overlapFields.join(", ")}`])];
  }

  const index = {
    schemaVersion: BITFIELD_INDEX_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    dependencyVersions: { registers: 1, tables: tablesIndex?.schemaVersion || null },
    pageCount: pdfIndex.pageCount,
    registerCount: regIndex.registerCount || 0,
    bitfieldCount: bitfields.length,
    quality: {
      valid: bitfields.filter((entry) => entry.validationStatus === "valid").length,
      needsVerification: bitfields.filter((entry) => entry.validationStatus === "needs_verification").length,
      conflict: bitfields.filter((entry) => entry.validationStatus === "conflict").length,
      unresolvedMapping: bitfields.filter((entry) => entry.mappingStatus === "unresolved").length,
      rejectedNoise: Math.max(0, (pdfIndex.chunks || []).reduce((sum, chunk) => sum + (chunk.bitFields || []).length, 0) - bitfields.length) + (extractedBitfields.length - bitfields.length),
    },
    bitfields,
  };

  const bitfieldsPath = safeBitfieldsIndexPath(filename);
  await atomicWriteJson(bitfieldsPath, index);
  return index;
}

export async function loadBitfieldsIndex(filename) {
  const bitfieldsPath = safeBitfieldsIndexPath(filename);

  if (!(await pathExists(bitfieldsPath))) return null;

  try {
    const index = await readJsonCached(bitfieldsPath);
    if (index.schemaVersion !== BITFIELD_INDEX_SCHEMA_VERSION) return null;
    if (index.filename !== filename) return null;
    if (!Array.isArray(index.bitfields)) return null;

    const currentSource = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(index.source, currentSource)) return null;

    return index;
  } catch {
    return null;
  }
}

export async function getBitfieldsIndex(filename, options = {}) {
  const existing = await loadBitfieldsIndex(filename);
  if (existing) return existing;

  if (options.buildIfMissing === true) {
    const indexData = await loadPdfIndex(filename, { buildIfMissing: true });
    const registersIndex = await getRegistersIndex(filename, { buildIfMissing: true });
    return buildBitfieldsIndex(filename, indexData, registersIndex);
  }

  throw new Error(`Bitfields index not found for ${filename}. Run index_pdf or start_index_pdf first.`);
}

export function scoreBitfieldIndexEntry(entry, options = {}) {
  const register = String(options.register || "").trim();
  const filter = String(options.filter || "").trim();
  const includeLowConfidence = Boolean(options.includeLowConfidence);
  const canonicalRegister = normalizeRegisterName(register);
  const normalizedFilter = normalizeForSearch(filter);

  if (!includeLowConfidence && Number(entry.confidence || 0) < 25) return 0;

  let score = Number(entry.score || entry.confidence || 1);

  if (register) {
    const entryRegister = normalizeRegisterName(entry.register);
    const registerText = normalizeForSearch([entry.register, entry.sourceRegister, entry.canonicalRegister, ...(entry.mappingReasons || [])].join("\n"));
    if (entryRegister === canonicalRegister) score += 200;
    else if (entryRegister.includes(canonicalRegister) || canonicalRegister.includes(entryRegister)) score += 80;
    else if (!registerText.includes(normalizeForSearch(register))) return 0;
  }

  if (filter) {
    const haystack = normalizeForSearch([
      entry.bitfield,
      entry.canonicalBitfield,
      entry.register,
      entry.sourceRegister,
      entry.bitPositionRange,
      entry.fieldBitRange,
      entry.description,
      ...(entry.evidenceLines || []),
    ].join("\n"));
    if (!haystack.includes(normalizedFilter)) return 0;
    score += 50;
  }

  return score;
}

export async function listBitfieldsFromIndex(filename, options = {}) {
  const bitfieldsIndex = await getBitfieldsIndex(filename);
  const topK = clampBitfieldListTopK(options.topK);

  const results = (bitfieldsIndex.bitfields || [])
    .map((entry) => ({
      ...entry,
      resultScore: scoreBitfieldIndexEntry(entry, options),
    }))
    .filter((entry) => entry.resultScore > 0)
    .sort((a, b) => {
      if (b.resultScore !== a.resultScore) return b.resultScore - a.resultScore;
      if (a.canonicalRegister !== b.canonicalRegister) return a.canonicalRegister.localeCompare(b.canonicalRegister);
      return a.canonicalBitfield.localeCompare(b.canonicalBitfield);
    })
    .slice(0, topK);

  return { bitfieldsIndex, results };
}

export function formatBitfieldListResults(bitfieldsIndex, results, options = {}) {
  const register = String(options.register || "").trim();
  const filter = String(options.filter || "").trim();
  const shown = results.length;
  const total = bitfieldsIndex.bitfieldCount || (bitfieldsIndex.bitfields || []).length;

  if (!shown) {
    return [
      register
        ? `No bit-field candidates found for register "${register}" in ${bitfieldsIndex.filename}.`
        : `No bit-field candidates found in ${bitfieldsIndex.filename}.`,
      filter ? `Filter: ${filter}` : "Filter: none",
      "",
      "Suggested next steps:",
      "- Rebuild the PDF index with index_pdf(force=true).",
      "- Try find_bitfield with a specific register and bit-field name.",
      "- Use read_pdf_pages around the register description page if the PDF table extraction is poor.",
    ].join("\n");
  }

  const header = [
    register
      ? `Detected bit-field candidates for register "${register}" in ${bitfieldsIndex.filename}`
      : `Detected bit-field candidates in ${bitfieldsIndex.filename}`,
    `Showing: ${shown} / ${total}`,
    filter ? `Filter: ${filter}` : "Filter: none",
    `Bitfields index created: ${bitfieldsIndex.createdAt}`,
    "",
  ];

  return header.concat(results.map((entry, idx) => {
    const evidence = (entry.evidenceLines || []).slice(0, 3).map((line) => `     evidence: ${line}`).join("\n");
    const chunks = (entry.chunks || []).slice(0, 4).map((chunk) => chunk.id).filter(Boolean).join(", ") || "none";
    const pages = (entry.pages || []).join(", ") || "unknown";
    return [
      `${idx + 1}. ${entry.bitfield}`,
      `   Register: ${entry.register || "unknown"}`,
      entry.sourceRegister && entry.sourceRegister !== entry.register ? `   Source register: ${entry.sourceRegister}` : null,
      `   Bit position: ${entry.bitPositionRange || entry.bitRange || "unknown"}`,
      entry.fieldBitRange && entry.fieldBitRange !== "unknown" ? `   Field bits: ${entry.fieldBitRange}` : null,
      `   Access: ${entry.access || "unknown"}`,
      `   Reset: ${entry.reset || "unknown"}`,
      entry.mappingStatus ? `   Mapping: ${entry.mappingStatus} (${entry.mappingConfidence || 0})` : null,
      `   Validation: ${entry.validationStatus || "needs_verification"}${(entry.validationIssues || []).length ? ` - ${entry.validationIssues.join("; ")}` : ""}`,
      (entry.conflicts || []).length ? `   Conflicts: ${entry.conflicts.map((conflict) => `${conflict.field}=[${conflict.values.join(", ")}]`).join("; ")}` : null,
      `   Pages: ${pages}`,
      `   Confidence: ${entry.confidence}`,
      `   Source: ${entry.source || "heuristic"}`,
      `   Description: ${entry.description || "candidate"}`,
      `   Chunks: ${chunks}`,
      `   Suggested find: find_bitfield(filename="${bitfieldsIndex.filename}", register="${entry.register}", bitfield="${entry.bitfield}")`,
      evidence,
    ].filter(Boolean).join("\n");
  })).join("\n\n");
}

export async function extractBitfieldTableFromIndex(filename, register, options = {}) {
  const topK = clampBitfieldListTopK(options.topK);
  const { bitfieldsIndex, results } = await listBitfieldsFromIndex(filename, {
    register,
    topK: Math.min(topK, MAX_BITFIELD_TABLE_ROWS),
    includeLowConfidence: true,
  });

  return {
    filename,
    register,
    bitfieldsIndex,
    rows: results.slice(0, MAX_BITFIELD_TABLE_ROWS).map((entry) => ({
      bitRange: entry.bitRange || "unknown",
      bitPositionRange: entry.bitPositionRange || entry.bitRange || "unknown",
      fieldBitRange: entry.fieldBitRange || "unknown",
      bitfield: entry.bitfield,
      access: entry.access || "unknown",
      reset: entry.reset || "unknown",
      register: entry.register,
      sourceRegister: entry.sourceRegister,
      mappingStatus: entry.mappingStatus,
      mappingConfidence: entry.mappingConfidence,
      mappingReasons: entry.mappingReasons || [],
      validationStatus: entry.validationStatus || "needs_verification",
      validationIssues: entry.validationIssues || [],
      conflicts: entry.conflicts || [],
      provenance: entry.provenance || {},
      registerWidth: entry.registerWidth || null,
      fieldWidth: entry.fieldWidth || null,
      description: entry.description || "candidate; verify against original bit table",
      pages: entry.pages || [],
      chunks: (entry.chunks || []).map((chunk) => chunk.id).filter(Boolean),
      confidence: entry.confidence || 0,
      evidenceLines: entry.evidenceLines || [],
    })),
  };
}


export function buildBitfieldTableEvidenceContract(table) {
  const rows = (table.rows || []).slice(0, 16);
  const evidence = rows.map((row) => makeEvidence({
    source: row.source || "bitfield-table-extraction",
    evidenceType: "bitfield-table",
    page: (row.pages || [])[0],
    chunkId: (row.chunks || [])[0] || null,
    quote: (row.evidenceLines || [])[0] || row.description || `${row.bitfield} ${row.bitRange || "unknown"}`,
    confidence: row.confidence || "medium",
    name: row.bitfield,
    field: "bitfield",
    tool: "extract_bitfield_table",
  }));
  const inference = rows.map((row) => makeInference({
    statement: `${row.bitfield}: bitPosition=${row.bitPositionRange || row.bitRange || "unknown"}, fieldBits=${row.fieldBitRange || "unknown"}, access=${row.access || "unknown"}, reset=${row.reset || "unknown"}`,
    basis: (row.evidenceLines || [])[0] || row.description || "coordinate/index heuristic row",
    confidence: row.confidence || "medium",
    risk: "Do not convert to Linux BIT()/GENMASK() macro unless bit/range is explicit and verified.",
  }));
  const needsVerification = [];
  for (const row of rows) {
    const page = (row.pages || [1])[0] || 1;
    if (!row.bitPositionRange || row.bitPositionRange === "unknown") needsVerification.push(makeNeedsVerification({
      item: `${row.bitfield} bit position/range`,
      reason: "Bit/range was not explicit in extracted table output.",
      suggestedTools: [`read_pdf_pages(filename="${table.filename}", start_page=${page}, end_page=${page + 2})`, `find_bitfield(filename="${table.filename}", register="${table.register}", bitfield="${row.bitfield}")`],
    }));
    if (!row.access || row.access === "unknown") needsVerification.push(makeNeedsVerification({
      item: `${row.bitfield} access type`,
      reason: "Access type was not explicit in extracted table output.",
      suggestedTools: [`read_pdf_pages(filename="${table.filename}", start_page=${page}, end_page=${page + 2})`],
    }));
    if (!row.reset || row.reset === "unknown") needsVerification.push(makeNeedsVerification({
      item: `${row.bitfield} reset/initial value`,
      reason: "Reset/initial value was not explicit in extracted table output.",
      suggestedTools: [`read_pdf_pages(filename="${table.filename}", start_page=${page}, end_page=${page + 2})`],
    }));
    if (row.validationStatus !== "valid") needsVerification.push(makeNeedsVerification({
      item: `${row.register || table.register}.${row.bitfield} validation`,
      reason: (row.validationIssues || []).join("; ") || "Bit-field evidence has not passed v3 validation.",
      suggestedTools: [`read_pdf_pages(filename="${table.filename}", start_page=${page}, end_page=${page + 2})`],
    }));
  }
  return makeEvidenceContract({
    tool: "extract_bitfield_table",
    filename: table.filename,
    query: table.register,
    evidence,
    inference,
    needsVerification,
    warnings: ["Coordinate/table extraction is heuristic; verify original manual table before writing driver macros."],
    recommendedNextTools: [`summarize_register(filename="${table.filename}", register="${table.register}")`, `get_cautions_for_register(filename="${table.filename}", register="${table.register}")`],
  });
}

export function formatExtractedBitfieldTable(table) {
  const rows = table.rows || [];
  if (!rows.length) {
    return [
      `No bit-field table candidates found for register "${table.register}" in ${table.filename}.`,
      "",
      "Suggested next steps:",
      `- Try summarize_register(filename="${table.filename}", register="${table.register}").`,
      `- Try find_register(filename="${table.filename}", register="${table.register}").`,
      "- Read the register description pages and verify the original bit table manually.",
    ].join("\n");
  }

  const lines = [
    `Step 30A layout-aware bit-field table candidates for register "${table.register}"`,
    `File: ${table.filename}`,
    `Rows: ${rows.length}`,
    "Reliability: coordinate-table extraction when possible, otherwise heuristic extraction from PDF text/chunk evidence. Verify bit positions/access/reset values with read_pdf_pages or read_pdf_chunk before writing driver macros.",
    "",
    "| # | Bit Position | Field Bits | Field | Access | Reset | Validation | Pages | Confidence | Evidence |",
    "|---:|---|---|---|---|---|---|---|---:|---|",
  ];

  rows.forEach((row, index) => {
    const evidence = (row.evidenceLines || [])[0] || row.description || "";
    lines.push(
      `| ${index + 1} | ${row.bitPositionRange || row.bitRange || "unknown"} | ${row.fieldBitRange || "unknown"} | ${row.bitfield} | ${row.access || "unknown"} | ${row.reset || "unknown"} | ${row.validationStatus || "needs_verification"} | ${(row.pages || []).join(", ") || "unknown"} | ${row.confidence || 0} | ${String(evidence).replace(/\|/g, "/").slice(0, 180)} |`
    );
  });

  lines.push("", "Suggested follow-up reads:");
  for (const row of rows.slice(0, 8)) {
    const chunkId = (row.chunks || [])[0];
    if (chunkId) {
      lines.push(`- read_pdf_chunk(filename="${table.filename}", chunk_id="${chunkId}")  # ${row.bitfield}`);
    } else if ((row.pages || []).length) {
      const page = row.pages[0];
      lines.push(`- read_pdf_pages(filename="${table.filename}", start_page=${page}, end_page=${Math.min(page + 2, page)})  # ${row.bitfield}`);
    }
  }

  const text = lines.join("\n");
  return appendEvidenceContract(text, buildBitfieldTableEvidenceContract(table));
}
