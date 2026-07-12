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

