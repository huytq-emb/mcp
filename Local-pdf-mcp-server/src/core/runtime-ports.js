const DEFAULT_PORTS = new Map();
let activePorts = DEFAULT_PORTS;

export function createRuntimePortRegistry() {
  return new Map();
}

export function activateRuntimePortRegistry(registry = DEFAULT_PORTS) {
  activePorts = registry;
  return activePorts;
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
    const implementation = activePorts.get(portName);
    if (typeof implementation !== "function") throw new Error(`Runtime port is not wired: ${portName}`);
    return implementation(...args);
  };
}
