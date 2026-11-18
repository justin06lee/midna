import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Each Screen Time extension compiles its own copy of Focus.swift (scripts/focus-copies.sh makes them).
test("the extensions' copies of Focus.swift are the app's", () => {
  const root = join(import.meta.dir, "..");
  const app = readFileSync(join(root, "modules/midna-focus/ios/Focus.swift"), "utf8");
  for (const target of ["focus-monitor", "focus-shield", "focus-shield-action"]) {
    expect(readFileSync(join(root, "targets", target, "Focus.swift"), "utf8"), target).toBe(app);
  }
});
