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
import type { LanguageOption } from './OpenCreateFileDialog';

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
    };

interface DialogContextValue {
  dialog: DialogSpec | null;
  showDialog: (spec: DialogSpec) => void;
  closeDialog: () => void;
  /** Update the current dialog (only for deleteProgress: partial current/currentPath). */
  updateDialog: (update: Partial<Pick<DialogSpec & { type: 'deleteProgress' }, 'current' | 'currentPath'>>) => void;
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

  const updateDialog = useCallback((update: { current?: number; currentPath?: string }) => {
    setDialog((prev) => {
      if (prev?.type !== 'deleteProgress') return prev;
      return { ...prev, ...update };
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
    default:
      return null;
  }
}

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used within DialogProvider');
  return ctx;
}
