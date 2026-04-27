import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

// https://vite.dev/config/
export default defineConfig({
  plugins: [dts()],
  build: {
    // Wipe `dist/` between builds — otherwise removed imports (e.g. dropped
    // Monaco language workers) leave stale sibling chunks like
    // `dist/assets/ts.worker-*.js` hanging around forever.
    emptyOutDir: true,
    lib: {
      entry: "lib/DotDir.tsx",
      name: "DotDir",
      // the proper extensions will be added
      fileName: "dotdir",
      formats: ["es", "cjs"],
    },
    rolldownOptions: {
      external: [
        "@dotdirfm/commands",
        "@dotdirfm/fss-lang",
        "react",
        "react/jsx-runtime",
        "react-dom",
        "react-dom/client",
        "react-dom/server",
        "jotai",
        "@xterm/addon-fit",
        "@xterm/xterm",
        "cmdk",
        "jsonc-parser",
        "marked",
      ],
    },
  },
});
