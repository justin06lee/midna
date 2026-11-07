/**
 * midna's markdown as blocks, for markdown.tsx to draw: paragraphs, headings,
 * bullet and numbered lists (nested), quotes, rules, fenced code and simple
 * tables. Kept free of React Native so it can be tested under bun.
 */

export type Align = "left" | "center" | "right";

export type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; text: string }
  | { t: "hr" }
  | { t: "list"; items: Item[] }
  | { t: "table"; head: string[]; align: Align[]; rows: string[][] };
export interface Item {
  ordered: boolean;
  n: number;
  text: string;
  indent: number;
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const ITEM = /^(\s*)(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/;
/** A table's second line: |---|:--:|--:| (the outer pipes optional). */
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A table row's cells: split on pipes not escaped, outer pipes dropped. */
export function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** A table starting at line i: a header row, then a delimiter row with as many columns. */
function tableAt(lines: string[], i: number): { head: string[]; align: Align[] } | null {
  const head = lines[i]!;
  const delim = lines[i + 1];
  if (delim === undefined || !head.includes("|") || !delim.includes("-") || !DELIMITER.test(delim)) return null;
  const names = cells(head);
  const marks = cells(delim);
  if (names.length !== marks.length) return null;
  const align = marks.map((m): Align => (m.startsWith(":") && m.endsWith(":") ? "center" : m.endsWith(":") ? "right" : "left"));
  return { head: names, align };
}

export function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!.slice(0, 3)); i++) body.push(lines[i]!);
      out.push({ t: "code", lang: fence[2]!, text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const table = tableAt(lines, i);
    if (table) {
      flush();
      const width = table.head.length;
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.trim() && lines[i]!.includes("|"); i++) {
        const row = cells(lines[i]!).slice(0, width);
        while (row.length < width) row.push("");
        rows.push(row);
      }
      i--;
      out.push({ t: "table", ...table, rows });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      out.push({ t: "h", level: h[1]!.length, text: h[2]! });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ t: "hr" });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const q: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) q.push(lines[i]!.replace(/^\s*>\s?/, ""));
      i--;
      out.push({ t: "quote", text: q.join("\n") });
      continue;
    }
    const it = ITEM.exec(line);
    if (it) {
      flush();
      const last = out[out.length - 1];
      const list = last?.t === "list" ? last : { t: "list" as const, items: [] };
      if (list !== last) out.push(list);
      list.items.push({ ordered: !it[2], n: Number(it[3] ?? 0), text: it[4]!, indent: Math.floor(it[1]!.replace(/\t/g, "  ").length / 2) });
      continue;
    }
    // A wrapped continuation of the last list item.
    const last = out[out.length - 1];
    if (!para.length && last?.t === "list" && /^\s+\S/.test(line) && lines[i - 1]?.trim()) {
      last.items[last.items.length - 1]!.text += `\n${line.trim()}`;
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

/** Characters as wide as two: Hangul, CJK and full-width forms. */
const WIDE = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;

/**
 * A width for each column, from its longest cell: a table can't measure its
 * text before it draws, and rows of fixed-width cells stay lined up. A long
 * cell wraps inside the widest a column gets; the table scrolls sideways.
 */
export function columnWidths(head: string[], rows: string[][], fontSize: number, pad: number, max = 240, min = 44): number[] {
  const units = (s: string) => {
    let n = 1;
    // Code is drawn in mono, wider than the system font.
    const prose = s.replace(/`([^`]*)`/g, (_, code: string) => ((n += code.length * 1.25), ""));
    for (const ch of prose.replace(/[*_~]|\]\([^)]*\)|\[/g, "")) n += WIDE.test(ch) ? 1.85 : 1;
    return n;
  };
  return head.map((h, c) => {
    const longest = Math.max(units(h) * 1.06, ...rows.map((r) => units(r[c] ?? "")));
    return Math.round(Math.min(max, Math.max(min, longest * fontSize * 0.54 + pad * 2 + 2)));
  });
}
