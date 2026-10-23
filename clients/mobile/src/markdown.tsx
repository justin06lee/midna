import { memo, useMemo, useState, type ReactNode } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { mono, useTheme, type Theme } from "./theme";

/**
 * Markdown for midna's messages, small and in-house: paragraphs, headings,
 * bullet and numbered lists (nested), quotes, rules, fenced code (scrolls
 * sideways, copies), and inline bold, italic, strike, code and links. Text is
 * selectable; anything it doesn't know stays as plain text.
 */

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; text: string }
  | { t: "hr" }
  | { t: "list"; items: Item[] };
interface Item {
  ordered: boolean;
  n: number;
  text: string;
  indent: number;
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const ITEM = /^(\s*)(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/;

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

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w])|\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?[^)]*\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function openLink(url: string) {
  void Linking.openURL(url).catch(() => {});
}

function inline(text: string, t: Theme, key = ""): ReactNode[] {
  const nodes: ReactNode[] = [];
  let at = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) nodes.push(text.slice(at, m.index));
    const k = `${key}${n++}`;
    if (m[2] !== undefined) {
      nodes.push(
        <Text key={k} style={[s.inlineCode, { backgroundColor: t.sunken, color: t.ink }]}>
          {m[2].trim()}
        </Text>,
      );
    } else if (m[3] !== undefined || m[4] !== undefined) {
      nodes.push(
        <Text key={k} style={s.bold}>
          {inline((m[3] ?? m[4])!, t, `${k}.`)}
        </Text>,
      );
    } else if (m[5] !== undefined) {
      nodes.push(
        <Text key={k} style={s.strike}>
          {inline(m[5], t, `${k}.`)}
        </Text>,
      );
    } else if (m[6] !== undefined || m[7] !== undefined) {
      nodes.push(
        <Text key={k} style={s.italic}>
          {inline((m[6] ?? m[7])!, t, `${k}.`)}
        </Text>,
      );
    } else if (m[8] !== undefined) {
      const url = m[9]!;
      nodes.push(
        <Text key={k} accessibilityRole="link" onPress={() => openLink(url)} style={[s.link, { color: t.ink, textDecorationColor: t.dim }]}>
          {inline(m[8], t, `${k}.`)}
        </Text>,
      );
    } else {
      const url = m[10]!;
      nodes.push(
        <Text key={k} accessibilityRole="link" onPress={() => openLink(url)} style={[s.link, { color: t.ink, textDecorationColor: t.dim }]}>
          {url}
        </Text>,
      );
    }
    at = m.index + m[0].length;
  }
  if (at < text.length) nodes.push(text.slice(at));
  return nodes;
}

function Code({ text, lang }: { text: string; lang: string }) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await Clipboard.setStringAsync(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <View style={[s.codeBox, { backgroundColor: t.sunken, borderColor: t.line }]}>
      <View style={s.codeBar}>
        <Text style={[s.codeLang, { color: t.dimmer }]}>{lang}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy code" hitSlop={10} onPress={() => void copy()}>
          <Text style={[s.codeCopy, { color: t.dim }]}>{copied ? "Copied" : "Copy"}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.codeScroll}>
        <Text selectable style={[s.codeText, { color: t.ink }]}>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

const HEADING = [22, 20, 18, 17, 16, 16];

/** A message's text as markdown, in the ink and size of the surrounding message text. */
export const Markdown = memo(function Markdown({ text, size = 16, lineHeight = 23 }: { text: string; size?: number; lineHeight?: number }) {
  const t = useTheme();
  const blocks = useMemo(() => parse(text), [text]);
  const base = { fontSize: size, lineHeight, color: t.ink };
  return (
    <View style={s.root}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return (
              <Text key={i} selectable style={base}>
                {inline(b.text, t)}
              </Text>
            );
          case "h":
            return (
              <Text key={i} selectable style={[base, s.bold, { fontSize: HEADING[b.level - 1]! * (size / 16), lineHeight: HEADING[b.level - 1]! * (size / 16) * 1.3, marginTop: i ? 4 : 0, letterSpacing: -0.2 }]}>
                {inline(b.text, t)}
              </Text>
            );
          case "code":
            return <Code key={i} text={b.text} lang={b.lang} />;
          case "quote":
            return (
              <View key={i} style={[s.quote, { borderLeftColor: t.line2 }]}>
                <Text selectable style={[base, { color: t.ink2 }]}>
                  {inline(b.text, t)}
                </Text>
              </View>
            );
          case "hr":
            return <View key={i} style={[s.hr, { backgroundColor: t.line2 }]} />;
          case "list": {
            const floor = Math.min(...b.items.map((x) => x.indent));
            const counts: number[] = [];
            return (
              <View key={i} style={s.list}>
                {b.items.map((x, j) => {
                  const depth = x.indent - floor;
                  counts.length = depth + 1;
                  counts[depth] = x.ordered ? (counts[depth] ? counts[depth]! + 1 : x.n || 1) : 0;
                  return (
                    <View key={j} style={[s.item, { paddingLeft: Math.min(depth, 4) * 18 }]}>
                      <Text style={[base, s.marker, { color: t.dim }]}>{x.ordered ? `${counts[depth]}.` : depth % 2 ? "◦" : "•"}</Text>
                      <Text selectable style={[base, s.itemText]}>
                        {inline(x.text, t)}
                      </Text>
                    </View>
                  );
                })}
              </View>
            );
          }
        }
      })}
    </View>
  );
});

const s = StyleSheet.create({
  root: { gap: 8, alignSelf: "stretch" },
  bold: { fontWeight: "600" },
  italic: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  link: { textDecorationLine: "underline" },
  inlineCode: { fontFamily: mono, fontSize: 14.5 },
  list: { gap: 3 },
  item: { flexDirection: "row", gap: 7 },
  marker: { minWidth: 18, textAlign: "right" },
  itemText: { flex: 1 },
  quote: { borderLeftWidth: 2.5, paddingLeft: 12 },
  hr: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  codeBox: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  codeBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 12, paddingTop: 7 },
  codeLang: { fontSize: 11.5, fontFamily: mono },
  codeCopy: { fontSize: 12.5, fontWeight: "500" },
  codeScroll: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 11 },
  codeText: { fontFamily: mono, fontSize: 13, lineHeight: 19 },
});

export type { Block };
