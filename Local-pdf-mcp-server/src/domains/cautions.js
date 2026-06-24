import { atomicWriteJson, canonicalSymbol, clampInteger, getPdfSourceInfo, isSamePdfSource, normalizeForSearch, normalizeText, pathExists, readJsonCached, safeCautionsIndexPath } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { CAUTION_INDEX_SCHEMA_VERSION, DEFAULT_CAUTION_INDEX_TOPICS, DEFAULT_CAUTION_LIST_TOP_K, DEFAULT_PAGE_RANGE, INDEX_DIR, MAX_CAUTION_EVIDENCE_LINES, MAX_CAUTION_INDEX_RESULTS_PER_TOPIC, MAX_CAUTION_LIST_TOP_K } from "../core/runtime-constants.js";
import fs from "node:fs/promises";


const buildSearchText = createRuntimePort("buildSearchText");


const classifyCautionLine = createRuntimePort("classifyCautionLine");
const collectSectionContext = createRuntimePort("collectSectionContext");
const extractCautionEvidenceLines = createRuntimePort("extractCautionEvidenceLines");
const findCautionInIndex = createRuntimePort("findCautionInIndex");
const formatCautionResults = createRuntimePort("formatCautionResults");

const getRegistersIndex = createRuntimePort("getRegistersIndex");
const getSectionsIndex = createRuntimePort("getSectionsIndex");

const loadPdfIndex = createRuntimePort("loadPdfIndex");

const normalizeRegisterName = createRuntimePort("normalizeRegisterName");
const normalizeSequenceTopic = createRuntimePort("normalizeSequenceTopic");


const scoreCautionChunk = createRuntimePort("scoreCautionChunk");
const scoreSimpleText = createRuntimePort("scoreSimpleText");
const searchRegistersIndex = createRuntimePort("searchRegistersIndex");


// -----------------------------------------------------------------------------
// Persistent caution / restriction index
// -----------------------------------------------------------------------------

export function clampCautionListTopK(value) {
  return clampInteger(value, DEFAULT_CAUTION_LIST_TOP_K, 1, MAX_CAUTION_LIST_TOP_K);
}

export function defaultCautionTopicsForModule(filename, sectionsIndex = null, registersIndex = null) {
  const topics = new Set([
    "caution",
    "note",
    "usage notes",
    "restriction",
    "reserved bits",
    "reserved bit handling",
    "write only when stopped",
    "write while running",
    "do not write",
    "prohibited",
    "undefined",
    "invalid setting",
    "write 1 to clear",
    "write 0 to clear",
    "clear status flag",
    "clear interrupt status",
    "read modify write",
    "initial value",
    "reset value",
    "write protection",
    "software reset restriction",
    "interrupt status clear",
    "error status clear",
  ]);

  const filenameText = normalizeForSearch(filename);
  if (/dma|dmac/.test(filenameText)) {
    [
      "dma channel enable restriction",
      "dma channel disable restriction",
      "transfer end clear",
      "dma error clear",
      "channel status clear",
      "transfer request restriction",
      "descriptor address restriction",
    ].forEach((topic) => topics.add(topic));
  }
  if (/wdt|watchdog/.test(filenameText)) {
    ["watchdog refresh restriction", "watchdog write sequence", "watchdog reset condition", "timeout setting caution"].forEach((topic) => topics.add(topic));
  }
  if (/gpt|timer|pwm/.test(filenameText)) {
    ["counter stopped before write", "compare register write restriction", "clear interrupt flag", "reserved bit handling"].forEach((topic) => topics.add(topic));
  }

  for (const section of (sectionsIndex && sectionsIndex.sections) || []) {
    const title = String(section.title || "").trim();
    if (!title) continue;
    if (/\b(caution|note|notes|restriction|usage notes|prohibit|reserved|undefined|invalid|clear|write|reset|interrupt|error)\b/i.test(title)) {
      topics.add(title.replace(/^\d+(?:\.\d+)*\s+/, "").slice(0, 180));
    }
  }

  for (const register of ((registersIndex && registersIndex.registers) || []).slice(0, 36)) {
    const name = register.displayName || register.name;
    if (!name) continue;
    if (/CTRL|CTL|CR|STAT|SR|INT|ERR|SUS|EN|END|TC|RESET|RST|CFG/i.test(name)) {
      topics.add(`${name} caution`);
      topics.add(`${name} reserved bits`);
      topics.add(`${name} clear status`);
      topics.add(`${name} write restriction`);
    }
  }

  return [...topics].filter(Boolean).slice(0, DEFAULT_CAUTION_INDEX_TOPICS);
}

export function cautionTypeFromLabels(labels = [], line = "", topic = "") {
  const text = `${labels.join(" ")} ${line} ${topic}`;
  if (/reserved/i.test(text)) return "reserved-bit";
  if (/write\s*1|write one|cleared?\s+by\s+writing\s+1|w1c/i.test(text)) return "clear-semantics-write-1";
  if (/write\s*0|write zero|cleared?\s+by\s+writing\s+0|w0c/i.test(text)) return "clear-semantics-write-0";
  if (/while|when|stopp?ed|running|operation|before|after|only/i.test(text) && /write|set|clear|enable|disable/i.test(text)) return "write-timing";
  if (/undefined|invalid/i.test(text)) return "undefined-invalid";
  if (/prohibit|prohibited|forbidden|do\s+not|must\s+not|cannot/i.test(text)) return "prohibited";
  if (/reset|initial|read|write/i.test(text)) return "reset-access";
  if (/restriction/i.test(text)) return "restriction";
  if (/caution/i.test(text)) return "caution";
  if (/note/i.test(text)) return "note";
  return "general";
}

export function inferCautionRelatedRegisters(chunks, registersIndex, maxRegisters = 16) {
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

export function cautionConfidenceFromScore(score) {
  const n = Number(score || 0);
  if (n >= 220) return "high";
  if (n >= 120) return "medium";
  return "low";
}

export function canonicalCautionId(filename, topic, type) {
  const normalized = normalizeForSearch(`${type} ${topic}`).replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return `${filename}:caution:${normalized || "unknown"}`;
}

export async function buildCautionsIndex(filename, indexData = null, sectionsIndex = null, registersIndex = null) {
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const source = await getPdfSourceInfo(filename);
  const actualIndexData = indexData || await loadPdfIndex(filename);
  const actualSectionsIndex = sectionsIndex || await getSectionsIndex(filename);
  const actualRegistersIndex = registersIndex || await getRegistersIndex(filename);
  const topics = defaultCautionTopicsForModule(filename, actualSectionsIndex, actualRegistersIndex);
  const cautions = [];

  for (const topic of topics) {
    const sectionMatches = (actualSectionsIndex.sections || [])
      .map((section) => ({ ...section, score: scoreSimpleText(section.title || "", topic) }))
      .filter((section) => section.score > 0 || /\b(caution|note|restriction|usage notes)\b/i.test(section.title || ""))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    const sectionContext = collectSectionContext(sectionMatches);

    const scoredChunks = (actualIndexData.chunks || [])
      .map((chunk) => ({
        ...chunk,
        score: scoreCautionChunk(chunk, topic, "", null, sectionContext),
        cautionEvidence: extractCautionEvidenceLines(chunk.text || "", topic, "", MAX_CAUTION_EVIDENCE_LINES),
      }))
      .filter((chunk) => {
        const text = buildSearchText(chunk);
        const hasCautionEvidence = (chunk.cautionEvidence || []).length > 0;
        const hasStrongTerm = /\b(Caution|CAUTION|Note|Notes|Restriction|Restrictions|reserved|undefined|invalid|prohibited|forbidden|do\s+not|must\s+not|cannot|write\s+(?:0|1|zero|one)|cleared?\s+by\s+writing|only\s+when|while\s+running|while\s+stopped)\b/i.test(text);
        return chunk.score >= 55 && (hasCautionEvidence || hasStrongTerm);
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.page !== b.page) return a.page - b.page;
        return a.chunkIndex - b.chunkIndex;
      })
      .slice(0, MAX_CAUTION_INDEX_RESULTS_PER_TOPIC);

    if (!scoredChunks.length) continue;

    const evidenceLines = [];
    const typeScores = new Map();
    for (const chunk of scoredChunks) {
      for (const line of chunk.cautionEvidence || []) {
        if (!evidenceLines.includes(line)) evidenceLines.push(line);
        const labels = classifyCautionLine(line);
        const type = cautionTypeFromLabels(labels, line, topic);
        typeScores.set(type, (typeScores.get(type) || 0) + 1);
        if (evidenceLines.length >= MAX_CAUTION_EVIDENCE_LINES) break;
      }
      if (evidenceLines.length >= MAX_CAUTION_EVIDENCE_LINES) break;
    }

    const type = [...typeScores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || cautionTypeFromLabels([], evidenceLines[0] || "", topic);
    const pages = [...new Set(scoredChunks.map((chunk) => Number(chunk.page)).filter(Number.isFinite))].sort((a, b) => a - b);
    const topScore = Math.max(...scoredChunks.map((chunk) => Number(chunk.score || 0)));
    const relatedRegisters = inferCautionRelatedRegisters(scoredChunks, actualRegistersIndex);

    cautions.push({
      id: canonicalCautionId(filename, topic, type),
      filename,
      topic: normalizeSequenceTopic(topic),
      type,
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
        evidenceLines: chunk.cautionEvidence || [],
        preview: normalizeText(chunk.text || "").slice(0, 700),
      })),
      evidenceLines,
      riskForDriver: riskForCautionType(type),
      confidence: cautionConfidenceFromScore(topScore),
      score: Math.round(topScore),
      source: "caution-index-heuristic",
    });
  }

  const dedup = new Map();
  for (const caution of cautions) {
    const key = `${caution.type}:${normalizeForSearch(caution.topic)}:${(caution.relatedRegisters || []).slice(0, 3).join(",")}`;
    const previous = dedup.get(key);
    if (!previous || caution.score > previous.score) dedup.set(key, caution);
  }

  const finalCautions = [...dedup.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.topic).localeCompare(String(b.topic));
  });

  const index = {
    schemaVersion: CAUTION_INDEX_SCHEMA_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    dependencyVersions: { "chunk-index": actualIndexData.schemaVersion, sections: actualSectionsIndex.schemaVersion, registers: actualRegistersIndex.schemaVersion },
    cautionCount: finalCautions.length,
    cautions: finalCautions,
  };

  const cautionsPath = safeCautionsIndexPath(filename);
  await atomicWriteJson(cautionsPath, index);
  return index;
}

export function riskForCautionType(type) {
  switch (String(type || "")) {
    case "reserved-bit":
      return "Preserve reserved bits and avoid raw writes that may change undefined/reserved fields.";
    case "clear-semantics-write-1":
      return "Verify write-1-to-clear behavior before acknowledging interrupt/status flags.";
    case "clear-semantics-write-0":
      return "Verify write-0-to-clear behavior before acknowledging interrupt/status flags.";
    case "write-timing":
      return "Verify allowed write timing such as stopped/running state before register writes.";
    case "undefined-invalid":
      return "Avoid invalid/undefined settings and mark unsupported configurations in the driver.";
    case "prohibited":
      return "Do not implement register operations that the manual marks as prohibited/forbidden.";
    case "reset-access":
      return "Verify reset/access constraints and preserve initial/reset values where required.";
    default:
      return "Review this caution before approving related register writes.";
  }
}

export async function loadCautionsIndex(filename) {
  const cautionsPath = safeCautionsIndexPath(filename);
  if (!(await pathExists(cautionsPath))) return null;

  try {
    const index = await readJsonCached(cautionsPath);
    if (index.schemaVersion !== CAUTION_INDEX_SCHEMA_VERSION) return null;
    if (index.filename !== filename) return null;
    if (!Array.isArray(index.cautions)) return null;
    const currentSource = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(index.source, currentSource)) return null;
    return index;
  } catch {
    return null;
  }
}

export async function getCautionsIndex(filename, options = {}) {
  const existing = await loadCautionsIndex(filename);
  if (existing) return existing;

  if (options.buildIfMissing === true) {
    const indexData = await loadPdfIndex(filename, { buildIfMissing: true });
    const sectionsIndex = await getSectionsIndex(filename, { buildIfMissing: true });
    const registersIndex = await getRegistersIndex(filename, { buildIfMissing: true });
    return await buildCautionsIndex(filename, indexData, sectionsIndex, registersIndex);
  }

  throw new Error(`Cautions index not found for ${filename}. Run index_pdf or start_index_pdf first.`);
}

export function cautionMatchesFilter(caution, filter = "", register = "", type = "") {
  const filterText = normalizeForSearch(filter);
  const registerCanonical = normalizeRegisterName(register);
  const typeText = normalizeForSearch(type);
  const cautionType = normalizeForSearch(caution.type || "");
  const searchText = normalizeForSearch([
    caution.topic,
    caution.type,
    caution.riskForDriver,
    ...(caution.relatedRegisters || []),
    ...(caution.evidenceLines || []),
    ...((caution.relatedSections || []).map((section) => section.title || "")),
  ].join("\n"));
  const canonicalRegisters = new Set((caution.relatedRegisters || []).map(normalizeRegisterName).filter(Boolean));

  if (filterText) {
    let ok = searchText.includes(filterText);
    if (!ok) {
      ok = filterText.split(/\s+/).filter((term) => term.length > 1).some((term) => searchText.includes(term));
    }
    if (!ok) return false;
  }

  if (registerCanonical) {
    let ok = canonicalRegisters.has(registerCanonical);
    if (!ok) {
      for (const name of canonicalRegisters) {
        if (name.includes(registerCanonical) || registerCanonical.includes(name)) {
          ok = true;
          break;
        }
      }
    }
    if (!ok) return false;
  }

  if (typeText && !cautionType.includes(typeText)) return false;
  return true;
}

export async function listCautionsFromIndex(filename, options = {}) {
  const cautionsIndex = await getCautionsIndex(filename);
  const topK = clampCautionListTopK(options.topK);
  const filter = String(options.filter || "").trim();
  const register = String(options.register || "").trim();
  const type = String(options.type || "").trim();

  const results = (cautionsIndex.cautions || [])
    .filter((caution) => cautionMatchesFilter(caution, filter, register, type))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.topic).localeCompare(String(b.topic));
    })
    .slice(0, topK);

  return { cautionsIndex, results, filter, register, type };
}

export function formatPersistentCautionList(cautionsIndex, results, options = {}) {
  const filename = cautionsIndex.filename;
  const filter = String(options.filter || "").trim();
  const register = String(options.register || "").trim();
  const type = String(options.type || "").trim();
  const header = [
    `Persistent caution index for ${filename}`,
    `Total cautions indexed: ${cautionsIndex.cautionCount}`,
    filter ? `Filter: ${filter}` : null,
    register ? `Register: ${register}` : null,
    type ? `Type: ${type}` : null,
    `Results shown: ${results.length}`,
  ].filter(Boolean);

  if (!results.length) {
    return [
      ...header,
      "",
      "No persistent caution candidates matched.",
      "Suggested fallback:",
      `- find_caution(filename="${filename}", topic="${filter || 'reserved bits'}"${register ? `, register="${register}"` : ""})`,
      `- find_section(filename="${filename}", section="Usage Notes")`,
    ].join("\n");
  }

  return [
    ...header,
    "",
    ...results.map((caution, index) => {
      const pages = (caution.pages || []).join(", ") || "unknown";
      const registers = (caution.relatedRegisters || []).slice(0, 10).join(", ") || "none";
      const evidence = (caution.evidenceLines || []).slice(0, 3).map((line) => `   - ${line}`).join("\n") || "   - none";
      const chunks = (caution.chunks || []).slice(0, 4).map((chunk) => chunk.id).join(", ") || "none";
      const firstPage = (caution.pages || [1])[0] || 1;
      const endPage = firstPage + DEFAULT_PAGE_RANGE - 1;
      return [
        `${index + 1}. ${caution.topic}`,
        `   Type: ${caution.type}`,
        `   Pages: ${pages}`,
        `   Related registers: ${registers}`,
        `   Confidence: ${caution.confidence}`,
        `   Score: ${caution.score}`,
        `   Risk for driver: ${caution.riskForDriver || "review required"}`,
        `   Related chunks: ${chunks}`,
        "   Evidence:",
        evidence,
        `   Suggested get: get_cautions_for_register(filename="${filename}", register="${(caution.relatedRegisters || [register || ''])[0] || register}")`,
        `   Suggested read: read_pdf_pages(filename="${filename}", start_page=${firstPage}, end_page=${endPage})`,
      ].join("\n");
    }),
  ].join("\n\n");
}

export async function getCautionsForRegister(filename, register, options = {}) {
  const rawRegister = String(register || "").trim();
  if (!rawRegister) throw new Error("register is required");
  const includeDynamicFallback = Boolean(options.includeDynamicFallback || options.allowFallback === true);

  const listed = await listCautionsFromIndex(filename, {
    register: rawRegister,
    filter: options.filter,
    topK: options.topK,
  });

  if (listed.results.length) {
    return {
      filename,
      register: rawRegister,
      filter: String(options.filter || "").trim(),
      cautionsIndex: listed.cautionsIndex,
      results: listed.results,
      fallback: null,
      fallbackMode: "exact-persistent",
    };
  }

  const explicitFilter = String(options.filter || "").trim();
  const fallbackTopic = explicitFilter || "reserved bits write timing clear status flag";
  const persistentFallback = await persistentCautionFallbackForRegister(listed.cautionsIndex, rawRegister, {
    filter: fallbackTopic,
    topK: options.topK,
    filterExplicit: Boolean(explicitFilter),
  });

  if (persistentFallback.length) {
    return {
      filename,
      register: rawRegister,
      filter: String(options.filter || "").trim(),
      cautionsIndex: listed.cautionsIndex,
      results: persistentFallback,
      fallback: null,
      fallbackMode: "persistent-general",
    };
  }

  const fallback = includeDynamicFallback ? await findCautionInIndex(filename, fallbackTopic, {
    register: rawRegister,
    topK: options.topK,
  }) : null;

  return {
    filename,
    register: rawRegister,
    filter: String(options.filter || "").trim(),
    cautionsIndex: listed.cautionsIndex,
    results: [],
    fallback,
    fallbackMode: fallback ? "dynamic" : "none",
  };
}

export async function persistentCautionFallbackForRegister(cautionsIndex, register, options = {}) {
  const rawRegister = String(register || "").trim();
  const filter = String(options.filter || "").trim();
  const filterExplicit = Boolean(options.filterExplicit);
  const topK = clampCautionListTopK(options.topK);
  const canonicalRegister = normalizeRegisterName(rawRegister);
  const filterText = normalizeForSearch(filter);
  const registerPages = new Set();

  try {
    const { results } = await searchRegistersIndex(cautionsIndex.filename, rawRegister, 5);
    for (const entry of results || []) {
      for (const page of entry.pages || []) {
        const n = Number(page);
        if (Number.isFinite(n)) registerPages.add(n);
      }
    }
  } catch {}

  const scored = (cautionsIndex.cautions || [])
    .map((caution) => {
      const relatedRegisters = (caution.relatedRegisters || []).map(normalizeRegisterName).filter(Boolean);
      const cautionPages = (caution.pages || []).map(Number).filter(Number.isFinite);
      const pageOverlap = cautionPages.some((page) => registerPages.has(page));
      const nearPage = cautionPages.some((page) => {
        for (const regPage of registerPages) {
          if (Math.abs(page - regPage) <= DEFAULT_PAGE_RANGE) return true;
        }
        return false;
      });
      const text = [
        caution.topic,
        caution.type,
        caution.riskForDriver,
        ...(caution.evidenceLines || []),
        ...(caution.relatedRegisters || []),
        ...((caution.relatedSections || []).map((section) => section.title || "")),
      ].join("\n");
      let matchScore = Math.round(Number(caution.score || 0) / 8);
      let hasRegisterRelation = false;
      if (filterText) {
        matchScore += scoreSimpleText(text, filter) + (cautionMatchesFilter(caution, filter, "", "") ? 60 : 0);
      } else {
        matchScore += scoreSimpleText(text, "reserved bits write timing clear status flag");
      }
      if (canonicalRegister) {
        for (const related of relatedRegisters) {
          if (related === canonicalRegister) {
            matchScore += 120;
            hasRegisterRelation = true;
          } else if (related.includes(canonicalRegister) || canonicalRegister.includes(related)) {
            matchScore += 60;
            hasRegisterRelation = true;
          }
        }
      }
      if (pageOverlap) matchScore += 90;
      else if (nearPage) matchScore += 35;
      if (!filterExplicit && !hasRegisterRelation && !pageOverlap && !nearPage) matchScore = 0;
      return {
        ...caution,
        matchScore,
        matchNote: hasRegisterRelation
          ? "persistent caution explicitly references register"
          : pageOverlap
            ? "persistent caution appears on a detected register page"
            : nearPage
              ? "persistent caution appears near detected register pages"
          : "persistent/general caution candidate; verify against register pages before treating as register-specific",
      };
    })
    .filter((caution) => Number(caution.matchScore || 0) > 0)
    .sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return Number(b.score || 0) - Number(a.score || 0);
    })
    .slice(0, topK);

  return scored;
}

export function formatCautionsForRegister(result) {
  const filename = result.filename;
  const register = result.register;
  const filter = result.filter;

  if (!result.results.length) {
    return [
      `No persistent caution candidates found for register "${register}"${filter ? ` with filter "${filter}"` : ""}.`,
      "",
      result.fallback
        ? "Dynamic fallback result:"
        : "Dynamic fallback skipped by default to avoid timeout on large manuals.",
      result.fallback ? formatCautionResults(result.fallback) : `- For deeper recall, call get_cautions_for_register(filename="${filename}", register="${register}", include_dynamic_fallback=true) or find_caution(filename="${filename}", topic="reserved bits", register="${register}").`,
    ].join("\n");
  }

  return [
    result.fallbackMode === "persistent-general"
      ? `Persistent/general caution candidates for register "${register}"`
      : `Persistent cautions for register "${register}"`,
    `File: ${filename}`,
    filter ? `Filter: ${filter}` : null,
    result.fallbackMode === "persistent-general" ? "Note: no exact register-specific caution matched; showing timeout-safe persistent/general candidates." : null,
    `Results shown: ${result.results.length}`,
    "",
    ...result.results.map((caution, index) => {
      const pages = (caution.pages || []).join(", ") || "unknown";
      const evidence = (caution.evidenceLines || []).slice(0, 5).map((line) => `   - ${line}`).join("\n") || "   - none";
      const chunks = (caution.chunks || []).slice(0, 5).map((chunk) => chunk.id).join(", ") || "none";
      const firstPage = (caution.pages || [1])[0] || 1;
      const endPage = firstPage + DEFAULT_PAGE_RANGE - 1;
      return [
        `Result ${index + 1}`,
        `Topic: ${caution.topic}`,
        `Type: ${caution.type}`,
        `Pages: ${pages}`,
        `Confidence: ${caution.confidence}`,
        `Score: ${caution.score}`,
        caution.matchScore ? `Match score: ${caution.matchScore}` : null,
        caution.matchNote ? `Match note: ${caution.matchNote}` : null,
        `Risk for driver: ${caution.riskForDriver || "review required"}`,
        `Related chunks: ${chunks}`,
        "Evidence:",
        evidence,
        `Suggested dynamic check: find_caution(filename="${filename}", topic="${caution.topic}", register="${register}")`,
        `Suggested page read: read_pdf_pages(filename="${filename}", start_page=${firstPage}, end_page=${endPage})`,
      ].filter(Boolean).join("\n");
    }),
  ].filter(Boolean).join("\n\n---\n\n");
}
