import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function createRuntimeConfig(options = {}) {
  const rootDir = path.resolve(options.rootDir || DEFAULT_ROOT_DIR);
  const env = options.env || process.env;
  const config = {
    rootDir,
    serverName: options.serverName || "local-pdf-mcp-server",
    serverVersion: options.serverVersion || "7.1.0",
    step40CompatMode: "eval-health-control-plane",
    paths: {
      documentsDir: path.join(rootDir, "documents"),
      indexDir: path.join(rootDir, "indexes"),
      evalDir: path.join(rootDir, "eval"),
      evalProfilesDir: path.join(rootDir, "eval", "profiles"),
      evalFixturesDir: path.join(rootDir, "eval", "fixtures"),
      driverProfilesDir: path.join(rootDir, "driver_profiles"),
      driverProfileFragmentsDir: path.join(rootDir, "driver_profiles", "fragments"),
      rendersDir: path.join(rootDir, "renders"),
      pythonWorkerDir: path.join(rootDir, "python_worker"),
      pythonVenvDir: path.join(rootDir, ".venv"),
      pythonWorkerTempDir: path.join(rootDir, "indexes", ".workers"),
    },
    extraction: {
      mode: String(options.extractionMode || env.RENESAS_MCP_EXTRACTION_ENGINE || "auto").trim().toLowerCase(),
      pythonPath: String(options.pythonPath || env.RENESAS_MCP_PYTHON || "").trim(),
      pythonOperations: String(options.pythonOperations || env.RENESAS_MCP_PYTHON_OPERATIONS || "pdf,pages")
        .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
    },
  };

  return Object.freeze({
    ...config,
    paths: Object.freeze(config.paths),
    extraction: Object.freeze(config.extraction),
  });
}

export const DEFAULT_RUNTIME_CONFIG = createRuntimeConfig();
