import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildGoldenSeedReport,
  classifyGoldenBitfieldCandidate,
  classifyGoldenRegisterCandidate,
  evaluateGoldenProfile,
  goldenManifestProblems,
  matchBitfieldFact,
  matchRegisterFact,
  matchSequenceFact,
  matchTableFact,
  normalizeBitRange,
  normalizeSymbol,
  validateGoldenProfile,
} from "../../src/eval/golden.js";

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

async function createGoldenFixture(profileData, { registers = [], bitfields = [], tables = [], sequences = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "golden-fixture-"));
  const filename = profileData.filename || "manual.pdf";
  await writeJson(path.join(root, "eval", "golden", `${profileData.profile}.json`), profileData);
  await writeJson(path.join(root, "indexes", `${filename}.registers.json`), {
    schemaVersion: 1,
    filename,
    registers,
  });
  await writeJson(path.join(root, "indexes", `${filename}.bitfields.json`), {
    schemaVersion: 1,
    filename,
    bitfields,
  });
  if (tables.length) await writeJson(path.join(root, "indexes", `${filename}.tables.json`), { schemaVersion: 1, filename, tables });
  if (sequences.length) await writeJson(path.join(root, "indexes", `${filename}.sequences.json`), { schemaVersion: 2, filename, sequences });
  await writeJson(path.join(root, "indexes", `${filename}.manifest.json`), {
    schemaVersion: 1,
    filename,
    health: "ok",
    artifacts: {
      registers: { status: "ok", ok: true },
      bitfields: { status: "ok", ok: true },
      ...(tables.length ? { tables: { status: "ok", ok: true } } : {}),
      ...(sequences.length ? { sequences: { status: "ok", ok: true } } : {}),
    },
  });
  return root;
}

test("golden schema accepts empty verified set", () => {
  const validation = validateGoldenProfile({
    schemaVersion: 1,
    type: "golden-profile",
    profile: "rzg3e-core",
    filename: "r01uh1069ej0115-rzg3e.pdf",
    registers: [],
    bitfields: [],
  });
  assert.equal(validation.ok, true);
});

test("golden schema accepts verified evidence metadata and register aliases", () => {
  const validation = validateGoldenProfile({
    schemaVersion: 1,
    type: "golden-profile",
    profile: "rzg3e-core",
    filename: "r01uh1069ej0115-rzg3e.pdf",
    registers: [{
      status: "verified",
      register: "WDTm_WDTCR",
      offsetAddress: "02h",
      initialValue: "33F3h",
      accessSize: "16",
      evidence: {
        page: 1007,
        chunkId: "r01uh1069ej0115-rzg3e.pdf:p1007:c0",
        quote: "Access Size 16 bits; Address + 02h; Initial Value 33F3h",
        sourceArtifact: "registers-index",
      },
      sourceArtifact: "registers-index+manual-page",
      verifiedBy: "codex",
      verifiedAt: "2026-06-19",
    }],
    bitfields: [{
      status: "verified",
      register: "RSPIm_SPCKD",
      registerAliases: ["RSPIM_BASE"],
      bitfield: "SCKDL",
      bitRange: "2:0",
      bitPositionRange: "2:0",
      fieldBitRange: "2:0",
      access: "R/W",
      reset: "0",
      evidence: {
        page: 2616,
        chunkId: "r01uh1069ej0115-rzg3e.pdf:p2616:c0",
        quote: "2 to 0 SCKDL[2:0] 0h RW",
        sourceArtifact: "bitfields-index",
      },
    }],
  });
  assert.equal(validation.ok, true);
});

test("golden schema rejects bad status", () => {
  const validation = validateGoldenProfile({
    schemaVersion: 1,
    type: "golden-profile",
    profile: "x",
    filename: "manual.pdf",
    registers: [{ status: "maybe", register: "WDTCR" }],
    bitfields: [],
  });
  assert.equal(validation.ok, false);
});

test("register fact matching uses canonical names and aliases", () => {
  const match = matchRegisterFact(
    { register: "WDTCR" },
    [{ name: "WDT Control Register", displayName: "WDTCR", aliases: ["WDT_CR"], offsetAddresses: ["0x10"] }],
  );
  assert.equal(match.displayName, "WDTCR");
  assert.equal(normalizeSymbol("WDT_CR"), "WDTCR");
});

test("bitfield fact matching uses register and bitfield identity", () => {
  const match = matchBitfieldFact(
    { register: "WDTCR", bitfield: "CKS" },
    [{ register: "WDTCR", bitfield: "CKS", bitRange: "[2:0]" }],
  );
  assert.equal(match.bitRange, "[2:0]");
  assert.equal(normalizeBitRange("[2:0]"), "2:0");
});

test("bitfield fact matching can use artifact register aliases", () => {
  const match = matchBitfieldFact(
    { register: "RSPIm_SPCKD", registerAliases: ["RSPIM_BASE"], bitfield: "SCKDL" },
    [{ register: "RSPIM_BASE", bitfield: "SCKDL", bitRange: "2:0" }],
  );
  assert.equal(match.bitRange, "2:0");
});

test("bitfield fact matching rejects same field on a different register", () => {
  const match = matchBitfieldFact(
    { register: "WDTCR", bitfield: "CKS" },
    [{ register: "OTHER", bitfield: "CKS", bitRange: "[2:0]" }],
  );
  assert.equal(match, null);
});

test("golden schema and matchers support table and structured sequence facts", () => {
  const profile = { schemaVersion: 1, type: "golden-profile", profile: "structured", filename: "manual.pdf", registers: [], bitfields: [], tables: [{ status: "candidate", kind: "bitfield-table", pageStart: 10 }], sequences: [{ status: "candidate", topic: "Start operation", steps: [{ operation: "write" }] }] };
  assert.equal(validateGoldenProfile(profile).ok, true);
  assert.equal(matchTableFact(profile.tables[0], [{ kind: "bitfield-table", pageStart: 10, pageEnd: 11 }]).pageEnd, 11);
  assert.equal(matchSequenceFact(profile.sequences[0], [{ topic: "Start Operation", steps: [] }]).topic, "Start Operation");
});

test("verified structured facts fail on table pages and sequence step semantics", async () => {
  const root = await createGoldenFixture({
    schemaVersion: 1,
    type: "golden-profile",
    profile: "bad-structured",
    filename: "manual.pdf",
    registers: [],
    bitfields: [],
    tables: [{ status: "verified", kind: "bitfield-table", pageStart: 10, pageEnd: 12, requiredRoles: ["bit", "access"], evidence: { page: 10 } }],
    sequences: [{ status: "verified", topic: "Start operation", structureStatus: "complete", steps: [{ operation: "write", register: "CTRL", bitfield: "EN", value: "1", page: 10 }], evidence: { page: 10 } }],
  }, {
    tables: [{ kind: "bitfield-table", pageStart: 10, pageEnd: 11, rowCount: 5, layout: { columnRoles: [{ role: "bit" }] } }],
    sequences: [{ topic: "Start operation", structureStatus: "partial", steps: [{ operation: "read", register: "STAT", bitfield: "DONE", value: "0", evidence: { page: 11 } }] }],
  });
  const report = await evaluateGoldenProfile({ root, profile: "bad-structured", strictVerifiedOnly: true });
  assert.equal(report.health, "fail");
  assert.match(report.results.find((result) => result.kind === "table").failures.join("\n"), /pageEnd mismatch|missing column role/);
  assert.match(report.results.find((result) => result.kind === "sequence").failures.join("\n"), /structureStatus mismatch|step 1 operation mismatch|step 1 page mismatch/);
});

test("candidate facts do not fail strict verified-only reports", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "golden-eval-"));
  const report = await evaluateGoldenProfile({
    root,
    profile: "missing-profile",
    strictVerifiedOnly: true,
  });
  assert.equal(report.health, "pass");
});

test("candidate and rejected mismatches do not fail strict verified-only reports", async () => {
  const root = await createGoldenFixture({
    schemaVersion: 1,
    type: "golden-profile",
    profile: "candidate-only",
    filename: "manual.pdf",
    registers: [{ status: "candidate", register: "MISSING", offsetAddress: "10h" }],
    bitfields: [{ status: "rejected", register: "MISSING", bitfield: "RW", bitRange: "1:0" }],
  });
  const report = await evaluateGoldenProfile({ root, profile: "candidate-only", strictVerifiedOnly: true });
  assert.equal(report.health, "pass");
  assert.equal(report.summary.candidate, 1);
  assert.equal(report.summary.rejected, 1);
});

test("verified register mismatches fail on offset reset access size and page", async () => {
  const root = await createGoldenFixture({
    schemaVersion: 1,
    type: "golden-profile",
    profile: "bad-register",
    filename: "manual.pdf",
    registers: [{
      status: "verified",
      register: "WDTCR",
      offsetAddress: "04h",
      initialValue: "0000h",
      accessSize: "8",
      page: 99,
      evidence: { page: 99 },
    }],
    bitfields: [],
  }, {
    registers: [{
      displayName: "WDTCR",
      offsetAddresses: ["02h"],
      initialValues: ["33F3h"],
      accessSizes: ["16"],
      pages: [1007],
    }],
  });
  const report = await evaluateGoldenProfile({ root, profile: "bad-register", strictVerifiedOnly: true });
  assert.equal(report.health, "fail");
  assert.match(report.results[0].failures.join("\n"), /offset mismatch/);
  assert.match(report.results[0].failures.join("\n"), /initial\/reset mismatch/);
  assert.match(report.results[0].failures.join("\n"), /accessSize mismatch/);
  assert.match(report.results[0].failures.join("\n"), /page mismatch/);
});

test("verified bitfield mismatches fail on bit range access reset and page", async () => {
  const root = await createGoldenFixture({
    schemaVersion: 1,
    type: "golden-profile",
    profile: "bad-bitfield",
    filename: "manual.pdf",
    registers: [],
    bitfields: [{
      status: "verified",
      register: "RSPIm_SPCKD",
      registerAliases: ["RSPIM_BASE"],
      bitfield: "SCKDL",
      bitPositionRange: "3:0",
      fieldBitRange: "1:0",
      access: "R",
      reset: "1",
      page: 2617,
      evidence: { page: 2617 },
    }],
  }, {
    bitfields: [{
      register: "RSPIM_BASE",
      bitfield: "SCKDL",
      bitRange: "2:0",
      bitPositionRange: "2:0",
      fieldBitRange: "2:0",
      access: "R/W",
      reset: "0",
      pages: [2616],
    }],
  });
  const report = await evaluateGoldenProfile({ root, profile: "bad-bitfield", strictVerifiedOnly: true });
  assert.equal(report.health, "fail");
  assert.match(report.results[0].failures.join("\n"), /bitPositionRange mismatch/);
  assert.match(report.results[0].failures.join("\n"), /fieldBitRange mismatch/);
  assert.match(report.results[0].failures.join("\n"), /access mismatch/);
  assert.match(report.results[0].failures.join("\n"), /reset mismatch/);
  assert.match(report.results[0].failures.join("\n"), /page mismatch/);
});

test("golden candidate classifiers filter hard noise and unknown ranges", () => {
  assert.equal(classifyGoldenRegisterCandidate({
    displayName: "GLOBAL",
    offsetAddresses: ["00h"],
    initialValues: ["00h"],
    accessSizes: ["8"],
    pages: [1],
  }).quality, "rejected_noise");
  assert.equal(classifyGoldenRegisterCandidate({
    displayName: "RSPIM_BASE",
    offsetAddresses: ["00h"],
    initialValues: ["00h"],
    accessSizes: ["8"],
    pages: [1],
  }).quality, "rejected_noise");
  for (const bitfield of ["RW", "RZ", "G3E", "CPU", "RAM"]) {
    assert.equal(classifyGoldenBitfieldCandidate({
      register: "REG",
      bitfield,
      bitRange: "1:0",
      access: "R/W",
      reset: "0",
      pages: [1],
    }).quality, "rejected_noise");
  }
  assert.notEqual(classifyGoldenBitfieldCandidate({
    register: "REG",
    bitfield: "REAL",
    bitRange: "unknown",
    access: "R/W",
    reset: "0",
    pages: [1],
  }).quality, "high_quality");
});

test("golden seed report includes suggested verification calls", async () => {
  const root = await createGoldenFixture({
    schemaVersion: 1,
    type: "golden-profile",
    profile: "seed-report",
    filename: "manual.pdf",
    registers: [],
    bitfields: [],
  }, {
    registers: [{
      displayName: "WDTCR",
      offsetAddresses: ["02h"],
      initialValues: ["33F3h"],
      accessSizes: ["16"],
      pages: [1007],
      chunks: [{ id: "manual.pdf:p1007:c0", preview: "WDTCR table" }],
      confidence: 90,
    }],
    bitfields: [{
      register: "WDTCR",
      bitfield: "CKS",
      bitRange: "2:0",
      access: "R/W",
      reset: "0",
      pages: [1007],
      evidenceLines: ["2 to 0 CKS[2:0] 0h RW"],
      confidence: 90,
    }],
  });
  const report = await buildGoldenSeedReport({ root, profile: "seed-report", limitRegisters: 1, limitBitfields: 1 });
  assert.equal(report.health, "pass");
  assert.match(report.candidates.registers.high_quality[0].suggestedVerificationCalls.join("\n"), /read_pdf_pages/);
  assert.match(report.candidates.bitfields.high_quality[0].suggestedVerificationCalls.join("\n"), /extract_bitfield_table/);
});

test("golden manifest guard requires register and bitfield artifacts", () => {
  const problems = goldenManifestProblems({
    manifest: {
      health: "ok",
      artifacts: {
        registers: { status: "ok", ok: true },
        bitfields: { status: "missing", ok: false },
      },
    },
  });
  assert.deepEqual(problems, ["bitfields artifact status is missing"]);
});
