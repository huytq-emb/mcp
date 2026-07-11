import { canonicalSymbol, normalizeForSearch } from "../core/runtime-helpers.js";
import { getEvidenceGraphEntity, loadEvidenceGraph } from "../services/evidence-graph.js";
import { hybridSearchPdf } from "../services/search.js";
import { SERVER_VERSION } from "../core/runtime-constants.js";
import { createEvidenceBundleV2 } from "../evidence/contract.js";

const RRF_K = 60;
const RRF_CHANNEL_WEIGHTS = Object.freeze({ exact: 3, lexical: 1, graph: 2, neighborhood: 0.75, ocr: 0.5 });
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 40;
const GENERIC_QUERY_TERMS = new Set(["a", "access", "address", "an", "and", "apply", "are", "be", "bit", "bits", "by", "clear", "description", "details", "does", "driver", "each", "field", "find", "for", "from", "how", "in", "initial", "is", "it", "linux", "locate", "manual", "must", "of", "on", "or", "offset", "page", "register", "reset", "size", "status", "that", "the", "their", "them", "these", "they", "this", "those", "to", "used", "value", "we", "what", "when", "where", "which", "with", "you", "your"]);

function clampTopK(value) {
  const numeric = Number(value ?? DEFAULT_TOP_K);
  if (!Number.isFinite(numeric)) return DEFAULT_TOP_K;
  return Math.max(1, Math.min(MAX_TOP_K, Math.floor(numeric)));
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function confidenceRank(value) {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function normalizedTokens(value) {
  return unique(normalizeForSearch(value).split(/\s+/).filter((token) => token.length >= 2));
}

function symbolTokens(value) {
  return unique(String(value || "").split(/[\s,;:/()[\]{}]+/).map(canonicalSymbol).filter((token) => token.length >= 2));
}

function hardwareSymbolTokens(value) {
  return unique((String(value || "").match(/[A-Za-z][A-Za-z0-9_]*/g) || [])
    .filter((token) => token.length >= 2 && (token.includes("_") || /\d/.test(token) || (token.length >= 3 && token === token.toUpperCase())))
    .map(canonicalSymbol)
    .filter(Boolean));
}

function entityText(entity) {
  const properties = entity.properties || {};
  const curatedProperties = entity.type === "register"
    ? [properties.descriptions, properties.offsets, properties.resetValues, properties.accessSizes]
    : entity.type === "bitfield"
      ? [properties.register, properties.bitRange, properties.access, properties.reset]
      : entity.type === "sequence-step"
        ? [properties.register, properties.bitfield, properties.value, properties.condition]
        : entity.type === "caution"
          ? [properties.type, properties.riskForDriver]
          : [properties.kind, properties.number];
  return normalizeForSearch([
    entity.canonicalName,
    entity.displayName,
    ...(entity.aliases || []),
    entity.type,
    ...curatedProperties.flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean),
  ].join(" "));
}

function preferredEntityTypes(query) {
  const text = normalizeForSearch(query);
  const types = new Set();
  if (/\b(register|offset|reset|access|control)\b/.test(text)) types.add("register");
  if (/\b(bit|field|bitfield)\b/.test(text)) types.add("bitfield");
  if (/\b(sequence|procedure|order|initialize|initialization|start|stop|refresh|enable|disable)\b/.test(text)) { types.add("sequence"); types.add("sequence-step"); }
  if (/\b(caution|restriction|prohibited|reserved|must not|avoid)\b/.test(text)) types.add("caution");
  if (/\b(table)\b/.test(text)) types.add("table");
  if (/\b(figure|diagram|waveform|visual)\b/.test(text)) types.add("figure");
  if (!types.size && /\b(where|locate|chapter|described)\b/.test(text)) types.add("section");
  return types;
}

export function symbolVariantMatches(alias, symbol, entityType) {
  if (!alias || !symbol || symbol.length < 3) return false;
  const parts = alias.split("_").filter((part) => part.length >= 3);
  if (parts.includes(symbol)) return true;
  const symbolParts = symbol.split("_").filter((part) => part.length >= 3);
  if (symbolParts.length > 1 && symbolParts.every((part) => parts.includes(part))) return true;
  return ["section", "sequence", "sequence-step", "caution", "table", "figure"].includes(entityType) && alias.includes(symbol);
}

function entityQueryRelevance(entity, query) {
  const aliases = unique([entity.canonicalName, entity.displayName, ...(entity.aliases || [])]).map(canonicalSymbol).filter(Boolean);
  const symbols = hardwareSymbolTokens(query);
  const terms = normalizedTokens(query).filter((term) => !GENERIC_QUERY_TERMS.has(term));
  const text = entityText(entity);
  let score = 0;
  let exactSymbolMatched = false;
  for (const symbol of symbols) {
    if (aliases.includes(symbol)) { score += 120; exactSymbolMatched = true; }
    else if (aliases.some((alias) => symbolVariantMatches(alias, symbol, entity.type))) score += 60;
  }
  for (const term of terms) if (text.includes(term)) score += term.length > 4 ? 12 : 5;
  const preferredTypes = preferredEntityTypes(query);
  const locatorOnly = preferredTypes.size === 1 && preferredTypes.has("section");
  if (locatorOnly && entity.type !== "section") return 0;
  if (preferredTypes.size && !preferredTypes.has(entity.type) && !exactSymbolMatched) return 0;
  if (score > 0 && preferredTypes.has(entity.type)) score += 60;
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
    return Number(right.sourceScore || 0) - Number(left.sourceScore || 0) || score(right) - score(left) || Number(left.page || Number.MAX_SAFE_INTEGER) - Number(right.page || Number.MAX_SAFE_INTEGER);
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
  const byId = new Map((graph.entities || []).map((entity) => [entity.id, entity]));
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
      const existing = byKey.get(key) || { ...item, score: 0, sourceChannels: [], channelRanks: {}, retrievalReasons: [] };
      if (!existing.channelRanks[channel.name]) {
        existing.score += (RRF_CHANNEL_WEIGHTS[channel.name] || 1) / (RRF_K + index + 1);
        existing.channelRanks[channel.name] = index + 1;
      }
      existing.sourceChannels = unique([...existing.sourceChannels, channel.name]);
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

function exactGraphMatches(graph, query, options = {}) {
  const symbols = hardwareSymbolTokens(query);
  const terms = normalizedTokens(query);
  const contextSymbols = hardwareSymbolTokens(options.register || options.moduleContext || "");
  const longContext = [...symbols, ...contextSymbols].some((token) => token.length > 3);
  const preferredTypes = preferredEntityTypes(query);
  const normalizedQuery = normalizeForSearch(query);
  return (graph.entities || []).filter((entity) => !["document", "page"].includes(entity.type)).map((entity) => {
    const aliases = unique([entity.canonicalName, ...(entity.aliases || [])]).map(canonicalSymbol);
    const text = entityText(entity);
    let score = 0;
    const reasons = [];
    let symbolMatched = false;
    for (const symbol of symbols) {
      const shortSymbol = symbol.length <= 3;
      if (aliases.includes(symbol)) {
        if (shortSymbol && !longContext) continue;
        score += shortSymbol ? 30 : 120;
        symbolMatched = true;
        reasons.push(shortSymbol ? `context-qualified short symbol ${symbol}` : `exact symbol ${symbol}`);
      } else if (aliases.some((alias) => symbolVariantMatches(alias, symbol, entity.type))) {
        score += 60;
        symbolMatched = true;
        reasons.push(`qualified symbol variant ${symbol}`);
      }
    }
    let lexicalHits = 0;
    for (const term of terms) {
      if (GENERIC_QUERY_TERMS.has(term)) continue;
      if (text.includes(term)) {
        lexicalHits += 1;
        score += term.length > 4 ? 12 : 4;
        reasons.push(`lexical entity term ${term}`);
      }
    }
    const canonicalPhrase = normalizeForSearch(entity.canonicalName || "");
    const exactPhraseMatched = canonicalPhrase.length >= 5 && normalizedQuery.includes(canonicalPhrase);
    if (exactPhraseMatched) {
      score += 120;
      reasons.push("exact entity phrase");
    }
    // A lone generic lexical hit is not an exact-entity signal. This prevents
    // every register/table section containing “offset” or “reset” from
    // competing with an exact hardware symbol.
    if (!reasons.some((reason) => reason.includes("symbol")) && lexicalHits < 2) return { entity, score: 0, retrievalReasons: [] };
    if (symbols.length && ["register", "bitfield"].includes(entity.type) && !symbolMatched && !exactPhraseMatched) return { entity, score: 0, retrievalReasons: [] };
    if (preferredTypes.size === 1 && preferredTypes.has("section") && entity.type !== "section") return { entity, score: 0, retrievalReasons: [] };
    if (score > 0 && preferredTypes.has(entity.type)) score += 60;
    if (score > 0 && entity.type === "register" && /\b(offset|reset|access|details|properties)\b/i.test(query)) {
      const properties = entity.properties || {};
      const known = [properties.offsets, properties.resetValues, properties.accessSizes].filter((values) => Array.isArray(values) && values.some((value) => value && value !== "unknown")).length;
      score += known * 20;
    }
    return { entity, score, retrievalReasons: unique(reasons) };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || confidenceRank(right.entity.confidence) - confidenceRank(left.entity.confidence));
}

function graphNeighborhood(graph, entities, query) {
  const seeds = new Set(entities.map((entity) => entity.id));
  const relatedIds = new Set();
  for (const relation of graph.relationships || []) {
    if (seeds.has(relation.from)) relatedIds.add(relation.to);
    if (seeds.has(relation.to)) relatedIds.add(relation.from);
  }
  return (graph.entities || [])
    .filter((entity) => relatedIds.has(entity.id) && !seeds.has(entity.id) && ["register", "bitfield", "sequence", "sequence-step", "caution", "table", "figure", "interrupt", "clock", "reset"].includes(entity.type))
    .map((entity) => ({ entity, relevance: entityQueryRelevance(entity, query), retrievalReasons: ["one-hop evidence graph relationship"] }))
    .sort((left, right) => right.relevance - left.relevance || confidenceRank(right.entity.confidence) - confidenceRank(left.entity.confidence));
}

function pageNeighborhood(graph, evidence, query) {
  const pages = new Set(evidence.map((item) => Number(item.page)).filter(Number.isFinite));
  return (graph.entities || []).filter((entity) => {
    if (!["register", "bitfield", "sequence", "sequence-step", "caution", "table", "figure", "interrupt", "clock", "reset"].includes(entity.type)) return false;
    return (entity.sourceLocations || []).some((location) => pages.has(Number(location.page)));
  }).map((entity) => ({ entity, relevance: entityQueryRelevance(entity, query), retrievalReasons: ["same-page neighborhood of ranked evidence"] }))
    .filter((item) => item.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance || confidenceRank(right.entity.confidence) - confidenceRank(left.entity.confidence));
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
  // Channel depth must not depend on the requested page size; otherwise the
  // same query receives a different fused order when topK or cursor changes.
  const exactEntities = exact.slice(0, MAX_TOP_K * 3).map((item) => item.entity);
  const includeOcr = Boolean(options.includeOcr) && /\b(figure|fig|diagram|timing|waveform|image|visual|table)\b/i.test(query);
  let lexicalRows = [];
  let lexicalWarning = "";
  try {
    const lexical = await hybridSearchPdf(filename, query, { register: options.register || "", intent: options.intent || "auto", topK: MAX_TOP_K });
    lexicalRows = lexicalEntityRows(graph, (lexical.results || [])
      .filter((item) => includeOcr || (item.sourceType !== "figure_ocr" && item.source_type !== "figure_ocr")), query);
  } catch (error) {
    lexicalWarning = `Lexical retrieval unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const exactRows = exact.map((item) => ({ entity: item.entity, evidence: entityEvidence(item.entity, { reason: item.retrievalReasons.join("; "), query }), retrievalReasons: item.retrievalReasons }));
  const neighborhoodRows = graphNeighborhood(graph, exactEntities, query).map((item) => ({ entity: item.entity, evidence: entityEvidence(item.entity, { reason: item.retrievalReasons[0], query }), retrievalReasons: item.retrievalReasons }));
  const lexicalEvidence = lexicalRows.map((item) => item.evidence);
  const pageRows = pageNeighborhood(graph, lexicalEvidence, query).map((item) => ({ entity: item.entity, evidence: entityEvidence(item.entity, { reason: item.retrievalReasons[0], query }), retrievalReasons: item.retrievalReasons }));
  const fused = reciprocalRankFuse([
    { name: "exact", results: exactRows },
    { name: "lexical", results: lexicalRows },
    { name: "graph", results: neighborhoodRows },
    { name: "neighborhood", results: pageRows },
  ]);
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
          reasons: item.retrievalReasons,
          rank: index + 1,
          rrfScore: Number(item.score.toFixed(6)),
          query,
        },
      },
    };
  });
  const paged = paginateEvidenceItems(normalized, topK, options.cursor, JSON.stringify({ filename, query, register: options.register || "", includeOcr: Boolean(options.includeOcr) }));
  return { graph, query, topK, results: paged.rows, pagination: paged.pagination, warnings: lexicalWarning ? [lexicalWarning] : [] };
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
      ...conflicts.flatMap((conflict) => conflict.recommendedVerification || []),
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
  return createEvidenceBundleV2({
    serverVersion: SERVER_VERSION,
    tool: "query_manual",
    filename,
    sourceFingerprint: retrieval.graph.sourceFingerprint,
    input: { filename, query, top_k: clampTopK(topK), cursor, register, include_ocr: Boolean(includeOcr) },
    summary: { retrievalChannels: ["exact", "lexical", "graph", "neighborhood"], graphEntities: retrieval.graph.entities.length, resultCountBeforePagination: retrieval.pagination.total },
    facts: mergeFacts(retrieval.results.map(evidenceFactFromResult)),
    evidence,
    inferences: [],
    conflicts: unique(retrieval.results.flatMap((result) => result.entity ? (retrieval.graph.conflicts || []).filter((conflict) => conflict.entityId === result.entity.id) : []).map((conflict) => JSON.stringify(conflict))).map((conflict) => JSON.parse(conflict)),
    gaps: evidence.length ? [] : [{ item: query, reason: "No result matched the graph or lexical channels.", recommendedAction: "Try an exact register name or inspect manual_status/index health." }],
    needsVerification: evidence.length ? [{ item: "Ranked evidence", reason: "Retrieval rank is not verification.", recommendedActions: ["read_manual_evidence", "read_pdf_pages"] }] : [],
    warnings: retrieval.warnings,
    recommendedNextActions: evidence.slice(0, 5).map((item) => item.chunkId ? { tool: "read_manual_evidence", arguments: { filename, entity_id: item.relatedEntityIds?.[0] || "", chunk_id: item.chunkId }, reason: "Read provenance and adjacent evidence." } : { tool: "read_pdf_pages", arguments: { filename, start_page: item.page, end_page: item.page }, reason: "Inspect the cited page." }),
    pagination: retrieval.pagination,
  });
}

export async function getManualEntityBundle({ filename, entityId } = {}) {
  const graph = await loadEvidenceGraph(filename, { buildIfMissing: true });
  const result = getEvidenceGraphEntity(graph, entityId);
  if (!result) throw new Error(`Manual entity not found: ${entityId}`);
  if (result.ambiguity) throw new Error(`Manual entity alias is ambiguous: ${entityId}. Use one of: ${result.ambiguity.candidateEntityIds.join(", ")}`);
  const evidence = [entityEvidence(result.entity, { reason: "direct entity lookup" })];
  return createEvidenceBundleV2({
    serverVersion: SERVER_VERSION,
    tool: "get_manual_entity",
    filename,
    sourceFingerprint: graph.sourceFingerprint,
    input: { filename, entity_id: entityId },
    summary: { entityType: result.entity.type, relatedEntityCount: result.relatedEntities.length, relationshipCount: result.relationships.length },
    entities: [result.entity, ...result.relatedEntities],
    relationships: result.relationships,
    facts: [evidenceFactFromResult({ entity: result.entity, evidence: evidence[0] })].filter(Boolean),
    evidence,
    inferences: [],
    conflicts: result.conflicts,
    gaps: [],
    needsVerification: result.entity.verificationStatus === "verified" ? [] : [{ item: result.entity.canonicalName, reason: `Entity status is ${result.entity.verificationStatus}.`, recommendedActions: ["read_manual_evidence"] }],
    warnings: result.entity.type === "figure" ? ["Figure semantic claims require opening the canonical PNG; graph caption metadata is not visual truth."] : [],
    recommendedNextActions: result.relatedEntities.slice(0, 12).map((entity) => ({ tool: "get_manual_entity", arguments: { filename, entity_id: entity.id }, reason: "Follow an evidence-graph relationship." })),
    pagination: { total: 1, returned: 1, truncated: false, nextCursor: null },
  });
}

export async function readManualEvidenceBundle({ filename, entityId = "", chunkId = "", page = null } = {}) {
  const graph = await loadEvidenceGraph(filename, { buildIfMissing: true });
  let entities = graph.entities || [];
  if (entityId) {
    const result = getEvidenceGraphEntity(graph, entityId);
    if (!result) throw new Error(`Manual entity not found: ${entityId}`);
    if (result.ambiguity) throw new Error(`Manual entity alias is ambiguous: ${entityId}. Use one of: ${result.ambiguity.candidateEntityIds.join(", ")}`);
    entities = [result.entity, ...result.relatedEntities];
  }
  const requestedPage = page === null || page === undefined ? null : Number(page);
  if (requestedPage !== null && (!Number.isInteger(requestedPage) || requestedPage < 1)) throw new Error("page must be a one-based integer");
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
