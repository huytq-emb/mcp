import { canonicalSymbol, normalizeForSearch } from "../core/runtime-helpers.js";
import { getEvidenceGraphEntity, getEvidenceGraphRuntimeIndex, loadEvidenceGraph } from "../services/evidence-graph.js";
import { hybridSearchPdf } from "../services/search.js";
import { SERVER_VERSION } from "../core/runtime-constants.js";
import { createEvidenceBundleV2 } from "../evidence/contract.js";

const RRF_K = 60;
const RRF_CHANNEL_WEIGHTS = Object.freeze({ exact: 3, lexical: 1, graph: 2, neighborhood: 0.75, ocr: 0.5 });
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 40;
const MAX_QUERY_CONTEXT_ENTITIES = 100;
const MAX_QUERY_CONTEXT_RELATIONSHIPS = 200;
const EXACT_GRAPH_QUERY_CACHE_ENTRIES = 64;
const exactGraphMatchCache = new WeakMap();
const DEFAULT_MAX_IN_PROCESS_FUSION_GRAPH_ITEMS = 75_000;
const QUERY_CONTEXT_RELATIONSHIP_TYPES = new Set([
  "register-has-bitfield",
  "register-has-caution",
  "sequence-has-step",
  "sequence-step-occurs-before",
  "sequence-uses-register",
  "figure-illustrates-sequence",
  "register-is-defined-in-section",
  "entity-is-mentioned-on-page",
  "table-describes-register",
]);
const GENERIC_QUERY_TERMS = new Set(["a", "access", "address", "an", "and", "apply", "are", "be", "bit", "bitfield", "bits", "by", "caution", "description", "details", "does", "driver", "each", "field", "figure", "find", "for", "from", "how", "in", "initial", "is", "it", "its", "linux", "locate", "manual", "must", "of", "on", "or", "our", "offset", "page", "register", "reset", "sequence", "size", "status", "table", "that", "the", "their", "them", "these", "they", "this", "those", "to", "used", "value", "we", "what", "when", "where", "which", "with", "you", "your"]);
const GENERIC_MODULE_SYMBOLS = new Set(["ADC", "CAN", "CPU", "DMA", "DMAC", "ETH", "ETHERNET", "GBETH", "GPIO", "GPT", "ICU", "IRQ", "MAC", "PCI", "PCIE", "PFC", "PHY", "PWM", "USB", "USB2", "USB3", "WDT"]);
const GENERIC_MODULE_TERMS = new Set(["adc", "can", "dma", "dmac", "ethernet", "gbeth", "gpio", "gpt", "pfc", "pwm", "timer", "usb", "usb2", "usb3", "watchdog", "wdt"]);
const GENERIC_ENTITY_PHRASES = new Set(["bitfield table", "caution", "clock", "figure", "initialization", "interrupt", "register table", "reset", "section", "sequence", "table"]);
const CAUTION_SECTION_PATTERN = /\b(?:after changing|before changing|caution|do not|invalid|must not|out of order|prohibit(?:ed)?|reserved|restriction|requires? manipulation|write[ -]?protect(?:ed|ion)?)\b/i;
const SEQUENCE_SECTION_PATTERN = /\b(?:after|before|clear|disable|enable|initiali[sz](?:e|ation)?|operation|order|procedure|sequence|setting|start|stop|write)\b/i;

function clampTopK(value) {
  const numeric = Number(value ?? DEFAULT_TOP_K);
  if (!Number.isFinite(numeric)) return DEFAULT_TOP_K;
  return Math.max(1, Math.min(MAX_TOP_K, Math.floor(numeric)));
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

export function shouldUseInProcessLexicalFusion(graph, limit = process.env.RENESAS_MCP_MAX_FUSION_GRAPH_ITEMS) {
  const configured = Number(limit ?? DEFAULT_MAX_IN_PROCESS_FUSION_GRAPH_ITEMS);
  const boundedLimit = Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : DEFAULT_MAX_IN_PROCESS_FUSION_GRAPH_ITEMS;
  const graphItems = Number(graph?.entityCount ?? graph?.entities?.length ?? 0)
    + Number(graph?.relationshipCount ?? graph?.relationships?.length ?? 0);
  return { enabled: graphItems <= boundedLimit, graphItems, limit: boundedLimit };
}

// Conflicts retain their human-readable verification hints for compatibility,
// but EvidenceBundle v2 next actions are a typed tool-call contract.
export function conflictVerificationActions(conflict, filename) {
  return unique(conflict?.pages || []).map(Number).filter((page) => Number.isFinite(page) && page > 0).map((page) => ({
    tool: "read_pdf_pages",
    arguments: { filename, start_page: page, end_page: page },
    reason: `Resolve ${conflict.field || "evidence"} conflict for ${conflict.entityId || "the selected entity"}.`,
  }));
}

function confidenceRank(value) {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function normalizedTokens(value) {
  return unique(normalizeForSearch(value).split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((token) => token.length >= 2));
}

function symbolTokens(value) {
  return unique(String(value || "").split(/[\s,;:/()[\]{}]+/).map(canonicalSymbol).filter((token) => token.length >= 2));
}

function hardwareSymbolTokens(value) {
  return unique((String(value || "").match(/[A-Za-z][A-Za-z0-9_]*/g) || [])
    .filter((token) => token.length >= 2 && (token.includes("_") || /\d/.test(token) || token === token.toUpperCase()))
    .map(canonicalSymbol)
    .filter(Boolean));
}

function strictHardwareSymbolTokens(value) {
  return hardwareSymbolTokens(value).filter((symbol) => !GENERIC_MODULE_SYMBOLS.has(symbol));
}

export function queryLexicalTerms(value) {
  // A qualified hardware symbol is one indivisible lookup key. Its pieces
  // must not independently satisfy an unrelated entity (for example a
  // section containing "DMAC" and page-like number "123").
  const qualifiedSymbolParts = new Set((String(value || "").match(/[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]+/g) || [])
    .flatMap((symbol) => normalizeForSearch(symbol).split(/\s+/))
    .filter(Boolean));
  const normalizedTerm = (term) => ({
    cautions: "caution", changed: "chang", changing: "chang", cleared: "clear", clearing: "clear", completes: "complete", locked: "lock",
    multiplexed: "multiplex", multiplexing: "multiplex", registers: "register", restrictions: "restriction", stopped: "stop", stopping: "stop", written: "write",
  }[term] || term);
  const terms = normalizedTokens(value).map(normalizedTerm)
    .filter((term) => !GENERIC_QUERY_TERMS.has(term) && !qualifiedSymbolParts.has(term));
  if (terms.includes("watchdog")) terms.push("wdt");
  if (terms.includes("dma")) terms.push("dmac");
  return unique(terms);
}

function entityText(entity) {
  const properties = entity.properties || {};
  const curatedProperties = entity.type === "register"
    ? [properties.descriptions, properties.offsets, properties.resetValues, properties.accessSizes]
    : entity.type === "bitfield"
      ? [properties.register, properties.bitRange, properties.access, properties.reset]
      : entity.type === "sequence"
        ? [properties.kind, properties.stepSummaries, properties.steps?.map((step) => [step.register, step.bitfield, step.value, step.condition, step.summary].filter(Boolean).join(" "))]
      : entity.type === "sequence-step"
        ? [properties.register, properties.bitfield, properties.value, properties.condition]
        : entity.type === "caution"
          ? [properties.type, properties.riskForDriver, properties.evidenceLines]
          : entity.type === "table"
            ? [properties.kind, properties.number, properties.caption, properties.title, properties.headerText, properties.columnRoles]
            : [properties.kind, properties.number];
  return normalizeForSearch([
    entity.canonicalName,
    entity.displayName,
    ...(entity.aliases || []),
    entity.type,
    ...curatedProperties.flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean),
  ].join(" "));
}

function primaryEntityTypes(query) {
  const text = normalizeForSearch(query);
  const types = new Set();
  const tableIntent = /\b(table)\b/.test(text);
  const figureIntent = /\b(figure|diagram|waveform|visual)\b/.test(text);
  const sequenceIntent = /\b(sequence|procedure|order|first|next|then|completes?)\b/.test(text)
    || (/\bhow\b/.test(text) && /\b(initialize|initialization|start|stop|stopped|clear|cleared|refresh|enable|enabled|disable|disabled)\b/.test(text));
  const cautionIntent = /\b(caution|cautions|restriction|restrictions|prohibited|must not|avoid|before changing|after changing|locked|out of order|happens if)\b/.test(text)
    || (!sequenceIntent && /\bwrite protection\b/.test(text));
  const bitfieldIntent = /\b(bit|bits|field|fields|bitfield|bitfields)\b/.test(text);
  if (cautionIntent) types.add("caution");
  if (tableIntent) types.add("table");
  if (figureIntent) types.add("figure");
  if (sequenceIntent) { types.add("sequence"); types.add("sequence-step"); }
  if (!cautionIntent && bitfieldIntent) types.add("bitfield");
  if (!cautionIntent && !tableIntent && !figureIntent && !sequenceIntent && !bitfieldIntent && /\b(register|offset|reset|access|control)\b/.test(text)) types.add("register");
  if (!tableIntent && !figureIntent && /\b(where|chapter|page|pages|documents?)\b/.test(text)) types.add("section");
  return types;
}

export function preferredEntityTypes(query, options = {}) {
  const text = normalizeForSearch(query);
  const types = new Set();
  const sequenceIntent = /\b(sequence|procedure|order|first|next|then|completes?)\b/.test(text) || (/\bhow\b/.test(text) && /\b(initialize|initialization|start|stop|stopped|clear|cleared|refresh|enable|enabled|disable|disabled)\b/.test(text));
  if (/\b(register|offset|reset|access|control)\b/.test(text)) types.add("register");
  if (/\b(bit|bits|field|fields|bitfield|bitfields)\b/.test(text)) types.add("bitfield");
  if (sequenceIntent) { types.add("sequence"); types.add("sequence-step"); }
  if (/\b(caution|cautions|restriction|restrictions|prohibited|reserved|must not|avoid|before changing|after changing|locked|out of order|happens if)\b/.test(text) || (!sequenceIntent && /\bwrite protection\b/.test(text))) types.add("caution");
  if (/\b(table)\b/.test(text)) types.add("table");
  if (/\b(figure|diagram|waveform|visual)\b/.test(text)) types.add("figure");
  const symbols = hardwareSymbolTokens(query);
  const contextSymbols = hardwareSymbolTokens(options.register || options.moduleContext || "");
  const hasRegisterContext = contextSymbols.length > 0 || symbols.some((symbol) => symbol.includes("_"));
  if (hasRegisterContext && strictHardwareSymbolTokens(query).some((symbol) => symbol.length <= 4)) types.add("bitfield");
  if (/\b(where|chapter|page|pages|documents?|described)\b/.test(text)) types.add("section");
  const hasModuleContext = symbols.some((symbol) => GENERIC_MODULE_SYMBOLS.has(symbol)) || queryLexicalTerms(query).some((term) => GENERIC_MODULE_TERMS.has(term));
  if (hasModuleContext && !["bitfield", "caution", "figure", "sequence", "sequence-step", "table"].some((type) => types.has(type))) types.add("register");
  return types;
}

function entityTypeBoost(entityType, query, options = {}) {
  if (primaryEntityTypes(query).has(entityType)) return 140;
  return preferredEntityTypes(query, options).has(entityType) ? 60 : 0;
}

export function symbolVariantMatches(alias, symbol, entityType) {
  if (!alias || !symbol || symbol.length < 3) return false;
  const parts = alias.split("_").filter((part) => part.length >= 3);
  if (parts.includes(symbol)) return true;
  if (GENERIC_MODULE_SYMBOLS.has(symbol) && parts.some((part) => part === symbol || new RegExp(`^${symbol}\\d+$`).test(part))) return true;
  const symbolParts = symbol.split("_").filter((part) => part.length >= 3);
  if (symbolParts.length > 1 && symbolParts.every((part) => parts.includes(part))) return true;
  return ["section", "sequence", "sequence-step", "caution", "table", "figure"].includes(entityType) && alias.includes(symbol);
}

function entityQueryRelevance(entity, query, options = {}) {
  const aliases = unique([entity.canonicalName, entity.displayName, ...(entity.aliases || [])]).map(canonicalSymbol).filter(Boolean);
  const symbols = hardwareSymbolTokens(query);
  const strictSymbols = strictHardwareSymbolTokens(query);
  const terms = queryLexicalTerms(query);
  const text = entityText(entity);
  let score = 0;
  let strictAliasMatched = false;
  for (const symbol of symbols) {
    if (aliases.includes(symbol)) {
      score += 120;
      if (strictSymbols.includes(symbol)) strictAliasMatched = true;
    } else if (aliases.some((alias) => symbolVariantMatches(alias, symbol, entity.type))) {
      score += 60;
      if (strictSymbols.includes(symbol)) strictAliasMatched = true;
    } else if (strictSymbols.includes(symbol) && text.includes(normalizeForSearch(symbol))) score += 45;
  }
  for (const term of terms) if (text.includes(term)) score += term.length > 4 ? 12 : 5;
  const preferredTypes = preferredEntityTypes(query, options);
  const locatorOnly = preferredTypes.size === 1 && preferredTypes.has("section");
  if (locatorOnly && entity.type !== "section") return 0;
  if (preferredTypes.size && !preferredTypes.has(entity.type) && !strictAliasMatched) return 0;
  if (score > 0) score += entityTypeBoost(entity.type, query, options);
  return score;
}

function matchingLocations(entity, { requestedPage = null, requestedChunkId = "" } = {}) {
  return (entity.sourceLocations || []).filter((location) => {
    if (requestedPage !== null && Number(location.page) !== Number(requestedPage)) return false;
    if (requestedChunkId && !(location.chunkIds || []).includes(requestedChunkId)) return false;
    return true;
  });
}

export function entityEvidence(entity, { reason = "graph entity match", rank = 0, query = "", requestedPage = null, requestedChunkId = "", selectedLocation = null } = {}) {
  const locations = entity.sourceLocations || [];
  const selectorMatches = matchingLocations(entity, { requestedPage, requestedChunkId });
  if ((requestedPage !== null || requestedChunkId) && !selectorMatches.length) return null;
  const location = selectedLocation || [...(selectorMatches.length ? selectorMatches : locations)].sort((left, right) => {
    const score = (candidate) => (candidate.chunkIds || []).some((id) => String(id).includes(`:p${candidate.page}:`)) ? 100 : 0;
    const sourceScoreDelta = Number(right.sourceScore || 0) - Number(left.sourceScore || 0);
    if (Math.abs(sourceScoreDelta) > 10) return sourceScoreDelta;
    const chunkCountDelta = Math.min(16, (right.chunkIds || []).length) - Math.min(16, (left.chunkIds || []).length);
    return chunkCountDelta || sourceScoreDelta || score(right) - score(left) || Number(left.page || Number.MAX_SAFE_INTEGER) - Number(right.page || Number.MAX_SAFE_INTEGER);
  })[0] || {};
  const statement = entity.type === "bitfield"
    ? `${entity.properties?.register || ""}.${entity.canonicalName} ${entity.properties?.bitRange || ""}`.trim()
    : entity.canonicalName;
  const evidence = {
    id: `evidence:${entity.id}:${location.page || "none"}:${(location.chunkIds || [])[0] || "none"}`,
    entityId: entity.id,
    kind: entity.type,
    canonicalName: entity.canonicalName,
    statement,
    properties: entity.properties || {},
    page: location.page ?? null,
    chunkId: (location.chunkIds || [])[0] || null,
    sectionPath: location.sectionPath || [],
    boundingBox: location.boundingBox || [],
    sourceArtifact: location.sourceArtifact || "",
    extractionMethod: location.extractionMethod || entity.extractionMethod || "artifact-import",
    confidence: entity.confidence || "medium",
    verificationStatus: entity.verificationStatus || "candidate",
    relatedEntityIds: [entity.id],
    retrieval: { sourceChannels: ["graph"], reasons: [reason], rank, query },
  };
  if (entity.type === "figure" && entity.properties?.figureId) {
    evidence.figureId = entity.properties.figureId;
    evidence.imagePath = entity.properties.imagePath || "";
  }
  return evidence;
}

export function chunkEvidence(chunk, { rank = 0, reasons = [], query = "" } = {}) {
  const isOcr = chunk.sourceType === "figure_ocr" || chunk.source_type === "figure_ocr";
  const figureId = chunk.figureUid || chunk.figure_uid || chunk.figure_id || "";
  return {
    id: `evidence:${isOcr ? "ocr" : "chunk"}:${chunk.id || chunk.figureUid || `${chunk.page}-${rank}`}`,
    kind: isOcr ? "figure-ocr-locator" : (chunk.chunkType || "paragraph"),
    statement: String((chunk.hybridEvidenceLines || [])[0] || chunk.text || chunk.ocrText || "").replace(/\s+/g, " ").trim().slice(0, 700),
    page: Number.isFinite(Number(chunk.page)) ? Number(chunk.page) : null,
    chunkId: isOcr ? null : (chunk.id || null),
    ...(isOcr && figureId ? { figureId } : {}),
    sectionPath: chunk.headings || [],
    boundingBox: chunk.bbox || [],
    sourceArtifact: isOcr ? "figure_ocr" : "chunk-index",
    extractionMethod: isOcr ? "optional-ocr-search-metadata" : "hybrid-lexical-retrieval",
    confidence: isOcr ? "low" : (Number(chunk.score || 0) >= 150 ? "high" : "medium"),
    verificationStatus: isOcr ? "visual-verification-required" : "candidate",
    relatedEntityIds: [],
    retrieval: { sourceChannels: [isOcr ? "ocr" : "lexical"], reasons, rank, query },
  };
}

function resultKey(result) {
  return result.entity?.id || result.entityId || result.evidence?.relatedEntityIds?.[0] || result.evidence?.id || result.id;
}

function entitiesForChunk(graph, chunk) {
  const direct = graph.chunkEntityIds?.[chunk.id] || [];
  if (direct.length) return direct;
  const symbolLinked = unique([...(chunk.symbols || []), ...(chunk.registers || []), ...(chunk.bitFields || [])]
    .flatMap((symbol) => graph.symbolEntityIds?.[String(symbol || "").trim().toLowerCase()] || []));
  if (symbolLinked.length) return symbolLinked;
  return graph.pageEntityIds?.[Number(chunk.page)] || [];
}

function lexicalEntityRows(graph, lexicalResults, query) {
  const { entitiesById: byId } = getEvidenceGraphRuntimeIndex(graph);
  return lexicalResults.flatMap((chunk) => {
    const baseEvidence = chunkEvidence(chunk, { reasons: chunk.hybridReasons || ["hybrid lexical match"], query });
    if (baseEvidence.kind === "figure-ocr-locator" && !baseEvidence.figureId) return [];
    const entityIds = entitiesForChunk(graph, chunk).filter((id) => byId.has(id))
      .map((id) => ({ id, score: entityQueryRelevance(byId.get(id), query) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((item) => item.id);
    if (!entityIds.length) return [{ evidence: baseEvidence, retrievalReasons: chunk.hybridReasons || ["hybrid lexical match"] }];
    return entityIds.slice(0, 16).map((entityId) => ({
      entity: byId.get(entityId),
      entityId,
      evidence: { ...baseEvidence, id: `${baseEvidence.id}:${entityId}`, entityId, relatedEntityIds: [entityId] },
      retrievalReasons: unique([...(chunk.hybridReasons || ["hybrid lexical match"]), `chunk linked to ${entityId}`]),
    }));
  });
}

export function reciprocalRankFuse(channels) {
  const byKey = new Map();
  for (const channel of channels) {
    for (const [index, item] of (channel.results || []).entries()) {
      const key = resultKey(item);
      if (!key) continue;
      const existing = byKey.get(key) || { ...item, score: 0, sourceChannels: [], channelRanks: {}, channelEvidence: {}, retrievalReasons: [] };
      if (!existing.channelRanks[channel.name]) {
        existing.score += (RRF_CHANNEL_WEIGHTS[channel.name] || 1) / (RRF_K + index + 1);
        existing.channelRanks[channel.name] = index + 1;
      }
      existing.sourceChannels = unique([...existing.sourceChannels, channel.name]);
      const provenance = item.evidence ? { id: item.evidence.id, page: item.evidence.page ?? null, chunkId: item.evidence.chunkId ?? null, sourceArtifact: item.evidence.sourceArtifact || "" } : null;
      if (provenance) existing.channelEvidence[channel.name] = unique([...(existing.channelEvidence[channel.name] || []).map((entry) => JSON.stringify(entry)), JSON.stringify(provenance)]).map((entry) => JSON.parse(entry));
      existing.retrievalReasons = unique([...existing.retrievalReasons, ...(item.retrievalReasons || []), `${channel.name} rank ${index + 1}`]);
      if (!existing.entity && item.entity) existing.entity = item.entity;
      if (!existing.evidence && item.evidence) existing.evidence = item.evidence;
      byKey.set(key, existing);
    }
  }
  return [...byKey.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return confidenceRank(right.entity?.confidence || right.evidence?.confidence || "low") - confidenceRank(left.entity?.confidence || left.evidence?.confidence || "low");
  });
}

export function exactGraphMatches(graph, query, options = {}) {
  const cacheKey = JSON.stringify({
    query: String(query || ""),
    register: String(options.register || ""),
    moduleContext: String(options.moduleContext || ""),
  });
  let cache = exactGraphMatchCache.get(graph);
  if (!cache) {
    cache = new Map();
    exactGraphMatchCache.set(graph, cache);
  }
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return cached;
  }
  const symbols = hardwareSymbolTokens(query);
  const strictSymbols = strictHardwareSymbolTokens(query);
  const terms = queryLexicalTerms(query);
  const contextSymbols = hardwareSymbolTokens(options.register || options.moduleContext || "");
  const longContext = [...symbols, ...contextSymbols].some((token) => token.length > 3);
  const preferredTypes = preferredEntityTypes(query, options);
  const normalizedQuery = normalizeForSearch(query);
  const qualifiedSymbolPhrases = (String(query || "").match(/[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]+/g) || []).map(normalizeForSearch);
  const hasModuleQueryContext = symbols.some((symbol) => GENERIC_MODULE_SYMBOLS.has(symbol)) || terms.some((term) => GENERIC_MODULE_TERMS.has(term));
  const matches = [];
  for (const entity of graph.entities || []) {
    if (["document", "page"].includes(entity.type)) continue;
    const aliases = unique([entity.canonicalName, ...(entity.aliases || [])]).map(canonicalSymbol);
    const text = entityText(entity);
    let score = 0;
    const reasons = [];
    let symbolMatched = false;
    let strictAliasMatched = false;
    for (const symbol of symbols) {
      const shortSymbol = symbol.length <= 3;
      const shortSymbolContextMatched = !shortSymbol || !contextSymbols.length || contextSymbols.some((contextSymbol) => text.includes(normalizeForSearch(contextSymbol)));
      if (aliases.includes(symbol)) {
        if ((shortSymbol && !longContext) || !shortSymbolContextMatched) continue;
        score += shortSymbol ? 30 : 120;
        symbolMatched = true;
        if (strictSymbols.includes(symbol)) strictAliasMatched = true;
        reasons.push(shortSymbol ? `context-qualified short symbol ${symbol}` : `exact symbol ${symbol}`);
      } else if (aliases.some((alias) => symbolVariantMatches(alias, symbol, entity.type))) {
        score += 60;
        symbolMatched = true;
        if (strictSymbols.includes(symbol)) strictAliasMatched = true;
        reasons.push(`qualified symbol variant ${symbol}`);
      } else if (strictSymbols.includes(symbol) && preferredTypes.has(entity.type) && text.includes(normalizeForSearch(symbol))) {
        score += 45;
        symbolMatched = true;
        reasons.push(`structured symbol reference ${symbol}`);
      }
    }
    let lexicalHits = 0;
    for (const term of terms) {
      if (text.includes(term)) {
        lexicalHits += 1;
        score += term.length > 4 ? 12 : 4;
        reasons.push(`lexical entity term ${term}`);
      }
    }
    const canonicalPhrase = normalizeForSearch(entity.canonicalName || "");
    const canonicalPhraseHasDistinctiveTerm = canonicalPhrase.split(/\s+/).some((term) => !GENERIC_QUERY_TERMS.has(term));
    const qualifiedSymbolFragment = qualifiedSymbolPhrases.some((phrase) => phrase !== canonicalPhrase && phrase.includes(canonicalPhrase));
    const exactPhraseMatched = canonicalPhrase.length >= 5 && canonicalPhraseHasDistinctiveTerm && !qualifiedSymbolFragment && !GENERIC_ENTITY_PHRASES.has(canonicalPhrase) && ` ${normalizedQuery} `.includes(` ${canonicalPhrase} `);
    if (exactPhraseMatched) {
      score += 120;
      reasons.push("exact entity phrase");
    }
    // A lone generic lexical hit is not an exact-entity signal. This prevents
    // every register/table section containing “offset” or “reset” from
    // competing with an exact hardware symbol.
    const locatorSection = entity.type === "section" && preferredTypes.has("section");
    if (!reasons.some((reason) => reason.includes("symbol")) && !exactPhraseMatched && lexicalHits < (locatorSection ? 1 : 2)) continue;
    if (strictSymbols.length && ["register", "bitfield"].includes(entity.type) && !symbolMatched && !exactPhraseMatched) continue;
    if (preferredTypes.size === 1 && preferredTypes.has("section") && entity.type !== "section") continue;
    const supportingSectionSeed = entity.type === "section" && (
      (lexicalHits >= 2 && [...primaryEntityTypes(query)].some((type) => ["caution", "figure", "sequence", "sequence-step", "table"].includes(type)))
      || (lexicalHits >= 1 && hasModuleQueryContext && preferredTypes.has("register"))
    );
    if (preferredTypes.size && !preferredTypes.has(entity.type) && !strictAliasMatched && !supportingSectionSeed) continue;
    if (score > 0) score += entityTypeBoost(entity.type, query, options);
    if (score > 0 && entity.type === "register" && /\b(offset|reset|access|details|properties)\b/i.test(query)) {
      const properties = entity.properties || {};
      const known = [properties.offsets, properties.resetValues, properties.accessSizes].filter((values) => Array.isArray(values) && values.some((value) => value && value !== "unknown")).length;
      score += known * 20;
    }
    if (score > 0) {
      matches.push({ entity, score, retrievalReasons: unique(reasons) });
      if (matches.length >= MAX_TOP_K * 12) {
        matches.sort((left, right) => right.score - left.score || confidenceRank(right.entity.confidence) - confidenceRank(left.entity.confidence));
        matches.length = MAX_TOP_K * 3;
      }
    }
  }
  const ranked = matches.sort((left, right) => right.score - left.score || confidenceRank(right.entity.confidence) - confidenceRank(left.entity.confidence))
    .slice(0, MAX_TOP_K * 3);
  cache.set(cacheKey, ranked);
  while (cache.size > EXACT_GRAPH_QUERY_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return ranked;
}

function graphNeighborhood(graph, entities, query, options = {}) {
  const seeds = new Set(entities.map((entity) => entity.id));
  const relatedIds = new Set();
  const { entitiesById, relationshipsByEntityId } = getEvidenceGraphRuntimeIndex(graph);
  for (const seedId of seeds) {
    for (const relation of relationshipsByEntityId.get(seedId) || []) {
      relatedIds.add(relation.from === seedId ? relation.to : relation.from);
    }
  }
  return [...relatedIds]
    .map((id) => entitiesById.get(id))
    .filter((entity) => entity && !seeds.has(entity.id) && ["register", "bitfield", "sequence", "sequence-step", "caution", "table", "figure", "interrupt", "clock", "reset"].includes(entity.type))
    .map((entity) => ({ entity, relevance: entityQueryRelevance(entity, query, options), retrievalReasons: ["one-hop evidence graph relationship"] }))
    .sort((left, right) => right.relevance - left.relevance || confidenceRank(right.entity.confidence) - confidenceRank(left.entity.confidence))
    .slice(0, MAX_TOP_K * 3);
}

function pageNeighborhood(graph, evidence, query, options = {}) {
  const pages = new Set(evidence.map((item) => Number(item.page)).filter(Number.isFinite));
  const { entitiesById } = getEvidenceGraphRuntimeIndex(graph);
  const entityIds = unique([...pages].flatMap((page) => graph.pageEntityIds?.[page] || []));
  const preferredTypes = preferredEntityTypes(query, options);
  return entityIds.map((id) => entitiesById.get(id)).filter((entity) => entity && ["register", "bitfield", "sequence", "sequence-step", "caution", "table", "figure", "interrupt", "clock", "reset"].includes(entity.type))
    .map((entity) => ({ entity, relevance: entityQueryRelevance(entity, query, options) || (preferredTypes.has(entity.type) ? entityTypeBoost(entity.type, query, options) : 0), retrievalReasons: ["same-page neighborhood of ranked evidence"] }))
    .filter((item) => item.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance || confidenceRank(right.entity.confidence) - confidenceRank(left.entity.confidence))
    .slice(0, MAX_TOP_K * 3);
}

export function prioritizeRequestedEntityTypes(items, query, options = {}) {
  const primaryTypes = primaryEntityTypes(query);
  const preferredTypes = preferredEntityTypes(query, options);
  if (!primaryTypes.size && !preferredTypes.size) return items;
  const strictSymbols = strictHardwareSymbolTokens(query);
  const isStrictAnchor = (item) => ["register", "bitfield"].includes(item.entity?.type || item.evidence?.kind)
    && strictSymbols.some((symbol) => (item.retrievalReasons || []).some((reason) => reason.startsWith(`exact symbol ${symbol}`) || reason.startsWith(`qualified symbol ${symbol}`)));
  const strictAnchors = items.filter(isStrictAnchor);
  const primary = items.filter((item) => !isStrictAnchor(item) && primaryTypes.has(item.entity?.type || item.evidence?.kind));
  if (primaryTypes.has("sequence") && !primaryTypes.has("caution")) {
    const priority = (item) => {
      const type = item.entity?.type || item.evidence?.kind;
      const projected = Boolean(item.entity?.properties?.projectedFromEntityId);
      if (type === "sequence" && !projected) return 0;
      if (type === "figure") return 1;
      if (type === "sequence" && projected) return 2;
      if (type === "sequence-step") return 3;
      return 4;
    };
    primary.sort((left, right) => priority(left) - priority(right));
  }
  const preferred = items.filter((item) => !isStrictAnchor(item) && !primaryTypes.has(item.entity?.type || item.evidence?.kind) && preferredTypes.has(item.entity?.type || item.evidence?.kind));
  const remaining = items.filter((item) => !isStrictAnchor(item) && !primaryTypes.has(item.entity?.type || item.evidence?.kind) && !preferredTypes.has(item.entity?.type || item.evidence?.kind));
  return [...strictAnchors, ...primary, ...preferred, ...remaining];
}

export function projectedCautionRows(exact, query) {
  if (!primaryEntityTypes(query).has("caution")) return [];
  return exact.filter((item) => item.entity?.type === "section" && CAUTION_SECTION_PATTERN.test(item.entity.canonicalName || ""))
    .slice(0, MAX_TOP_K * 3)
    .map((item) => {
      const section = item.entity;
      const projected = {
        ...section,
        id: `projection:caution:${section.id}`,
        type: "caution",
        confidence: "low",
        verificationStatus: "candidate",
        extractionMethod: "section-caution-semantic-projection",
        properties: {
          type: "section-derived-caution",
          evidenceLines: [section.canonicalName],
          projectedFromEntityId: section.id,
        },
      };
      const evidence = entityEvidence(projected, { reason: "caution language projected from a ranked manual section", query });
      evidence.extractionMethod = "section-caution-semantic-projection";
      return {
        entity: projected,
        evidence,
        retrievalReasons: unique([...item.retrievalReasons, "caution language projected from ranked section evidence"]),
      };
    });
}

export function projectedSequenceRows(exact, query) {
  if (!primaryEntityTypes(query).has("sequence")) return [];
  return exact.filter((item) => item.entity?.type === "section" && !/^\s*(?:figure|table)\b/i.test(item.entity.canonicalName || "") && SEQUENCE_SECTION_PATTERN.test(item.entity.canonicalName || ""))
    .slice(0, MAX_TOP_K * 3)
    .map((item) => {
      const section = item.entity;
      const projected = {
        ...section,
        id: `projection:sequence:${section.id}`,
        type: "sequence",
        confidence: "low",
        verificationStatus: "candidate",
        extractionMethod: "section-sequence-semantic-projection",
        properties: {
          kind: "section-derived-sequence",
          steps: [],
          stepSummaries: [],
          projectedFromEntityId: section.id,
        },
      };
      const evidence = entityEvidence(projected, { reason: "operation or procedure language projected from a ranked manual section", query });
      evidence.extractionMethod = "section-sequence-semantic-projection";
      return {
        entity: projected,
        evidence,
        retrievalReasons: unique([...item.retrievalReasons, "operation or procedure language projected from ranked section evidence"]),
      };
    });
}

function cursorToken(inputIdentity = "") {
  return Buffer.from(String(inputIdentity), "utf8").toString("base64url");
}

function cursorOffset(cursor, inputIdentity = "") {
  if (cursor === null || cursor === undefined || cursor === "") return 0;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8")); }
  catch { throw new Error("Invalid pagination cursor."); }
  if (!Number.isInteger(parsed.offset) || parsed.offset < 0 || parsed.token !== cursorToken(inputIdentity)) {
    throw new Error("Pagination cursor does not match this request.");
  }
  return parsed.offset;
}

export function paginateEvidenceItems(items, topK, cursor, inputIdentity = "") {
  const offset = cursorOffset(cursor, inputIdentity);
  if (offset > items.length) throw new Error("Pagination cursor is beyond the available result set.");
  const rows = items.slice(offset, offset + topK);
  const next = offset + rows.length < items.length
    ? Buffer.from(JSON.stringify({ offset: offset + rows.length, token: cursorToken(inputIdentity) }), "utf8").toString("base64url")
    : null;
  return { rows, pagination: { total: items.length, returned: rows.length, truncated: next !== null, nextCursor: next } };
}

export async function retrieveManualEvidence(filename, query, options = {}) {
  const graph = await loadEvidenceGraph(filename, { buildIfMissing: options.buildGraphIfMissing !== false });
  const topK = clampTopK(options.topK);
  const exact = exactGraphMatches(graph, query, options);
  const strictSymbols = strictHardwareSymbolTokens(query).filter((symbol) => symbol.includes("_") || /\d/.test(symbol));
  const strictSymbolResolved = exact.some((item) => (item.retrievalReasons || []).some((reason) => reason.includes("symbol")));
  // Channel depth must not depend on the requested page size; otherwise the
  // same query receives a different fused order when topK or cursor changes.
  const exactEntities = exact.slice(0, MAX_TOP_K * 3).map((item) => item.entity);
  const includeOcr = Boolean(options.includeOcr) && /\b(figure|fig|diagram|timing|waveform|image|visual|table)\b/i.test(query);
  let lexicalRows = [];
  let lexicalWarning = "";
  const fusion = shouldUseInProcessLexicalFusion(graph);
  if (strictSymbols.length && !strictSymbolResolved) {
    lexicalWarning = `Qualified hardware symbol ${strictSymbols.join(", ")} did not resolve as an indexed entity or structured reference; partial-token lexical fallback was suppressed.`;
  } else if (fusion.enabled) {
    try {
      const lexical = await hybridSearchPdf(filename, query, { register: options.register || "", intent: options.intent || "auto", topK: MAX_TOP_K, preserveEvidenceGraphCache: true });
      lexicalRows = lexicalEntityRows(graph, (lexical.results || [])
        .filter((item) => includeOcr || (item.sourceType !== "figure_ocr" && item.source_type !== "figure_ocr")), query);
    } catch (error) {
      lexicalWarning = `Lexical retrieval unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    lexicalWarning = `In-process lexical fusion was not loaded because this evidence graph has ${fusion.graphItems} entities plus relationships, above the memory-safe limit of ${fusion.limit}. Exact, graph, and neighborhood channels remain active; use hybrid_search_pdf as a separate request for chunk-level lexical corroboration.`;
  }
  const exactRows = [
    ...projectedCautionRows(exact, query),
    ...projectedSequenceRows(exact, query),
    ...exact.map((item) => ({ entity: item.entity, evidence: entityEvidence(item.entity, { reason: item.retrievalReasons.join("; "), query }), retrievalReasons: item.retrievalReasons })),
  ];
  const neighborhoodRows = graphNeighborhood(graph, exactEntities, query, options).map((item) => ({ entity: item.entity, evidence: entityEvidence(item.entity, { reason: item.retrievalReasons[0], query }), retrievalReasons: item.retrievalReasons }));
  const lexicalEvidence = lexicalRows.map((item) => item.evidence);
  const exactEvidence = exactRows.slice(0, MAX_TOP_K).map((item) => item.evidence).filter(Boolean);
  const pageRows = pageNeighborhood(graph, [...exactEvidence, ...lexicalEvidence], query, options).map((item) => ({ entity: item.entity, evidence: entityEvidence(item.entity, { reason: item.retrievalReasons[0], query }), retrievalReasons: item.retrievalReasons }));
  const fused = prioritizeRequestedEntityTypes(reciprocalRankFuse([
    { name: "exact", results: exactRows },
    { name: "lexical", results: lexicalRows },
    { name: "graph", results: neighborhoodRows },
    { name: "neighborhood", results: pageRows },
  ]), query, options);
  const normalized = fused.map((item, index) => {
    const evidence = item.evidence || entityEvidence(item.entity, { reason: item.retrievalReasons.join("; "), rank: index + 1, query });
    return {
      ...item,
      evidence: {
        ...evidence,
        retrieval: {
          ...(evidence.retrieval || {}),
          sourceChannels: item.sourceChannels,
          ...((item.entity?.id || evidence.entityId || evidence.relatedEntityIds?.[0]) ? { entityId: item.entity?.id || evidence.entityId || evidence.relatedEntityIds[0] } : {}),
          channelRanks: item.channelRanks,
          channelEvidence: item.channelEvidence,
          reasons: item.retrievalReasons,
          rank: index + 1,
          rrfScore: Number(item.score.toFixed(6)),
          query,
        },
      },
    };
  });
  const paged = paginateEvidenceItems(normalized, topK, options.cursor, JSON.stringify({ filename, query, register: options.register || "", includeOcr: Boolean(options.includeOcr) }));
  return {
    graph,
    query,
    topK,
    results: paged.rows,
    pagination: paged.pagination,
    retrievalChannels: fusion.enabled ? ["exact", "lexical", "graph", "neighborhood"] : ["exact", "graph", "neighborhood"],
    warnings: lexicalWarning ? [lexicalWarning] : [],
  };
}

export function evidenceFactFromResult(result) {
  const entity = result.entity;
  if (!entity || !["register", "bitfield", "sequence", "caution", "table", "figure"].includes(entity.type)) return null;
  const verified = entity.verificationStatus === "verified" || entity.verificationStatus === "high-confidence";
  if (!verified) return null;
  return {
    id: entity.id,
    kind: entity.type,
    canonicalName: entity.canonicalName,
    aliases: entity.aliases,
    properties: entity.properties,
    confidence: entity.confidence,
    verificationStatus: entity.verificationStatus,
    evidenceIds: [result.evidence.id],
  };
}

function safeTaskSymbols(task, graph) {
  const knownSymbols = new Set((graph.entities || [])
    .filter((entity) => ["register", "bitfield", "sequence", "caution", "figure"].includes(entity.type))
    .flatMap((entity) => [entity.canonicalName, ...(entity.aliases || []), ...(entity.aliasVariants || [])])
    .flatMap(symbolTokens));
  return unique((String(task || "").match(/\b[A-Za-z][A-Za-z0-9_]{2,}\b/g) || [])
    .map(canonicalSymbol)
    .filter((symbol) => symbol.length >= 3 && !GENERIC_QUERY_TERMS.has(symbol.toLowerCase()) && knownSymbols.has(symbol)));
}

export function taskQuestions(task, moduleType, evidenceTypes, graph) {
  const requested = new Set((evidenceTypes || []).map((type) => String(type).toLowerCase()));
  const text = String(task || "").trim();
  const questions = [{ category: "general", query: text }];
  const symbols = safeTaskSymbols(text, graph);
  for (const symbol of symbols.slice(0, 8)) questions.push({ category: "symbol", query: symbol, register: symbol });
  if (requested.has("register")) questions.push({ category: "register", query: `${text} register locator offset reset access` });
  if (requested.has("bitfield")) questions.push({ category: "bitfield", query: `${text} bit field access reset description` });
  if (requested.has("table")) questions.push({ category: "table", query: `${text} register table layout` });
  if (requested.has("sequence") || /\b(init|start|stop|reset|clear|interrupt|irq|enable|disable)\b/i.test(text)) questions.push({ category: "sequence", query: `${text} sequence procedure` });
  if (requested.has("caution") || /\b(caution|restriction|reserved|must not|prohibited|clear)\b/i.test(text)) questions.push({ category: "caution", query: `${text} caution restriction` });
  if (requested.has("figure") || /\b(figure|table|diagram|timing|waveform|visual)\b/i.test(text)) questions.push({ category: "figure", query: `${text} figure table diagram`, includeOcr: true });
  if (moduleType) questions.push({ category: "module", query: `${moduleType} ${text}` });
  return unique(questions.map((question) => JSON.stringify(question))).map((question) => JSON.parse(question));
}

function dedupeEvidence(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.kind}:${item.page || ""}:${item.chunkId || ""}:${item.relatedEntityIds?.join(",") || item.statement}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mergeFacts(items) {
  const byId = new Map();
  for (const fact of items.filter(Boolean)) {
    const existing = byId.get(fact.id);
    if (!existing) {
      byId.set(fact.id, { ...fact, evidenceIds: unique(fact.evidenceIds || []) });
      continue;
    }
    existing.evidenceIds = unique([...(existing.evidenceIds || []), ...(fact.evidenceIds || [])]);
  }
  return [...byId.values()];
}

export function factsForEvidencePage(facts, evidence) {
  const returnedEvidenceIds = new Set((evidence || []).map((item) => item.id));
  return mergeFacts(facts).map((fact) => ({ ...fact, evidenceIds: (fact.evidenceIds || []).filter((id) => returnedEvidenceIds.has(id)) })).filter((fact) => fact.evidenceIds.length);
}

function queryContextEntityIds(evidence) {
  return unique((evidence || []).flatMap((item) => [
    item.entityId,
    ...(item.relatedEntityIds || []),
    item.retrieval?.entityId,
  ]));
}

function contextRelationshipSort(left, right) {
  return String(left.type || "").localeCompare(String(right.type || "")) || contextRelationshipKey(left).localeCompare(contextRelationshipKey(right));
}

function contextRelationshipKey(relationship) {
  return String(relationship.id || `${relationship.type || ""}:${relationship.from || ""}:${relationship.to || ""}`);
}

function boundedContextLimit(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
}

// query_manual returns enough of the graph to explain ranked evidence without
// exposing a document-wide graph dump. Sequence context is atomic: either all
// of a returned sequence's steps fit or none are added, so a truncated result
// can never look like a complete ordered procedure.
export function buildBoundedQueryGraphContext(graph, evidence, {
  maxEntities = MAX_QUERY_CONTEXT_ENTITIES,
  maxRelationships = MAX_QUERY_CONTEXT_RELATIONSHIPS,
} = {}) {
  const { entitiesById, relationshipsByEntityId } = getEvidenceGraphRuntimeIndex(graph);
  const isIncludedEntity = (entity) => entity && !["document", "page"].includes(entity.type);
  const isEligibleRelationship = (relationship) => QUERY_CONTEXT_RELATIONSHIP_TYPES.has(relationship.type)
    && isIncludedEntity(entitiesById.get(relationship.from))
    && isIncludedEntity(entitiesById.get(relationship.to));
  const seedIds = queryContextEntityIds(evidence).filter((id) => isIncludedEntity(entitiesById.get(id)));
  const entityLimit = boundedContextLimit(maxEntities, MAX_QUERY_CONTEXT_ENTITIES);
  const relationshipLimit = boundedContextLimit(maxRelationships, MAX_QUERY_CONTEXT_RELATIONSHIPS);
  // Evidence order is retrieval-rank order, so it is also the deterministic
  // preference order when the rank seeds alone exceed the context budget.
  const retainedSeedIds = seedIds.slice(0, entityLimit);
  const selectedEntityIds = new Set(retainedSeedIds);
  const selectedEntities = retainedSeedIds.map((id) => entitiesById.get(id));
  const selectedRelationshipIds = new Set();
  const selectedRelationships = [];
  const skippedSequenceIds = [];
  const skippedRelationshipIds = new Set();
  let optionalContextTruncated = false;

  const includeGroup = (relationships) => {
    const rows = [];
    const seen = new Set();
    for (const relationship of relationships) {
      const key = contextRelationshipKey(relationship);
      if (seen.has(key) || selectedRelationshipIds.has(key)) continue;
      if (!isEligibleRelationship(relationship)) continue;
      seen.add(key);
      rows.push(relationship);
    }
    if (!rows.length) return true;
    const newEntityIds = unique(rows.flatMap((relationship) => [relationship.from, relationship.to]))
      .filter((id) => !selectedEntityIds.has(id));
    if (selectedEntities.length + newEntityIds.length > entityLimit || selectedRelationships.length + rows.length > relationshipLimit) {
      for (const relationship of rows) skippedRelationshipIds.add(contextRelationshipKey(relationship));
      return false;
    }
    for (const id of newEntityIds) {
      selectedEntityIds.add(id);
      selectedEntities.push(entitiesById.get(id));
    }
    for (const relationship of rows) {
      selectedRelationshipIds.add(contextRelationshipKey(relationship));
      selectedRelationships.push(relationship);
    }
    return true;
  };

  // A retrieved step must carry the same complete ordered context as a
  // retrieved sequence. Resolve parents before expansion instead of relying
  // on the ranked entity type alone.
  const sequenceIds = [];
  const addSequenceId = (sequenceId) => {
    if (sequenceId && !sequenceIds.includes(sequenceId)) sequenceIds.push(sequenceId);
  };
  for (const seedId of retainedSeedIds) {
    const entity = entitiesById.get(seedId);
    if (entity?.type === "sequence") addSequenceId(seedId);
    if (entity?.type === "sequence-step") {
      for (const relationship of relationshipsByEntityId.get(seedId) || []) {
        if (relationship.type !== "sequence-has-step" || !isEligibleRelationship(relationship)) continue;
        const otherId = relationship.from === seedId ? relationship.to : relationship.from;
        if (entitiesById.get(otherId)?.type === "sequence") addSequenceId(otherId);
      }
    }
  }

  const sequenceMembersById = new Map();
  const expandedSequenceIds = new Set();
  const skippedSequenceMemberIds = new Set();
  for (const sequenceId of sequenceIds) {
    const stepRelationships = (relationshipsByEntityId.get(sequenceId) || [])
      .filter((relationship) => relationship.type === "sequence-has-step" && isEligibleRelationship(relationship));
    const stepIds = new Set(stepRelationships.map((relationship) => relationship.from === sequenceId ? relationship.to : relationship.from));
    const orderingById = new Map();
    for (const stepId of stepIds) {
      for (const relationship of relationshipsByEntityId.get(stepId) || []) {
        if (relationship.type === "sequence-step-occurs-before" && stepIds.has(relationship.from) && stepIds.has(relationship.to)) {
          orderingById.set(contextRelationshipKey(relationship), relationship);
        }
      }
    }
    const orderingRelationships = [...orderingById.values()];
    const coreRelationships = [...stepRelationships, ...orderingRelationships].sort(contextRelationshipSort);
    sequenceMembersById.set(sequenceId, new Set([sequenceId, ...stepIds]));
    if (includeGroup(coreRelationships)) {
      // A step seed can need the parent sequence entity even if an incomplete
      // graph has no sequence-has-step rows. There is no partial core in that
      // case: the graph declares no children to include.
      if (!selectedEntityIds.has(sequenceId)) {
        if (selectedEntities.length < entityLimit) {
          selectedEntityIds.add(sequenceId);
          selectedEntities.push(entitiesById.get(sequenceId));
        } else {
          skippedSequenceIds.push(sequenceId);
          for (const memberId of sequenceMembersById.get(sequenceId)) skippedSequenceMemberIds.add(memberId);
          continue;
        }
      }
      expandedSequenceIds.add(sequenceId);
    } else {
      skippedSequenceIds.push(sequenceId);
      for (const memberId of sequenceMembersById.get(sequenceId)) skippedSequenceMemberIds.add(memberId);
    }
  }

  // Add optional sequence context only after the complete core fits. The
  // structural sequence relationships are never reintroduced one-at-a-time.
  for (const sequenceId of sequenceIds) {
    if (!expandedSequenceIds.has(sequenceId)) continue;
    const optionalById = new Map();
    for (const memberId of sequenceMembersById.get(sequenceId) || []) {
      for (const relationship of relationshipsByEntityId.get(memberId) || []) {
        if (!isEligibleRelationship(relationship)) continue;
        if (selectedRelationshipIds.has(contextRelationshipKey(relationship))) continue;
        if (["sequence-has-step", "sequence-step-occurs-before"].includes(relationship.type)) continue;
        optionalById.set(contextRelationshipKey(relationship), relationship);
      }
    }
    for (const relationship of [...optionalById.values()].sort(contextRelationshipSort)) {
      if (!includeGroup([relationship])) optionalContextTruncated = true;
    }
  }

  // Direct one-hop context is intentionally last so it cannot crowd out a
  // mandatory sequence core. Do not add anything incident to a sequence that
  // was skipped: that would make the omitted sequence look partially present.
  const directById = new Map();
  for (const seedId of retainedSeedIds) {
    for (const relationship of relationshipsByEntityId.get(seedId) || []) {
      if (!isEligibleRelationship(relationship)) continue;
      if (["sequence-has-step", "sequence-step-occurs-before"].includes(relationship.type)) continue;
      if (skippedSequenceMemberIds.has(relationship.from) || skippedSequenceMemberIds.has(relationship.to)) continue;
      directById.set(contextRelationshipKey(relationship), relationship);
    }
  }
  for (const relationship of [...directById.values()].sort(contextRelationshipSort)) {
    if (!includeGroup([relationship])) optionalContextTruncated = true;
  }

  return {
    entities: selectedEntities,
    relationships: selectedRelationships.sort(contextRelationshipSort),
    truncated: skippedRelationshipIds.size > 0 || seedIds.length > retainedSeedIds.length || skippedSequenceIds.length > 0,
    skippedSeedEntityCount: seedIds.length - retainedSeedIds.length,
    skippedRelationshipCount: skippedRelationshipIds.size,
    skippedSequenceIds: unique(skippedSequenceIds),
    optionalContextTruncated,
    maxEntities: entityLimit,
    maxRelationships: relationshipLimit,
  };
}

export async function collectManualEvidenceBundle({ filename, task, moduleType = "", depth = "standard", evidenceTypes = [], topK = DEFAULT_TOP_K, cursor = null } = {}) {
  if (!String(task || "").trim()) throw new Error("task is required");
  const requestedTypes = new Set((evidenceTypes || []).map((type) => String(type).toLowerCase()));
  const requestedTopK = clampTopK(topK);
  const perQuestion = depth === "deep" ? Math.min(20, requestedTopK) : Math.min(12, requestedTopK);
  const graph = await loadEvidenceGraph(filename, { buildIfMissing: true });
  const questions = taskQuestions(task, moduleType, evidenceTypes, graph);
  const collections = [];
  for (const question of questions) {
    collections.push(await retrieveManualEvidence(filename, question.query, {
      topK: perQuestion,
      register: question.register || "",
      moduleContext: moduleType,
      includeOcr: Boolean(question.includeOcr),
      buildGraphIfMissing: true,
    }));
  }
  const evidence = dedupeEvidence(collections.flatMap((collection) => collection.results.map((result) => result.evidence)));
  const facts = mergeFacts(collections.flatMap((collection) => collection.results.map(evidenceFactFromResult)));
  const relatedEntities = new Set(evidence.flatMap((item) => item.relatedEntityIds || []));
  const conflicts = (graph.conflicts || []).filter((conflict) => relatedEntities.has(conflict.entityId));
  const candidateOnly = evidence.filter((item) => !["verified", "high-confidence"].includes(item.verificationStatus));
  const visualCandidates = evidence.filter((item) => item.kind === "figure" || item.kind === "figure-ocr-locator");
  const gaps = [];
  if (!evidence.length) gaps.push({ item: task, reason: "No evidence candidates were retrieved.", recommendedAction: "Check index health, use a shorter symbol/phrase, or rebuild artifacts." });
  const typeKinds = {
    register: new Set(["register"]),
    bitfield: new Set(["bitfield"]),
    sequence: new Set(["sequence", "sequence-step"]),
    caution: new Set(["caution"]),
    table: new Set(["table"]),
    figure: new Set(["figure", "figure-ocr-locator"]),
  };
  for (const requestedType of requestedTypes) {
    const kinds = typeKinds[requestedType];
    if (kinds && !evidence.some((item) => kinds.has(item.kind))) gaps.push({ item: `${requestedType} evidence`, reason: `No ${requestedType} entity or locator was retrieved.`, recommendedAction: `Use query_manual with an exact ${requestedType} name or rebuild the relevant artifacts.` });
  }
  if ((evidenceTypes || []).some((type) => String(type).toLowerCase() === "figure") && !visualCandidates.length) gaps.push({ item: "visual evidence", reason: "No figure locator was retrieved.", recommendedAction: "Run search_figures with a figure/table caption phrase; do not infer figure semantics from text." });
  if (!facts.length && evidence.length) gaps.push({ item: "verified facts", reason: "Retrieved evidence is candidate-level and has not been manually verified.", recommendedAction: "Read cited pages/tables; open canonical figure PNGs for visual claims." });
  const paged = paginateEvidenceItems(evidence, requestedTopK, cursor, JSON.stringify({ filename, task, moduleType, depth, evidenceTypes }));
  const returnedFacts = factsForEvidencePage(facts, paged.rows);
  return createEvidenceBundleV2({
    serverVersion: SERVER_VERSION,
    tool: "collect_manual_evidence",
    filename,
    sourceFingerprint: graph.sourceFingerprint,
    input: { filename, task, module_type: moduleType, depth, evidence_types: evidenceTypes, top_k: requestedTopK, cursor },
    summary: {
      task,
      questions: questions.map((question) => ({ category: question.category, query: question.query })),
      graphEntities: graph.entities.length,
      resultCountBeforePagination: evidence.length,
      candidateEvidenceCount: candidateOnly.length,
      visualCandidateCount: visualCandidates.length,
    },
    facts: returnedFacts,
    evidence: paged.rows,
    inferences: [{ statement: `Task decomposition produced ${questions.length} evidence questions.`, basis: "task text and requested evidence types", confidence: "medium", risk: "Task decomposition guides retrieval only; it is not a manual fact." }],
    conflicts,
    gaps,
    needsVerification: [
      ...(candidateOnly.length ? [{ item: "Candidate manual evidence", reason: "Search and extraction candidates require page/table review before driver-critical conclusions.", recommendedActions: ["read_manual_evidence", "read_pdf_pages", "extract_bitfield_table"] }] : []),
      ...(visualCandidates.length ? [{ item: "Figure semantics", reason: "Figure/OCR matches are locators only. Open the canonical PNG before making visual-semantic claims.", recommendedActions: ["get_figure_context_pack", "get_figure_image transport=metadata", "open canonical image"] }] : []),
    ],
    warnings: unique([
      ...collections.flatMap((collection) => collection.warnings || []),
      visualCandidates.length ? "OCR-derived entries are supplemental locator metadata, not visual-semantic truth." : "",
      "The MCP server does not inspect Linux source code; source-code checks are recommendations only.",
    ]),
    recommendedNextActions: unique([
      ...conflicts.flatMap((conflict) => conflictVerificationActions(conflict, filename)),
      ...candidateOnly.slice(0, 5).map((item) => item.chunkId ? { tool: "read_pdf_chunk", arguments: { filename, chunk_id: item.chunkId }, reason: "Read candidate evidence in context." } : { tool: "read_pdf_pages", arguments: { filename, start_page: item.page, end_page: item.page }, reason: "Verify page-level candidate evidence." }),
      ...paged.rows.filter((item) => item.kind === "figure" || item.kind === "figure-ocr-locator").filter((item) => item.figureId).slice(0, 3).map((item) => ({ tool: "get_figure_context_pack", arguments: { filename, figure_id: item.figureId }, reason: "Locate canonical image before visual verification." })),
    ]),
    pagination: paged.pagination,
  });
}

export async function queryManualEvidenceBundle({ filename, query, topK, cursor, register = "", includeOcr = false } = {}) {
  if (!String(query || "").trim()) throw new Error("query is required");
  const retrieval = await retrieveManualEvidence(filename, query, { topK, cursor, register, includeOcr, buildGraphIfMissing: true });
  const evidence = retrieval.results.map((result) => result.evidence);
  const { entitiesById } = getEvidenceGraphRuntimeIndex(retrieval.graph);
  const transientEntities = unique(retrieval.results
    .map((result) => result.entity)
    .filter((entity) => entity?.id && !entitiesById.has(entity.id))
    .map((entity) => JSON.stringify(entity))).map((entity) => JSON.parse(entity));
  const graphContext = buildBoundedQueryGraphContext(retrieval.graph, evidence, {
    maxEntities: Math.max(0, MAX_QUERY_CONTEXT_ENTITIES - transientEntities.length),
  });
  graphContext.entities = [...transientEntities, ...graphContext.entities];
  graphContext.maxEntities = MAX_QUERY_CONTEXT_ENTITIES;
  const projectedCautions = transientEntities.filter((entity) => entity.type === "caution" && entity.properties?.projectedFromEntityId);
  const exactRegisterAnchors = retrieval.results.filter((result) => result.entity?.type === "register"
    && (result.retrievalReasons || []).some((reason) => reason.startsWith("exact symbol ") || reason.startsWith("qualified symbol "))).map((result) => result.entity);
  for (const caution of projectedCautions) {
    const cautionText = entityText(caution);
    const registerEntity = exactRegisterAnchors.find((candidate) => unique([candidate.canonicalName, ...(candidate.aliases || [])])
      .some((alias) => normalizeForSearch(alias).split(/\s+/).filter((part) => part.length >= 4).some((part) => cautionText.includes(part))))
      || (exactRegisterAnchors.length === 1 ? exactRegisterAnchors[0] : null);
    if (!registerEntity || graphContext.relationships.length >= MAX_QUERY_CONTEXT_RELATIONSHIPS) continue;
    graphContext.relationships.push({
      id: `query-context-register-has-caution:${registerEntity.id}->${caution.id}`,
      from: registerEntity.id,
      to: caution.id,
      type: "register-has-caution",
      properties: { resolutionStatus: "query-context-section-projection", verificationStatus: "candidate" },
    });
  }
  const graphContextWarning = graphContext.truncated
    ? `Bounded graph context was truncated at ${graphContext.maxEntities} entities and ${graphContext.maxRelationships} relationships${graphContext.optionalContextTruncated ? "; optional graph context was omitted after required context was retained" : ""}; use get_manual_entity for additional related evidence.`
    : "";
  const graphContextGap = graphContext.truncated
    ? [{
      item: "bounded graph context",
      reason: graphContext.skippedSequenceIds.length
        ? "One or more returned sequences could not include every ordered step within the graph-context limit."
        : graphContext.optionalContextTruncated
          ? "Optional one-hop graph context could not fit after required context was retained."
        : "Some direct graph relationships could not fit within the graph-context limit.",
      recommendedAction: "Use get_manual_entity with a returned canonical entity ID to retrieve the remaining one-hop relationships.",
    }]
    : [];
  return createEvidenceBundleV2({
    serverVersion: SERVER_VERSION,
    tool: "query_manual",
    filename,
    sourceFingerprint: retrieval.graph.sourceFingerprint,
    input: { filename, query, top_k: clampTopK(topK), cursor, register, include_ocr: Boolean(includeOcr) },
    summary: {
      retrievalChannels: retrieval.retrievalChannels,
      graphEntities: retrieval.graph.entities.length,
      resultCountBeforePagination: retrieval.pagination.total,
      graphContext: {
        entities: graphContext.entities.length,
        relationships: graphContext.relationships.length,
        truncated: graphContext.truncated,
      },
    },
    entities: graphContext.entities,
    relationships: graphContext.relationships,
    facts: mergeFacts(retrieval.results.map(evidenceFactFromResult)),
    evidence,
    inferences: [],
    conflicts: unique(retrieval.results.flatMap((result) => result.entity ? (retrieval.graph.conflicts || []).filter((conflict) => conflict.entityId === result.entity.id) : []).map((conflict) => JSON.stringify(conflict))).map((conflict) => JSON.parse(conflict)),
    gaps: [
      ...(evidence.length ? [] : [{ item: query, reason: "No result matched the enabled retrieval channels.", recommendedAction: "Try an exact register name or inspect manual_status/index health." }]),
      ...graphContextGap,
    ],
    needsVerification: evidence.length ? [{ item: "Ranked evidence", reason: "Retrieval rank is not verification.", recommendedActions: ["read_manual_evidence", "read_pdf_pages"] }] : [],
    warnings: unique([...retrieval.warnings, graphContextWarning]),
    recommendedNextActions: [
      ...evidence.slice(0, 5).map((item) => item.chunkId ? { tool: "read_manual_evidence", arguments: { filename, entity_id: item.relatedEntityIds?.[0] || "", chunk_id: item.chunkId }, reason: "Read provenance and adjacent evidence." } : { tool: "read_pdf_pages", arguments: { filename, start_page: item.page, end_page: item.page }, reason: "Inspect the cited page." }),
      ...graphContext.skippedSequenceIds.slice(0, 3).map((entityId) => ({ tool: "get_manual_entity", arguments: { filename, entity_id: entityId }, reason: "Retrieve the complete ordered sequence context that did not fit in query_manual." })),
    ],
    pagination: retrieval.pagination,
  });
}

export async function getManualEntityBundle({ filename, entityId, relatedEntityTypes = [], relationshipTypes = [], topK = 20, cursor = null, includePageEntities = false } = {}) {
  const graph = await loadEvidenceGraph(filename, { buildIfMissing: true });
  const result = getEvidenceGraphEntity(graph, entityId);
  if (!result) throw new Error(`Manual entity not found: ${entityId}`);
  if (result.ambiguity) throw new Error(`Manual entity alias is ambiguous: ${entityId}. Use one of: ${result.ambiguity.candidateEntityIds.join(", ")}`);
  const entityTypes = new Set((relatedEntityTypes || []).map((type) => String(type).toLowerCase()));
  const relationTypes = new Set((relationshipTypes || []).map((type) => String(type).toLowerCase()));
  const allowedRelatedIds = new Set(result.relatedEntities.filter((entity) => (includePageEntities || entity.type !== "page") && (!entityTypes.size || entityTypes.has(String(entity.type).toLowerCase()))).map((entity) => entity.id));
  const relationships = result.relationships
    .filter((relation) => !relationTypes.size || relationTypes.has(String(relation.type).toLowerCase()))
    .filter((relation) => allowedRelatedIds.has(relation.from === result.entity.id ? relation.to : relation.from))
    .sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
  const relationshipPage = paginateEvidenceItems(relationships, Math.max(1, Math.min(100, Number(topK) || 20)), cursor, JSON.stringify({ filename, entityId: result.entity.id, relatedEntityTypes: [...entityTypes].sort(), relationshipTypes: [...relationTypes].sort(), includePageEntities: Boolean(includePageEntities) }));
  const selectedIds = new Set(relationshipPage.rows.map((relation) => relation.from === result.entity.id ? relation.to : relation.from));
  const relatedEntities = result.relatedEntities.filter((entity) => selectedIds.has(entity.id));
  const evidence = [entityEvidence(result.entity, { reason: "direct entity lookup" })];
  return createEvidenceBundleV2({
    serverVersion: SERVER_VERSION,
    tool: "get_manual_entity",
    filename,
    sourceFingerprint: graph.sourceFingerprint,
    input: { filename, entity_id: entityId, related_entity_types: relatedEntityTypes, relationship_types: relationshipTypes, top_k: topK, cursor, include_page_entities: Boolean(includePageEntities) },
    summary: { entityType: result.entity.type, relatedEntityCount: result.relatedEntities.length, relationshipCount: result.relationships.length, relationshipPagination: relationshipPage.pagination },
    entities: [result.entity, ...relatedEntities],
    relationships: relationshipPage.rows,
    facts: [evidenceFactFromResult({ entity: result.entity, evidence: evidence[0] })].filter(Boolean),
    evidence,
    inferences: [],
    conflicts: result.conflicts,
    gaps: [],
    needsVerification: result.entity.verificationStatus === "verified" ? [] : [{ item: result.entity.canonicalName, reason: `Entity status is ${result.entity.verificationStatus}.`, recommendedActions: ["read_manual_evidence"] }],
    warnings: result.entity.type === "figure" ? ["Figure semantic claims require opening the canonical PNG; graph caption metadata is not visual truth."] : [],
    recommendedNextActions: relatedEntities.slice(0, 12).map((entity) => ({ tool: "get_manual_entity", arguments: { filename, entity_id: entity.id }, reason: "Follow an evidence-graph relationship." })),
    pagination: { total: 1, returned: 1, truncated: false, nextCursor: null },
  });
}

export async function readManualEvidenceBundle({ filename, entityId = "", chunkId = "", page = null } = {}) {
  entityId = typeof entityId === "string" ? entityId.trim() : "";
  chunkId = typeof chunkId === "string" ? chunkId.trim() : "";
  const requestedPage = page === null || page === undefined ? null : Number(page);
  if (requestedPage !== null && (!Number.isInteger(requestedPage) || requestedPage < 1)) throw new Error("page must be a one-based integer");
  if (!entityId && !chunkId && requestedPage === null) throw new Error("At least one of entity_id, chunk_id, or page is required");
  const graph = await loadEvidenceGraph(filename, { buildIfMissing: true });
  let entities = graph.entities || [];
  if (entityId) {
    const result = getEvidenceGraphEntity(graph, entityId);
    if (!result) throw new Error(`Manual entity not found: ${entityId}`);
    if (result.ambiguity) throw new Error(`Manual entity alias is ambiguous: ${entityId}. Use one of: ${result.ambiguity.candidateEntityIds.join(", ")}`);
    entities = [result.entity, ...result.relatedEntities];
  }
  const evidence = dedupeEvidence(entities.flatMap((entity) => {
    const locations = matchingLocations(entity, { requestedPage, requestedChunkId: chunkId });
    if ((requestedPage !== null || chunkId) && !locations.length) return [];
    if (!locations.length) return [entityEvidence(entity, { reason: "provenance read" })].filter(Boolean);
    return locations.map((location) => entityEvidence(entity, { reason: "provenance read", requestedPage, requestedChunkId: chunkId, selectedLocation: location })).filter(Boolean);
  }));
  return createEvidenceBundleV2({
    serverVersion: SERVER_VERSION,
    tool: "read_manual_evidence",
    filename,
    sourceFingerprint: graph.sourceFingerprint,
    input: { filename, entity_id: entityId || null, chunk_id: chunkId || null, page: page ?? null },
    summary: { matchingEntityCount: entities.length, graphEntityCount: graph.entities.length },
    facts: mergeFacts(entities.flatMap((entity) => evidence.filter((item) => item.relatedEntityIds?.includes(entity.id)).map((item) => evidenceFactFromResult({ entity, evidence: item })))),
    evidence,
    inferences: [],
    conflicts: unique(entities.flatMap((entity) => (graph.conflicts || []).filter((conflict) => conflict.entityId === entity.id)).map((conflict) => JSON.stringify(conflict))).map((conflict) => JSON.parse(conflict)),
    gaps: evidence.length ? [] : [{ item: entityId || chunkId || `page ${page}`, reason: "No graph provenance matched this selector.", recommendedAction: "Use query_manual to discover stable entity and chunk IDs." }],
    needsVerification: evidence.filter((item) => item.verificationStatus !== "verified").map((item) => ({ item: item.statement, reason: `Evidence status is ${item.verificationStatus}.`, recommendedActions: [item.page ? `read_pdf_pages page ${item.page}` : "query_manual"] })),
    warnings: [],
    recommendedNextActions: entities.filter((entity) => entity.type === "figure").map((entity) => ({ tool: "get_figure_context_pack", arguments: { filename, figure_id: entity.properties?.figureId || entity.id }, reason: "Open canonical PNG before visual reasoning." })),
    pagination: { total: evidence.length, returned: evidence.length, truncated: false, nextCursor: null },
  });
}

export function formatEvidenceBundle(bundle) {
  const lines = [
    `EvidenceBundle v${bundle.schemaVersion}: ${bundle.tool}`,
    `File: ${bundle.filename}`,
    `Source fingerprint: ${bundle.sourceFingerprint}`,
    `Evidence: ${bundle.pagination.returned}/${bundle.pagination.total}${bundle.pagination.truncated ? " (more available)" : ""}`,
  ];
  if (Object.keys(bundle.summary || {}).length) lines.push(`Summary: ${JSON.stringify(bundle.summary)}`);
  if (bundle.facts.length) {
    lines.push("", "Facts:");
    for (const fact of bundle.facts.slice(0, 8)) lines.push(`- ${fact.kind}: ${fact.canonicalName} [${fact.verificationStatus}/${fact.confidence}]`);
  }
  if (bundle.evidence.length) {
    lines.push("", "Evidence:");
    for (const item of bundle.evidence) lines.push(`- p${item.page || "?"} ${item.kind}: ${item.statement.slice(0, 240)} [${item.verificationStatus}; ${item.retrieval?.sourceChannels?.join("+") || "direct"}]`);
  } else lines.push("", "No evidence found.");
  if (bundle.conflicts.length) lines.push("", `Conflicts: ${bundle.conflicts.length}; inspect recommended verification pages.`);
  if (bundle.gaps.length) lines.push("", `Gaps: ${bundle.gaps.map((gap) => gap.item).join(", ")}`);
  if (bundle.warnings.length) lines.push("", ...bundle.warnings.map((warning) => `Warning: ${warning}`));
  if (bundle.pagination.nextCursor) lines.push(`Next cursor: ${bundle.pagination.nextCursor}`);
  return lines.join("\n");
}
