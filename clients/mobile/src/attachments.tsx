import { useEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
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

/**
 * A thumbnail in a fixed box: images arrive without their size, and one that
 * changed the box as it loaded would shove the list. A failed load is a
 * quiet tile, not a broken one.
 */
export function Thumb({ a, source, width = THUMB_W, height = THUMB_H, radius = 14, style }: { a: Attachment; source: Source; width?: number; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const [failed, setFailed] = useState(false);
  return (
    <View style={[{ width, height, borderRadius: radius, backgroundColor: t.sunken, overflow: "hidden", alignItems: "center", justifyContent: "center" }, style]}>
      {failed ? (
        height >= 60 ? <Text style={[s.failed, { color: t.dimmer }]}>Couldn't load the picture</Text> : null
      ) : (
        <Image source={source(a.id)} cachePolicy="memory-disk" recyclingKey={a.id} contentFit="cover" transition={120} onError={() => setFailed(true)} style={{ width, height }} />
      )}
    </View>
  );
}

function Picture({ a, source, onPress }: { a: Attachment; source: Source; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="imagebutton" accessibilityLabel={a.caption ?? a.name} onPress={onPress} style={s.picture}>
      <Thumb a={a} source={source} />
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

/** An image full screen: pinch or double-tap to zoom, Share to send it on, Done to close. */
function Viewer({ a, source, fetchAttachment, onClose }: { a: Attachment | null; source: Source; fetchAttachment: Fetch; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const zoom = useRef(1);
  const tapAt = useRef(0);
  const boxH = height - insets.top - insets.bottom - 56;
  useEffect(() => setFailed(false), [a?.id]);

  // iOS zooms a ScrollView natively; a double tap asks it to zoom to a point or back out.
  const doubleTap = (x: number, y: number) => {
    const sv = scroller.current as unknown as { scrollResponderZoomTo?: (r: { x: number; y: number; width: number; height: number; animated: boolean }) => void } | null;
    if (!sv?.scrollResponderZoomTo) return;
    if (zoom.current > 1.05) sv.scrollResponderZoomTo({ x: 0, y: 0, width, height: boxH, animated: true });
    else sv.scrollResponderZoomTo({ x: x - width / 4, y: y - boxH / 4, width: width / 2, height: boxH / 2, animated: true });
  };
  return (
    <Modal visible={!!a} animationType="fade" onRequestClose={onClose} supportedOrientations={["portrait", "landscape"]}>
      <View style={[s.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={s.viewerBar}>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
            <Text style={s.viewerButton}>Done</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !a || failed}
            hitSlop={12}
            style={{ opacity: failed ? 0.35 : 1 }}
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
        <ScrollView
          ref={scroller}
          style={s.full}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={(e) => {
            zoom.current = e.nativeEvent.zoomScale ?? 1;
          }}
          contentContainerStyle={{ width, height: boxH }}
        >
          {a &&
            (failed ? (
              <View style={{ width, height: boxH, alignItems: "center", justifyContent: "center" }}>
                <Text style={s.viewerFailed}>Couldn't load the picture</Text>
              </View>
            ) : (
              <Pressable
                accessibilityLabel="Double-tap to zoom"
                onPress={(e) => {
                  const now = Date.now();
                  if (now - tapAt.current < 320) {
                    tapAt.current = 0;
                    doubleTap(e.nativeEvent.locationX, e.nativeEvent.locationY);
                  } else tapAt.current = now;
                }}
              >
                <Image source={source(a.id)} cachePolicy="memory-disk" contentFit="contain" onError={() => setFailed(true)} style={{ width, height: boxH }} />
              </Pressable>
            ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const THUMB_W = 240;
const THUMB_H = 180;

const s = StyleSheet.create({
  list: { gap: 6 },
  picture: { width: 240, gap: 4 },
  failed: { fontSize: 12.5, textAlign: "center", paddingHorizontal: 12 },
  caption: { fontSize: 13 },
  file: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 8, paddingRight: 14, maxWidth: 280 },
  fileIcon: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  ext: { fontSize: 11, fontWeight: "700" },
  fileText: { flexShrink: 1 },
  fileName: { fontSize: 15, fontWeight: "500" },
  fileMeta: { fontSize: 12.5, marginTop: 1 },
  viewer: { flex: 1, backgroundColor: "#000" },
  full: { flex: 1 },
  viewerFailed: { color: "#8e8e93", fontSize: 15 },
  viewerBar: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 12 },
  viewerButton: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
