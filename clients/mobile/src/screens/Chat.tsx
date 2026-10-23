import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type RefObject } from "react";
import { ActionSheetIOS, ActivityIndicator, Animated, Easing, FlatList, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { APPROVAL_OPTIONS, MAX_ATTACHMENTS_PER_MESSAGE, MidnaError, type Approval, type ApprovalAnswer, type Attachment } from "@midna/protocol";
import { Attachments } from "../attachments";
import type { PhoneConnection } from "../connection";
import { draftKey, dropDraft, loadDraft, saveDraft, useDraft } from "../drafts";
import { faceId } from "../faceid";
import { Markdown } from "../markdown";
import { approvalOutcome, asksApproval, size, type Line } from "../lines";
import { useTheme } from "../theme";
import { Problem, time } from "../ui";
import type { Midna } from "../useMidna";

/** A file on its way to the host, before it is an attachment. */
interface Uploading {
  key: string;
  name: string;
}

/**
 * How far the keyboard covers the bottom of the view `ref` holds, animated
 * with the keyboard. KeyboardAvoidingView measures its frame against its
 * parent, not the window, so under a header and above a tab bar it never
 * lifts; this measures the window.
 */
type Measurable = ComponentRef<typeof View>;

function useKeyboardLift(ref: RefObject<Measurable | null>) {
  const lift = useRef(new Animated.Value(0)).current;
  const applied = useRef(0);
  const move = (to: number, ms: number) => {
    applied.current = to;
    Animated.timing(lift, { toValue: to, duration: ms || 250, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  };
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardWillChangeFrame", (e) => {
      ref.current?.measureInWindow((_x, y, _w, h) => {
        // The view's bottom without the lift already applied.
        move(Math.max(0, y + h + applied.current - e.endCoordinates.screenY), e.duration);
      });
    });
    const hide = Keyboard.addListener("keyboardWillHide", (e) => move(0, e.duration));
    return () => {
      sub.remove();
      hide.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, lift]);
  return lift;
}

/**
 * The conversation, newest at the bottom, and the composer. What is typed,
 * and the files added to it (already on the host), are a draft until midna
 * has the message: they survive switching tabs, the app being killed, and
 * a send that failed.
 */
export function Chat({ midna, connection, onOpenApprovals }: { midna: Midna; connection: PhoneConnection; onOpenApprovals: () => void }) {
  const t = useTheme();
  const key = draftKey(connection);
  const text = useDraft(key);
  const [files, setFilesState] = useState<Attachment[]>(() => loadDraft<Attachment[]>(`${key}:files`) ?? []);
  /** The files with the draft, changed from what they are now (an upload can finish while another is removed). */
  const setFiles = useCallback(
    (change: (cur: Attachment[]) => Attachment[]) =>
      setFilesState((cur) => {
        const next = change(cur);
        if (next.length) saveDraft(`${key}:files`, next);
        else dropDraft(`${key}:files`);
        return next;
      }),
    [key],
  );
  const [uploading, setUploading] = useState<Uploading[]>([]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState("");
  const root = useRef<Measurable>(null);
  const lift = useKeyboardLift(root);

  const byOutbox = useMemo(() => new Map([...midna.approvals.values()].flatMap((a) => (a.outboxId === null ? [] : [[a.outboxId, a] as const]))), [midna.approvals]);
  const data = useMemo(() => [...midna.lines].reverse(), [midna.lines]);
  const canSend = midna.link === "live";

  const submit = async () => {
    const value = text.value.trim();
    if ((!value && !files.length) || sending || uploading.length) return;
    setSending(true);
    setProblem("");
    try {
      await midna.send(value, undefined, files);
      text.clear();
      setFiles(() => []);
    } catch (err) {
      // An upload unsent for a day is gone from the host: drop it, keep the rest.
      const gone = err instanceof MidnaError && /^no attachment (\S+)/.exec(err.message)?.[1];
      if (gone) setFiles((cur) => cur.filter((f) => f.id !== gone));
      setProblem(gone ? "A file had expired on midna's side, so it was taken off. Add it again if you still want it; your message is kept." : `Couldn't send that; it's kept here. ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  const add = async (picked: Array<{ uri: string; name: string; mime: string }>) => {
    const room = MAX_ATTACHMENTS_PER_MESSAGE - files.length - uploading.length;
    if (picked.length > room) setProblem(`A message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} files.`);
    for (const p of picked.slice(0, Math.max(0, room))) {
      const u = { key: `${p.uri}#${Math.random()}`, name: p.name };
      setUploading((cur) => [...cur, u]);
      try {
        const a = await midna.upload(p.uri, { name: p.name, mime: p.mime });
        setFiles((cur) => [...cur, a]);
      } catch (err) {
        setProblem(`Couldn't put ${p.name} on midna: ${(err as Error).message}`);
      } finally {
        setUploading((cur) => cur.filter((x) => x !== u));
      }
    }
  };

  const attach = () =>
    ActionSheetIOS.showActionSheetWithOptions({ options: ["Photo or video", "File", "Cancel"], cancelButtonIndex: 2 }, async (i) => {
      if (i === 0) {
        const r = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images", "videos"],
          allowsMultipleSelection: true,
          selectionLimit: MAX_ATTACHMENTS_PER_MESSAGE,
          quality: 1,
          // HEIC becomes JPEG, so midna can see it.
          preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        });
        if (!r.canceled) await add(r.assets.map((a, n) => ({ uri: a.uri, name: a.fileName ?? `${a.type === "video" ? "video" : "photo"}-${n + 1}.${a.type === "video" ? "mov" : "jpg"}`, mime: a.mimeType ?? (a.type === "video" ? "video/quicktime" : "image/jpeg") })));
      } else if (i === 1) {
        const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
        if (!r.canceled) await add(r.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? "application/octet-stream" })));
      }
    });

  const unstage = (a: Attachment) => {
    setFiles((cur) => cur.filter((f) => f.id !== a.id));
    void midna.discardUpload(a.id).catch(() => {});
  };

  return (
    <Animated.View ref={root} style={[s.root, { paddingBottom: lift }]}>
      <FlatList
        testID="chat-lines"
        inverted
        data={data}
        keyExtractor={(l) => l.key}
        contentContainerStyle={s.lines}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onEndReached={() => void midna.loadOlder().catch(() => {})}
        onEndReachedThreshold={0.4}
        renderItem={({ item }) => (
          <LineView
            line={item}
            midna={midna}
            canSend={canSend}
            approval={item.outboxId === undefined ? undefined : byOutbox.get(item.outboxId)}
            onAnswer={(option) => {
              if (item.outboxId === undefined) return;
              setProblem("");
              midna.send(option, item.outboxId).catch((err) => setProblem(`Couldn't answer: ${(err as Error).message}`));
            }}
            onOpenApprovals={onOpenApprovals}
          />
        )}
        ListEmptyComponent={
          midna.link === "connecting" ? undefined : (
            <Text style={[s.empty, { color: t.dim }]}>Nothing said yet. Say hello.</Text>
          )
        }
      />
      <View style={[s.composer, { borderTopColor: t.line, backgroundColor: t.bg }]}>
        <Problem text={problem} />
        {(files.length > 0 || uploading.length > 0) && (
          <View style={s.staged}>
            {files.map((a) => (
              <View key={a.id} style={[s.chip, { backgroundColor: t.panel, borderColor: t.line2 }]}>
                <Text numberOfLines={1} style={[s.chipText, { color: t.ink }]}>
                  {a.name}
                </Text>
                <Text style={[s.chipMeta, { color: t.dim }]}>{size(a.size)}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${a.name}`} hitSlop={10} onPress={() => unstage(a)}>
                  <Text style={[s.chipX, { color: t.dim }]}>×</Text>
                </Pressable>
              </View>
            ))}
            {uploading.map((u) => (
              <View key={u.key} style={[s.chip, { backgroundColor: t.panel, borderColor: t.line2 }]}>
                <ActivityIndicator size="small" color={t.dim} />
                <Text numberOfLines={1} style={[s.chipText, { color: t.dim }]}>
                  {u.name}
                </Text>
              </View>
            ))}
          </View>
        )}
        <View style={s.row}>
          <Pressable testID="chat-attach" accessibilityRole="button" accessibilityLabel="Add a photo or file" onPress={attach} disabled={sending} style={({ pressed }) => [s.round, { backgroundColor: t.panel, borderColor: t.line2, opacity: pressed ? 0.6 : 1 }]}>
            <Text style={[s.plus, { color: t.ink }]}>+</Text>
          </Pressable>
          <TextInput
            testID="chat-input"
            value={text.value}
            onChangeText={text.set}
            editable={!sending}
            placeholder={canSend ? "Message midna" : "Message midna (sends once it's back)"}
            placeholderTextColor={t.dimmer}
            multiline
            style={[s.input, { color: t.ink, backgroundColor: t.panel, borderColor: t.line2, opacity: sending ? 0.6 : 1 }]}
          />
          <Pressable
            testID="chat-send"
            accessibilityRole="button"
            accessibilityLabel="Send"
            onPress={() => void submit()}
            disabled={!canSend || sending || uploading.length > 0 || (!text.value.trim() && !files.length)}
            style={({ pressed }) => [s.round, s.send, { backgroundColor: t.primary, opacity: !canSend || (!text.value.trim() && !files.length) || uploading.length ? 0.35 : pressed ? 0.7 : 1 }]}
          >
            {sending ? <ActivityIndicator size="small" color={t.primaryInk} /> : <Text style={[s.arrow, { color: t.primaryInk }]}>↑</Text>}
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

function LineView({
  line: l,
  midna,
  canSend,
  approval,
  onAnswer,
  onOpenApprovals,
}: {
  line: Line;
  midna: Midna;
  canSend: boolean;
  approval?: Approval;
  onAnswer: (option: string) => void;
  onOpenApprovals: () => void;
}) {
  const t = useTheme();
  if (l.role === "user") {
    return (
      <View style={s.user}>
        {l.attachments.length > 0 && <Attachments items={l.attachments} align="end" source={midna.attachmentSource} fetchAttachment={midna.fetchAttachment} />}
        {l.text ? (
          <View style={[s.bubble, { backgroundColor: t.primary, opacity: l.pending ? 0.6 : 1 }]}>
            <Text selectable style={[s.userText, { color: t.primaryInk }]}>
              {l.text}
            </Text>
          </View>
        ) : null}
        <Text style={[s.meta, { color: t.dimmer }]}>
          {l.pending ? "sending…" : time(l.at)}
          {l.client && l.client !== "mobile" ? ` · via ${l.client}` : ""}
        </Text>
      </View>
    );
  }
  return (
    <View style={s.midna}>
      {l.text ? (
        <Markdown text={l.text} />
      ) : null}
      {l.attachments.length > 0 && <Attachments items={l.attachments} source={midna.attachmentSource} fetchAttachment={midna.fetchAttachment} />}
      {approval ? (
        <ApprovalButtons approval={approval} midna={midna} canSend={canSend} />
      ) : asksApproval(l) ? (
        // An approval this phone hasn't heard about: never answered by sending its label, which skips Face ID.
        l.answered ? (
          <Text style={[s.outcome, { color: t.dim }]}>Over</Text>
        ) : (
          <Pressable accessibilityRole="button" onPress={onOpenApprovals}>
            <Text style={[s.outcome, { color: t.ink, textDecorationLine: "underline" }]}>Answer it in Approvals</Text>
          </Pressable>
        )
      ) : l.kind === "question" && l.options && l.options.length > 0 ? (
        <View style={s.options}>
          {l.options.map((o) => (
            <Pressable
              key={o}
              accessibilityRole="button"
              disabled={l.answered || !canSend}
              onPress={() => onAnswer(o)}
              style={({ pressed }) => [s.option, { backgroundColor: t.panel, borderColor: t.line2, opacity: l.answered || !canSend ? 0.45 : pressed ? 0.6 : 1 }]}
            >
              <Text style={[s.optionText, { color: t.ink }]}>{o}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text style={[s.meta, { color: t.dimmer }]}>{time(l.at)}</Text>
    </View>
  );
}

/** An approval's three answers, each behind Face ID; once it's over, how it ended. */
export function ApprovalButtons({ approval, midna, canSend }: { approval: Approval; midna: Midna; canSend: boolean }) {
  const t = useTheme();
  const [busy, setBusy] = useState<ApprovalAnswer | null>(null);
  const [problem, setProblem] = useState("");
  if (approval.state !== "pending") return <Text style={[s.outcome, { color: t.dim }]}>{approvalOutcome(approval)}</Text>;
  const answer = async (label: string, a: ApprovalAnswer) => {
    setProblem("");
    setBusy(a);
    try {
      const why = await faceId(`${label}: ${approval.summary}`);
      if (why !== null) return setProblem(why);
      await midna.answerApproval(approval, a);
    } catch (err) {
      setProblem(`Couldn't answer: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <View style={s.approval}>
      <View style={s.options}>
        {APPROVAL_OPTIONS.map((o) => (
          <Pressable
            key={o.answer}
            testID={`approve-${o.answer}`}
            accessibilityRole="button"
            disabled={!!busy || !canSend}
            onPress={() => void answer(o.label, o.answer)}
            style={({ pressed }) => [s.option, { backgroundColor: o.answer === "deny" ? t.panel : t.primary, borderColor: o.answer === "deny" ? t.line2 : t.primary, opacity: busy || !canSend ? 0.45 : pressed ? 0.6 : 1 }]}
          >
            {busy === o.answer ? (
              <ActivityIndicator size="small" color={o.answer === "deny" ? t.ink : t.primaryInk} />
            ) : (
              <Text style={[s.optionText, { color: o.answer === "deny" ? t.ink : t.primaryInk }]}>{o.label}</Text>
            )}
          </Pressable>
        ))}
      </View>
      <Problem text={problem} />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  lines: { paddingHorizontal: 14, paddingVertical: 12, gap: 14 },
  empty: { textAlign: "center", fontSize: 15, marginTop: 40, transform: [{ scaleY: -1 }] },
  user: { alignItems: "flex-end", gap: 4 },
  bubble: { maxWidth: "82%", borderRadius: 18, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 9 },
  userText: { fontSize: 16, lineHeight: 22 },
  midna: { alignItems: "flex-start", gap: 6, width: "92%" },
  meta: { fontSize: 11.5 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: { minHeight: 34, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, justifyContent: "center" },
  optionText: { fontSize: 14.5, fontWeight: "500" },
  approval: { gap: 6 },
  outcome: { fontSize: 13.5 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8, gap: 8 },
  staged: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, height: 30, maxWidth: 220 },
  chipText: { fontSize: 13, flexShrink: 1 },
  chipMeta: { fontSize: 12 },
  chipX: { fontSize: 18, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  round: { width: 38, height: 38, borderRadius: 19, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  send: { borderWidth: 0 },
  plus: { fontSize: 24, lineHeight: 26, fontWeight: "300" },
  arrow: { fontSize: 20, fontWeight: "700" },
  input: { flex: 1, minHeight: 38, maxHeight: 140, borderRadius: 19, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingTop: 9, paddingBottom: 9, fontSize: 16 },
});
