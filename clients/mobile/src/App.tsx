import { useEffect, useState } from "react";
import { View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { forget, loadConnection, loadPrevious, setAside, type PhoneConnection } from "./connection";
import { Main } from "./screens/Main";
import { Pair } from "./screens/Pair";
import { useTheme } from "./theme";

/** Paired, or not yet: the keychain decides which screen comes first. */
export default function App() {
  const t = useTheme();
  // undefined while the keychain is read.
  const [connection, setConnection] = useState<PhoneConnection | null | undefined>(undefined);
  const [previous, setPrevious] = useState<PhoneConnection | null>(null);

  useEffect(() => {
    void Promise.all([loadConnection(), loadPrevious()]).then(([c, p]) => {
      setPrevious(p);
      setConnection(c);
    });
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {connection === undefined ? (
        <View style={{ flex: 1, backgroundColor: t.bg }} />
      ) : connection === null ? (
        <Pair
          previous={previous}
          onPaired={(c) => {
            setPrevious(null);
            setConnection(c);
          }}
        />
      ) : (
        <Main
          key={`${connection.url}#${connection.device}`}
          connection={connection}
          onPairAgain={() => {
            void setAside(connection);
            setPrevious(connection);
            setConnection(null);
          }}
          onUnpaired={() => {
            void forget();
            setPrevious(null);
            setConnection(null);
          }}
        />
      )}
    </SafeAreaProvider>
  );
}
