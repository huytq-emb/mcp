import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteFile, replaceFileAtomic } from "../../src/core/atomic-file.js";

function transient(code = "EPERM") {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

test("atomic replacement retries a transient Windows rename failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-atomic-retry-"));
  try {
    const target = path.join(root, "artifact.json");
    const incoming = path.join(root, "incoming.json");
    await fs.writeFile(target, "old");
    await fs.writeFile(incoming, "new");
    let calls = 0;
    const fsOps = new Proxy(fs, { get(object, key) {
      if (key !== "rename") return object[key];
      return async (...args) => { calls += 1; if (calls === 1) throw transient("EPERM"); return fs.rename(...args); };
    } });
    await replaceFileAtomic(incoming, target, { fs: fsOps, sleep: async () => {} });
    assert.equal(await fs.readFile(target, "utf8"), "new");
    assert.ok(calls >= 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("exhausted transient backup failures preserve the old target and remove incoming", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-atomic-exhaust-"));
  try {
    const target = path.join(root, "artifact.json");
    const incoming = path.join(root, "incoming.json");
    await fs.writeFile(target, "old");
    await fs.writeFile(incoming, "new");
    const fsOps = new Proxy(fs, { get(object, key) { return key === "rename" ? async () => { throw transient("EBUSY"); } : object[key]; } });
    await assert.rejects(replaceFileAtomic(incoming, target, { fs: fsOps, retries: 2, sleep: async () => {} }), /simulated EBUSY/);
    assert.equal(await fs.readFile(target, "utf8"), "old");
    await assert.rejects(fs.access(incoming));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("failed promotion after backup rolls back the previous artifact and cleans temporary files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-atomic-rollback-"));
  try {
    const target = path.join(root, "artifact.json");
    const incoming = path.join(root, "incoming.json");
    await fs.writeFile(target, "old-valid");
    await fs.writeFile(incoming, "new-invalid");
    let calls = 0;
    const fsOps = new Proxy(fs, { get(object, key) {
      if (key !== "rename") return object[key];
      return async (...args) => { calls += 1; if (calls === 2) throw Object.assign(new Error("permanent promotion failure"), { code: "EINVAL" }); return fs.rename(...args); };
    } });
    await assert.rejects(replaceFileAtomic(incoming, target, { fs: fsOps, sleep: async () => {} }), /permanent promotion failure/);
    assert.equal(await fs.readFile(target, "utf8"), "old-valid");
    assert.deepEqual((await fs.readdir(root)).sort(), ["artifact.json"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("atomic writer cleans its incoming file when replacement fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-atomic-write-"));
  try {
    const target = path.join(root, "artifact.json");
    await fs.writeFile(target, "old-valid");
    let calls = 0;
    const fsOps = new Proxy(fs, { get(object, key) {
      if (key !== "rename") return object[key];
      return async (...args) => { calls += 1; if (calls === 2) throw Object.assign(new Error("promotion denied"), { code: "EINVAL" }); return fs.rename(...args); };
    } });
    await assert.rejects(atomicWriteFile(target, "new", "utf8", { fs: fsOps, sleep: async () => {} }), /promotion denied/);
    assert.equal(await fs.readFile(target, "utf8"), "old-valid");
    assert.deepEqual((await fs.readdir(root)).sort(), ["artifact.json"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

