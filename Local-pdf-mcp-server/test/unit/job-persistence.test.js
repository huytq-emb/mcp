import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppContext } from "../../src/core/app-context.js";
import { withPathResolver } from "../../src/core/path-resolver.js";
import { wireRuntimePorts } from "../../src/app/runtime-wiring.js";
import { getJobStore, jobs, startExternalRebuildArtifactJob } from "../../src/services/jobs.js";

function failure(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function fsWithOpenFault(predicate) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === "open") {
        return async (filePath, ...args) => {
          const error = predicate(String(filePath), args);
          if (error) throw error;
          return target.open(filePath, ...args);
        };
      }
      return target[property];
    },
  });
}

async function withFixture(fsOps, callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-job-persistence-"));
  const context = createAppContext({ rootDir: root, fs: fsOps });
  wireRuntimePorts(context);
  jobs.clear();
  try { return await withPathResolver(context.paths, () => callback({ root, context })); }
  finally {
    jobs.clear();
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const code of ["EACCES", "ENOSPC"]) {
  test(`initial job ${code} persistence failure prevents detached spawn`, async () => {
    let spawned = 0;
    const fsOps = fsWithOpenFault((filePath) => filePath.includes(".json.incoming-") ? failure(code, `${code} writing job JSON`) : null);
    await withFixture(fsOps, async () => {
      await assert.rejects(
        startExternalRebuildArtifactJob("manual.pdf", "pages", { spawn: () => { spawned += 1; } }),
        new RegExp(`Unable to persist initial background job.*${code}`),
      );
      assert.equal(spawned, 0);
    });
  });
}

test("job lock creation failure prevents detached spawn and reaches the caller", async () => {
  let spawned = 0;
  const fsOps = fsWithOpenFault((filePath) => filePath.endsWith(".lock") ? failure("EACCES", "lock creation denied") : null);
  await withFixture(fsOps, async () => {
    await assert.rejects(
      startExternalRebuildArtifactJob("manual.pdf", "pages", { spawn: () => { spawned += 1; } }),
      /Unable to persist initial background job.*lock creation denied/,
    );
    assert.equal(spawned, 0);
  });
});

test("PID persistence failure terminates the spawned child and does not return success", async () => {
  let jsonWrites = 0;
  let killed = 0;
  let unrefed = 0;
  const fsOps = fsWithOpenFault((filePath) => {
    if (!filePath.includes(".json.incoming-")) return null;
    jsonWrites += 1;
    return jsonWrites === 2 ? failure("EACCES", "PID update denied") : null;
  });
  await withFixture(fsOps, async () => {
    await assert.rejects(
      startExternalRebuildArtifactJob("manual.pdf", "pages", {
        spawn: () => ({ pid: 4567, kill: () => { killed += 1; return true; }, unref: () => { unrefed += 1; } }),
      }),
      /terminated because its PID could not be persisted.*PID update denied/,
    );
    assert.equal(killed, 1);
    assert.equal(unrefed, 0);
    const stored = (await getJobStore().listJobs())[0];
    assert.equal(stored.status, "failed");
    assert.equal(stored.phase, "worker-pid-persist-failed");
  });
});
