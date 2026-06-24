import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimePortRegistry } from "./runtime-ports.js";

export function createAppContext(options = {}) {
  const config = options.config || createRuntimeConfig(options);
  const childProcess = options.childProcess || {
    execFile,
    execFileAsync: promisify(execFile),
    spawn,
  };

  return {
    config,
    fs: options.fs || fs,
    path: options.path || path,
    pdfEngine: options.pdfEngine || pdfjsLib,
    childProcess,
    clock: options.clock || {
      now: () => Date.now(),
      nowIso: () => new Date().toISOString(),
    },
    caches: options.caches || {
      json: new Map(),
      renderers: new Map(),
    },
    runtimePorts: options.runtimePorts || createRuntimePortRegistry(),
  };
}
