import path from "path";

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

export function safeArtifactPath(rootDir, filename, suffix, what = "artifact") {
  const safeName = ensureDirectPdfFilename(filename);
  return ensureInsideRoot(path.join(rootDir, `${safeName}${suffix}`), rootDir, what);
}
