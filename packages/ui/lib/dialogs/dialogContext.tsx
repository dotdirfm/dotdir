import type { ConflictResolution, CopyOptions, MoveOptions } from "@/shared/api/bridge";
import React, { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ConflictDialog } from "./ConflictDialog";
import { CopyConfigDialog } from "./CopyConfigDialog";
import { CopyProgressDialog } from "./CopyProgressDialog";
import { DeleteProgressDialog } from "./DeleteProgressDialog";
import { HotkeyProvider } from "./dialogHotkeys";
import { MakeFolderDialog, type MakeFolderResult } from "./MakeFolderDialog";
import { ModalDialog } from "./ModalDialog";
import { MoveConfigDialog } from "./MoveConfigDialog";
import type { LanguageOption } from "./OpenCreateFileDialog";
import { OpenCreateFileDialog } from "./OpenCreateFileDialog";
import { RenameDialog } from "./RenameDialog";

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
      languages: LanguageOption[];
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
    };

export type DialogUpdate =
  | Partial<Pick<DialogSpec & { type: "deleteProgress" }, "filesDone" | "currentFile">>
  | Partial<Pick<DialogSpec & { type: "copyProgress" }, "bytesCopied" | "bytesTotal" | "filesDone" | "filesTotal" | "currentFile">>
  | Partial<Pick<DialogSpec & { type: "moveProgress" }, "bytesCopied" | "bytesTotal" | "filesDone" | "filesTotal" | "currentFile">>;

interface DialogContextValue {
  dialog: DialogSpec | null;
  showDialog: (spec: DialogSpec) => void;
  closeDialog: () => void;
  /** Update the current dialog (for deleteProgress or copyProgress: partial updates). */
  updateDialog: (update: DialogUpdate) => void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogSpec | null>(null);

  const showDialog = useCallback((spec: DialogSpec) => {
    setDialog(spec);
  }, []);

  const closeDialog = useCallback(() => {
    setDialog(null);
  }, []);

  const updateDialog = useCallback((update: DialogUpdate) => {
    setDialog((prev) => {
      if (prev?.type === "deleteProgress" || prev?.type === "copyProgress" || prev?.type === "moveProgress") {
        return { ...prev, ...update } as DialogSpec;
      }
      return prev;
    });
  }, []);

  const value = useMemo(() => ({ dialog, showDialog, closeDialog, updateDialog }), [dialog, showDialog, closeDialog, updateDialog]);

  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>;
}

function renderDialogContent(dialog: DialogSpec, ctx: DialogContextValue): React.ReactElement | null {
  switch (dialog.type) {
    case "message":
      return <ModalDialog title={dialog.title} message={dialog.message} variant={dialog.variant} buttons={dialog.buttons} onClose={ctx!.closeDialog} />;
    case "openCreateFile":
      return (
        <OpenCreateFileDialog
          currentPath={dialog.currentPath}
          languages={dialog.languages}
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
    default:
      return null;
  }
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
  const dialog = ctx?.dialog ?? null;
  if (!dialog) return null;
  const content = renderDialogContent(dialog, ctx!);
  if (!content) return null;
  const helpText = HELP_TEXTS[dialog.type];
  return <HotkeyProvider helpText={helpText}>{content}</HotkeyProvider>;
}

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within DialogProvider");
  return ctx;
}
