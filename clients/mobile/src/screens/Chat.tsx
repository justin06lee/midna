import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type RefObject } from "react";
import { ActionSheetIOS, ActivityIndicator, Animated, AppState, Dimensions, Easing, FlatList, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { APPROVAL_OPTIONS, MAX_ATTACHMENTS_PER_MESSAGE, plainText, type Approval, type ApprovalAnswer, type Attachment } from "@midna/protocol";
import { Attachments, Thumb } from "../attachments";
import { keyboardLift } from "../keyboard";
import type { PhoneConnection } from "../connection";
import { draftKey, dropDraft, loadDraft, saveDraft, useDraft } from "../drafts";
import { faceId } from "../faceid";
import { Markdown } from "../markdown";
import { approvalOutcome, asksApproval, size, type Line } from "../lines";
import { radius, type as face, useTheme } from "../theme";
import { Glass, Icon, Problem } from "../ui";
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

function useKeyboardLift(ref: RefObject<Measurable | null>, rest: number) {
  const lift = useRef(new Animated.Value(rest)).current;
  // Never less than `rest`: with no keyboard, the foot stands clear of the tab capsule floating over it.
  const move = (to: number, ms: number) =>
    Animated.timing(lift, { toValue: Math.max(to, rest), duration: ms || 250, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  useEffect(() => {
    // The lift is worked out afresh from the view's frame and the keyboard's
    // each time: padding doesn't move the frame, so nothing already applied
    // is added to it. A frame that is off screen, or measured while the app
    // isn't active, lifts nothing.
    const place = (top: number, height: number, ms: number) => {
      const { height: windowHeight } = Dimensions.get("window");
      ref.current?.measureInWindow((_x, y, _w, h) => move(keyboardLift({ viewTop: y, viewBottom: y + h, keyboardTop: top, keyboardHeight: height, windowHeight }), ms));
    };
    const frame = Keyboard.addListener("keyboardWillChangeFrame", (e) => {
      if (AppState.currentState === "active") place(e.endCoordinates.screenY, e.endCoordinates.height, e.duration);
    });
    const hide = Keyboard.addListener("keyboardWillHide", (e) => move(0, e.duration));
    const done = Keyboard.addListener("keyboardDidHide", () => lift.setValue(rest));
    // Back from the background: whatever the keyboard is now decides.
    const app = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const k = Keyboard.metrics();
      if (k) place(k.screenY, k.height, 0);
      else lift.setValue(rest);
    });
    return () => {
      frame.remove();
      hide.remove();
      done.remove();
      app.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, lift, rest]);
  return lift;
}

/**
 * The conversation, newest at the bottom: what you said in grey bubbles on
 * the right, midna's replies as the page itself. At its foot, one field:
 * the words, and under them the button that adds a file, the model that is
 * thinking (it opens the sheet that changes it) and send. What is typed,
 * and the files added to it (already on the host), are a draft until midna
 * has the message: they survive switching tabs, the app being killed, and
 * a send that failed. `foot` is what the tab capsule floating over the
 * screen needs left clear.
 */
export function Chat({ midna, connection, foot, model, onPickModel, onOpenApprovals }: { midna: Midna; connection: PhoneConnection; foot: number; model: string; onPickModel: () => void; onOpenApprovals: () => void }) {
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
  const [problem, setProblem] = useState("");
  const root = useRef<Measurable>(null);
  const lift = useKeyboardLift(root, foot);

  const byOutbox = useMemo(() => new Map([...midna.approvals.values()].flatMap((a) => (a.outboxId === null ? [] : [[a.outboxId, a] as const]))), [midna.approvals]);
  const data = useMemo(() => [...midna.lines].reverse(), [midna.lines]);
  // Sending never waits on the connection: a line that can't go now says so, and is retried with a tap.
  const canSend = midna.link !== "unpaired";

  const submit = async () => {
    const value = text.value.trim();
    if ((!value && !files.length) || uploading.length) return;
    setProblem("");
    // The line takes the words now (kept until midna has them, across a restart too), so the composer is free at once.
    const sent = files;
    text.clear();
    setFiles(() => []);
    const problem = await midna.send(value, undefined, sent);
    if (problem) setProblem(problem);
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

  // Something to send, and nothing still on its way up.
  const ready = canSend && uploading.length === 0 && (text.value.trim().length > 0 || files.length > 0);

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
        // Inverted, so the header sits at the bottom, under the newest line: midna at work.
        ListHeaderComponent={midna.thinking ? <ActivityIndicator testID="chat-working" size="small" color={t.inkFaint} style={s.working} /> : undefined}
        renderItem={({ item, index }) => (
          <LineView
            line={item}
            // Inverted: the line before this one in time is the next in the list.
            stamp={stampFor(item.at, data[index + 1]?.at)}
            // Lines of one speaker sit close; a change of speaker takes a breath.
            gap={data[index + 1] ? (data[index + 1]!.role === item.role ? 8 : 18) : 0}
            midna={midna}
            canSend={canSend}
            approval={item.outboxId === undefined ? undefined : byOutbox.get(item.outboxId)}
            onAnswer={(option) => {
              if (item.outboxId === undefined) return;
              setProblem("");
              void midna.send(option, item.outboxId).then((p) => p && setProblem(p));
            }}
            onOpenApprovals={onOpenApprovals}
          />
        )}
        ListEmptyComponent={
          midna.link === "connecting" ? undefined : (
            <Text style={[s.empty, { color: t.inkSoft }]}>Nothing said yet. Say hello.</Text>
          )
        }
      />
      <View style={s.composer}>
        {/* The conversation fades out under the field rather than stopping at a line. */}
        <LinearGradient pointerEvents="none" colors={[t.dark ? "rgba(20,19,18,0)" : "rgba(255,255,255,0)", t.paper]} locations={[0, 0.35]} style={StyleSheet.absoluteFill} />
        <Problem text={problem} />
        <Glass fallback={t.raised} lifted={!t.dark} style={s.field}>
          {(files.length > 0 || uploading.length > 0) && (
            <View style={s.staged}>
              {files.map((a) => (
                <View key={a.id} style={[s.chip, { backgroundColor: t.fill }]}>
                  {a.kind === "image" ? <Thumb a={a} source={midna.attachmentSource} width={22} height={22} radius={6} /> : null}
                  <Text numberOfLines={1} style={[s.chipText, { color: t.ink }]}>
                    {a.name}
                  </Text>
                  <Text style={[s.chipMeta, { color: t.inkFaint }]}>{size(a.size)}</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${a.name}`} hitSlop={10} onPress={() => unstage(a)}>
                    <Icon name="xmark" size={10} color={t.inkSoft} weight="bold" />
                  </Pressable>
                </View>
              ))}
              {uploading.map((u) => (
                <View key={u.key} style={[s.chip, { backgroundColor: t.fill }]}>
                  <ActivityIndicator size="small" color={t.inkSoft} />
                  <Text numberOfLines={1} style={[s.chipText, { color: t.inkSoft }]}>
                    {u.name}
                  </Text>
                </View>
              ))}
            </View>
          )}
          <TextInput
            testID="chat-input"
            value={text.value}
            onChangeText={text.set}
            placeholder={midna.link === "live" ? "Message midna…" : "Message midna (sends once it's back)"}
            placeholderTextColor={t.inkFaint}
            multiline
            style={[s.input, { color: t.ink }]}
          />
          <View style={s.row}>
            <Pressable testID="chat-attach" accessibilityRole="button" accessibilityLabel="Add a photo or file" hitSlop={8} onPress={attach} style={({ pressed }) => [s.round, { backgroundColor: t.fill, opacity: pressed ? 0.6 : 1 }]}>
              <Icon name="plus" size={15} color={t.ink} weight="semibold" />
            </Pressable>
            {/* The model that thinks, where ruri's field has it: a tap opens the sheet that changes it. */}
            <Pressable testID="header-model" accessibilityRole="button" accessibilityLabel={`Model: ${model}. Change it`} hitSlop={8} onPress={onPickModel} style={({ pressed }) => [s.model, pressed && { opacity: 0.5 }]}>
              <Text numberOfLines={1} style={[s.modelText, { color: t.inkSoft }]}>
                {model}
              </Text>
              <Icon name="chevron.up.chevron.down" size={10} color={t.inkFaint} weight="semibold" />
            </Pressable>
            <Pressable testID="chat-send" accessibilityRole="button" accessibilityLabel="Send" hitSlop={5} onPress={() => void submit()} disabled={!ready} style={({ pressed }) => [s.round, { backgroundColor: ready ? t.ink : t.fill, opacity: pressed ? 0.7 : 1 }]}>
              <Icon name="arrow.up" size={15} color={ready ? t.paper : t.inkFaint} weight="bold" />
            </Pressable>
          </View>
        </Glass>
      </View>
    </Animated.View>
  );
}

/** The day and time a stretch of the conversation began, as Messages heads one; nothing unless a day turned or half an hour passed since the line before. */
function stampFor(at: number, before: number | undefined): string | null {
  if (before !== undefined && new Date(before).toDateString() === new Date(at).toDateString() && at - before < 30 * 60_000) return null;
  const d = new Date(at);
  const clock = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(new Date().toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  return `${days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${clock}`;
}

function LineView(props: Parameters<typeof LineBody>[0] & { stamp: string | null; gap: number }) {
  const t = useTheme();
  if (!props.stamp) return <View style={{ paddingTop: props.gap }}><LineBody {...props} /></View>;
  return (
    <View style={[s.stamped, { paddingTop: props.gap }]}>
      <Text style={[s.stamp, { color: t.inkFaint }]}>{props.stamp}</Text>
      <LineBody {...props} />
    </View>
  );
}

function LineBody({
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
          <Pressable disabled={l.state !== "failed"} onPress={() => void midna.retry(l)} style={[s.bubble, { backgroundColor: t.bubble, opacity: l.state === "sending" || l.state === "failed" ? 0.55 : 1 }]}>
            <Text selectable={l.state !== "failed"} style={[s.userText, { color: t.ink }]}>
              {l.text}
            </Text>
          </Pressable>
        ) : null}
        {l.state === "failed" ? (
          <Text onPress={() => void midna.retry(l)} style={[s.meta, { color: t.destructive }]}>
            Not sent · tap to try again
          </Text>
        ) : l.state === "sending" ? (
          <Text style={[s.meta, { color: t.inkSoft }]}>Sending…</Text>
        ) : null}
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
          <Text style={[s.outcome, { color: t.inkSoft }]}>Over</Text>
        ) : (
          <Pressable accessibilityRole="button" onPress={onOpenApprovals}>
            <Text style={[s.outcome, { color: t.accent }]}>Answer in Approvals</Text>
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
              style={({ pressed }) => [s.option, { backgroundColor: t.fill, opacity: l.answered || !canSend ? 0.45 : pressed ? 0.6 : 1 }]}
            >
              <Text style={[s.optionText, { color: l.answered ? t.inkSoft : t.ink }]}>{plainText(o)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** An approval's three answers, each behind Face ID; once it's over, how it ended. */
export function ApprovalButtons({ approval, midna, canSend }: { approval: Approval; midna: Midna; canSend: boolean }) {
  const t = useTheme();
  const [busy, setBusy] = useState<ApprovalAnswer | null>(null);
  const [problem, setProblem] = useState("");
  if (approval.state !== "pending") return <Text style={[s.outcome, { color: t.inkSoft }]}>{approvalOutcome(approval)}</Text>;
  const answer = async (label: string, a: ApprovalAnswer) => {
    setProblem("");
    setBusy(a);
    try {
      const why = await faceId(`${label}: ${plainText(approval.summary)}`);
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
            style={({ pressed }) => [s.option, { backgroundColor: o.answer === "allow" ? t.ink : t.fill, opacity: busy || !canSend ? 0.45 : pressed ? 0.6 : 1 }]}
          >
            {busy === o.answer ? (
              <ActivityIndicator size="small" color={o.answer === "allow" ? t.paper : t.inkSoft} />
            ) : (
              <Text style={[s.optionText, { color: o.answer === "allow" ? t.paper : o.answer === "deny" ? t.destructive : t.ink }]}>{o.label}</Text>
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
  lines: { paddingHorizontal: 16, paddingVertical: 12 },
  empty: { ...face(15), textAlign: "center", marginTop: 40, transform: [{ scaleY: -1 }] },
  working: { alignSelf: "flex-start", marginTop: 14, marginLeft: 2 },
  stamped: { gap: 14 },
  stamp: { ...face(12), textAlign: "center", marginTop: 6 },
  // Room on the left says whose it is, however long it runs.
  user: { alignItems: "flex-end", gap: 4, paddingLeft: 44 },
  bubble: { borderRadius: radius.bubble, borderCurve: "continuous", paddingHorizontal: 14, paddingVertical: 9 },
  userText: face(16, "regular", 22),
  midna: { alignItems: "flex-start", gap: 8 },
  meta: { ...face(11), marginRight: 6 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: { minHeight: 38, borderRadius: 19, paddingHorizontal: 16, justifyContent: "center" },
  optionText: face(14, "medium"),
  approval: { gap: 6 },
  outcome: face(13),
  composer: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, gap: 8 },
  field: { borderRadius: radius.field, borderCurve: "continuous", paddingTop: 10, paddingLeft: 14, paddingRight: 8, paddingBottom: 8, gap: 6, overflow: "hidden" },
  staged: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 2 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 15, paddingHorizontal: 10, height: 30, maxWidth: 220 },
  chipText: { ...face(13), flexShrink: 1 },
  chipMeta: face(12),
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  round: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  model: { flex: 1, flexDirection: "row", alignItems: "center", gap: 5, height: 34 },
  modelText: { ...face(13, "medium"), flexShrink: 1 },
  input: { ...face(16, "regular", 21), minHeight: 24, maxHeight: 140, paddingTop: 0, paddingBottom: 0, paddingRight: 6 },
});
