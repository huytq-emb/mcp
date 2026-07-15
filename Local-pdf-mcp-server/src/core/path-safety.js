import path from "path";
import fs from "node:fs/promises";

export function ensureDirectPdfFilename(filename) {
  if (!filename || typeof filename !== "string") {
    throw new Error("filename is required");
  }

  const value = filename.trim();
  if (!value.toLowerCase().endsWith(".pdf")) {
    throw new Error("Only .pdf files are allowed");
  }

  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..") ||
    path.basename(value) !== value
  ) {
    throw new Error("Invalid filename. Only files directly inside the documents folder are allowed.");
  }

  return value;
}

export function ensureInsideRoot(candidatePath, rootDir, what = "path") {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedCandidate;
  }

  throw new Error(`Invalid ${what} path`);
}

export async function ensureRegularFileInsideRoot(candidatePath, rootDir, what = "file", fsOps = fs) {
  const lexicalPath = ensureInsideRoot(candidatePath, rootDir, what);
  const entry = await fsOps.lstat(lexicalPath);
  if (entry.isSymbolicLink()) {
    throw new Error(`Invalid ${what} path: symbolic links and reparse points are not allowed`);
  }
  if (!entry.isFile()) throw new Error(`Invalid ${what} path: expected a regular file`);

  const [realRoot, realCandidate] = await Promise.all([
    fsOps.realpath(rootDir),
    fsOps.realpath(lexicalPath),
  ]);
  ensureInsideRoot(realCandidate, realRoot, what);
  return lexicalPath;
}

export function safeArtifactPath(rootDir, filename, suffix, what = "artifact") {
  const safeName = ensureDirectPdfFilename(filename);
  return ensureInsideRoot(path.join(rootDir, `${safeName}${suffix}`), rootDir, what);
}
