import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntimeConfig } from "../../src/core/runtime-config.js";
import { createPathResolver } from "../../src/core/path-resolver.js";
import { createJobStore, JobUpdateRejectedError } from "../../src/services/job-store.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-job-store-"));
  const paths = createPathResolver(createRuntimeConfig({ rootDir: root }));
  return { root, paths, store: createJobStore({ paths }) };
}

function job(id, status = "queued", updatedMs = 1, metadata = {}) {
  return { id, type: "test", filename: `${id}.pdf`, status, createdMs: 1, updatedMs, metadata, log: [] };
}

test("per-job files preserve concurrent writers for different jobs", async () => {
  const { root, paths, store } = await fixture();
  try {
    await Promise.all([store.createJob(job("one")), store.createJob(job("two"))]);
    await Promise.all([
      store.updateJob("one", { status: "running", message: "one latest" }, { updatedMs: 10 }),
      store.updateJob("two", { status: "running", message: "two latest" }, { updatedMs: 11 }),
    ]);
    const listed = await store.listJobs();
    assert.deepEqual(new Set(listed.map((entry) => entry.id)), new Set(["one", "two"]));
    assert.equal((await store.readJob("one")).message, "one latest");
    assert.equal((await store.readJob("two")).message, "two latest");
    assert.equal((await fs.readdir(paths.jobsDir())).filter((name) => name.endsWith(".json")).length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("job reads survive the transient missing-target window of Windows atomic replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-job-transient-read-"));
  const paths = createPathResolver(createRuntimeConfig({ rootDir: root }));
  const store = createJobStore({ paths, readRetries: 0 });
  try {
    await fs.mkdir(paths.jobsDir(), { recursive: true });
    const previous = { ...job("swap", "running", 10), revision: 2 };
    const current = { ...job("swap", "running", 11), revision: 3, message: "newest" };
    await fs.writeFile(`${paths.job("swap")}.backup-test`, JSON.stringify(previous), "utf8");
    await fs.writeFile(`${paths.job("swap")}.incoming-test`, JSON.stringify(current), "utf8");
    const read = await store.readJob("swap");
    assert.equal(read.message, "newest");
    const listed = await store.listJobs();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].revision, 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("cancelled terminal state rejects late running and done updates", async () => {
  const { root, store } = await fixture();
  try {
    await store.createJob(job("race", "running", 1));
    await store.updateJob("race", { status: "cancelled" }, { updatedMs: 20 });
    await assert.rejects(store.updateJob("race", { status: "running" }, { updatedMs: 21 }), JobUpdateRejectedError);
    await assert.rejects(store.updateJob("race", { status: "done" }, { updatedMs: 22 }), /terminal state cancelled/);
    assert.equal((await store.readJob("race")).status, "cancelled");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("restart recovery preserves terminal jobs and interrupts only orphaned active jobs", async () => {
  const { root, paths, store } = await fixture();
  try {
    for (const [index, status] of ["queued", "running", "done", "failed", "cancelled"].entries()) {
      await store.createJob(job(status, status, index + 1, status === "running" ? { workerPid: 99 } : {}));
    }
    const restarted = createJobStore({ paths });
    const recovered = await restarted.recoverJobs({ isProcessAlive: (pid) => pid === 99 });
    assert.equal(recovered.find((entry) => entry.id === "queued").phase, "interrupted");
    assert.equal(recovered.find((entry) => entry.id === "running").status, "running");
    for (const status of ["done", "failed", "cancelled"]) assert.equal(recovered.find((entry) => entry.id === status).status, status);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("detached worker atomically claims a queued job before the parent PID update", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-job-claim-"));
  const paths = createPathResolver(createRuntimeConfig({ rootDir: root }));
  let now = 10_000;
  const store = createJobStore({ paths, clock: { now: () => now } });
  try {
    await store.createJob({ ...job("claim-race", "queued", 9_000, { artifact: "pages" }), createdMs: 8_000 });
    now = 10_001;
    const claimed = await store.claimDetachedJob("claim-race", { pid: 4321, artifact: "pages", filename: "claim-race.pdf" });
    assert.equal(claimed.status, "running");
    assert.equal(claimed.metadata.orchestratorPid, 4321);

    now = 10_002;
    const parentUpdate = await store.recordDetachedPid("claim-race", 4321);
    assert.equal(parentUpdate.status, "running");
    assert.equal(parentUpdate.phase, "worker-pages");
    assert.equal(parentUpdate.metadata.orchestratorPid, 4321);
    await assert.rejects(store.claimDetachedJob("claim-race", { pid: 4321, artifact: "pages" }), /only be claimed from queued state/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("recovery applies queued grace and rechecks live PIDs for active jobs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-job-recovery-"));
  const paths = createPathResolver(createRuntimeConfig({ rootDir: root }));
  const now = 100_000;
  const store = createJobStore({ paths, clock: { now: () => now } });
  try {
    await store.createJob({ ...job("queued-recent", "queued", 99_500), createdMs: 99_000 });
    await store.createJob({ ...job("queued-old", "queued", 60_000), createdMs: 60_000 });
    await store.createJob({ ...job("running-live", "running", 80_000, { workerPid: 77 }), createdMs: 70_000 });
    await store.createJob({ ...job("running-dead", "running", 80_001, { orchestratorPid: 88, workerPid: 89 }), createdMs: 70_000 });
    const recovered = await store.recoverJobs({ queuedGraceMs: 30_000, isProcessAlive: (pid) => pid === 77 });
    assert.equal(recovered.find((entry) => entry.id === "queued-recent").status, "queued");
    assert.equal(recovered.find((entry) => entry.id === "queued-old").phase, "interrupted");
    assert.equal(recovered.find((entry) => entry.id === "running-live").status, "running");
    assert.equal(recovered.find((entry) => entry.id === "running-dead").phase, "interrupted");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("polling a live job does not contend for its writer lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-job-live-poll-"));
  const paths = createPathResolver(createRuntimeConfig({ rootDir: root }));
  const store = createJobStore({ paths, lockRetries: 0 });
  try {
    await store.createJob({ ...job("live-poll", "running", 10, { workerPid: 77 }), createdMs: 1 });
    await fs.writeFile(paths.jobLock("live-poll"), JSON.stringify({ pid: process.pid, createdMs: Date.now() }), "utf8");
    const recovered = await store.recoverJob("live-poll", { isProcessAlive: (pid) => pid === 77 });
    assert.equal(recovered.status, "running");
    assert.equal(recovered.metadata.workerPid, 77);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("cleanup removes selected terminal jobs and protects active jobs by default", async () => {
  const { root, store } = await fixture();
  try {
    for (const status of ["running", "done", "failed", "cancelled"]) await store.createJob(job(status, status));
    assert.deepEqual(new Set(await store.cleanupJobs({ statuses: ["done", "failed"] })), new Set(["done", "failed"]));
    assert.equal((await store.readJob("running")).status, "running");
    assert.equal((await store.readJob("cancelled")).status, "cancelled");
    assert.deepEqual(await store.cleanupJobs({ statuses: ["running"], includeRunning: true }), ["running"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
