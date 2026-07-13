import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";
import { ensureDirectPdfFilename, ensureInsideRoot } from "./path-safety.js";

function safeJobId(jobId) {
  const value = String(jobId || "").trim();
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new Error(`Invalid background job id: ${jobId || "<empty>"}`);
  }
  return value;
}

export function createPathResolver(config = DEFAULT_RUNTIME_CONFIG, pathImpl = path) {
  if (!config?.rootDir || !config?.paths) throw new Error("Runtime config with rootDir and paths is required");
  const rootDir = pathImpl.resolve(config.rootDir);
  const roots = Object.freeze({
    rootDir,
    documentsDir: pathImpl.resolve(config.paths.documentsDir),
    indexDir: pathImpl.resolve(config.paths.indexDir),
    evalDir: pathImpl.resolve(config.paths.evalDir),
    evalProfilesDir: pathImpl.resolve(config.paths.evalProfilesDir),
    evalFixturesDir: pathImpl.resolve(config.paths.evalFixturesDir),
    driverProfilesDir: pathImpl.resolve(config.paths.driverProfilesDir),
    driverProfileFragmentsDir: pathImpl.resolve(config.paths.driverProfileFragmentsDir),
    rendersDir: pathImpl.resolve(config.paths.rendersDir),
    pythonWorkerDir: pathImpl.resolve(config.paths.pythonWorkerDir),
    pythonVenvDir: pathImpl.resolve(config.paths.pythonVenvDir),
    pythonWorkerTempDir: pathImpl.resolve(config.paths.pythonWorkerTempDir),
  });

  for (const [name, value] of Object.entries(roots)) {
    if (name !== "rootDir") ensureInsideRoot(value, rootDir, `runtime ${name}`);
  }

  const pdfArtifact = (filename, suffix, what) => {
    ensureDirectPdfFilename(filename);
    return ensureInsideRoot(pathImpl.join(roots.indexDir, `${filename}${suffix}`), roots.indexDir, what);
  };

  return Object.freeze({
    roots,
    root: () => roots.rootDir,
    documentsDir: () => roots.documentsDir,
    indexDir: () => roots.indexDir,
    evalDir: () => roots.evalDir,
    evalProfilesDir: () => roots.evalProfilesDir,
    evalFixturesDir: () => roots.evalFixturesDir,
    driverProfilesDir: () => roots.driverProfilesDir,
    driverProfileFragmentsDir: () => roots.driverProfileFragmentsDir,
    rendersDir: () => roots.rendersDir,
    pythonWorkerDir: () => roots.pythonWorkerDir,
    pythonVenvDir: () => roots.pythonVenvDir,
    pythonWorkerTempDir: () => roots.pythonWorkerTempDir,
    appEntry: () => ensureInsideRoot(pathImpl.join(rootDir, "index.js"), rootDir, "server entry point"),
    pdf: (filename) => {
      ensureDirectPdfFilename(filename);
      return ensureInsideRoot(pathImpl.join(roots.documentsDir, filename), roots.documentsDir, "PDF");
    },
    chunkIndex: (filename) => pdfArtifact(filename, ".index.json", "index"),
    pages: (filename) => pdfArtifact(filename, ".pages.json", "pages cache"),
    pagesPartial: (filename) => pdfArtifact(filename, ".pages.partial.json", "partial pages cache"),
    sections: (filename) => pdfArtifact(filename, ".sections.json", "sections index"),
    tables: (filename) => pdfArtifact(filename, ".tables.json", "tables index"),
    tablesPartial: (filename) => pdfArtifact(filename, ".tables.partial.json", "partial tables index"),
    registers: (filename) => pdfArtifact(filename, ".registers.json", "registers index"),
    bitfields: (filename) => pdfArtifact(filename, ".bitfields.json", "bitfields index"),
    sequences: (filename) => pdfArtifact(filename, ".sequences.json", "sequences index"),
    cautions: (filename) => pdfArtifact(filename, ".cautions.json", "cautions index"),
    figures: (filename) => pdfArtifact(filename, ".figures.json", "figures index"),
    figureLookup: (filename) => pdfArtifact(filename, ".figures.lookup.json", "figures lookup index"),
    evidenceGraph: (filename) => pdfArtifact(filename, ".evidence-graph.json", "evidence graph"),
    manifest: (filename) => pdfArtifact(filename, ".manifest.json", "artifact manifest"),
    jobsDir: () => ensureInsideRoot(pathImpl.join(roots.indexDir, "jobs"), roots.indexDir, "jobs directory"),
    job: (jobId) => ensureInsideRoot(pathImpl.join(roots.indexDir, "jobs", `${safeJobId(jobId)}.json`), roots.indexDir, "job state"),
    jobLock: (jobId) => ensureInsideRoot(pathImpl.join(roots.indexDir, "jobs", `${safeJobId(jobId)}.lock`), roots.indexDir, "job lock"),
    legacyJobsState: () => ensureInsideRoot(pathImpl.join(roots.indexDir, ".jobs.json"), roots.indexDir, "legacy jobs state"),
    cacheDir: () => ensureInsideRoot(pathImpl.join(roots.indexDir, "cache"), roots.indexDir, "cache directory"),
  });
}

const pathResolverStorage = new AsyncLocalStorage();
const resolverDependencies = new WeakMap();
let activePathResolver = createPathResolver(DEFAULT_RUNTIME_CONFIG);

export function registerPathResolverDependencies(resolver, dependencies = {}) {
  if (!resolver?.root || !resolver?.pdf) throw new Error("A valid runtime path resolver is required");
  resolverDependencies.set(resolver, {
    fs: dependencies.fs,
    clock: dependencies.clock,
  });
  return resolver;
}

export function withPathResolver(resolver, callback) {
  if (!resolver?.root || !resolver?.pdf) throw new Error("A valid runtime path resolver is required");
  if (typeof callback !== "function") throw new Error("withPathResolver requires a callback");
  return pathResolverStorage.run(resolver, callback);
}

export function activatePathResolver(resolver) {
  if (!resolver?.root || !resolver?.pdf) throw new Error("A valid runtime path resolver is required");
  activePathResolver = resolver;
  return resolver;
}

export function getPathResolver() {
  return pathResolverStorage.getStore() || activePathResolver;
}

export function getPathResolverDependencies(resolver = getPathResolver()) {
  return resolverDependencies.get(resolver) || {};
}

export function getArtifactBuildId(resolver = getPathResolver()) {
  return String(resolver?.artifactBuildId || "");
}
