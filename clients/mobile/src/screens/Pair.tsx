import { useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MidnaError } from "@midna/protocol";
import { clientFor, saveConnection, type PhoneConnection } from "../connection";
import { useDraft, useSecretDraft } from "../drafts";
import { sameHost, serverUrl } from "../server";
import { useTheme } from "../theme";
import { Button, Field, Problem } from "../ui";

/** Waits this long for an answer before saying midna can't be reached. */
const REACH_MS = 6_000;

/**
 * Pair this phone with midna: where it is on the tailnet, a one-time code
 * from `midna pair`, and what to call the phone. Pairing again names the
 * pairing it replaces (only to the same host), so the host retires it.
 */
export function Pair({ previous, onPaired }: { previous: PhoneConnection | null; onPaired: (c: PhoneConnection) => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const server = useDraft("midna.draft:pair#url", previous?.url ?? "");
  const name = useDraft("midna.draft:pair#name", "iPhone");
  const [code, setCode] = useSecretDraft("pair#code");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const pair = async () => {
    const url = serverUrl(server.value);
    if (!url) return setProblem("That isn't an address. Try http://midna:7717, or midna's 100.x address.");
    if (!code.trim()) return setProblem("Enter the pairing code. Get one on the host with `midna pair`.");
    setBusy(true);
    setProblem("");
    const client = clientFor(url);
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), REACH_MS);
      const health = await client.health(ctl.signal).finally(() => clearTimeout(timer));
      const replaces = previous && sameHost(previous.url, url) ? previous.token : undefined;
      const paired = await client.pair({ code: code.trim().toUpperCase(), deviceName: name.value.trim() || "iPhone", kind: "mobile", ...(replaces ? { replaces } : {}) });
      const connection: PhoneConnection = { url, token: paired.token, device: paired.deviceId, name: paired.name || health.name };
      await saveConnection(connection);
      // What was typed has done its job.
      server.clear();
      name.clear();
      setCode("");
      onPaired(connection);
    } catch (err) {
      if (err instanceof MidnaError) setProblem(err.status === 400 || err.status === 401 || err.status === 403 ? "That code didn't work. Codes are single-use and expire after a few minutes; get a new one with `midna pair`." : `midna said: ${err.message}`);
      else setProblem(`Couldn't reach midna at ${url}. Is Tailscale on, and is this the right address?`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={[s.root, { backgroundColor: t.bg }]}>
      <ScrollView contentContainerStyle={[s.body, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <View style={s.head}>
          <Text style={[s.title, { color: t.ink }]}>{previous ? "Pair again" : "Pair with midna"}</Text>
          <Text style={[s.lede, { color: t.dim }]}>
            This phone reaches midna over your tailnet. For a code, run <Text style={s.code}>midna pair</Text> on midna's machine or your Mac.
          </Text>
        </View>
        <Field
          testID="pair-server"
          label="Where midna is"
          value={server.value}
          onChangeText={server.set}
          placeholder="http://midna:7717"
          autoCapitalize="none"
          keyboardType="url"
          textContentType="URL"
          returnKeyType="next"
          hint="Its MagicDNS name or 100.x address. Port 7717 unless you say otherwise."
        />
        <Field testID="pair-code" label="Pairing code" value={code} onChangeText={setCode} placeholder="ABCD2345" autoCapitalize="characters" returnKeyType="next" />
        <Field testID="pair-name" label="Call this phone" value={name.value} onChangeText={name.set} placeholder="iPhone" returnKeyType="go" onSubmitEditing={() => void pair()} />
        <Problem text={problem} />
        <Button testID="pair-submit" label="Pair" kind="primary" busy={busy} onPress={() => void pair()} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  body: { paddingHorizontal: 22, gap: 18 },
  head: { gap: 8, marginBottom: 8 },
  title: { fontSize: 30, fontWeight: "700", letterSpacing: -0.5 },
  lede: { fontSize: 15.5, lineHeight: 21 },
  code: { fontFamily: "Menlo", fontSize: 14 },
});
