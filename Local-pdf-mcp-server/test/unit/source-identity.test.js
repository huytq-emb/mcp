import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { contentSourceFingerprint, metadataFingerprint, sourceFingerprint } from "../../src/artifacts/manifest.js";
import { isSamePdfSource } from "../../src/core/runtime-helpers.js";
import { assertSameContentSource, clearSourceIdentityCache, readSourceIdentity, readStableSourceIdentity, requireStrongSourceIdentity, SourceChangedError } from "../../src/artifacts/source-identity.js";

test("cross-request source identity cache reuses stable metadata and invalidates on content writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-source-shared-cache-"));
  const filePath = path.join(root, "cached.pdf");
  clearSourceIdentityCache();
  try {
    await fs.writeFile(filePath, "AAAA", "utf8");
    const initialStat = await fs.stat(filePath);
    let hashCalls = 0;
    const hashFile = async () => {
      hashCalls += 1;
      return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
    };
    const first = await readSourceIdentity(filePath, { includeHash: true, hashFile });
    const second = await readSourceIdentity(filePath, { includeHash: true, hashFile });
    assert.equal(second.sha256, first.sha256);
    assert.equal(hashCalls, 1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(filePath, "BBBB", "utf8");
    await fs.utimes(filePath, initialStat.atime, initialStat.mtime);
    const changed = await readSourceIdentity(filePath, { includeHash: true, hashFile });
    assert.notEqual(changed.sha256, first.sha256);
    assert.equal(hashCalls, 2);
  } finally {
    clearSourceIdentityCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("same size and mtime with different PDF content has different SHA-256 identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-source-identity-"));
  try {
    const left = path.join(root, "left.pdf");
    const right = path.join(root, "right.pdf");
    await fs.writeFile(left, "AAAA", "utf8");
    await fs.writeFile(right, "BBBB", "utf8");
    const timestamp = new Date("2025-01-02T03:04:05.000Z");
    await Promise.all([fs.utimes(left, timestamp, timestamp), fs.utimes(right, timestamp, timestamp)]);
    const [leftIdentity, rightIdentity] = await Promise.all([
      readSourceIdentity(left, { includeHash: true }),
      readSourceIdentity(right, { includeHash: true }),
    ]);
    assert.equal(leftIdentity.size, rightIdentity.size);
    assert.equal(leftIdentity.mtimeMs, rightIdentity.mtimeMs);
    assert.notEqual(leftIdentity.sha256, rightIdentity.sha256);
    assert.notEqual(sourceFingerprint(leftIdentity), sourceFingerprint(rightIdentity));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("identical content keeps the same hash across timestamps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-source-copy-"));
  try {
    const original = path.join(root, "original.pdf");
    const copy = path.join(root, "copy.pdf");
    await fs.writeFile(original, "identical PDF bytes", "utf8");
    await fs.copyFile(original, copy);
    await fs.utimes(copy, new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z"));
    const first = await readSourceIdentity(original, { includeHash: true });
    const second = await readSourceIdentity(copy, { includeHash: true });
    assert.equal(first.sha256, second.sha256);
    assert.equal(contentSourceFingerprint(first), contentSourceFingerprint(second));
    assert.equal(sourceFingerprint(first), sourceFingerprint(second));
    assert.equal(isSamePdfSource(first, second), true);
    assert.notEqual(metadataFingerprint(first), metadataFingerprint(second));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("pre-hash source metadata reports an explicit rebuild migration", () => {
  assert.throws(() => requireStrongSourceIdentity({ size: 10, mtimeMs: 20 }, "Artifact pages"), /pre-hash artifact.*rebuild/i);
  const strong = { size: 10, mtimeMs: 20, sha256: "a".repeat(64) };
  assert.match(sourceFingerprint(strong), /;sha256=a{64}$/);
  assert.equal(isSamePdfSource(strong, { ...strong, mtimeMs: 999 }), true);
  assert.equal(isSamePdfSource(strong, { ...strong, sha256: "b".repeat(64) }), false);
  assert.equal(isSamePdfSource(strong, { size: 10, mtimeMs: 20 }), false);
});

test("stable source identity rejects a PDF changed during streaming hash", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-source-changing-hash-"));
  const filePath = path.join(root, "changing.pdf");
  try {
    await fs.writeFile(filePath, "before", "utf8");
    await assert.rejects(readStableSourceIdentity(filePath, {
      hashFile: async () => {
        await fs.appendFile(filePath, "-after", "utf8");
        return "a".repeat(64);
      },
    }), SourceChangedError);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("final build verification rejects content changed after the initial identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-source-changing-build-"));
  const filePath = path.join(root, "changing.pdf");
  try {
    await fs.writeFile(filePath, "AAAA", "utf8");
    const initial = await readStableSourceIdentity(filePath);
    const originalTimes = await fs.stat(filePath);
    await fs.writeFile(filePath, "BBBB", "utf8");
    await fs.utimes(filePath, originalTimes.atime, originalTimes.mtime);
    const final = await readStableSourceIdentity(filePath);
    assert.equal(initial.size, final.size);
    assert.ok(Math.abs(initial.mtimeMs - final.mtimeMs) < 2);
    assert.throws(() => assertSameContentSource(initial, final, "changing.pdf"), /changed during indexing/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
