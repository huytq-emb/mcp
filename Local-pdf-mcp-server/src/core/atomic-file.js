import fs from "node:fs/promises";
import path from "node:path";

export const TRANSIENT_REPLACE_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function uniqueSibling(targetPath, label) {
  return `${targetPath}.${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function exists(fsOps, filePath) {
  try { await fsOps.stat(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function retryTransient(operation, { retries, backoffMs, sleep }) {
  let attempt = 0;
  while (true) {
    try { return await operation(); }
    catch (error) {
      if (!TRANSIENT_REPLACE_ERROR_CODES.has(error?.code) || attempt >= retries) throw error;
      attempt += 1;
      await sleep(backoffMs * attempt);
    }
  }
}

async function removeBestEffort(fsOps, filePath, retryOptions) {
  if (!filePath) return;
  try { await retryTransient(() => fsOps.rm(filePath, { force: true }), retryOptions); } catch { /* cleanup must not hide the primary error */ }
}

export async function replaceFileAtomic(incomingPath, targetPath, options = {}) {
  const fsOps = options.fs || fs;
  const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : 4;
  const backoffMs = Number.isFinite(options.backoffMs) ? Math.max(0, options.backoffMs) : 20;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const backupPath = options.backupPath || uniqueSibling(targetPath, "backup");
  const retryOptions = { retries, backoffMs, sleep };
  let backedUp = false;
  let promoted = false;
  let failedTargetPath = "";

  await fsOps.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    if (await exists(fsOps, targetPath)) {
      await retryTransient(() => fsOps.rename(targetPath, backupPath), { retries, backoffMs, sleep });
      backedUp = true;
    }
    await retryTransient(() => fsOps.rename(incomingPath, targetPath), { retries, backoffMs, sleep });
    promoted = true;
    if (backedUp) await removeBestEffort(fsOps, backupPath, retryOptions);
    return targetPath;
  } catch (error) {
    if (backedUp) {
      try {
        if (await exists(fsOps, targetPath)) {
          failedTargetPath = uniqueSibling(targetPath, "failed");
          await retryTransient(() => fsOps.rename(targetPath, failedTargetPath), { retries, backoffMs, sleep });
        }
        await retryTransient(() => fsOps.rename(backupPath, targetPath), { retries, backoffMs, sleep });
        backedUp = false;
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
        error.message = `${error.message}; rollback failed: ${rollbackError.message}`;
      }
    }
    throw error;
  } finally {
    if (!promoted) await removeBestEffort(fsOps, incomingPath, retryOptions);
    if (!backedUp) await removeBestEffort(fsOps, failedTargetPath, retryOptions);
    if (!backedUp) await removeBestEffort(fsOps, backupPath, retryOptions);
  }
}

export async function atomicWriteFile(targetPath, data, encoding = "utf-8", options = {}) {
  const fsOps = options.fs || fs;
  const incomingPath = options.incomingPath || uniqueSibling(targetPath, "incoming");
  await fsOps.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    if (typeof fsOps.open === "function") {
      const handle = await fsOps.open(incomingPath, "wx");
      try {
        await handle.writeFile(data, encoding);
        if (typeof handle.sync === "function") await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await fsOps.writeFile(incomingPath, data, encoding);
    }
    return await replaceFileAtomic(incomingPath, targetPath, options);
  } catch (error) {
    const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : 4;
    const backoffMs = Number.isFinite(options.backoffMs) ? Math.max(0, options.backoffMs) : 20;
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    await removeBestEffort(fsOps, incomingPath, { retries, backoffMs, sleep });
    throw error;
  }
}

export async function atomicWriteJson(targetPath, value, options = {}) {
  return atomicWriteFile(targetPath, JSON.stringify(value, null, 2), "utf-8", options);
}
