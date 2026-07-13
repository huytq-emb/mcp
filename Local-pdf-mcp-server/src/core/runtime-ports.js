import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_PORTS = new Map();
const runtimePortStorage = new AsyncLocalStorage();
let activePorts = DEFAULT_PORTS;

export function createRuntimePortRegistry() {
  return new Map();
}

export function activateRuntimePortRegistry(registry = DEFAULT_PORTS) {
  activePorts = registry;
  return activePorts;
}

export function withRuntimePortRegistry(registry, callback) {
  if (!(registry instanceof Map)) throw new Error("A runtime port registry is required");
  if (typeof callback !== "function") throw new Error("withRuntimePortRegistry requires a callback");
  return runtimePortStorage.run(registry, callback);
}

export function bindRuntimePorts(bindings, registry = activePorts) {
  for (const [name, implementation] of Object.entries(bindings || {})) {
    if (typeof implementation !== "function") throw new Error(`Runtime port ${name} must be a function`);
    registry.set(name, implementation);
  }
  return registry;
}

export function createRuntimePort(name) {
  const portName = String(name || "");
  return (...args) => {
    const implementation = (runtimePortStorage.getStore() || activePorts).get(portName);
    if (typeof implementation !== "function") throw new Error(`Runtime port is not wired: ${portName}`);
    return implementation(...args);
  };
}
