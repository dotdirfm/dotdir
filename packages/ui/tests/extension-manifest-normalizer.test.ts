import { describe, expect, it } from "vitest";

import { normalizeExtensionManifest } from "../lib/features/extensions/manifestNormalizer";

function createReader(files: Record<string, string>) {
  return async (path: string): Promise<string | null> => files[path] ?? null;
}

describe("normalizeExtensionManifest", () => {
  it("normalizes localized Open VSX-style static contributions", async () => {
    const ext = await normalizeExtensionManifest({
      extDir: "/ext/example",
      locale: "ru-RU",
      readTextFile: createReader({
        "/ext/example/package.json": JSON.stringify({
          publisher: "pub",
          name: "theme-pack",
          version: "1.2.3",
          displayName: "%displayName%",
          contributes: {
            languages: [{ id: "foo", extensions: [".foo"] }],
            grammars: [{ language: "foo", scopeName: "source.foo", path: "./syntaxes/foo.tmLanguage.json" }],
            themes: [{ label: "%themeLabel%", uiTheme: "vs-dark", path: "./themes/dark.json" }],
          },
        }),
        "/ext/example/package.nls.json": JSON.stringify({
          displayName: "Theme Pack",
          themeLabel: "Dark",
        }),
        "/ext/example/package.nls.ru-ru.json": JSON.stringify({
          themeLabel: "Temnaya",
        }),
      }),
    });

    expect(ext?.identity.manifest.displayName).toBe("Theme Pack");
    expect(ext?.assets.colorThemes?.[0]).toMatchObject({
      label: "Temnaya",
      jsonPath: "/ext/example/themes/dark.json",
    });
    expect(ext?.contributions.grammarRefs?.[0]?.path).toBe("/ext/example/syntaxes/foo.tmLanguage.json");
    expect(ext?.compatibility.activation).toBe("unsupported");
  });

  it("prefers browser activation and preserves path-based development refs", async () => {
    const ext = await normalizeExtensionManifest({
      extDir: "/dev/ext",
      ref: {
        publisher: "override",
        name: "local",
        version: "0.0.0",
        path: "/dev/ext",
        source: "open-vsx-marketplace",
      },
      readTextFile: createReader({
        "/dev/ext/package.json": JSON.stringify({
          publisher: "manifest",
          name: "from-manifest",
          version: "9.9.9",
          browser: "./browser/index.js",
          main: "./node/index.js",
          contributes: {
            commands: [{ command: "local.hello", title: "Hello" }],
          },
        }),
      }),
    });

    expect(ext?.identity.ref).toMatchObject({
      publisher: "override",
      name: "local",
      version: "0.0.0",
      path: "/dev/ext",
      source: "open-vsx-marketplace",
    });
    expect(ext?.runtime.activationEntry).toEqual({
      path: "/dev/ext/browser/index.js",
      format: "cjs",
      sourceField: "browser",
    });
    expect(ext?.compatibility.activation).toBe("supported");
  });

  it("falls back to main activation when browser is absent", async () => {
    const ext = await normalizeExtensionManifest({
      extDir: "/ext/main-only",
      readTextFile: createReader({
        "/ext/main-only/package.json": JSON.stringify({
          publisher: "pub",
          name: "main-only",
          version: "1.0.0",
          type: "module",
          main: "./dist/main.mjs",
        }),
      }),
    });

    expect(ext?.runtime.activationEntry).toEqual({
      path: "/ext/main-only/dist/main.mjs",
      format: "esm",
      sourceField: "main",
    });
  });

  it("keeps desktop UI-only extensions static when browser activation is absent", async () => {
    const ext = await normalizeExtensionManifest({
      extDir: "/ext/ui-only",
      readTextFile: createReader({
        "/ext/ui-only/package.json": JSON.stringify({
          publisher: "pub",
          name: "ui-only",
          version: "1.0.0",
          main: "./extension.js",
          extensionKind: ["ui"],
          activationEvents: ["*"],
          contributes: {
            commands: [{ command: "ui-only.enable", title: "Enable" }],
          },
        }),
      }),
    });

    expect(ext?.runtime.activationEntry).toBeUndefined();
    expect(ext?.compatibility).toEqual({
      activation: "unsupported",
      reason: "Desktop UI extension has no browser activation entry; static contributions loaded only.",
    });
    expect(ext?.contributions.commands?.[0]?.command).toBe("ui-only.enable");
  });

  it("returns null when package.json is missing and throws on malformed JSON", async () => {
    await expect(
      normalizeExtensionManifest({
        extDir: "/missing",
        readTextFile: createReader({}),
      }),
    ).resolves.toBeNull();

    await expect(
      normalizeExtensionManifest({
        extDir: "/bad",
        readTextFile: createReader({ "/bad/package.json": "{" }),
      }),
    ).rejects.toThrow();
  });
});
