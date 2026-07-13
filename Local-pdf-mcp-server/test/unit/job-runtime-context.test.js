import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppContext } from "../../src/core/app-context.js";
import { withPathResolver } from "../../src/core/path-resolver.js";
import { wireRuntimePorts } from "../../src/app/runtime-wiring.js";
import { createRuntimeToolRegistry } from "../../src/mcp/runtime-registry.js";
import { runWorkerRebuildArtifact } from "../../src/app/bootstrap.js";
import { activeJobCount, cleanupBackgroundJobs, flushJobsState, getJobsMap, getJobStore, refreshJobsStateFromDisk, startExternalRebuildArtifactJob, updateJob } from "../../src/services/jobs.js";

function persistedJob(id, filename, status = "done", updatedMs = 10, metadata = {}) {
  return {
    id,
    type: "test",
    filename,
    status,
    phase: status,
    message: `${filename}:${status}`,
    createdAt: new Date(1).toISOString(),
    createdMs: 1,
    updatedAt: new Date(updatedMs).toISOString(),
    updatedMs,
    finishedAt: status === "done" ? new Date(updatedMs).toISOString() : null,
    finishedMs: status === "done" ? updatedMs : 0,
    metadata,
    log: [],
  };
}

async function contexts(optionsA = {}, optionsB = {}) {
  const [rootA, rootB] = await Promise.all([
    fs.mkdtemp(path.join(os.tmpdir(), "mcp-job-context-a-")),
    fs.mkdtemp(path.join(os.tmpdir(), "mcp-job-context-b-")),
  ]);
  const contextA = createAppContext({ rootDir: rootA, ...optionsA });
  const contextB = createAppContext({ rootDir: rootB, ...optionsB });
  wireRuntimePorts(contextA);
  const registryA = createRuntimeToolRegistry({ context: contextA });
  wireRuntimePorts(contextB);
  const registryB = createRuntimeToolRegistry({ context: contextB });
  return { rootA, rootB, contextA, contextB, registryA, registryB };
}

async function cleanup(value) {
  await Promise.all([fs.rm(value.rootA, { recursive: true, force: true }), fs.rm(value.rootB, { recursive: true, force: true })]);
}

test("runtime job maps, IDs, refresh, active limits, list/status, and cleanup are isolated per resolver", async () => {
  const value = await contexts();
  const sameId = "same-job-1";
  try {
    await withPathResolver(value.contextA.paths, async () => {
      await getJobStore().createJob(persistedJob(sameId, "a.pdf"));
      await getJobStore().createJob(persistedJob("a-only-2", "a-only.pdf"));
      await refreshJobsStateFromDisk();
    });
    await withPathResolver(value.contextB.paths, async () => {
      await getJobStore().createJob(persistedJob(sameId, "b.pdf"));
      await getJobStore().createJob(persistedJob("b-only-2", "b-only.pdf"));
      await refreshJobsStateFromDisk();
    });

    assert.notEqual(getJobsMap(value.contextA.paths), getJobsMap(value.contextB.paths));
    assert.equal(getJobsMap(value.contextA.paths).get(sameId).filename, "a.pdf");
    assert.equal(getJobsMap(value.contextB.paths).get(sameId).filename, "b.pdf");
    await withPathResolver(value.contextA.paths, () => refreshJobsStateFromDisk());
    assert.equal(getJobsMap(value.contextB.paths).has("b-only-2"), true);

    getJobsMap(value.contextA.paths).set("active-a-1", persistedJob("active-a-1", "a.pdf", "running"));
    getJobsMap(value.contextA.paths).set("active-a-2", persistedJob("active-a-2", "a.pdf", "queued"));
    assert.equal(await withPathResolver(value.contextA.paths, () => activeJobCount()), 2);
    assert.equal(await withPathResolver(value.contextB.paths, () => activeJobCount()), 0);
    await withPathResolver(value.contextA.paths, () => assert.rejects(startExternalRebuildArtifactJob("a.pdf", "pages", { spawn: () => assert.fail("must not spawn") }), /Too many active jobs/));
    const startedB = await withPathResolver(value.contextB.paths, () => startExternalRebuildArtifactJob("b.pdf", "pages", {
      spawn: () => ({ pid: process.pid, unref() {}, kill() { return true; } }),
    }));
    assert.equal(startedB.filename, "b.pdf");

    const [listedA, listedB] = await Promise.all([
      value.registryA.dispatchTool("mcp_control", { action: "list_jobs" }),
      value.registryB.dispatchTool("mcp_control", { action: "list_jobs" }),
    ]);
    assert.match(listedA.content[0].text, /a-only\.pdf/);
    assert.doesNotMatch(listedA.content[0].text, /b-only\.pdf/);
    assert.match(listedB.content[0].text, /b-only\.pdf/);
    assert.doesNotMatch(listedB.content[0].text, /a-only\.pdf/);
    const crossStatus = await value.registryA.dispatchTool("mcp_control", { action: "job_status", job_id: "b-only-2" });
    assert.match(crossStatus.content[0].text, /Job not found/);

    await withPathResolver(value.contextA.paths, () => cleanupBackgroundJobs({ statuses: ["done"] }));
    assert.equal(await withPathResolver(value.contextA.paths, () => getJobStore().readJob(sameId)), null);
    assert.equal((await withPathResolver(value.contextB.paths, () => getJobStore().readJob(sameId))).filename, "b.pdf");
  } finally { await cleanup(value); }
});

test("polling recovers dead jobs, preserves live PIDs/recent queued jobs/terminal jobs, and list recovers before formatting", async () => {
  const clock = { now: () => 100_000, nowIso: () => new Date(100_000).toISOString() };
  const value = await contexts({ clock }, { clock });
  try {
    await withPathResolver(value.contextA.paths, async () => {
      const store = getJobStore();
      await store.createJob({ ...persistedJob("dead-running", "dead.pdf", "running", 80_000, { orchestratorPid: 2_147_483_647 }), createdMs: 70_000 });
      await store.createJob({ ...persistedJob("live-orchestrator", "live-o.pdf", "running", 80_001, { orchestratorPid: process.pid }), createdMs: 70_000 });
      await store.createJob({ ...persistedJob("live-python", "live-p.pdf", "running", 80_002, { workerPid: process.pid }), createdMs: 70_000 });
      await store.createJob({ ...persistedJob("queued-recent", "recent.pdf", "queued", 99_001), createdMs: 99_000 });
      await store.createJob({ ...persistedJob("queued-old", "old.pdf", "queued", 60_000), createdMs: 60_000 });
      await store.createJob(persistedJob("terminal", "terminal.pdf", "done", 90_000));
    });

    const dead = await value.registryA.dispatchTool("mcp_control", { action: "job_status", job_id: "dead-running" });
    assert.match(dead.content[0].text, /Status: failed/);
    assert.match(dead.content[0].text, /interrupted/i);
    for (const id of ["live-orchestrator", "live-python", "queued-recent", "terminal"]) {
      const result = await value.registryA.dispatchTool("mcp_control", { action: "job_status", job_id: id });
      assert.doesNotMatch(result.content[0].text, /Phase: interrupted/, id);
    }
    const listed = await value.registryA.dispatchTool("mcp_control", { action: "list_jobs" });
    assert.match(listed.content[0].text, /queued-old[\s\S]*status: failed[\s\S]*phase: interrupted/);
  } finally { await cleanup(value); }
});

test("concurrent detached claim and polling recovery serialize, and a failed claim remains recoverable", async () => {
  const value = await contexts({ clock: { now: () => 100_000 } }, { clock: { now: () => 100_000 } });
  try {
    await withPathResolver(value.contextA.paths, async () => {
      const store = getJobStore();
      await store.createJob({ ...persistedJob("claim-race", "race.pdf", "queued", 50_000, { artifact: "pages" }), createdMs: 50_000 });
      const [claim, recovery] = await Promise.allSettled([
        store.claimDetachedJob("claim-race", { pid: process.pid, artifact: "pages", filename: "race.pdf" }),
        store.recoverJob("claim-race", { queuedGraceMs: 0, isProcessAlive: (pid) => pid === process.pid }),
      ]);
      const current = await store.readJob("claim-race");
      assert.equal(["running", "failed"].includes(current.status), true);
      if (claim.status === "fulfilled") assert.equal(current.status, "running");
      else assert.equal(recovery.status, "fulfilled");

      await store.createJob({ ...persistedJob("claim-failed", "failed.pdf", "queued", 50_001, { artifact: "pages" }), createdMs: 50_000 });
      await assert.rejects(store.claimDetachedJob("claim-failed", { pid: process.pid, artifact: "tables" }), /artifact pages/);
      const recovered = await store.recoverJob("claim-failed", { queuedGraceMs: 0, isProcessAlive: () => false });
      assert.equal(recovered.phase, "interrupted");
    });
  } finally { await cleanup(value); }
});

test("detached worker claim failure is actionable, does not recreate missing jobs, and terminal jobs exit without rebuilding", async () => {
  const value = await contexts();
  const encode = (jobId) => Buffer.from(JSON.stringify({ jobId, filename: "worker.pdf", artifact: "pages", options: {} }), "utf8").toString("base64");
  try {
    await withPathResolver(value.contextA.paths, async () => {
      await assert.rejects(runWorkerRebuildArtifact(encode("missing-worker-job")), /job does not exist/);
      assert.equal(await getJobStore().readJob("missing-worker-job"), null);
      await getJobStore().createJob(persistedJob("terminal-worker-job", "worker.pdf", "cancelled", 100));
      await runWorkerRebuildArtifact(encode("terminal-worker-job"));
      assert.equal((await getJobStore().readJob("terminal-worker-job")).status, "cancelled");
      await getJobStore().createJob({ ...persistedJob("mismatched-worker-job", "worker.pdf", "queued", 100, { artifact: "tables" }), createdMs: 100 });
      await assert.rejects(runWorkerRebuildArtifact(encode("mismatched-worker-job")), /artifact tables/);
      const failed = await getJobStore().readJob("mismatched-worker-job");
      assert.equal(failed.status, "failed");
      assert.equal(failed.phase, "worker-claim-failed");
    });
  } finally { await cleanup(value); }
});

test("persistence failures aggregate once, drain, isolate by context, and stale rejections do not poison later flushes", async () => {
  let failWritesA = false;
  const fsA = new Proxy(fs, {
    get(target, property) {
      if (property === "open") return async (filePath, ...args) => {
        if (failWritesA && String(filePath).includes(".json.incoming-")) throw Object.assign(new Error(`write denied: ${path.basename(String(filePath))}`), { code: "EACCES" });
        return target.open(filePath, ...args);
      };
      return target[property];
    },
  });
  const value = await contexts({ fs: fsA }, {});
  try {
    await withPathResolver(value.contextA.paths, async () => {
      const store = getJobStore();
      for (const id of ["failure-one", "failure-two"]) {
        const job = await store.createJob(persistedJob(id, `${id}.pdf`, "running", 10));
        getJobsMap().set(id, job);
      }
      failWritesA = true;
      updateJob(getJobsMap().get("failure-one"), { message: "one" });
      updateJob(getJobsMap().get("failure-two"), { message: "two" });
      await assert.rejects(flushJobsState(), (error) => error instanceof AggregateError && error.errors.length === 2);
      failWritesA = false;
      await flushJobsState();
    });
    await withPathResolver(value.contextB.paths, () => flushJobsState());

    await withPathResolver(value.contextA.paths, async () => {
      const store = getJobStore();
      const terminal = await store.createJob(persistedJob("stale-current", "stale.pdf", "cancelled", 500));
      getJobsMap().set("stale-current", { ...terminal, status: "running", updatedMs: 100, revision: 1 });
      updateJob(getJobsMap().get("stale-current"), { message: "stale update" });
      await flushJobsState();
      assert.equal(getJobsMap().get("stale-current").status, "cancelled");
    });
  } finally { await cleanup(value); }
});
