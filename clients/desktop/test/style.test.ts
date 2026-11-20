import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "..", "src", "style.css"), "utf8");
/** The declarations of the rule with exactly this selector. */
const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";

// The page's own background, ink, type size and no-selection are the body's; the windows over the screen (the pill,
// the approval panel) are the same page with a see-through body. One edit once gave the body's rules to the pill's
// selector: the app then drew light text on the window's own pale colour in dark mode, and the pill's window went solid.
test("the body carries the page's colours and type, and the overlay windows are see-through", () => {
  expect(rule("body")).toContain("background: var(--bg);");
  expect(rule("body")).toContain("color: var(--ink);");
  expect(rule("body")).toContain("font-size: 13px;");
  expect(rule("body")).toContain("user-select: none;");
  expect(rule("html.pill, html.pill body").trim()).toBe("background: transparent;");
});

test("light and dark name the same things, and dark is written the same both times", () => {
  const names = (block: string) => [...block.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]).sort();
  const light = /:root \{([^}]*)\}/.exec(css)![1]!;
  const media = /:root:not\(\.light\) \{([^}]*)\}/.exec(css)![1]!;
  const klass = /:root\.dark \{([^}]*)\}/.exec(css)![1]!;
  const dark = (block: string) => block.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  expect(dark(media)).toBe(dark(klass));
  // Dark may leave out what is the same in both (the primary follows the accent; no panel shadow).
  for (const n of names(media)) expect(names(light)).toContain(n);
});
