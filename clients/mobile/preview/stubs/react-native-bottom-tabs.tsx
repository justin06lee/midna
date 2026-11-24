import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native-web";

// The system's tab bar, which a browser has none of: every scene kept mounted, the one chosen shown, and a plain capsule to switch with.
type Route = { key: string; title?: string; testID?: string };
export default function TabView({ navigationState, renderScene, onIndexChange, tabBarActiveTintColor, tabBarInactiveTintColor, getSceneStyle }: { navigationState: { index: number; routes: Route[] }; renderScene: (p: { route: Route; jumpTo: (key: string) => void }) => ReactNode; onIndexChange: (i: number) => void; tabBarActiveTintColor?: string; tabBarInactiveTintColor?: string; getSceneStyle?: (p: { route: Route }) => object }) {
  const { index, routes } = navigationState;
  return (
    <View style={{ flex: 1 }}>
      {routes.map((route, i) => (
        <View key={route.key} style={[{ position: "absolute", inset: 0, display: i === index ? "flex" : "none" }, getSceneStyle?.({ route })]}>
          {renderScene({ route, jumpTo: () => {} })}
        </View>
      ))}
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 21, alignItems: "center" }} pointerEvents="box-none">
        <View style={{ flexDirection: "row", height: 62, borderRadius: 31, padding: 4, backgroundColor: "rgba(128,128,128,0.22)", backdropFilter: "blur(20px)" }}>
          {routes.map((route, i) => (
            <Pressable key={route.key} testID={route.testID} onPress={() => onIndexChange(i)} style={{ width: 88, borderRadius: 27, alignItems: "center", justifyContent: "center", backgroundColor: i === index ? "rgba(128,128,128,0.25)" : "transparent" }}>
              <Text style={{ fontFamily: '"Space Grotesk"', fontWeight: "500", fontSize: 12, color: i === index ? tabBarActiveTintColor : tabBarInactiveTintColor }}>{route.title}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}
