import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    commandIds: "src/commandIds.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  external: ["react"],
  clean: true,
});
