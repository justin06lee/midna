import { memo, useMemo, useState, type ReactNode } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { columnWidths, parse, type Block } from "./blocks";
import { mono, useTheme, type Theme } from "./theme";

/**
 * Markdown for midna's messages, small and in-house: paragraphs, headings,
 * bullet and numbered lists (nested), quotes, rules, fenced code (scrolls
 * sideways, copies), simple tables (scroll sideways), and inline bold,
 * italic, strike, code and links (blocks.ts parses). Text is selectable;
 * anything it doesn't know stays as plain text.
 */

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

/** A table in a box like code's, its columns lined up; wider than the message, it scrolls sideways. */
function Table({ b, size }: { b: Extract<Block, { t: "table" }>; size: number }) {
  const t = useTheme();
  const fontSize = size - 1;
  const widths = useMemo(() => columnWidths(b.head, b.rows, fontSize, CELL_PAD), [b, fontSize]);
  const cell = { fontSize, lineHeight: Math.round(fontSize * 1.4), color: t.ink };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tableScroll}>
      <View style={[s.table, { backgroundColor: t.sunken, borderColor: t.line }]}>
        {[b.head, ...b.rows].map((row, r) => (
          <View key={r} style={[s.tableRow, r > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line2 }]}>
            {row.map((text, c) => (
              <View key={c} style={[s.tableCell, { width: widths[c] }]}>
                <Text selectable style={[cell, r === 0 && s.bold, { textAlign: b.align[c] }]}>
                  {inline(text, t, `${r}.${c}.`)}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const CELL_PAD = 12;

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
          case "table":
            return <Table key={i} b={b} size={size} />;
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
  tableScroll: { alignSelf: "stretch", flexGrow: 0 },
  table: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  tableRow: { flexDirection: "row" },
  tableCell: { paddingHorizontal: CELL_PAD, paddingVertical: 7 },
});

