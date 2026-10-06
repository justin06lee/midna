import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createToolServer, type ToolContext } from "./tools.ts";

/**
 * Serve one MCP request statelessly: a fresh server per request, bound to
 * the episode that made it so every tool call lands in the audit log under
 * the right episode.
 */
export async function handleMcp(request: Request, ctx: ToolContext): Promise<Response> {
  const server = createToolServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}
