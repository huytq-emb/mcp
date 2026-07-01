import { HIDDEN_COMPATIBILITY_TOOL_NAMES, HIDDEN_TOOL_DEFINITIONS, PUBLIC_TOOL_DEFINITIONS } from "./tool-definitions.js";
import { createToolRegistry } from "./registry.js";
import { createRuntimeHandlers } from "./runtime-handlers.js";

export function createRuntimeToolRegistry(options = {}) {
  const runtimeHandlers = createRuntimeHandlers(options.context);
  const handlers = Object.fromEntries(
    PUBLIC_TOOL_DEFINITIONS.map((definition) => [definition.name, runtimeHandlers[definition.name]]),
  );
  const hiddenHandlers = Object.fromEntries(
    HIDDEN_COMPATIBILITY_TOOL_NAMES.map((name) => [name, runtimeHandlers[name]]),
  );
  return createToolRegistry({
    definitions: PUBLIC_TOOL_DEFINITIONS,
    handlers,
    hiddenHandlers,
    hiddenDefinitions: HIDDEN_TOOL_DEFINITIONS,
    expectedAdvertisedCount: PUBLIC_TOOL_DEFINITIONS.length,
  });
}
