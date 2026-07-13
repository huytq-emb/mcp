import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ARTIFACT_MANIFEST_SCHEMA_VERSION } from "../artifacts/manifest.js";
import { createAppContext } from "../core/app-context.js";
import { wireRuntimePorts } from "./runtime-wiring.js";
import { SERVER_NAME, SERVER_VERSION } from "../core/runtime-constants.js";
import { errorResult } from "../core/runtime-helpers.js";
import {
  flushJobsState,
  claimDetachedJob,
  jobs,
  loadJobsStateFromDisk,
  normalizeArtifactName,
  nowIso,
  rebuildArtifact,
  refreshJobStateFromDisk,
  updateJob,
} from "../services/jobs.js";
import { resolveDriverProfile } from "../workflows/profiles.js";
import { createRuntimeToolRegistry } from "../mcp/runtime-registry.js";
import { createMcpServer } from "../mcp/server.js";

export async function runWorkerRebuildArtifact(encoded) {
  if (!encoded) throw new Error("Missing worker payload");
  const payload = JSON.parse(Buffer.from(String(encoded), "base64").toString("utf-8"));
  const filename = payload.filename;
  const artifact = normalizeArtifactName(payload.artifact);
  const options = payload.options || {};
  const jobId = String(payload.jobId || "").trim();
  if (!jobId) throw new Error("Detached worker payload is missing its persistent job ID");

  let job = await claimDetachedJob(jobId, { pid: process.pid, artifact, filename });

  try {
    const result = await rebuildArtifact(filename, artifact, {
      ...options,
      onProgress: (event = {}) => {
        if (!job) return;
        updateJob(job, {
          phase: event.phase || `worker-${artifact}`,
          progress: { current: event.current || 0, total: event.total || 0, unit: event.unit || "", percent: event.total ? Math.min(100, Math.round((event.current || 0) / event.total * 100)) : null },
          message: event.warning || event.phase || `worker-${artifact}`,
        });
      },
      onWorkerContext: (workerContext) => {
        if (!job) return;
        updateJob(job, { metadata: { ...(job.metadata || {}), ...workerContext } });
      },
      onWorkerSpawn: (workerPid) => {
        if (!job) return;
        updateJob(job, { metadata: { ...(job.metadata || {}), workerPid, engine: "python" } });
      },
      onWorkerStderr: (chunk) => {
        if (!job) return;
        const stderrTail = `${job.metadata?.stderrTail || ""}${chunk}`.slice(-32768);
        job.metadata = { ...(job.metadata || {}), stderrTail };
      },
    });
    await refreshJobStateFromDisk(jobId);
    job = jobId ? jobs.get(jobId) : job;
    if (job?.status === "cancelled") return;
    if (job) {
      updateJob(job, { status: "done", phase: "done", message: "Detached external worker completed", finishedAt: nowIso(), finishedMs: Date.now(), result: { ok: true, filename, artifact, result } });
      await flushJobsState();
    }
  } catch (error) {
    await refreshJobStateFromDisk(jobId);
    job = jobId ? jobs.get(jobId) : job;
    if (job?.status === "cancelled") return;
    if (job) {
      updateJob(job, { status: "failed", phase: "worker-failed", message: "Detached external worker failed", finishedAt: nowIso(), finishedMs: Date.now(), error: error instanceof Error ? error.stack || error.message : String(error) });
      await flushJobsState();
    }
    throw error;
  }
}

function cliArgValue(argv, name, fallback = "") {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function runProfileResolveSmoke(argv) {
  const resolved = await resolveDriverProfile({
    profile: cliArgValue(argv, "profile", ""),
    subsystem: cliArgValue(argv, "subsystem", ""),
    driverFamily: cliArgValue(argv, "driver-family", cliArgValue(argv, "driver_family", "")),
    createDefault: true,
  });
  console.log(JSON.stringify({
    ok: true,
    selected: resolved.selected,
    candidates: resolved.candidates,
    profile: resolved.profile.profile,
    subsystem: resolved.profile.subsystem,
    driverFamily: resolved.profile.driver_family,
    profileStack: resolved.profile._profileStack || [],
    fragments: resolved.profile._fragmentStack || [],
    checklistAreas: (resolved.profile.checklist || []).map((area) => area.area || "Unnamed area"),
    requiredManualChecks: resolved.profile.required_manual_checks || [],
    warnings: resolved.warnings || [],
  }, null, 2));
}

export async function runCli(argv = process.argv, options = {}) {
  const context = options.context || createAppContext();
  wireRuntimePorts(context);
  const registry = createRuntimeToolRegistry({ context });
  await context.fs.mkdir(context.paths.documentsDir(), { recursive: true });
  await context.fs.mkdir(context.paths.indexDir(), { recursive: true });

  try {
    if (argv[2] === "--worker-rebuild-artifact") {
      await runWorkerRebuildArtifact(argv[3]);
      return 0;
    }
    if (argv[2] === "--profile-resolve-smoke") {
      await runProfileResolveSmoke(argv);
      return 0;
    }
    if (argv[2] === "--smoke") {
      console.log(JSON.stringify({
        ok: true,
        serverName: SERVER_NAME,
        serverVersion: SERVER_VERSION,
        toolCount: registry.advertisedCount,
        documentsDir: context.paths.documentsDir(),
        indexDir: context.paths.indexDir(),
        manifestSchemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
      }, null, 2));
      return 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    return 1;
  }

  const server = createMcpServer({
    registry,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    onError: (error) => {
      console.error("Tool execution error:", error);
      return errorResult(error);
    },
  });
  await loadJobsStateFromDisk();
  await server.connect(options.transport || new StdioServerTransport());
  console.error(`${SERVER_NAME} started`);
  console.error(`Version: ${SERVER_VERSION}`);
  console.error(`Documents folder: ${context.paths.documentsDir()}`);
  console.error(`Indexes folder: ${context.paths.indexDir()}`);
  return 0;
}
