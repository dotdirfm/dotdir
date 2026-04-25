import { describe, expect, it } from "vitest";

import type { Bridge, FsEntry } from "../lib/features/bridge";
import { deriveOpenedResources } from "../lib/features/extensions/extensionHostWorkspaceSync";
import { clearWorkspaceRootCache, findWorkspaceRoot, workspaceContainsMatch } from "../lib/features/extensions/workspaceContains";
import type { PanelTab } from "../lib/entities/tab/model/types";

function createBridge(files: Record<string, string>, dirs: Record<string, FsEntry[]> = {}): Bridge {
  const encoder = new TextEncoder();
  return {
    fs: {
      entries: async (dirPath: string) => dirs[dirPath] ?? [],
      stat: async (filePath: string) => ({ size: files[filePath]?.length ?? 0, mtimeMs: 0 }),
      exists: async (filePath: string) => files[filePath] != null || dirs[filePath] != null,
      readFile: async (filePath: string) => {
        const text = files[filePath];
        if (text == null) throw new Error("ENOENT");
        return encoder.encode(text).buffer;
      },
      open: async () => 0,
      read: async () => new ArrayBuffer(0),
      close: async () => {},
      watch: async () => true,
      unwatch: async () => {},
      onFsChange: () => () => {},
      writeFile: async () => {},
      writeBinaryFile: async () => {},
      createDir: async () => {},
      moveToTrash: async () => {},
      copy: { start: async () => 0, cancel: async () => {}, resolveConflict: async () => {}, onProgress: () => () => {} },
      move: { start: async () => 0, cancel: async () => {}, resolveConflict: async () => {}, onProgress: () => () => {} },
      delete: { start: async () => 0, cancel: async () => {}, onProgress: () => () => {} },
      search: { start: async () => 0, cancel: async () => {}, onProgress: () => () => {} },
      rename: { rename: async () => {} },
    },
    pty: { spawn: async () => ({ ptyId: 0, cwd: "/", shell: "" }), write: async () => {}, resize: async () => {}, close: async () => {}, onData: () => () => {}, onExit: () => () => {} },
    utils: { getHomePath: async () => "/", debugLog: async () => {} },
    window: { getState: async () => null, setState: async () => {}, onStateChanged: () => () => {} },
    systemTheme: { get: async () => "light", onChange: () => () => {} },
    extensions: { install: async () => {}, onProgress: () => () => {} },
  } as unknown as Bridge;
}

describe("workspace-gated LSP activation helpers", () => {
  it("resolves the nearest opted-in .dir/settings.json workspace root", async () => {
    clearWorkspaceRootCache();
    const bridge = createBridge({
      "/repo/.dir/settings.json": '{ "workspace": true }',
      "/repo/packages/app/.dir/settings.json": '{ "workspace": true }',
      "/repo/other/.dir/settings.json": '{ "workspace": false }',
    });

    await expect(findWorkspaceRoot(bridge, "/repo/packages/app/src/index.ts", "file")).resolves.toBe("/repo/packages/app");
    await expect(findWorkspaceRoot(bridge, "/repo/packages/app/src", "directory")).resolves.toBe("/repo/packages/app");
    await expect(findWorkspaceRoot(bridge, "/repo/other/src/index.ts", "file")).resolves.toBe("/repo");
  });

  it("ignores missing, invalid, and false workspace settings", async () => {
    clearWorkspaceRootCache();
    const bridge = createBridge({
      "/bad/.dir/settings.json": "{",
      "/off/.dir/settings.json": '{ "workspace": false }',
    });

    await expect(findWorkspaceRoot(bridge, "/missing/src/index.ts", "file")).resolves.toBeNull();
    await expect(findWorkspaceRoot(bridge, "/bad/src/index.ts", "file")).resolves.toBeNull();
    await expect(findWorkspaceRoot(bridge, "/off/src/index.ts", "file")).resolves.toBeNull();
  });

  it("matches common workspaceContains glob shapes", async () => {
    const bridge = createBridge(
      {},
      {
        "/repo": [
          { name: "package.json", path: "/repo/package.json", kind: "file" },
          { name: "src", path: "/repo/src", kind: "directory" },
          { name: "native", path: "/repo/native", kind: "directory" },
        ],
        "/repo/src": [{ name: "index.ts", path: "/repo/src/index.ts", kind: "file" }],
        "/repo/native": [{ name: "app.sln", path: "/repo/native/app.sln", kind: "file" }],
      },
    );

    await expect(workspaceContainsMatch(bridge, "/repo", "package.json")).resolves.toBe(true);
    await expect(workspaceContainsMatch(bridge, "/repo", "**/*.sln")).resolves.toBe(true);
    await expect(workspaceContainsMatch(bridge, "/repo", "**/*.{js,ts}")).resolves.toBe(true);
    await expect(workspaceContainsMatch(bridge, "/repo", "src/index.?s")).resolves.toBe(true);
    await expect(workspaceContainsMatch(bridge, "/repo", "**/*.rs")).resolves.toBe(false);
  });

  it("matches language contribution extension globs used for workspace inference", async () => {
    const bridge = createBridge(
      {},
      {
        "/repo": [
          { name: "package.json", path: "/repo/package.json", kind: "file" },
          { name: "packages", path: "/repo/packages", kind: "directory" },
        ],
        "/repo/packages": [{ name: "ui", path: "/repo/packages/ui", kind: "directory" }],
        "/repo/packages/ui": [{ name: "index.tsx", path: "/repo/packages/ui/index.tsx", kind: "file" }],
      },
    );

    await expect(workspaceContainsMatch(bridge, "/repo", "**/*.tsx")).resolves.toBe(true);
    await expect(workspaceContainsMatch(bridge, "/repo", "package.json")).resolves.toBe(true);
  });

  it("derives opened resources from every tab, independent of active tab", () => {
    const left: PanelTab[] = [
      { id: "l1", type: "filelist", path: "/repo", entries: [] },
      { id: "l2", type: "preview", path: "/repo/src", name: "index.ts", size: 1, isTemp: true, langId: "typescript" },
    ];
    const right: PanelTab[] = [
      { id: "r1", type: "filelist", path: "/repo/packages/app", entries: [] },
      { id: "r2", type: "preview", path: "/repo", name: "README.md", size: 1, isTemp: false, langId: "markdown" },
    ];

    expect(deriveOpenedResources(left, right)).toEqual([
      { id: "left-tab:l1", kind: "directory", path: "/repo", source: "left-tab" },
      { id: "left-tab:l2", kind: "file", path: "/repo/src/index.ts", langId: "typescript", source: "left-tab" },
      { id: "right-tab:r1", kind: "directory", path: "/repo/packages/app", source: "right-tab" },
      { id: "right-tab:r2", kind: "file", path: "/repo/README.md", langId: "markdown", source: "right-tab" },
    ]);
  });
});
