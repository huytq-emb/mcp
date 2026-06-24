import { PUBLIC_TOOL_DEFINITIONS } from "./tool-definitions.js";
import {
  HIDDEN_COMPATIBILITY_TOOL_NAMES,
  createToolRegistry,
} from "./registry.js";
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
    expectedAdvertisedCount: 63,
  });
}
