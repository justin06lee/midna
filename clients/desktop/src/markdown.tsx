import { Fragment, type ReactNode } from "react";
import { openUrl } from "./host";

/**
 * The little Markdown models write — paragraphs, lists, bold, italics, code,
 * links, the odd heading — as React elements. Never HTML: what midna writes
 * can quote an email or a web page, and none of that gets to be markup.
 */
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
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,6}\s|\s*[-*•]\s+|\s*\d+[.)]\s+)/.test(lines[i]!)) para.push(lines[i++]!);
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

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((?:https?:\/\/|tg:\/\/)[^)\s]+\))|(https?:\/\/[^\s)]+)|((?:^|[\s(])_[^_\n]+_(?=[\s).,!?:;]|$))/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const [tok] = m;
    if (m[1]) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
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
