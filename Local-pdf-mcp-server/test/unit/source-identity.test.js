import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sourceFingerprint } from "../../src/artifacts/manifest.js";
import { readSourceIdentity, requireStrongSourceIdentity } from "../../src/artifacts/source-identity.js";

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
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("pre-hash source metadata reports an explicit rebuild migration", () => {
  assert.throws(() => requireStrongSourceIdentity({ size: 10, mtimeMs: 20 }, "Artifact pages"), /pre-hash artifact.*rebuild/i);
  const strong = { size: 10, mtimeMs: 20, sha256: "a".repeat(64) };
  assert.match(sourceFingerprint(strong), /;sha256=a{64}$/);
});

