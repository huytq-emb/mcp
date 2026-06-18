import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateGoldenProfile,
  goldenManifestProblems,
  matchBitfieldFact,
  matchRegisterFact,
  normalizeBitRange,
  normalizeSymbol,
  validateGoldenProfile,
} from "../../src/eval/golden.js";

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

test("bitfield fact matching rejects same field on a different register", () => {
  const match = matchBitfieldFact(
    { register: "WDTCR", bitfield: "CKS" },
    [{ register: "OTHER", bitfield: "CKS", bitRange: "[2:0]" }],
  );
  assert.equal(match, null);
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
