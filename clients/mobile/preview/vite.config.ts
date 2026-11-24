import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { join } from "node:path";

/**
 * The phone's screens in a browser, to look at while working on them: the
 * app's own source through react-native-web, with a stand-in for everything
 * native (stubs/). It is a web render, not an iPhone: the layout, colours
 * and type are the app's; native controls, sheets, the keyboard and the
 * safe areas are approximations. It has its own dependencies so the app's
 * stay what the iPhone build needs:
 *
 *   bun run preview                      # in the repo: the throwaway midna; it prints a link ending ?connect=…
 *   cd clients/mobile/preview && bun install && bunx vite
 *   open http://localhost:5191/phones.html?connect=…   (&scheme=dark, &show=chat,model,settings,approvals,vault)
 */
const HERE = import.meta.dirname;
const REPO = join(HERE, "../../..");
const SRC = join(REPO, "clients/mobile/src");
const stub = (name: string) => join(HERE, "stubs", name);

/** The app's own modules that wrap something native: each gets a stand-in. */
const FILES: Record<string, string> = Object.fromEntries(["push", "alarms", "focus", "location", "faceid"].map((n) => [join(SRC, `${n}.ts`), stub(`app-${n}.ts`)]));

function phone(): Plugin {
  return {
    name: "phone-preview",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || !source.startsWith(".")) return null;
      const r = await this.resolve(source, importer, { skipSelf: true });
      return r && FILES[r.id] ? FILES[r.id] : null;
    },
    transform(code, id) {
      // Metro's require("x.png") for an asset: here, its address.
      if (id.includes("/clients/mobile/")) return code.replace(/require\((["'][^"']+\.png["'])\)/g, "new URL($1, import.meta.url).href");
      return null;
    },
  };
}

export default defineConfig({
  plugins: [phone(), react()],
  define: { __DEV__: "true" },
  // The app's tsconfig extends expo's, which isn't installed here: say what is needed instead of reading it.
  esbuild: { tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: "react-jsx", target: "ES2022" } }) },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^react$/, replacement: join(HERE, "node_modules/react") },
      { find: /^react\/jsx-runtime$/, replacement: join(HERE, "node_modules/react/jsx-runtime.js") },
      { find: /^react\/jsx-dev-runtime$/, replacement: join(HERE, "node_modules/react/jsx-dev-runtime.js") },
      { find: /^react-native$/, replacement: stub("react-native.ts") },
      { find: /^@midna\/protocol$/, replacement: join(REPO, "packages/protocol/src/index.ts") },
      { find: /^@phone\/(.*)$/, replacement: `${SRC}/$1` },
      { find: /^react-native-safe-area-context$/, replacement: stub("safe-area.tsx") },
      { find: /^expo\/fetch$/, replacement: stub("expo-fetch.ts") },
      { find: /^react-native-bottom-tabs$/, replacement: stub("react-native-bottom-tabs.tsx") },
      { find: /^@expo\/ui\/swift-ui\/modifiers$/, replacement: stub("expo-ui/modifiers.ts") },
      { find: /^@expo\/ui\/swift-ui$/, replacement: stub("expo-ui/swift-ui.tsx") },
      { find: /^expo-sqlite\/kv-store$/, replacement: stub("kv-store.ts") },
      { find: /^expo-(clipboard|network|sharing|file-system|image|document-picker|image-picker|secure-store|symbols|glass-effect|linear-gradient)$/, replacement: `${HERE}/stubs/expo-$1.tsx` },
    ],
  },
  server: { port: 5191, strictPort: true, fs: { strict: false } },
});
