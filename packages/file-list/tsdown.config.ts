import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  deps: {
    neverBundle: ["react", "react/jsx-runtime"],
  },
  css: {
    fileName: "file-list.css",
    inject: true,
    modules: {
      localsConvention: "camelCase",
    },
  },
});
