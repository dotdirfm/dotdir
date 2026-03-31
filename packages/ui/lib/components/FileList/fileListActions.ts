import type { ActionQueue } from "@/actionQueue";
import { useCommandRegistry } from "@/features/commands/commands";
import { useFileOperationHandlers } from "@/features/file-ops/model/fileOperationHandlers";
import type { FsNode } from "fss-lang";
import { useMemo } from "react";

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

  return useMemo(() => ({
    execute: () =>
      deps.actionQueue.enqueue(async () => {
        const [item] = getSelectedOrActiveEntries(deps);
        if (!item || item.entry.type !== "file") return;
        if (!(item.entry.meta as { executable?: boolean }).executable) return;
        void commandRegistry.executeCommand("terminal.execute", item.entry.path as string);
      }),
    open: () =>
      deps.actionQueue.enqueue(async () => {
        const [item] = getSelectedOrActiveEntries(deps);
        if (item) await deps.navigateToEntry(item.entry);
      }),
    viewFile: () =>
      deps.actionQueue.enqueue(() => {
        const [item] = getSelectedOrActiveEntries(deps);
        if (item && item.entry.type === "file") {
          void commandRegistry.executeCommand("viewFile", item.entry.path as string, item.entry.name, Number(item.entry.meta.size));
        }
      }),
    editFile: () =>
      deps.actionQueue.enqueue(() => {
        const [item] = getSelectedOrActiveEntries(deps);
        if (item && item.entry.type === "file") {
          const langId = typeof item.entry.lang === "string" && item.entry.lang ? item.entry.lang : "plaintext";
          void commandRegistry.executeCommand("editFile", item.entry.path as string, item.entry.name, Number(item.entry.meta.size), langId);
        }
      }),
    moveToTrash: () =>
      deps.actionQueue.enqueue(() => {
        if (!ops) return;
        const sourcePaths = getSelectedOrActiveEntries(deps).map((item) => item.entry.path as string);
        if (sourcePaths.length === 0) return;
        ops.moveToTrash(sourcePaths, deps.refresh);
      }),
    permanentDelete: () =>
      deps.actionQueue.enqueue(() => {
        if (!ops) return;
        const sourcePaths = getSelectedOrActiveEntries(deps).map((item) => item.entry.path as string);
        if (sourcePaths.length === 0) return;
        ops.permanentDelete(sourcePaths, deps.refresh);
      }),
    copy: () =>
      deps.actionQueue.enqueue(() => {
        if (!ops) return;
        const sourcePaths = getSelectedOrActiveEntries(deps).map((item) => item.entry.path as string);
        if (sourcePaths.length === 0) return;
        ops.copy(sourcePaths, deps.refresh);
      }),
    move: () =>
      deps.actionQueue.enqueue(() => {
        if (!ops) return;
        const sourcePaths = getSelectedOrActiveEntries(deps).map((item) => item.entry.path as string);
        if (sourcePaths.length === 0) return;
        ops.move(sourcePaths, deps.refresh);
      }),
    rename: () =>
      deps.actionQueue.enqueue(() => {
        if (!ops) return;
        const [item] = getSelectedOrActiveEntries(deps);
        if (!item) return;
        ops.rename(item.entry.path as string, item.entry.name, deps.refresh);
      }),
    pasteFilename: () =>
      deps.actionQueue.enqueue(() => {
        const [item] = getSelectedOrActiveEntries(deps);
        if (!item) return;
        if (!ops) return;
        const name = item.entry.name;
        const arg = /^[a-zA-Z0-9._+-]+$/.test(name) ? name : JSON.stringify(name);
        ops.pasteToCommandLine(arg);
      }),
    pastePath: () =>
      deps.actionQueue.enqueue(() => {
        const [item] = getSelectedOrActiveEntries(deps);
        if (!item) return;
        if (!ops) return;
        const path = ((item.entry.path as string) ?? "").split("\0")[0];
        const arg = /^[a-zA-Z0-9._+/:-]+$/.test(path) ? path : JSON.stringify(path);
        ops.pasteToCommandLine(arg);
      }),
  }), [commandRegistry, deps, ops]);
}
