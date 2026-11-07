/**
 * midna's markdown as plain text, for where nothing draws it: a push
 * notification's body, a button's label. The words stay; the marks go —
 * bold and italic markers, code ticks, a link's URL behind its words, a
 * heading's hashes, a quote's bar — lists keep a bullet, and a table's
 * cells are joined with " · ", a row a line.
 */
export function plainText(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    // Code keeps every line as written; only its fences go.
    if (fence !== null) {
      if (line.trim().startsWith(fence)) fence = null;
      else out.push(line);
      continue;
    }
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      fence = f[1]!.slice(0, 3);
      continue;
    }
    // A table's |---|:--:| line, and a rule, say nothing.
    if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    let s = line
      .replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/, "$1")
      .replace(/^(\s*)>\s?/, "$1")
      .replace(/^(\s*)[-*+]\s+\[([ xX])\]\s+/, (_, sp: string, x: string) => `${sp}${x === " " ? "☐" : "☑"} `)
      .replace(/^(\s*)[-*+]\s+/, "$1• ");
    if (/^\s*\|.*\|\s*$/.test(s))
      s = s
        .trim()
        .replace(/^\||\|$/g, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim())
        .join(" · ");
    out.push(inlinePlain(s));
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** An escaped mark (\\*) is held as a private-use character while the marks go, then put back as itself. */
const HOLD = 0xe000;

function inlinePlain(s: string): string {
  return s
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, c: string) => String.fromCharCode(HOLD + c.charCodeAt(0)))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\(\s*<?[^)\s>]+>?[^)]*\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t: string, code: string) => code.trim())
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/g, (_, a?: string, b?: string) => (a ?? b)!)
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, "$1")
    .replace(/(?<![\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w])/g, "$1")
    .replace(/[\ue000-\ue07f]/g, (c) => String.fromCharCode(c.charCodeAt(0) - HOLD));
}
