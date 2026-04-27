import type { ActionQueue } from "./actionQueue";
import { EDIT_FILE, SHELL_EXECUTE, useCommandRegistry, VIEW_FILE } from "@dotdirfm/commands";
import type { FsNode } from "@dotdirfm/fss-lang";
import { useMemo, useRef } from "react";
import type { FileOperationHandlers, LanguageResolver } from "./types";

type DisplayEntry = {
  entry: FsNode;
};

type FileListActionDeps = {
  actionQueue: ActionQueue;
  getDisplayEntries: () => DisplayEntry[];
  getActiveIndex: () => number;
  getSelectedNames: () => ReadonlySet<string>;
  navigateToEntry: (entry: FsNode) => Promise<void>;
  refresh: () => Promise<void>;
  fileOperations?: FileOperationHandlers | null;
  pasteToCommandLine?: (text: string) => void;
  languageResolver?: LanguageResolver;
};

function getSelectedOrActiveEntries({
  getDisplayEntries,
  getActiveIndex,
  getSelectedNames,
}: Pick<FileListActionDeps, "getDisplayEntries" | "getActiveIndex" | "getSelectedNames">): DisplayEntry[] {
  const all = getDisplayEntries();
  const selected = getSelectedNames();
  if (selected.size > 0) {
    return all.filter((item: DisplayEntry) => selected.has(item.entry.name));
  }
  const active = all[getActiveIndex()];
  return active ? [active] : [];
}

export function useFileListActionHandlers(deps: FileListActionDeps) {
  const commandRegistry = useCommandRegistry();
  const depsRef = useRef(deps);
  depsRef.current = deps;

  return useMemo(
    () => ({
      execute: () =>
        depsRef.current.actionQueue.enqueue(async () => {
          const [item] = getSelectedOrActiveEntries(depsRef.current);
          if (!item || item.entry.type !== "file") return;
          if (!(item.entry.meta as { executable?: boolean }).executable) return;
          void commandRegistry.executeCommand(SHELL_EXECUTE, item.entry.path as string);
        }),
      open: () =>
        depsRef.current.actionQueue.enqueue(async () => {
          const [item] = getSelectedOrActiveEntries(depsRef.current);
          if (item) await depsRef.current.navigateToEntry(item.entry);
        }),
      viewFile: () =>
        depsRef.current.actionQueue.enqueue(() => {
          const [item] = getSelectedOrActiveEntries(depsRef.current);
          if (item && item.entry.type === "file") {
            void commandRegistry.executeCommand(VIEW_FILE, item.entry.path as string, item.entry.name, Number(item.entry.meta.size));
          }
        }),
      editFile: () =>
        depsRef.current.actionQueue.enqueue(() => {
          const [item] = getSelectedOrActiveEntries(depsRef.current);
          if (item && item.entry.type === "file") {
            // Always resolve the language from the current registry — the value cached on
            // FsNode.lang can be stale if the folder was listed before an extension that
            // contributes the language finished loading.
            const reg = depsRef.current.languageResolver;
            const resolved = reg?.getLanguageForFilename(item.entry.name);
            const cached = typeof item.entry.lang === "string" && item.entry.lang ? item.entry.lang : "plaintext";
            const langId = resolved && resolved !== "plaintext" ? resolved : cached;
            if (reg && langId === "plaintext" && "languages" in reg && Array.isArray(reg.languages)) {
              console.warn(
                "[editFile] falling back to plaintext for",
                item.entry.name,
                "— registry knows",
                reg.languages.length,
                "languages:",
                reg.languages.map((l: { id: string }) => l.id),
              );
            }
            void commandRegistry.executeCommand(EDIT_FILE, item.entry.path as string, item.entry.name, Number(item.entry.meta.size), langId);
          }
        }),
      moveToTrash: () =>
        depsRef.current.actionQueue.enqueue(() => {
          const ops = depsRef.current.fileOperations;
          if (!ops) return;
          const sourcePaths = getSelectedOrActiveEntries(depsRef.current).map((item) => item.entry.path as string);
          if (sourcePaths.length === 0) return;
          ops.moveToTrash(sourcePaths, depsRef.current.refresh);
        }),
      permanentDelete: () =>
        depsRef.current.actionQueue.enqueue(() => {
          const ops = depsRef.current.fileOperations;
          if (!ops) return;
          const sourcePaths = getSelectedOrActiveEntries(depsRef.current).map((item) => item.entry.path as string);
          if (sourcePaths.length === 0) return;
          ops.permanentDelete(sourcePaths, depsRef.current.refresh);
        }),
      copy: () =>
        depsRef.current.actionQueue.enqueue(() => {
          const ops = depsRef.current.fileOperations;
          if (!ops) return;
          const sourcePaths = getSelectedOrActiveEntries(depsRef.current).map((item) => item.entry.path as string);
          if (sourcePaths.length === 0) return;
          ops.copy(sourcePaths, depsRef.current.refresh);
        }),
      move: () =>
        depsRef.current.actionQueue.enqueue(() => {
          const ops = depsRef.current.fileOperations;
          if (!ops) return;
          const sourcePaths = getSelectedOrActiveEntries(depsRef.current).map((item) => item.entry.path as string);
          if (sourcePaths.length === 0) return;
          ops.move(sourcePaths, depsRef.current.refresh);
        }),
      rename: () =>
        depsRef.current.actionQueue.enqueue(() => {
          const ops = depsRef.current.fileOperations;
          if (!ops) return;
          const [item] = getSelectedOrActiveEntries(depsRef.current);
          if (!item) return;
          ops.rename(item.entry.path as string, item.entry.name, depsRef.current.refresh);
        }),
      pasteFilename: () =>
        depsRef.current.actionQueue.enqueue(() => {
          const [item] = getSelectedOrActiveEntries(depsRef.current);
          if (!item) return;
          if (!depsRef.current.pasteToCommandLine) return;
          const name = item.entry.name;
          const arg = /^[a-zA-Z0-9._+-]+$/.test(name) ? name : JSON.stringify(name);
          depsRef.current.pasteToCommandLine(arg);
        }),
      pastePath: () =>
        depsRef.current.actionQueue.enqueue(() => {
          const [item] = getSelectedOrActiveEntries(depsRef.current);
          if (!item) return;
          if (!depsRef.current.pasteToCommandLine) return;
          const path = ((item.entry.path as string) ?? "").split("\0")[0];
          const arg = /^[a-zA-Z0-9._+/:-]+$/.test(path) ? path : JSON.stringify(path);
          depsRef.current.pasteToCommandLine(arg);
        }),
    }),
    [commandRegistry],
  );
}

export type UseFileListActionHandlersReturn = ReturnType<typeof useFileListActionHandlers>;
