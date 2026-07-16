import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CANCELLATION_CONFIRMATION_DEFAULTS,
  confirmJobCancellation,
  createIndexTimeoutError,
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
  validateCancellationConfirmationOptions,
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

function cancellationHarness(statuses, {
  cancelStatus = "running",
  timeoutMs = 1_000,
  pollMs = 500,
  statusLatencyMs = 0,
  cancellationLatencyMs = 0,
} = {}) {
  const state = { now: 0, cancellationCalls: 0, statusReads: 0, sleeps: [], activeSleeps: 0 };
  const result = confirmJobCancellation({
    cancellationAction: async () => {
      state.cancellationCalls += 1;
      state.now += cancellationLatencyMs;
      return cancelStatus;
    },
    statusReader: async () => {
      const index = Math.min(state.statusReads, statuses.length - 1);
      state.statusReads += 1;
      state.now += statusLatencyMs;
      return statuses[index] ?? "unknown";
    },
    timeoutMs,
    pollMs,
    now: () => state.now,
    sleep: async (delayMs) => {
      state.activeSleeps += 1;
      state.sleeps.push(delayMs);
      state.now += delayMs;
      state.activeSleeps -= 1;
    },
  });
  return { result, state };
}

test("cancellation confirmation polls twice before a job becomes cancelled", async () => {
  const { result, state } = cancellationHarness(["running", "cancelled"]);
  assert.deepEqual(await result, {
    confirmed: true,
    cancelStatus: "running",
    finalStatus: "cancelled",
    confirmationDurationMs: 500,
    polls: 2,
  });
  assert.equal(state.cancellationCalls, 1);
  assert.equal(state.statusReads, 2);
});

test("cancellation confirmation stops when a running job becomes done", async () => {
  const { result } = cancellationHarness(["running", "done"]);
  const confirmation = await result;
  assert.equal(confirmation.confirmed, true);
  assert.equal(confirmation.finalStatus, "done");
  assert.equal(confirmation.polls, 2);
});

test("cancellation confirmation expires while a job remains running", async () => {
  const { result, state } = cancellationHarness(["running"], { pollMs: 400 });
  assert.deepEqual(await result, {
    confirmed: false,
    cancelStatus: "running",
    finalStatus: "running",
    confirmationDurationMs: 1_000,
    polls: 3,
  });
  assert.deepEqual(state.sleeps, [400, 400, 200]);
});

test("cancellation confirmation retries unknown status until its bound", async () => {
  const { result, state } = cancellationHarness(["unknown"], { pollMs: 250 });
  const confirmation = await result;
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.finalStatus, "unknown");
  assert.equal(confirmation.confirmationDurationMs, 1_000);
  assert.equal(state.statusReads, 4);
});

test("cancellation confirmation polling does not exceed the timeout bound", async () => {
  const { result, state } = cancellationHarness(["queued"], { pollMs: 300 });
  const confirmation = await result;
  assert.equal(confirmation.confirmationDurationMs, 1_000);
  assert.ok(state.sleeps.reduce((sum, delayMs) => sum + delayMs, 0) <= 1_000);
  assert.equal(state.now, 1_000);
});

test("cancellation confirmation grace period starts after the cancel action", async () => {
  const { result, state } = cancellationHarness(["running", "cancelled"], { cancellationLatencyMs: 2_000 });
  const confirmation = await result;
  assert.equal(confirmation.confirmationDurationMs, 500);
  assert.equal(state.now, 2_500);
});

test("cancellation confirmation applies the configured polling interval", async () => {
  const { result, state } = cancellationHarness(["running", "running", "cancelled"], { pollMs: 250 });
  await result;
  assert.deepEqual(state.sleeps, [250, 250]);
});

test("cancellation confirmation returns a terminal first status without sleeping", async () => {
  const { result, state } = cancellationHarness(["failed"]);
  const confirmation = await result;
  assert.equal(confirmation.finalStatus, "failed");
  assert.equal(confirmation.polls, 1);
  assert.deepEqual(state.sleeps, []);
});

test("cancellation confirmation records the final status and measured duration", async () => {
  const { result } = cancellationHarness(["running", "done"], { statusLatencyMs: 120 });
  const confirmation = await result;
  assert.equal(confirmation.finalStatus, "done");
  assert.equal(confirmation.confirmationDurationMs, 740);
});

test("index timeout errors preserve timeout semantics and cancellation outcomes", () => {
  const cancelled = createIndexTimeoutError({
    jobId: "job-1",
    indexingTimeoutMs: 7_200_000,
    confirmationTimeoutMs: 30_000,
    confirmation: { confirmed: true, finalStatus: "cancelled", confirmationDurationMs: 1_240 },
  });
  assert.equal(cancelled.code, "INDEX_TIMEOUT");
  assert.match(cancelled.message, /exceeded 7200000 ms/);
  assert.match(cancelled.message, /confirmed after 1240 ms with terminal status cancelled/);

  const done = createIndexTimeoutError({
    jobId: "job-2",
    indexingTimeoutMs: 7_200_000,
    confirmationTimeoutMs: 30_000,
    confirmation: { confirmed: true, finalStatus: "done", confirmationDurationMs: 500 },
  });
  assert.equal(done.code, "INDEX_TIMEOUT");
  assert.match(done.message, /terminal state was confirmed after 500 ms with status done/i);
  assert.match(done.message, /did not finish as cancelled/i);

  const unconfirmed = createIndexTimeoutError({
    jobId: "job-3",
    indexingTimeoutMs: 7_200_000,
    confirmationTimeoutMs: 30_000,
    confirmation: { confirmed: false, finalStatus: "running", confirmationDurationMs: 30_000 },
  });
  assert.equal(unconfirmed.code, "INDEX_TIMEOUT");
  assert.match(unconfirmed.message, /not confirmed within 30000 ms; last status was running/i);
});

test("cancellation confirmation leaves no asynchronous sleep active", async () => {
  const { result, state } = cancellationHarness(["running", "cancelled"]);
  await result;
  assert.equal(state.activeSleeps, 0);
});

test("cancellation confirmation defaults and bounds match the CLI contract", () => {
  assert.deepEqual(CANCELLATION_CONFIRMATION_DEFAULTS, { timeoutMs: 30_000, pollMs: 500 });
  assert.deepEqual(validateCancellationConfirmationOptions(), CANCELLATION_CONFIRMATION_DEFAULTS);
  assert.throws(() => validateCancellationConfirmationOptions({ timeoutMs: 999, pollMs: 100 }), /at least 1000/);
  assert.throws(() => validateCancellationConfirmationOptions({ timeoutMs: 1_000, pollMs: 99 }), /at least 100/);
  assert.throws(() => validateCancellationConfirmationOptions({ timeoutMs: 1_000, pollMs: 1_001 }), /must not exceed/);
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

const WINDOWS_PROJECT_ROOT = "C:\\repo\\mcp\\Local-pdf-mcp-server";

test("report sanitization makes Windows project paths relative", () => {
  const sanitized = sanitizeIntegrationReport({
    reportPath: `${WINDOWS_PROJECT_ROOT}\\indexes\\manual.json`,
    cacheDirectory: `${WINDOWS_PROJECT_ROOT}\\..cache\\manual`,
    message: `Wrote ${WINDOWS_PROJECT_ROOT}\\indexes\\manual.md successfully`,
  }, { projectRoot: WINDOWS_PROJECT_ROOT });
  assert.equal(sanitized.reportPath, "indexes/manual.json");
  assert.equal(sanitized.cacheDirectory, "..cache/manual");
  assert.equal(sanitized.message, "Wrote indexes/manual.md successfully");
});

test("report sanitization replaces an external Windows path field", () => {
  const sanitized = sanitizeIntegrationReport({ workerPath: "C:\\Users\\alice\\worker.exe" }, { projectRoot: WINDOWS_PROJECT_ROOT });
  assert.equal(sanitized.workerPath, "[external-path]");
});

test("report sanitization preserves a message around an external Windows path", () => {
  const sanitized = sanitizeIntegrationReport({
    error: "ENOENT while reading C:\\Users\\alice\\indexes\\manual.json",
  }, { projectRoot: WINDOWS_PROJECT_ROOT });
  assert.equal(sanitized.error, "ENOENT while reading [external-path]");
});

test("report sanitization replaces two Windows paths in one message", () => {
  const sanitized = sanitizeIntegrationReport({
    error: "Copy C:\\temp\\a.json to D:\\cache\\b.json failed",
  }, { projectRoot: WINDOWS_PROJECT_ROOT });
  assert.equal(sanitized.error, "Copy [external-path] to [external-path] failed");
});

test("report sanitization makes POSIX project paths relative", () => {
  const projectRoot = "/repo/mcp/Local-pdf-mcp-server";
  const sanitized = sanitizeIntegrationReport({
    artifactPath: `${projectRoot}/indexes/manual.json`,
    message: `Wrote ${projectRoot}/indexes/manual.md`,
  }, { projectRoot });
  assert.equal(sanitized.artifactPath, "indexes/manual.json");
  assert.equal(sanitized.message, "Wrote indexes/manual.md");
});

test("report sanitization replaces known external POSIX roots token by token", () => {
  const sanitized = sanitizeIntegrationReport({
    errors: [
      "ENOENT at /home/alice/cache/a.json",
      "EACCES at /tmp/worker.json",
      "EPERM at /var/tmp/staging/file.json",
      "Failed to read /etc/renesas/worker.json",
    ],
  }, { projectRoot: WINDOWS_PROJECT_ROOT });
  assert.deepEqual(sanitized.errors, [
    "ENOENT at [external-path]",
    "EACCES at [external-path]",
    "EPERM at [external-path]",
    "Failed to read [external-path]",
  ]);
});

test("report sanitization replaces UNC paths", () => {
  const sanitized = sanitizeIntegrationReport({
    error: "EACCES while reading \\\\server\\share\\private\\worker.json",
  }, { projectRoot: WINDOWS_PROJECT_ROOT });
  assert.equal(sanitized.error, "EACCES while reading [external-path]");
});

test("report sanitization preserves hardware signals and error codes", () => {
  const sanitized = sanitizeIntegrationReport({
    message: "/RESET /CS /IRQ /RD /WR remain hardware signals",
    errors: [
      "ENOENT at C:\\private\\a.json",
      "EACCES at /tmp/b.json",
      "EPERM at \\\\server\\share\\c.json",
    ],
  }, { projectRoot: WINDOWS_PROJECT_ROOT });
  assert.equal(sanitized.message, "/RESET /CS /IRQ /RD /WR remain hardware signals");
  assert.match(sanitized.errors.join(" "), /ENOENT/);
  assert.match(sanitized.errors.join(" "), /EACCES/);
  assert.match(sanitized.errors.join(" "), /EPERM/);
});

test("report sanitization traverses nested arrays and objects without leaking usernames", () => {
  const sanitized = sanitizeIntegrationReport({
    nested: [{ detail: { error: "Failed C:\\Users\\private-user\\cache\\x.json and /home/secret-user/y.json" } }],
  }, { projectRoot: WINDOWS_PROJECT_ROOT });
  assert.equal(sanitized.nested[0].detail.error, "Failed [external-path] and [external-path]");
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /private-user|secret-user|C:\\Users|\/home\//i);
});

test("report sanitization is idempotent and preserves project-relative paths", () => {
  const once = sanitizeIntegrationReport({
    artifactPath: "indexes/manual.json",
    error: "ENOENT at C:\\Users\\alice\\manual.json",
  }, { projectRoot: WINDOWS_PROJECT_ROOT });
  const twice = sanitizeIntegrationReport(once, { projectRoot: WINDOWS_PROJECT_ROOT });
  assert.deepEqual(twice, once);
  assert.equal(twice.artifactPath, "indexes/manual.json");
});

test("report sanitization preserves web URLs and explicitly sanitizes local file URLs", () => {
  const sanitized = sanitizeIntegrationReport({
    message: "See https://example.com/tmp/manual and file:///C:/Users/alice/manual.json",
    projectFileUrl: "file:///C:/repo/mcp/Local-pdf-mcp-server/indexes/manual.json",
  }, { projectRoot: WINDOWS_PROJECT_ROOT });
  assert.equal(sanitized.message, "See https://example.com/tmp/manual and [external-path]");
  assert.equal(sanitized.projectFileUrl, "indexes/manual.json");
});

test("report sanitization does not alter extracted manual evidence text", () => {
  const report = { evidence: [{ statement: "The /RESET signal is unrelated to /home/user/example." }] };
  const sanitized = sanitizeIntegrationReport(report, { projectRoot: WINDOWS_PROJECT_ROOT });
  assert.equal(sanitized.evidence[0].statement, report.evidence[0].statement);
});

test("unknown-query validation permits marked context but rejects resolved claims", () => {
  assert.equal(validateUnknownQueryBundle({ evidence: [{ id: "context" }], facts: [], entities: [], needsVerification: [{ id: "verify" }] }).ok, true);
  assert.equal(validateUnknownQueryBundle({ evidence: [], facts: [], entities: [], gaps: [{ id: "gap" }] }).ok, true);
  assert.match(validateUnknownQueryBundle({ evidence: [{ id: "context" }], facts: [], entities: [] }).errors[0], /without an explicit uncertainty marker/);
  assert.match(validateUnknownQueryBundle({ facts: [{ id: "false-fact" }], entities: [] }).errors[0], /semantic facts/);
});
