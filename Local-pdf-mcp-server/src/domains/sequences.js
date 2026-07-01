import { appendEvidenceContract, atomicWriteJson, canonicalSymbol, clampBitfieldListTopK, clampInteger, clampRegisterListTopK, clampTopK, escapeRegExp, getPdfSourceInfo, isSamePdfSource, makeEvidence, makeEvidenceContract, makeInference, makeNeedsVerification, normalizeForSearch, normalizeText, pathExists, readJsonCached, safeSequencesIndexPath } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { DEFAULT_CAUTION_TOP_K, DEFAULT_DRIVER_PACK_REGISTERS, DEFAULT_DRIVER_PACK_SUMMARIES, DEFAULT_DRIVER_TASK_REGISTERS, DEFAULT_PAGE_RANGE, DEFAULT_REGISTER_SUMMARY_CHUNKS, DEFAULT_SEQUENCE_INDEX_TOPICS, DEFAULT_SEQUENCE_LIST_TOP_K, DEFAULT_SEQUENCE_TOP_K, DEFAULT_TABLE_PAGE_RANGE, DEFAULT_TOP_K, INDEX_DIR, MAX_BITFIELD_TABLE_ROWS, MAX_CAUTION_EVIDENCE_LINES, MAX_CAUTION_TOP_K, MAX_DRIVER_PACK_REGISTERS, MAX_DRIVER_PACK_SUMMARIES, MAX_DRIVER_TASK_REGISTERS, MAX_EXTRACTED_TABLES, MAX_PREVIEW_CHARS, MAX_REGISTER_SUMMARY_BITFIELDS, MAX_REGISTER_SUMMARY_CHUNKS, MAX_SEQUENCE_EVIDENCE_LINES, MAX_SEQUENCE_INDEX_RESULTS_PER_TOPIC, MAX_SEQUENCE_LIST_TOP_K, MAX_SEQUENCE_TOP_K, MAX_TABLE_COLUMNS, MAX_TABLE_PAGE_RANGE, MAX_TABLE_ROWS_PER_TABLE, MAX_TOP_K, SEQUENCE_INDEX_SCHEMA_VERSION } from "../core/runtime-constants.js";
import fs from "node:fs/promises";
import { BITFIELD_NOISE_WORDS, normalizeBitfieldReset, normalizeHardwareRange, parseBitfieldSemantics } from "../bitfields/semantics.js";


const buildBitFieldQueries = createRuntimePort("buildBitFieldQueries");
const buildRegisterQueries = createRuntimePort("buildRegisterQueries");
const buildSearchText = createRuntimePort("buildSearchText");


const collectRegisterContext = createRuntimePort("collectRegisterContext");
const countWordOccurrences = createRuntimePort("countWordOccurrences");

const exactRegisterContextMatches = createRuntimePort("exactRegisterContextMatches");
const extractBitfieldTableFromIndex = createRuntimePort("extractBitfieldTableFromIndex");
const formatSearchResults = createRuntimePort("formatSearchResults");
const getPdfPageCount = createRuntimePort("getPdfPageCount");

const getRegistersIndex = createRuntimePort("getRegistersIndex");
const getBitfieldsIndex = createRuntimePort("getBitfieldsIndex");
const getSectionsIndex = createRuntimePort("getSectionsIndex");
const isNonRegisterSignal = createRuntimePort("isNonRegisterSignal");

const loadPdfDocument = createRuntimePort("loadPdfDocument");
const loadPdfIndex = createRuntimePort("loadPdfIndex");
const loadRegistersIndex = createRuntimePort("loadRegistersIndex");
const loadSectionsIndex = createRuntimePort("loadSectionsIndex");
const loadCautionsIndex = createRuntimePort("loadCautionsIndex");
const loadTablesIndex = createRuntimePort("loadTablesIndex");
const looksLikeRegisterSymbol = createRuntimePort("looksLikeRegisterSymbol");


const multiQuerySearch = createRuntimePort("multiQuerySearch");
const normalizeBitFieldName = createRuntimePort("normalizeBitFieldName");

const normalizeRegisterName = createRuntimePort("normalizeRegisterName");


const q = createRuntimePort("q");


const searchPdfIndex = createRuntimePort("searchPdfIndex");
const searchRegistersIndex = createRuntimePort("searchRegistersIndex");
const searchSectionsIndex = createRuntimePort("searchSectionsIndex");

export function clampSequenceTopK(value) {
  return clampInteger(value, DEFAULT_SEQUENCE_TOP_K, 1, MAX_SEQUENCE_TOP_K);
}

export function classifySequenceTopic(topic) {
  const normalized = normalizeForSearch(topic);
  const canonical = canonicalSymbol(topic);
  const kinds = new Set();

  if (/\b(init|initial|initialize|initialization|setup|setting|configure|configuration)\b/i.test(normalized)) kinds.add("init");
  if (/\b(start|enable|run|trigger|request|kick|resume|seten|tstart|transfer start)\b/i.test(normalized) || /SETEN|TSTART/.test(canonical)) kinds.add("start");
  if (/\b(stop|disable|halt|suspend|pause|cancel|clear enable|clren|clrrq)\b/i.test(normalized) || /CLREN|CLRRQ|SUSP/.test(canonical)) kinds.add("stop");
  if (/\b(clear|ack|acknowledge|status|flag|interrupt|w1c|write 1|write one|end|tc|er)\b/i.test(normalized)) kinds.add("clear");
  if (/\b(reset|software reset|swrst|module reset|rst)\b/i.test(normalized) || /SWRST|RESET/.test(canonical)) kinds.add("reset");
  if (/\b(interrupt|irq|request|event|status)\b/i.test(normalized)) kinds.add("interrupt");
  if (/\b(clock|reset release|module standby|mstp|pclk)\b/i.test(normalized)) kinds.add("clock-reset");

  if (!kinds.size) kinds.add("generic");
  return [...kinds];
}

export function buildSequenceQueries(topic, register = "") {
  const rawTopic = String(topic || "").trim();
  const rawRegister = String(register || "").trim();
  const kinds = classifySequenceTopic(rawTopic);
  const queries = new Set();

  const add = (value) => {
    const text = String(value || "").trim();
    if (text) queries.add(text);
  };

  add(rawTopic);
  add(`${rawTopic} procedure`);
  add(`${rawTopic} operation`);
  add(`${rawTopic} sequence`);
  add(`${rawTopic} flow`);
  add(`${rawTopic} setting procedure`);
  add(`${rawTopic} register setting`);
  add(`${rawTopic} caution note restriction`);

  if (rawRegister) {
    add(`${rawRegister} ${rawTopic}`);
    add(`${rawRegister} procedure`);
    add(`${rawRegister} operation`);
    add(`${rawRegister} Bit Name Description`);
    add(`${rawRegister} caution note restriction`);
  }

  if (kinds.includes("init")) {
    add("initial setting procedure");
    add("initialization procedure");
    add("initial settings before operation");
    add("register setting procedure");
    add("clock reset setting procedure");
    add("before starting operation setting");
  }

  if (kinds.includes("start")) {
    add("start operation procedure");
    add("start transfer procedure");
    add("enable operation sequence");
    add("set enable bit start transfer");
    add("transfer request start");
    add("channel enable start");
    add("SETEN enable start");
  }

  if (kinds.includes("stop")) {
    add("stop operation procedure");
    add("disable operation sequence");
    add("stop transfer procedure");
    add("suspend channel procedure");
    add("clear enable bit stop");
    add("CLREN stop disable");
  }

  if (kinds.includes("clear")) {
    add("clear status flag procedure");
    add("clear interrupt status");
    add("write 1 to clear status");
    add("write 0 to clear status");
    add("transfer end clear");
    add("error status clear");
    add("status register clear flag");
  }

  if (kinds.includes("reset")) {
    add("software reset procedure");
    add("reset operation sequence");
    add("module reset procedure");
    add("reset release procedure");
    add("SWRST software reset");
  }

  if (kinds.includes("interrupt")) {
    add("interrupt handling procedure");
    add("interrupt status clear");
    add("interrupt enable setting");
    add("interrupt request clear");
    add("status flag interrupt");
  }

  if (kinds.includes("clock-reset")) {
    add("clock setting procedure");
    add("reset release setting");
    add("module standby release");
    add("PCLK clock enable reset");
  }

  return [...queries];
}

export function sequenceKeywordSet(topic, register = "") {
  const normalized = normalizeForSearch(`${topic} ${register}`);
  const words = normalized.split(/\s+/).filter((word) => word.length > 1);
  const keywords = new Set(words);

  const common = [
    "procedure", "sequence", "flow", "operation", "setting", "settings",
    "initial", "initialization", "initialize", "start", "stop", "enable",
    "disable", "clear", "reset", "software", "transfer", "request",
    "interrupt", "status", "flag", "error", "end", "complete", "completion",
    "write", "read", "set", "before", "after", "when", "while", "must",
    "should", "prohibit", "prohibited", "caution", "note", "restriction",
  ];

  for (const word of common) keywords.add(word);
  return keywords;
}

export function extractSequenceEvidenceLines(text, topic, register = "", maxLines = MAX_SEQUENCE_EVIDENCE_LINES) {
  const keywords = sequenceKeywordSet(topic, register);
  const topicTerms = normalizeForSearch(topic).split(/\s+/).filter((word) => word.length > 1);
  const registerCanonical = normalizeRegisterName(register);
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const scored = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const normalizedLine = normalizeForSearch(line);
    const canonicalLine = canonicalSymbol(line);
    let score = 0;

    for (const term of topicTerms) {
      if (term && normalizedLine.includes(term)) score += 18;
    }

    for (const word of keywords) {
      if (word && normalizedLine.includes(word)) score += 2;
    }

    if (registerCanonical && canonicalLine.includes(registerCanonical)) score += 25;
    if (/\b(procedure|sequence|flow|operation|setting|settings)\b/i.test(line)) score += 18;
    if (/\b(before|after|when|while|must|should|do not|prohibited|only|until)\b/i.test(line)) score += 20;
    if (/\b(write|read|set|clear|enable|disable|start|stop|reset|suspend|transfer|interrupt|status|flag)\b/i.test(line)) score += 12;
    if (/^\(?\d+\)?[.)]\s+/.test(line) || /^Step\s*\d+/i.test(line)) score += 16;
    if (/\b(Caution|Note|Notes|Restriction|Restrictions)\b/i.test(line)) score += 22;

    if (score <= 0) continue;

    const prev = index > 0 ? lines[index - 1] : "";
    const next = index + 1 < lines.length ? lines[index + 1] : "";
    scored.push({
      score,
      index,
      line: [prev, line, next].filter(Boolean).join(" / ").slice(0, 900),
    });
  }

  return scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .slice(0, maxLines)
    .map((item) => item.line);
}

export function scoreSequenceChunk(chunk, topic, register = "", registerContext = null, sectionContext = null) {
  const rawText = buildSearchText(chunk);
  const normalizedText = chunk.searchText || normalizeForSearch(rawText);
  const canonicalText = canonicalSymbol(rawText);
  const topicNormalized = normalizeForSearch(topic);
  const topicTerms = topicNormalized.split(/\s+/).filter((word) => word.length > 1);
  const registerCanonical = normalizeRegisterName(register);
  const evidenceLines = extractSequenceEvidenceLines(chunk.text || "", topic, register, 5);
  const kinds = classifySequenceTopic(topic);
  let score = 0;

  if (topicNormalized && normalizedText.includes(topicNormalized)) score += 70;

  for (const term of topicTerms) {
    if (countWordOccurrences(normalizedText, term)) score += 12;
    else if (normalizedText.includes(term)) score += 5;
  }

  if (registerCanonical && canonicalText.includes(registerCanonical)) score += 45;

  if (registerContext) {
    if (registerContext.chunkIds && registerContext.chunkIds.has(chunk.id)) score += 85;
    if (registerContext.pages && registerContext.pages.has(Number(chunk.page))) score += 30;
    if (registerContext.names) {
      for (const name of registerContext.names) {
        if (name && canonicalText.includes(name)) {
          score += 20;
          break;
        }
      }
    }
  }

  if (sectionContext) {
    if (sectionContext.pages && sectionContext.pages.has(Number(chunk.page))) score += 45;
    if (sectionContext.nearPages && sectionContext.nearPages.has(Number(chunk.page))) score += 22;
  }

  if (/\b(procedure|sequence|flow|operation|operations|setting|settings)\b/i.test(rawText)) score += 28;
  if (/\b(before|after|when|while|must|should|do not|prohibited|only|until)\b/i.test(rawText)) score += 24;
  if (/\b(Caution|Note|Notes|Restriction|Restrictions)\b/i.test(rawText)) score += 20;
  if (/^\(?\d+\)?[.)]\s+/m.test(rawText) || /^Step\s*\d+/im.test(rawText)) score += 25;

  if (kinds.includes("init") && /\b(initial|initialization|initialize|setting|configuration|configure|before)\b/i.test(rawText)) score += 30;
  if (kinds.includes("start") && /\b(start|enable|set|request|transfer|operation|SETEN|TSTART)\b/i.test(rawText)) score += 30;
  if (kinds.includes("stop") && /\b(stop|disable|clear|suspend|halt|CLREN|CLRRQ)\b/i.test(rawText)) score += 30;
  if (kinds.includes("clear") && /\b(clear|status|flag|interrupt|write\s*[01]|END|TC|ER)\b/i.test(rawText)) score += 32;
  if (kinds.includes("reset") && /\b(reset|software reset|SWRST|release)\b/i.test(rawText)) score += 32;
  if (kinds.includes("interrupt") && /\b(interrupt|IRQ|request|status|flag|enable|clear)\b/i.test(rawText)) score += 25;

  score += evidenceLines.length * 18;

  // Pure register-list rows are useful context but usually not the actual operation sequence.
  if (/\bRegister\s+Name\b/i.test(rawText) && !/\b(procedure|sequence|operation|Caution|Note)\b/i.test(rawText)) {
    score -= 30;
  }

  return Math.max(0, Math.round(score));
}

export function collectSectionContext(sectionResults) {
  const pages = new Set();
  const nearPages = new Set();

  for (const section of sectionResults || []) {
    const page = Number(section.page);
    if (!Number.isFinite(page)) continue;
    pages.add(page);
    for (let delta = -1; delta <= DEFAULT_PAGE_RANGE; delta++) {
      const nearPage = page + delta;
      if (nearPage > 0) nearPages.add(nearPage);
    }
  }

  return { pages, nearPages };
}

export async function findSequenceInIndex(filename, topic, options = {}) {
  const rawTopic = String(topic || "").trim();
  const rawRegister = String(options.register || "").trim();
  const topK = clampSequenceTopK(options.topK);
  if (!rawTopic) throw new Error("topic is required");

  const queries = buildSequenceQueries(rawTopic, rawRegister);
  const candidateMap = new Map();
  const searchTopK = Math.min(MAX_TOP_K, Math.max(topK * 3, DEFAULT_TOP_K));

  let registerResults = [];
  let registerContext = null;
  if (rawRegister) {
    const registerSearch = await searchRegistersIndex(filename, rawRegister, Math.max(topK, DEFAULT_TOP_K));
    registerResults = registerSearch.results;
    registerContext = collectRegisterContext(registerResults);
  }

  const sectionQueries = [rawTopic, `${rawTopic} operation`, `${rawTopic} procedure`, `${rawTopic} setting`, `${rawTopic} caution`];
  const sectionResultsById = new Map();
  for (const query of sectionQueries) {
    const { results } = await searchSectionsIndex(filename, query, Math.min(8, topK));
    for (const result of results) sectionResultsById.set(result.id, result);
  }
  const sectionResults = [...sectionResultsById.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.page - b.page;
    })
    .slice(0, 8);
  const sectionContext = collectSectionContext(sectionResults);

  for (const query of queries) {
    const { results } = await searchPdfIndex(filename, query, searchTopK);
    for (const result of results) {
      candidateMap.set(result.id, candidateMap.get(result.id) || result);
    }
  }

  // Pull chunks near matched sections and matched registers into the candidate set even if
  // lexical search missed them. Procedures often appear under headings with sparse repetition
  // of the exact query terms.
  const indexData = await loadPdfIndex(filename);
  for (const chunk of indexData.chunks || []) {
    const page = Number(chunk.page);
    const nearSection = sectionContext.nearPages && sectionContext.nearPages.has(page);
    const nearRegister = registerContext && registerContext.pages && registerContext.pages.has(page);
    const directRegisterChunk = registerContext && registerContext.chunkIds && registerContext.chunkIds.has(chunk.id);
    if (nearSection || nearRegister || directRegisterChunk) {
      candidateMap.set(chunk.id, candidateMap.get(chunk.id) || chunk);
    }
  }

  const results = [...candidateMap.values()]
    .map((chunk) => ({
      ...chunk,
      score: scoreSequenceChunk(chunk, rawTopic, rawRegister, registerContext, sectionContext),
      sequenceEvidence: extractSequenceEvidenceLines(chunk.text || "", rawTopic, rawRegister, MAX_SEQUENCE_EVIDENCE_LINES),
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, topK);

  return {
    filename,
    topic: rawTopic,
    register: rawRegister,
    queries,
    registerResults,
    sectionResults,
    results,
  };
}

export function formatSequenceResults(sequenceResult) {
  const filename = sequenceResult.filename;
  const topic = sequenceResult.topic;
  const register = sequenceResult.register;
  const results = sequenceResult.results || [];
  const registerResults = sequenceResult.registerResults || [];
  const sectionResults = sequenceResult.sectionResults || [];

  if (!results.length) {
    return [
      register
        ? `No sequence results found for "${topic}" in register context "${register}".`
        : `No sequence results found for "${topic}".`,
      "",
      "Suggested next steps:",
      `- Try find_section(filename="${filename}", section="${topic} operation").`,
      `- Try search_pdf(filename="${filename}", query="${topic} procedure sequence operation caution").`,
      register
        ? `- Try summarize_register(filename="${filename}", register="${register}").`
        : `- Try get_sequence with a related register, for example get_sequence(filename="${filename}", topic="${topic}", register="DMACm_CHCTRL_n").`,
    ].join("\n");
  }

  const header = [
    register
      ? `Sequence results for "${topic}" within register context "${register}"`
      : `Sequence results for "${topic}"`,
    `File: ${filename}`,
  ];

  if (register) {
    header.push(
      registerResults.length
        ? `Register context matches: ${registerResults.slice(0, 5).map((entry) => entry.displayName || entry.name).join(", ")}`
        : "Register context matches: none; used generic sequence search fallback."
    );
  }

  header.push(
    sectionResults.length
      ? `Relevant sections: ${sectionResults.slice(0, 5).map((section) => `${section.title} (page ${section.page})`).join(" | ")}`
      : "Relevant sections: none from section index."
  );

  const queryLine = sequenceResult.queries && sequenceResult.queries.length
    ? `Expanded queries: ${sequenceResult.queries.slice(0, 12).join(" | ")}`
    : "Expanded queries: none";

  return [
    ...header,
    queryLine,
    "",
    ...results.map((result, index) => {
      const preview = normalizeText(result.text || "").slice(0, MAX_PREVIEW_CHARS);
      const truncated = (result.text || "").length > MAX_PREVIEW_CHARS ? "..." : "";
      const evidence = (result.sequenceEvidence || []).length
        ? result.sequenceEvidence.map((line) => `   - ${line}`).join("\n")
        : "   - none";
      const endPage = Math.min(Number(result.page) + DEFAULT_PAGE_RANGE - 1, result.pageCount || Number(result.page) + DEFAULT_PAGE_RANGE - 1);

      return [
        `Result ${index + 1}`,
        `ID: ${result.id}`,
        `File: ${result.filename}`,
        `Page: ${result.page}`,
        `Chunk: ${result.chunkIndex}`,
        `Score: ${result.score}`,
        `Headings: ${(result.headings || []).join(" | ") || "none"}`,
        `Registers: ${(result.registers || []).join(", ") || "none"}`,
        `Bit fields / symbols: ${(result.bitFields || []).slice(0, 40).join(", ") || "none"}`,
        "Sequence evidence lines:",
        evidence,
        `Suggested chunk read: read_pdf_chunk(filename="${result.filename}", chunk_id="${result.id}")`,
        `Suggested page read: read_pdf_pages(filename="${result.filename}", start_page=${result.page}, end_page=${endPage})`,
        "Driver-review hint: verify the exact order of register writes and any before/after/caution conditions from the suggested page read.",
        "Preview:",
        `${preview}${truncated}`,
      ].join("\n");
    }),
  ].join("\n\n---\n\n");
}


export function clampSequenceListTopK(value) {
  return clampInteger(value, DEFAULT_SEQUENCE_LIST_TOP_K, 1, MAX_SEQUENCE_LIST_TOP_K);
}

export function normalizeSequenceTopic(topic) {
  return String(topic || "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSequenceBoilerplate(text) {
  const raw = String(text || "").trim();
  if (!raw) return true;
  if (/\b(REVISION HISTORY|copyright|all rights reserved|notation of numbers and symbols)\b/i.test(raw)) return true;
  if (/\b(bit names? and statements?|examples? and have nothing to do with|correct operation of this LSI chip is not guaranteed)\b/i.test(raw)) return true;
  if (/^(?:Note\s*:?)?\s*(?:Access to (?:the\s+)?reserved|Access to (?:the\s+)?unavailable|Settings other than the above are prohibited)/i.test(raw)) return true;
  if (/\.{2,}\s*\d+\s*$/.test(raw)) return true;
  return false;
}

export function isTrustedSequenceTopic(topic) {
  const raw = String(topic || "").replace(/^\d+(?:\.\d+)*\s+/, "").trim();
  if (!raw || raw.length > 160 || isSequenceBoilerplate(raw)) return false;
  if (!/\b(operation|procedure|sequence|setting|settings|initial|start|stop|clear|reset|interrupt|error|transfer|request|enable|disable|suspend|refresh|handling|control|write)\b/i.test(raw)) return false;
  if (/\bregister\b\s*(?:\([^)]*\))?\s*$/i.test(raw) && !/\b(operation|procedure|steps?)\b/i.test(raw)) return false;
  if (/[.!?]/.test(raw) && raw.split(/\s+/).length > 14) return false;
  return true;
}

export function inferSequenceOperation(text) {
  const raw = String(text || "");
  if (/\b(write|writes|written|program)\b/i.test(raw)) return "write";
  if (/\b(read|reads)\b/i.test(raw)) return "read";
  if (/\b(poll|wait until|until .*?(?:becomes|is set|is cleared))\b/i.test(raw)) return "poll";
  if (/\b(wait|delay|cycle|microsecond|millisecond|ns|us|ms)\b/i.test(raw)) return "wait";
  if (/\b(clear|cleared|write\s+1\s+to\s+clear)\b/i.test(raw)) return "clear";
  if (/\b(set|assert)\b/i.test(raw)) return "set";
  if (/\b(enable|start|trigger|request)\b/i.test(raw)) return "enable";
  if (/\b(disable|stop|suspend|deassert)\b/i.test(raw)) return "disable";
  return "other";
}

export function extractOrderedWritePair(text) {
  const raw = String(text || "");
  const direct = raw.match(/writing\s+(0x[0-9a-f]+|[0-9a-f]+h|[01]+b|\d+)\s+and\s+then\s+writing\s+(0x[0-9a-f]+|[0-9a-f]+h|[01]+b|\d+)\s+to\s+([A-Z][A-Z0-9_]*)/i);
  if (direct) return { firstValue: direct[1], secondValue: direct[2], registerHint: direct[3] };
  const ordered = raw.match(/write\s+to\s+(?:the\s+)?[^()]*\(([A-Z][A-Z0-9_]*)\)[\s\S]*?order\s+of\s+values?\s+from\s+(0x[0-9a-f]+|[0-9a-f]+h|[01]+b|\d+)\s+to\s+(0x[0-9a-f]+|[0-9a-f]+h|[01]+b|\d+)/i);
  if (ordered) return { firstValue: ordered[2], secondValue: ordered[3], registerHint: ordered[1] };
  return null;
}

function buildSequenceLookups(registersIndex, bitfieldsIndex) {
  const registersByPage = new Map();
  for (const entry of registersIndex?.registers || []) {
    for (const page of entry.pages || []) {
      const pageNumber = Number(page);
      if (!registersByPage.has(pageNumber)) registersByPage.set(pageNumber, []);
      registersByPage.get(pageNumber).push(entry);
    }
  }
  const bitfieldsByRegister = new Map();
  for (const entry of bitfieldsIndex?.bitfields || []) {
    const key = canonicalSymbol(entry.register);
    if (!bitfieldsByRegister.has(key)) bitfieldsByRegister.set(key, []);
    bitfieldsByRegister.get(key).push(entry);
  }
  return { registersByPage, bitfieldsByRegister };
}

function sequenceLineRegister(line, registersIndex, chunk, lookups) {
  const canonical = canonicalSymbol(line);
  const chunkNames = [...(chunk?.registers || [])];
  for (const name of chunkNames) {
    const nameCanonical = canonicalSymbol(name);
    if (!canonical.includes(nameCanonical)) continue;
    const concrete = (registersIndex?.registers || []).filter((entry) =>
      [entry.displayName, entry.name, ...(entry.aliases || [])]
        .filter(Boolean)
        .some((candidate) => canonicalSymbol(candidate) === nameCanonical || canonicalSymbol(candidate).endsWith(nameCanonical))
    );
    if (concrete.length === 1) return concrete[0].displayName || concrete[0].name;
    if (concrete.length > 1) {
      const moduleHint = String(line || "").match(/\b(WDT|DMAC|ADC|RSPI)\b/i)?.[1];
      if (moduleHint) {
        const moduleCanonical = canonicalSymbol(moduleHint);
        const moduleMatch = concrete.find((entry) => canonicalSymbol(entry.displayName || entry.name).startsWith(`${moduleCanonical}M`));
        if (moduleMatch) return moduleMatch.displayName || moduleMatch.name;
      }
    }
    return name;
  }
  const pageEntries = lookups.registersByPage.get(Number(chunk?.page)) || [];
  for (const entry of pageEntries) {
    const names = [entry.displayName, entry.name, ...(entry.aliases || [])].filter(Boolean);
    const match = names.find((name) => canonicalSymbol(name).length >= 4 && canonical.includes(canonicalSymbol(name)));
    if (match) return entry.displayName || entry.name;
  }
  const symbolHints = String(line || "").match(/\b[A-Z][A-Z0-9_]{4,}\b/g) || [];
  for (const hint of symbolHints) {
    const hintCanonical = canonicalSymbol(hint);
    const suffixMatches = (registersIndex?.registers || []).filter((entry) =>
      [entry.displayName, entry.name, ...(entry.aliases || [])]
        .filter(Boolean)
        .some((name) => canonicalSymbol(name).endsWith(hintCanonical))
    );
    if (suffixMatches.length === 1) return suffixMatches[0].displayName || suffixMatches[0].name;
  }
  return null;
}

function sequenceLineBitfield(line, register, lookups) {
  const canonical = canonicalSymbol(line);
  const registerCanonical = canonicalSymbol(register);
  if (!registerCanonical) return null;
  for (const entry of lookups.bitfieldsByRegister.get(registerCanonical) || []) {
    const names = [entry.bitfield, ...(entry.aliases || [])].filter(Boolean);
    const match = names.find((name) => canonicalSymbol(name).length >= 2 && canonical.includes(canonicalSymbol(name)));
    if (match) return entry.bitfield;
  }
  return null;
}

export function extractStructuredSequenceSteps(chunks, registersIndex, bitfieldsIndex, options = {}) {
  const steps = [];
  const seen = new Set();
  const lookups = buildSequenceLookups(registersIndex, bitfieldsIndex);
  for (const chunk of chunks || []) {
    const lines = String(chunk.text || chunk.preview || "").split("\n").map((line) => line.trim()).filter(Boolean);
    const chunkWritePair = extractOrderedWritePair(lines.join(" "));
    if (chunkWritePair) {
      const register = sequenceLineRegister(`${chunkWritePair.registerHint} ${lines.join(" ")}`, registersIndex, chunk, lookups) || chunkWritePair.registerHint;
      for (const [pairIndex, value] of [chunkWritePair.firstValue, chunkWritePair.secondValue].entries()) {
        steps.push({ order: pairIndex + 1, semanticPriority: 100, explicitOrder: true, operation: "write", register, bitfield: null, value, condition: null, timing: null, text: pairIndex === 0 ? `Write ${value} to ${register}` : `Then write ${value} to ${register}`, evidence: { page: Number(chunk.page || 0) || null, chunkId: chunk.id || null, quote: lines.join(" ").slice(0, 700), sourceArtifact: "chunk-index" } });
      }
    }
    const procedureContext = /\b(procedure|sequence|operation|setting|steps?|before|after|first|then|next)\b/i.test(lines.join(" "));
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (isSequenceBoilerplate(line)) continue;
      const numbered = line.match(/^\s*(?:Step\s*)?(\d{1,2})[.):]\s*(.+)$/i) || line.match(/^\s*\((\d{1,2})\)\s*(.+)$/);
      const connective = line.match(/^\s*(First|Then|Next|Finally|After(?:wards)?|Subsequently)[,:]?\s+(.+)$/i);
      const operationSignal = /\b(write|read|set|clear|enable|disable|start|stop|reset|wait|poll|assert|deassert|configure|program)\b/i.test(line);
      const orderedWritePair = extractOrderedWritePair(line);
      if (orderedWritePair) {
        if (chunkWritePair) continue;
        const register = sequenceLineRegister(`${orderedWritePair.registerHint} ${line}`, registersIndex, chunk, lookups) || orderedWritePair.registerHint;
        for (const [pairIndex, value] of [orderedWritePair.firstValue, orderedWritePair.secondValue].entries()) {
          steps.push({ order: steps.length + 1, explicitOrder: true, operation: "write", register, bitfield: null, value, condition: null, timing: null, text: pairIndex === 0 ? `Write ${value} to ${register}` : `Then write ${value} to ${register}`, evidence: { page: Number(chunk.page || 0) || null, chunkId: chunk.id || null, quote: line.slice(0, 700), sourceArtifact: "chunk-index" } });
        }
        continue;
      }
      if (!numbered && !connective && !(procedureContext && operationSignal)) continue;
      const text = String(numbered?.[2] || connective?.[2] || line).trim();
      if (text.length < 6 || isSequenceBoilerplate(text)) continue;
      const key = normalizeForSearch(text);
      if (seen.has(key)) continue;
      seen.add(key);
      const register = sequenceLineRegister(text, registersIndex, chunk, lookups);
      const bitfield = sequenceLineBitfield(text, register, lookups);
      const value = text.match(/\b(?:write|set|clear|program)\s+(0x[0-9a-f]+|[0-9a-f]+h|[01]+b|\d+)\b/i)?.[1]
        || text.match(/(?:=|to|with)\s*(0x[0-9a-f]+|[0-9a-f]+h|[01]+b|\d+)\b/i)?.[1]
        || null;
      const condition = text.match(/\b(?:if|when|while|until|before|after)\b[\s\S]*/i)?.[0] || null;
      const timing = text.match(/\b\d+(?:\.\d+)?\s*(?:cycles?|ns|us|ms|s|microseconds?|milliseconds?)\b/i)?.[0] || null;
      steps.push({
        order: numbered ? Number(numbered[1]) : steps.length + 1,
        explicitOrder: Boolean(numbered || connective),
        operation: inferSequenceOperation(text),
        register,
        bitfield,
        value,
        condition,
        timing,
        text,
        evidence: { page: Number(chunk.page || 0) || null, chunkId: chunk.id || null, quote: line.slice(0, 700), sourceArtifact: "chunk-index" },
      });
      if (steps.length >= Number(options.maxSteps || 16)) return finalizeStructuredSequenceSteps(steps);
    }
  }
  return finalizeStructuredSequenceSteps(steps);
}

function finalizeStructuredSequenceSteps(steps) {
  return steps.sort((a, b) => Number(b.semanticPriority || 0) - Number(a.semanticPriority || 0) || a.order - b.order).map((step, index) => ({ ...step, order: index + 1 }));
}

export function buildSequenceEdges(steps) {
  const edges = [];
  for (let index = 1; index < (steps || []).length; index += 1) {
    edges.push({ from: index, to: index + 1, relation: "before" });
  }
  return edges;
}

export function sequenceStructureStatus(steps) {
  const explicitlyOrdered = (steps || []).filter((step) => step.explicitOrder);
  if ((steps || []).length >= 2 && explicitlyOrdered.length >= 2 && steps.every((step) => step.evidence?.page && step.evidence?.chunkId)) return "complete";
  if ((steps || []).length) return "partial";
  return "unstructured";
}

export function selectCoherentSequenceChunks(chunks, maxGap = 2) {
  const ordered = [...(chunks || [])].sort((a, b) => Number(a.page) - Number(b.page) || Number(b.score || 0) - Number(a.score || 0));
  const clusters = [];
  for (const chunk of ordered) {
    const previous = clusters[clusters.length - 1];
    const previousPage = previous?.length ? Number(previous[previous.length - 1].page) : null;
    if (!previous || previousPage === null || Number(chunk.page) - previousPage > maxGap) clusters.push([chunk]);
    else previous.push(chunk);
  }
  return clusters
    .map((cluster) => ({ cluster, score: cluster.reduce((sum, chunk) => sum + Number(chunk.score || 0), 0) + cluster.length * 25 }))
    .sort((a, b) => b.score - a.score)[0]?.cluster || [];
}

export function sequenceSemanticAnchorScore(chunk, topic) {
  const text = String(chunk?.text || "");
  const normalizedTopic = normalizeForSearch(topic);
  let score = 0;
  if (/watchdog refresh/.test(normalizedTopic) && /\bRefresh Operation\b/i.test(text) && /\bWDTRR\b/.test(text)) score += 420;
  if (extractOrderedWritePair(text)) score += /refresh|write|procedure|sequence/.test(normalizedTopic) ? 260 : 80;
  return score;
}

export function canonicalSequenceId(filename, topic) {
  const normalized = normalizeForSearch(topic).replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return `${filename}:seq:${normalized || "unknown"}`;
}

export function defaultSequenceTopicsForModule(filename, sectionsIndex = null, registersIndex = null) {
  const topics = new Set([
    "initialization",
    "initial setting procedure",
    "start operation",
    "start transfer",
    "enable channel",
    "stop operation",
    "stop transfer",
    "disable channel",
    "suspend operation",
    "clear status flag",
    "clear interrupt status",
    "interrupt handling",
    "error handling",
    "software reset",
    "reset operation",
    "clock setting",
    "reset release",
  ]);

  const filenameText = normalizeForSearch(filename);
  const registerText = normalizeForSearch((registersIndex?.registers || []).map((entry) => entry.displayName || entry.name || "").join(" "));
  if (/dma|dmac/.test(filenameText)) {
    [
      "dma transfer start",
      "dma transfer stop",
      "channel enable",
      "channel disable",
      "transfer end clear",
      "transfer complete interrupt",
      "dma error handling",
      "dma request setting",
    ].forEach((topic) => topics.add(topic));
  }
  if (/wdt|watchdog/.test(filenameText)) {
    ["watchdog start", "watchdog refresh", "watchdog reset", "timeout setting", "counter clear"].forEach((topic) => topics.add(topic));
  }
  if (/gpt|timer|pwm/.test(filenameText)) {
    ["counter start", "counter stop", "clear interrupt status", "pwm output setting", "input capture"].forEach((topic) => topics.add(topic));
  }
  if (/wdt|watchdog/.test(registerText)) ["watchdog refresh", "watchdog start", "watchdog error clear"].forEach((topic) => topics.add(topic));
  if (/dmac|dma/.test(registerText)) ["dma transfer start", "dma transfer suspension procedure", "dma error clear"].forEach((topic) => topics.add(topic));
  if (/adc|adcsr/.test(registerText)) ["a/d conversion start", "a/d error clear"].forEach((topic) => topics.add(topic));
  if (/rspi|spcr/.test(registerText)) ["spi transfer start", "spi stop operation", "spi sequence control"].forEach((topic) => topics.add(topic));

  for (const section of (sectionsIndex && sectionsIndex.sections) || []) {
    const title = String(section.title || "").trim();
    if (!title) continue;
    if (/\b(operation|procedure|sequence|setting|settings|initial|start|stop|clear|reset|interrupt|error|transfer|request|enable|disable|suspend)\b/i.test(title)) {
      const topic = title.replace(/^\d+(?:\.\d+)*\s+/, "").slice(0, 160);
      if (isTrustedSequenceTopic(topic)) topics.add(topic);
    }
  }

  for (const register of (registersIndex && registersIndex.registers || []).slice(0, 24)) {
    const name = register.displayName || register.name;
    if (!name) continue;
    if (/CTRL|CTL|CR|STAT|SR|INT|ERR|SUS|EN|END|TC|RESET|RST/i.test(name)) {
      topics.add(`${name} operation`);
      topics.add(`${name} clear status`);
    }
  }

  return [...topics].filter(isTrustedSequenceTopic).slice(0, DEFAULT_SEQUENCE_INDEX_TOPICS);
}

export function sequenceTopicKind(topic) {
  const kinds = classifySequenceTopic(topic).filter((kind) => kind !== "generic");
  return kinds.length ? kinds.join(",") : "generic";
}

export function inferSequenceRelatedRegisters(chunks, registersIndex, maxRegisters = 12) {
  const scores = new Map();
  const registerEntries = (registersIndex && registersIndex.registers) || [];

  for (const chunk of chunks || []) {
    const canonicalText = canonicalSymbol([chunk.text || "", ...(chunk.registers || []), ...(chunk.headings || [])].join("\n"));
    for (const entry of registerEntries) {
      const names = new Set([entry.name, entry.displayName, ...(entry.aliases || [])].map(normalizeRegisterName).filter(Boolean));
      let matched = false;
      for (const name of names) {
        if (name && canonicalText.includes(name)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      const key = entry.displayName || entry.name;
      scores.set(key, (scores.get(key) || 0) + Number(chunk.score || 1));
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxRegisters)
    .map(([name]) => name);
}

export function sequenceConfidenceFromScore(score, structureStatus = "unstructured") {
  const n = Number(score || 0);
  if (n >= 220 && structureStatus === "complete") return "high";
  if (n >= 120) return "medium";
  return "low";
}

export async function buildSequencesIndex(filename, indexData = null, sectionsIndex = null, registersIndex = null, dependencies = {}) {
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const source = await getPdfSourceInfo(filename);
  const actualIndexData = indexData || await loadPdfIndex(filename);
  const actualSectionsIndex = sectionsIndex || await getSectionsIndex(filename);
  const actualRegistersIndex = registersIndex || await getRegistersIndex(filename);
  const topics = defaultSequenceTopicsForModule(filename, actualSectionsIndex, actualRegistersIndex);
  const sequences = [];

  for (const topic of topics) {
    const sectionMatches = (actualSectionsIndex.sections || [])
      .map((section) => ({ ...section, score: scoreSimpleText(section.title || "", topic) }))
      .filter((section) => section.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    const sectionContext = collectSectionContext(sectionMatches);

    const scoredCandidates = (actualIndexData.chunks || [])
      .map((chunk) => {
        const semanticAnchorScore = sequenceSemanticAnchorScore(chunk, topic);
        return {
          ...chunk,
          semanticAnchorScore,
          score: scoreSequenceChunk(chunk, topic, "", null, sectionContext) + semanticAnchorScore,
          sequenceEvidence: extractSequenceEvidenceLines(chunk.text || "", topic, "", MAX_SEQUENCE_EVIDENCE_LINES),
        };
      })
      .filter((chunk) => chunk.score >= 55 && ((chunk.sequenceEvidence || []).length > 0 || chunk.semanticAnchorScore > 0))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.page !== b.page) return a.page - b.page;
        return a.chunkIndex - b.chunkIndex;
      })
      .slice(0, Math.max(MAX_SEQUENCE_INDEX_RESULTS_PER_TOPIC * 3, 16));
    const scoredChunks = selectCoherentSequenceChunks(scoredCandidates).slice(0, MAX_SEQUENCE_INDEX_RESULTS_PER_TOPIC);

    if (!scoredChunks.length || isSequenceBoilerplate(topic)) continue;

    const pages = [...new Set(scoredChunks.map((chunk) => Number(chunk.page)).filter(Number.isFinite))].sort((a, b) => a - b);
    const evidenceLines = [];
    for (const chunk of scoredChunks) {
      for (const line of chunk.sequenceEvidence || []) {
        if (!evidenceLines.includes(line)) evidenceLines.push(line);
        if (evidenceLines.length >= MAX_SEQUENCE_EVIDENCE_LINES) break;
      }
      if (evidenceLines.length >= MAX_SEQUENCE_EVIDENCE_LINES) break;
    }

    const topScore = Math.max(...scoredChunks.map((chunk) => Number(chunk.score || 0)));
    const steps = extractStructuredSequenceSteps(scoredChunks, actualRegistersIndex, dependencies.bitfieldsIndex);
    const structureStatus = sequenceStructureStatus(steps);
    const preconditions = steps.filter((step) => /\b(before|prior|ensure|only when)\b/i.test(step.text)).map((step) => step.text).slice(0, 8);
    const postconditions = steps.filter((step) => /\b(after|until|complete|completion)\b/i.test(step.text)).map((step) => step.text).slice(0, 8);
    const relatedRegisters = inferSequenceRelatedRegisters(scoredChunks, actualRegistersIndex);
    const cautions = (dependencies.cautionsIndex?.cautions || []).filter((caution) =>
      (caution.pages || [caution.page]).map(Number).some((page) => pages.includes(page)) ||
      (caution.registers || []).some((register) => relatedRegisters.map(canonicalSymbol).includes(canonicalSymbol(register)))
    ).slice(0, 8).map((caution) => ({ id: caution.id, page: caution.page || caution.pages?.[0] || null, text: caution.text || caution.evidenceLines?.[0] || "", confidence: caution.confidence || "medium" }));
    sequences.push({
      id: canonicalSequenceId(filename, topic),
      filename,
      topic: normalizeSequenceTopic(topic),
      kind: sequenceTopicKind(topic),
      pages,
      relatedRegisters,
      relatedSections: sectionMatches.slice(0, 5).map((section) => ({
        title: section.title,
        page: section.page,
        score: section.score,
      })),
      chunks: scoredChunks.map((chunk) => ({
        id: chunk.id,
        page: chunk.page,
        chunkIndex: chunk.chunkIndex,
        score: chunk.score,
        headings: chunk.headings || [],
        registers: chunk.registers || [],
        evidenceLines: chunk.sequenceEvidence || [],
        preview: normalizeText(chunk.text || "").slice(0, 700),
      })),
      evidenceLines,
      steps,
      edges: buildSequenceEdges(steps),
      preconditions,
      postconditions,
      cautions,
      structureStatus,
      confidence: sequenceConfidenceFromScore(topScore, structureStatus),
      score: Math.round(topScore),
      source: "sequence-index-heuristic",
    });
  }

  const dedup = new Map();
  for (const sequence of sequences) {
    const key = normalizeForSearch(sequence.topic);
    const previous = dedup.get(key);
    if (!previous || sequence.score > previous.score) dedup.set(key, sequence);
  }

  const finalSequences = [...dedup.values()].sort((a, b) => {
    const structureRank = { complete: 2, partial: 1, unstructured: 0 };
    if ((structureRank[b.structureStatus] || 0) !== (structureRank[a.structureStatus] || 0)) return (structureRank[b.structureStatus] || 0) - (structureRank[a.structureStatus] || 0);
    if (b.score !== a.score) return b.score - a.score;
    return String(a.topic).localeCompare(String(b.topic));
  });

  const index = {
    schemaVersion: SEQUENCE_INDEX_SCHEMA_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    dependencyVersions: { "chunk-index": actualIndexData.schemaVersion, sections: actualSectionsIndex.schemaVersion, tables: dependencies.tablesIndex?.schemaVersion || null, registers: actualRegistersIndex.schemaVersion, bitfields: dependencies.bitfieldsIndex?.schemaVersion || null, cautions: dependencies.cautionsIndex?.schemaVersion || null },
    sequenceCount: finalSequences.length,
    quality: {
      complete: finalSequences.filter((sequence) => sequence.structureStatus === "complete").length,
      partial: finalSequences.filter((sequence) => sequence.structureStatus === "partial").length,
      unstructured: finalSequences.filter((sequence) => sequence.structureStatus === "unstructured").length,
      rejectedNoise: topics.filter(isSequenceBoilerplate).length,
    },
    sequences: finalSequences,
  };

  const sequencesPath = safeSequencesIndexPath(filename);
  await atomicWriteJson(sequencesPath, index);
  return index;
}

export async function loadSequencesIndex(filename) {
  const sequencesPath = safeSequencesIndexPath(filename);
  if (!(await pathExists(sequencesPath))) return null;

  try {
    const index = await readJsonCached(sequencesPath);
    if (index.schemaVersion !== SEQUENCE_INDEX_SCHEMA_VERSION) return null;
    if (index.filename !== filename) return null;
    if (!Array.isArray(index.sequences)) return null;
    const currentSource = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(index.source, currentSource)) return null;
    return index;
  } catch {
    return null;
  }
}

export async function getSequencesIndex(filename, options = {}) {
  const existing = await loadSequencesIndex(filename);
  if (existing) return existing;

  if (options.buildIfMissing === true) {
    const indexData = await loadPdfIndex(filename, { buildIfMissing: true });
    const sectionsIndex = await getSectionsIndex(filename, { buildIfMissing: true });
    const registersIndex = await getRegistersIndex(filename, { buildIfMissing: true });
    const tablesIndex = await loadTablesIndex(filename);
    const bitfieldsIndex = await getBitfieldsIndex(filename, { buildIfMissing: true });
    const cautionsIndex = await loadCautionsIndex(filename);
    return await buildSequencesIndex(filename, indexData, sectionsIndex, registersIndex, { tablesIndex, bitfieldsIndex, cautionsIndex });
  }

  throw new Error(`Sequences index not found for ${filename}. Run index_pdf first; use mode="background" for large manuals.`);
}

export function scoreSimpleText(text, query) {
  const haystack = normalizeForSearch(text);
  const needle = normalizeForSearch(query);
  if (!haystack || !needle) return 0;
  let score = 0;
  if (haystack.includes(needle)) score += 80;
  for (const term of needle.split(/\s+/).filter((part) => part.length > 1)) {
    if (countWordOccurrences(haystack, term)) score += 12;
    else if (haystack.includes(term)) score += 4;
  }
  return score;
}

export function scoreSequenceEntry(sequence, topic, register = "") {
  const q = normalizeForSearch(topic);
  const r = normalizeRegisterName(register);
  const searchText = normalizeForSearch([
    sequence.topic,
    sequence.kind,
    ...(sequence.relatedRegisters || []),
    ...(sequence.evidenceLines || []),
    ...((sequence.steps || []).map((step) => `${step.operation} ${step.register || ""} ${step.bitfield || ""} ${step.text || ""}`)),
    ...((sequence.relatedSections || []).map((section) => section.title || "")),
  ].join("\n"));
  const canonical = canonicalSymbol([
    ...(sequence.relatedRegisters || []),
    sequence.topic,
  ].join("\n"));

  let score = scoreSimpleText(searchText, q) + Math.round(Number(sequence.score || 0) / 6);
  if (r && canonical.includes(r)) score += 80;
  return score;
}

export async function listSequencesFromIndex(filename, options = {}) {
  const sequencesIndex = await getSequencesIndex(filename);
  const filter = String(options.filter || "").trim();
  const topK = clampSequenceListTopK(options.topK);
  const filterText = normalizeForSearch(filter);

  let results = sequencesIndex.sequences || [];
  if (filterText) {
    results = results
      .map((sequence) => ({ ...sequence, filterScore: scoreSequenceEntry(sequence, filter) }))
      .filter((sequence) => sequence.filterScore > 0)
      .sort((a, b) => {
        if (b.filterScore !== a.filterScore) return b.filterScore - a.filterScore;
        return b.score - a.score;
      });
  } else {
    results = [...results].sort((a, b) => b.score - a.score);
  }

  return {
    sequencesIndex,
    results: results.slice(0, topK),
  };
}

export function formatSequenceListResults(sequencesIndex, results, filter = "") {
  const lines = [
    filter
      ? `Detected operation-flow/sequence candidates matching "${filter}" in ${sequencesIndex.filename}`
      : `Detected operation-flow/sequence candidates in ${sequencesIndex.filename}`,
    `Sequences index created: ${sequencesIndex.createdAt}`,
    `Total sequences indexed: ${sequencesIndex.sequenceCount || (sequencesIndex.sequences || []).length}`,
    `Showing: ${results.length}`,
    "",
  ];

  if (!results.length) {
    lines.push("No sequence candidates found. Try get_sequence with a concrete topic such as start transfer, clear interrupt, reset, or initialization.");
    return lines.join("\n");
  }

  results.forEach((sequence, index) => {
    const pages = (sequence.pages || []).join(", ") || "unknown";
    const registers = (sequence.relatedRegisters || []).slice(0, 10).join(", ") || "none";
    const evidence = (sequence.evidenceLines || []).slice(0, 2).map((line) => `      - ${line}`).join("\n") || "      - none";
    lines.push(
      [
        `${index + 1}. ${sequence.topic}`,
        `   Kind: ${sequence.kind || "generic"}`,
        `   Pages: ${pages}`,
        `   Related registers: ${registers}`,
        `   Confidence: ${sequence.confidence || "unknown"}`,
        `   Structure: ${sequence.structureStatus || "unstructured"} (${(sequence.steps || []).length} steps)`,
        `   Score: ${sequence.score}`,
        `   Evidence:`,
        evidence,
        `   Suggested get: get_sequence(filename="${sequencesIndex.filename}", topic="${sequence.topic}")`,
      ].join("\n")
    );
  });

  lines.push("", "Machine summary JSON:", JSON.stringify({ schemaVersion: SEQUENCE_INDEX_SCHEMA_VERSION, filename: sequencesIndex.filename, sequenceCount: results.length, sequences: results.map((sequence) => ({ id: sequence.id, topic: sequence.topic, kind: sequence.kind, confidence: sequence.confidence, structureStatus: sequence.structureStatus || "unstructured", stepCount: (sequence.steps || []).length, pages: sequence.pages || [] })) }, null, 2));

  return lines.join("\n\n");
}

export async function getSequenceFromIndex(filename, topic, options = {}) {
  const sequencesIndex = await getSequencesIndex(filename);
  const register = String(options.register || "").trim();
  const topK = clampSequenceTopK(options.topK);
  const allowFallback = options.allowFallback !== false;
  const scored = (sequencesIndex.sequences || [])
    .map((sequence) => ({ ...sequence, matchScore: scoreSequenceEntry(sequence, topic, register) }))
    .filter((sequence) => sequence.matchScore > 0)
    .sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return b.score - a.score;
    });

  if (!scored.length || scored[0].matchScore < 35) {
    const fallback = allowFallback ? await findSequenceInIndex(filename, topic, { register, topK }) : null;
    return { sequencesIndex, topic, register, persistentMatches: [], fallback };
  }

  return {
    sequencesIndex,
    topic,
    register,
    persistentMatches: scored.slice(0, Math.min(topK, 5)),
    fallback: null,
  };
}

export function formatPersistentSequenceResult(result) {
  if (result.fallback) {
    return [
      `No strong persistent sequence-index match for "${result.topic}". Falling back to dynamic sequence search.`,
      "",
      formatSequenceResults(result.fallback),
    ].join("\n");
  }

  const filename = result.sequencesIndex.filename;
  const lines = [
    result.register
      ? `Persistent sequence result for "${result.topic}" within register context "${result.register}"`
      : `Persistent sequence result for "${result.topic}"`,
    `File: ${filename}`,
    `Sequences index created: ${result.sequencesIndex.createdAt}`,
    "",
  ];

  for (const [index, sequence] of (result.persistentMatches || []).entries()) {
    const pages = (sequence.pages || []).join(", ") || "unknown";
    const registers = (sequence.relatedRegisters || []).slice(0, 12).join(", ") || "none";
    const sections = (sequence.relatedSections || []).slice(0, 5).map((section) => `${section.title} (page ${section.page})`).join(" | ") || "none";
    const evidence = (sequence.evidenceLines || []).map((line) => `   - ${line}`).join("\n") || "   - none";
    const sequenceChunks = Array.isArray(sequence.chunks) ? sequence.chunks : [];
    const chunks = sequenceChunks.slice(0, Math.min(5, sequenceChunks.length)).map((chunk) => {
      const endPage = Number(chunk.page) + DEFAULT_PAGE_RANGE - 1;
      return [
        `   Chunk: ${chunk.id}`,
        `   Page: ${chunk.page}`,
        `   Score: ${chunk.score}`,
        `   Suggested chunk read: read_pdf_chunk(filename="${filename}", chunk_id="${chunk.id}")`,
        `   Suggested page read: read_pdf_pages(filename="${filename}", start_page=${chunk.page}, end_page=${endPage})`,
      ].join("\n");
    }).join("\n");
    const steps = (sequence.steps || []).map((step) => [
      `   ${step.order}. ${step.operation}: ${step.text}`,
      step.register ? `      Register: ${step.register}${step.bitfield ? `.${step.bitfield}` : ""}` : null,
      step.value ? `      Value: ${step.value}` : null,
      step.condition ? `      Condition: ${step.condition}` : null,
      step.timing ? `      Timing: ${step.timing}` : null,
      `      Evidence: page ${step.evidence?.page || "unknown"}, chunk ${step.evidence?.chunkId || "unknown"}`,
    ].filter(Boolean).join("\n")).join("\n") || "   - no structured steps; verify the evidence chunks manually";

    lines.push([
      `Match ${index + 1}`,
      `Topic: ${sequence.topic}`,
      `Kind: ${sequence.kind || "generic"}`,
      `Pages: ${pages}`,
      `Related registers: ${registers}`,
      `Related sections: ${sections}`,
      `Confidence: ${sequence.confidence || "unknown"}`,
      `Structure: ${sequence.structureStatus || "unstructured"}`,
      `Score: ${sequence.score}`,
      `Match score: ${sequence.matchScore}`,
      "Evidence lines:",
      evidence,
      "Structured steps:",
      steps,
      "Related chunks:",
      chunks || "   - none",
      "Driver-review hint: verify the exact order of register writes and any before/after/caution condition before implementing the sequence in Linux driver code.",
    ].join("\n"));
  }

  lines.push("Machine summary JSON:", JSON.stringify({ schemaVersion: SEQUENCE_INDEX_SCHEMA_VERSION, filename, matches: (result.persistentMatches || []).map((sequence) => ({ id: sequence.id, topic: sequence.topic, confidence: sequence.confidence, structureStatus: sequence.structureStatus || "unstructured", steps: sequence.steps || [], cautions: sequence.cautions || [] })) }, null, 2));
  return lines.join("\n\n---\n\n");
}
