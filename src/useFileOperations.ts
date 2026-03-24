/**
 * useFileOperations — file operation handlers (copy, move, delete, rename) and
 * their background-progress listeners.
 *
 * Extracted from app.tsx so the main component stays lean.  All dialog interaction
 * goes through the shared DialogContext (useDialog()).
 */

import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { ConflictResolution, CopyOptions, CopyProgressEvent, DeleteProgressEvent, MoveOptions, MoveProgressEvent } from "./bridge";
import { bridge } from "./bridge";
import { loadFsProvider } from "./browserFsProvider";
import { isContainerPath, parseContainerPath } from "./containerPath";
import { useDialog } from "./dialogContext";
import type { FsProviderExtensionApi } from "./extensionApi";
import { basename, dirname, join } from "./path";
import { fsProviderRegistry } from "./viewerEditorRegistry";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PanelSide = "left" | "right";

/** Minimal interface the hook needs from each panel. */
export interface PanelHandle {
  currentPath: string;
  navigateTo(path: string, force?: boolean): void;
}

// ── Container-extraction helper ───────────────────────────────────────────────

async function collectContainerFiles(
  listFn: (innerPath: string) => Promise<Array<{ name: string; kind: string }>>,
  innerPath: string,
  destRelPath: string,
): Promise<Array<{ innerPath: string; destRelPath: string }>> {
  const entries = await listFn(innerPath);
  if (entries.length === 0) return [{ innerPath, destRelPath }];
  const results: Array<{ innerPath: string; destRelPath: string }> = [];
  for (const entry of entries) {
    const childInner = innerPath === "/" ? `/${entry.name}` : `${innerPath}/${entry.name}`;
    const childDest = `${destRelPath}/${entry.name}`;
    results.push(...(await collectContainerFiles(listFn, childInner, childDest)));
  }
  return results;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useFileOperations(
  activePanelRef: RefObject<PanelSide>,
  leftRef: RefObject<PanelHandle>,
  rightRef: RefObject<PanelHandle>,
  setSelectionKey: Dispatch<SetStateAction<number>>,
) {
  const { showDialog, closeDialog, updateDialog } = useDialog();

  // ── Progress-tracking refs ────────────────────────────────────────────────

  const activeCopyIdRef = useRef<number | null>(null);
  const copyProgressSpecRef = useRef<{
    type: "copyProgress";
    bytesCopied: number;
    bytesTotal: number;
    filesDone: number;
    filesTotal: number;
    currentFile: string;
    onCancel: () => void;
  } | null>(null);

  const activeMoveIdRef = useRef<number | null>(null);
  const moveProgressSpecRef = useRef<{
    type: "moveProgress";
    bytesCopied: number;
    bytesTotal: number;
    filesDone: number;
    filesTotal: number;
    currentFile: string;
    onCancel: () => void;
  } | null>(null);

  const activeDeleteIdRef = useRef<number | null>(null);
  const deleteProgressSpecRef = useRef<{
    type: "deleteProgress";
    filesDone: number;
    currentFile: string;
    onCancel: () => void;
  } | null>(null);

  // Stable helpers that read from refs so progress listeners don't need re-registration.
  const refreshBoth = useCallback(() => {
    setSelectionKey((k) => k + 1);
    leftRef.current.navigateTo(leftRef.current.currentPath);
    rightRef.current.navigateTo(rightRef.current.currentPath);
  }, [setSelectionKey, leftRef, rightRef]);

  // ── Trash ─────────────────────────────────────────────────────────────────

  const handleMoveToTrash = useCallback(
    (sourcePaths: string[], refresh: () => void) => {
      if (sourcePaths.length === 0) return;
      const label = sourcePaths.length === 1 ? `Move "${basename(sourcePaths[0])}" to Trash?` : `Move ${sourcePaths.length} items to Trash?`;
      showDialog({
        type: "message",
        title: "Move to Trash",
        message: label,
        variant: "default",
        buttons: [
          { label: "Cancel" },
          {
            label: "Move to Trash",
            default: true,
            onClick: async () => {
              try {
                await bridge.fs.moveToTrash(sourcePaths);
                refresh();
              } catch (e) {
                showDialog({
                  type: "message",
                  title: "Error",
                  message: e instanceof Error ? e.message : String(e),
                  variant: "error",
                });
              }
            },
          },
        ],
      });
    },
    [showDialog],
  );

  // ── Permanent delete ──────────────────────────────────────────────────────

  const handlePermanentDelete = useCallback(
    (sourcePaths: string[], _refresh: () => void) => {
      if (sourcePaths.length === 0) return;
      const label =
        sourcePaths.length === 1
          ? `Permanently delete "${basename(sourcePaths[0])}"? This cannot be undone.`
          : `Permanently delete ${sourcePaths.length} items? This cannot be undone.`;
      showDialog({
        type: "message",
        title: "Permanently Delete",
        message: label,
        variant: "default",
        buttons: [
          { label: "Cancel" },
          {
            label: "Delete",
            default: true,
            onClick: async () => {
              try {
                const onCancel = () => {
                  showDialog({
                    type: "cancelDeleteConfirm",
                    onResume: () => {
                      if (deleteProgressSpecRef.current) showDialog(deleteProgressSpecRef.current);
                    },
                    onCancelDeletion: () => {
                      if (activeDeleteIdRef.current !== null) {
                        void bridge.fs.delete.cancel(activeDeleteIdRef.current);
                      }
                      activeDeleteIdRef.current = null;
                      deleteProgressSpecRef.current = null;
                      closeDialog();
                    },
                  });
                };
                const progressSpec = {
                  type: "deleteProgress" as const,
                  filesDone: 0,
                  currentFile: "Preparing...",
                  onCancel,
                };
                deleteProgressSpecRef.current = progressSpec;
                showDialog(progressSpec);
                const deleteId = await bridge.fs.delete.start(sourcePaths);
                if (deleteProgressSpecRef.current !== null) {
                  activeDeleteIdRef.current = deleteId;
                }
              } catch (e) {
                activeDeleteIdRef.current = null;
                deleteProgressSpecRef.current = null;
                closeDialog();
                showDialog({
                  type: "message",
                  title: "Error",
                  message: e instanceof Error ? e.message : String(e),
                  variant: "error",
                });
              }
            },
          },
        ],
      });
    },
    [showDialog, closeDialog],
  );

  // ── Copy ──────────────────────────────────────────────────────────────────

  const handleCopy = useCallback(
    (sourcePaths: string[], refresh: () => void) => {
      const destPanel = activePanelRef.current === "left" ? rightRef.current : leftRef.current;
      const destDir = destPanel.currentPath;
      if (!destDir || sourcePaths.length === 0) return;

      showDialog({
        type: "copyConfig",
        itemCount: sourcePaths.length,
        destPath: destDir,
        onConfirm: async (options: CopyOptions, newDestDir: string) => {
          try {
            // Handle files inside containers (e.g. ZIP archives)
            if (sourcePaths.some((p) => isContainerPath(p))) {
              if (!sourcePaths.every((p) => isContainerPath(p))) {
                throw new Error("Cannot copy files from archives and local files in the same operation");
              }

              // Show dialog immediately so the user sees feedback during collection.
              const progressSpec = {
                type: "copyProgress" as const,
                bytesCopied: 0,
                bytesTotal: 0,
                filesDone: 0,
                filesTotal: 0,
                currentFile: "Collecting files...",
                onCancel: closeDialog,
              };
              copyProgressSpecRef.current = progressSpec;
              showDialog(progressSpec);

              // Phase 1: collect all files to extract, recursing into directories.
              type ExtractJob = {
                innerPath: string;
                destRelPath: string;
                hostFile: string;
                wasmPath: string | null;
                provider: FsProviderExtensionApi | null;
              };
              const jobs: ExtractJob[] = [];
              for (const src of sourcePaths) {
                const { containerFile: hostFile, innerPath } = parseContainerPath(src);
                const match = fsProviderRegistry.resolve(basename(hostFile));
                if (!match) throw new Error(`No fsProvider registered for "${basename(hostFile)}"`);
                let wasmPath: string | null = null;
                let provider: FsProviderExtensionApi | null = null;
                if (match.contribution.runtime === "backend" && bridge.fsProvider) {
                  wasmPath = join(match.extensionDirPath, match.contribution.entry);
                } else {
                  provider = await loadFsProvider(match.extensionDirPath, match.contribution.entry);
                }
                const listFn = async (ip: string) => {
                  if (wasmPath) return bridge.fsProvider!.listEntries(wasmPath, hostFile, ip);
                  const raw = await provider!.listEntries(hostFile, ip);
                  return raw.map((e) => ({ name: e.name, kind: e.type as string }));
                };
                const files = await collectContainerFiles(listFn, innerPath, basename(innerPath));
                files.forEach((f) => jobs.push({ ...f, hostFile, wasmPath, provider }));
              }

              updateDialog({ filesTotal: jobs.length, currentFile: "Extracting..." });
              copyProgressSpecRef.current = {
                ...progressSpec,
                filesTotal: jobs.length,
                currentFile: "Extracting...",
              };

              // Phase 2: create parent dirs and write each file.
              let filesDone = 0;
              for (const { innerPath, destRelPath, hostFile, wasmPath, provider } of jobs) {
                const destPath = join(newDestDir, destRelPath);
                updateDialog({ currentFile: basename(destRelPath), filesDone });
                if (bridge.fs.createDir) await bridge.fs.createDir(dirname(destPath)).catch(() => {});
                let data: ArrayBuffer;
                if (wasmPath) {
                  data = await bridge.fsProvider!.readFileRange(wasmPath, hostFile, innerPath, 0, 64 * 1024 * 1024);
                } else {
                  if (!provider?.readFileRange) throw new Error("Provider does not support readFileRange");
                  data = await provider.readFileRange(hostFile, innerPath, 0, 64 * 1024 * 1024);
                }
                await bridge.fs.writeBinaryFile(destPath, new Uint8Array(data));
                filesDone++;
              }

              copyProgressSpecRef.current = null;
              closeDialog();
              refresh();
              return;
            }

            // Set up progress dialog and refs BEFORE starting copy to avoid
            // race condition where Done event arrives before copyId is set.
            const onCancel = () => {
              showDialog({
                type: "cancelCopyConfirm",
                onResume: () => {
                  if (copyProgressSpecRef.current) showDialog(copyProgressSpecRef.current);
                },
                onCancelCopy: () => {
                  if (activeCopyIdRef.current !== null) {
                    bridge.fs.copy.cancel(activeCopyIdRef.current);
                  }
                  activeCopyIdRef.current = null;
                  copyProgressSpecRef.current = null;
                  closeDialog();
                  refresh();
                },
              });
            };
            const progressSpec = {
              type: "copyProgress" as const,
              bytesCopied: 0,
              bytesTotal: 0,
              filesDone: 0,
              filesTotal: 0,
              currentFile: "Preparing...",
              onCancel,
            };
            copyProgressSpecRef.current = progressSpec;
            showDialog(progressSpec);

            const copyId = await bridge.fs.copy.start(sourcePaths, newDestDir, options);
            if (copyProgressSpecRef.current !== null) {
              activeCopyIdRef.current = copyId;
            }
          } catch (e) {
            activeCopyIdRef.current = null;
            copyProgressSpecRef.current = null;
            closeDialog();
            showDialog({
              type: "message",
              title: "Copy Error",
              message: e instanceof Error ? e.message : String(e),
              variant: "error",
            });
          }
        },
        onCancel: () => {},
      });
    },
    [showDialog, closeDialog],
  );

  // ── Copy progress listener ────────────────────────────────────────────────

  useEffect(() => {
    const unsub = bridge.fs.copy.onProgress((payload: CopyProgressEvent) => {
      if (activeCopyIdRef.current === null) {
        if (copyProgressSpecRef.current !== null) {
          activeCopyIdRef.current = payload.copyId;
        } else {
          return;
        }
      } else if (payload.copyId !== activeCopyIdRef.current) {
        return;
      }
      const event = payload.event;

      switch (event.kind) {
        case "progress": {
          const update = {
            bytesCopied: event.bytesCopied,
            bytesTotal: event.bytesTotal,
            filesDone: event.filesDone,
            filesTotal: event.filesTotal,
            currentFile: event.currentFile,
          };
          if (copyProgressSpecRef.current) {
            copyProgressSpecRef.current = { ...copyProgressSpecRef.current, ...update };
          }
          updateDialog(update);
          break;
        }
        case "conflict": {
          showDialog({
            type: "copyConflict",
            src: event.src,
            dest: event.dest,
            srcSize: event.srcSize,
            srcMtimeMs: event.srcMtimeMs,
            destSize: event.destSize,
            destMtimeMs: event.destMtimeMs,
            onResolve: (resolution: ConflictResolution) => {
              bridge.fs.copy.resolveConflict(activeCopyIdRef.current!, resolution);
              if (copyProgressSpecRef.current) showDialog(copyProgressSpecRef.current);
            },
          });
          break;
        }
        case "done": {
          activeCopyIdRef.current = null;
          copyProgressSpecRef.current = null;
          closeDialog();
          refreshBoth();
          break;
        }
        case "error": {
          activeCopyIdRef.current = null;
          copyProgressSpecRef.current = null;
          closeDialog();
          showDialog({
            type: "message",
            title: "Copy Error",
            message: event.message,
            variant: "error",
          });
          refreshBoth();
          break;
        }
      }
    });
    return unsub;
  }, [showDialog, closeDialog, updateDialog, refreshBoth]);

  // ── Move ──────────────────────────────────────────────────────────────────

  const handleMove = useCallback(
    (sourcePaths: string[], refresh: () => void) => {
      const destPanel = activePanelRef.current === "left" ? rightRef.current : leftRef.current;
      const destDir = destPanel.currentPath;
      if (!destDir || sourcePaths.length === 0) return;

      showDialog({
        type: "moveConfig",
        itemCount: sourcePaths.length,
        destPath: destDir,
        onConfirm: async (options: MoveOptions, newDestDir: string) => {
          try {
            const onCancel = () => {
              showDialog({
                type: "cancelMoveConfirm",
                onResume: () => {
                  if (moveProgressSpecRef.current) showDialog(moveProgressSpecRef.current);
                },
                onCancelMove: () => {
                  if (activeMoveIdRef.current !== null) {
                    bridge.fs.move.cancel(activeMoveIdRef.current);
                  }
                  activeMoveIdRef.current = null;
                  moveProgressSpecRef.current = null;
                  closeDialog();
                  refresh();
                },
              });
            };
            const progressSpec = {
              type: "moveProgress" as const,
              bytesCopied: 0,
              bytesTotal: 0,
              filesDone: 0,
              filesTotal: 0,
              currentFile: "Preparing...",
              onCancel,
            };
            moveProgressSpecRef.current = progressSpec;
            showDialog(progressSpec);

            const moveId = await bridge.fs.move.start(sourcePaths, newDestDir, options);
            if (moveProgressSpecRef.current !== null) {
              activeMoveIdRef.current = moveId;
            }
          } catch (e) {
            activeMoveIdRef.current = null;
            moveProgressSpecRef.current = null;
            closeDialog();
            showDialog({
              type: "message",
              title: "Move Error",
              message: e instanceof Error ? e.message : String(e),
              variant: "error",
            });
          }
        },
        onCancel: () => {},
      });
    },
    [showDialog, closeDialog],
  );

  // ── Move progress listener ────────────────────────────────────────────────

  useEffect(() => {
    const unsub = bridge.fs.move.onProgress((payload: MoveProgressEvent) => {
      if (activeMoveIdRef.current === null) {
        if (moveProgressSpecRef.current !== null) {
          activeMoveIdRef.current = payload.moveId;
        } else {
          return;
        }
      } else if (payload.moveId !== activeMoveIdRef.current) {
        return;
      }
      const event = payload.event;

      switch (event.kind) {
        case "progress": {
          const update = {
            bytesCopied: event.bytesCopied,
            bytesTotal: event.bytesTotal,
            filesDone: event.filesDone,
            filesTotal: event.filesTotal,
            currentFile: event.currentFile,
          };
          if (moveProgressSpecRef.current) {
            moveProgressSpecRef.current = { ...moveProgressSpecRef.current, ...update };
          }
          updateDialog(update);
          break;
        }
        case "conflict": {
          showDialog({
            type: "moveConflict",
            src: event.src,
            dest: event.dest,
            srcSize: event.srcSize,
            srcMtimeMs: event.srcMtimeMs,
            destSize: event.destSize,
            destMtimeMs: event.destMtimeMs,
            onResolve: (resolution: ConflictResolution) => {
              bridge.fs.move.resolveConflict(activeMoveIdRef.current!, resolution);
              if (moveProgressSpecRef.current) showDialog(moveProgressSpecRef.current);
            },
          });
          break;
        }
        case "done": {
          activeMoveIdRef.current = null;
          moveProgressSpecRef.current = null;
          closeDialog();
          refreshBoth();
          break;
        }
        case "error": {
          activeMoveIdRef.current = null;
          moveProgressSpecRef.current = null;
          closeDialog();
          showDialog({
            type: "message",
            title: "Move Error",
            message: event.message,
            variant: "error",
          });
          refreshBoth();
          break;
        }
      }
    });
    return unsub;
  }, [showDialog, closeDialog, updateDialog, refreshBoth]);

  // ── Delete progress listener ──────────────────────────────────────────────

  useEffect(() => {
    const unsub = bridge.fs.delete.onProgress((payload: DeleteProgressEvent) => {
      if (activeDeleteIdRef.current === null) {
        if (deleteProgressSpecRef.current !== null) {
          activeDeleteIdRef.current = payload.deleteId;
        } else {
          return;
        }
      } else if (payload.deleteId !== activeDeleteIdRef.current) {
        return;
      }
      const event = payload.event;

      switch (event.kind) {
        case "progress": {
          const update = { filesDone: event.filesDone, currentFile: event.currentFile };
          if (deleteProgressSpecRef.current) {
            deleteProgressSpecRef.current = { ...deleteProgressSpecRef.current, ...update };
          }
          updateDialog(update);
          break;
        }
        case "done": {
          activeDeleteIdRef.current = null;
          deleteProgressSpecRef.current = null;
          closeDialog();
          refreshBoth();
          break;
        }
        case "error": {
          activeDeleteIdRef.current = null;
          deleteProgressSpecRef.current = null;
          closeDialog();
          showDialog({
            type: "message",
            title: "Delete Error",
            message: event.message,
            variant: "error",
          });
          refreshBoth();
          break;
        }
      }
    });
    return unsub;
  }, [showDialog, closeDialog, updateDialog, refreshBoth]);

  // ── Rename ────────────────────────────────────────────────────────────────

  const handleRename = useCallback(
    (sourcePath: string, currentName: string, refresh: () => void) => {
      showDialog({
        type: "rename",
        currentName,
        onConfirm: async (newName: string) => {
          try {
            await bridge.fs.rename.rename(sourcePath, newName);
            refresh();
          } catch (e) {
            showDialog({
              type: "message",
              title: "Rename Error",
              message: e instanceof Error ? e.message : String(e),
              variant: "error",
            });
          }
        },
        onCancel: () => {},
      });
    },
    [showDialog],
  );

  return { handleCopy, handleMove, handleMoveToTrash, handlePermanentDelete, handleRename };
}
