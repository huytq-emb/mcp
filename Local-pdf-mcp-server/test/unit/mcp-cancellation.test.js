import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createToolRegistry } from "../../src/mcp/registry.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { runPythonWorker } from "../../src/services/python-worker.js";

const slowTool = {
  name: "slow_tool",
  description: "Cancellation test tool",
  inputSchema: { type: "object", additionalProperties: false },
};

test("a pre-aborted registry dispatch never invokes its handler", async () => {
  let invoked = false;
  const registry = createToolRegistry({
    definitions: [slowTool],
    handlers: { slow_tool: async () => { invoked = true; return { content: [] }; } },
  });
  const controller = new AbortController();
  controller.abort("cancel before dispatch");
  await assert.rejects(
    registry.dispatchTool("slow_tool", {}, { signal: controller.signal }),
    (error) => error?.name === "AbortError" && error?.code === "MCP_REQUEST_CANCELLED",
  );
  assert.equal(invoked, false);
});

test("MCP client cancellation reaches the handler signal and bypasses error recovery", async () => {
  let observedAbort = false;
  let errorRecoveryCalls = 0;
  const started = Promise.withResolvers();
  const observed = Promise.withResolvers();
  const registry = createToolRegistry({
    definitions: [slowTool],
    handlers: {
      slow_tool: async (_args, meta) => {
        started.resolve();
        return new Promise((resolve) => {
          meta.signal.addEventListener("abort", () => {
            observedAbort = true;
            observed.resolve();
            resolve({ content: [{ type: "text", text: "cancelled" }] });
          }, { once: true });
        });
      },
    },
  });
  const server = createMcpServer({
    registry,
    serverName: "cancellation-test",
    serverVersion: "1.0.0",
    onError: () => { errorRecoveryCalls += 1; return { content: [] }; },
  });
  const client = new Client({ name: "cancellation-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const controller = new AbortController();
    const call = client.callTool({ name: "slow_tool", arguments: {} }, undefined, { signal: controller.signal });
    await started.promise;
    controller.abort("client cancelled test request");
    await assert.rejects(call, /abort|cancel/i);
    await Promise.race([
      observed.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("server did not observe cancellation")), 2_000)),
    ]);
    assert.equal(observedAbort, true);
    assert.equal(errorRecoveryCalls, 0);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

test("aborting a Python worker writes its sentinel and terminates with cancellation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "renesas-mcp-worker-abort-"));
  const cancelPath = path.join(root, "cancel.requested");
  const controller = new AbortController();
  const fakeWorker = path.resolve("test/fixtures/fake-python-worker.js");
  try {
    const pending = runPythonWorker({
      operation: "health",
      allowedRoots: [],
      outputs: { cancelPath },
      options: { mode: "delay" },
    }, {
      interpreter: { available: true, command: process.execPath, argsPrefix: [], source: "test" },
      workerArgs: [fakeWorker],
      timeoutMs: 5_000,
      signal: controller.signal,
      onSpawn: () => setTimeout(() => controller.abort("worker cancellation test"), 25),
    });
    await assert.rejects(
      pending,
      (error) => error?.name === "AbortError" && error?.code === "MCP_REQUEST_CANCELLED",
    );
    assert.match(await fs.readFile(cancelPath, "utf8"), /worker cancellation test/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
