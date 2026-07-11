import { canonicalSymbol } from "../core/runtime-helpers.js";

export const SEMANTIC_GOLDEN_SCHEMA_VERSION = 1;

function ratio(numerator, denominator) { return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : 0; }
function mean(values) { return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6)) : 0; }
function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}
function normalized(value) { return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function normalizedPhrase(value) { return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim(); }
function propertyMatches(expected, actual) {
  if (expected === undefined || expected === null || expected === "") return true;
  return (Array.isArray(actual) ? actual : [actual]).some((value) => normalized(value) === normalized(expected));
}

function evidenceActuals(bundle = {}) {
  return (bundle.evidence || []).map((item, index) => ({
    ...item,
    id: item.entityId || item.id,
    kind: item.kind,
    canonicalName: item.canonicalName || item.statement,
    properties: item.properties || {},
    aliases: item.aliases || [],
    source: "evidence",
    inputOrder: index + 1,
  }));
}
function factActuals(bundle = {}) { return (bundle.facts || []).map((fact) => ({ ...fact, source: "fact" })); }
function actualsFromBundle(bundle = {}) { return [...factActuals(bundle), ...evidenceActuals(bundle)]; }

// Facts are verified assertions, not retrieval results. Ranking metrics must
// therefore be driven exclusively by retrieval evidence and its original rank.
function rankedEvidence(bundle = {}) {
  return evidenceActuals(bundle).sort((left, right) => {
    const leftRank = Number(left.retrieval?.rank);
    const rightRank = Number(right.retrieval?.rank);
    const leftKnown = Number.isFinite(leftRank) && leftRank > 0;
    const rightKnown = Number.isFinite(rightRank) && rightRank > 0;
    if (leftKnown && rightKnown && leftRank !== rightRank) return leftRank - rightRank;
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    return left.inputOrder - right.inputOrder;
  });
}

function exactSymbol(value) { return canonicalSymbol(value || ""); }
function isHardwareType(type) { return ["register", "bitfield"].includes(String(type || "").toLowerCase()); }

export function expectedMatches(actual = {}, expected = {}) {
  const type = String(expected.kind || expected.entityType || "").toLowerCase();
  if (type && String(actual.kind || actual.type || "").toLowerCase() !== type) return false;
  if (expected.entityId && String(actual.id || actual.entityId || "") !== String(expected.entityId)) return false;
  const expectedCanonical = exactSymbol(expected.canonicalName || expected.name || "");
  const actualCanonical = exactSymbol(actual.canonicalName || actual.name || actual.statement || "");
  const aliases = (expected.aliases || []).map(exactSymbol).filter(Boolean);
  const actualAliases = [actual.canonicalName, actual.name, ...(actual.aliases || [])].map(exactSymbol).filter(Boolean);
  if (expectedCanonical || aliases.length) {
    if (isHardwareType(type || actual.kind || actual.type)) {
      return Boolean((expectedCanonical && actualCanonical === expectedCanonical) || aliases.some((alias) => actualAliases.includes(alias)));
    }
    const candidates = [expectedCanonical, ...aliases].filter(Boolean);
    // Controlled text matching is for human-language entities only. A short
    // symbol such as EN or CR can never match an unrelated word.
    return candidates.some((candidate) => candidate.length >= 4 && (actualCanonical === candidate || actualCanonical.includes(candidate) || candidate.includes(actualCanonical)));
  }
  return true;
}

function bestActual(actuals, expected) { return actuals.find((actual) => expectedMatches(actual, expected)) || null; }
function hasExpectedText(items, expected) {
  const needle = normalizedPhrase(expected);
  return needle.length >= 3 && items.some((item) => {
    const properties = item.properties || {};
    const structuredStep = [properties.register, properties.bitfield, properties.value].filter((value) => value !== null && value !== undefined && value !== "").join(" ");
    return normalizedPhrase([item.statement, item.canonicalName, structuredStep, JSON.stringify(properties)].join(" ")).includes(needle);
  });
}
function entityMap(bundle = {}) {
  const map = new Map();
  for (const entity of bundle.entities || []) map.set(entity.id, entity);
  for (const evidence of bundle.evidence || []) {
    const id = evidence.entityId || evidence.relatedEntityIds?.[0];
    if (id && !map.has(id)) map.set(id, { id, type: evidence.kind, canonicalName: evidence.canonicalName || evidence.statement, properties: evidence.properties || {}, aliases: [] });
  }
  return map;
}
function matchingEntity(bundle, expected) { return [...entityMap(bundle).values()].find((entity) => expectedMatches({ ...entity, kind: entity.type }, expected)) || null; }
function connectedRelationships(bundle, entityId, type) {
  return (bundle.relationships || []).filter((relation) => (!type || relation.type === type) && (relation.from === entityId || relation.to === entityId));
}
function sequenceStepRows(bundle, sequence) {
  if (!sequence) return [];
  const entities = entityMap(bundle);
  const relations = connectedRelationships(bundle, sequence.id, "sequence-has-step");
  return relations.map((relation) => ({ relation, entity: entities.get(relation.from === sequence.id ? relation.to : relation.from) })).filter((item) => item.entity);
}

// Sequence coverage is a correctness check, not a best-effort presentation
// order. In particular, insertion order must never make an incomplete graph
// look ordered.
function sequenceOrdering(bundle, sequence) {
  const steps = sequenceStepRows(bundle, sequence);
  if (!steps.length) return { steps, ordered: false, orderingSource: null, errors: ["sequence has no resolved steps"] };
  const explicitOrder = (item) => item.entity.properties?.order ?? item.relation.properties?.order;
  const explicitValues = steps.map(explicitOrder);
  const hasExplicitOrder = explicitValues.some((value) => value !== undefined && value !== null && value !== "");
  if (hasExplicitOrder) {
    const numericOrders = explicitValues.map(Number);
    if (!numericOrders.every(Number.isFinite)) return { steps, ordered: false, orderingSource: "explicit-order", errors: ["every sequence step must have a finite explicit order"] };
    if (new Set(numericOrders).size !== numericOrders.length) return { steps, ordered: false, orderingSource: "explicit-order", errors: ["sequence step explicit orders must be unique"] };
    return {
      steps: [...steps].sort((left, right) => Number(explicitOrder(left)) - Number(explicitOrder(right)) || left.entity.id.localeCompare(right.entity.id)),
      ordered: true,
      orderingSource: "explicit-order",
      errors: [],
    };
  }
  const stepById = new Map(steps.map((item) => [item.entity.id, item]));
  const incoming = new Map(steps.map((item) => [item.entity.id, 0]));
  const next = new Map(steps.map((item) => [item.entity.id, new Set()]));
  for (const relation of bundle.relationships || []) {
    if (relation.type !== "sequence-step-occurs-before" || !stepById.has(relation.from) || !stepById.has(relation.to)) continue;
    if (!next.get(relation.from).has(relation.to)) {
      next.get(relation.from).add(relation.to);
      incoming.set(relation.to, incoming.get(relation.to) + 1);
    }
  }
  let queue = steps.filter((item) => incoming.get(item.entity.id) === 0).sort((left, right) => left.entity.id.localeCompare(right.entity.id));
  const ordered = [];
  while (queue.length) {
    // More than one available step means the declared relationships do not
    // establish a complete sequence order. Sorting would be deterministic but
    // would still invent ordering evidence.
    if (queue.length !== 1) return { steps, ordered: false, orderingSource: "relationship-dag", errors: ["sequence relationship order is incomplete or disconnected"] };
    const current = queue.shift();
    ordered.push(current);
    for (const id of [...next.get(current.entity.id)].sort()) {
      incoming.set(id, incoming.get(id) - 1);
      if (incoming.get(id) === 0) queue.push(stepById.get(id));
    }
    queue = queue.sort((left, right) => left.entity.id.localeCompare(right.entity.id));
  }
  if (ordered.length !== steps.length) return { steps, ordered: false, orderingSource: "relationship-dag", errors: ["sequence relationship order contains a cycle"] };
  return { steps: ordered, ordered: true, orderingSource: "relationship-dag", errors: [] };
}
function sequenceStepsInOrder(bundle, sequence, expectedSteps) {
  const ordering = sequenceOrdering(bundle, sequence);
  const steps = ordering.steps;
  if (steps.length > 1 && !ordering.ordered) return false;
  let cursor = -1;
  for (const expected of expectedSteps) {
    const index = steps.findIndex((item, position) => position > cursor && hasExpectedText([item.entity], expected));
    if (index < 0) return false;
    cursor = index;
  }
  return true;
}
function cautionTextMatches(caution, expectedCaution) {
  if (typeof expectedCaution === "string") return hasExpectedText([caution], expectedCaution);
  const expected = expectedCaution || {};
  const identityExpected = expected.entityId || expected.canonicalName || expected.name || (expected.aliases || []).length;
  const identityMatches = identityExpected && expectedMatches({ ...caution, kind: "caution" }, { ...expected, kind: "caution" });
  const text = expected.text || expected.statement || expected.description || "";
  return Boolean(identityMatches || (text && hasExpectedText([caution], text)));
}
function cautionMatches(bundle, expected, actual) {
  const targetId = expected.cautionEntityId || expected.entityId || actual?.id;
  if (!targetId) return false;
  const relationships = bundle.relationships || [];
  return [...entityMap(bundle).values()]
    .filter((entity) => entity.type === "caution")
    .some((caution) => cautionTextMatches(caution, expected.caution) && relationships.some((relation) => relation.type === "register-has-caution" && (
      (relation.from === targetId && relation.to === caution.id) ||
      (relation.to === targetId && relation.from === caution.id)
    )));
}
function figureMatches(bundle, expected, sequence) {
  const locator = expected.figureLocator || expected.figure || {};
  if (!locator || !Object.keys(locator).length) return true;
  const figures = [...entityMap(bundle).values()].filter((entity) => entity.type === "figure");
  return figures.some((figure) => {
    const figureId = figure.properties?.figureId || figure.figureId || figure.id;
    const figurePage = Number(figure.sourceLocations?.[0]?.page ?? figure.properties?.page ?? 0);
    if (locator.page !== undefined && Number(locator.page) !== figurePage) return false;
    const exactId = Boolean(locator.figureId && (figureId === locator.figureId || (figure.aliases || []).includes(locator.figureId)));
    const caption = Boolean(locator.caption && normalizedPhrase(figure.properties?.caption || figure.canonicalName).includes(normalizedPhrase(locator.caption)));
    const illustratesSequence = Boolean(sequence && (bundle.relationships || []).some((relation) => relation.type === "figure-illustrates-sequence" && ((relation.from === figure.id && relation.to === sequence.id) || (relation.to === figure.id && relation.from === sequence.id))));
    // A page narrows a known locator, but does not establish figure identity.
    return exactId || caption || illustratesSequence;
  });
}

export function validateSemanticGoldenDataset(dataset = {}) {
  const errors = [];
  if (dataset.schemaVersion !== SEMANTIC_GOLDEN_SCHEMA_VERSION) errors.push(`schemaVersion must be ${SEMANTIC_GOLDEN_SCHEMA_VERSION}`);
  if (dataset.type !== "semantic-golden-dataset") errors.push("type must be semantic-golden-dataset");
  if (!String(dataset.subsystem || "").trim()) errors.push("subsystem is required");
  if (!String(dataset.manual?.filename || "").endsWith(".pdf")) errors.push("manual.filename must be a PDF filename");
  if (!dataset.manual?.verification || dataset.manual.verification.status !== "manually-verified") errors.push("manual.verification.status must be manually-verified");
  if (!Array.isArray(dataset.cases) || !dataset.cases.length) errors.push("at least one semantic case is required");
  for (const [index, testCase] of (dataset.cases || []).entries()) {
    if (!testCase.id || !testCase.query) errors.push(`cases[${index}] requires id and realistic query`);
    if (!Array.isArray(testCase.expectedFacts) || !testCase.expectedFacts.length) errors.push(`cases[${index}] requires expectedFacts`);
    for (const [factIndex, fact] of (testCase.expectedFacts || []).entries()) {
      if (!fact.kind || !(fact.canonicalName || fact.name || fact.entityId)) errors.push(`cases[${index}].expectedFacts[${factIndex}] requires kind and identity`);
      if (!Number.isFinite(Number(fact.page)) || Number(fact.page) < 1) errors.push(`cases[${index}].expectedFacts[${factIndex}] requires verified page`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function evaluateSemanticGoldenDataset(dataset, caseResults = {}) {
  const validation = validateSemanticGoldenDataset(dataset);
  if (!validation.ok) return { health: "fail", validation, metrics: {}, failures: validation.errors };
  const totalExpected = dataset.cases.flatMap((testCase) => testCase.expectedFacts || []);
  let recall5Hits = 0; let recall10Hits = 0; const reciprocalRanks = [];
  let registerTotal = 0; let registerCorrect = 0; let bitfieldTotal = 0; let bitfieldCorrect = 0;
  let propertyTotal = 0; let propertyCorrect = 0; let sequenceTotal = 0; let sequenceCovered = 0;
  let cautionTotal = 0; let cautionHits = 0; let figureTotal = 0; let figureCorrect = 0;
  let pageTotal = 0; let pageCorrect = 0; let duplicateEvidence = 0; let evidenceCount = 0;
  let unsupportedClaims = 0; let claimCount = 0; const latencies = []; const indexingDurations = []; const peakMemory = []; const failures = [];
  for (const testCase of dataset.cases) {
    const result = caseResults[testCase.id] || {}; const bundle = result.bundle || result;
    const actuals = actualsFromBundle(bundle); const ranked = rankedEvidence(bundle); const evidence = bundle.evidence || [];
    const evidenceIds = new Set(evidence.map((item) => item.id)); evidenceCount += evidence.length; duplicateEvidence += evidence.length - evidenceIds.size;
    for (const fact of bundle.facts || []) { claimCount += 1; if (!Array.isArray(fact.evidenceIds) || !fact.evidenceIds.length || fact.evidenceIds.some((id) => !evidenceIds.has(id))) unsupportedClaims += 1; }
    if (Number.isFinite(Number(result.latencyMs))) latencies.push(Number(result.latencyMs));
    if (Number.isFinite(Number(result.indexingDurationMs))) indexingDurations.push(Number(result.indexingDurationMs));
    if (Number.isFinite(Number(result.peakRssMb))) peakMemory.push(Number(result.peakRssMb));
    for (const expected of testCase.expectedFacts) {
      const rank = ranked.findIndex((actual) => expectedMatches(actual, expected));
      if (rank >= 0 && rank < 5) recall5Hits += 1;
      if (rank >= 0 && rank < 10) recall10Hits += 1;
      reciprocalRanks.push(rank >= 0 ? 1 / (rank + 1) : 0);
      const actual = bestActual(actuals, expected);
      if (!actual) { failures.push(`${testCase.id}: missing ${expected.kind} ${expected.canonicalName || expected.entityId}`); continue; }
      if (expected.kind === "register") { registerTotal += 1; if (expectedMatches(actual, expected)) registerCorrect += 1; }
      if (expected.kind === "bitfield") { bitfieldTotal += 1; if (expectedMatches(actual, expected)) bitfieldCorrect += 1; }
      for (const property of ["offset", "reset", "access", "accessSize"]) {
        if (expected[property] === undefined) continue;
        propertyTotal += 1;
        const keys = { offset: ["offset", "offsets", "offsetAddresses"], reset: ["reset", "resets", "resetValues", "initialValues"], access: ["access"], accessSize: ["accessSize", "accessSizes"] }[property];
        const value = keys.map((key) => actual.properties?.[key]).find((candidate) => candidate !== undefined) ?? actual[property];
        if (propertyMatches(expected[property], value) || normalizedPhrase(actual.statement).includes(normalizedPhrase(expected[property]))) propertyCorrect += 1;
      }
      const sequence = expected.sequenceSteps?.length ? matchingEntity(bundle, { entityId: expected.sequenceEntityId, canonicalName: expected.sequenceCanonicalName || expected.canonicalName, kind: "sequence" }) : null;
      if (expected.sequenceSteps?.length) { sequenceTotal += expected.sequenceSteps.length; sequenceCovered += sequenceStepsInOrder(bundle, sequence, expected.sequenceSteps) ? expected.sequenceSteps.length : 0; }
      if (expected.caution) { cautionTotal += 1; if (cautionMatches(bundle, expected, actual)) cautionHits += 1; }
      if (expected.figureLocator || expected.figure) { figureTotal += 1; if (figureMatches(bundle, expected, sequence)) figureCorrect += 1; }
      pageTotal += 1;
      if (actuals.some((candidate) => expectedMatches(candidate, expected) && Number(candidate.page ?? candidate.properties?.page ?? 0) === Number(expected.page))) pageCorrect += 1;
    }
  }
  const metrics = { recallAt5: ratio(recall5Hits, totalExpected.length), recallAt10: ratio(recall10Hits, totalExpected.length), meanReciprocalRank: mean(reciprocalRanks), registerExactMatchAccuracy: ratio(registerCorrect, registerTotal), bitfieldExactMatchAccuracy: ratio(bitfieldCorrect, bitfieldTotal), offsetResetAccessExactMatchAccuracy: ratio(propertyCorrect, propertyTotal), sequenceStepCoverage: ratio(sequenceCovered, sequenceTotal), cautionRecall: ratio(cautionHits, cautionTotal), figureLocatorAccuracy: ratio(figureCorrect, figureTotal), evidencePageCorrectness: ratio(pageCorrect, pageTotal), duplicateEvidenceRate: ratio(duplicateEvidence, evidenceCount), unsupportedClaimRate: ratio(unsupportedClaims, claimCount), p50LatencyMs: percentile(latencies, 0.5), p95LatencyMs: percentile(latencies, 0.95), indexingDurationMs: mean(indexingDurations), peakMemoryMb: Math.max(0, ...peakMemory) };
  const thresholdResult = evaluateSemanticThresholds(metrics, dataset.thresholds || {});
  return { health: thresholdResult.ok ? "ok" : "fail", validation, metrics, thresholdResult, failures: [...failures, ...thresholdResult.failures], casesEvaluated: dataset.cases.length };
}

export function evaluateSemanticThresholds(metrics = {}, thresholds = {}) {
  const failures = [];
  for (const [metric, requirement] of Object.entries(thresholds.metrics || thresholds || {})) {
    const actual = Number(metrics[metric]);
    if (!Number.isFinite(actual)) { failures.push(`${metric}: metric is unavailable`); continue; }
    if (requirement?.min !== undefined && actual < Number(requirement.min)) failures.push(`${metric}: ${actual} is below minimum ${requirement.min}`);
    if (requirement?.max !== undefined && actual > Number(requirement.max)) failures.push(`${metric}: ${actual} exceeds maximum ${requirement.max}`);
  }
  return { ok: failures.length === 0, failures };
}

export function evaluateCoverageExpectation(queryCase = {}, result = {}) {
  const expectation = queryCase.expectation || { type: "runtime-only" };
  const type = typeof expectation === "string" ? expectation : expectation.type;
  if (type === "runtime-only") return { type, evaluated: false, passed: true, reason: "runtime-only" };
  const bundle = result.bundle || result || {};
  const actuals = actualsFromBundle(bundle);
  const entities = [...entityMap(bundle).values()];
  const types = new Set((expectation.requiredEntityTypes || []).map((value) => String(value).toLowerCase()));
  const matchingTypes = (item) => !types.size || types.has(String(item.kind || item.type || "").toLowerCase());
  const hasEntity = (expected = expectation) => actuals.some((item) => matchingTypes(item) && expectedMatches(item, { kind: expected.entityType, entityId: expected.entityId, canonicalName: expected.canonicalName, aliases: expected.aliases }));
  const allowedPages = expectation.allowedPages || expectation.allowedPageRange;
  const pageAllowed = (page) => !allowedPages || (Array.isArray(allowedPages) ? allowedPages.includes(Number(page)) : Number(page) >= Number(allowedPages.start) && Number(page) <= Number(allowedPages.end));
  let passed = false;
  if (type === "negative") {
    const forbidden = new Set((expectation.forbiddenCanonicalNames || []).map(exactSymbol));
    const allow = new Set(expectation.allowedEntityIds || []);
    passed = !(bundle.facts || []).length && !(bundle.evidence || []).some((item) => {
      const entityId = item.entityId || item.relatedEntityIds?.[0] || "";
      const nameForbidden = forbidden.has(exactSymbol(item.canonicalName || item.statement));
      const score = Number(item.retrieval?.rrfScore ?? item.retrieval?.relevance ?? 0);
      const meaningful = nameForbidden || (entityId && !allow.has(entityId)) || score > Number(expectation.maxAcceptedRrfScore ?? 0.01) || ["verified", "high-confidence"].includes(item.verificationStatus);
      return meaningful && !(expectation.allowGenericCandidateEvidence && !entityId && score <= Number(expectation.maxAcceptedRrfScore ?? 0.01));
    });
  } else if (type === "page") {
    passed = actuals.some((item) => matchingTypes(item) && pageAllowed(item.page));
  } else if (type === "property") {
    passed = hasEntity() && (!expectation.property || actuals.some((item) => matchingTypes(item) && propertyMatches(expectation.property.value, item.properties?.[expectation.property.name])));
  } else if (type === "text") {
    passed = Boolean(expectation.requiredText) && hasExpectedText(actuals, expectation.requiredText);
  } else if (type === "figure-locator") {
    passed = entities.some((entity) => entity.type === "figure") && figureMatches(bundle, { figureLocator: expectation }, null);
  } else if (type === "sequence") {
    const sequence = matchingEntity(bundle, { kind: "sequence", entityId: expectation.entityId, canonicalName: expectation.canonicalName });
    passed = Boolean(sequence) && (!expectation.orderedSteps?.length || sequenceStepsInOrder(bundle, sequence, expectation.orderedSteps));
  } else if (type === "caution") {
    const target = bestActual(actuals, { kind: expectation.relatedEntityType, entityId: expectation.relatedEntityId, canonicalName: expectation.relatedCanonicalName });
    passed = Boolean(target) ? cautionMatches(bundle, { ...expectation, caution: expectation.caution || { canonicalName: expectation.canonicalName }, entityId: target.id }, target) : entities.some((entity) => entity.type === "caution");
  } else {
    passed = actuals.some((item) => matchingTypes(item) && expectedMatches(item, expectation) && pageAllowed(item.page));
  }
  return { type, evaluated: true, passed, reason: passed ? "expectation satisfied" : "expectation not satisfied" };
}

export function evaluateCoverageQueries(queryCases = [], results = []) {
  const rows = queryCases.map((queryCase, index) => ({ id: queryCase.id || String(index), ...evaluateCoverageExpectation(queryCase, results[index]) }));
  const correctness = rows.filter((row) => row.evaluated);
  return { queryCount: rows.length, correctnessQueryCount: correctness.length, runtimeOnlyQueryCount: rows.length - correctness.length, correctnessRate: ratio(correctness.filter((row) => row.passed).length, correctness.length), failures: correctness.filter((row) => !row.passed).map((row) => row.id), rows };
}
export function compareSemanticRegression(current = {}, baseline = {}, tolerances = {}) {
  const failures = [];
  for (const [metric, baselineValue] of Object.entries(baseline || {})) {
    const actual = Number(current[metric]); const previous = Number(baselineValue);
    if (!Number.isFinite(actual) || !Number.isFinite(previous)) continue;
    const tolerance = Number(tolerances[metric] ?? 0); const lowerIsBetter = /rate$|latency|duration|memory/i.test(metric);
    if (lowerIsBetter ? actual > previous + tolerance : actual < previous - tolerance) failures.push(`${metric} regressed from ${previous} to ${actual} (tolerance ${tolerance})`);
  }
  return { ok: failures.length === 0, failures };
}
