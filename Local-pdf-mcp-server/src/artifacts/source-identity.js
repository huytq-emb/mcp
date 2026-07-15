import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";

const identityCacheStorage = new AsyncLocalStorage();
const sharedIdentityCache = new Map();
const SHARED_IDENTITY_CACHE_ENTRIES = 64;

function sharedIdentityHash(key) {
  const cached = sharedIdentityCache.get(key);
  if (!cached) return null;
  sharedIdentityCache.delete(key);
  sharedIdentityCache.set(key, cached);
  return cached;
}

function cacheSharedIdentity(key, sha256) {
  sharedIdentityCache.delete(key);
  sharedIdentityCache.set(key, sha256);
  while (sharedIdentityCache.size > SHARED_IDENTITY_CACHE_ENTRIES) sharedIdentityCache.delete(sharedIdentityCache.keys().next().value);
}

export class SourceChangedError extends Error {
  constructor(message = "PDF changed while source identity was being calculated") {
    super(message);
    this.name = "SourceChangedError";
    this.code = "PDF_SOURCE_CHANGED";
  }
}

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

function identityFromStat(stat) {
  const identity = {
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    mtime: stat.mtime?.toISOString?.() || new Date(stat.mtimeMs).toISOString(),
  };
  if (Number.isFinite(Number(stat.ctimeMs))) identity.ctimeMs = Number(stat.ctimeMs);
  if (Number.isFinite(Number(stat.ino)) && Number(stat.ino) > 0) identity.ino = Number(stat.ino);
  if (Number.isFinite(Number(stat.dev)) && Number(stat.dev) > 0) identity.dev = Number(stat.dev);
  return identity;
}

function stableMetadataMatches(before, after) {
  for (const key of ["size", "mtimeMs", "ctimeMs", "ino", "dev"]) {
    const left = Number(before?.[key]);
    const right = Number(after?.[key]);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return false;
  }
  return true;
}

function cacheKey(filePath, identity) {
  return `${filePath}\0${identity.size}\0${identity.mtimeMs}\0${identity.ctimeMs || 0}\0${identity.ino || 0}\0${identity.dev || 0}`;
}

export async function readStableSourceIdentity(filePath, options = {}) {
  const fsOps = options.fs || fsp;
  const statFile = options.statFile || ((target) => fsOps.stat(target));
  const beforeStat = options.stat && typeof options.stat !== "function" ? options.stat : await statFile(filePath);
  const before = identityFromStat(beforeStat);
  const cache = options.cache || identityCacheStorage.getStore();
  const key = cacheKey(filePath, before);
  const cached = options.allowCache === true && options.bypassCache !== true
    ? cache?.get(key) || sharedIdentityHash(key)
    : null;
  const hashFile = options.hashFile || sha256File;
  const sha256 = cached || await hashFile(filePath, options);
  const after = identityFromStat(await statFile(filePath));
  if (!stableMetadataMatches(before, after)) {
    throw new SourceChangedError("PDF changed while source identity was being calculated");
  }
  after.sha256 = sha256;
  cache?.set(cacheKey(filePath, after), sha256);
  if (options.allowCache === true && options.bypassCache !== true) cacheSharedIdentity(cacheKey(filePath, after), sha256);
  return after;
}

export async function readSourceIdentity(filePath, options = {}) {
  if (options.includeHash === true) return readStableSourceIdentity(filePath, { ...options, allowCache: options.bypassCache !== true });
  const fsOps = options.fs || fsp;
  const stat = options.stat && typeof options.stat !== "function" ? options.stat : await fsOps.stat(filePath);
  return identityFromStat(stat);
}

export function requireStrongSourceIdentity(source, artifact = "artifact") {
  if (!source?.sha256 || !/^[a-f0-9]{64}$/i.test(String(source.sha256))) {
    throw new Error(`${artifact} was built without a PDF SHA-256 source fingerprint. This pre-hash artifact is incompatible; rebuild the index.`);
  }
  return source;
}

export function assertSameContentSource(initialSource, finalSource, filename = "PDF") {
  requireStrongSourceIdentity(initialSource, `Initial source for ${filename}`);
  requireStrongSourceIdentity(finalSource, `Final source for ${filename}`);
  if (Number(initialSource.size) !== Number(finalSource.size) || String(initialSource.sha256).toLowerCase() !== String(finalSource.sha256).toLowerCase()) {
    throw new SourceChangedError(`${filename} changed during indexing; discard the generated artifacts and start a new build.`);
  }
  return finalSource;
}

export function isCompatibleBuildCheckpoint(checkpoint, { filename, buildId, source, schemaVersion } = {}) {
  if (!checkpoint || checkpoint.schemaVersion !== schemaVersion || checkpoint.filename !== filename || checkpoint.buildId !== buildId) return false;
  try {
    requireStrongSourceIdentity(checkpoint.source, "Partial checkpoint");
    requireStrongSourceIdentity(source, "Current checkpoint source");
    return Number(checkpoint.source.size) === Number(source.size)
      && String(checkpoint.source.sha256).toLowerCase() === String(source.sha256).toLowerCase();
  } catch {
    return false;
  }
}

export function clearSourceIdentityCache() {
  identityCacheStorage.getStore()?.clear();
  sharedIdentityCache.clear();
}

export function withSourceIdentityCache(callback) {
  return identityCacheStorage.run(new Map(), callback);
}
