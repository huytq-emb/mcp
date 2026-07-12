import fs from "node:fs/promises";
import { atomicWriteJson } from "../core/atomic-file.js";

export const TERMINAL_JOB_STATES = new Set(["done", "failed", "cancelled"]);

export class JobUpdateRejectedError extends Error {
  constructor(jobId, reason, current = null) {
    super(`Job update rejected for ${jobId}: ${reason}`);
    this.name = "JobUpdateRejectedError";
    this.code = "JOB_UPDATE_REJECTED";
    this.jobId = jobId;
    this.reason = reason;
    this.current = current;
  }
}

function normalizedJob(job = {}) {
  return {
    ...structuredClone(job),
    id: String(job.id || ""),
    revision: Math.max(0, Number(job.revision || 0)),
    updatedMs: Number(job.updatedMs || 0),
  };
}

export class JobStore {
  constructor({ paths, fs: fsOps = fs, clock = { now: () => Date.now() }, lockRetries = 80, lockBackoffMs = 10, lockStaleMs = 30_000 } = {}) {
    if (!paths?.jobsDir || !paths?.job || !paths?.jobLock) throw new Error("JobStore requires a runtime path resolver");
    this.paths = paths;
    this.fs = fsOps;
    this.clock = clock;
    this.lockRetries = lockRetries;
    this.lockBackoffMs = lockBackoffMs;
    this.lockStaleMs = lockStaleMs;
  }

  async #clearStaleLock(lockPath) {
    let createdMs = 0;
    let pid = 0;
    try {
      const lock = JSON.parse(await this.fs.readFile(lockPath, "utf8"));
      createdMs = Number(lock.createdMs || 0);
      pid = Number(lock.pid || 0);
    } catch {
      try { createdMs = Number((await this.fs.stat(lockPath)).mtimeMs || 0); } catch { return; }
    }
    if (!createdMs || this.clock.now() - createdMs <= this.lockStaleMs) return;
    let alive = false;
    if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
    if (!alive) await this.fs.rm(lockPath, { force: true }).catch(() => {});
  }

  async #withLock(jobId, callback) {
    await this.fs.mkdir(this.paths.jobsDir(), { recursive: true });
    const lockPath = this.paths.jobLock(jobId);
    let handle = null;
    for (let attempt = 0; attempt <= this.lockRetries; attempt += 1) {
      try {
        handle = await this.fs.open(lockPath, "wx");
        break;
      }
      catch (error) {
        if (error?.code !== "EEXIST" || attempt === this.lockRetries) throw error;
        await this.#clearStaleLock(lockPath);
        await new Promise((resolve) => setTimeout(resolve, this.lockBackoffMs * Math.min(10, attempt + 1)));
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdMs: this.clock.now() }), "utf8");
      return await callback();
    }
    finally {
      try { await handle?.close(); } finally { await this.fs.rm(lockPath, { force: true }).catch(() => {}); }
    }
  }

  async createJob(job) {
    const value = normalizedJob(job);
    if (!value.id) throw new Error("Job id is required");
    return this.#withLock(value.id, async () => {
      if (await this.readJob(value.id)) throw new JobUpdateRejectedError(value.id, "job already exists", await this.readJob(value.id));
      value.revision = 1;
      value.updatedMs = value.updatedMs || this.clock.now();
      await atomicWriteJson(this.paths.job(value.id), value, { fs: this.fs });
      return value;
    });
  }

  async readJob(jobId) {
    try {
      return normalizedJob(JSON.parse(await this.fs.readFile(this.paths.job(jobId), "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error(`Unable to read job ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async updateJob(jobId, patch = {}, options = {}) {
    return this.#withLock(jobId, async () => {
      const current = await this.readJob(jobId);
      if (!current) throw new JobUpdateRejectedError(jobId, "job does not exist");
      const requestedStatus = patch.status === undefined ? current.status : String(patch.status);
      if (TERMINAL_JOB_STATES.has(current.status) && requestedStatus !== current.status) {
        throw new JobUpdateRejectedError(jobId, `terminal state ${current.status} is monotonic and cannot become ${requestedStatus}`, current);
      }
      if (TERMINAL_JOB_STATES.has(current.status) && patch.status === undefined) {
        throw new JobUpdateRejectedError(jobId, `terminal state ${current.status} cannot be modified by a stale non-terminal update`, current);
      }
      if (options.expectedRevision !== undefined && Number(options.expectedRevision) !== Number(current.revision)) {
        throw new JobUpdateRejectedError(jobId, `expected revision ${options.expectedRevision}, current revision is ${current.revision}`, current);
      }
      const proposedUpdatedMs = Number(options.updatedMs ?? patch.updatedMs ?? this.clock.now());
      if (proposedUpdatedMs <= Number(current.updatedMs || 0)) {
        throw new JobUpdateRejectedError(jobId, `update timestamp ${proposedUpdatedMs} is not newer than current timestamp ${current.updatedMs}`, current);
      }
      const next = normalizedJob({ ...current, ...structuredClone(patch) });
      next.id = current.id;
      next.revision = Number(current.revision || 0) + 1;
      next.updatedMs = proposedUpdatedMs;
      await atomicWriteJson(this.paths.job(jobId), next, { fs: this.fs });
      return next;
    });
  }

  async listJobs() {
    await this.fs.mkdir(this.paths.jobsDir(), { recursive: true });
    const entries = await this.fs.readdir(this.paths.jobsDir(), { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      jobs.push(await this.readJob(id));
    }
    return jobs.filter(Boolean).sort((a, b) => Number(b.createdMs || 0) - Number(a.createdMs || 0));
  }

  async deleteJob(jobId) {
    return this.#withLock(jobId, async () => {
      const current = await this.readJob(jobId);
      if (!current) return false;
      await this.fs.rm(this.paths.job(jobId), { force: true });
      return true;
    });
  }

  async cleanupJobs(options = {}) {
    const includeRunning = Boolean(options.includeRunning);
    const statuses = new Set(Array.isArray(options.statuses) && options.statuses.length ? options.statuses.map(String) : [...TERMINAL_JOB_STATES]);
    const cutoffMs = Number(options.olderThanMs || 0) > 0 ? this.clock.now() - Number(options.olderThanMs) : 0;
    const removed = [];
    for (const job of await this.listJobs()) {
      const active = job.status === "queued" || job.status === "running";
      if (active && !includeRunning) continue;
      if (!statuses.has(job.status)) continue;
      if (cutoffMs && Number(job.updatedMs || job.createdMs || 0) > cutoffMs) continue;
      if (await this.deleteJob(job.id)) removed.push(job.id);
    }
    return removed;
  }

  async recoverJobs(options = {}) {
    const isProcessAlive = options.isProcessAlive || ((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    const recovered = [];
    for (const job of await this.listJobs()) {
      if (job.status !== "queued" && job.status !== "running") { recovered.push(job); continue; }
      const pids = [job.metadata?.orchestratorPid, job.metadata?.workerPid].map(Number).filter((pid) => pid > 0);
      if (pids.some((pid) => isProcessAlive(pid))) { recovered.push(job); continue; }
      const updatedMs = Math.max(this.clock.now(), Number(job.updatedMs || 0) + 1);
      const updatedAt = new Date(updatedMs).toISOString();
      recovered.push(await this.updateJob(job.id, {
        status: "failed",
        phase: "interrupted",
        message: "Recorded background job processes are no longer alive",
        error: "Interrupted because no recorded worker/orchestrator process is alive; start a new job if the index is incomplete.",
        finishedAt: job.finishedAt || updatedAt,
        finishedMs: job.finishedMs || updatedMs,
        updatedAt,
        updatedMs,
      }, { updatedMs }));
    }
    return recovered.sort((a, b) => Number(b.createdMs || 0) - Number(a.createdMs || 0));
  }
}

export function createJobStore(options) {
  return new JobStore(options);
}
