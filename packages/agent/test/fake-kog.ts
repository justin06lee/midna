#!/usr/bin/env bun
/**
 * A stand-in for King of Greed's CLI, for tests and the preview: `status`
 * exits as FAKE_KOG_STATUS says (0 when unset), and `mcp` serves two tools
 * over stdio that keep their entries in the file FAKE_KOG_BOOK names. With
 * --json, the read commands (status, budget, riba, zakat, list -n N) print
 * what the file FAKE_KOG_LEDGER holds (fake-ledger.ts; an empty ledger when
 * unset), and a command named in FAKE_KOG_FAIL fails as kog does.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { emptyLedger } from "./fake-ledger.ts";

const [command, ...rest] = process.argv.slice(2);
const book = process.env.FAKE_KOG_BOOK ?? "/dev/null";
const entries = (): Array<{ amount: number; what: string }> => (existsSync(book) && book !== "/dev/null" ? JSON.parse(readFileSync(book, "utf8")) : []);

if (rest.includes("--json") && command && ["status", "budget", "riba", "zakat", "list"].includes(command)) {
  if (process.env.FAKE_KOG_FAIL?.split(",").includes(command) || (command === "status" && Number(process.env.FAKE_KOG_STATUS ?? 0) !== 0)) {
    console.error(`kog: ${command} could not reach the ledger's server`);
    process.exit(1);
  }
  const ledger = (process.env.FAKE_KOG_LEDGER ? JSON.parse(readFileSync(process.env.FAKE_KOG_LEDGER, "utf8")) : emptyLedger()) as Record<string, unknown>;
  const n = Number(rest[rest.indexOf("-n") + 1]);
  console.log(JSON.stringify(command === "list" && rest.includes("-n") ? (ledger.list as unknown[]).slice(0, n) : ledger[command]));
  process.exit(0);
}
if (command === "status") process.exit(Number(process.env.FAKE_KOG_STATUS ?? 0));
if (command !== "mcp") process.exit(2);

const server = new McpServer({ name: "kog", version: "0.0.0" });
server.registerTool("log_transaction", { description: "Record money spent.", inputSchema: { amount: z.number(), what: z.string() } }, async ({ amount, what }) => {
  writeFileSync(book, JSON.stringify([...entries(), { amount, what }]));
  return { content: [{ type: "text", text: `logged ${amount} ${what} via ${server.server.getClientVersion()?.name}` }] };
});
server.registerTool("list_transactions", { description: "What is in the ledger." }, async () => ({ content: [{ type: "text", text: JSON.stringify(entries()) }] }));
await server.connect(new StdioServerTransport());
