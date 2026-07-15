import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deterministicBundleSignature,
  discoverPdfManuals,
  figureSearchArguments,
  parseEmbeddedJson,
  parseJobId,
  parseJobStatus,
  percentile,
  validateBundleForManual,
  validateUnknownQueryBundle,
} from "../../src/eval/all-manual-integration.js";
import { createEvidenceBundleV2 } from "../../src/evidence/contract.js";

test("all-manual discovery is recursive, deterministic, and flags duplicate basenames", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "all-manual-discovery-"));
  try {
    await fs.mkdir(path.join(root, "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "z.pdf"), "z");
    await fs.writeFile(path.join(root, "nested", "a.PDF"), "a");
    await fs.writeFile(path.join(root, "nested", "z.pdf"), "duplicate");
    await fs.writeFile(path.join(root, "ignored.txt"), "ignored");
    const manuals = await discoverPdfManuals(root);
    assert.deepEqual(manuals.map((item) => item.relativePath), ["nested/a.PDF", "nested/z.pdf", "z.pdf"]);
    assert.equal(manuals[0].nested, true);
    assert.equal(manuals[1].duplicateBasename, true);
    assert.equal(manuals[2].duplicateBasename, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("all-manual parsers handle embedded reports, job state, and percentiles", () => {
  const text = 'prefix\nMachine summary JSON:\n{"health":"ok","nested":{"brace":"}"}}\ntrailer';
  assert.deepEqual(parseEmbeddedJson(text), { health: "ok", nested: { brace: "}" } });
  assert.equal(parseJobId("Job ID: rebuild-42\nStatus: queued"), "rebuild-42");
  assert.equal(parseJobStatus("Status: running"), "running");
  assert.equal(percentile([5, 1, 4, 2, 3], 0.95), 5);
});

test("all-manual figure smoke uses the public search_figures limit argument", () => {
  assert.deepEqual(figureSearchArguments("manual.pdf", "clock tree", 10), {
    filename: "manual.pdf",
    query: "clock tree",
    limit: 10,
  });
  assert.equal(Object.hasOwn(figureSearchArguments("manual.pdf", "clock tree"), "top_k"), false);
});

function bundle(page = 1) {
  return createEvidenceBundleV2({
    serverVersion: "unit", tool: "query_manual", filename: "manual.pdf", sourceFingerprint: "unit", input: { query: "REG" }, summary: {},
    facts: [], entities: [], relationships: [], inferences: [], conflicts: [], gaps: [], needsVerification: [], warnings: [], recommendedNextActions: [],
    evidence: [{ id: "e1", kind: "register", statement: "REG", page, chunkId: "manual.pdf:p1:c0", sectionPath: [], boundingBox: [], sourceArtifact: "chunk-index", extractionMethod: "unit", confidence: "medium", verificationStatus: "candidate", relatedEntityIds: [], retrieval: { sourceChannels: ["exact"], reasons: ["exact"], rank: 1, query: "REG" } }],
    pagination: { total: 1, returned: 1, truncated: false, nextCursor: null },
  });
}

test("all-manual evidence validation checks provenance bounds and deterministic ordering", () => {
  const valid = bundle(2);
  assert.deepEqual(validateBundleForManual(valid, { filename: "manual.pdf", pageCount: 3 }), { ok: true, errors: [] });
  assert.equal(deterministicBundleSignature(valid), deterministicBundleSignature(structuredClone(valid)));
  const invalid = bundle(4);
  const validation = validateBundleForManual(invalid, { filename: "manual.pdf", pageCount: 3 });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /out-of-bounds page/);
});

test("unknown-query validation permits marked context but rejects resolved claims", () => {
  assert.equal(validateUnknownQueryBundle({ evidence: [{ id: "context" }], facts: [], entities: [], needsVerification: [{ id: "verify" }] }).ok, true);
  assert.equal(validateUnknownQueryBundle({ evidence: [], facts: [], entities: [], gaps: [{ id: "gap" }] }).ok, true);
  assert.match(validateUnknownQueryBundle({ evidence: [{ id: "context" }], facts: [], entities: [] }).errors[0], /without an explicit uncertainty marker/);
  assert.match(validateUnknownQueryBundle({ facts: [{ id: "false-fact" }], entities: [] }).errors[0], /semantic facts/);
});
