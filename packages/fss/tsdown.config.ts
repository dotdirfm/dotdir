import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    helpers: "src/helpers.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  deps: {
    neverBundle: ["css-tree"],
  },
});
