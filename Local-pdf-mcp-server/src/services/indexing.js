import { atomicWriteJson, canonicalSymbol, clampChunkOverlap, clampChunkSize, clampRegisterListTopK, clampTopK, escapeRegExp, getPdfSourceInfo, isSamePdfSource, normalizeForSearch, normalizeText, pathExists, readJsonCached, safeIndexPath, safeRegistersIndexPath, safeSectionsIndexPath, withIndexBuildLock } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { DEFAULT_PAGE_RANGE, DEFAULT_TOP_K, INDEX_DIR, INDEX_SCHEMA_VERSION, REGISTER_INDEX_SCHEMA_VERSION, SECTION_INDEX_SCHEMA_VERSION, SERVER_VERSION } from "../core/runtime-constants.js";
import fs from "node:fs/promises";
import path from "node:path";


const buildBitfieldsIndex = createRuntimePort("buildBitfieldsIndex");
const buildCautionsIndex = createRuntimePort("buildCautionsIndex");
const buildFiguresIndex = createRuntimePort("buildFiguresIndex");
const buildPagesCache = createRuntimePort("buildPagesCache");
const buildSequencesIndex = createRuntimePort("buildSequencesIndex");
const buildTablesIndex = createRuntimePort("buildTablesIndex");
const buildStructuredArtifacts = createRuntimePort("buildStructuredArtifacts");


const getFileStat = createRuntimePort("getFileStat");
const getPagesCache = createRuntimePort("getPagesCache");
const extractRegisterRowsFromCoordinateTable = createRuntimePort("extractRegisterRowsFromCoordinateTable");


const loadPagesCache = createRuntimePort("loadPagesCache");
const loadTablesIndex = createRuntimePort("loadTablesIndex");


const q = createRuntimePort("q");


const tokenizeQuery = createRuntimePort("tokenizeQuery");

const writeArtifactManifest = createRuntimePort("writeArtifactManifest");


// -----------------------------------------------------------------------------
// Indexing
// -----------------------------------------------------------------------------

export function chunkText(text, chunkSize, overlap) {
  const clean = normalizeText(text);
  if (!clean) return [];

  if (clean.length <= chunkSize) return [clean];

  const chunks = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);

    if (end < clean.length) {
      const slice = clean.slice(start, end);
      const boundaries = [
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf("\n"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf("; "),
        slice.lastIndexOf(": "),
      ];
      const boundary = Math.max(...boundaries);

      if (boundary > chunkSize * 0.55) {
        end = start + boundary + 1;
      }
    }

    const chunk = clean.slice(start, end).trim();
    if (chunk) chunks.push(chunk);

    if (end >= clean.length) break;
    start = Math.max(0, end - overlap);
  }

  return chunks;
}


export const CHUNK_TYPE_LABELS = [
  "register_table",
  "bitfield_table",
  "procedure",
  "caution",
  "register_description",
  "interrupt_status",
  "clock_reset",
  "overview",
  "toc_index",
  "revision_history",
  "legal_notice",
  "noise",
  "text",
];

export function clampScore(value, min = 0, max = 100) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function countRegexMatches(text, pattern) {
  const matches = String(text || "").match(pattern);
  return matches ? matches.length : 0;
}

export function isLikelyTocOrIndexChunk(text, headings = []) {
  const raw = String(text || "");
  const normalized = normalizeForSearch(raw);
  const headingText = normalizeForSearch((headings || []).join(" "));
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);

  if (/\b(table of contents|contents|list of figures|list of tables)\b/i.test(raw)) return true;
  if (/\bindex\b/i.test(headingText) && lines.length > 8) return true;

  const numberedLines = lines.filter((line) => /\.{2,}\s*\d+\s*$/.test(line) || /^\d+(?:\.\d+){1,5}\s+.+\s+\d+\s*$/.test(line));
  if (lines.length >= 8 && numberedLines.length / lines.length > 0.45) return true;

  const chapterLike = lines.filter((line) => /^\d+(?:\.\d+)*\s+.+/.test(line));
  if (normalized.includes("contents") && chapterLike.length >= 5) return true;

  return false;
}

export function classifyChunkProfile(text, meta = {}) {
  const raw = String(text || "");
  const headings = meta.headings || [];
  const registers = meta.registers || [];
  const bitFields = meta.bitFields || [];
  const lineCount = raw.split("\n").map((line) => line.trim()).filter(Boolean).length;
  const charCount = raw.length;
  const signals = [];
  const types = new Set();
  let noiseScore = 0;
  let contentScore = 35;

  const add = (type, signal, contentDelta = 0, noiseDelta = 0) => {
    types.add(type);
    if (signal) signals.push(signal);
    contentScore += contentDelta;
    noiseScore += noiseDelta;
  };

  if (!raw.trim() || charCount < 30) add("noise", "very-short-or-empty", -20, 45);

  if (isLikelyTocOrIndexChunk(raw, headings)) add("toc_index", "toc/index layout", -35, 70);
  if (/\b(revision history|document revision|revision record|rev\.?\s+date|description of revision)\b/i.test(raw)) add("revision_history", "revision-history language", -30, 65);
  if (/\b(copyright|trademark|notice|disclaimer|all rights reserved|renesas electronics corporation)\b/i.test(raw) && !/\bregister|bit|operation\b/i.test(raw)) add("legal_notice", "legal/notice language", -25, 55);

  if (/\b(Register\s+Name|Abbreviation|Offset\s+Address|Initial\s+Value|Access\s+Size)\b/i.test(raw)) add("register_table", "register table headers", 55, -15);
  if (/\b(Bit\s+Name|Bit\s+Field|R\/W|R\/O|W\/O|Initial\s+Value|Description)\b/i.test(raw) && /\b(bit|b\d+|\[\d+(?::\d+)?\])\b/i.test(raw)) add("bitfield_table", "bitfield table headers", 55, -15);
  if ((registers || []).length && /\b(Address|Offset|Initial\s+Value|Access|Description|Register)\b/i.test(raw)) add("register_description", "register metadata", 35, -8);
  if ((bitFields || []).length >= 2 && /\b(Bit|Description|Set|Clear|Read|Write)\b/i.test(raw)) add("bitfield_table", "multiple bitfield symbols", 30, -8);

  if (/\b(Caution|CAUTION|Note|NOTES?|Restriction|Restrictions|Prohibited|Forbidden|Undefined|Invalid|Reserved|must\s+not|do\s+not|only\s+when)\b/i.test(raw)) add("caution", "caution/restriction language", 45, -10);
  if (/\b(sequence|procedure|operation|setting|settings|step|steps|before|after|when|while|first|then|enable|disable|start|stop|clear|reset|initialize|initialization)\b/i.test(raw)) add("procedure", "operation/procedure language", 35, -5);
  if (/\b(interrupt|IRQ|INT|status flag|interrupt request|interrupt status|enable interrupt|clear interrupt)\b/i.test(raw)) add("interrupt_status", "interrupt/status language", 30, -5);
  if (/\b(clock|PCLK|module stop|standby|reset release|software reset|SWRST|reset)\b/i.test(raw)) add("clock_reset", "clock/reset language", 22, -3);
  if (/\b(overview|features|block diagram|functional overview|outline)\b/i.test(raw) || headings.some((h) => /overview|outline|features/i.test(h))) add("overview", "overview language", 18, -3);

  const letters = raw.replace(/[^A-Za-z]/g, "");
  const uppercaseRatio = letters.length ? raw.replace(/[^A-Z]/g, "").length / letters.length : 0;
  if (lineCount > 30 && uppercaseRatio > 0.78 && !types.has("register_table") && !types.has("bitfield_table")) add("noise", "high-uppercase-list-like chunk", -25, 35);

  const numericPageRefs = countRegexMatches(raw, /\.{2,}\s*\d+\s*$/gm);
  if (numericPageRefs >= 5 && !types.has("register_table")) add("toc_index", "many page-reference lines", -25, 45);

  if (!types.size) types.add("text");

  if (types.has("register_table") || types.has("bitfield_table") || types.has("procedure") || types.has("caution")) {
    noiseScore = Math.max(0, noiseScore - 25);
  }

  const priority = [
    "register_table",
    "bitfield_table",
    "caution",
    "procedure",
    "interrupt_status",
    "clock_reset",
    "register_description",
    "overview",
    "toc_index",
    "revision_history",
    "legal_notice",
    "noise",
    "text",
  ];
  const chunkType = priority.find((type) => types.has(type)) || "text";

  return {
    chunkType,
    chunkTypes: priority.filter((type) => types.has(type)),
    noiseScore: clampScore(noiseScore),
    contentScore: clampScore(contentScore - Math.round(noiseScore / 3)),
    signals: [...new Set(signals)].slice(0, 12),
  };
}

export function chunkTypeAdjustmentForBasicSearch(chunk) {
  let adjustment = 0;
  const type = chunk.chunkType || "text";
  const noise = Number(chunk.noiseScore || 0);
  const content = Number(chunk.contentScore || 0);

  adjustment += Math.round(content / 12);
  if (noise >= 70) adjustment -= 55;
  else if (noise >= 45) adjustment -= 25;

  if (["toc_index", "revision_history", "legal_notice", "noise"].includes(type)) adjustment -= 35;
  if (["register_table", "bitfield_table", "register_description", "procedure", "caution"].includes(type)) adjustment += 12;

  return adjustment;
}

export function chunkTypeAdjustmentForHybrid(chunk, hybrid) {
  const type = chunk.chunkType || "text";
  const types = new Set([type, ...((chunk.chunkTypes || []))]);
  const intents = new Set(hybrid.intents || []);
  const noise = Number(chunk.noiseScore || 0);
  const content = Number(chunk.contentScore || 0);
  const reasons = [];
  let score = 0;

  score += Math.round(content / 8);
  if (noise >= 75) {
    score -= 120;
    reasons.push("noise suppression");
  } else if (noise >= 50) {
    score -= 55;
    reasons.push("moderate noise suppression");
  }

  const isSearchForNavigation = intents.has("section") || intents.has("table");
  if (!isSearchForNavigation && (types.has("toc_index") || types.has("revision_history") || types.has("legal_notice") || types.has("noise"))) {
    score -= 85;
    reasons.push(`chunkType penalty ${type}`);
  }

  if (intents.has("register") && (types.has("register_table") || types.has("register_description"))) {
    score += 95;
    reasons.push("chunkType register boost");
  }
  if ((intents.has("bitfield") || intents.has("table")) && types.has("bitfield_table")) {
    score += 95;
    reasons.push("chunkType bitfield-table boost");
  }
  if (intents.has("table") && (types.has("register_table") || types.has("bitfield_table"))) {
    score += 80;
    reasons.push("chunkType table boost");
  }
  if (intents.has("caution") && types.has("caution")) {
    score += 110;
    reasons.push("chunkType caution boost");
  }
  if (["sequence", "init", "start", "stop", "clear", "reset", "irq", "error"].some((intent) => intents.has(intent)) && types.has("procedure")) {
    score += 90;
    reasons.push("chunkType procedure boost");
  }
  if (intents.has("irq") && types.has("interrupt_status")) {
    score += 90;
    reasons.push("chunkType interrupt/status boost");
  }
  if (intents.has("reset") && types.has("clock_reset")) {
    score += 65;
    reasons.push("chunkType clock/reset boost");
  }
  if (intents.has("section") && types.has("overview")) {
    score += 35;
    reasons.push("chunkType overview boost");
  }

  return { score, reasons };
}

export function summarizeChunkTypes(chunks) {
  const byType = new Map();
  const byNoiseBand = { low: 0, medium: 0, high: 0 };
  let totalNoise = 0;
  let totalContent = 0;

  for (const chunk of chunks || []) {
    const type = chunk.chunkType || "unknown";
    if (!byType.has(type)) {
      byType.set(type, {
        type,
        count: 0,
        pages: new Set(),
        examples: [],
        _noise: 0,
        _content: 0,
      });
    }
    const item = byType.get(type);
    item.count += 1;
    item.pages.add(chunk.page);
    item._noise += Number(chunk.noiseScore || 0);
    item._content += Number(chunk.contentScore || 0);
    if (item.examples.length < 3) {
      item.examples.push({
        id: chunk.id,
        page: chunk.page,
        chunkIndex: chunk.chunkIndex,
        noiseScore: chunk.noiseScore || 0,
        contentScore: chunk.contentScore || 0,
        signals: chunk.chunkTypeSignals || [],
        preview: normalizeText(chunk.text || "").slice(0, 220),
      });
    }

    const noise = Number(chunk.noiseScore || 0);
    if (noise >= 70) byNoiseBand.high += 1;
    else if (noise >= 40) byNoiseBand.medium += 1;
    else byNoiseBand.low += 1;
    totalNoise += noise;
    totalContent += Number(chunk.contentScore || 0);
  }

  const typeStats = [...byType.values()].map((item) => ({
    type: item.type,
    count: item.count,
    pages: [...item.pages].sort((a, b) => a - b).slice(0, 30),
    avgNoise: item.count ? Math.round(item._noise / item.count) : 0,
    avgContent: item.count ? Math.round(item._content / item.count) : 0,
    examples: item.examples,
  })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const count = (chunks || []).length;
  return {
    chunkCount: count,
    avgNoise: count ? Math.round(totalNoise / count) : 0,
    avgContent: count ? Math.round(totalContent / count) : 0,
    byNoiseBand,
    byType: typeStats,
  };
}

export async function getChunkTypeStats(filename, options = {}) {
  const indexData = await loadPdfIndex(filename);
  const stats = summarizeChunkTypes(indexData.chunks || []);
  return {
    filename,
    createdAt: new Date().toISOString(),
    indexCreatedAt: indexData.createdAt,
    pageCount: indexData.pageCount,
    includeExamples: options.includeExamples !== false,
    stats,
  };
}

export function formatChunkTypeStats(payload) {
  const lines = [
    `Chunk type statistics for ${payload.filename}`,
    `Index created: ${payload.indexCreatedAt}`,
    `Pages: ${payload.pageCount}`,
    `Chunks: ${payload.stats.chunkCount}`,
    `Average noise score: ${payload.stats.avgNoise}`,
    `Average content score: ${payload.stats.avgContent}`,
    `Noise bands: low=${payload.stats.byNoiseBand.low}, medium=${payload.stats.byNoiseBand.medium}, high=${payload.stats.byNoiseBand.high}`,
    "",
    "Types:",
  ];

  for (const item of payload.stats.byType || []) {
    lines.push(`- ${item.type}: count=${item.count}, avgNoise=${item.avgNoise}, avgContent=${item.avgContent}, pages=${item.pages.join(", ") || "unknown"}`);
    if (payload.includeExamples) {
      for (const example of item.examples || []) {
        lines.push(`  example: ${example.id} page=${example.page} noise=${example.noiseScore} content=${example.contentScore} signals=${(example.signals || []).join("; ") || "none"}`);
        lines.push(`    preview: ${example.preview}`);
      }
    }
  }

  lines.push("", "Machine summary JSON:");
  lines.push(JSON.stringify({
    filename: payload.filename,
    chunkCount: payload.stats.chunkCount,
    avgNoise: payload.stats.avgNoise,
    avgContent: payload.stats.avgContent,
    byNoiseBand: payload.stats.byNoiseBand,
    byType: (payload.stats.byType || []).map((item) => ({
      type: item.type,
      count: item.count,
      avgNoise: item.avgNoise,
      avgContent: item.avgContent,
    })),
  }, null, 2));

  return lines.join("\n");
}

export function detectHeadings(text) {
  const headings = [];
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const compact = line.replace(/\s+/g, " ");
    const isSectionNumber = /^\d+(?:\.\d+){1,8}\s+\S+/.test(compact);
    const isAppendixSection = /^Appendix\s+[A-Z0-9]+\b/i.test(compact);
    const isTableOrFigure = /^(Table|Figure)\s+\d[\d.\-]*\b/i.test(compact);
    const mentionsRegister = /\b(Register|Registers|Bit Field|Interrupt|Clock|Reset|Operation|Description)\b/i.test(compact) && compact.length <= 180;
    const allCapsHeading = /^[A-Z0-9][A-Z0-9_ /,()\-]{8,160}$/.test(compact) && /[A-Z]{4}/.test(compact);

    if (isSectionNumber || isAppendixSection || isTableOrFigure || mentionsRegister || allCapsHeading) {
      headings.push(compact.slice(0, 220));
    }

    if (headings.length >= 10) break;
  }

  return [...new Set(headings)];
}

export function cleanSectionTitle(line) {
  return String(line || "")
    .replace(/\s+/g, " ")
    .replace(/[.·•]+$/g, "")
    .trim()
    .slice(0, 240);
}

export function isNoiseSectionLine(line) {
  const text = String(line || "").trim();

  if (!text || text.length < 4 || text.length > 240) return true;
  if (/^[-–—_\s]+$/.test(text)) return true;
  if (/^Page\s+\d+\b/i.test(text)) return true;
  if (/^R\d{2}[A-Z0-9]+/i.test(text)) return true;
  if (/^(Rev\.|Revision|Preliminary|Confidential|Copyright)\b/i.test(text)) return true;
  if (/^\d+$/.test(text)) return true;

  return false;
}

export function classifySectionLine(line) {
  const title = cleanSectionTitle(line);

  if (isNoiseSectionLine(title)) return null;

  let match = title.match(/^(\d+(?:\.\d+){0,8})\s+(.{2,})$/);
  if (match) {
    const number = match[1];
    const tail = match[2].trim();
    if (tail.length >= 2 && !/^\d+$/.test(tail)) {
      return {
        title,
        number,
        level: number.split(".").length,
        type: "numbered",
        confidence: 95,
      };
    }
  }

  match = title.match(/^(Appendix\s+[A-Z0-9]+(?:[.\-]\d+)*)\s+(.{2,})$/i);
  if (match) {
    return {
      title,
      number: match[1],
      level: 1,
      type: "appendix",
      confidence: 90,
    };
  }

  match = title.match(/^(Table|Figure)\s+(\d[\d.\-]*)\s+(.{2,})$/i);
  if (match) {
    return {
      title,
      number: `${match[1]} ${match[2]}`,
      level: 99,
      type: match[1].toLowerCase(),
      confidence: 80,
    };
  }

  const manualTopic = /\b(Overview|Register(?:s)?|Register Description|Bit Field|Operation|Operating|Procedure|Setting|Settings|Interrupt(?:s)?|Clock|Reset|Initialization|Configuration|Caution|Note|Restriction|Usage Notes|Pin|DMA|Transfer|Mode)\b/i.test(title);
  const looksLikeHeading = /^[A-Z0-9][A-Za-z0-9_ /,()\-:+]{5,180}$/.test(title);
  const registerHeading = /\b[A-Z][A-Z0-9_]{2,}\b.*\b(Register|Registers)\b/i.test(title);

  if ((manualTopic && looksLikeHeading) || registerHeading) {
    return {
      title,
      number: "",
      level: 50,
      type: "topic",
      confidence: registerHeading ? 78 : 65,
    };
  }

  const allCapsHeading = /^[A-Z0-9][A-Z0-9_ /,()\-:+]{8,160}$/.test(title) && /[A-Z]{4}/.test(title);
  if (allCapsHeading) {
    return {
      title,
      number: "",
      level: 60,
      type: "caps",
      confidence: 55,
    };
  }

  return null;
}

export function detectSectionCandidatesFromPage(page) {
  const candidates = [];
  const lines = String(page.text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const classified = classifySectionLine(line);
    if (!classified) continue;

    candidates.push({
      ...classified,
      filename: page.filename,
      page: page.page,
      searchText: normalizeForSearch(classified.title),
      canonicalTitle: canonicalSymbol(classified.title),
    });
  }

  return candidates;
}

export async function buildSectionsIndex(filename, pageCache = null) {
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const source = await getPdfSourceInfo(filename);
  const cache = pageCache || (await getPagesCache(filename));
  const byKey = new Map();

  for (const page of cache.pages || []) {
    const pageCandidates = detectSectionCandidatesFromPage({
      ...page,
      filename,
    });

    for (const candidate of pageCandidates) {
      const key = `${candidate.page}:${candidate.title.toLowerCase()}`;
      const previous = byKey.get(key);

      if (!previous || candidate.confidence > previous.confidence) {
        byKey.set(key, candidate);
      }
    }
  }

  const sections = [...byKey.values()]
    .sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      if (a.level !== b.level) return a.level - b.level;
      return b.confidence - a.confidence;
    })
    .map((section, index) => ({
      id: `${filename}:s${index}`,
      filename,
      title: section.title,
      number: section.number || "",
      page: section.page,
      level: section.level,
      type: section.type,
      confidence: section.confidence,
      searchText: section.searchText,
      canonicalTitle: section.canonicalTitle,
    }));

  const indexData = {
    schemaVersion: SECTION_INDEX_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    pageCount: cache.pageCount,
    sectionCount: sections.length,
    sections,
  };

  const sectionsPath = safeSectionsIndexPath(filename);
  await atomicWriteJson(sectionsPath, indexData);

  return indexData;
}

export async function loadSectionsIndex(filename) {
  const sectionsPath = safeSectionsIndexPath(filename);

  if (!(await pathExists(sectionsPath))) {
    return null;
  }

  try {
    const indexData = await readJsonCached(sectionsPath);

    if (indexData.schemaVersion !== SECTION_INDEX_SCHEMA_VERSION) return null;
    if (indexData.filename !== filename) return null;
    if (!Array.isArray(indexData.sections)) return null;

    const currentSource = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(indexData.source, currentSource)) return null;

    return indexData;
  } catch {
    return null;
  }
}

export async function getSectionsIndex(filename, options = {}) {
  const existing = await loadSectionsIndex(filename);
  if (existing) return existing;

  if (options.buildIfMissing === true) {
    const pageCache = await getPagesCache(filename, { buildIfMissing: true });
    return buildSectionsIndex(filename, pageCache);
  }

  throw new Error(`Sections index not found for ${filename}. Run index_pdf or start_index_pdf first.`);
}

export function detectRegisters(text) {
  const found = new Set();
  const source = String(text || "");

  const patterns = [
    // Renesas module style: DMACm_N0SA_n, DMACm_CHCTRL_n, GBETHm_MACCR, GPTm_GTCR.
    /\b[A-Z][A-Za-z0-9]*m_[A-Za-z0-9_]+(?:_n)?\b/g,
    /\b[A-Z]{2,12}m_[A-Za-z0-9_]+(?:_n)?\b/g,

    // Generic all-caps register-looking symbols.
    /\b[A-Z]{2,12}_[A-Z0-9_]*(?:R|CR|SR|DR|MR|ER|FR|RR|TR|BR|AR|LR|PR|CSR|ISR|IER|ICR|CTRL|STAT)\d*\b/g,
    /\b(?:MAC|MTL|DMA|DMAC|GMAC|ETH|GBETH|WDT|GPT|GT|POEG|ICU|IRQ|INT|SPI|I2C|I3C|UART|CAN|ADC)[A-Z0-9_]*(?:R|CR|SR|DR|MR|ER|FR|RR|TR|BR|AR|LR|PR|CSR|ISR|IER|ICR|CTRL|STAT)\d*\b/g,

    // Known short names that do not always end in R.
    /\b(?:WDT|WDTRR|WDTCR|WDTSR|WDTRCR|GTCR|GTUDDTYC|GTCNT|GTCCR|GTCCRA|GTCCRB|GTIOR|GTINTAD|GTST|GTBER|GTPR|GTPBR|GTDTCR|GTDVU|GTDVD)\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.match(pattern) || []) {
      const symbol = match.trim();
      if (symbol.length >= 3 && symbol.length <= 80) found.add(symbol);
    }
  }

  return [...found].slice(0, 120);
}
export function detectBitFields(text) {
  const found = new Set();
  const source = String(text || "");

  const patterns = [
    /\b[A-Z][A-Z0-9_]{1,31}\s*\[[0-9]+(?::[0-9]+)?\]/g,
    /\b[A-Z][A-Z0-9_]{1,31}\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.match(pattern) || []) {
      const cleaned = match.replace(/\s+/g, "").trim();
      if (cleaned.length >= 2 && cleaned.length <= 40) found.add(cleaned);
    }
  }

  return [...found].slice(0, 100);
}

export function normalizeRegisterName(name) {
  return canonicalSymbol(name);
}

export function registerAliasCandidates(name) {
  const raw = String(name || "").trim();
  const canonical = normalizeRegisterName(raw);
  const aliases = new Set();

  if (!raw || !canonical) return [];

  aliases.add(raw);
  aliases.add(canonical);

  const unprefixed = raw
    .replace(/^[A-Z0-9]+m_/i, "")
    .replace(/^(GBETH|ETH|GMAC|WDT|GPT|POEG|ICU)_/i, "");

  const canonicalUnprefixed = normalizeRegisterName(unprefixed);
  if (canonicalUnprefixed) aliases.add(canonicalUnprefixed);

  for (const prefix of ["GBETHm_", "ETH_", "GMAC_", "WDT_", "GPT_", "POEG_", "ICU_"]) {
    if (canonicalUnprefixed && !canonicalUnprefixed.startsWith(normalizeRegisterName(prefix))) {
      aliases.add(`${prefix}${canonicalUnprefixed}`);
    }
  }

  return [...aliases].filter(Boolean);
}

export function looksLikeRegisterSymbol(symbol) {
  const raw = String(symbol || "").trim();
  const value = normalizeRegisterName(raw);
  if (value.length < 3 || value.length > 80) return false;

  const noisy = new Set([
    "NOTE",
    "NOTES",
    "TABLE",
    "FIGURE",
    "REGISTER",
    "REGISTERS",
    "ADDRESS",
    "OFFSET",
    "DESCRIPTION",
    "INITIALVALUE",
    "BITNAME",
    "READ",
    "WRITE",
    "RESERVED",
    "UNDEFINED",
    "CAUTION",
    "CAUTIONS",
  ]);

  if (noisy.has(value)) return false;

  // Avoid common DMA interrupt/signal names being promoted to registers.
  // They can still be found by search_pdf, but should not pollute list_registers.
  const likelySignalOnly = /^(DMAERR|DMAEND\d*|DMAC\d+_DMAER|DMAC\d+_DMAEND\d*)$/.test(value);
  if (likelySignalOnly) return false;

  return (
    /R\d*$/.test(value) ||
    /(CR|SR|DR|MR|ER|FR|RR|TR|BR|AR|LR|PR|CSR|ISR|IER|ICR|CTRL|STAT)$/.test(value) ||
    /^[A-Z0-9]+M_[A-Z0-9_]+(?:_N)?$/.test(value) ||
    /^(WDT|WDTRR|WDTCR|WDTSR|WDTRCR|GT|GPT|POEG|MAC|MTL|DMA|DMAC|GMAC|ETH|GBETH|ICU|I3C|I2C|SPI|UART|CAN|ADC)[A-Z0-9_]*$/.test(value)
  );
}
export function isNonRegisterSignal(symbol) {
  const value = normalizeRegisterName(symbol);
  if (!value || value.length < 3 || value.length > 80) return true;
  const noisy = new Set(["NOTE", "NOTES", "TABLE", "FIGURE", "SECTION", "CHAPTER", "PAGE", "PAGES", "REGISTER", "REGISTERS", "ADDRESS", "OFFSET", "DESCRIPTION", "INITIALVALUE", "ACCESS", "ACCESSSIZE", "BIT", "BITS", "BITNAME", "READ", "WRITE", "RESET", "RESERVED", "UNDEFINED", "CAUTION", "CAUTIONS", "PROHIBITED", "FUNCTION", "OPERATION"]);
  if (noisy.has(value)) return true;
  const signalOnlyPatterns = [/^(DMAERR|DMAEND\d*|DMAOR|DMARQ\d*|DREQ\d*|DACK\d*)$/, /^DMAC\d+_(DMAER|DMAERR|DMAEND\d*|DREQ\d*|DACK\d*)$/, /^(IRQ|INT|NMI|FIQ|EVENT|REQUEST|ACK|ERROR|DONE|BUSERR|PERIERR)$/, /^(RXD|TXD|RXER|TXER|RXDV|TXEN|MDC|MDIO|REFCLK|GTXCLK|RXCLK|TXCLK)$/];
  if (signalOnlyPatterns.some((pattern) => pattern.test(value))) return true;
  return !looksLikeRegisterSymbol(symbol);
}

export function scoreRegisterOccurrence(symbol, chunk) {
  const name = normalizeRegisterName(symbol);
  const text = String(chunk.text || "");
  const searchText = chunk.searchText || normalizeForSearch(text);
  const headings = (chunk.headings || []).join("\n");
  const headingSearch = normalizeForSearch(headings);
  const canonicalHeading = canonicalSymbol(headings);

  let score = 20;

  if ((chunk.registers || []).map(normalizeRegisterName).includes(name)) score += 30;
  if ((chunk.symbols || []).map(normalizeRegisterName).includes(name)) score += 15;
  if (canonicalHeading.includes(name)) score += 35;

  const registerWord = normalizeForSearch(symbol);
  if (registerWord && searchText.includes(`${registerWord} register`)) score += 30;
  if (registerWord && searchText.includes(`register ${registerWord}`)) score += 25;

  if (/\b(Register|Registers|Register Description|Register Descriptions)\b/i.test(text)) score += 18;
  if (/\b(Address|Offset)\s*:?\b/i.test(text)) score += 14;
  if (/\bInitial\s+Value\s*:?\b/i.test(text)) score += 12;
  if (/\bAccess\s+Size\s*:?\b/i.test(text)) score += 10;
  if (/\bBit\s+Name\b/i.test(text)) score += 12;
  if (/\bDescription\b/i.test(text)) score += 4;

  const occurrenceCount = (canonicalSymbol(text).match(new RegExp(escapeRegExp(name), "g")) || []).length;
  score += Math.min(occurrenceCount * 3, 24);

  return score;
}

export function nearestSectionForPage(sectionsIndex, pageNumber) {
  if (!sectionsIndex || !Array.isArray(sectionsIndex.sections)) return null;

  let best = null;
  for (const section of sectionsIndex.sections) {
    if (Number(section.page) > Number(pageNumber)) continue;
    if (!best || section.page > best.page || (section.page === best.page && section.level > best.level)) {
      best = section;
    }
  }

  return best
    ? {
        id: best.id,
        title: best.title,
        page: best.page,
        level: best.level,
        type: best.type,
      }
    : null;
}

export function collectRegisterSymbolsFromChunk(chunk) {
  const symbols = new Set();

  for (const value of chunk.registers || []) {
    if (looksLikeRegisterSymbol(value)) symbols.add(value);
  }

  for (const heading of chunk.headings || []) {
    for (const value of detectRegisters(heading)) {
      if (looksLikeRegisterSymbol(value)) symbols.add(value);
    }
  }

  return [...symbols];
}

export function normalizeRegisterDisplayName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

export function extractRegisterTableRowsFromPage(page) {
  const rows = [];
  const text = String(page.text || "");
  if (!/Register\s+Name\s+Abbreviation\s+Initial\s+Value\s+Offset\s+Address/i.test(text)) {
    return rows;
  }

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    // Example:
    // Next0 Source Address Register n  DMACm_N0SA_n  0000_0000h  0000h + k x 0040h  32
    const match = line.match(/^(.+?)\s+([A-Z][A-Za-z0-9]*m_[A-Za-z0-9_]+(?:_n)?)\s+([0-9A-Fa-f_]+h|-)\s+(.+?)\s+(\d+|-)\s*$/);
    if (!match) continue;

    const [, description, abbreviation, initialValue, offsetAddress, accessSize] = match;
    const cleanedDescription = normalizeRegisterDisplayName(description);

    if (!cleanedDescription || /^Reserve$/i.test(cleanedDescription) || abbreviation === "-") continue;

    rows.push({
      name: abbreviation.trim(),
      displayName: abbreviation.trim(),
      description: cleanedDescription,
      initialValue: initialValue.trim(),
      offsetAddress: normalizeRegisterDisplayName(offsetAddress),
      accessSize: accessSize.trim(),
      page: page.page,
      sourceKind: "register-list-table",
      confidenceBoost: 90,
    });
  }

  return rows;
}

export function extractRegisterDescriptionHeadings(chunk) {
  const rows = [];
  const headings = chunk.headings || [];
  const sources = [...headings, ...String(chunk.text || "").split("\n").slice(0, 8)];

  for (const line of sources) {
    const match = String(line).match(/(?:^|\s)(\d+(?:\.\d+){2,})\s+(.+?Register(?:\s+n)?)[^()]*\(([^()]*[A-Za-z0-9]m_[A-Za-z0-9_]+(?:_n)?[^()]*)\)/i);
    if (!match) continue;

    const [, sectionNumber, description, symbolGroup] = match;
    for (const symbolMatch of symbolGroup.matchAll(/\b[A-Z][A-Za-z0-9]*m_[A-Za-z0-9_]+(?:_n)?\b/g)) {
      const name = symbolMatch[0].trim();
      rows.push({
        name,
        displayName: name,
        description: normalizeRegisterDisplayName(description),
        sectionNumber,
        page: chunk.page,
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
        sourceKind: "register-description-heading",
        confidenceBoost: 75,
      });
    }
  }

  return rows;
}

export function upsertRegisterCandidate(byName, candidate, chunk = null, sectionsIndex = null) {
  const canonical = normalizeRegisterName(candidate.name);
  if (!canonical || !looksLikeRegisterSymbol(candidate.name)) return;

  const current = byName.get(canonical) || {
    name: canonical,
    displayName: candidate.displayName || candidate.name,
    aliases: new Set(),
    pages: new Set(),
    chunks: new Map(),
    headings: new Set(),
    sections: new Map(),
    descriptions: new Set(),
    offsets: new Set(),
    initialValues: new Set(),
    accessSizes: new Set(),
    sourceKinds: new Set(),
    totalScore: 0,
    occurrenceCount: 0,
  };

  current.displayName = current.displayName || candidate.displayName || candidate.name;
  current.aliases.add(candidate.name);
  current.aliases.add(candidate.displayName || candidate.name);
  current.aliases.add(canonical);
  for (const alias of registerAliasCandidates(candidate.name)) current.aliases.add(alias);

  if (candidate.description) current.descriptions.add(candidate.description);
  if (candidate.offsetAddress) current.offsets.add(candidate.offsetAddress);
  if (candidate.initialValue) current.initialValues.add(candidate.initialValue);
  if (candidate.accessSize) current.accessSizes.add(candidate.accessSize);
  if (candidate.sourceKind) current.sourceKinds.add(candidate.sourceKind);

  const page = Number(candidate.page || (chunk && chunk.page));
  if (Number.isFinite(page)) current.pages.add(page);

  const occurrenceScore = Number(candidate.score || candidate.confidenceBoost || 0) + (chunk ? scoreRegisterOccurrence(candidate.name, chunk) : 0);
  current.totalScore += Math.max(1, occurrenceScore);
  current.occurrenceCount += 1;

  if (chunk) {
    for (const heading of chunk.headings || []) current.headings.add(heading);

    const previousChunk = current.chunks.get(chunk.id);
    if (!previousChunk || occurrenceScore > previousChunk.score) {
      current.chunks.set(chunk.id, {
        id: chunk.id,
        page: chunk.page,
        chunkIndex: chunk.chunkIndex,
        score: occurrenceScore,
        headings: (chunk.headings || []).slice(0, 5),
        preview: normalizeText(chunk.text || "").slice(0, 500),
      });
    }
  } else if (candidate.chunkId) {
    const previousChunk = current.chunks.get(candidate.chunkId);
    if (!previousChunk || occurrenceScore > previousChunk.score) {
      current.chunks.set(candidate.chunkId, {
        id: candidate.chunkId,
        page,
        chunkIndex: candidate.chunkIndex ?? 0,
        score: occurrenceScore,
        headings: [],
        preview: candidate.description || "",
      });
    }
  }

  const nearestSection = nearestSectionForPage(sectionsIndex, page);
  if (nearestSection) current.sections.set(nearestSection.id, nearestSection);

  byName.set(canonical, current);
}

export async function buildRegistersIndex(filename, indexData = null, sectionsIndex = null, tablesIndex = null) {
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const source = await getPdfSourceInfo(filename);
  const chunkIndex = indexData || (await loadPdfIndex(filename));
  const sectionIndexData = sectionsIndex || (await getSectionsIndex(filename));
  const pageCache = await getPagesCache(filename);
  const byName = new Map();
  const tableIndexData = tablesIndex || await loadTablesIndex(filename).catch(() => null);

  // Coordinate tables preserve columns and row provenance better than flattened page text.
  for (const table of tableIndexData?.tables || []) {
    if (table.kind !== "register-table") continue;
    for (const row of extractRegisterRowsFromCoordinateTable(table)) {
      upsertRegisterCandidate(byName, {
        name: row.register,
        displayName: row.register,
        page: row.page,
        offsetAddress: row.offsetAddress,
        initialValue: row.initialValue,
        accessSize: row.accessSize,
        description: row.description,
        sourceKind: "tables-index",
        confidenceBoost: Math.max(50, Number(row.confidence || 0)),
      }, null, sectionIndexData);
    }
  }

  // Highest-confidence source: the module's explicit "List of Registers" table.
  for (const page of pageCache.pages || []) {
    for (const candidate of extractRegisterTableRowsFromPage(page)) {
      upsertRegisterCandidate(byName, candidate, null, sectionIndexData);
    }
  }

  // Next source: individual register-description headings.
  for (const chunk of chunkIndex.chunks || []) {
    for (const candidate of extractRegisterDescriptionHeadings(chunk)) {
      upsertRegisterCandidate(byName, candidate, chunk, sectionIndexData);
    }
  }

  // Fallback source: symbol scan in chunks. This is useful for find_register,
  // but list_registers hides low-confidence symbol-only candidates by default.
  for (const chunk of chunkIndex.chunks || []) {
    const symbols = collectRegisterSymbolsFromChunk(chunk);
    for (const symbol of symbols) {
      upsertRegisterCandidate(
        byName,
        {
          name: symbol,
          displayName: symbol,
          page: chunk.page,
          sourceKind: "symbol-scan",
          confidenceBoost: 10,
        },
        chunk,
        sectionIndexData
      );
    }
  }

  const registers = [...byName.values()]
    .map((entry) => {
      const pages = [...entry.pages].sort((a, b) => a - b);
      const chunks = [...entry.chunks.values()].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.page !== b.page) return a.page - b.page;
        return a.chunkIndex - b.chunkIndex;
      });
      const sourceKinds = [...entry.sourceKinds];
      const hasExplicitTable = sourceKinds.includes("register-list-table");
      const hasDescriptionHeading = sourceKinds.includes("register-description-heading");
      const confidence = Math.max(
        1,
        Math.min(
          99,
          Math.round(
            Math.min(55, entry.totalScore / Math.max(1, entry.occurrenceCount)) +
              Math.min(18, entry.occurrenceCount * 2) +
              Math.min(8, pages.length) +
              (hasExplicitTable ? 25 : 0) +
              (hasDescriptionHeading ? 15 : 0)
          )
        )
      );

      return {
        name: entry.name,
        displayName: entry.displayName,
        filename,
        aliases: [...entry.aliases].map(String).filter(Boolean).slice(0, 32),
        pages,
        chunks: chunks.slice(0, 24),
        sections: [...entry.sections.values()].slice(0, 8),
        headings: [...entry.headings].slice(0, 12),
        descriptions: [...entry.descriptions].slice(0, 6),
        offsetAddresses: [...entry.offsets].slice(0, 6),
        initialValues: [...entry.initialValues].slice(0, 6),
        accessSizes: [...entry.accessSizes].slice(0, 6),
        sourceKinds,
        isExplicitRegister: hasExplicitTable || hasDescriptionHeading,
        occurrenceCount: entry.occurrenceCount,
        confidence,
        searchText: normalizeForSearch([
          entry.name,
          entry.displayName,
          ...entry.aliases,
          ...entry.headings,
          ...entry.descriptions,
          ...entry.offsets,
          ...[...entry.sections.values()].map((section) => section.title),
        ].join("\n")),
        canonicalName: entry.name,
      };
    })
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (a.pages[0] !== b.pages[0]) return a.pages[0] - b.pages[0];
      return a.name.localeCompare(b.name);
    });

  const registerIndexData = {
    schemaVersion: REGISTER_INDEX_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    dependencyVersions: { "chunk-index": chunkIndex.schemaVersion, sections: sectionIndexData.schemaVersion, tables: tableIndexData?.schemaVersion || null },
    pageCount: chunkIndex.pageCount,
    chunkCount: chunkIndex.chunkCount || (chunkIndex.chunks || []).length,
    registerCount: registers.length,
    registers,
  };

  const registersPath = safeRegistersIndexPath(filename);
  await atomicWriteJson(registersPath, registerIndexData);

  return registerIndexData;
}

export async function loadRegistersIndex(filename) {
  const registersPath = safeRegistersIndexPath(filename);

  if (!(await pathExists(registersPath))) {
    return null;
  }

  try {
    const indexData = await readJsonCached(registersPath);

    if (indexData.schemaVersion !== REGISTER_INDEX_SCHEMA_VERSION) return null;
    if (indexData.filename !== filename) return null;
    if (!Array.isArray(indexData.registers)) return null;

    const currentSource = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(indexData.source, currentSource)) return null;

    return indexData;
  } catch {
    return null;
  }
}

export async function getRegistersIndex(filename, options = {}) {
  const existing = await loadRegistersIndex(filename);
  if (existing) return existing;

  if (options.buildIfMissing === true) {
    const indexData = await loadPdfIndex(filename, { buildIfMissing: true });
    const sectionsIndex = await getSectionsIndex(filename, { buildIfMissing: true });
    return buildRegistersIndex(filename, indexData, sectionsIndex);
  }

  throw new Error(`Registers index not found for ${filename}. Run index_pdf or start_index_pdf first.`);
}

export function scoreRegisterIndexEntry(entry, register) {
  const q = tokenizeQuery(register);
  if (!q.normalized && !q.canonical) return 0;

  const canonicalName = entry.canonicalName || normalizeRegisterName(entry.name);
  const aliases = (entry.aliases || []).map((alias) => ({
    raw: alias,
    canonical: normalizeRegisterName(alias),
    normalized: normalizeForSearch(alias),
  }));

  let score = 0;

  if (q.canonical) {
    if (canonicalName === q.canonical) score += 180;
    else if (aliases.some((alias) => alias.canonical === q.canonical)) score += 160;
    else if (canonicalName.endsWith(q.canonical) || q.canonical.endsWith(canonicalName)) score += 85;
    else if (canonicalName.includes(q.canonical) || q.canonical.includes(canonicalName)) score += 45;
  }

  if (q.normalized) {
    if ((entry.searchText || "").includes(q.normalized)) score += 35;
    if (aliases.some((alias) => alias.normalized === q.normalized)) score += 90;
    if (aliases.some((alias) => alias.normalized.includes(q.normalized))) score += 35;
  }

  for (const symbolTerm of q.symbolTerms) {
    if (canonicalName === symbolTerm) score += 80;
    else if (aliases.some((alias) => alias.canonical === symbolTerm)) score += 65;
    else if (canonicalName.includes(symbolTerm)) score += 20;
  }

  score += Math.min(Number(entry.confidence || 0), 99) / 5;
  score += Math.min(Number(entry.occurrenceCount || 0), 15);

  return Math.round(score);
}

export async function searchRegistersIndex(filename, register, topK = DEFAULT_TOP_K) {
  const registerIndex = await getRegistersIndex(filename);
  const k = clampTopK(topK);

  const results = registerIndex.registers
    .map((entry) => ({
      ...entry,
      score: scoreRegisterIndexEntry(entry, register),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const aPage = a.pages && a.pages.length ? a.pages[0] : Number.MAX_SAFE_INTEGER;
      const bPage = b.pages && b.pages.length ? b.pages[0] : Number.MAX_SAFE_INTEGER;
      return aPage - bPage;
    })
    .slice(0, k);

  return {
    registerIndex,
    results,
  };
}

export function formatRegisterIndexResults(results, query) {
  if (!results.length) {
    return `No register-index results found for "${query}".`;
  }

  return [
    `Register index results for "${query}"`,
    "",
    ...results.map((entry, index) => {
      const bestChunks = (entry.chunks || []).slice(0, 5);
      const pages = (entry.pages || []).join(", ") || "unknown";
      const sections = (entry.sections || [])
        .slice(0, 4)
        .map((section) => `${section.title} (page ${section.page})`)
        .join(" | ") || "none";
      const headings = (entry.headings || []).slice(0, 4).join(" | ") || "none";

      return [
        `Result ${index + 1}`,
        `Register: ${entry.displayName || entry.name}`,
        `Canonical name: ${entry.name}`,
        `Aliases: ${(entry.aliases || []).slice(0, 12).join(", ") || "none"}`,
        `Pages: ${pages}`,
        `Confidence: ${entry.confidence}`,
        `Score: ${entry.score}`,
        `Occurrences: ${entry.occurrenceCount}`,
        `Nearest sections: ${sections}`,
        `Headings: ${headings}`,
        `Related chunks: ${bestChunks.map((chunk) => chunk.id).join(", ") || "none"}`,
        bestChunks.length
          ? `Suggested read: read_pdf_pages(filename="${entry.filename || ""}", start_page=${bestChunks[0].page}, end_page=${Math.min(bestChunks[0].page + DEFAULT_PAGE_RANGE - 1, Math.max(...(entry.pages || [bestChunks[0].page])))})`
          : "Suggested read: none",
        bestChunks.length ? `Best preview:\n${bestChunks[0].preview}` : "Best preview: none",
      ].join("\n");
    }),
  ].join("\n\n---\n\n");
}


export function scoreRegisterListEntry(entry, filter) {
  const rawFilter = String(filter || "").trim();

  if (!rawFilter) {
    return Math.round(Number(entry.confidence || 0) + Math.min(Number(entry.occurrenceCount || 0), 20));
  }

  const normalizedFilter = normalizeForSearch(rawFilter);
  const canonicalFilter = normalizeRegisterName(rawFilter);
  const searchText = String(entry.searchText || "");
  const canonicalName = entry.canonicalName || normalizeRegisterName(entry.name);
  const aliases = (entry.aliases || []).map((alias) => ({
    raw: alias,
    canonical: normalizeRegisterName(alias),
    normalized: normalizeForSearch(alias),
  }));

  let score = 0;

  if (canonicalFilter) {
    if (canonicalName === canonicalFilter) score += 180;
    else if (aliases.some((alias) => alias.canonical === canonicalFilter)) score += 160;
    else if (canonicalName.startsWith(canonicalFilter)) score += 95;
    else if (canonicalName.includes(canonicalFilter)) score += 60;
    else if (aliases.some((alias) => alias.canonical.includes(canonicalFilter))) score += 45;
  }

  if (normalizedFilter) {
    if (searchText.includes(normalizedFilter)) score += 35;
    if (aliases.some((alias) => alias.normalized === normalizedFilter)) score += 90;
    if (aliases.some((alias) => alias.normalized.includes(normalizedFilter))) score += 35;
  }

  score += Math.min(Number(entry.confidence || 0), 99) / 8;
  score += Math.min(Number(entry.occurrenceCount || 0), 20);

  return Math.round(score);
}

export async function listRegistersFromIndex(filename, options = {}) {
  const registerIndex = await getRegistersIndex(filename);
  const filter = String(options.filter || "").trim();
  const topK = clampRegisterListTopK(options.topK);
  const includeLowConfidence = Boolean(options.includeLowConfidence);

  let registers = (registerIndex.registers || [])
    .filter((entry) => includeLowConfidence || entry.isExplicitRegister || Number(entry.confidence || 0) >= 70)
    .map((entry) => ({
    ...entry,
    score: scoreRegisterListEntry(entry, filter),
  }));

  if (filter) {
    registers = registers.filter((entry) => entry.score > 0);
  }

  registers = registers
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const aPage = a.pages && a.pages.length ? a.pages[0] : Number.MAX_SAFE_INTEGER;
      const bPage = b.pages && b.pages.length ? b.pages[0] : Number.MAX_SAFE_INTEGER;
      if (aPage !== bPage) return aPage - bPage;
      return String(a.name || "").localeCompare(String(b.name || ""));
    })
    .slice(0, topK);

  return {
    registerIndex,
    filter,
    results: registers,
  };
}

export function formatRegisterListResults(registerIndex, results, filter) {
  const total = Number(registerIndex.registerCount || (registerIndex.registers || []).length || 0);
  const filterText = String(filter || "").trim();

  if (!results.length) {
    return [
      filterText
        ? `No registers found in ${registerIndex.filename} for filter "${filterText}".`
        : `No registers found in ${registerIndex.filename}.`,
      `Register index path: ${safeRegistersIndexPath(registerIndex.filename)}`,
      "Try index_pdf(filename=..., force=true) to rebuild the register index, or use find_register for a specific symbol.",
    ].join("\n");
  }

  return [
    filterText
      ? `Detected registers in ${registerIndex.filename} matching "${filterText}"`
      : `Detected registers in ${registerIndex.filename}`,
    `Total detected in index: ${total}`,
    `Shown: ${results.length}`,
    `Register index created: ${registerIndex.createdAt}`,
    `Default view: explicit register-list/description entries; pass include_low_confidence=true to include symbol-only candidates.`,
    "",
    ...results.map((entry, index) => {
      const pages = (entry.pages || []).slice(0, 12).join(", ") || "unknown";
      const pageSuffix = (entry.pages || []).length > 12 ? ", ..." : "";
      const sections = (entry.sections || [])
        .slice(0, 2)
        .map((section) => `${section.title} (page ${section.page})`)
        .join(" | ") || "none";
      const bestChunks = (entry.chunks || []).slice(0, 3);
      const chunkIds = bestChunks.map((chunk) => chunk.id).join(", ") || "none";
      const aliases = (entry.aliases || [])
        .filter((alias) => alias !== entry.name && alias !== entry.displayName)
        .slice(0, 8)
        .join(", ") || "none";
      const description = (entry.descriptions || [])[0] || "unknown";
      const offset = (entry.offsetAddresses || [])[0] || "unknown";
      const initialValue = (entry.initialValues || [])[0] || "unknown";
      const accessSize = (entry.accessSizes || [])[0] || "unknown";
      const sourceKinds = (entry.sourceKinds || []).join(", ") || "unknown";
      const firstPage = (entry.pages || [])[0];
      const suggestedRead = firstPage
        ? `read_pdf_pages(filename="${entry.filename || registerIndex.filename}", start_page=${firstPage}, end_page=${Math.min(firstPage + DEFAULT_PAGE_RANGE - 1, registerIndex.pageCount || firstPage)})`
        : "none";

      return [
        `${index + 1}. ${entry.displayName || entry.name}`,
        `   Canonical: ${entry.name}`,
        `   Description: ${description}`,
        `   Offset address: ${offset}`,
        `   Initial value: ${initialValue}`,
        `   Access size: ${accessSize}`,
        `   Pages: ${pages}${pageSuffix}`,
        `   Source: ${sourceKinds}`,
        `   Confidence: ${entry.confidence}`,
        `   Occurrences: ${entry.occurrenceCount}`,
        `   Score: ${entry.score}`,
        `   Aliases: ${aliases}`,
        `   Nearest sections: ${sections}`,
        `   Related chunks: ${chunkIds}`,
        `   Suggested find: find_register(filename="${entry.filename || registerIndex.filename}", register="${entry.name}")`,
        `   Suggested read: ${suggestedRead}`,
      ].join("\n");
    }),
  ].join("\n\n");
}

export function buildSearchText(chunk) {
  return [
    chunk.text || "",
    ...(chunk.headings || []),
    ...(chunk.registers || []),
    ...(chunk.bitFields || []),
  ].join("\n");
}

export async function buildPdfIndex(filename, options = {}) {
  return withIndexBuildLock(filename, {
    forceLock: Boolean(options.forceLock),
  }, async () => {
    await fs.mkdir(INDEX_DIR, { recursive: true });
    await getFileStat(filename);

    const chunkSize = clampChunkSize(options.chunkSize);
    const chunkOverlap = clampChunkOverlap(options.chunkOverlap, chunkSize);

    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    if (onProgress) onProgress({ phase: "start", current: 0, total: 0, unit: "" });

    let pageCache = null;
    if (options.reusePageCache !== false) pageCache = await loadPagesCache(filename);
    if (!pageCache) {
      if (onProgress) onProgress({ phase: "build-pages-cache", current: 0, total: 0, unit: "" });
      pageCache = await buildPagesCache(filename, { onProgress, onWorkerContext: options.onWorkerContext, onWorkerSpawn: options.onWorkerSpawn, onWorkerStderr: options.onWorkerStderr, extractionEngine: options.extractionEngine });
    } else if (onProgress) {
      onProgress({ phase: "reuse-pages-cache", current: pageCache.pageCount, total: pageCache.pageCount, unit: "pages" });
    }

  const pdfData = {
    filename,
    pageCount: pageCache.pageCount,
    pages: pageCache.pages,
  };

  const pdfStat = await getFileStat(filename);
  const sectionsIndex = await buildSectionsIndex(filename, pageCache);
  const chunks = [];

  for (const page of pdfData.pages) {
    if (onProgress && (page.page === 1 || page.page === pdfData.pageCount || page.page % 25 === 0)) {
      onProgress({ phase: "chunk-pages", current: page.page, total: pdfData.pageCount, unit: "pages" });
    }
    const pageHeadings = detectHeadings(page.text);
    const pageChunks = chunkText(page.text, chunkSize, chunkOverlap);

    pageChunks.forEach((chunkTextValue, index) => {
      const headings = [...new Set([...pageHeadings, ...detectHeadings(chunkTextValue)])].slice(0, 12);
      const registers = detectRegisters(chunkTextValue);
      const bitFields = detectBitFields(chunkTextValue);
      const id = `${filename}:p${page.page}:c${index}`;
      const chunkProfile = classifyChunkProfile(chunkTextValue, {
        headings,
        registers,
        bitFields,
        page: page.page,
      });

      chunks.push({
        id,
        filename,
        page: page.page,
        chunkIndex: index,
        headings,
        registers,
        bitFields,
        chunkType: chunkProfile.chunkType,
        chunkTypes: chunkProfile.chunkTypes,
        chunkTypeSignals: chunkProfile.signals,
        noiseScore: chunkProfile.noiseScore,
        contentScore: chunkProfile.contentScore,
        text: chunkTextValue,
        searchText: normalizeForSearch([chunkTextValue, ...headings, ...registers, ...bitFields, chunkProfile.chunkType, ...(chunkProfile.chunkTypes || [])].join("\n")),
        symbols: [...new Set([...registers, ...bitFields].map(canonicalSymbol).filter(Boolean))],
      });
    });
  }

  const indexData = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    sourceSize: pdfStat.size,
    sourceModifiedMs: pdfStat.mtimeMs,
    pageCount: pdfData.pageCount,
    chunkCount: chunks.length,
    chunkTypeStats: summarizeChunkTypes(chunks),
    chunkSize,
    chunkOverlap,
    sectionCount: sectionsIndex.sectionCount,
    registerCount: 0,
    chunks,
  };

  const workerOptions = { onProgress, onWorkerContext: options.onWorkerContext, onWorkerSpawn: options.onWorkerSpawn, onWorkerStderr: options.onWorkerStderr, extractionEngine: options.extractionEngine };
  const structured = await buildStructuredArtifacts(filename, indexData, pageCache, sectionsIndex, workerOptions);
  let tablesIndex;
  let registersIndex;
  let bitfieldsIndex;
  let cautionsIndex;
  if (structured) {
    ({ tables: tablesIndex, registers: registersIndex, bitfields: bitfieldsIndex, cautions: cautionsIndex } = structured);
  } else {
    if (onProgress) onProgress({ phase: "build-tables-index", current: 0, total: 0, unit: "" });
    tablesIndex = await buildTablesIndex(filename, indexData, pageCache, sectionsIndex, workerOptions);
    if (onProgress) onProgress({ phase: "build-registers-index", current: 0, total: 0, unit: "" });
    registersIndex = await buildRegistersIndex(filename, indexData, sectionsIndex, tablesIndex);
    if (onProgress) onProgress({ phase: "build-bitfields-index", current: 0, total: 0, unit: "" });
    bitfieldsIndex = await buildBitfieldsIndex(filename, indexData, registersIndex, tablesIndex);
    if (onProgress) onProgress({ phase: "build-cautions-index", current: 0, total: 0, unit: "" });
    cautionsIndex = await buildCautionsIndex(filename, indexData, sectionsIndex, registersIndex);
  }
  indexData.tableCount = tablesIndex.tableCount;
  indexData.registerCount = registersIndex.registerCount;
  indexData.bitfieldCount = bitfieldsIndex.bitfieldCount;
  indexData.cautionCount = cautionsIndex.cautionCount;

  if (onProgress) onProgress({ phase: "build-sequences-index", current: 0, total: 0, unit: "" });
  const sequencesIndex = await buildSequencesIndex(filename, indexData, sectionsIndex, registersIndex, { tablesIndex, bitfieldsIndex, cautionsIndex });
  indexData.sequenceCount = sequencesIndex.sequenceCount;

  if (onProgress) onProgress({ phase: "build-figures-index", current: 0, total: 0, unit: "" });
  const figuresIndex = await buildFiguresIndex(filename, pageCache);
  indexData.figureCount = figuresIndex.figureCount;

    if (onProgress) onProgress({ phase: "write-index", current: 0, total: 0, unit: "" });
    const indexPath = safeIndexPath(filename);
    await atomicWriteJson(indexPath, indexData);
    await writeArtifactManifest(filename, { buildStatus: "ready", notes: ["full index build completed"], clearStale: true, producer: tablesIndex.producer || pageCache.producer || { engine: "node" } });

    return indexData;
  });
}

export function isIndexUsable(indexData, pdfStat) {
  if (!indexData || typeof indexData !== "object") return false;
  if (indexData.schemaVersion !== INDEX_SCHEMA_VERSION) return false;
  if (!Array.isArray(indexData.chunks)) return false;
  if (Number(indexData.sourceSize) !== Number(pdfStat.size)) return false;

  const indexedMtime = Number(indexData.sourceModifiedMs || 0);
  if (!Number.isFinite(indexedMtime) || indexedMtime <= 0) return false;

  // Some filesystems have coarse mtime resolution, so allow a small delta.
  return Math.abs(indexedMtime - Number(pdfStat.mtimeMs)) < 1500;
}

export async function loadPdfIndex(filename, options = {}) {
  const indexPath = safeIndexPath(filename);
  const pdfStat = await getFileStat(filename);

  if (!(await pathExists(indexPath))) {
    if (options.buildIfMissing === true) {
      return buildPdfIndex(filename, options.buildOptions || {});
    }
    throw new Error(`Index not found for ${filename}. Run index_pdf or start_index_pdf first. Large manuals should be indexed in background with start_index_pdf.`);
  }

  try {
    const indexData = await readJsonCached(indexPath);

    if (isIndexUsable(indexData, pdfStat)) return indexData;

    if (options.rebuildIfStale === true) {
      return buildPdfIndex(filename, options.buildOptions || {});
    }

    throw new Error(
      `Index is stale or incompatible for ${filename}. Run index_pdf with force=true or start_index_pdf. Large manuals should be indexed in background.`
    );
  } catch (error) {
    if (options.rebuildIfBroken === true) return buildPdfIndex(filename, options.buildOptions || {});
    throw error;
  }
}
