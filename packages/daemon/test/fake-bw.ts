#!/usr/bin/env bun
// A stand-in for `bw --response …`, just enough of it for the vault's tests
// (after ghostly's own test/fake-bw.ts). State lives in
// $BITWARDENCLI_APPDATA_DIR/fake.json; every invocation's arguments are
// appended to calls.log, so a test can check that no secret was ever on a
// command line.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.BITWARDENCLI_APPDATA_DIR!;
const statePath = join(dir, "fake.json");
const SESSION = "fake-session-key";

interface State {
  serverUrl: string | null;
  email: string;
  password: string;
  status: "unauthenticated" | "locked" | "unlocked";
  items: Record<string, unknown>[];
  collections: Record<string, unknown>[];
  /** Session keys handed out so far; an older one stops working. */
  generation: number;
  /** Collections midna may only read: creating into one fails. */
  readOnly?: string[];
}

const state = JSON.parse(readFileSync(statePath, "utf8")) as State;
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const args = process.argv.slice(2).filter((a) => a !== "--response");
appendFileSync(join(dir, "calls.log"), `${JSON.stringify(args)}\n`);

function reply(data: unknown): never {
  process.stdout.write(JSON.stringify({ success: true, data }));
  process.exit(0);
}
function fail(message: string): never {
  process.stdout.write(JSON.stringify({ success: false, message }));
  process.exit(1);
}
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const session = () => `${SESSION}-${state.generation}`;
function needSession(): void {
  if (state.status === "unauthenticated") fail("You are not logged in.");
  if (state.status !== "unlocked" || process.env.BW_SESSION !== session()) fail("Vault is locked.");
}
function passwordMatches(): boolean {
  const file = flag("--passwordfile");
  return !!file && existsSync(file) && readFileSync(file, "utf8").split("\n")[0] === state.password;
}
const decode = () => JSON.parse(Buffer.from(readFileSync(0, "utf8"), "base64").toString("utf8")) as Record<string, unknown>;

const [command, object] = args;
switch (command) {
  case "status":
    reply({ object: "template", template: { serverUrl: state.serverUrl, userEmail: state.status === "unauthenticated" ? undefined : state.email, status: state.status } });
  case "config":
    state.serverUrl = args[2] ?? null;
    save();
    reply({ object: "message", title: "Saved setting `config`." });
  case "login":
    if (object !== state.email || !passwordMatches()) fail("Username or password is incorrect. Try again");
    state.status = "unlocked";
    state.generation++;
    save();
    reply({ object: "message", title: "You are logged in!", raw: session() });
  case "unlock":
    if (state.status === "unauthenticated") fail("You are not logged in.");
    if (!passwordMatches()) fail("Invalid master password.");
    state.status = "unlocked";
    state.generation++;
    save();
    reply({ object: "message", title: "Your vault is now unlocked!", raw: session() });
  case "lock":
    if (state.status !== "unauthenticated") state.status = "locked";
    save();
    reply({ object: "message", title: "Your vault is locked." });
  case "logout":
    state.status = "unauthenticated";
    save();
    reply({ object: "message", title: "You have logged out." });
  case "sync":
    needSession();
    reply({ object: "message", title: "Syncing complete." });
  case "list":
    needSession();
    if (object === "collections") reply({ object: "list", data: state.collections });
    reply({ object: "list", data: state.items });
  case "create": {
    needSession();
    const item = decode();
    if ((item.collectionIds as string[]).some((c) => state.readOnly?.includes(c))) fail("You do not have permission to edit this.");
    Object.assign(item, { id: `new-${state.items.length + 1}`, revisionDate: "2026-11-12T01:00:00.000Z" });
    state.items.push(item);
    save();
    reply({ object: "item", ...item });
  }
  case "edit": {
    needSession();
    const item = decode();
    const i = state.items.findIndex((e) => e.id === args[2]);
    if (i === -1) fail("Not found.");
    state.items[i] = { ...item, id: args[2], revisionDate: "2026-11-12T02:00:00.000Z" };
    save();
    reply({ object: "item", ...state.items[i] });
  }
  case "delete":
    needSession();
    state.items = state.items.filter((e) => e.id !== args[2]);
    save();
    reply({ object: "message", title: "Deleted." });
  default:
    fail(`fake bw does not implement: ${args.join(" ")}`);
}
