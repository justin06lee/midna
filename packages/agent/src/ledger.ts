import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Ledger } from "@midna/protocol";
import { z } from "zod";

/**
 * The user's money: King of Greed (`kog`), a halal ledger the user and
 * their agent both keep. Where its CLI is installed and set up, midna's
 * brain gets `kog mcp` as a second MCP server beside midna's own; where it
 * isn't, nothing of it shows. The tools are kog's, and so is what they
 * record; midna itself only reads the ledger, for the apps' Money view
 * (readLedger), and never writes to it.
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

// ── reading the ledger for the apps ──────────────────────────────────────

/** kog could not be asked, or did not answer. */
export class LedgerError extends Error {}

const READ_TIMEOUT_MS = 30_000;
/** How many of the latest entries the apps are handed. */
export const LEDGER_RECENT = 60;

/** One `kog … --json` call: what it printed, parsed. A failure says what kog said. */
async function kogJson(command: string, args: string[]): Promise<unknown> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([command, ...args, "--json"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  } catch (err) {
    throw new LedgerError(`kog couldn't be run: ${(err as Error).message}`);
  }
  const timer = setTimeout(() => child.kill(), READ_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited]);
    if (code !== 0) throw new LedgerError((err.trim() || out.trim() || `kog ${args[0]} exited ${code}`).split("\n")[0]!.slice(0, 300));
    return JSON.parse(out);
  } catch (err) {
    if (err instanceof LedgerError) throw err;
    throw new LedgerError(`kog ${args[0]} didn't answer in JSON`);
  } finally {
    clearTimeout(timer);
  }
}

// kog's own shapes (its src/ledger.ts and src/halal.ts), read leniently: it is another program's output, and a
// field it drops or renames must cost the apps that field, not the whole view.
const text = z.string().catch("");
const num = z.number().catch(0);
const sums = z.record(z.string(), z.number()).catch({});
const list = <T extends z.ZodType>(item: T) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((rows) => rows.flatMap((row) => ((parsed) => (parsed.success ? [parsed.data as z.output<T>] : []))(item.safeParse(row))));
const KogAccount = z.object({ name: z.string(), kind: z.enum(["asset", "owed", "debt"]).catch("asset"), currency: z.string(), balance: z.number(), person: z.string().optional().catch(undefined) });
const KogStatus = z.object({
  name: text,
  accounts: list(KogAccount),
  worth: z.object({ total: num, currency: z.string().catch("KRW"), missingRates: z.array(z.string()).catch([]) }),
  owed: list(z.object({ person: z.string(), amount: z.number(), currency: z.string() })),
  month: z.object({ month: text, count: num, spent: sums, earned: sums, categories: list(z.object({ name: z.string(), currency: z.string(), amount: z.number() })) }),
});
const KogBudgets = list(z.object({ name: z.string(), limit: z.number(), spent: num, left: z.number(), currency: z.string() }));
const KogRiba = z.object({ received: sums, paid: sums, purified: sums, toPurify: sums });
const KogZakat = z.object({
  wealth: z.number(),
  currency: z.string(),
  nisab: z.object({ value: z.number() }).optional().catch(undefined),
  aboveNisab: z.boolean().optional().catch(undefined),
  hawl: z.object({ dueOn: z.string().optional().catch(undefined), daysLeft: z.number().optional().catch(undefined), due: z.number().optional().catch(undefined) }).catch({}),
});
const KogEntry = z.object({
  id: z.coerce.string(),
  date: z.string(),
  kind: z.enum(["spend", "earn", "move", "lend", "repay", "opening"]),
  amount: z.number(),
  currency: z.string(),
  description: text,
  account: text,
  other: text,
  category: z.string().optional().catch(undefined),
  for: z.string().optional().catch(undefined),
  riba: z.enum(["received", "paid"]).optional().catch(undefined),
  via: z.string().optional().catch(undefined),
});

/** Undefined fields left out, so what goes over the wire is what the type says. */
const lean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * What the apps' Money view shows, read from kog's own commands (each takes
 * --json). `kog status` is the one that must answer; budgets, interest,
 * zakat and the latest entries each come empty when their command fails,
 * since a ledger with no metal price still has balances to show.
 */
export async function readLedger(command: string, ask: (command: string, args: string[]) => Promise<unknown> = kogJson, now: () => number = Date.now): Promise<Ledger> {
  const soft = <T>(work: Promise<T>, fallback: T) => work.catch(() => fallback);
  const [status, budgets, riba, zakat, recent] = await Promise.all([
    ask(command, ["status"]).then((raw) => {
      const parsed = KogStatus.safeParse(raw);
      if (!parsed.success) throw new LedgerError("kog status answered in a shape midna doesn't know");
      return parsed.data;
    }),
    soft(ask(command, ["budget"]).then((raw) => KogBudgets.parse(raw)), []),
    soft(ask(command, ["riba"]).then((raw) => KogRiba.parse(raw)), { received: {}, paid: {}, purified: {}, toPurify: {} }),
    soft(ask(command, ["zakat"]).then((raw) => KogZakat.parse(raw)), null),
    soft(ask(command, ["list", "-n", String(LEDGER_RECENT)]).then((raw) => list(KogEntry).parse(raw)), []),
  ]);
  return {
    name: status.name,
    worth: status.worth,
    accounts: status.accounts.map(lean),
    owed: status.owed,
    month: status.month,
    budgets,
    riba,
    zakat: zakat && lean({ wealth: zakat.wealth, currency: zakat.currency, nisab: zakat.nisab?.value, aboveNisab: zakat.aboveNisab, dueOn: zakat.hawl.dueOn, daysLeft: zakat.hawl.daysLeft, due: zakat.hawl.due }),
    recent: recent.map(lean).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    at: now(),
  };
}

/**
 * The ledger for the apps, remembered a few seconds: several screens (and
 * both of a user's devices) ask at once, and each read is five runs of the
 * CLI. One read at a time; `fresh` waits for a new one.
 */
export function ledgerReader(read: (command: string) => Promise<Ledger> = readLedger, keepMs = 10_000, now: () => number = Date.now) {
  let last: { command: string; ledger: Ledger; at: number } | null = null;
  let reading: Promise<Ledger> | null = null;
  return async (command: string, fresh = false): Promise<Ledger> => {
    if (!fresh && last && last.command === command && now() - last.at < keepMs) return last.ledger;
    reading ??= read(command)
      .then((ledger) => ((last = { command, ledger, at: now() }), ledger))
      .finally(() => (reading = null));
    return reading;
  };
}
