import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createManualMetrics,
  deterministicBundleSignature,
  discoverPdfManuals,
  finalizeManualMetrics,
  figureSearchArguments,
  isPdfListed,
  isTerminalJobStatus,
  paginationDuplicateIds,
  parseEmbeddedJson,
  parseDoctorSummary,
  parseJobId,
  parseJobStatus,
  percentile,
  recordToolLatency,
  requiredStagesExecuted,
  sanitizeIntegrationReport,
  selectPdfManuals,
  sharedProcessIsolationMetadata,
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
  for (const status of ["queued", "running", "done", "failed", "cancelled"]) {
    assert.equal(parseJobStatus(`Job: id\nStatus: ${status}\nFile: manual.pdf`), status);
  }
  assert.equal(parseJobStatus("Status: complete"), "unknown");
  assert.equal(isTerminalJobStatus("running"), false);
  assert.equal(isTerminalJobStatus("unknown"), false);
  for (const status of ["done", "failed", "cancelled"]) assert.equal(isTerminalJobStatus(status), true);
  assert.equal(percentile([5, 1, 4, 2, 3], 0.95), 5);
});

test("all-manual doctor summary validation fails clearly on malformed machine output", () => {
  const valid = 'Machine summary JSON:\n{"health":"ok","reports":[{"filename":"manual.pdf","checks":[]}]}';
  assert.equal(parseDoctorSummary(valid, "manual.pdf").reports[0].filename, "manual.pdf");
  assert.throws(
    () => parseDoctorSummary('Machine summary JSON:\n{"health":', "manual.pdf"),
    /doctor machine summary JSON is malformed/i,
  );
  assert.throws(
    () => parseDoctorSummary('Machine summary JSON:\n{"health":"ok"}', "manual.pdf"),
    /reports must be a non-empty array/i,
  );
  assert.throws(
    () => parseDoctorSummary('Machine summary JSON:\n{"reports":[{"filename":"other.pdf","checks":[]}]}', "manual.pdf"),
    /exactly one report for manual\.pdf/i,
  );
});

test("all-manual filename selection and list matching are exact and non-fallback", () => {
  const manuals = [
    { filename: "manual.pdf", relativePath: "manual.pdf" },
    { filename: "manual.pdf", relativePath: "nested/manual.pdf" },
    { filename: "manual.pdf.backup", relativePath: "manual.pdf.backup" },
    { filename: "other.pdf", relativePath: "other.pdf" },
  ];
  const listed = "Available PDFs:\n\n- manual.pdf.backup\n- other.pdf";
  assert.equal(isPdfListed(listed, "manual.pdf"), false);
  assert.equal(isPdfListed(listed, "other.pdf"), true);
  assert.deepEqual(selectPdfManuals(manuals, ""), manuals);
  assert.throws(() => selectPdfManuals(manuals, "manual.pdf"), /ambiguous/i);
  assert.throws(() => selectPdfManuals(manuals, "missing.pdf"), /was not found/i);
  assert.throws(() => selectPdfManuals(manuals, "nested/other.pdf"), /basename/i);
  assert.deepEqual(selectPdfManuals(manuals, "other.pdf").map((item) => item.filename), ["other.pdf"]);
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
  const reranked = structuredClone(valid);
  reranked.evidence[0].retrieval.rrfScore = 0.125;
  assert.notEqual(deterministicBundleSignature(valid), deterministicBundleSignature(reranked));
  const invalid = bundle(4);
  const validation = validateBundleForManual(invalid, { filename: "manual.pdf", pageCount: 3 });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /out-of-bounds page/);
});

test("all-manual pagination detects stable duplicate evidence and entities", () => {
  assert.deepEqual(
    paginationDuplicateIds(
      { evidence: [{ id: "e1" }], entities: [{ id: "entity-1" }] },
      { evidence: [{ id: "e1" }, { id: "e2" }], entities: [{ id: "entity-1" }, { id: "entity-2" }] },
    ),
    { evidence: ["e1"], entities: ["entity-1"] },
  );
  assert.deepEqual(paginationDuplicateIds({ evidence: [], entities: [] }, { evidence: [], entities: [] }), { evidence: [], entities: [] });
});

test("all-manual metrics classify evidence, control, advanced, figure, and all-tool latency", () => {
  const mb = 1048576;
  const metrics = createManualMetrics({ rss: 100 * mb, heapUsed: 20 * mb });
  for (const [tool, latency] of [
    ["query_manual", 10],
    ["get_manual_entity", 20],
    ["doctor", 100],
    ["mcp_control", 200],
    ["index_pdf", 300],
    ["find_register", 30],
    ["get_figure_image", 40],
  ]) recordToolLatency(metrics, tool, latency);
  finalizeManualMetrics(
    metrics,
    { rss: 115 * mb, heapUsed: 25 * mb },
    { rss: 125 * mb, heapUsed: 30 * mb },
  );

  assert.deepEqual(metrics.evidenceQueryLatenciesMs, [10, 20]);
  assert.deepEqual(metrics.controlLatenciesMs, [100, 200, 300]);
  assert.deepEqual(metrics.advancedToolLatenciesMs, [30]);
  assert.deepEqual(metrics.figureLatenciesMs, [40]);
  assert.deepEqual(metrics.allToolLatenciesMs, [10, 20, 100, 200, 300, 30, 40]);
  assert.equal(metrics.evidenceQueryP50Ms, 10);
  assert.equal(metrics.evidenceQueryP95Ms, 20);
  assert.equal(metrics.allToolP50Ms, 40);
  assert.equal(metrics.allToolP95Ms, 300);
  assert.equal(metrics.processRssBeforeManualMb, 100);
  assert.equal(metrics.processRssAfterManualMb, 115);
  assert.equal(metrics.processPeakRssThroughManualMb, 125);
  assert.equal(metrics.processRssDeltaMb, 15);
  assert.equal(Object.hasOwn(metrics, "queryLatenciesMs"), false);
  assert.equal(Object.hasOwn(metrics, "manualPeakRssMb"), false);
  assert.equal(Object.hasOwn(metrics, "p50QueryMs"), false);
  assert.deepEqual(sharedProcessIsolationMetadata(), {
    model: "shared-process-sequential",
    perManualIsolated: false,
    semantics: "Per-manual RSS and heap fields describe this runner process before, after, and through each manual; retained state from earlier manuals may be included.",
  });
});

test("all-manual pass status requires every required stage to execute", () => {
  const complete = Object.fromEntries([
    "manualValidation", "doctorBefore", "indexing", "doctorAfter", "cacheBefore",
    "evidence", "advanced", "figure", "cacheAfter",
  ].map((stage) => [stage, "pass"]));
  assert.equal(requiredStagesExecuted(complete).ok, true);
  complete.figure = "not_run";
  assert.deepEqual(requiredStagesExecuted(complete), { ok: false, missing: ["figure"] });
});

test("all-manual report sanitization removes local absolute paths and records external omissions", () => {
  const projectRoot = "C:\\Users\\DELL\\repo\\Local-pdf-mcp-server";
  const report = {
    doctor: {
      path: `${projectRoot}\\indexes\\manual.pdf.manifest.json`,
      worker: `${projectRoot}\\.venv\\Scripts\\python.exe`,
    },
    figure: { canonicalImagePath: `${projectRoot}\\indexes\\cache\\figure-images\\page.png` },
    cache: { root: `${projectRoot}\\indexes\\cache` },
    external: "C:\\Users\\someone\\private\\worker.exe",
    error: "worker failed at /home/alice/private/staging/output.json",
    uncommonExternal: "worker config: /etc/renesas-mcp/worker.json",
  };
  const sanitized = sanitizeIntegrationReport(report, { projectRoot });
  assert.equal(sanitized.doctor.path, "indexes/manual.pdf.manifest.json");
  assert.equal(sanitized.doctor.worker, ".venv/Scripts/python.exe");
  assert.equal(sanitized.figure.canonicalImagePath, "indexes/cache/figure-images/page.png");
  assert.equal(sanitized.cache.root, "indexes/cache");
  assert.equal(sanitized.external, "[external path unavailable]");
  assert.match(sanitized.error, /omitted because it contained an external absolute path/i);
  assert.match(sanitized.uncommonExternal, /omitted because it contained an external absolute path/i);
  assert.equal(sanitized.reportWarnings.length, 3);
  const serialized = JSON.stringify(sanitized);
  for (const forbidden of [/C:\\/i, /C:\//i, /Users\//i, /\\Users\\/i, /\/home\//i]) {
    assert.equal(forbidden.test(serialized), false, `report leaked ${forbidden}`);
  }
});

test("unknown-query validation permits marked context but rejects resolved claims", () => {
  assert.equal(validateUnknownQueryBundle({ evidence: [{ id: "context" }], facts: [], entities: [], needsVerification: [{ id: "verify" }] }).ok, true);
  assert.equal(validateUnknownQueryBundle({ evidence: [], facts: [], entities: [], gaps: [{ id: "gap" }] }).ok, true);
  assert.match(validateUnknownQueryBundle({ evidence: [{ id: "context" }], facts: [], entities: [] }).errors[0], /without an explicit uncertainty marker/);
  assert.match(validateUnknownQueryBundle({ facts: [{ id: "false-fact" }], entities: [] }).errors[0], /semantic facts/);
});
