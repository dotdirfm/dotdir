import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ModalDialog } from './ModalDialog';
import { OpenCreateFileDialog } from './OpenCreateFileDialog';
import { DeleteProgressDialog } from './DeleteProgressDialog';
import { MakeFolderDialog } from './MakeFolderDialog';
import { CopyConfigDialog } from './CopyConfigDialog';
import { CopyProgressDialog } from './CopyProgressDialog';
import { ConflictDialog } from './ConflictDialog';
import { MoveConfigDialog } from './MoveConfigDialog';
import { RenameDialog } from './RenameDialog';
import type { LanguageOption } from './OpenCreateFileDialog';
import type { CopyOptions, MoveOptions, ConflictResolution } from './bridge';

export interface MessageDialogButton {
  label: string;
  default?: boolean;
  onClick?: () => void;
}

export type DialogSpec =
  | {
      type: 'message';
      title?: string;
      message: string;
      variant?: 'error' | 'default';
      buttons?: MessageDialogButton[];
    }
  | {
      type: 'openCreateFile';
      currentPath: string;
      languages: LanguageOption[];
      onConfirm: (filePath: string, fileName: string, langId: string) => void;
      onCancel: () => void;
    }
  | {
      type: 'deleteProgress';
      total: number;
      current: number;
      currentPath: string;
      onCancel: () => void;
    }
  | {
      type: 'cancelDeleteConfirm';
      onResume: () => void;
      onCancelDeletion: () => void;
    }
  | {
      type: 'makeFolder';
      currentPath: string;
      onConfirm: (folderName: string) => void;
      onCancel: () => void;
    }
  | {
      type: 'copyConfig';
      itemCount: number;
      destPath: string;
      onConfirm: (options: CopyOptions) => void;
      onCancel: () => void;
    }
  | {
      type: 'copyProgress';
      bytesCopied: number;
      bytesTotal: number;
      filesDone: number;
      filesTotal: number;
      currentFile: string;
      onCancel: () => void;
    }
  | {
      type: 'copyConflict';
      src: string;
      dest: string;
      srcSize: number;
      srcMtimeMs: number;
      destSize: number;
      destMtimeMs: number;
      onResolve: (resolution: ConflictResolution) => void;
    }
  | {
      type: 'cancelCopyConfirm';
      onResume: () => void;
      onCancelCopy: () => void;
    }
  | {
      type: 'moveConfig';
      itemCount: number;
      destPath: string;
      onConfirm: (options: MoveOptions) => void;
      onCancel: () => void;
    }
  | {
      type: 'moveProgress';
      bytesCopied: number;
      bytesTotal: number;
      filesDone: number;
      filesTotal: number;
      currentFile: string;
      onCancel: () => void;
    }
  | {
      type: 'moveConflict';
      src: string;
      dest: string;
      srcSize: number;
      srcMtimeMs: number;
      destSize: number;
      destMtimeMs: number;
      onResolve: (resolution: ConflictResolution) => void;
    }
  | {
      type: 'cancelMoveConfirm';
      onResume: () => void;
      onCancelMove: () => void;
    }
  | {
      type: 'rename';
      currentName: string;
      onConfirm: (newName: string) => void;
      onCancel: () => void;
    };

export type DialogUpdate =
  | Partial<Pick<DialogSpec & { type: 'deleteProgress' }, 'current' | 'currentPath'>>
  | Partial<Pick<DialogSpec & { type: 'copyProgress' }, 'bytesCopied' | 'bytesTotal' | 'filesDone' | 'filesTotal' | 'currentFile'>>
  | Partial<Pick<DialogSpec & { type: 'moveProgress' }, 'bytesCopied' | 'bytesTotal' | 'filesDone' | 'filesTotal' | 'currentFile'>>;

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
      if (prev?.type === 'deleteProgress' || prev?.type === 'copyProgress' || prev?.type === 'moveProgress') {
        return { ...prev, ...update } as DialogSpec;
      }
      return prev;
    });
  }, []);

  const value = useMemo(
    () => ({ dialog, showDialog, closeDialog, updateDialog }),
    [dialog, showDialog, closeDialog, updateDialog]
  );

  return (
    <DialogContext.Provider value={value}>
      {children}
    </DialogContext.Provider>
  );
}

export function DialogHolder() {
  const ctx = useContext(DialogContext);
  const dialog = ctx?.dialog ?? null;

  if (!dialog) return null;

  switch (dialog.type) {
    case 'message':
      return (
        <ModalDialog
          title={dialog.title}
          message={dialog.message}
          variant={dialog.variant}
          buttons={dialog.buttons}
          onClose={ctx!.closeDialog}
        />
      );
    case 'openCreateFile':
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
    case 'deleteProgress':
      return (
        <DeleteProgressDialog
          total={dialog.total}
          current={dialog.current}
          currentPath={dialog.currentPath}
          onCancel={dialog.onCancel}
        />
      );
    case 'cancelDeleteConfirm':
      return (
        <ModalDialog
          title="Cancel deletion?"
          message="Already deleted items cannot be recovered."
          onClose={dialog.onResume}
          buttons={[
            { label: 'Resume', default: true, onClick: dialog.onResume },
            { label: 'Cancel deletion', onClick: () => {
              dialog.onCancelDeletion();
              ctx!.closeDialog();
            }},
          ]}
        />
      );
    case 'makeFolder':
      return (
        <MakeFolderDialog
          currentPath={dialog.currentPath}
          onConfirm={(name: string) => {
            dialog.onConfirm(name);
            ctx!.closeDialog();
          }}
          onCancel={() => {
            dialog.onCancel();
            ctx!.closeDialog();
          }}
        />
      );
     case 'copyConfig':
       return (
         <CopyConfigDialog
           itemCount={dialog.itemCount}
           destPath={dialog.destPath}
           onConfirm={(options) => {
             dialog.onConfirm(options);
           }}
           onCancel={() => {
             dialog.onCancel();
             ctx!.closeDialog();
           }}
         />
      );
    case 'copyProgress':
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
    case 'copyConflict':
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
    case 'cancelCopyConfirm':
      return (
        <ModalDialog
          title="Cancel copy?"
          message="Files already copied will remain at the destination."
          onClose={dialog.onResume}
          buttons={[
            { label: 'Resume', default: true, onClick: dialog.onResume },
            { label: 'Cancel copy', onClick: () => {
              dialog.onCancelCopy();
              ctx!.closeDialog();
            }},
          ]}
        />
      );
     case 'moveConfig':
       return (
         <MoveConfigDialog
           itemCount={dialog.itemCount}
           destPath={dialog.destPath}
           onConfirm={(options) => {
             dialog.onConfirm(options);
           }}
           onCancel={() => {
             dialog.onCancel();
             ctx!.closeDialog();
           }}
         />
      );
    case 'moveProgress':
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
    case 'moveConflict':
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
    case 'cancelMoveConfirm':
      return (
        <ModalDialog
          title="Cancel move?"
          message="Files already moved cannot be automatically restored."
          onClose={dialog.onResume}
          buttons={[
            { label: 'Resume', default: true, onClick: dialog.onResume },
            { label: 'Cancel move', onClick: () => {
              dialog.onCancelMove();
              ctx!.closeDialog();
            }},
          ]}
        />
      );
    case 'rename':
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

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used within DialogProvider');
  return ctx;
}
