import { Fragment, type ReactNode } from "react";
import { openUrl } from "./host";
import { WebImage } from "./media";

/**
 * The little Markdown models write — paragraphs, lists, bold, italics, code,
 * links, images, simple tables, the odd heading — as React elements. Never HTML: what midna
 * writes can quote an email or a web page, and none of that gets to be markup.
 */

/** An image on a line of its own: `![alt](src)`, or a bare URL of an image file. */
function imageLine(line: string): { src: string; alt: string } | null {
  const md = /^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*$/.exec(line);
  if (md) return { alt: md[1]!, src: md[2]! };
  const bare = /^\s*(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]\S*)?)\s*$/i.exec(line);
  return bare ? { alt: "", src: bare[1]! } : null;
}
/** A table row's cells: split on pipes not escaped, outer pipes dropped. A loop, not a lookbehind (older WebKit). */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") cell += s[++i];
    else if (s[i] === "|") {
      out.push(cell.trim());
      cell = "";
    } else cell += s[i];
  }
  return [...out, cell.trim()];
}

type Align = "left" | "center" | "right";

/** A table starting at line i: a header row, then a |---|:--:| row with as many columns. */
function tableAt(lines: string[], i: number): { head: string[]; align: Align[] } | null {
  const head = lines[i]!;
  const delim = lines[i + 1];
  if (delim === undefined || !head.includes("|") || !/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(delim)) return null;
  const names = cells(head);
  const marks = cells(delim);
  if (names.length !== marks.length) return null;
  return { head: names, align: marks.map((m) => (m.startsWith(":") && m.endsWith(":") ? "center" : m.endsWith(":") ? "right" : "left")) };
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) body.push(lines[i]!);
      i++;
      blocks.push(<pre key={key++}>{body.join("\n")}</pre>);
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/).test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""));
        i++;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key++}>
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const table = tableAt(lines, i);
    if (table) {
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.trim() && lines[i]!.includes("|"); i++) {
        const row = cells(lines[i]!).slice(0, table.head.length);
        while (row.length < table.head.length) row.push("");
        rows.push(row);
      }
      blocks.push(
        <div key={key++} className="md-table">
          <table>
            <thead>
              <tr>
                {table.head.map((h, c) => (
                  <th key={c} style={{ textAlign: table.align[c] }}>
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={{ textAlign: table.align[c] }}>
                      {inline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const image = imageLine(line);
    if (image) {
      blocks.push(
        <div key={key++}>
          <WebImage src={image.src} alt={image.alt} />
        </div>,
      );
      i++;
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<h3 key={key++}>{inline(heading[1]!)}</h3>);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,6}\s|\s*[-*•]\s+|\s*\d+[.)]\s+)/.test(lines[i]!) && !imageLine(lines[i]!) && !(para.length && tableAt(lines, i))) para.push(lines[i++]!);
    blocks.push(
      <p key={key++}>
        {para.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(l)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="prose-midna selectable">{blocks}</div>;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((?:https?:\/\/|tg:\/\/)[^)\s]+\))|(https?:\/\/[^\s)]+)|((?:^|[\s(])_[^_\n]+_(?=[\s).,!?:;]|$))|(!\[[^\]]*\]\([^)\s]+\))/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const [tok] = m;
    if (m[6]) {
      const [, alt, src] = /\[([^\]]*)\]\(([^)\s]+)\)$/.exec(tok)!;
      out.push(<WebImage key={k++} src={src!} alt={alt!} />);
    } else if (m[1]) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      out.push(<Link key={k++} href={href!}>{label}</Link>);
    } else if (m[4]) out.push(<Link key={k++} href={tok}>{tok}</Link>);
    else if (m[5]) {
      // The match carries the space or bracket before the underscore (no lookbehind on older WebKit).
      const lead = tok.startsWith("_") ? "" : tok[0]!;
      out.push(lead, <em key={k++}>{tok.slice(lead.length + 1, -1)}</em>);
    }
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a onClick={() => void openUrl(href)} title={href}>
      {children}
    </a>
  );
}
