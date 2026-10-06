import { describe, expect, test } from "bun:test";
import { chunk, toHtml } from "../src/bot.ts";

describe("formatting for Telegram", () => {
  test("the Markdown models write becomes Telegram HTML", () => {
    expect(toHtml("**Today**: ship `midna` & rest")).toBe("<b>Today</b>: ship <code>midna</code> &amp; rest");
    expect(toHtml("## Plan\n- one")).toBe("<b>Plan</b>\n- one");
    expect(toHtml("see [docs](https://example.com/a?b=1&c=2)")).toBe('see <a href="https://example.com/a?b=1&amp;c=2">docs</a>');
    expect(toHtml("```ts\nconst a = 1 < 2;\n```")).toBe("<pre>const a = 1 &lt; 2;</pre>");
    expect(toHtml("snake_case_name stays")).toBe("snake_case_name stays");
  });

  test("long messages split on paragraph boundaries under the limit", () => {
    const para = "word ".repeat(150).trim();
    const parts = chunk([para, para, para].join("\n\n"), 1000);
    expect(parts.length).toBe(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1000);
    expect(chunk("x".repeat(2500), 1000).map((p) => p.length)).toEqual([1000, 1000, 500]);
  });
});
