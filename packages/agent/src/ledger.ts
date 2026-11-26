import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * The user's money: King of Greed (`kog`), a halal ledger the user and
 * their agent both keep. Where its CLI is installed and set up, midna's
 * brain gets `kog mcp` as a second MCP server beside midna's own; where it
 * isn't, nothing of it shows. midna never reads the ledger itself: the tools
 * are kog's, and so is what they record.
 */

/** Where the CLI is when it is installed: the same place as ghostly's. */
export const kogCommand = (home: string) => join(home, ".local/bin/kog");

/** How long a "not set up" answer stands before `kog status` is asked again. */
const RECHECK_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;

/** `kog status` exits 0 once `kog init` has run and the ledger answers. */
async function kogStatus(command: string): Promise<boolean> {
  try {
    const child = Bun.spawn([command, "status"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), STATUS_TIMEOUT_MS);
    return (await child.exited.finally(() => clearTimeout(timer))) === 0;
  } catch {
    // Not runnable: no bun on the PATH for its shebang, say.
    return false;
  }
}

/**
 * Whether the ledger is there, asked before each turn. Once `kog status`
 * has said yes it stays yes while the CLI is installed: the system prompt
 * and the brain's tools must not flip because the ledger's server was slow
 * for a moment (a call then fails and says so). A no is asked again after a
 * minute, so a ledger set up while midna runs is found without a restart.
 */
export function ledgerWatch(command: string | null, status: (command: string) => Promise<boolean> = kogStatus, now: () => number = Date.now): () => Promise<string | null> {
  let ready = false;
  let asked = -Infinity;
  let asking: Promise<boolean> | null = null;
  return async () => {
    if (!command || !existsSync(command)) {
      ready = false;
      return null;
    }
    if (ready) return command;
    if (now() - asked < RECHECK_MS) return null;
    asking ??= status(command).finally(() => {
      asked = now();
      asking = null;
    });
    ready = await asking;
    return ready ? command : null;
  };
}

/**
 * `kog mcp` speaks MCP over stdio, which Claude Code starts itself. The
 * other harnesses take only HTTP servers, so for them the daemon answers
 * here: each request starts `kog mcp`, hands it the list or the call, and
 * stops it. Stateless, like midna's own tools; a ledger call is rare enough
 * that starting the CLI each time doesn't matter.
 */
export async function handleLedgerMcp(request: Request, command: string): Promise<Response> {
  let kog: Client | null = null;
  const open = async () => {
    if (kog) return kog;
    const client = new Client({ name: "midna", version: "1" });
    await client.connect(new StdioClientTransport({ command, args: ["mcp"], env: process.env as Record<string, string>, stderr: "ignore" }));
    return (kog = client);
  };
  const server = new Server({ name: "kog", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (req) => (await open()).listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, async (req) => (await open()).callTool(req.params));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
    void (kog as Client | null)?.close();
  }
}
