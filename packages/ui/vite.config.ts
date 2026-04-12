import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

// https://vite.dev/config/
export default defineConfig({
  plugins: [dts()],
  build: {
    lib: {
      entry: "lib/DotDir.tsx",
      name: "DotDir",
      // the proper extensions will be added
      fileName: "dotdir",
      formats: ["es", "cjs"],
    },
    rolldownOptions: {
      external: [
        "react",
        "react/jsx-runtime",
        "react-dom",
        "react-dom/client",
        "react-dom/server",
        "jotai",
        "@xterm/addon-fit",
        "@xterm/xterm",
        "cmdk",
        "fss-lang",
        "jsonc-parser",
        "marked",
      ],
    },
  },
});
