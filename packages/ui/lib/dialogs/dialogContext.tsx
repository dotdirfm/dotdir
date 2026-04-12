import type { ConflictResolution, CopyOptions, FileSearchMatch, FileSearchRequest, MoveOptions } from "@/features/bridge";
import { useCommandRegistry } from "@/features/commands/commands";
import { type EditorProps, type ViewerProps } from "@/features/extensions/extensionApi";
import { EditorContainer, ViewerContainer } from "@/features/extensions/ExtensionContainer";
import { ExtensionsPanel } from "@/features/extensions/ExtensionsPanel/ExtensionsPanel";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ConflictDialog } from "./ConflictDialog";
import { CopyConfigDialog } from "./CopyConfigDialog";
import { CopyProgressDialog } from "./CopyProgressDialog";
import { DeleteProgressDialog } from "./DeleteProgressDialog";
import { HotkeyProvider } from "./dialogHotkeys";
import { MakeFolderDialog, type MakeFolderResult } from "./MakeFolderDialog";
import { ModalDialog } from "./ModalDialog";
import { MoveConfigDialog } from "./MoveConfigDialog";
import { OpenCreateFileDialog } from "./OpenCreateFileDialog";
import { RenameDialog } from "./RenameDialog";
import { FindFilesDialog } from "./FindFilesDialog";
import { FindFilesResultsDialog } from "./FindFilesResultsDialog";

export interface MessageDialogButton {
  label: string;
  default?: boolean;
  onClick?: () => void;
}

export type DialogSpec =
  | {
      type: "message";
      title?: string;
      message: string;
      variant?: "error" | "default";
      buttons?: MessageDialogButton[];
    }
  | {
      type: "openCreateFile";
      currentPath: string;
      onConfirm: (filePath: string, fileName: string, langId: string) => void;
      onCancel: () => void;
    }
  | {
      type: "deleteProgress";
      filesDone: number;
      currentFile: string;
      onCancel: () => void;
    }
  | {
      type: "cancelDeleteConfirm";
      onResume: () => void;
      onCancelDeletion: () => void;
    }
  | {
      type: "makeFolder";
      currentPath: string;
      onConfirm: (result: MakeFolderResult) => void;
      onCancel: () => void;
    }
  | {
      type: "copyConfig";
      itemCount: number;
      destPath: string;
      suggestionRoots: Array<{ id: string; label: string; path: string }>;
      onConfirm: (options: CopyOptions, destDir: string) => void;
      onCancel: () => void;
    }
  | {
      type: "copyProgress";
      bytesCopied: number;
      bytesTotal: number;
      filesDone: number;
      filesTotal: number;
      currentFile: string;
      onCancel: () => void;
    }
  | {
      type: "copyConflict";
      src: string;
      dest: string;
      srcSize: number;
      srcMtimeMs: number;
      destSize: number;
      destMtimeMs: number;
      onResolve: (resolution: ConflictResolution) => void;
    }
  | {
      type: "cancelCopyConfirm";
      onResume: () => void;
      onCancelCopy: () => void;
    }
  | {
      type: "moveConfig";
      itemCount: number;
      destPath: string;
      suggestionRoots: Array<{ id: string; label: string; path: string }>;
      onConfirm: (options: MoveOptions, destDir: string) => void;
      onCancel: () => void;
    }
  | {
      type: "moveProgress";
      bytesCopied: number;
      bytesTotal: number;
      filesDone: number;
      filesTotal: number;
      currentFile: string;
      onCancel: () => void;
    }
  | {
      type: "moveConflict";
      src: string;
      dest: string;
      srcSize: number;
      srcMtimeMs: number;
      destSize: number;
      destMtimeMs: number;
      onResolve: (resolution: ConflictResolution) => void;
    }
  | {
      type: "cancelMoveConfirm";
      onResume: () => void;
      onCancelMove: () => void;
    }
  | {
      type: "rename";
      currentName: string;
      onConfirm: (newName: string) => void;
      onCancel: () => void;
    }
  | {
      type: "extensions";
    }
  | {
      type: "findFiles";
      initialRequest: FileSearchRequest;
      suggestionRoots: Array<{ id: string; label: string; path: string }>;
      onConfirm: (request: FileSearchRequest) => void;
      onCancel: () => void;
    }
  | {
      type: "findFilesResults";
      request: FileSearchRequest;
      onAgain: (request: FileSearchRequest) => void;
      onClose: () => void;
      onChdir: (path: string) => void;
      onViewFile: (path: string) => void;
      onEditFile: (path: string) => void;
      onPanelize?: (matches: FileSearchMatch[]) => void;
    }
  | {
      type: "viewer";
      surfaceKey?: string;
      extensionDirPath: string;
      entry: string;
      props: ViewerProps;
      onClose: () => void;
      onExecuteCommand?: (command: string, args?: unknown) => Promise<unknown>;
    }
  | {
      type: "editor";
      surfaceKey?: string;
      extensionDirPath: string;
      entry: string;
      props: EditorProps;
      onClose: () => void;
      onDirtyChange?: (dirty: boolean) => void;
    };

export type DialogUpdate =
  | Partial<Pick<DialogSpec & { type: "deleteProgress" }, "filesDone" | "currentFile">>
  | Partial<Pick<DialogSpec & { type: "copyProgress" }, "bytesCopied" | "bytesTotal" | "filesDone" | "filesTotal" | "currentFile">>
  | Partial<Pick<DialogSpec & { type: "moveProgress" }, "bytesCopied" | "bytesTotal" | "filesDone" | "filesTotal" | "currentFile">>;

interface DialogContextValue {
  dialog: DialogSpec | null;
  dialogs: DialogSpec[];
  extensionSurfaces: Record<string, ExtensionSurfaceSlot>;
  showDialog: (spec: DialogSpec) => void;
  replaceDialog: (spec: DialogSpec) => void;
  showError: (message: string) => void;
  closeDialog: () => void;
  /** Update the current dialog (for deleteProgress or copyProgress: partial updates). */
  updateDialog: (update: DialogUpdate) => void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

type ExtensionDialogSpec = Extract<DialogSpec, { type: "viewer" | "editor" }>;
type ExtensionSurfaceSlot = {
  dialog: ExtensionDialogSpec;
  visible: boolean;
};

function getExtensionDialogReuseKey(spec: ExtensionDialogSpec): string {
  return `${spec.type}:${spec.extensionDirPath}:${spec.entry}`;
}

function assignExtensionDialogSurfaceKey(
  spec: DialogSpec,
  current: DialogSpec | null,
  slots: Record<string, ExtensionSurfaceSlot>,
  nextSurfaceIdRef: React.MutableRefObject<number>,
): DialogSpec {
  if (spec.type !== "viewer" && spec.type !== "editor") return spec;
  if (spec.surfaceKey) return spec;
  const reuseKey = getExtensionDialogReuseKey(spec);
  const currentSurfaceKey =
    current?.type === spec.type && current.extensionDirPath === spec.extensionDirPath && current.entry === spec.entry ? current.surfaceKey : undefined;
  const parkedSurfaceKey = Object.entries(slots).find(([, slot]) => !slot.visible && getExtensionDialogReuseKey(slot.dialog) === reuseKey)?.[0];
  return {
    ...spec,
    surfaceKey: currentSurfaceKey ?? parkedSurfaceKey ?? `dialog-surface-${++nextSurfaceIdRef.current}`,
  };
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const commandRegistry = useCommandRegistry();
  const [state, setState] = useState<{ dialogs: DialogSpec[]; extensionSurfaces: Record<string, ExtensionSurfaceSlot> }>({
    dialogs: [],
    extensionSurfaces: {},
  });
  const { dialogs, extensionSurfaces } = state;
  const dialog = dialogs.length > 0 ? dialogs[dialogs.length - 1]! : null;
  const nextSurfaceIdRef = React.useRef(0);

  useEffect(() => {
    commandRegistry.setContext("dialogOpen", dialogs.length > 0);
    return () => {
      commandRegistry.setContext("dialogOpen", false);
    };
  }, [commandRegistry, dialogs.length]);

  const showDialog = useCallback((spec: DialogSpec) => {
    setState((prev) => {
      const nextSpec = assignExtensionDialogSurfaceKey(spec, prev.dialogs[prev.dialogs.length - 1] ?? null, prev.extensionSurfaces, nextSurfaceIdRef);
      const nextSurfaces = { ...prev.extensionSurfaces };
      if (nextSpec.type === "viewer" || nextSpec.type === "editor") {
        const surfaceKey = nextSpec.surfaceKey;
        if (surfaceKey) {
          nextSurfaces[surfaceKey] = {
            dialog: nextSpec,
            visible: true,
          };
        }
      }
      return {
        extensionSurfaces: nextSurfaces,
        dialogs: [...prev.dialogs, nextSpec],
      };
    });
  }, []);

  const replaceDialog = useCallback((spec: DialogSpec) => {
    setState((prev) => {
      const nextSpec = assignExtensionDialogSurfaceKey(spec, prev.dialogs.length > 0 ? prev.dialogs[prev.dialogs.length - 1]! : null, prev.extensionSurfaces, nextSurfaceIdRef);
      const nextSurfaces = { ...prev.extensionSurfaces };
      if (nextSpec.type === "viewer" || nextSpec.type === "editor") {
        const surfaceKey = nextSpec.surfaceKey;
        if (surfaceKey) {
          nextSurfaces[surfaceKey] = {
            dialog: nextSpec,
            visible: true,
          };
        }
      }
      if (prev.dialogs.length === 0) {
        return {
          extensionSurfaces: nextSurfaces,
          dialogs: [nextSpec],
        };
      }
      const nextDialogs = [...prev.dialogs];
      nextDialogs[nextDialogs.length - 1] = nextSpec;
      return {
        extensionSurfaces: nextSurfaces,
        dialogs: nextDialogs,
      };
    });
  }, []);

  const showError = useCallback(
    (message: string) => {
      showDialog({
        type: "message",
        title: "Error",
        message,
        variant: "error",
      });
    },
    [showDialog],
  );

  const closeDialog = useCallback(() => {
    setState((prev) => {
      const current = prev.dialogs.length > 0 ? prev.dialogs[prev.dialogs.length - 1]! : null;
      const nextSurfaces = { ...prev.extensionSurfaces };
      if (current?.type === "viewer" || current?.type === "editor") {
        const surfaceKey = current.surfaceKey;
        if (surfaceKey) {
          nextSurfaces[surfaceKey] = {
            dialog: current,
            visible: false,
          };
        }
        return {
          extensionSurfaces: nextSurfaces,
          dialogs: prev.dialogs.slice(0, -1),
        };
      }
      return {
        extensionSurfaces: nextSurfaces,
        dialogs: prev.dialogs.slice(0, -1),
      };
    });
  }, []);

  const updateDialog = useCallback((update: DialogUpdate) => {
    setState((prev) => {
      const current = prev.dialogs.length > 0 ? prev.dialogs[prev.dialogs.length - 1]! : null;
      if (current?.type === "deleteProgress" || current?.type === "copyProgress" || current?.type === "moveProgress") {
        const nextDialogs = [...prev.dialogs];
        nextDialogs[nextDialogs.length - 1] = { ...current, ...update } as DialogSpec;
        return {
          ...prev,
          dialogs: nextDialogs,
        };
      }
      return prev;
    });
  }, []);

  const value = useMemo(
    () => ({ dialog, dialogs, extensionSurfaces, showDialog, replaceDialog, closeDialog, updateDialog, showError }),
    [dialog, dialogs, extensionSurfaces, showDialog, replaceDialog, closeDialog, updateDialog, showError],
  );

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

function renderDialogContent(dialog: DialogSpec, ctx: DialogContextValue, stackIndex = 0): React.ReactElement | null {
  switch (dialog.type) {
    case "message":
      return <ModalDialog title={dialog.title} message={dialog.message} variant={dialog.variant} buttons={dialog.buttons} onClose={ctx!.closeDialog} stackIndex={stackIndex} />;
    case "openCreateFile":
      return (
        <OpenCreateFileDialog
          currentPath={dialog.currentPath}
          onConfirm={(path, name, langId) => {
            dialog.onConfirm(path, name, langId);
            ctx!.closeDialog();
          }}
          onCancel={() => {
            dialog.onCancel();
            ctx!.closeDialog();
          }}
        />
      );
    case "deleteProgress":
      return <DeleteProgressDialog filesDone={dialog.filesDone} currentFile={dialog.currentFile} onCancel={dialog.onCancel} />;
    case "cancelDeleteConfirm":
      return (
        <ModalDialog
          title="Cancel deletion?"
          message="Already deleted items cannot be recovered."
          onClose={dialog.onResume}
          buttons={[
            { label: "Resume", default: true, onClick: dialog.onResume },
            {
              label: "Cancel deletion",
              onClick: () => {
                dialog.onCancelDeletion();
                ctx!.closeDialog();
              },
            },
          ]}
        />
      );
    case "makeFolder":
      return (
        <MakeFolderDialog
          currentPath={dialog.currentPath}
          onConfirm={(result: MakeFolderResult) => {
            dialog.onConfirm(result);
            ctx!.closeDialog();
          }}
          onCancel={() => {
            dialog.onCancel();
            ctx!.closeDialog();
          }}
        />
      );
    case "copyConfig":
      return (
        <CopyConfigDialog
          itemCount={dialog.itemCount}
          destPath={dialog.destPath}
          suggestionRoots={dialog.suggestionRoots}
          onConfirm={(options, destDir) => {
            dialog.onConfirm(options, destDir);
          }}
          onCancel={() => {
            dialog.onCancel();
            ctx!.closeDialog();
          }}
        />
      );
    case "copyProgress":
      return (
        <CopyProgressDialog
          bytesCopied={dialog.bytesCopied}
          bytesTotal={dialog.bytesTotal}
          filesDone={dialog.filesDone}
          filesTotal={dialog.filesTotal}
          currentFile={dialog.currentFile}
          onCancel={dialog.onCancel}
        />
      );
    case "copyConflict":
      return (
        <ConflictDialog
          src={dialog.src}
          dest={dialog.dest}
          srcSize={dialog.srcSize}
          srcMtimeMs={dialog.srcMtimeMs}
          destSize={dialog.destSize}
          destMtimeMs={dialog.destMtimeMs}
          onResolve={(resolution) => {
            dialog.onResolve(resolution);
            ctx!.closeDialog();
          }}
        />
      );
    case "cancelCopyConfirm":
      return (
        <ModalDialog
          title="Cancel copy?"
          message="Files already copied will remain at the destination."
          onClose={dialog.onResume}
          buttons={[
            { label: "Resume", default: true, onClick: dialog.onResume },
            {
              label: "Cancel copy",
              onClick: () => {
                dialog.onCancelCopy();
                ctx!.closeDialog();
              },
            },
          ]}
        />
      );
    case "moveConfig":
      return (
        <MoveConfigDialog
          itemCount={dialog.itemCount}
          destPath={dialog.destPath}
          suggestionRoots={dialog.suggestionRoots}
          onConfirm={(options, destDir) => {
            dialog.onConfirm(options, destDir);
          }}
          onCancel={() => {
            dialog.onCancel();
            ctx!.closeDialog();
          }}
        />
      );
    case "moveProgress":
      return (
        <CopyProgressDialog
          bytesCopied={dialog.bytesCopied}
          bytesTotal={dialog.bytesTotal}
          filesDone={dialog.filesDone}
          filesTotal={dialog.filesTotal}
          currentFile={dialog.currentFile}
          onCancel={dialog.onCancel}
        />
      );
    case "moveConflict":
      return (
        <ConflictDialog
          src={dialog.src}
          dest={dialog.dest}
          srcSize={dialog.srcSize}
          srcMtimeMs={dialog.srcMtimeMs}
          destSize={dialog.destSize}
          destMtimeMs={dialog.destMtimeMs}
          onResolve={(resolution) => {
            dialog.onResolve(resolution);
            ctx!.closeDialog();
          }}
        />
      );
    case "cancelMoveConfirm":
      return (
        <ModalDialog
          title="Cancel move?"
          message="Files already moved cannot be automatically restored."
          onClose={dialog.onResume}
          buttons={[
            { label: "Resume", default: true, onClick: dialog.onResume },
            {
              label: "Cancel move",
              onClick: () => {
                dialog.onCancelMove();
                ctx!.closeDialog();
              },
            },
          ]}
        />
      );
    case "rename":
      return (
        <RenameDialog
          currentName={dialog.currentName}
          onConfirm={(newName) => {
            dialog.onConfirm(newName);
            ctx!.closeDialog();
          }}
          onCancel={() => {
            dialog.onCancel();
            ctx!.closeDialog();
          }}
        />
      );
    case "extensions":
      return <ExtensionsPanel onClose={ctx.closeDialog} />;
    case "findFiles":
      return (
        <FindFilesDialog
          initialRequest={dialog.initialRequest}
          suggestionRoots={dialog.suggestionRoots}
          stackIndex={stackIndex}
          onConfirm={(request) => {
            dialog.onConfirm(request);
          }}
          onCancel={() => {
            dialog.onCancel();
            ctx!.closeDialog();
          }}
        />
      );
    case "findFilesResults":
      return (
        <FindFilesResultsDialog
          request={dialog.request}
          stackIndex={stackIndex}
          onAgain={dialog.onAgain}
          onClose={() => {
            dialog.onClose();
            ctx!.closeDialog();
          }}
          onChdir={dialog.onChdir}
          onViewFile={dialog.onViewFile}
          onEditFile={dialog.onEditFile}
          onPanelize={dialog.onPanelize}
        />
      );
    case "viewer":
      return (
        <ViewerContainer
          extensionDirPath={dialog.extensionDirPath}
          entry={dialog.entry}
          filePath={dialog.props.filePath}
          fileName={dialog.props.fileName}
          fileSize={dialog.props.fileSize}
          stackIndex={stackIndex}
          onClose={dialog.onClose}
          onExecuteCommand={dialog.onExecuteCommand}
        />
      );
    case "editor":
      return (
        <EditorContainer
          extensionDirPath={dialog.extensionDirPath}
          entry={dialog.entry}
          filePath={dialog.props.filePath}
          fileName={dialog.props.fileName}
          langId={dialog.props.langId}
          stackIndex={stackIndex}
          onClose={dialog.onClose}
          onDirtyChange={dialog.onDirtyChange}
        />
      );
    default:
      return null;
  }
}

function renderExtensionDialogSurface(dialog: ExtensionDialogSpec, visible: boolean, stackIndex = 0) {
  if (dialog.type === "viewer") {
    return (
      <ViewerContainer
        key={dialog.surfaceKey}
        extensionDirPath={dialog.extensionDirPath}
        entry={dialog.entry}
        filePath={dialog.props.filePath}
        fileName={dialog.props.fileName}
        fileSize={dialog.props.fileSize}
        stackIndex={stackIndex}
        visible={visible}
        onClose={dialog.onClose}
        onExecuteCommand={dialog.onExecuteCommand}
      />
    );
  }

  return (
    <EditorContainer
      key={dialog.surfaceKey}
      extensionDirPath={dialog.extensionDirPath}
      entry={dialog.entry}
      filePath={dialog.props.filePath}
      fileName={dialog.props.fileName}
      langId={dialog.props.langId}
      stackIndex={stackIndex}
      visible={visible}
      onClose={dialog.onClose}
      onDirtyChange={dialog.onDirtyChange}
    />
  );
}

function ExtensionDialogSurfaceHost({
  extensionSurfaces,
  dialogs,
}: {
  extensionSurfaces: Record<string, ExtensionSurfaceSlot>;
  dialogs: DialogSpec[];
}) {
  const orderBySurfaceKey = new Map<string, number>();
  dialogs.forEach((dialog, index) => {
    if ((dialog.type === "viewer" || dialog.type === "editor") && dialog.surfaceKey) {
      orderBySurfaceKey.set(dialog.surfaceKey, index);
    }
  });
  const orderedSurfaces = Object.entries(extensionSurfaces).sort((left, right) => {
    const leftOrder = orderBySurfaceKey.get(left[0]) ?? -1;
    const rightOrder = orderBySurfaceKey.get(right[0]) ?? -1;
    return leftOrder - rightOrder;
  });

  return (
    <>
      {orderedSurfaces.map(([surfaceKey, slot]) =>
        renderExtensionDialogSurface(slot.dialog, slot.visible, orderBySurfaceKey.get(surfaceKey) ?? 0),
      )}
    </>
  );
}

const HELP_TEXTS: Partial<Record<DialogSpec["type"], string>> = {
  copyConfig: `# Copy

Copies the selected items into the destination directory.

## Destination

The target directory path. You can edit it directly before confirming.

## Conflict handling

What to do when a file with the same name already exists at the destination:

- **Ask** — show a conflict dialog for each file (default)
- **Overwrite** — always replace the existing file
- **Skip** — leave existing files untouched, skip the source
- **Auto-rename** — append a numeric suffix to avoid overwriting (e.g. \`file (2).txt\`)
- **Only newer** — overwrite only when the source was modified more recently

## Symlinks

How to handle symbolic links found in the source:

- **Smart** — links pointing inside the source tree become relative links at the destination; links pointing outside are followed and their target content is copied
- **Copy link** — always recreate the symlink as-is at the destination
- **Copy target** — always follow the link and copy the actual file content

## Options

- **Copy permissions** — preserve file mode bits (read/write/execute)
- **Copy extended attributes** — preserve macOS/Linux xattrs (e.g. resource forks, ACLs)
- **Sparse files** — use sparse allocation for files with large zero-filled regions
- **Use CoW** — use copy-on-write cloning when the filesystem supports it (fast, zero extra disk usage until modified)
- **Disable write cache** — bypass the OS write-back cache; slower but ensures data is flushed to disk immediately
`,

  moveConfig: `# Move

Moves the selected items into the destination directory.

## Destination

The target directory path. You can edit it directly before confirming.

## Conflict handling

What to do when a file with the same name already exists at the destination:

- **Ask** — show a conflict dialog for each file (default)
- **Overwrite** — always replace the existing file
- **Skip** — leave existing files untouched, skip the source
- **Auto-rename** — append a numeric suffix to avoid overwriting (e.g. \`file (2).txt\`)
- **Only newer** — overwrite only when the source was modified more recently

**Note:** When source and destination are on the same filesystem, move is an atomic rename with no data copying. Across filesystems, the file is copied then the source is deleted.
`,

  copyConflict: `# File conflict

A file with the same name already exists at the destination. Choose how to resolve it:

- **Overwrite** — replace the existing destination file with the source file
- **Skip** — keep the existing file and skip this source file
- **Rename** — copy with a custom name you specify
- **Overwrite All** — overwrite this and all remaining conflicts automatically
- **Skip All** — skip this and all remaining conflicts automatically
- **Cancel** — abort the entire copy operation

The source and destination file sizes and modification times are shown above to help you decide.
`,

  moveConflict: `# File conflict

A file with the same name already exists at the destination. Choose how to resolve it:

- **Overwrite** — replace the existing destination file with the source file
- **Skip** — keep the existing file and skip this source file
- **Rename** — move with a custom name you specify
- **Overwrite All** — overwrite this and all remaining conflicts automatically
- **Skip All** — skip this and all remaining conflicts automatically
- **Cancel** — abort the entire move operation

The source and destination file sizes and modification times are shown above to help you decide.
`,

  makeFolder: `# New folder

Enter a name for the new folder. The folder will be created in the active panel's current directory.

With **Process multiple names** checked, separate names with semicolons (\`;\`); multiple folders are created and the list stays in the current directory.

With it unchecked, a single folder is created and the panel navigates into it.

Intermediate directories are not created automatically — the parent directory must already exist.
`,

  rename: `# Rename

Enter a new name for the selected item.

The name must not be empty and must not contain path separator characters (\`/\` on Unix, \`\\\\\` on Windows).
`,

  openCreateFile: `# Open / create file

Type a file path to open an existing file or create a new one.

- If the path is relative, it is resolved against the active panel's current directory.
- If the file does not exist, it will be created when you confirm.
- Choose a **language** to set the syntax highlighting mode for the editor.
`,

  deleteProgress: `# Deleting

Files are being permanently deleted.

Press **Cancel** to stop the deletion. Items that have already been deleted cannot be recovered.
`,

  copyProgress: `# Copying

Files are being copied to the destination.

Press **Cancel** to stop. Files already copied will remain at the destination.
`,

  moveProgress: `# Moving

Files are being moved to the destination.

Press **Cancel** to stop. Files already moved will remain at the destination and will not be restored automatically.
`,
};

export function DialogHolder() {
  const ctx = useContext(DialogContext);
  const dialogs = ctx?.dialogs ?? [];
  const extensionSurfaces = ctx?.extensionSurfaces ?? {};

  if (dialogs.length === 0) {
    return Object.keys(extensionSurfaces).length > 0 ? <ExtensionDialogSurfaceHost extensionSurfaces={extensionSurfaces} dialogs={dialogs} /> : null;
  }

  const stackedDialogs = dialogs.map((item, index) => {
    if (item.type === "viewer" || item.type === "editor") {
      return null;
    }
    const content = renderDialogContent(item, ctx!, index);
    if (!content) return null;
    const helpText = index === dialogs.length - 1 ? HELP_TEXTS[item.type] : undefined;
    return helpText ? <HotkeyProvider key={`dialog-${index}`} helpText={helpText}>{content}</HotkeyProvider> : <React.Fragment key={`dialog-${index}`}>{content}</React.Fragment>;
  });

  return (
    <>
      <ExtensionDialogSurfaceHost extensionSurfaces={extensionSurfaces} dialogs={dialogs} />
      {stackedDialogs}
    </>
  );
}

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within DialogProvider");
  return ctx;
}
