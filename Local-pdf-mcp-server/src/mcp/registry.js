import Ajv from "ajv";

export const HIDDEN_COMPATIBILITY_TOOL_NAMES = Object.freeze([
  "mcp_server_ping",
  "pdf_index_status_lite",
  "index_status",
  "rebuild_artifact",
  "cancel_job",
  "cleanup_jobs",
  "build_figures_index",
  "find_figure",
  "get_figure_context",
  "inspect_figure",
  "render_figure",
  "render_figure_page",
  "render_figure_region",
  "ocr_figure",
]);

function validateDefinition(definition) {
  if (!definition || typeof definition !== "object") throw new Error("Tool definition must be an object");
  if (!String(definition.name || "").trim()) throw new Error("Tool definition name is required");
  if (!definition.inputSchema || definition.inputSchema.type !== "object") {
    throw new Error(`Tool ${definition.name} must define an object inputSchema`);
  }
}

function formatValidationPath(error = {}) {
  if (error.instancePath) return error.instancePath;
  if (error.keyword === "required" && error.params?.missingProperty) return `/${error.params.missingProperty}`;
  if (error.keyword === "additionalProperties" && error.params?.additionalProperty) return `/${error.params.additionalProperty}`;
  return "/";
}

function formatValidationErrors(toolName, errors = []) {
  const details = (errors || []).slice(0, 6).map((error) => {
    const path = formatValidationPath(error);
    const message = error.message || "is invalid";
    return `${path} ${message}`;
  });
  return `Invalid arguments for ${toolName}: ${details.join("; ") || "/ is invalid"}`;
}

export function createToolRegistry({
  definitions = [],
  handlers = {},
  hiddenHandlers = {},
  hiddenDefinitions = [],
  expectedAdvertisedCount,
} = {}) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const publicEntries = new Map();
  const allEntries = new Map();

  for (const definition of definitions) {
    validateDefinition(definition);
    const name = String(definition.name);
    if (publicEntries.has(name)) throw new Error(`Duplicate advertised tool: ${name}`);
    const handler = handlers[name];
    if (typeof handler !== "function") throw new Error(`Missing handler for advertised tool: ${name}`);
    let validateArgs;
    try {
      validateArgs = ajv.compile(definition.inputSchema);
    } catch (error) {
      throw new Error(`Invalid inputSchema for tool ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const entry = Object.freeze({ definition, handler, validateArgs, advertised: true });
    publicEntries.set(name, entry);
    allEntries.set(name, entry);
  }

  const hiddenDefinitionMap = new Map((hiddenDefinitions || []).map((definition) => [String(definition.name), definition]));
  for (const [name, handler] of Object.entries(hiddenHandlers)) {
    if (publicEntries.has(name)) throw new Error(`Hidden tool is also advertised: ${name}`);
    if (typeof handler !== "function") throw new Error(`Missing handler for hidden tool: ${name}`);
    const definition = hiddenDefinitionMap.get(String(name));
    let validateArgs;
    if (definition?.inputSchema) {
      validateDefinition(definition);
      try { validateArgs = ajv.compile(definition.inputSchema); }
      catch (error) { throw new Error(`Invalid inputSchema for hidden tool ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    allEntries.set(String(name), Object.freeze({ definition, handler, validateArgs, advertised: false }));
  }

  if (expectedAdvertisedCount !== undefined && publicEntries.size !== expectedAdvertisedCount) {
    throw new Error(`Expected ${expectedAdvertisedCount} advertised tools, found ${publicEntries.size}`);
  }

  return Object.freeze({
    advertisedCount: publicEntries.size,
    handlerCount: allEntries.size,
    definitions: Object.freeze([...publicEntries.values()].map((entry) => entry.definition)),
    advertisedNames: Object.freeze([...publicEntries.keys()]),
    hiddenNames: Object.freeze(Object.keys(hiddenHandlers)),
    has(name) {
      return allEntries.has(String(name || ""));
    },
    async dispatchTool(name, args = {}) {
      const normalizedName = String(name || "");
      const normalizedArgs = args === undefined ? {} : args;
      const entry = allEntries.get(normalizedName);
      if (!entry) throw new Error(`Unknown tool: ${normalizedName}`);
      if (entry.validateArgs && !entry.validateArgs(normalizedArgs)) {
        throw new Error(formatValidationErrors(normalizedName, entry.validateArgs.errors));
      }
      return entry.handler(normalizedArgs || {}, { name: normalizedName });
    },
  });
}

export function validateToolRegistryContract(registry, options = {}) {
  const errors = [];
  const expectedAdvertisedCount = options.expectedAdvertisedCount;
  if (expectedAdvertisedCount !== undefined && registry.advertisedCount !== expectedAdvertisedCount) {
    errors.push(`Expected ${expectedAdvertisedCount} advertised tools, found ${registry.advertisedCount}`);
  }
  const duplicates = registry.advertisedNames.filter((name, index, names) => names.indexOf(name) !== index);
  if (duplicates.length) errors.push(`Duplicate advertised tools: ${[...new Set(duplicates)].join(", ")}`);
  for (const hiddenName of registry.hiddenNames) {
    if (registry.advertisedNames.includes(hiddenName)) errors.push(`Hidden compatibility tool is advertised: ${hiddenName}`);
  }
  return { ok: errors.length === 0, errors };
}
