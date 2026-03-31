import type { ActionQueue } from "@/actionQueue";
import { getFileOperationHandlers } from "@/features/file-ops/model/fileOperationHandlers";
import { commandRegistry } from "@/features/commands/commands";
import type { FsNode } from "fss-lang";

type DisplayEntry = {
  entry: FsNode;
};

type FileListActionContext = {
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
}: Pick<FileListActionContext, "getDisplayEntries" | "getActiveIndex" | "getSelectedNames">): DisplayEntry[] {
  const all = getDisplayEntries();
  const selected = getSelectedNames();
  if (selected.size > 0) {
    return all.filter((item) => selected.has(item.entry.name));
  }
  const active = all[getActiveIndex()];
  return active ? [active] : [];
}

export function createFileListActionHandlers(ctx: FileListActionContext) {
  return {
    execute: () =>
      ctx.actionQueue.enqueue(async () => {
        const [item] = getSelectedOrActiveEntries(ctx);
        if (!item || item.entry.type !== "file") return;
        if (!(item.entry.meta as { executable?: boolean }).executable) return;
        void commandRegistry.executeCommand("terminal.execute", item.entry.path as string);
      }),
    open: () =>
      ctx.actionQueue.enqueue(async () => {
        const [item] = getSelectedOrActiveEntries(ctx);
        if (item) await ctx.navigateToEntry(item.entry);
      }),
    viewFile: () =>
      ctx.actionQueue.enqueue(() => {
        const [item] = getSelectedOrActiveEntries(ctx);
        if (item && item.entry.type === "file") {
          void commandRegistry.executeCommand("viewFile", item.entry.path as string, item.entry.name, Number(item.entry.meta.size));
        }
      }),
    editFile: () =>
      ctx.actionQueue.enqueue(() => {
        const [item] = getSelectedOrActiveEntries(ctx);
        if (item && item.entry.type === "file") {
          const langId = typeof item.entry.lang === "string" && item.entry.lang ? item.entry.lang : "plaintext";
          void commandRegistry.executeCommand("editFile", item.entry.path as string, item.entry.name, Number(item.entry.meta.size), langId);
        }
      }),
    moveToTrash: () =>
      ctx.actionQueue.enqueue(() => {
        const ops = getFileOperationHandlers();
        if (!ops) return;
        const sourcePaths = getSelectedOrActiveEntries(ctx).map((item) => item.entry.path as string);
        if (sourcePaths.length === 0) return;
        ops.moveToTrash(sourcePaths, ctx.refresh);
      }),
    permanentDelete: () =>
      ctx.actionQueue.enqueue(() => {
        const ops = getFileOperationHandlers();
        if (!ops) return;
        const sourcePaths = getSelectedOrActiveEntries(ctx).map((item) => item.entry.path as string);
        if (sourcePaths.length === 0) return;
        ops.permanentDelete(sourcePaths, ctx.refresh);
      }),
    copy: () =>
      ctx.actionQueue.enqueue(() => {
        const ops = getFileOperationHandlers();
        if (!ops) return;
        const sourcePaths = getSelectedOrActiveEntries(ctx).map((item) => item.entry.path as string);
        if (sourcePaths.length === 0) return;
        ops.copy(sourcePaths, ctx.refresh);
      }),
    move: () =>
      ctx.actionQueue.enqueue(() => {
        const ops = getFileOperationHandlers();
        if (!ops) return;
        const sourcePaths = getSelectedOrActiveEntries(ctx).map((item) => item.entry.path as string);
        if (sourcePaths.length === 0) return;
        ops.move(sourcePaths, ctx.refresh);
      }),
    rename: () =>
      ctx.actionQueue.enqueue(() => {
        const ops = getFileOperationHandlers();
        if (!ops) return;
        const [item] = getSelectedOrActiveEntries(ctx);
        if (!item) return;
        ops.rename(item.entry.path as string, item.entry.name, ctx.refresh);
      }),
    pasteFilename: () =>
      ctx.actionQueue.enqueue(() => {
        const [item] = getSelectedOrActiveEntries(ctx);
        if (!item) return;
        const ops = getFileOperationHandlers();
        if (!ops) return;
        const name = item.entry.name;
        const arg = /^[a-zA-Z0-9._+-]+$/.test(name) ? name : JSON.stringify(name);
        ops.pasteToCommandLine(arg);
      }),
    pastePath: () =>
      ctx.actionQueue.enqueue(() => {
        const [item] = getSelectedOrActiveEntries(ctx);
        if (!item) return;
        const ops = getFileOperationHandlers();
        if (!ops) return;
        const path = ((item.entry.path as string) ?? "").split("\0")[0];
        const arg = /^[a-zA-Z0-9._+/:-]+$/.test(path) ? path : JSON.stringify(path);
        ops.pasteToCommandLine(arg);
      }),
  };
}
