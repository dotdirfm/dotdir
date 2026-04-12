import type { ActionQueue } from "@/components/FileList/actionQueue";
import { useCommandLine } from "@/features/command-line/useCommandLine";
import { useCommandRegistry } from "@/features/commands/commands";
import { EDIT_FILE, SHELL_EXECUTE, VIEW_FILE } from "@/features/commands/commandIds";
import { useFileOperationHandlers } from "@/features/file-ops/fileOperationHandlers";
import type { FsNode } from "fss-lang";
import { useMemo, useRef } from "react";

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
  const ops = useFileOperationHandlers();
  const { paste: pasteToCommandLine } = useCommandLine();
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const opsRef = useRef(ops);
  opsRef.current = ops;
  const pasteToCommandLineRef = useRef(pasteToCommandLine);
  pasteToCommandLineRef.current = pasteToCommandLine;

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
            const langId = typeof item.entry.lang === "string" && item.entry.lang ? item.entry.lang : "plaintext";
            void commandRegistry.executeCommand(EDIT_FILE, item.entry.path as string, item.entry.name, Number(item.entry.meta.size), langId);
          }
        }),
      moveToTrash: () =>
        depsRef.current.actionQueue.enqueue(() => {
          if (!opsRef.current) return;
          const sourcePaths = getSelectedOrActiveEntries(depsRef.current).map((item) => item.entry.path as string);
          if (sourcePaths.length === 0) return;
          opsRef.current.moveToTrash(sourcePaths, depsRef.current.refresh);
        }),
      permanentDelete: () =>
        depsRef.current.actionQueue.enqueue(() => {
          if (!opsRef.current) return;
          const sourcePaths = getSelectedOrActiveEntries(depsRef.current).map((item) => item.entry.path as string);
          if (sourcePaths.length === 0) return;
          opsRef.current.permanentDelete(sourcePaths, depsRef.current.refresh);
        }),
      copy: () =>
        depsRef.current.actionQueue.enqueue(() => {
          if (!opsRef.current) return;
          const sourcePaths = getSelectedOrActiveEntries(depsRef.current).map((item) => item.entry.path as string);
          if (sourcePaths.length === 0) return;
          opsRef.current.copy(sourcePaths, depsRef.current.refresh);
        }),
      move: () =>
        depsRef.current.actionQueue.enqueue(() => {
          if (!opsRef.current) return;
          const sourcePaths = getSelectedOrActiveEntries(depsRef.current).map((item) => item.entry.path as string);
          if (sourcePaths.length === 0) return;
          opsRef.current.move(sourcePaths, depsRef.current.refresh);
        }),
      rename: () =>
        depsRef.current.actionQueue.enqueue(() => {
          if (!opsRef.current) return;
          const [item] = getSelectedOrActiveEntries(depsRef.current);
          if (!item) return;
          opsRef.current.rename(item.entry.path as string, item.entry.name, depsRef.current.refresh);
        }),
      pasteFilename: () =>
        depsRef.current.actionQueue.enqueue(() => {
          const [item] = getSelectedOrActiveEntries(depsRef.current);
          if (!item) return;
          if (!opsRef.current) return;
          const name = item.entry.name;
          const arg = /^[a-zA-Z0-9._+-]+$/.test(name) ? name : JSON.stringify(name);
          pasteToCommandLineRef.current(arg);
        }),
      pastePath: () =>
        depsRef.current.actionQueue.enqueue(() => {
          const [item] = getSelectedOrActiveEntries(depsRef.current);
          if (!item) return;
          if (!opsRef.current) return;
          const path = ((item.entry.path as string) ?? "").split("\0")[0];
          const arg = /^[a-zA-Z0-9._+/:-]+$/.test(path) ? path : JSON.stringify(path);
          pasteToCommandLineRef.current(arg);
        }),
    }),
    [commandRegistry],
  );
}

export type UseFileListActionHandlersReturn = ReturnType<typeof useFileListActionHandlers>;
