import { useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import * as Sharing from "expo-sharing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Attachment } from "@midna/protocol";
import { size } from "./lines";
import { useTheme } from "./theme";
import type { Midna } from "./useMidna";

type Source = Midna["attachmentSource"];
type Fetch = Midna["fetchAttachment"];

/** Open a file from midna on this phone: Quick Look where it can, the share sheet otherwise. */
async function open(a: Attachment, fetchAttachment: Fetch): Promise<void> {
  const file = await fetchAttachment(a);
  if (await file.canPreview().catch(() => false)) return file.preview();
  await Sharing.shareAsync(file.uri, { dialogTitle: a.name });
}

/** A message's images and files, in the sender's order: images drawn, files as rows to open. */
export function Attachments({ items, align = "start", source, fetchAttachment }: { items: Attachment[]; align?: "start" | "end"; source: Source; fetchAttachment: Fetch }) {
  const [viewing, setViewing] = useState<Attachment | null>(null);
  return (
    <View style={[s.list, { alignItems: align === "end" ? "flex-end" : "flex-start" }]}>
      {items.map((a) =>
        a.kind === "image" ? (
          <Picture key={a.id} a={a} source={source} onPress={() => setViewing(a)} />
        ) : (
          <FileRow key={a.id} a={a} fetchAttachment={fetchAttachment} />
        ),
      )}
      <Viewer a={viewing} source={source} fetchAttachment={fetchAttachment} onClose={() => setViewing(null)} />
    </View>
  );
}

function Picture({ a, source, onPress }: { a: Attachment; source: Source; onPress: () => void }) {
  const t = useTheme();
  const [ratio, setRatio] = useState(4 / 3);
  return (
    <Pressable accessibilityRole="imagebutton" accessibilityLabel={a.caption ?? a.name} onPress={onPress} style={s.picture}>
      <Image
        source={source(a.id)}
        onLoad={(e) => e.source.width && e.source.height && setRatio(e.source.width / e.source.height)}
        contentFit="cover"
        transition={120}
        style={[s.image, { aspectRatio: Math.max(0.6, Math.min(ratio, 2)), backgroundColor: t.sunken }]}
      />
      {a.caption ? <Text style={[s.caption, { color: t.dim }]}>{a.caption}</Text> : null}
    </Pressable>
  );
}

function FileRow({ a, fetchAttachment }: { a: Attachment; fetchAttachment: Fetch }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${a.name}`}
      disabled={busy}
      onPress={() => {
        setBusy(true);
        setFailed(false);
        open(a, fetchAttachment)
          .catch(() => setFailed(true))
          .finally(() => setBusy(false));
      }}
      style={({ pressed }) => [s.file, { backgroundColor: t.panel, borderColor: t.line2, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={[s.fileIcon, { backgroundColor: t.sunken }]}>
        {busy ? <ActivityIndicator size="small" color={t.dim} /> : <Text style={[s.ext, { color: t.dim }]}>{ext(a.name)}</Text>}
      </View>
      <View style={s.fileText}>
        <Text numberOfLines={1} style={[s.fileName, { color: t.ink }]}>
          {a.name}
        </Text>
        <Text style={[s.fileMeta, { color: failed ? t.danger : t.dim }]}>{failed ? "Couldn't open it — tap to try again" : size(a.size)}</Text>
      </View>
    </Pressable>
  );
}

const ext = (name: string) => (/\.([a-z0-9]{1,4})$/i.exec(name)?.[1] ?? "file").toUpperCase();

/** An image full screen, with a way to keep or send it on. */
function Viewer({ a, source, fetchAttachment, onClose }: { a: Attachment | null; source: Source; fetchAttachment: Fetch; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  return (
    <Modal visible={!!a} animationType="fade" onRequestClose={onClose} supportedOrientations={["portrait", "landscape"]}>
      <View style={[s.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {a && <Image source={source(a.id)} contentFit="contain" style={s.full} />}
        <View style={s.viewerBar}>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
            <Text style={s.viewerButton}>Done</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !a}
            hitSlop={12}
            onPress={() => {
              if (!a) return;
              setBusy(true);
              fetchAttachment(a)
                .then((f) => Sharing.shareAsync(f.uri))
                .catch(() => {})
                .finally(() => setBusy(false));
            }}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.viewerButton}>Share</Text>}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  list: { gap: 6 },
  picture: { width: 240, gap: 4 },
  image: { width: 240, borderRadius: 14 },
  caption: { fontSize: 13 },
  file: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 8, paddingRight: 14, maxWidth: 280 },
  fileIcon: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  ext: { fontSize: 11, fontWeight: "700" },
  fileText: { flexShrink: 1 },
  fileName: { fontSize: 15, fontWeight: "500" },
  fileMeta: { fontSize: 12.5, marginTop: 1 },
  viewer: { flex: 1, backgroundColor: "#000" },
  full: { flex: 1 },
  viewerBar: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 12 },
  viewerButton: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
