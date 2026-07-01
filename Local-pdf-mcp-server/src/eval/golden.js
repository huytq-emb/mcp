import fs from "fs/promises";
import path from "path";
import { ensureDirectPdfFilename, ensureInsideRoot } from "../core/path-safety.js";

export const GOLDEN_SCHEMA_VERSION = 1;
export const DEFAULT_GOLDEN_PROFILE = "rzg3e-core";
export const GOLDEN_STATUSES = new Set(["candidate", "verified", "rejected"]);
export const GOLDEN_NOISE_BITFIELD_NAMES = new Set([
  "RW",
  "R",
  "W",
  "RZ",
  "G3E",
  "CPU",
  "RAM",
  "GLOBAL",
]);

export function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
}

export function normalizeComparable(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\[\]{}()_,-]+/g, "");
}

export function normalizeBitRange(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^bits?/, "")
    .replace(/^\[/, "")
    .replace(/\]$/, "");
}

export function goldenDir(root = process.cwd()) {
  return ensureInsideRoot(path.join(root, "eval", "golden"), path.join(root, "eval"), "golden directory");
}

export function safeGoldenProfilePath(root = process.cwd(), profile = DEFAULT_GOLDEN_PROFILE) {
  const safeName = String(profile || DEFAULT_GOLDEN_PROFILE)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || DEFAULT_GOLDEN_PROFILE;
  return ensureInsideRoot(path.join(goldenDir(root), `${safeName}.json`), goldenDir(root), "golden profile");
}

export function defaultGoldenProfile() {
  return {
    schemaVersion: GOLDEN_SCHEMA_VERSION,
    type: "golden-profile",
    profile: DEFAULT_GOLDEN_PROFILE,
    filename: "r01uh1069ej0115-rzg3e.pdf",
    description: "RZ/G3E core register/bitfield golden facts. Candidate facts are not trusted until status is changed to verified.",
    strictVerifiedOnly: true,
    registers: [],
    bitfields: [],
    tables: [],
    sequences: [],
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureGoldenProfile(root = process.cwd(), profile = DEFAULT_GOLDEN_PROFILE) {
  const filePath = safeGoldenProfilePath(root, profile);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (!(await pathExists(filePath))) {
    await fs.writeFile(filePath, `${JSON.stringify(defaultGoldenProfile(), null, 2)}\n`, "utf-8");
  }
  return filePath;
}

export async function loadGoldenProfile(root = process.cwd(), profile = DEFAULT_GOLDEN_PROFILE) {
  const filePath = await ensureGoldenProfile(root, profile);
  const data = JSON.parse(await fs.readFile(filePath, "utf-8"));
  return { filePath, profile: data, validation: validateGoldenProfile(data) };
}

export function validateGoldenProfile(profile) {
  const errors = [];
  const warnings = [];

  if (!profile || typeof profile !== "object") errors.push("profile must be an object");
  if (profile?.schemaVersion !== GOLDEN_SCHEMA_VERSION) errors.push(`schemaVersion must be ${GOLDEN_SCHEMA_VERSION}`);
  if (profile?.type !== "golden-profile") errors.push("type must be golden-profile");
  try {
    ensureDirectPdfFilename(profile?.filename || "");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(profile?.registers)) errors.push("registers must be an array");
  if (!Array.isArray(profile?.bitfields)) errors.push("bitfields must be an array");
  if (profile?.tables !== undefined && !Array.isArray(profile.tables)) errors.push("tables must be an array");
  if (profile?.sequences !== undefined && !Array.isArray(profile.sequences)) errors.push("sequences must be an array");

  for (const [kind, facts] of [["register", profile?.registers || []], ["bitfield", profile?.bitfields || []], ["table", profile?.tables || []], ["sequence", profile?.sequences || []]]) {
    for (const [index, fact] of facts.entries()) {
      const status = fact.status || "candidate";
      if (!GOLDEN_STATUSES.has(status)) errors.push(`${kind}[${index}] invalid status: ${status}`);
      if (kind === "register" && !fact.register) errors.push(`register[${index}] missing register`);
      if (kind === "bitfield" && (!fact.register || !(fact.bitfield || fact.field || fact.name))) {
        errors.push(`bitfield[${index}] missing register or bitfield`);
      }
      if (kind === "table" && !fact.kind) errors.push(`table[${index}] missing kind`);
      if (kind === "sequence" && !fact.topic) errors.push(`sequence[${index}] missing topic`);
      if (kind === "sequence" && fact.steps !== undefined && !Array.isArray(fact.steps)) errors.push(`sequence[${index}] steps must be an array`);
      if (status === "verified" && !(fact.evidence?.page || fact.page || fact.pages?.length)) {
        warnings.push(`${kind}[${index}] verified fact has no evidence page`);
      }
      if (fact.evidence !== undefined && (typeof fact.evidence !== "object" || Array.isArray(fact.evidence))) {
        errors.push(`${kind}[${index}] evidence must be an object`);
      }
      if (fact.registerAliases !== undefined && !Array.isArray(fact.registerAliases)) {
        errors.push(`${kind}[${index}] registerAliases must be an array`);
      }
      if (status === "verified" && kind === "register") {
        for (const field of ["offsetAddress", "initialValue", "accessSize"]) {
          if (fact[field] === undefined && !(field === "initialValue" && fact.reset !== undefined)) {
            warnings.push(`${kind}[${index}] verified fact missing ${field}`);
          }
        }
      }
      if (status === "verified" && kind === "bitfield") {
        for (const field of ["access", "reset"]) {
          if (fact[field] === undefined) warnings.push(`${kind}[${index}] verified fact missing ${field}`);
        }
        if (fact.bitRange === undefined && fact.bitPositionRange === undefined) {
          warnings.push(`${kind}[${index}] verified fact missing bitRange/bitPositionRange`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function indexPath(root, filename, suffix) {
  const safeName = ensureDirectPdfFilename(filename);
  return ensureInsideRoot(path.join(root, "indexes", `${safeName}${suffix}`), path.join(root, "indexes"), suffix);
}

export async function loadGoldenArtifacts(root, filename) {
  const registersPath = indexPath(root, filename, ".registers.json");
  const bitfieldsPath = indexPath(root, filename, ".bitfields.json");
  const manifestPath = indexPath(root, filename, ".manifest.json");
  const tablesPath = indexPath(root, filename, ".tables.json");
  const sequencesPath = indexPath(root, filename, ".sequences.json");
  const missing = [];

  let registersIndex = null;
  let bitfieldsIndex = null;
  let manifest = null;
  let tablesIndex = null;
  let sequencesIndex = null;

  if (await pathExists(registersPath)) registersIndex = JSON.parse(await fs.readFile(registersPath, "utf-8"));
  else missing.push(registersPath);

  if (await pathExists(bitfieldsPath)) bitfieldsIndex = JSON.parse(await fs.readFile(bitfieldsPath, "utf-8"));
  else missing.push(bitfieldsPath);

  if (await pathExists(manifestPath)) manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  else missing.push(manifestPath);
  if (await pathExists(tablesPath)) tablesIndex = JSON.parse(await fs.readFile(tablesPath, "utf-8"));
  if (await pathExists(sequencesPath)) sequencesIndex = JSON.parse(await fs.readFile(sequencesPath, "utf-8"));

  return {
    filename,
    registersPath,
    bitfieldsPath,
    tablesPath,
    sequencesPath,
    manifestPath,
    registers: registersIndex?.registers || [],
    bitfields: bitfieldsIndex?.bitfields || [],
    tables: tablesIndex?.tables || [],
    sequences: sequencesIndex?.sequences || [],
    quality: { bitfields: bitfieldsIndex?.quality || {}, tables: tablesIndex?.quality || {}, sequences: sequencesIndex?.quality || {} },
    manifest,
    missing,
  };
}

export function goldenManifestProblems(artifacts = {}) {
  const problems = [];
  const manifest = artifacts.manifest;
  if (!manifest) {
    problems.push("artifact manifest is missing");
    return problems;
  }
  if (manifest.health === "fail") problems.push("artifact manifest health is fail");
  for (const key of ["registers", "bitfields"]) {
    const artifact = manifest.artifacts?.[key];
    if (!artifact) problems.push(`artifact manifest missing ${key} entry`);
    else if (artifact.status !== "ok" && artifact.ok !== true) problems.push(`${key} artifact status is ${artifact.status || "not ok"}`);
  }
  return problems;
}

function registerNames(entry) {
  return [entry?.name, entry?.displayName, entry?.canonicalName, ...(entry?.aliases || [])]
    .map(normalizeSymbol)
    .filter(Boolean);
}

function bitfieldNames(entry) {
  return [entry?.bitfield, entry?.name, entry?.canonicalBitfield]
    .map(normalizeSymbol)
    .filter(Boolean);
}

function bitfieldRegisterNames(entry) {
  return [entry?.register, entry?.sourceRegister, entry?.canonicalRegister, entry?.displayRegister]
    .map(normalizeSymbol)
    .filter(Boolean);
}

function factRegisterNames(fact) {
  return [fact.register, fact.canonicalRegister, fact.artifactRegister, ...(fact.registerAliases || [])]
    .map(normalizeSymbol)
    .filter(Boolean);
}

function isUnknownValue(value) {
  const raw = String(value || "").trim().toLowerCase();
  return !raw || raw === "unknown" || raw === "n/a" || raw === "-";
}

export function classifyGoldenRegisterCandidate(entry = {}) {
  const reasons = [];
  let score = Number(entry.confidence || 0);
  const name = entry.displayName || entry.name || entry.register || "";
  const canonicalName = normalizeSymbol(name);
  const pages = (entry.pages || []).filter(Boolean);

  if (!canonicalName) reasons.push("missing register name");
  if (canonicalName === "GLOBAL" || canonicalName.endsWith("BASE")) reasons.push("register name is not a concrete register");
  if (!pages.length) reasons.push("missing page evidence");
  if (!(entry.offsetAddresses || []).some((value) => !isUnknownValue(value))) reasons.push("missing offset");
  if (!(entry.initialValues || []).some((value) => !isUnknownValue(value))) reasons.push("missing reset/initial value");
  if (!(entry.accessSizes || []).some((value) => !isUnknownValue(value))) reasons.push("missing access size");

  if (!reasons.length) score += 40;
  if ((entry.chunks || []).length) score += 10;

  const quality = reasons.some((reason) => /not a concrete|missing register name/.test(reason))
    ? "rejected_noise"
    : reasons.length
      ? "needs_manual_review"
      : "high_quality";
  return { quality, score, reasons };
}

export function classifyGoldenBitfieldCandidate(entry = {}, { strict = true } = {}) {
  const reasons = [];
  let score = Number(entry.confidence || 0);
  const register = normalizeSymbol(entry.register);
  const name = normalizeSymbol(entry.bitfield || entry.name || entry.canonicalBitfield);

  if (!register) reasons.push("missing register");
  if (!name) reasons.push("missing bitfield name");
  if (register === "GLOBAL") reasons.push("global pseudo-register");
  if (register.endsWith("BASE")) reasons.push("base pseudo-register; map to a concrete register before verification");
  if (entry.mappingStatus === "unresolved") reasons.push("unresolved register mapping");
  if (GOLDEN_NOISE_BITFIELD_NAMES.has(name) || /^R01UH\d+/i.test(entry.bitfield || "")) reasons.push(`noise bitfield name: ${entry.bitfield || name}`);
  if (isUnknownValue(entry.bitRange)) reasons.push("missing/unknown bit range");
  if (!((entry.pages || []).filter(Boolean)).length) reasons.push("missing page evidence");
  if (strict && isUnknownValue(entry.access)) reasons.push("missing/unknown access");
  if (strict && isUnknownValue(entry.reset)) reasons.push("missing/unknown reset");

  if (!reasons.length) score += 40;
  if ((entry.evidenceLines || []).length) score += 10;

  const quality = reasons.some((reason) => /noise|pseudo-register|missing bitfield name|missing register|global/.test(reason))
    ? "rejected_noise"
    : reasons.length
      ? "needs_manual_review"
      : "high_quality";
  return { quality, score, reasons };
}

export function matchRegisterFact(fact, registers = []) {
  const expectedNames = [fact.register, fact.name, ...(fact.aliases || [])].map(normalizeSymbol).filter(Boolean);
  let best = null;
  let bestScore = -1;
  for (const entry of registers) {
    const names = registerNames(entry);
    let score = 0;
    if (expectedNames.some((name) => names.includes(name))) score += 100;
    if (expectedNames.some((name) => names.some((candidate) => candidate.includes(name) || name.includes(candidate)))) score += 20;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

export function matchBitfieldFact(fact, bitfields = []) {
  const expectedRegisters = factRegisterNames(fact);
  const expectedNames = [fact.bitfield, fact.field, fact.name, ...(fact.aliases || [])].map(normalizeSymbol).filter(Boolean);
  let best = null;
  let bestScore = -1;
  for (const entry of bitfields) {
    const entryRegisters = bitfieldRegisterNames(entry);
    const registerMatches = !expectedRegisters.length || expectedRegisters.some((expected) => entryRegisters.includes(expected));
    if (expectedRegisters.length && !registerMatches) continue;
    const registerScore = expectedRegisters.length && registerMatches ? 60 : 0;
    const names = bitfieldNames(entry);
    let score = registerScore;
    if (expectedNames.some((name) => names.includes(name))) score += 100;
    if (expectedNames.some((name) => names.some((candidate) => candidate.includes(name) || name.includes(candidate)))) score += 15;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return bestScore >= 100 ? best : null;
}

function compareExpectedValue(label, expected, actualValues, normalize = normalizeComparable) {
  if (expected === undefined || expected === null || expected === "" || String(expected).toLowerCase() === "unknown") return null;
  const actual = Array.isArray(actualValues) ? actualValues : [actualValues];
  const normalizedExpected = normalize(expected);
  const ok = actual.some((value) => normalize(value) === normalizedExpected);
  return ok ? null : `${label} mismatch: expected ${expected}, got ${actual.filter(Boolean).join(" | ") || "missing"}`;
}

function compareExpectedPage(fact, actualPages) {
  const expectedPage = Number(fact.page || fact.evidence?.page || (Array.isArray(fact.pages) ? fact.pages[0] : 0));
  if (!Number.isFinite(expectedPage) || expectedPage <= 0) return null;
  const pages = (actualPages || []).map(Number);
  return pages.includes(expectedPage) ? null : `page mismatch: expected ${expectedPage}, got ${pages.join(", ") || "missing"}`;
}

function evaluateRegisterFact(fact, artifacts, strict) {
  const status = fact.status || "candidate";
  const actual = matchRegisterFact(fact, artifacts.registers);
  const failures = [];
  const warnings = [];
  if (!actual) failures.push(`register not found: ${fact.register}`);
  else {
    for (const message of [
      compareExpectedValue("offset", fact.offsetAddress || fact.offset, actual.offsetAddresses),
      compareExpectedValue("initial/reset", fact.initialValue || fact.reset, actual.initialValues),
      compareExpectedValue("accessSize", fact.accessSize, actual.accessSizes),
      compareExpectedPage(fact, actual.pages),
    ].filter(Boolean)) failures.push(message);
  }
  const strictFact = strict && status === "verified";
  if (!strictFact && failures.length) warnings.push(...failures);
  return { kind: "register", id: fact.id || fact.register, status, strict: strictFact, pass: strictFact ? failures.length === 0 : true, failures: strictFact ? failures : [], warnings, fact, actual };
}

function evaluateBitfieldFact(fact, artifacts, strict) {
  const status = fact.status || "candidate";
  const name = fact.bitfield || fact.field || fact.name;
  const actual = matchBitfieldFact(fact, artifacts.bitfields);
  const failures = [];
  const warnings = [];
  if (!actual) failures.push(`bitfield not found: ${fact.register}.${name}`);
  else {
    for (const message of [
      compareExpectedValue("bitPositionRange", fact.bitPositionRange, actual.bitPositionRange || actual.bitRange, normalizeBitRange),
      compareExpectedValue("fieldBitRange", fact.fieldBitRange, actual.fieldBitRange, normalizeBitRange),
      fact.bitPositionRange === undefined
        ? compareExpectedValue("bitRange", fact.bitRange || fact.bits, actual.bitRange || actual.bitPositionRange, normalizeBitRange)
        : null,
      compareExpectedValue("access", fact.access, actual.access),
      compareExpectedValue("reset", fact.reset || fact.initialValue, actual.reset),
      compareExpectedPage(fact, actual.pages),
    ].filter(Boolean)) failures.push(message);
  }
  const strictFact = strict && status === "verified";
  if (!strictFact && failures.length) warnings.push(...failures);
  return { kind: "bitfield", id: fact.id || `${fact.register}.${name}`, status, strict: strictFact, pass: strictFact ? failures.length === 0 : true, failures: strictFact ? failures : [], warnings, fact, actual };
}

export function matchTableFact(fact, tables = []) {
  const expectedPage = Number(fact.page || fact.pageStart || fact.evidence?.page || 0);
  return (tables || [])
    .filter((table) => !fact.kind || table.kind === fact.kind)
    .map((table) => {
      let score = table.kind === fact.kind ? 100 : 0;
      const start = Number(table.pageStart || table.page || 0);
      const end = Number(table.pageEnd || table.page || start);
      if (expectedPage && expectedPage >= start && expectedPage <= end) score += 80;
      const roles = new Set((table.layout?.columnRoles || []).map((column) => column.role));
      score += (fact.requiredRoles || []).filter((role) => roles.has(role)).length * 15;
      return { table, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.table || null;
}

export function matchSequenceFact(fact, sequences = []) {
  const expected = normalizeComparable(fact.topic);
  const best = (sequences || [])
    .map((sequence) => ({ sequence, score: normalizeComparable(sequence.topic) === expected ? 100 : normalizeComparable(sequence.topic).includes(expected) || expected.includes(normalizeComparable(sequence.topic)) ? 50 : 0 }))
    .sort((a, b) => b.score - a.score)[0];
  return best?.score > 0 ? best.sequence : null;
}

function evaluateTableFact(fact, artifacts, strict) {
  const status = fact.status || "candidate";
  const actual = matchTableFact(fact, artifacts.tables);
  const failures = [];
  const warnings = [];
  if (!actual) failures.push(`table not found: ${fact.kind}`);
  else {
    const start = Number(actual.pageStart || actual.page || 0);
    const end = Number(actual.pageEnd || actual.page || start);
    const expectedStart = Number(fact.pageStart || fact.page || fact.evidence?.page || 0);
    const expectedEnd = Number(fact.pageEnd || expectedStart || 0);
    if (expectedStart && start !== expectedStart) failures.push(`pageStart mismatch: expected ${expectedStart}, got ${start}`);
    if (expectedEnd && end !== expectedEnd) failures.push(`pageEnd mismatch: expected ${expectedEnd}, got ${end}`);
    if (fact.minRows && Number(actual.rowCount || actual.rows?.length || 0) < Number(fact.minRows)) failures.push(`row count below ${fact.minRows}`);
    const roles = new Set((actual.layout?.columnRoles || []).map((column) => column.role));
    for (const role of fact.requiredRoles || []) if (!roles.has(role)) failures.push(`missing column role: ${role}`);
  }
  const strictFact = strict && status === "verified";
  if (!strictFact && failures.length) warnings.push(...failures);
  return { kind: "table", id: fact.id || `${fact.kind}:${fact.pageStart || fact.page || "unknown"}`, status, strict: strictFact, pass: strictFact ? failures.length === 0 : true, failures: strictFact ? failures : [], warnings, fact, actual };
}

function evaluateSequenceFact(fact, artifacts, strict) {
  const status = fact.status || "candidate";
  const actual = matchSequenceFact(fact, artifacts.sequences);
  const failures = [];
  const warnings = [];
  if (!actual) failures.push(`sequence not found: ${fact.topic}`);
  else {
    if (fact.structureStatus && actual.structureStatus !== fact.structureStatus) failures.push(`structureStatus mismatch: expected ${fact.structureStatus}, got ${actual.structureStatus || "missing"}`);
    for (const [index, expectedStep] of (fact.steps || []).entries()) {
      const step = (actual.steps || [])[index];
      if (!step) { failures.push(`step ${index + 1} missing`); continue; }
      for (const field of ["operation", "register", "bitfield", "value"]) {
        const mismatch = compareExpectedValue(`step ${index + 1} ${field}`, expectedStep[field], step[field], field === "register" || field === "bitfield" ? normalizeSymbol : normalizeComparable);
        if (mismatch) failures.push(mismatch);
      }
      const pageMismatch = compareExpectedPage(expectedStep, [step.evidence?.page]);
      if (pageMismatch) failures.push(`step ${index + 1} ${pageMismatch}`);
    }
  }
  const strictFact = strict && status === "verified";
  if (!strictFact && failures.length) warnings.push(...failures);
  return { kind: "sequence", id: fact.id || fact.topic, status, strict: strictFact, pass: strictFact ? failures.length === 0 : true, failures: strictFact ? failures : [], warnings, fact, actual };
}

export async function evaluateGoldenProfile({
  root = process.cwd(),
  profile = DEFAULT_GOLDEN_PROFILE,
  strictVerifiedOnly = true,
} = {}) {
  const loaded = await loadGoldenProfile(root, profile);
  const data = loaded.profile;
  const validation = loaded.validation;
  const strict = strictVerifiedOnly !== false;
  const allFacts = [...(data.registers || []), ...(data.bitfields || []), ...(data.tables || []), ...(data.sequences || [])];
  const statusCounts = allFacts.reduce((acc, fact) => {
    const status = fact.status || "candidate";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const verifiedCount = statusCounts.verified || 0;

  if (!validation.ok) {
    return {
      schemaVersion: GOLDEN_SCHEMA_VERSION,
      profile: data.profile || profile,
      filename: data.filename || "",
      health: "fail",
      validation,
      summary: { total: allFacts.length, pass: 0, fail: validation.errors.length, warn: validation.warnings.length, verified: verifiedCount, candidate: statusCounts.candidate || 0, rejected: statusCounts.rejected || 0 },
      results: [],
      missingArtifacts: [],
    };
  }

  let artifacts = null;
  try {
    artifacts = await loadGoldenArtifacts(root, data.filename);
  } catch (error) {
    artifacts = { missing: [], loadError: error instanceof Error ? error.message : String(error), registers: [], bitfields: [] };
  }

  const missingArtifacts = [...(artifacts.missing || [])];
  if ((data.tables || []).some((fact) => fact.status === "verified") && !artifacts.tables?.length) missingArtifacts.push(artifacts.tablesPath);
  if ((data.sequences || []).some((fact) => fact.status === "verified") && !artifacts.sequences?.length) missingArtifacts.push(artifacts.sequencesPath);
  const manifestProblems = goldenManifestProblems(artifacts);
  for (const key of [
    (data.tables || []).some((fact) => fact.status === "verified") ? "tables" : null,
    (data.sequences || []).some((fact) => fact.status === "verified") ? "sequences" : null,
  ].filter(Boolean)) {
    const artifact = artifacts.manifest?.artifacts?.[key];
    if (!artifact) manifestProblems.push(`artifact manifest missing ${key} entry`);
    else if (artifact.status !== "ok" && artifact.ok !== true) manifestProblems.push(`${key} artifact status is ${artifact.status || "not ok"}`);
  }
  if ((missingArtifacts.length || manifestProblems.length) && verifiedCount > 0) {
    return {
      schemaVersion: GOLDEN_SCHEMA_VERSION,
      profile: data.profile || profile,
      filename: data.filename,
      health: "fail",
      validation,
      summary: { total: allFacts.length, pass: 0, fail: verifiedCount, warn: 0, verified: verifiedCount, candidate: statusCounts.candidate || 0, rejected: statusCounts.rejected || 0 },
      results: [],
      missingArtifacts,
      manifestProblems,
      recommendation: `Run index_pdf(filename="${data.filename}", mode="background") and rerun golden eval after mcp_control(action="job_status", job_id="...") is done.`,
    };
  }

  const registerResults = (data.registers || [])
    .filter((fact) => fact.status !== "rejected")
    .map((fact) => evaluateRegisterFact(fact, artifacts, strict));
  const bitfieldResults = (data.bitfields || [])
    .filter((fact) => fact.status !== "rejected")
    .map((fact) => evaluateBitfieldFact(fact, artifacts, strict));
  const tableResults = (data.tables || []).filter((fact) => fact.status !== "rejected").map((fact) => evaluateTableFact(fact, artifacts, strict));
  const sequenceResults = (data.sequences || []).filter((fact) => fact.status !== "rejected").map((fact) => evaluateSequenceFact(fact, artifacts, strict));
  const results = [...registerResults, ...bitfieldResults, ...tableResults, ...sequenceResults];
  const fail = results.filter((result) => !result.pass).length;
  const warn = validation.warnings.length + results.filter((result) => result.warnings.length).length + (missingArtifacts.length || manifestProblems.length ? 1 : 0);
  return {
    schemaVersion: GOLDEN_SCHEMA_VERSION,
    profile: data.profile || profile,
    filename: data.filename,
    strictVerifiedOnly: strict,
    health: fail ? "fail" : "pass",
    validation,
    summary: {
      total: results.length,
      pass: results.filter((result) => result.pass).length,
      fail,
      warn,
      verified: statusCounts.verified || 0,
      candidate: statusCounts.candidate || 0,
      rejected: statusCounts.rejected || 0,
    },
    missingArtifacts,
    manifestProblems,
    recommendation: missingArtifacts.length || manifestProblems.length
      ? `Run index_pdf(filename="${data.filename}", mode="background") before bootstrapping/evaluating golden facts.`
      : "",
    accuracyMetrics: {
      stitchedTables: (artifacts.tables || []).filter((table) => Number(table.pageEnd || table.page) > Number(table.pageStart || table.page)).length,
      validBitfields: (artifacts.bitfields || []).filter((entry) => entry.validationStatus === "valid").length,
      conflictingBitfields: (artifacts.bitfields || []).filter((entry) => entry.validationStatus === "conflict" || (entry.conflicts || []).length).length,
      structuredSequences: (artifacts.sequences || []).filter((sequence) => sequence.structureStatus === "complete").length,
      rejectedNoise: { bitfields: artifacts.quality?.bitfields?.rejectedNoise || 0, sequences: artifacts.quality?.sequences?.rejectedNoise || 0 },
    },
    results,
  };
}

function firstValue(values) {
  return Array.isArray(values) ? values.find(Boolean) || "" : values || "";
}

function firstPage(entry) {
  return (entry?.pages || []).map(Number).find((page) => Number.isFinite(page) && page > 0) || null;
}

function firstChunkId(entry) {
  return (entry?.chunks || []).find((chunk) => chunk?.id)?.id || null;
}

function firstEvidenceQuote(entry) {
  return (entry?.evidenceLines || []).find(Boolean)
    || entry?.chunks?.find((chunk) => chunk?.preview)?.preview?.split("\n").find(Boolean)
    || "";
}

function qualityCounts(items) {
  return items.reduce((acc, item) => {
    acc[item.classification.quality] = (acc[item.classification.quality] || 0) + 1;
    return acc;
  }, { high_quality: 0, needs_manual_review: 0, rejected_noise: 0 });
}

function sortByQualityScore(left, right) {
  return (right.classification.score || 0) - (left.classification.score || 0);
}

function registerCandidateFromEntry(entry, classification) {
  const page = firstPage(entry);
  return {
    status: "candidate",
    register: entry.displayName || entry.name,
    aliases: (entry.aliases || []).slice(0, 8),
    offsetAddress: firstValue(entry.offsetAddresses),
    initialValue: firstValue(entry.initialValues),
    accessSize: firstValue(entry.accessSizes),
    page,
    confidence: entry.confidence || null,
    quality: classification.quality,
    qualityScore: classification.score,
    qualityReasons: classification.reasons,
    sourceArtifact: "registers-index",
    evidence: {
      page,
      chunkId: firstChunkId(entry),
      quote: firstEvidenceQuote(entry),
      sourceArtifact: "registers-index",
    },
    note: "Candidate generated from index artifacts; verify against original manual before changing status to verified.",
  };
}

function bitfieldCandidateFromEntry(entry, classification) {
  const page = firstPage(entry);
  return {
    status: "candidate",
    register: entry.register,
    bitfield: entry.bitfield,
    bitRange: entry.bitRange,
    bitPositionRange: entry.bitPositionRange || entry.bitRange,
    fieldBitRange: entry.fieldBitRange,
    access: entry.access,
    reset: entry.reset,
    page,
    confidence: entry.confidence || null,
    quality: classification.quality,
    qualityScore: classification.score,
    qualityReasons: classification.reasons,
    sourceArtifact: "bitfields-index",
    evidence: {
      page,
      chunkId: firstChunkId(entry),
      quote: firstEvidenceQuote(entry),
      sourceArtifact: "bitfields-index",
    },
    note: "Candidate generated from index artifacts; verify against original manual before changing status to verified.",
  };
}

function withClassification(entries, classify) {
  return entries
    .map((entry) => ({ entry, classification: classify(entry) }))
    .sort(sortByQualityScore);
}

export async function bootstrapGoldenProfile({
  root = process.cwd(),
  profile = DEFAULT_GOLDEN_PROFILE,
  limitRegisters = 20,
  limitBitfields = 60,
} = {}) {
  const loaded = await loadGoldenProfile(root, profile);
  const data = loaded.profile;
  const artifacts = await loadGoldenArtifacts(root, data.filename);
  const manifestProblems = goldenManifestProblems(artifacts);
  if ((artifacts.missing || []).length || manifestProblems.length) {
    const error = new Error(`Missing or unhealthy core index artifacts. Run index_pdf(filename="${data.filename}", mode="background") first.`);
    error.missingArtifacts = artifacts.missing;
    error.manifestProblems = manifestProblems;
    throw error;
  }

  const existingRegisters = new Set((data.registers || []).map((fact) => normalizeSymbol(fact.register)));
  const existingBitfields = new Set((data.bitfields || []).map((fact) => `${normalizeSymbol(fact.register)}:${normalizeSymbol(fact.bitfield || fact.field || fact.name)}`));
  const classifiedRegisters = withClassification(artifacts.registers, classifyGoldenRegisterCandidate);
  const classifiedBitfields = withClassification(artifacts.bitfields, (entry) => classifyGoldenBitfieldCandidate(entry, { strict: true }));
  const registerCandidates = classifiedRegisters
    .filter(({ entry, classification }) => !existingRegisters.has(normalizeSymbol(entry.displayName || entry.name)) && classification.quality === "high_quality")
    .slice(0, limitRegisters)
    .map(({ entry, classification }) => registerCandidateFromEntry(entry, classification));

  const bitfieldCandidates = classifiedBitfields
    .filter(({ entry, classification }) => !existingBitfields.has(`${normalizeSymbol(entry.register)}:${normalizeSymbol(entry.bitfield)}`) && classification.quality === "high_quality")
    .slice(0, limitBitfields)
    .map(({ entry, classification }) => bitfieldCandidateFromEntry(entry, classification));

  const nextProfile = {
    ...data,
    registers: [...(data.registers || []), ...registerCandidates],
    bitfields: [...(data.bitfields || []), ...bitfieldCandidates],
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(loaded.filePath, `${JSON.stringify(nextProfile, null, 2)}\n`, "utf-8");
  return {
    profilePath: loaded.filePath,
    filename: data.filename,
    added: { registers: registerCandidates.length, bitfields: bitfieldCandidates.length },
    skippedExisting: {
      registers: existingRegisters.size,
      bitfields: existingBitfields.size,
    },
    candidateQuality: {
      registers: qualityCounts(classifiedRegisters),
      bitfields: qualityCounts(classifiedBitfields),
    },
  };
}

function reviewItemFromRegister(entry, classification, filename) {
  const candidate = registerCandidateFromEntry(entry, classification);
  const page = candidate.page;
  return {
    ...candidate,
    suggestedVerificationCalls: [
      page ? `read_pdf_pages(filename="${filename}", start_page=${page}, end_page=${page})` : `read_pdf_pages(filename="${filename}", start_page=<page>, end_page=<page>)`,
      `find_register(filename="${filename}", register="${candidate.register}")`,
      page ? `extract_register_table(filename="${filename}", page=${page})` : `extract_register_table(filename="${filename}", page=<page>)`,
    ],
  };
}

function reviewItemFromBitfield(entry, classification, filename) {
  const candidate = bitfieldCandidateFromEntry(entry, classification);
  const page = candidate.page;
  return {
    ...candidate,
    suggestedVerificationCalls: [
      page ? `read_pdf_pages(filename="${filename}", start_page=${page}, end_page=${page})` : `read_pdf_pages(filename="${filename}", start_page=<page>, end_page=<page>)`,
      `extract_bitfield_table(filename="${filename}", register="${candidate.register}")`,
      `hybrid_search_pdf(filename="${filename}", query="${candidate.register} ${candidate.bitfield} ${candidate.bitRange || ""}")`,
    ],
  };
}

function selectQuality(items, quality, limit, mapper) {
  return items
    .filter((item) => item.classification.quality === quality)
    .slice(0, limit)
    .map((item) => mapper(item.entry, item.classification));
}

export async function buildGoldenSeedReport({
  root = process.cwd(),
  profile = DEFAULT_GOLDEN_PROFILE,
  limitRegisters = 12,
  limitBitfields = 20,
} = {}) {
  const loaded = await loadGoldenProfile(root, profile);
  const data = loaded.profile;
  const artifacts = await loadGoldenArtifacts(root, data.filename);
  const manifestProblems = goldenManifestProblems(artifacts);
  const missingArtifacts = artifacts.missing || [];
  const classifiedRegisters = withClassification(artifacts.registers || [], classifyGoldenRegisterCandidate);
  const classifiedBitfields = withClassification(artifacts.bitfields || [], (entry) => classifyGoldenBitfieldCandidate(entry, { strict: true }));
  const verifiedCoverage = {
    registers: (data.registers || []).filter((fact) => fact.status === "verified").length,
    bitfields: (data.bitfields || []).filter((fact) => fact.status === "verified").length,
    candidateRegisters: (data.registers || []).filter((fact) => (fact.status || "candidate") === "candidate").length,
    candidateBitfields: (data.bitfields || []).filter((fact) => (fact.status || "candidate") === "candidate").length,
    rejectedRegisters: (data.registers || []).filter((fact) => fact.status === "rejected").length,
    rejectedBitfields: (data.bitfields || []).filter((fact) => fact.status === "rejected").length,
  };

  const health = missingArtifacts.length || manifestProblems.length || !loaded.validation.ok ? "fail" : "pass";
  return {
    schemaVersion: GOLDEN_SCHEMA_VERSION,
    type: "golden-seed-report",
    profile: data.profile || profile,
    filename: data.filename,
    generatedAt: new Date().toISOString(),
    health,
    validation: loaded.validation,
    missingArtifacts,
    manifestProblems,
    recommendation: health === "fail"
      ? `Run index_pdf(filename="${data.filename}", mode="background") and fix golden schema errors before seed review.`
      : "Review high-quality candidates against manual pages before promoting any fact to verified.",
    verifiedCoverage,
    candidates: {
      registers: {
        counts: qualityCounts(classifiedRegisters),
        high_quality: selectQuality(classifiedRegisters, "high_quality", limitRegisters, (entry, classification) => reviewItemFromRegister(entry, classification, data.filename)),
        needs_manual_review: selectQuality(classifiedRegisters, "needs_manual_review", limitRegisters, (entry, classification) => reviewItemFromRegister(entry, classification, data.filename)),
        rejected_noise: selectQuality(classifiedRegisters, "rejected_noise", Math.min(limitRegisters, 20), (entry, classification) => reviewItemFromRegister(entry, classification, data.filename)),
      },
      bitfields: {
        counts: qualityCounts(classifiedBitfields),
        high_quality: selectQuality(classifiedBitfields, "high_quality", limitBitfields, (entry, classification) => reviewItemFromBitfield(entry, classification, data.filename)),
        needs_manual_review: selectQuality(classifiedBitfields, "needs_manual_review", limitBitfields, (entry, classification) => reviewItemFromBitfield(entry, classification, data.filename)),
        rejected_noise: selectQuality(classifiedBitfields, "rejected_noise", Math.min(limitBitfields, 40), (entry, classification) => reviewItemFromBitfield(entry, classification, data.filename)),
      },
    },
  };
}

function formatCandidateLine(kind, item) {
  if (kind === "register") {
    return `- ${item.register} page=${item.page || "unknown"} offset=${item.offsetAddress || "unknown"} reset=${item.initialValue || "unknown"} access=${item.accessSize || "unknown"} quality=${item.qualityScore || 0}`;
  }
  return `- ${item.register}.${item.bitfield} page=${item.page || "unknown"} bitPosition=${item.bitPositionRange || item.bitRange || "unknown"} fieldBits=${item.fieldBitRange || "unknown"} access=${item.access || "unknown"} reset=${item.reset || "unknown"} quality=${item.qualityScore || 0}`;
}

function appendCandidateSection(lines, title, kind, items) {
  lines.push(title);
  if (!items.length) {
    lines.push("- none");
    lines.push("");
    return;
  }
  for (const item of items) {
    lines.push(formatCandidateLine(kind, item));
    if (item.qualityReasons?.length) lines.push(`  reasons: ${item.qualityReasons.join("; ")}`);
    if (item.evidence?.quote) lines.push(`  evidence: ${item.evidence.quote}`);
    if (item.suggestedVerificationCalls?.length) lines.push(`  suggested: ${item.suggestedVerificationCalls.join(" | ")}`);
  }
  lines.push("");
}

export function formatGoldenSeedReport(report) {
  const lines = [
    "Golden Seed Report",
    `Profile: ${report.profile}`,
    `File: ${report.filename}`,
    `Health: ${String(report.health || "unknown").toUpperCase()}`,
    `Verified coverage: registers=${report.verifiedCoverage?.registers || 0}, bitfields=${report.verifiedCoverage?.bitfields || 0}`,
    `Profile candidates: registers=${report.verifiedCoverage?.candidateRegisters || 0}, bitfields=${report.verifiedCoverage?.candidateBitfields || 0}`,
    `Profile rejected: registers=${report.verifiedCoverage?.rejectedRegisters || 0}, bitfields=${report.verifiedCoverage?.rejectedBitfields || 0}`,
    `Register candidate quality: high_quality=${report.candidates?.registers?.counts?.high_quality || 0}, needs_manual_review=${report.candidates?.registers?.counts?.needs_manual_review || 0}, rejected_noise=${report.candidates?.registers?.counts?.rejected_noise || 0}`,
    `Bitfield candidate quality: high_quality=${report.candidates?.bitfields?.counts?.high_quality || 0}, needs_manual_review=${report.candidates?.bitfields?.counts?.needs_manual_review || 0}, rejected_noise=${report.candidates?.bitfields?.counts?.rejected_noise || 0}`,
    "",
  ];
  if (report.recommendation) lines.push(`Recommendation: ${report.recommendation}`, "");
  if ((report.missingArtifacts || []).length) {
    lines.push("Missing artifacts:");
    for (const item of report.missingArtifacts) lines.push(`- ${item}`);
    lines.push("");
  }
  if ((report.manifestProblems || []).length) {
    lines.push("Manifest problems:");
    for (const item of report.manifestProblems) lines.push(`- ${item}`);
    lines.push("");
  }
  appendCandidateSection(lines, "High-quality register candidates:", "register", report.candidates?.registers?.high_quality || []);
  appendCandidateSection(lines, "Register candidates needing manual review:", "register", report.candidates?.registers?.needs_manual_review || []);
  appendCandidateSection(lines, "Rejected/noise register examples:", "register", report.candidates?.registers?.rejected_noise || []);
  appendCandidateSection(lines, "High-quality bitfield candidates:", "bitfield", report.candidates?.bitfields?.high_quality || []);
  appendCandidateSection(lines, "Bitfield candidates needing manual review:", "bitfield", report.candidates?.bitfields?.needs_manual_review || []);
  appendCandidateSection(lines, "Rejected/noise bitfield examples:", "bitfield", report.candidates?.bitfields?.rejected_noise || []);
  lines.push("Machine summary JSON:");
  lines.push(JSON.stringify({
    health: report.health,
    verifiedCoverage: report.verifiedCoverage,
    registerCandidateQuality: report.candidates?.registers?.counts || {},
    bitfieldCandidateQuality: report.candidates?.bitfields?.counts || {},
    missingArtifacts: report.missingArtifacts || [],
    manifestProblems: report.manifestProblems || [],
  }, null, 2));
  return lines.join("\n");
}

export function formatGoldenReport(report) {
  const lines = [
    "Golden Accuracy Report",
    `Profile: ${report.profile}`,
    `File: ${report.filename}`,
    `Health: ${String(report.health || "unknown").toUpperCase()}`,
    `Strict verified only: ${report.strictVerifiedOnly !== false ? "yes" : "no"}`,
    `Summary: total=${report.summary?.total || 0}, pass=${report.summary?.pass || 0}, fail=${report.summary?.fail || 0}, warn=${report.summary?.warn || 0}, verified=${report.summary?.verified || 0}, candidate=${report.summary?.candidate || 0}, rejected=${report.summary?.rejected || 0}`,
    `Verified coverage: registers=${(report.results || []).filter((result) => result.kind === "register" && result.status === "verified").length}, bitfields=${(report.results || []).filter((result) => result.kind === "bitfield" && result.status === "verified").length}, tables=${(report.results || []).filter((result) => result.kind === "table" && result.status === "verified").length}, sequences=${(report.results || []).filter((result) => result.kind === "sequence" && result.status === "verified").length}`,
    `Accuracy metrics: stitchedTables=${report.accuracyMetrics?.stitchedTables || 0}, validBitfields=${report.accuracyMetrics?.validBitfields || 0}, conflictingBitfields=${report.accuracyMetrics?.conflictingBitfields || 0}, structuredSequences=${report.accuracyMetrics?.structuredSequences || 0}`,
    "",
  ];
  if (report.recommendation) lines.push(`Recommendation: ${report.recommendation}`, "");
  if ((report.missingArtifacts || []).length) {
    lines.push("Missing artifacts:");
    for (const item of report.missingArtifacts) lines.push(`- ${item}`);
    lines.push("");
  }
  if ((report.manifestProblems || []).length) {
    lines.push("Manifest problems:");
    for (const item of report.manifestProblems) lines.push(`- ${item}`);
    lines.push("");
  }
  if (report.validation?.errors?.length) {
    lines.push("Validation errors:");
    for (const item of report.validation.errors) lines.push(`- ${item}`);
    lines.push("");
  }
  if (report.validation?.warnings?.length) {
    lines.push("Validation warnings:");
    for (const item of report.validation.warnings) lines.push(`- ${item}`);
    lines.push("");
  }
  for (const result of report.results || []) {
    if (result.pass && !result.warnings.length) continue;
    lines.push(`- [${result.pass ? "WARN" : "FAIL"}] ${result.kind}:${result.id} status=${result.status}`);
    for (const failure of result.failures || []) lines.push(`  failure: ${failure}`);
    for (const warning of result.warnings || []) lines.push(`  warning: ${warning}`);
  }
  lines.push("", "Machine summary JSON:");
  lines.push(JSON.stringify({
    health: report.health,
    summary: report.summary,
    missingArtifacts: report.missingArtifacts || [],
    manifestProblems: report.manifestProblems || [],
    accuracyMetrics: report.accuracyMetrics || {},
    failures: (report.results || []).filter((result) => !result.pass).map((result) => ({ kind: result.kind, id: result.id, failures: result.failures })),
    warnings: (report.results || []).filter((result) => result.warnings?.length).map((result) => ({ kind: result.kind, id: result.id, warnings: result.warnings })),
  }, null, 2));
  return lines.join("\n");
}
