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
