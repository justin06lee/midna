import { expect, test } from "bun:test";
import { VAULT_MCP, vaultMcpConfig } from "../src/hermes.ts";

test("Hermes reaches the vault's tools through midna, with its own app token and asked first for a password", () => {
  const config = Object.fromEntries(vaultMcpConfig("http://127.0.0.1:7717/"));
  const k = `mcp_servers.${VAULT_MCP}.`;
  expect(config[`${k}url`]).toBe("http://127.0.0.1:7717/v1/vault/mcp");
  // A reference Hermes fills in from its own .env, never a token written into config.yaml.
  expect(config[`${k}headers.Authorization`]).toBe("Bearer ${MIDNA_APP_TOKEN}");
  expect(config[`${k}trust`]).toBe("untrusted");
  expect(config[`${k}enabled`]).toBe("true");
});
