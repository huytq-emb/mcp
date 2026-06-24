import {
  atomicWriteFile,
  atomicWriteJson,
  safeHybridQualityReportJsonPath,
  safeHybridQualityReportMarkdownPath,
} from "../core/runtime-helpers.js";
import {
  DEFAULT_GOLDEN_PROFILE,
  loadGoldenProfile,
  matchBitfieldFact,
  matchRegisterFact,
  matchTableFact,
  normalizeBitRange,
  normalizeComparable,
} from "../eval/golden.js";

export const HYBRID_QUALITY_REPORT_SCHEMA_VERSION = 1;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isUnknown(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return !raw || raw === "unknown" || raw === "n/a" || raw === "-";
}

function firstPage(value) {
  const pages = Array.isArray(value?.pages) ? value.pages : [value?.page, value?.evidence?.page];
  return pages.map(Number).find((page) => Number.isFinite(page) && page > 0) || null;
}

function normalizeExpected(value, normalize = normalizeComparable) {
  return normalize(value ?? "");
}

function actualValues(value) {
  return Array.isArray(value) ? value : [value];
}

function compareExpected(label, expected, actual, normalize = normalizeComparable) {
  if (expected === undefined || expected === null || isUnknown(expected)) return null;
  const expectedValue = normalizeExpected(expected, normalize);
  const ok = actualValues(actual).some((value) => normalizeExpected(value, normalize) === expectedValue);
  return ok ? null : `${label} mismatch: expected ${expected}, got ${actualValues(actual).filter(Boolean).join(" | ") || "missing"}`;
}

function comparePage(fact, actual) {
  const expected = Number(fact.page || fact.evidence?.page || (Array.isArray(fact.pages) ? fact.pages[0] : 0));
  if (!Number.isFinite(expected) || expected <= 0) return null;
  const pages = Array.isArray(actual?.pages) ? actual.pages.map(Number) : [firstPage(actual)].filter(Boolean);
  return pages.includes(expected) ? null : `page mismatch: expected ${expected}, got ${pages.join(", ") || "missing"}`;
}

function makeCheck(name, status = "pass", details = {}) {
  return {
    name,
    status,
    errors: details.errors || [],
    warnings: details.warnings || [],
    summary: details.summary || {},
  };
}

function countStatus(checks, status) {
  return checks.filter((check) => check.status === status).length;
}

function artifactArray(value, key) {
  return asArray(value?.[key]);
}

export function validateHybridArtifactSemantics(values = {}) {
  const checks = [];
  const tables = artifactArray(values.tables, "tables");
  const registers = artifactArray(values.registers, "registers");
  const bitfields = artifactArray(values.bitfields, "bitfields");
  const cautions = artifactArray(values.cautions, "cautions");

  const countChecks = [
    ["tables", values.tables, "tableCount", tables.length],
    ["registers", values.registers, "registerCount", registers.length],
    ["bitfields", values.bitfields, "bitfieldCount", bitfields.length],
    ["cautions", values.cautions, "cautionCount", cautions.length],
  ];
  const countErrors = [];
  for (const [name, artifact, countKey, actual] of countChecks) {
    if (!artifact || typeof artifact !== "object") countErrors.push(`${name} artifact missing`);
    else if (Number(artifact[countKey]) !== actual) countErrors.push(`${name} ${countKey}=${artifact[countKey]} but array length=${actual}`);
  }
  checks.push(makeCheck("artifact counts", countErrors.length ? "fail" : "pass", { errors: countErrors }));

  const tableErrors = [];
  const tableWarnings = [];
  if (!tables.length) tableErrors.push("no table candidates");
  for (const table of tables.slice(0, 30)) {
    if (!table.tableId) tableErrors.push("table missing tableId");
    if (!Number(table.page || table.pageStart)) tableErrors.push(`${table.tableId || "table"} missing page/pageStart`);
    if (!Array.isArray(table.rows)) tableErrors.push(`${table.tableId || "table"} rows must be an array`);
    if (!Array.isArray(table.layout?.columnRoles)) tableWarnings.push(`${table.tableId || "table"} missing layout column roles`);
    for (const row of asArray(table.rows).slice(0, 8)) {
      if (!row.rowId) tableErrors.push(`${table.tableId || "table"} row missing rowId`);
      if (!Array.isArray(row.cells)) tableErrors.push(`${table.tableId || "table"} row cells must be an array`);
      if (!Array.isArray(row.cellBboxes)) tableWarnings.push(`${table.tableId || "table"} row missing cellBboxes`);
      if (!Number(row.sourcePage || table.page)) tableErrors.push(`${table.tableId || "table"} row missing source page`);
    }
  }
  checks.push(makeCheck("table semantics", tableErrors.length ? "fail" : tableWarnings.length ? "warn" : "pass", {
    errors: [...new Set(tableErrors)].slice(0, 12),
    warnings: [...new Set(tableWarnings)].slice(0, 12),
    summary: { tables: tables.length },
  }));

  const registerErrors = [];
  const registerWarnings = [];
  if (!registers.length) registerErrors.push("no register candidates");
  for (const register of registers.slice(0, 40)) {
    if (!(register.name || register.displayName || register.canonicalName)) registerErrors.push("register missing name");
    if (!firstPage(register)) registerWarnings.push(`${register.name || "register"} missing page evidence`);
  }
  const registersWithOffset = registers.filter((entry) => asArray(entry.offsetAddresses).some((value) => !isUnknown(value))).length;
  if (registers.length && registersWithOffset / registers.length < 0.25) registerWarnings.push("fewer than 25% of registers have offset evidence");
  checks.push(makeCheck("register semantics", registerErrors.length ? "fail" : registerWarnings.length ? "warn" : "pass", {
    errors: [...new Set(registerErrors)].slice(0, 12),
    warnings: [...new Set(registerWarnings)].slice(0, 12),
    summary: { registers: registers.length, withOffset: registersWithOffset },
  }));

  const bitfieldErrors = [];
  const bitfieldWarnings = [];
  if (!bitfields.length) bitfieldErrors.push("no bitfield candidates");
  for (const bitfield of bitfields.slice(0, 60)) {
    if (!(bitfield.bitfield || bitfield.name || bitfield.canonicalBitfield)) bitfieldErrors.push("bitfield missing name");
    if (!(bitfield.register || bitfield.sourceRegister || bitfield.canonicalRegister)) bitfieldErrors.push(`${bitfield.bitfield || "bitfield"} missing register`);
    if (isUnknown(bitfield.bitPositionRange || bitfield.bitRange)) bitfieldErrors.push(`${bitfield.register || "?"}.${bitfield.bitfield || "?"} missing bit position`);
    if (!firstPage(bitfield)) bitfieldWarnings.push(`${bitfield.register || "?"}.${bitfield.bitfield || "?"} missing page evidence`);
    if (bitfield.mappingStatus === "unresolved") bitfieldWarnings.push(`${bitfield.register || "?"}.${bitfield.bitfield || "?"} unresolved mapping`);
  }
  checks.push(makeCheck("bitfield semantics", bitfieldErrors.length ? "fail" : bitfieldWarnings.length ? "warn" : "pass", {
    errors: [...new Set(bitfieldErrors)].slice(0, 12),
    warnings: [...new Set(bitfieldWarnings)].slice(0, 12),
    summary: { bitfields: bitfields.length },
  }));

  const cautionWarnings = [];
  if (!cautions.length) cautionWarnings.push("no caution candidates");
  for (const caution of cautions.slice(0, 30)) {
    if (!caution.id) cautionWarnings.push("caution missing id");
    if (!Number(caution.page)) cautionWarnings.push(`${caution.id || "caution"} missing page`);
    if (!caution.type) cautionWarnings.push(`${caution.id || "caution"} missing type classification`);
  }
  checks.push(makeCheck("caution semantics", cautionWarnings.length ? "warn" : "pass", {
    warnings: [...new Set(cautionWarnings)].slice(0, 12),
    summary: { cautions: cautions.length },
  }));

  return checks;
}

function evaluateGoldenRegisters(facts, registers) {
  return facts.map((fact) => {
    const actual = matchRegisterFact(fact, registers);
    const failures = [];
    if (!actual) failures.push(`register not found: ${fact.register}`);
    else {
      for (const message of [
        compareExpected("offset", fact.offsetAddress || fact.offset, actual.offsetAddresses),
        compareExpected("initial/reset", fact.initialValue || fact.reset, actual.initialValues),
        compareExpected("accessSize", fact.accessSize, actual.accessSizes),
        comparePage(fact, actual),
      ].filter(Boolean)) failures.push(message);
    }
    return { kind: "register", id: fact.id || fact.register, pass: failures.length === 0, failures };
  });
}

function evaluateGoldenBitfields(facts, bitfields) {
  return facts.map((fact) => {
    const name = fact.bitfield || fact.field || fact.name;
    const actual = matchBitfieldFact(fact, bitfields);
    const failures = [];
    if (!actual) failures.push(`bitfield not found: ${fact.register}.${name}`);
    else {
      for (const message of [
        compareExpected("bitPositionRange", fact.bitPositionRange, actual.bitPositionRange || actual.bitRange, normalizeBitRange),
        compareExpected("fieldBitRange", fact.fieldBitRange, actual.fieldBitRange, normalizeBitRange),
        fact.bitPositionRange === undefined ? compareExpected("bitRange", fact.bitRange || fact.bits, actual.bitRange || actual.bitPositionRange, normalizeBitRange) : null,
        compareExpected("access", fact.access, actual.access),
        compareExpected("reset", fact.reset || fact.initialValue, actual.reset),
        comparePage(fact, actual),
      ].filter(Boolean)) failures.push(message);
    }
    return { kind: "bitfield", id: fact.id || `${fact.register}.${name}`, pass: failures.length === 0, failures };
  });
}

function evaluateGoldenTables(facts, tables) {
  return facts.map((fact) => {
    const actual = matchTableFact(fact, tables);
    const failures = [];
    if (!actual) failures.push(`table not found: ${fact.kind}`);
    else {
      const start = Number(actual.pageStart || actual.page || 0);
      const end = Number(actual.pageEnd || actual.page || start);
      const expectedStart = Number(fact.pageStart || fact.page || fact.evidence?.page || 0);
      const expectedEnd = Number(fact.pageEnd || expectedStart || 0);
      if (expectedStart && start !== expectedStart) failures.push(`pageStart mismatch: expected ${expectedStart}, got ${start}`);
      if (expectedEnd && end !== expectedEnd) failures.push(`pageEnd mismatch: expected ${expectedEnd}, got ${end}`);
      if (fact.minRows && Number(actual.rowCount || actual.rows?.length || 0) < Number(fact.minRows)) failures.push(`row count below ${fact.minRows}`);
      const roles = new Set(asArray(actual.layout?.columnRoles).map((column) => column.role));
      for (const role of fact.requiredRoles || []) if (!roles.has(role)) failures.push(`missing column role: ${role}`);
    }
    return { kind: "table", id: fact.id || `${fact.kind}:${fact.pageStart || fact.page || "unknown"}`, pass: failures.length === 0, failures };
  });
}

export async function evaluateHybridGoldenGate(filename, values = {}, options = {}) {
  const profileName = options.goldenProfile || DEFAULT_GOLDEN_PROFILE;
  const loaded = await loadGoldenProfile(process.cwd(), profileName);
  const data = loaded.profile;
  if (data.filename !== filename) {
    return makeCheck("verified golden facts", "pass", {
      summary: { skipped: true, reason: `profile filename ${data.filename} does not match ${filename}` },
    });
  }
  if (!loaded.validation.ok) {
    return makeCheck("verified golden facts", "fail", { errors: loaded.validation.errors });
  }
  const verifiedRegisters = asArray(data.registers).filter((fact) => fact.status === "verified");
  const verifiedBitfields = asArray(data.bitfields).filter((fact) => fact.status === "verified");
  const verifiedTables = asArray(data.tables).filter((fact) => fact.status === "verified");
  const results = [
    ...evaluateGoldenRegisters(verifiedRegisters, artifactArray(values.registers, "registers")),
    ...evaluateGoldenBitfields(verifiedBitfields, artifactArray(values.bitfields, "bitfields")),
    ...evaluateGoldenTables(verifiedTables, artifactArray(values.tables, "tables")),
  ];
  const failures = results.filter((result) => !result.pass);
  return makeCheck("verified golden facts", failures.length ? "fail" : "pass", {
    errors: failures.flatMap((result) => result.failures.map((failure) => `${result.id}: ${failure}`)).slice(0, 20),
    summary: {
      profile: data.profile || profileName,
      verifiedRegisters: verifiedRegisters.length,
      verifiedBitfields: verifiedBitfields.length,
      verifiedTables: verifiedTables.length,
      pass: results.length - failures.length,
      fail: failures.length,
    },
  });
}

export function createHybridQualityReport({ filename, operation, requestId, worker, descriptors = [], checks = [] } = {}) {
  const fail = countStatus(checks, "fail");
  const warn = countStatus(checks, "warn");
  return {
    schemaVersion: HYBRID_QUALITY_REPORT_SCHEMA_VERSION,
    type: "hybrid-python-quality-report",
    filename,
    operation,
    requestId,
    generatedAt: new Date().toISOString(),
    engine: "python",
    health: fail ? "fail" : warn ? "warn" : "pass",
    decision: fail ? "reject" : "promote",
    summary: {
      pass: countStatus(checks, "pass"),
      warn,
      fail,
    },
    worker: worker ? {
      durationMs: worker.durationMs || null,
      interpreter: worker.interpreter?.command || "",
      workerVersion: worker.events?.find?.((event) => event.workerVersion)?.workerVersion || "unknown",
    } : null,
    artifacts: descriptors.map((entry) => ({
      kind: entry.kind,
      schemaVersion: entry.schemaVersion,
      count: entry.count,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    })),
    checks,
  };
}

export function formatHybridQualityReport(report) {
  const lines = [
    `# Hybrid Python Quality Report`,
    "",
    `Filename: ${report.filename}`,
    `Operation: ${report.operation}`,
    `Generated: ${report.generatedAt}`,
    `Health: ${String(report.health || "unknown").toUpperCase()}`,
    `Decision: ${report.decision}`,
    `Summary: pass=${report.summary?.pass || 0}, warn=${report.summary?.warn || 0}, fail=${report.summary?.fail || 0}`,
    "",
    "## Checks",
  ];
  for (const check of report.checks || []) {
    lines.push(`- ${check.name}: ${check.status}`);
    for (const error of check.errors || []) lines.push(`  - error: ${error}`);
    for (const warning of check.warnings || []) lines.push(`  - warning: ${warning}`);
  }
  lines.push("", "## Artifacts");
  for (const artifact of report.artifacts || []) {
    lines.push(`- ${artifact.kind}: schema=${artifact.schemaVersion}, count=${artifact.count}, size=${artifact.sizeBytes}`);
  }
  lines.push("", "Machine summary JSON:");
  lines.push(JSON.stringify({
    schemaVersion: report.schemaVersion,
    filename: report.filename,
    operation: report.operation,
    health: report.health,
    decision: report.decision,
    summary: report.summary,
  }, null, 2));
  return lines.join("\n");
}

export async function writeHybridQualityReport(report) {
  const jsonPath = safeHybridQualityReportJsonPath(report.filename);
  const markdownPath = safeHybridQualityReportMarkdownPath(report.filename);
  await atomicWriteJson(jsonPath, report);
  await atomicWriteFile(markdownPath, `${formatHybridQualityReport(report)}\n`);
  return { jsonPath, markdownPath };
}

export async function validateHybridStructuredQuality({ filename, values, descriptors, worker, operation = "structured.build", requestId = "" } = {}) {
  const checks = validateHybridArtifactSemantics(values);
  checks.push(await evaluateHybridGoldenGate(filename, values));
  const report = createHybridQualityReport({
    filename,
    operation,
    requestId,
    worker,
    descriptors,
    checks,
  });
  const paths = await writeHybridQualityReport(report);
  return { report, paths };
}
