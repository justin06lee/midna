import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { accountChoices, modelGroups, parseModel, thinkingWith, type Account, type BrainInfo, type BrainModel, type ModelChoice } from "@midna/protocol";
import { useTheme } from "../theme";
import { Group, GroupNote, GroupTitle, Problem, Row } from "../ui";
import type { Midna } from "../useMidna";

export interface Models {
  brains: BrainInfo[];
  catalogues: Record<string, BrainModel[]>;
}

/**
 * What the host can think with: its installed brains, and each one's own list
 * of models once asked for (`wanted`; a host before 0.13.7 has none to give,
 * and the sheet falls back to the short list it can work out itself). The
 * brain that is set is asked at once, so its model is called by its real name.
 */
export function useModels(midna: Midna, wanted: boolean): Models {
  const { client, status, link } = midna;
  const [brains, setBrains] = useState<BrainInfo[]>([]);
  const [catalogues, setCatalogues] = useState<Record<string, BrainModel[]>>({});
  const live = link === "live";
  useEffect(() => {
    if (live) void client.brains().then(setBrains, () => {});
  }, [client, live]);
  const account = status?.account;
  const set = status ? parseModel(status.model, brains.map((b) => b.id)).provider : null;
  useEffect(() => {
    const abort = new AbortController();
    for (const b of brains) {
      if (!b.installed || b.id === "hermes" || !(wanted || b.id === set)) continue;
      void client.brainModels(b.id, b.id === "claude" ? account : undefined, abort.signal).then(
        (m) => setCatalogues((c) => ({ ...c, [b.id]: m })),
        () => {},
      );
    }
    return () => abort.abort();
  }, [client, brains, account, set, wanted]);
  return { brains, catalogues };
}

/** What is thinking now, for the header and for Settings: "Opus 5.5". */
export function modelNow(midna: Midna, models: Models): string {
  return midna.status ? thinkingWith(midna.status, models.brains, models.catalogues).name : "—";
}

/**
 * The model midna thinks with, as a sheet of grouped rows: each installed
 * brain's models, the one that is set ticked, and the two Claude accounts.
 * A change is the host's setting, so every device sees it, and it holds from
 * midna's next turn.
 */
export function ModelSheet({ midna, models, open, onClose }: { midna: Midna; models: Models; open: boolean; onClose: () => void }) {
  const t = useTheme();
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const status = midna.status;

  const save = async (what: string, patch: { model?: string; account?: Account }) => {
    setSaving(what);
    setProblem("");
    try {
      midna.setStatus(await midna.client.updateSettings(patch));
      if (patch.model) onClose();
    } catch (err) {
      setProblem(`Couldn't switch: ${(err as Error).message}`);
    } finally {
      setSaving(null);
    }
  };

  const now = status ? thinkingWith(status, models.brains, models.catalogues) : null;
  const row = (c: ModelChoice, first: boolean) => (
    <Row
      key={c.ref}
      testID={`model-${c.ref}`}
      label={c.name}
      value={c.note && c.note.length <= 14 ? c.note : undefined}
      first={first}
      checked={c.selected}
      busy={saving === c.ref}
      onPress={() => (c.selected ? onClose() : void save(c.ref, { model: c.ref }))}
    />
  );

  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[s.root, { backgroundColor: t.grouped }]}>
        <View style={s.bar}>
          <Text style={[s.title, { color: t.ink }]}>Model</Text>
          <Pressable testID="models-done" accessibilityRole="button" hitSlop={12} onPress={onClose} style={s.done}>
            <Text style={[s.doneText, { color: t.primary }]}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={s.body}>
          {now?.standIn ? <GroupNote>{`${now.standIn}. ${now.name} is thinking meanwhile.`}</GroupNote> : null}
          <Problem text={problem} />
          {status &&
            modelGroups(status, models.brains, models.catalogues).map((g) => (
              <View key={g.provider} style={s.section}>
                <GroupTitle>{g.label}</GroupTitle>
                <Group>
                  {g.choices.map((c, n) => row(c, n === 0))}
                  {g.more.length > 0 && (more[g.provider] ? g.more.map((c) => row(c, false)) : <Row label={`${g.more.length} more`} tone="tint" onPress={() => setMore((m) => ({ ...m, [g.provider]: true }))} />)}
                </Group>
              </View>
            ))}
          {status && accountChoices(status).length > 0 && (
            <View style={s.section}>
              <GroupTitle>Claude account</GroupTitle>
              <Group>
                {accountChoices(status).map((a, n) => (
                  <Row
                    key={a.account}
                    testID={`account-${a.account}`}
                    label={a.name}
                    value={a.note}
                    first={n === 0}
                    checked={a.selected}
                    busy={saving === a.account}
                    onPress={() => !a.selected && void save(a.account, { account: a.account })}
                  />
                ))}
              </Group>
            </View>
          )}
          <GroupNote>A change holds from midna's next turn, on every device.</GroupNote>
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  bar: { height: 56, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 17, fontWeight: "600" },
  done: { position: "absolute", right: 16, height: 56, justifyContent: "center" },
  doneText: { fontSize: 17, fontWeight: "600" },
  body: { paddingHorizontal: 16, paddingBottom: 40, gap: 22 },
  section: { gap: 14 },
});
