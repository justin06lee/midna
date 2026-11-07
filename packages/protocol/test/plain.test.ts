import { expect, test } from "bun:test";
import { plainText } from "../src/plain.ts";

test("a notification's markdown becomes the words alone", () => {
  const md = [
    "Nova, Thursday: Lead and I both say keep the current live demo.",
    "",
    '- **Loans:** live already has "대출" right under the amount on all 7 loans.',
    "- See [the preview](https://nova.example/preview) and `bun run check`.",
    "1. Practice run #1 (after Dhuhr), *out loud*.",
    "> quoted from the email",
  ].join("\n");
  expect(plainText(md)).toBe(
    [
      "Nova, Thursday: Lead and I both say keep the current live demo.",
      "",
      '• Loans: live already has "대출" right under the amount on all 7 loans.',
      "• See the preview and bun run check.",
      "1. Practice run #1 (after Dhuhr), out loud.",
      "quoted from the email",
    ].join("\n"),
  );
});

test("headings, rules, strike, underscores, escapes and angle links", () => {
  expect(plainText("## Today\n\n---\n~~old~~ __new__ _now_ \\*literally\\* <https://midna.example>")).toBe("Today\n\nold new now *literally* https://midna.example");
});

test("a table becomes a line a row, its cells joined", () => {
  expect(plainText("| Model | Price |\n|---|--:|\n| Opus | $15 |\n| Haiku | $1 |")).toBe("Model · Price\nOpus · $15\nHaiku · $1");
});

test("code keeps its lines; only the fences go", () => {
  expect(plainText("Run:\n```sh\nmidna status --json\n# a comment, not a heading\n```\nDone.")).toBe("Run:\nmidna status --json\n# a comment, not a heading\nDone.");
});

test("words that only look like marks stay", () => {
  expect(plainText("2 * 3 * 4, snake_case_name, a_b, 5*6")).toBe("2 * 3 * 4, snake_case_name, a_b, 5*6");
  expect(plainText("Plain text, nothing to do.")).toBe("Plain text, nothing to do.");
});
