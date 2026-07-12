import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";

const identityCacheStorage = new AsyncLocalStorage();

export async function sha256File(filePath, options = {}) {
  const createReadStream = options.createReadStream || fs.createReadStream;
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function readSourceIdentity(filePath, options = {}) {
  const fsOps = options.fs || fsp;
  const stat = options.stat || await fsOps.stat(filePath);
  const identity = {
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    mtime: stat.mtime?.toISOString?.() || new Date(stat.mtimeMs).toISOString(),
  };
  const cache = options.cache || identityCacheStorage.getStore();
  const key = `${filePath}\0${identity.size}\0${identity.mtimeMs}`;
  const cached = cache?.get(key);
  if (cached) identity.sha256 = cached;
  if (options.includeHash === true && !identity.sha256) {
    identity.sha256 = await sha256File(filePath, options);
    cache?.set(key, identity.sha256);
  }
  return identity;
}

export function requireStrongSourceIdentity(source, artifact = "artifact") {
  if (!source?.sha256 || !/^[a-f0-9]{64}$/i.test(String(source.sha256))) {
    throw new Error(`${artifact} was built without a PDF SHA-256 source fingerprint. This pre-hash artifact is incompatible; rebuild the index.`);
  }
  return source;
}

export function clearSourceIdentityCache() {
  identityCacheStorage.getStore()?.clear();
}

export function withSourceIdentityCache(callback) {
  return identityCacheStorage.run(new Map(), callback);
}
