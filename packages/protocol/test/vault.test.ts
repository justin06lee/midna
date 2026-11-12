import { expect, test } from "bun:test";
import { VaultEntry, VaultPatch, vaultMatches, vaultSite, type VaultItem } from "../src/index.ts";

const item = (id: string, title: string, username: string | null = null, url: string | null = null): VaultItem => ({ id, title, username, url, shared: false, updatedAt: null });

test("a login's website shows as its host name", () => {
  expect(vaultSite("https://www.github.com/login")).toBe("github.com");
  expect(vaultSite("netflix.com")).toBe("netflix.com");
  expect(vaultSite("not a url")).toBe("not a url");
  expect(vaultSite(null)).toBeNull();
});

test("finding in the list looks at title, username and website, in any case", () => {
  const items = [item("1", "GitHub", "justin06lee", "https://github.com"), item("2", "Bank", "j"), item("3", "Router", null, "http://192.168.0.1")];
  expect(vaultMatches(items, "").map((i) => i.id)).toEqual(["1", "2", "3"]);
  expect(vaultMatches(items, "  GIT ").map((i) => i.id)).toEqual(["1"]);
  expect(vaultMatches(items, "192.168").map((i) => i.id)).toEqual(["3"]);
});

test("a new login needs a title and a password; a change needs something to change", () => {
  expect(VaultEntry.safeParse({ title: " GitHub ", password: "p" }).data).toEqual({ title: "GitHub", password: "p" });
  expect(VaultEntry.safeParse({ title: "", password: "p" }).success).toBe(false);
  expect(VaultEntry.safeParse({ title: "x", password: "" }).success).toBe(false);
  expect(VaultPatch.safeParse({}).success).toBe(false);
  expect(VaultPatch.safeParse({ username: "" }).success).toBe(true); // clears it
});
