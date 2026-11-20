import { describe, expect, test } from "bun:test";
import { cells, columnWidths, fitColumns, parse } from "../src/blocks.ts";

test("a table between paragraphs: its header, alignment and rows", () => {
  const md = [
    "Prices per million tokens:",
    "",
    "| Model | Their price (in / cached / out) | Yours |",
    "|---|:---:|--:|",
    "| **Opus** | $15 / $1.50 / $75 | `$12` |",
    "| Haiku | $1 / $0.10 / $5 | $0.80 |",
    "",
    "That's all.",
  ].join("\n");
  expect(parse(md)).toEqual([
    { t: "p", text: "Prices per million tokens:" },
    {
      t: "table",
      head: ["Model", "Their price (in / cached / out)", "Yours"],
      align: ["left", "center", "right"],
      rows: [
        ["**Opus**", "$15 / $1.50 / $75", "`$12`"],
        ["Haiku", "$1 / $0.10 / $5", "$0.80"],
      ],
    },
    { t: "p", text: "That's all." },
  ]);
});

test("a table right under a line of text, without outer pipes, ends at the first line without one", () => {
  const blocks = parse("Here:\nA | B\n--- | ---\n1 | 2\n3 | 4\nAfter the table.");
  expect(blocks.map((b) => b.t)).toEqual(["p", "table", "p"]);
  expect(blocks[1]).toMatchObject({ head: ["A", "B"], rows: [["1", "2"], ["3", "4"]] });
});

test("ragged rows are evened out to the header's columns", () => {
  const [b] = parse("| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |");
  expect(b).toMatchObject({ rows: [["1", "", ""], ["1", "2", "3"]] });
});

test("an escaped pipe stays in its cell", () => {
  expect(cells("| a \\| b | c |")).toEqual(["a | b", "c"]);
});

test("not tables: a lone pipe, a rule under text, a delimiter that doesn't match the header", () => {
  expect(parse("this | that")).toEqual([{ t: "p", text: "this | that" }]);
  expect(parse("a | b\n---").map((b) => b.t)).not.toContain("table");
  expect(parse("| a | b |\n|---|").map((b) => b.t)).not.toContain("table");
  // A code block keeps its pipes.
  expect(parse("```\n| a | b |\n|---|---|\n```")).toEqual([{ t: "code", lang: "", text: "| a | b |\n|---|---|" }]);
});

test("column widths follow the longest cell, Hangul counted wide, within bounds", () => {
  const [narrow, wide, hangul, long] = columnWidths(["#", "Model", "모델", "Notes"], [["1", "Opus 4", "오퍼스", "x".repeat(300)]], 15, 12);
  expect(narrow).toBe(44);
  expect(wide!).toBeGreaterThan(narrow!);
  expect(hangul!).toBeGreaterThan(wide! - 20);
  expect(long).toBe(240);
});

describe("a table in the width it has", () => {
  test("one that fits, or has no width yet, keeps its columns", () => {
    expect(fitColumns([60, 196, 78], 400)).toEqual([60, 196, 78]);
    expect(fitColumns([60, 196, 78], 0)).toEqual([60, 196, 78]);
  });

  test("one that only just overflows is drawn to fit, so its edge isn't cut", () => {
    const fitted = fitColumns([60, 196, 78], 330);
    expect(fitted.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(330);
    expect(fitted.every((w, i) => w <= [60, 196, 78][i]! && w >= 44)).toBe(true);
  });

  test("one a good deal wider keeps its widths and scrolls", () => {
    expect(fitColumns([120, 240, 240, 120], 330)).toEqual([120, 240, 240, 120]);
  });

  test("columns already at their narrowest aren't squeezed further: it scrolls", () => {
    expect(fitColumns([44, 44, 44, 44, 44, 44, 44, 44], 340)).toEqual([44, 44, 44, 44, 44, 44, 44, 44]);
  });
});
