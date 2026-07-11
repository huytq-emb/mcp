import { canonicalSymbol } from "../core/runtime-helpers.js";

export const SEMANTIC_GOLDEN_SCHEMA_VERSION = 1;

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : 0;
}

function mean(values) {
  return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6)) : 0;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function normalized(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function propertyMatches(expected, actual) {
  if (expected === undefined || expected === null || expected === "") return true;
  const values = Array.isArray(actual) ? actual : [actual];
  return values.some((value) => normalized(value) === normalized(expected));
}

function factsFromBundle(bundle = {}) {
  const facts = Array.isArray(bundle.facts) ? bundle.facts : [];
  const evidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  return [...facts.map((fact) => ({ ...fact, source: "fact" })), ...evidence.map((item) => ({
    id: item.id,
    kind: item.kind,
    canonicalName: item.canonicalName || item.statement,
    properties: item.properties || {},
    page: item.page,
    statement: item.statement || "",
    evidenceIds: [item.id],
    source: "evidence",
  }))];
}

function expectedMatches(actual, expected) {
  const expectedName = canonicalSymbol(expected.canonicalName || expected.name || expected.id || "");
  const actualName = canonicalSymbol(actual.canonicalName || actual.name || actual.statement || "");
  if (expected.kind && String(actual.kind || "").toLowerCase() !== String(expected.kind).toLowerCase()) return false;
  if (expectedName && actualName !== expectedName && !actualName.includes(expectedName) && !expectedName.includes(actualName)) return false;
  return true;
}

function bestActual(actuals, expected) {
  return actuals.find((actual) => expectedMatches(actual, expected)) || null;
}

function hasExpectedText(items, expected) {
  const needle = normalized(expected);
  return items.some((item) => normalized([item.statement, item.canonicalName, JSON.stringify(item.properties || {})].join(" ")).includes(needle));
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
      if (!fact.id || !fact.kind || !(fact.canonicalName || fact.name)) errors.push(`cases[${index}].expectedFacts[${factIndex}] requires id, kind, and canonicalName`);
      if (!Number.isFinite(Number(fact.page)) || Number(fact.page) < 1) errors.push(`cases[${index}].expectedFacts[${factIndex}] requires verified page`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function evaluateSemanticGoldenDataset(dataset, caseResults = {}) {
  const validation = validateSemanticGoldenDataset(dataset);
  if (!validation.ok) return { health: "fail", validation, metrics: {}, failures: validation.errors };
  const totalExpected = dataset.cases.flatMap((testCase) => testCase.expectedFacts || []);
  let recall5Hits = 0;
  let recall10Hits = 0;
  const reciprocalRanks = [];
  let registerTotal = 0;
  let registerCorrect = 0;
  let bitfieldTotal = 0;
  let bitfieldCorrect = 0;
  let propertyTotal = 0;
  let propertyCorrect = 0;
  let sequenceTotal = 0;
  let sequenceCovered = 0;
  let cautionTotal = 0;
  let cautionHits = 0;
  let figureTotal = 0;
  let figureCorrect = 0;
  let pageTotal = 0;
  let pageCorrect = 0;
  let duplicateEvidence = 0;
  let evidenceCount = 0;
  let unsupportedClaims = 0;
  let claimCount = 0;
  const latencies = [];
  const indexingDurations = [];
  const peakMemory = [];
  const failures = [];

  for (const testCase of dataset.cases) {
    const result = caseResults[testCase.id] || {};
    const bundle = result.bundle || result;
    const actuals = factsFromBundle(bundle);
    const ranked = actuals.slice(0, 10);
    const evidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
    const evidenceIds = new Set(evidence.map((item) => item.id));
    evidenceCount += evidence.length;
    duplicateEvidence += evidence.length - new Set(evidence.map((item) => item.id)).size;
    for (const fact of Array.isArray(bundle.facts) ? bundle.facts : []) {
      claimCount += 1;
      if (!Array.isArray(fact.evidenceIds) || !fact.evidenceIds.length || fact.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) unsupportedClaims += 1;
    }
    if (Number.isFinite(Number(result.latencyMs))) latencies.push(Number(result.latencyMs));
    if (Number.isFinite(Number(result.indexingDurationMs))) indexingDurations.push(Number(result.indexingDurationMs));
    if (Number.isFinite(Number(result.peakRssMb))) peakMemory.push(Number(result.peakRssMb));

    for (const expected of testCase.expectedFacts) {
      const rank = ranked.findIndex((actual) => expectedMatches(actual, expected));
      if (rank >= 0 && rank < 5) recall5Hits += 1;
      if (rank >= 0 && rank < 10) recall10Hits += 1;
      reciprocalRanks.push(rank >= 0 ? 1 / (rank + 1) : 0);
      const actual = bestActual(actuals, expected);
      if (!actual) {
        failures.push(`${testCase.id}: missing ${expected.kind} ${expected.canonicalName}`);
        continue;
      }
      if (expected.kind === "register") {
        registerTotal += 1;
        if (canonicalSymbol(actual.canonicalName || actual.statement) === canonicalSymbol(expected.canonicalName)) registerCorrect += 1;
      }
      if (expected.kind === "bitfield") {
        bitfieldTotal += 1;
        if (canonicalSymbol(actual.canonicalName || actual.statement).includes(canonicalSymbol(expected.canonicalName))) bitfieldCorrect += 1;
      }
      for (const property of ["offset", "reset", "access", "accessSize"]) {
        if (expected[property] === undefined) continue;
        propertyTotal += 1;
        const actualProperties = actual.properties || {};
        const propertyKeys = {
          offset: ["offset", "offsets", "offsetAddresses"],
          reset: ["reset", "resets", "resetValues", "initialValues"],
          access: ["access"],
          accessSize: ["accessSize", "accessSizes"],
        }[property];
        const possible = propertyKeys.map((key) => actualProperties[key]).find((value) => value !== undefined) ?? actual[property];
        if (propertyMatches(expected[property], possible) || normalized(actual.statement).includes(normalized(expected[property]))) propertyCorrect += 1;
      }
      if (expected.sequenceSteps?.length) {
        sequenceTotal += expected.sequenceSteps.length;
        sequenceCovered += expected.sequenceSteps.filter((step) => hasExpectedText(actuals, step)).length;
      }
      if (expected.caution) {
        cautionTotal += 1;
        if (hasExpectedText(actuals, expected.caution)) cautionHits += 1;
      }
      if (expected.figureLocator) {
        figureTotal += 1;
        const matchingFigure = actuals.find((item) => item.kind === "figure" && Number(item.page) === Number(expected.figureLocator.page));
        if (matchingFigure) figureCorrect += 1;
      }
      pageTotal += 1;
      const pageMatch = actuals.find((candidate) => expectedMatches(candidate, expected) && Number(candidate.page ?? candidate.properties?.page ?? 0) === Number(expected.page));
      if (pageMatch) pageCorrect += 1;
    }
  }

  const metrics = {
    recallAt5: ratio(recall5Hits, totalExpected.length),
    recallAt10: ratio(recall10Hits, totalExpected.length),
    meanReciprocalRank: mean(reciprocalRanks),
    registerExactMatchAccuracy: ratio(registerCorrect, registerTotal),
    bitfieldExactMatchAccuracy: ratio(bitfieldCorrect, bitfieldTotal),
    offsetResetAccessExactMatchAccuracy: ratio(propertyCorrect, propertyTotal),
    sequenceStepCoverage: ratio(sequenceCovered, sequenceTotal),
    cautionRecall: ratio(cautionHits, cautionTotal),
    figureLocatorAccuracy: ratio(figureCorrect, figureTotal),
    evidencePageCorrectness: ratio(pageCorrect, pageTotal),
    duplicateEvidenceRate: ratio(duplicateEvidence, evidenceCount),
    unsupportedClaimRate: ratio(unsupportedClaims, claimCount),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    indexingDurationMs: mean(indexingDurations),
    peakMemoryMb: Math.max(0, ...peakMemory),
  };
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

export function compareSemanticRegression(current = {}, baseline = {}, tolerances = {}) {
  const failures = [];
  for (const [metric, baselineValue] of Object.entries(baseline || {})) {
    const actual = Number(current[metric]);
    const previous = Number(baselineValue);
    if (!Number.isFinite(actual) || !Number.isFinite(previous)) continue;
    const tolerance = Number(tolerances[metric] ?? 0);
    const lowerIsBetter = /rate$|latency|duration|memory/i.test(metric);
    if (lowerIsBetter ? actual > previous + tolerance : actual < previous - tolerance) {
      failures.push(`${metric} regressed from ${previous} to ${actual} (tolerance ${tolerance})`);
    }
  }
  return { ok: failures.length === 0, failures };
}
