import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { VaultItem } from "@midna/protocol";
import { z } from "zod";

/**
 * The vault's tools, for Hermes (`mcp_servers.midna-vault`, which `midna
 * hermes setup` adds): find a login by its title, and — only with the user's
 * OK — its password. Finding never returns a secret. The password tool is
 * not read-only, so Hermes, which trusts this server as "untrusted", asks the
 * user before every call (its approval buttons, or midna's app during a turn
 * midna gave it). What either tool hands out is never logged: the log says
 * which login, not what is in it.
 */

export interface VaultLookup {
  find(title: string): Promise<VaultItem[]>;
  /** Throws for a login the user marked "re-prompt". */
  password(id: string): Promise<{ item: VaultItem; password: string }>;
}

const line = (i: VaultItem) => [i.title, i.username ? `user ${i.username}` : null, i.url, `id ${i.id}`].filter(Boolean).join(" · ");

export function createVaultServer(vault: VaultLookup | null, why: string, log: (line: string) => void): McpServer {
  const server = new McpServer(
    { name: "midna-vault", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Justin's password vault (ghostly, on midna's host). vault_find looks a login up by its title and never returns a password. vault_password returns one login's password and asks Justin first; use it only when you must type or hand the password over yourself, and never repeat it in a message unless he asked to see it.",
    },
  );
  const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

  server.registerTool(
    "vault_find",
    {
      description: "Find logins in Justin's vault by title (a site or service name). Returns each match's title, username, website and id — never a password.",
      inputSchema: { title: z.string().min(1).describe("The login's title, or part of it") },
      annotations: { title: "Find a login", readOnlyHint: true, openWorldHint: false },
    },
    async ({ title }) => {
      if (!vault) return text(why, true);
      try {
        const found = await vault.find(title);
        log(`vault_find "${title.slice(0, 80)}": ${found.length} found`);
        return text(found.length ? found.map(line).join("\n") : `No login titled "${title}" in the vault.`);
      } catch (err) {
        return text(`error: ${(err as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "vault_password",
    {
      description: "The password of one login in Justin's vault, by its id from vault_find (or its exact title). Justin is asked first. Use it only to type or hand the password over yourself; don't repeat it in a message unless he asked to see it.",
      inputSchema: { login: z.string().min(1).describe("The id vault_find gave, or the login's exact title") },
      annotations: { title: "Use a password", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ login }) => {
      if (!vault) return text(why, true);
      try {
        const byTitle = await vault.find(login);
        const exact = byTitle.filter((i) => i.title.toLowerCase() === login.trim().toLowerCase());
        const id = exact.length === 1 ? exact[0]!.id : login.trim();
        if (exact.length > 1) return text(`"${login}" names ${exact.length} logins; pass one id:\n${exact.map(line).join("\n")}`, true);
        const { item, password } = await vault.password(id);
        log(`vault_password: handed out the password of "${item.title}" (${item.id})`);
        return text(password);
      } catch (err) {
        return text(`error: ${(err as Error).message}`, true);
      }
    },
  );
  return server;
}

/** One MCP request, statelessly: a fresh server per request, as midna's own tools are served. */
export async function handleVaultMcp(request: Request, vault: VaultLookup | null, why: string, log: (line: string) => void): Promise<Response> {
  const server = createVaultServer(vault, why, log);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}
