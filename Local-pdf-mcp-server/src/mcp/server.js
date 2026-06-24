import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export function createMcpServer({ registry, serverName, serverVersion, onError } = {}) {
  if (!registry) throw new Error("registry is required");
  const server = new Server(
    { name: serverName, version: serverVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.definitions }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      return await registry.dispatchTool(name, args);
    } catch (error) {
      if (typeof onError === "function") return onError(error, { name, args });
      throw error;
    }
  });

  return server;
}
