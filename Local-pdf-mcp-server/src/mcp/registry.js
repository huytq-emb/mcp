export const HIDDEN_COMPATIBILITY_TOOL_NAMES = Object.freeze([
  "mcp_server_ping",
  "pdf_index_status_lite",
  "index_status",
  "rebuild_artifact",
  "cancel_job",
  "cleanup_jobs",
]);

function validateDefinition(definition) {
  if (!definition || typeof definition !== "object") throw new Error("Tool definition must be an object");
  if (!String(definition.name || "").trim()) throw new Error("Tool definition name is required");
  if (!definition.inputSchema || definition.inputSchema.type !== "object") {
    throw new Error(`Tool ${definition.name} must define an object inputSchema`);
  }
}

export function createToolRegistry({
  definitions = [],
  handlers = {},
  hiddenHandlers = {},
  expectedAdvertisedCount,
} = {}) {
  const publicEntries = new Map();
  const allHandlers = new Map();

  for (const definition of definitions) {
    validateDefinition(definition);
    const name = String(definition.name);
    if (publicEntries.has(name)) throw new Error(`Duplicate advertised tool: ${name}`);
    const handler = handlers[name];
    if (typeof handler !== "function") throw new Error(`Missing handler for advertised tool: ${name}`);
    publicEntries.set(name, Object.freeze({ definition, handler, advertised: true }));
    allHandlers.set(name, handler);
  }

  for (const [name, handler] of Object.entries(hiddenHandlers)) {
    if (publicEntries.has(name)) throw new Error(`Hidden tool is also advertised: ${name}`);
    if (typeof handler !== "function") throw new Error(`Missing handler for hidden tool: ${name}`);
    allHandlers.set(name, handler);
  }

  if (expectedAdvertisedCount !== undefined && publicEntries.size !== expectedAdvertisedCount) {
    throw new Error(`Expected ${expectedAdvertisedCount} advertised tools, found ${publicEntries.size}`);
  }

  return Object.freeze({
    advertisedCount: publicEntries.size,
    handlerCount: allHandlers.size,
    definitions: Object.freeze([...publicEntries.values()].map((entry) => entry.definition)),
    advertisedNames: Object.freeze([...publicEntries.keys()]),
    hiddenNames: Object.freeze(Object.keys(hiddenHandlers)),
    has(name) {
      return allHandlers.has(String(name || ""));
    },
    async dispatchTool(name, args = {}) {
      const normalizedName = String(name || "");
      const handler = allHandlers.get(normalizedName);
      if (!handler) throw new Error(`Unknown tool: ${normalizedName}`);
      return handler(args || {}, { name: normalizedName });
    },
  });
}

export function validateToolRegistryContract(registry, options = {}) {
  const errors = [];
  const expectedAdvertisedCount = options.expectedAdvertisedCount ?? 63;
  if (registry.advertisedCount !== expectedAdvertisedCount) {
    errors.push(`Expected ${expectedAdvertisedCount} advertised tools, found ${registry.advertisedCount}`);
  }
  const duplicates = registry.advertisedNames.filter((name, index, names) => names.indexOf(name) !== index);
  if (duplicates.length) errors.push(`Duplicate advertised tools: ${[...new Set(duplicates)].join(", ")}`);
  for (const hiddenName of registry.hiddenNames) {
    if (registry.advertisedNames.includes(hiddenName)) errors.push(`Hidden compatibility tool is advertised: ${hiddenName}`);
  }
  return { ok: errors.length === 0, errors };
}
