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
const getSectionsIndex = createRuntimePort("getSectionsIndex");
const isNonRegisterSignal = createRuntimePort("isNonRegisterSignal");

const loadPdfDocument = createRuntimePort("loadPdfDocument");
const loadPdfIndex = createRuntimePort("loadPdfIndex");
const loadRegistersIndex = createRuntimePort("loadRegistersIndex");
const loadSectionsIndex = createRuntimePort("loadSectionsIndex");
const looksLikeRegisterSymbol = createRuntimePort("looksLikeRegisterSymbol");


const multiQuerySearch = createRuntimePort("multiQuerySearch");
const normalizeBitFieldName = createRuntimePort("normalizeBitFieldName");

const normalizeRegisterName = createRuntimePort("normalizeRegisterName");


const q = createRuntimePort("q");


const searchPdfIndex = createRuntimePort("searchPdfIndex");
const searchRegistersIndex = createRuntimePort("searchRegistersIndex");
const searchSectionsIndex = createRuntimePort("searchSectionsIndex");
import { collectSectionContext } from "./sequences.js";

export function topSafe(max, length) {
  const n = Number(length || 0);
  return Math.max(0, Math.min(max, n));
}


export function clampCautionTopK(value) {
  const n = Number(value || DEFAULT_CAUTION_TOP_K);
  if (!Number.isFinite(n)) return DEFAULT_CAUTION_TOP_K;
  return Math.max(1, Math.min(MAX_CAUTION_TOP_K, Math.floor(n)));
}

export function clampDriverPackRegisters(value) {
  return clampInteger(value, DEFAULT_DRIVER_PACK_REGISTERS, 1, MAX_DRIVER_PACK_REGISTERS);
}

export function clampDriverPackSummaries(value) {
  return clampInteger(value, DEFAULT_DRIVER_PACK_SUMMARIES, 1, MAX_DRIVER_PACK_SUMMARIES);
}

export function clampDriverTaskRegisters(value) {
  return clampInteger(value, DEFAULT_DRIVER_TASK_REGISTERS, 1, MAX_DRIVER_TASK_REGISTERS);
}

export function buildCautionQueries(topic, register = "") {
  const rawTopic = String(topic || "").trim();
  const rawRegister = String(register || "").trim();
  const combined = `${rawRegister} ${rawTopic}`.trim();
  const normalized = normalizeForSearch(`${rawTopic} ${rawRegister}`);
  const queries = new Set();

  if (rawTopic) queries.add(rawTopic);
  if (combined) queries.add(combined);

  queries.add(`${combined || rawTopic} caution`);
  queries.add(`${combined || rawTopic} note`);
  queries.add(`${combined || rawTopic} restriction`);
  queries.add(`${combined || rawTopic} prohibited`);
  queries.add(`${combined || rawTopic} undefined`);
  queries.add(`${combined || rawTopic} reserved`);
  queries.add(`${combined || rawTopic} must`);

  if (/clear|flag|status|interrupt|end|error/.test(normalized)) {
    queries.add(`${combined || rawTopic} clear status flag`);
    queries.add(`${combined || rawTopic} write 1 to clear`);
    queries.add(`${combined || rawTopic} write one to clear`);
    queries.add(`${combined || rawTopic} write 0 to clear`);
    queries.add(`${combined || rawTopic} write zero to clear`);
    queries.add(`${combined || rawTopic} cleared by writing`);
  }

  if (/reserved|bit|bits/.test(normalized)) {
    queries.add(`${combined || rawTopic} reserved bits`);
    queries.add(`${combined || rawTopic} read value undefined`);
    queries.add(`${combined || rawTopic} write value undefined`);
    queries.add(`${combined || rawTopic} must be written as 0`);
    queries.add(`${combined || rawTopic} must be written as 1`);
  }

  if (/stop|stopped|running|start|enable|disable|write|setting|set/.test(normalized)) {
    queries.add(`${combined || rawTopic} write only when stopped`);
    queries.add(`${combined || rawTopic} set only when stopped`);
    queries.add(`${combined || rawTopic} while stopped`);
    queries.add(`${combined || rawTopic} while operating`);
    queries.add(`${combined || rawTopic} before setting`);
    queries.add(`${combined || rawTopic} after setting`);
    queries.add(`${combined || rawTopic} cannot be changed`);
  }

  if (/reset|clock|module|software/.test(normalized)) {
    queries.add(`${combined || rawTopic} reset caution`);
    queries.add(`${combined || rawTopic} clock note`);
    queries.add(`${combined || rawTopic} module stop`);
  }

  return [...queries]
    .map((query) => query.trim())
    .filter(Boolean)
    .slice(0, 24);
}

export function cautionKeywordSet(topic, register = "") {
  const normalized = normalizeForSearch(`${topic} ${register}`);
  const words = normalized.split(/\s+/).filter((word) => word.length > 1);
  const keywords = new Set(words);

  const cautionWords = [
    "caution", "note", "notes", "restriction", "restrictions",
    "prohibit", "prohibited", "undefined", "invalid", "reserved",
    "must", "should", "only", "cannot", "do", "not", "before", "after",
    "when", "while", "until", "except", "write", "read", "clear", "cleared",
    "set", "reset", "stop", "stopped", "start", "enable", "disable",
    "interrupt", "status", "flag", "error", "end", "zero", "one", "0", "1",
  ];

  for (const word of cautionWords) keywords.add(word);
  return keywords;
}

export function classifyCautionLine(line) {
  const labels = [];
  const text = String(line || "");

  if (/\b(Caution|CAUTION)\b/.test(text)) labels.push("caution");
  if (/\b(Note|Notes|NOTE|NOTES)\b/.test(text)) labels.push("note");
  if (/\b(Restriction|Restrictions|restricted)\b/i.test(text)) labels.push("restriction");
  if (/\b(prohibit|prohibited|do\s+not|must\s+not|cannot|can't)\b/i.test(text)) labels.push("prohibited/forbidden");
  if (/\b(undefined|invalid|indeterminate|unpredictable)\b/i.test(text)) labels.push("undefined/invalid");
  if (/\breserved\b/i.test(text)) labels.push("reserved-bit handling");
  if (/\b(write|written|writing)\b/i.test(text) && /\b(clear|cleared)\b/i.test(text)) labels.push("clear semantics");
  if (/\b(write|written|writing)\b/i.test(text) && /\b(0|zero|1|one)\b/i.test(text) && /\b(clear|cleared|set|reserved)\b/i.test(text)) labels.push("write value semantics");
  if (/\b(only|when|while|before|after|until)\b/i.test(text) && /\b(stop|stopped|start|running|operation|operating|enable|disable|setting|set|write)\b/i.test(text)) labels.push("operation-order condition");
  if (/\b(initial value|reset value|read as|write as|must be written)\b/i.test(text)) labels.push("reset/read-write constraint");

  return [...new Set(labels)];
}

export function extractCautionEvidenceLines(text, topic, register = "", maxLines = MAX_CAUTION_EVIDENCE_LINES) {
  const keywords = cautionKeywordSet(topic, register);
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
    const labels = classifyCautionLine(line);
    let score = 0;

    for (const term of topicTerms) {
      if (term && normalizedLine.includes(term)) score += 14;
    }

    for (const word of keywords) {
      if (word && normalizedLine.includes(word)) score += 2;
    }

    if (registerCanonical && canonicalLine.includes(registerCanonical)) score += 24;
    if (labels.length) score += labels.length * 18;
    if (/\b(Caution|Note|Notes|Restriction|Restrictions)\b/i.test(line)) score += 28;
    if (/\b(reserved|undefined|invalid|prohibited|do\s+not|must\s+not|cannot)\b/i.test(line)) score += 24;
    if (/\b(write|written|writing)\b/i.test(line) && /\b(0|zero|1|one)\b/i.test(line)) score += 18;
    if (/\b(clear|cleared|status|flag|interrupt|error|end)\b/i.test(line)) score += 12;
    if (/\b(only|when|while|before|after|until)\b/i.test(line)) score += 14;

    if (score <= 0) continue;

    const prev = index > 0 ? lines[index - 1] : "";
    const next = index + 1 < lines.length ? lines[index + 1] : "";
    const context = [prev, line, next].filter(Boolean).join(" / ").slice(0, 1000);
    const labelText = labels.length ? ` [${labels.join(", ")}]` : "";

    scored.push({
      score,
      index,
      line: `${context}${labelText}`,
      labels,
    });
  }

  return scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .slice(0, maxLines)
    .map((entry) => entry.line);
}

export function scoreCautionChunk(chunk, topic, register = "", registerContext = null, sectionContext = null) {
  const textRaw = String(chunk.text || "");
  const text = normalizeForSearch(textRaw);
  const canonicalText = canonicalSymbol(textRaw);
  const topicTerms = normalizeForSearch(topic).split(/\s+/).filter((word) => word.length > 1);
  const registerCanonical = normalizeRegisterName(register);
  const metadata = normalizeForSearch([
    ...(chunk.headings || []),
    ...(chunk.registers || []),
    ...(chunk.bitFields || []),
  ].join("\n"));

  let score = 0;

  for (const term of topicTerms) {
    if (term && text.includes(term)) score += 10;
    if (term && metadata.includes(term)) score += 8;
  }

  if (registerCanonical && canonicalText.includes(registerCanonical)) score += 35;
  if (registerCanonical && metadata.includes(normalizeForSearch(register))) score += 20;

  if (registerContext) {
    if (registerContext.chunkIds && registerContext.chunkIds.has(chunk.id)) score += 55;
    if (registerContext.pages && registerContext.pages.has(Number(chunk.page))) score += 28;
    if (registerContext.nearPages && registerContext.nearPages.has(Number(chunk.page))) score += 14;
  }

  if (sectionContext) {
    if (sectionContext.pages && sectionContext.pages.has(Number(chunk.page))) score += 22;
    if (sectionContext.nearPages && sectionContext.nearPages.has(Number(chunk.page))) score += 12;
  }

  if (/\b(Caution|CAUTION)\b/.test(textRaw)) score += 60;
  if (/\b(Note|Notes|NOTE|NOTES)\b/.test(textRaw)) score += 32;
  if (/\b(Restriction|Restrictions)\b/i.test(textRaw)) score += 45;
  if (/\b(prohibit|prohibited|do\s+not|must\s+not|cannot|can't)\b/i.test(textRaw)) score += 40;
  if (/\b(undefined|invalid|indeterminate|unpredictable)\b/i.test(textRaw)) score += 38;
  if (/\breserved\b/i.test(textRaw)) score += 35;
  if (/\b(write|written|writing)\b/i.test(textRaw) && /\b(clear|cleared)\b/i.test(textRaw)) score += 35;
  if (/\b(write|written|writing)\b/i.test(textRaw) && /\b(0|zero|1|one)\b/i.test(textRaw)) score += 28;
  if (/\b(only|when|while|before|after|until)\b/i.test(textRaw) && /\b(stop|stopped|running|operation|enable|disable|setting|set|write)\b/i.test(textRaw)) score += 30;

  const evidence = extractCautionEvidenceLines(textRaw, topic, register, 4);
  score += evidence.length * 16;

  return score;
}

export async function findCautionInIndex(filename, topic, options = {}) {
  const rawTopic = String(topic || "").trim();
  const rawRegister = String(options.register || "").trim();
  const topK = clampCautionTopK(options.topK);
  const searchTopK = Math.max(topK * 4, 30);
  const queries = buildCautionQueries(rawTopic, rawRegister);
  const candidateMap = new Map();
  let registerResults = [];
  let registerContext = null;

  if (!rawTopic) throw new Error("topic is required");

  if (rawRegister) {
    const registerSearch = await searchRegistersIndex(filename, rawRegister, Math.min(8, topK));
    registerResults = registerSearch.results;
    registerContext = collectRegisterContext(registerResults);
  }

  const sectionQueries = [
    rawTopic,
    `${rawTopic} caution`,
    `${rawTopic} note`,
    `${rawTopic} restriction`,
    `${rawTopic} usage notes`,
    `${rawTopic} operation`,
  ];

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

  const indexData = await loadPdfIndex(filename);
  for (const chunk of indexData.chunks || []) {
    const page = Number(chunk.page);
    const nearSection = sectionContext.nearPages && sectionContext.nearPages.has(page);
    const nearRegister = registerContext && registerContext.pages && registerContext.pages.has(page);
    const directRegisterChunk = registerContext && registerContext.chunkIds && registerContext.chunkIds.has(chunk.id);
    const textRaw = String(chunk.text || "");
    const hasStrongCautionTerm = /\b(Caution|Note|Notes|Restriction|Restrictions|reserved|undefined|invalid|prohibited|do\s+not|must\s+not|cannot|write\s+(?:0|1|zero|one)|cleared?\s+by\s+writing)\b/i.test(textRaw);

    if (nearSection || nearRegister || directRegisterChunk || hasStrongCautionTerm) {
      candidateMap.set(chunk.id, candidateMap.get(chunk.id) || chunk);
    }
  }

  const results = [...candidateMap.values()]
    .map((chunk) => ({
      ...chunk,
      score: scoreCautionChunk(chunk, rawTopic, rawRegister, registerContext, sectionContext),
      cautionEvidence: extractCautionEvidenceLines(chunk.text || "", rawTopic, rawRegister, MAX_CAUTION_EVIDENCE_LINES),
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

export function formatCautionResults(cautionResult) {
  const filename = cautionResult.filename;
  const topic = cautionResult.topic;
  const register = cautionResult.register;
  const results = cautionResult.results || [];
  const registerResults = cautionResult.registerResults || [];
  const sectionResults = cautionResult.sectionResults || [];

  if (!results.length) {
    return [
      register
        ? `No caution/note/restriction results found for "${topic}" in register context "${register}".`
        : `No caution/note/restriction results found for "${topic}".`,
      "",
      "Suggested next steps:",
      `- Try find_section(filename="${filename}", section="Usage Notes").`,
      `- Try search_pdf(filename="${filename}", query="${topic} caution note restriction reserved undefined prohibited").`,
      register
        ? `- Try summarize_register(filename="${filename}", register="${register}").`
        : `- Try passing a related register, for example find_caution(filename="${filename}", topic="write only when stopped", register="DMACm_CHCTRL_n").`,
    ].join("\n");
  }

  const header = [
    register
      ? `Caution results for "${topic}" within register context "${register}"`
      : `Caution results for "${topic}"`,
    `File: ${filename}`,
  ];

  if (register) {
    header.push(
      registerResults.length
        ? `Register context matches: ${registerResults.slice(0, 5).map((entry) => entry.displayName || entry.name).join(", ")}`
        : "Register context matches: none; used generic caution search fallback."
    );
  }

  header.push(
    sectionResults.length
      ? `Relevant sections: ${sectionResults.slice(0, 5).map((section) => `${section.title} (page ${section.page})`).join(" | ")}`
      : "Relevant sections: none from section index."
  );

  const queryLine = cautionResult.queries && cautionResult.queries.length
    ? `Expanded queries: ${cautionResult.queries.slice(0, 14).join(" | ")}`
    : "Expanded queries: none";

  return [
    ...header,
    queryLine,
    "",
    ...results.map((result, index) => {
      const preview = normalizeText(result.text || "").slice(0, MAX_PREVIEW_CHARS);
      const truncated = (result.text || "").length > MAX_PREVIEW_CHARS ? "..." : "";
      const evidence = (result.cautionEvidence || []).length
        ? result.cautionEvidence.map((line) => `   - ${line}`).join("\n")
        : "   - none";
      const endPage = Math.max(Number(result.page), Number(result.page) + DEFAULT_PAGE_RANGE - 1);

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
        "Caution / restriction evidence lines:",
        evidence,
        `Suggested chunk read: read_pdf_chunk(filename="${result.filename}", chunk_id="${result.id}")`,
        `Suggested page read: read_pdf_pages(filename="${result.filename}", start_page=${result.page}, end_page=${endPage})`,
        "Driver-review hint: verify reserved-bit handling, allowed write timing, and clear-flag semantics before approving register writes in the driver.",
        "Preview:",
        `${preview}${truncated}`,
      ].join("\n");
    }),
  ].join("\n\n---\n\n");
}
