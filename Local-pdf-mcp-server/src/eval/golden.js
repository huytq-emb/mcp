import fs from "fs/promises";
import path from "path";
import { ensureDirectPdfFilename, ensureInsideRoot } from "../core/path-safety.js";

export const GOLDEN_SCHEMA_VERSION = 1;
export const DEFAULT_GOLDEN_PROFILE = "rzg3e-core";
export const GOLDEN_STATUSES = new Set(["candidate", "verified", "rejected"]);

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

  for (const [kind, facts] of [["register", profile?.registers || []], ["bitfield", profile?.bitfields || []]]) {
    for (const [index, fact] of facts.entries()) {
      const status = fact.status || "candidate";
      if (!GOLDEN_STATUSES.has(status)) errors.push(`${kind}[${index}] invalid status: ${status}`);
      if (kind === "register" && !fact.register) errors.push(`register[${index}] missing register`);
      if (kind === "bitfield" && (!fact.register || !(fact.bitfield || fact.field || fact.name))) {
        errors.push(`bitfield[${index}] missing register or bitfield`);
      }
      if (status === "verified" && !(fact.evidence?.page || fact.page || fact.pages?.length)) {
        warnings.push(`${kind}[${index}] verified fact has no evidence page`);
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
  const missing = [];

  let registersIndex = null;
  let bitfieldsIndex = null;
  let manifest = null;

  if (await pathExists(registersPath)) registersIndex = JSON.parse(await fs.readFile(registersPath, "utf-8"));
  else missing.push(registersPath);

  if (await pathExists(bitfieldsPath)) bitfieldsIndex = JSON.parse(await fs.readFile(bitfieldsPath, "utf-8"));
  else missing.push(bitfieldsPath);

  if (await pathExists(manifestPath)) manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  else missing.push(manifestPath);

  return {
    filename,
    registersPath,
    bitfieldsPath,
    manifestPath,
    registers: registersIndex?.registers || [],
    bitfields: bitfieldsIndex?.bitfields || [],
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
  const expectedRegister = normalizeSymbol(fact.register);
  const expectedNames = [fact.bitfield, fact.field, fact.name, ...(fact.aliases || [])].map(normalizeSymbol).filter(Boolean);
  let best = null;
  let bestScore = -1;
  for (const entry of bitfields) {
    const entryRegisters = [entry.register, entry.canonicalRegister, entry.displayRegister]
      .map(normalizeSymbol)
      .filter(Boolean);
    const registerMatches = !expectedRegister || entryRegisters.includes(expectedRegister);
    if (expectedRegister && !registerMatches) continue;
    const registerScore = expectedRegister && registerMatches ? 60 : 0;
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
      compareExpectedValue("bitRange", fact.bitRange || fact.bits, actual.bitRange, normalizeBitRange),
      compareExpectedValue("access", fact.access, actual.access),
      compareExpectedValue("reset", fact.reset || fact.initialValue, actual.reset),
      compareExpectedPage(fact, actual.pages),
    ].filter(Boolean)) failures.push(message);
  }
  const strictFact = strict && status === "verified";
  if (!strictFact && failures.length) warnings.push(...failures);
  return { kind: "bitfield", id: fact.id || `${fact.register}.${name}`, status, strict: strictFact, pass: strictFact ? failures.length === 0 : true, failures: strictFact ? failures : [], warnings, fact, actual };
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
  const allFacts = [...(data.registers || []), ...(data.bitfields || [])];
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

  const missingArtifacts = artifacts.missing || [];
  const manifestProblems = goldenManifestProblems(artifacts);
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
      recommendation: `Run start_index_pdf(filename="${data.filename}") and rerun golden eval after job_status is done.`,
    };
  }

  const registerResults = (data.registers || [])
    .filter((fact) => fact.status !== "rejected")
    .map((fact) => evaluateRegisterFact(fact, artifacts, strict));
  const bitfieldResults = (data.bitfields || [])
    .filter((fact) => fact.status !== "rejected")
    .map((fact) => evaluateBitfieldFact(fact, artifacts, strict));
  const results = [...registerResults, ...bitfieldResults];
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
      ? `Run start_index_pdf(filename="${data.filename}") before bootstrapping/evaluating golden facts.`
      : "",
    results,
  };
}

function firstValue(values) {
  return Array.isArray(values) ? values.find(Boolean) || "" : values || "";
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
    const error = new Error(`Missing or unhealthy core index artifacts. Run start_index_pdf(filename="${data.filename}") first.`);
    error.missingArtifacts = artifacts.missing;
    error.manifestProblems = manifestProblems;
    throw error;
  }

  const existingRegisters = new Set((data.registers || []).map((fact) => normalizeSymbol(fact.register)));
  const existingBitfields = new Set((data.bitfields || []).map((fact) => `${normalizeSymbol(fact.register)}:${normalizeSymbol(fact.bitfield || fact.field || fact.name)}`));
  const registerCandidates = artifacts.registers
    .filter((entry) => !existingRegisters.has(normalizeSymbol(entry.displayName || entry.name)))
    .filter((entry) => Number(entry.confidence || 0) >= 50)
    .slice(0, limitRegisters)
    .map((entry) => ({
      status: "candidate",
      register: entry.displayName || entry.name,
      aliases: (entry.aliases || []).slice(0, 8),
      offsetAddress: firstValue(entry.offsetAddresses),
      initialValue: firstValue(entry.initialValues),
      accessSize: firstValue(entry.accessSizes),
      page: (entry.pages || [])[0] || null,
      confidence: entry.confidence || null,
      source: "bootstrap-register-index",
      note: "Candidate generated from index artifacts; verify against original manual before changing status to verified.",
    }));

  const bitfieldCandidates = artifacts.bitfields
    .filter((entry) => !existingBitfields.has(`${normalizeSymbol(entry.register)}:${normalizeSymbol(entry.bitfield)}`))
    .filter((entry) => Number(entry.confidence || 0) >= 50)
    .slice(0, limitBitfields)
    .map((entry) => ({
      status: "candidate",
      register: entry.register,
      bitfield: entry.bitfield,
      bitRange: entry.bitRange,
      access: entry.access,
      reset: entry.reset,
      page: (entry.pages || [])[0] || null,
      confidence: entry.confidence || null,
      source: "bootstrap-bitfield-index",
      note: "Candidate generated from index artifacts; verify against original manual before changing status to verified.",
    }));

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
  };
}

export function formatGoldenReport(report) {
  const lines = [
    "Golden Accuracy Report",
    `Profile: ${report.profile}`,
    `File: ${report.filename}`,
    `Health: ${String(report.health || "unknown").toUpperCase()}`,
    `Strict verified only: ${report.strictVerifiedOnly !== false ? "yes" : "no"}`,
    `Summary: total=${report.summary?.total || 0}, pass=${report.summary?.pass || 0}, fail=${report.summary?.fail || 0}, warn=${report.summary?.warn || 0}, verified=${report.summary?.verified || 0}, candidate=${report.summary?.candidate || 0}, rejected=${report.summary?.rejected || 0}`,
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
    failures: (report.results || []).filter((result) => !result.pass).map((result) => ({ kind: result.kind, id: result.id, failures: result.failures })),
    warnings: (report.results || []).filter((result) => result.warnings?.length).map((result) => ({ kind: result.kind, id: result.id, warnings: result.warnings })),
  }, null, 2));
  return lines.join("\n");
}
