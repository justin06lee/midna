import { useEffect, useState } from "react";
import { Modal, ScrollView, StyleSheet, View } from "react-native";
import Storage from "expo-sqlite/kv-store";
import { accountChoices, modelGroups, providersInUse, thinkingWith, type Account, type BrainInfo, type BrainModel, type ModelChoice } from "@midna/protocol";
import { useTheme } from "../theme";
import { Group, GroupNote, GroupTitle, Problem, Row, SheetBar } from "../ui";
import type { Midna } from "../useMidna";

export interface Models {
  brains: BrainInfo[];
  catalogues: Record<string, BrainModel[]>;
  /** The brains that gave no list of their models. */
  unlisted: Record<string, boolean>;
}

/** Where the brains' lists are kept between launches: names a brain gave, never ones made up here. */
const REMEMBERED = "midna.models";
function remembered(): Record<string, BrainModel[]> {
  try {
    return (JSON.parse(Storage.getItemSync(REMEMBERED) ?? "{}") as Record<string, BrainModel[]>) ?? {};
  } catch {
    return {};
  }
}

/**
 * What the host can think with: its installed brains, and each one's own list
 * of models. The brains the host is set to (the model, a stand-in, the
 * fallbacks) are asked at once, so what is thinking is called by the name
 * its brain gives it; the rest once `wanted`. A host before 0.13.7 has no
 * way to ask, and then only what the host itself names is offered.
 */
export function useModels(midna: Midna, wanted: boolean): Models {
  const { client, status, link } = midna;
  const [brains, setBrains] = useState<BrainInfo[]>([]);
  // Started from the lists as last heard, so what is thinking has its name before the brain answers again.
  const [catalogues, setCatalogues] = useState<Record<string, BrainModel[]>>(remembered);
  useEffect(() => Storage.setItemSync(REMEMBERED, JSON.stringify(catalogues)), [catalogues]);
  const [unlisted, setUnlisted] = useState<Record<string, boolean>>({});
  const live = link === "live";
  useEffect(() => {
    if (live) void client.brains().then(setBrains, () => {});
  }, [client, live]);
  const account = status?.account;
  const inUse = status ? providersInUse(status, brains).join(",") : "";
  useEffect(() => {
    const abort = new AbortController();
    for (const b of brains) {
      if (!b.installed || b.id === "hermes" || !(wanted || inUse.split(",").includes(b.id))) continue;
      void client.brainModels(b.id, b.id === "claude" ? account : undefined, abort.signal).then(
        (m) => {
          setCatalogues((c) => ({ ...c, [b.id]: m }));
          setUnlisted((u) => ({ ...u, [b.id]: false }));
        },
        () => abort.signal.aborted || setUnlisted((u) => ({ ...u, [b.id]: true })),
      );
    }
    return () => abort.abort();
  }, [client, brains, account, inUse, wanted]);
  return { brains, catalogues, unlisted };
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
  // Opened: what is set may have changed on another device since this phone last asked.
  const { client, setStatus } = midna;
  useEffect(() => {
    if (open) void client.status().then(setStatus, () => {});
  }, [open, client, setStatus]);

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
      value={c.note}
      first={first}
      checked={c.selected}
      busy={saving === c.ref}
      onPress={() => (c.selected ? onClose() : void save(c.ref, { model: c.ref }))}
    />
  );

  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[s.root, { backgroundColor: t.ground }]}>
        <SheetBar title="Model" testID="models-done" onDone={onClose} />
        <ScrollView contentContainerStyle={s.body}>
          {now?.standIn ? <GroupNote>{`${now.standIn}. ${now.name} is thinking meanwhile.`}</GroupNote> : null}
          <Problem text={problem} />
          {status &&
            modelGroups(status, models.brains, models.catalogues).map((g) => (
              <View key={g.provider} style={s.section}>
                <GroupTitle>{g.label}</GroupTitle>
                <Group>
                  {g.choices.map((c, n) => row(c, n === 0))}
                  {g.more.length > 0 && (more[g.provider] ? g.more.map((c) => row(c, false)) : <Row label={`${g.more.length} more`} chevron first={g.choices.length === 0} onPress={() => setMore((m) => ({ ...m, [g.provider]: true }))} />)}
                </Group>
                {/* No list from this brain: say so rather than offer names of our own. */}
                {!g.listed ? <GroupNote>{models.unlisted[g.provider] ? `Couldn't list ${g.label}'s models.` : "Asking for its models…"}</GroupNote> : null}
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
  body: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48, gap: 24 },
  section: { gap: 24 },
});
