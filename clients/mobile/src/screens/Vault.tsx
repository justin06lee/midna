import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { MidnaError, vaultMatches, vaultSite, type VaultItem } from "@midna/protocol";
import type { PhoneConnection } from "../connection";
import { draftKey, useDraft, useSecretDraft } from "../drafts";
import { faceId } from "../faceid";
import { mono, useTheme } from "../theme";
import { Button, Field, Problem } from "../ui";
import type { Midna } from "../useMidna";

const NEW = "new";
/** A copied password leaves the clipboard after this long, if it is still the one there. */
const CLEAR_MS = 30_000;

/**
 * The vault: the logins midna keeps in ghostly, by title. Tap one to change
 * it; its password shows or copies only behind Face ID. Hermes finds a login
 * by its title, and asks before it uses a password. What is typed stays
 * until it is saved — a password being typed in memory only.
 */
export function Vault({ midna, connection }: { midna: Midna; connection: PhoneConnection }) {
  const t = useTheme();
  const key = draftKey(connection);
  const [items, setItems] = useState<VaultItem[] | null>(null);
  const [error, setError] = useState("");
  const [none, setNone] = useState("");
  const [tries, setTries] = useState(0);
  const query = useDraft(`${key}:vault:query`);
  const open = useDraft(`${key}:vault:open`);

  useEffect(() => {
    let live = true;
    setError("");
    midna.client.vault().then(
      (v) => live && setItems(v),
      (err: Error) => {
        if (!live) return;
        if (err instanceof MidnaError && err.status === 503) setNone(err.message.replace(/^there's no vault here: /, ""));
        else setError(`Couldn't open the vault: ${err.message}`);
      },
    );
    return () => {
      live = false;
    };
  }, [midna.client, tries]);
  const reload = useCallback(() => setTries((n) => n + 1), []);

  if (none)
    return (
      <View style={s.empty}>
        <Text style={[s.emptyTitle, { color: t.ink }]}>No vault on this midna</Text>
        <Text style={[s.emptyText, { color: t.dim }]}>{none}. ghostly keeps its vault on midna's host.</Text>
      </View>
    );
  if (!items)
    return (
      <View style={s.empty}>
        {error ? (
          <>
            <Text style={[s.emptyText, { color: t.dim }]}>{error}</Text>
            <Button small label="Try again" onPress={reload} />
          </>
        ) : (
          <ActivityIndicator color={t.dim} />
        )}
      </View>
    );

  const editing = open.value === NEW ? null : items.find((i) => i.id === open.value);
  if (open.value && (open.value === NEW || editing))
    return <Editor midna={midna} item={editing ?? null} draft={key} onDone={() => (open.set(""), reload())} onBack={() => open.set("")} />;

  const shown = vaultMatches(items, query.value);
  return (
    <ScrollView testID="vault" contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <View style={s.top}>
        <Text style={[s.title, { color: t.ink }]}>Vault</Text>
        <Button small label="Add" onPress={() => open.set(NEW)} testID="vault-add" />
      </View>
      <Text style={[s.lede, { color: t.dim }]}>Logins midna keeps in ghostly. Hermes finds one by its title, and asks you before it uses a password.</Text>
      {items.length > 0 && (
        <TextInput
          testID="vault-find"
          value={query.value}
          onChangeText={query.set}
          placeholder="Find by title"
          placeholderTextColor={t.dimmer}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          style={[s.find, { color: t.ink, backgroundColor: t.panel, borderColor: t.line2 }]}
        />
      )}
      {items.length === 0 ? (
        <Text style={[s.note, { color: t.dim }]}>Nothing in the vault yet. Add a login, and midna can find it by its title when you ask.</Text>
      ) : shown.length === 0 ? (
        <Text style={[s.note, { color: t.dim }]}>No login titled "{query.value.trim()}".</Text>
      ) : (
        <View style={[s.list, { backgroundColor: t.panel, borderColor: t.line }]}>
          {shown.map((i, n) => (
            <Pressable
              key={i.id}
              testID={`vault-${i.id}`}
              accessibilityRole="button"
              onPress={() => open.set(i.id)}
              style={({ pressed }) => [s.row, n > 0 && { borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }, pressed && { backgroundColor: t.active }]}
            >
              <Text style={[s.rowTitle, { color: t.ink }]}>{i.title}</Text>
              {i.username || i.url ? <Text style={[s.rowMeta, { color: t.dim }]}>{[i.username, vaultSite(i.url)].filter(Boolean).join(" · ")}</Text> : null}
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

/** One login, open to change — or a new one. Saving sends only what changed. */
function Editor({ midna, item, draft, onDone, onBack }: { midna: Midna; item: VaultItem | null; draft: string; onDone: () => void; onBack: () => void }) {
  const t = useTheme();
  const key = `${draft}:vault:${item?.id ?? NEW}`;
  const title = useDraft(`${key}:title`, item?.title ?? "");
  const username = useDraft(`${key}:username`, item?.username ?? "");
  const url = useDraft(`${key}:url`, item?.url ?? "");
  const [password, setPassword] = useSecretDraft(`${key}:password`);
  /** The saved password, once asked for behind Face ID: memory only. */
  const [current, setCurrent] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState<"save" | "show" | "copy" | "trash" | null>(null);
  const [problem, setProblem] = useState("");
  const [copied, setCopied] = useState(false);

  const run = async (what: NonNullable<typeof busy>, work: () => Promise<void>) => {
    setBusy(what);
    setProblem("");
    try {
      await work();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** The saved password, behind Face ID; null when Face ID said no (and why is shown). */
  const saved = async (reason: string): Promise<string | null> => {
    if (current !== null || !item) return current ?? "";
    const why = await faceId(reason, "see passwords");
    if (why !== null) {
      setProblem(why);
      return null;
    }
    const { password: p } = await midna.client.vaultPassword(item.id);
    setCurrent(p);
    return p;
  };

  const show = () =>
    run("show", async () => {
      if (visible) return setVisible(false);
      if (!password && item) {
        const p = await saved(`Show the password for ${item.title}`);
        if (p === null) return;
        setPassword(p);
      }
      setVisible(true);
    });

  const copy = () =>
    run("copy", async () => {
      const p = password || (item ? await saved(`Copy the password for ${item.title}`) : null);
      if (!p) return;
      await Clipboard.setStringAsync(p);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
      setTimeout(() => void Clipboard.getStringAsync().then((now) => now === p && Clipboard.setStringAsync("")).catch(() => {}), CLEAR_MS);
    });

  const clear = () => {
    title.clear();
    username.clear();
    url.clear();
    setPassword("");
  };

  const save = () =>
    run("save", async () => {
      if (!title.value.trim()) throw new Error("A login needs a title.");
      if (!item) {
        if (!password) throw new Error("A new login needs a password.");
        await midna.client.addToVault({ title: title.value, username: username.value, url: url.value, password });
      } else {
        const patch = {
          ...(title.value !== item.title ? { title: title.value } : {}),
          ...(username.value !== (item.username ?? "") ? { username: username.value } : {}),
          ...(url.value !== (item.url ?? "") ? { url: url.value } : {}),
          ...(password && password !== current ? { password } : {}),
        };
        if (Object.keys(patch).length) await midna.client.editVault(item.id, patch);
      }
      clear();
      onDone();
    });

  const trash = () =>
    item &&
    Alert.alert(`Move ${item.title} to the trash?`, "Bitwarden can still restore it from there.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Move to trash",
        style: "destructive",
        onPress: () =>
          void run("trash", async () => {
            await midna.client.removeFromVault(item.id);
            clear();
            onDone();
          }),
      },
    ]);

  const discard = () => {
    clear();
    onBack();
  };

  return (
    <ScrollView testID="vault-editor" contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <View style={s.top}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to the vault" onPress={onBack} hitSlop={12} style={s.back}>
          <Text style={[s.backText, { color: t.dim }]}>‹ Vault</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={discard} hitSlop={12} style={s.back}>
          <Text style={[s.backText, { color: t.dim }]}>Discard</Text>
        </Pressable>
      </View>
      <Text style={[s.title, { color: t.ink }]}>{item ? item.title : "New login"}</Text>
      <View style={s.fields}>
        <Field testID="vault-title" label="Title" value={title.value} onChangeText={title.set} placeholder="GitHub" autoCapitalize="words" />
        <Field testID="vault-username" label="Username" value={username.value} onChangeText={username.set} autoCapitalize="none" textContentType="username" />
        <Field testID="vault-url" label="Website" value={url.value} onChangeText={url.set} placeholder="https://" autoCapitalize="none" keyboardType="url" />
        <View style={s.password}>
          <Field
            testID="vault-password"
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder={item ? "Unchanged" : ""}
            secureTextEntry={!visible}
            autoCapitalize="none"
            textContentType="newPassword"
            style={{ fontFamily: mono, fontSize: 15 }}
          />
          {item || password ? (
            <View style={s.secretActions}>
              <Button small label={visible ? "Hide" : "Show"} busy={busy === "show"} onPress={() => void show()} />
              <Button small label={copied ? "Copied" : "Copy"} busy={busy === "copy"} onPress={() => void copy()} />
            </View>
          ) : null}
        </View>
      </View>
      <Problem text={problem} />
      <Button testID="vault-save" kind="primary" label={item ? "Save" : "Add"} busy={busy === "save"} disabled={busy !== null && busy !== "save"} onPress={() => void save()} />
      {item ? <Button kind="danger" label="Move to trash" busy={busy === "trash"} onPress={trash} style={{ marginTop: 4 }} /> : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  body: { padding: 16, gap: 14 },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  title: { fontSize: 24, fontWeight: "700" },
  lede: { fontSize: 15, lineHeight: 21, marginTop: -6 },
  find: { height: 44, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, fontSize: 16 },
  list: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  row: { paddingHorizontal: 16, paddingVertical: 12, minHeight: 52, justifyContent: "center", gap: 2 },
  rowTitle: { fontSize: 16.5, fontWeight: "500" },
  rowMeta: { fontSize: 14 },
  note: { fontSize: 15, lineHeight: 21, paddingVertical: 8 },
  empty: { flex: 1, paddingTop: 60, paddingHorizontal: 24, gap: 10, alignItems: "center" },
  emptyTitle: { fontSize: 18, fontWeight: "600" },
  emptyText: { fontSize: 15, lineHeight: 21, textAlign: "center" },
  back: { minHeight: 44, justifyContent: "center" },
  backText: { fontSize: 16 },
  fields: { gap: 14 },
  password: { gap: 8 },
  secretActions: { flexDirection: "row", gap: 8 },
});
