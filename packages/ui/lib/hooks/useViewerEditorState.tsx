import { useDialog } from "@/dialogs/dialogContext";
import { activePanelSideAtom, leftActiveTabAtom, leftActiveTabIdAtom, leftTabsAtom, rightActiveTabAtom, rightActiveTabIdAtom, rightTabsAtom } from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { useShowHidden } from "@/features/settings/useUserSettings";
import { useFocusContext } from "@/focusContext";
import { CONTAINER_SEP } from "@/utils/containerPath";
import { isMediaFile } from "@/utils/mediaFiles";
import { basename } from "@/utils/path";
import { useEditorRegistry, useFsProviderRegistry, useViewerRegistry } from "@/viewerEditorRegistry";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function sameViewerDialog(
  dialog: ReturnType<typeof useDialog>["dialog"],
  next:
    | {
        extensionDirPath: string;
        entry: string;
        filePath: string;
        fileName: string;
        fileSize: number;
      }
    | null,
): boolean {
  if (!dialog || dialog.type !== "viewer" || !next) return false;
  return (
    dialog.extensionDirPath === next.extensionDirPath &&
    dialog.entry === next.entry &&
    dialog.props.filePath === next.filePath &&
    dialog.props.fileName === next.fileName &&
    dialog.props.fileSize === next.fileSize
  );
}

function sameEditorDialog(
  dialog: ReturnType<typeof useDialog>["dialog"],
  next:
    | {
        extensionDirPath: string;
        entry: string;
        filePath: string;
        fileName: string;
        langId: string;
      }
    | null,
): boolean {
  if (!dialog || dialog.type !== "editor" || !next) return false;
  return (
    dialog.extensionDirPath === next.extensionDirPath &&
    dialog.entry === next.entry &&
    dialog.props.filePath === next.filePath &&
    dialog.props.fileName === next.fileName &&
    dialog.props.langId === next.langId
  );
}

type UseViewerEditorStateResult = {
  handleViewFile: (filePath: string, fileName: string, fileSize: number) => void;
  handleEditFile: (filePath: string, fileName: string, fileSize: number, langId: string) => void;
  handleOpenCreateFileConfirm: (filePath: string, fileName: string, langId: string) => Promise<void>;
  requestCloseViewer: () => void;
  requestCloseEditor: () => void;
  viewerOpen: boolean;
};

export function useViewerEditorState(): UseViewerEditorStateResult {
  const bridge = useBridge();
  const viewerRegistry = useViewerRegistry();
  const editorRegistry = useEditorRegistry();
  const fsProviderRegistry = useFsProviderRegistry();
  const focusContext = useFocusContext();
  const { navigateTo } = useActivePanelNavigation();
  const [viewerFile, setViewerFile] = useState<{ path: string; name: string; size: number; panel: "left" | "right" } | null>(null);
  const [editorFile, setEditorFile] = useState<{ path: string; name: string; size: number; langId: string } | null>(null);
  const setLeftTabs = useSetAtom(leftTabsAtom);
  const setRightTabs = useSetAtom(rightTabsAtom);
  const leftActiveTabId = useAtomValue(leftActiveTabIdAtom);
  const rightActiveTabId = useAtomValue(rightActiveTabIdAtom);
  const leftActiveTab = useAtomValue(leftActiveTabAtom);
  const rightActiveTab = useAtomValue(rightActiveTabAtom);
  const [editorDirty, setEditorDirty] = useState(false);
  const editorCloseConfirmOpenRef = useRef(false);
  const { showHidden } = useShowHidden();
  const { dialog, showDialog, replaceDialog, closeDialog } = useDialog();

  const activePanelSide = useAtomValue(activePanelSideAtom);
  const activePanelSideRef = useRef(activePanelSide);
  activePanelSideRef.current = activePanelSide;

  const handleViewFile = useCallback(
    (filePath: string, fileName: string, fileSize: number) => {
      if (fsProviderRegistry.resolve(basename(filePath))) {
        void navigateTo(filePath + CONTAINER_SEP);
        return;
      }
      setEditorDirty(false);
      setEditorFile(null);
      setViewerFile({
        path: filePath,
        name: fileName,
        size: fileSize,
        panel: activePanelSideRef.current,
      });
    },
    [activePanelSideRef, fsProviderRegistry, navigateTo, setEditorFile, setViewerFile],
  );

  const handleEditFile = useCallback(
    (filePath: string, fileName: string, fileSize: number, langId: string) => {
      setViewerFile(null);
      setEditorDirty(false);
      setEditorFile({ path: filePath, name: fileName, size: fileSize, langId });
    },
    [setEditorFile, setViewerFile],
  );

  const handleOpenCreateFileConfirm = useCallback(
    async (filePath: string, fileName: string, langId: string) => {
      const exists = await bridge.fs.exists(filePath);
      if (!exists) {
        await bridge.fs.writeFile(filePath, "");
      }
      const size = exists ? (await bridge.fs.stat(filePath)).size : 0;
      setViewerFile(null);
      setEditorDirty(false);
      setEditorFile({ path: filePath, name: fileName, size, langId });
    },
    [bridge, setEditorFile, setViewerFile],
  );

  const requestCloseViewer = useCallback(() => {
    setViewerFile(null);
  }, []);

  const requestCloseEditor = useCallback(() => {
    if (editorCloseConfirmOpenRef.current) return;
    if (!editorDirty || !editorFile) {
      focusContext.restore();
      setEditorDirty(false);
      setEditorFile(null);
      return;
    }
    editorCloseConfirmOpenRef.current = true;
    showDialog({
      type: "message",
      title: "Unsaved Changes",
      message: `Close "${editorFile.name}" and discard unsaved changes?`,
      buttons: [
        {
          label: "Cancel",
          default: true,
          onClick: () => {
            editorCloseConfirmOpenRef.current = false;
            requestAnimationFrame(() => {
              focusContext.request("editor");
            });
          },
        },
        {
          label: "Discard",
          onClick: () => {
            editorCloseConfirmOpenRef.current = false;
            focusContext.restore();
            setEditorDirty(false);
            setEditorFile(null);
          },
        },
      ],
    });
  }, [editorDirty, editorFile, focusContext, setEditorFile, showDialog]);

  const viewerPanelEntries = useMemo(() => {
    if (!viewerFile) return [];
    if (viewerFile.panel === "left") {
      return leftActiveTab?.type === "filelist" ? leftActiveTab.entries : [];
    }
    return rightActiveTab?.type === "filelist" ? rightActiveTab.entries : [];
  }, [leftActiveTab, rightActiveTab, viewerFile]);

  const matchesPatterns = useCallback((name: string, patterns: string[]) => {
    return patterns.some((pattern) => {
      if (pattern.startsWith("*.")) {
        const ext = pattern.slice(1).toLowerCase();
        return name.toLowerCase().endsWith(ext);
      }
      return name.toLowerCase() === pattern.toLowerCase();
    });
  }, []);

  const getMatchingFiles = useCallback(
    (patterns: string[]) => {
      if (!viewerFile) return [];
      const entries = showHidden ? viewerPanelEntries : viewerPanelEntries.filter((entry) => !entry.meta.hidden);
      return entries
        .filter((entry) => entry.type === "file" && matchesPatterns(entry.name, patterns))
        .map((entry) => ({
          path: entry.path as string,
          name: entry.name,
          size: Number(entry.meta.size),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    [matchesPatterns, showHidden, viewerFile, viewerPanelEntries],
  );

  const handleExecuteCommand = useCallback(
    async (command: string, args?: unknown): Promise<unknown> => {
      const { patterns } = (args as { patterns?: string[] } | undefined) ?? {};
      if (!patterns || !viewerFile) return undefined;
      const files = getMatchingFiles(patterns);
      const index = files.findIndex((file) => file.path === viewerFile.path);

      if (command === "navigatePrev") {
        if (index > 0) {
          const file = files[index - 1]!;
          setViewerFile((prev) => (prev ? { ...file, panel: prev.panel } : null));
        }
        return undefined;
      }
      if (command === "navigateNext") {
        if (index >= 0 && index < files.length - 1) {
          const file = files[index + 1]!;
          setViewerFile((prev) => (prev ? { ...file, panel: prev.panel } : null));
        }
        return undefined;
      }
      if (command === "getFileIndex") {
        return { index, total: files.length };
      }
      return undefined;
    },
    [getMatchingFiles, setViewerFile, viewerFile],
  );

  const viewerResolved = viewerFile ? viewerRegistry.resolve(viewerFile.name) : null;
  const editorResolved = editorFile ? editorRegistry.resolve(editorFile.name) : null;
  useEffect(() => {
    if (!viewerFile) return;
    const viewerActiveName = isMediaFile(viewerFile.name) ? viewerFile.name : undefined;
    if (!viewerActiveName) return;
    const viewerPanel = viewerFile.panel;

    const updateTabs = viewerPanel === "left" ? setLeftTabs : setRightTabs;
    const activeTabId = viewerPanel === "left" ? leftActiveTabId : rightActiveTabId;

    updateTabs((prev) => {
      const index = prev.findIndex((tab) => tab.id === activeTabId);
      if (index < 0) return prev;
      const tab = prev[index];
      if (!tab || tab.type !== "filelist" || tab.activeEntryName === viewerActiveName) return prev;
      const next = [...prev];
      next[index] = {
        ...tab,
        activeEntryName: viewerActiveName,
      };
      return next;
    });
  }, [leftActiveTabId, rightActiveTabId, setLeftTabs, setRightTabs, viewerFile]);

  useEffect(() => {
    const topDialogType = dialog?.type;
    if (!viewerFile) {
      if (topDialogType === "viewer") {
        closeDialog();
      }
      return;
    }

    if (!viewerResolved) {
      if (topDialogType !== "message") {
        showDialog({
          type: "message",
          title: "No viewer",
          message: "No viewer extension found for this file type. Install viewer extensions (e.g. Image Viewer, File Viewer) from the extensions panel.",
          buttons: [{ label: "OK", default: true, onClick: () => setViewerFile(null) }],
        });
      }
      return;
    }

    if (topDialogType === "findFilesResults") {
      showDialog({
        type: "viewer",
        extensionDirPath: viewerResolved.extensionDirPath,
        entry: viewerResolved.contribution.entry,
        props: {
          filePath: viewerFile.path,
          fileName: viewerFile.name,
          fileSize: viewerFile.size,
        },
        onClose: requestCloseViewer,
        onExecuteCommand: handleExecuteCommand,
      });
      return;
    }

    if (topDialogType && topDialogType !== "viewer") {
      return;
    }

    const desiredViewer = {
      extensionDirPath: viewerResolved.extensionDirPath,
      entry: viewerResolved.contribution.entry,
      filePath: viewerFile.path,
      fileName: viewerFile.name,
      fileSize: viewerFile.size,
    };

    if (sameViewerDialog(dialog, desiredViewer)) {
      return;
    }

    replaceDialog({
      type: "viewer",
      extensionDirPath: desiredViewer.extensionDirPath,
      entry: desiredViewer.entry,
      props: {
        filePath: desiredViewer.filePath,
        fileName: desiredViewer.fileName,
        fileSize: desiredViewer.fileSize,
      },
      onClose: requestCloseViewer,
      onExecuteCommand: handleExecuteCommand,
    });
  }, [closeDialog, dialog, handleExecuteCommand, replaceDialog, requestCloseViewer, showDialog, viewerFile, viewerResolved]);

  useEffect(() => {
    const topDialogType = dialog?.type;
    if (!editorFile) {
      if (topDialogType === "editor") {
        closeDialog();
      }
      return;
    }

    if (!editorResolved) {
      if (topDialogType !== "message") {
        showDialog({
          type: "message",
          title: "No editor",
          message: "No editor extension found for this file type. Install an editor extension (e.g. Monaco Editor) from the extensions panel.",
          buttons: [{ label: "OK", default: true, onClick: requestCloseEditor }],
        });
      }
      return;
    }

    if (topDialogType === "findFilesResults") {
      showDialog({
        type: "editor",
        extensionDirPath: editorResolved.extensionDirPath,
        entry: editorResolved.contribution.entry,
        props: {
          filePath: editorFile.path,
          fileName: editorFile.name,
          langId: editorFile.langId,
        },
        onClose: requestCloseEditor,
        onDirtyChange: setEditorDirty,
      });
      return;
    }

    if (topDialogType && topDialogType !== "editor") {
      return;
    }

    const desiredEditor = {
      extensionDirPath: editorResolved.extensionDirPath,
      entry: editorResolved.contribution.entry,
      filePath: editorFile.path,
      fileName: editorFile.name,
      langId: editorFile.langId,
    };

    if (sameEditorDialog(dialog, desiredEditor)) {
      return;
    }

    replaceDialog({
      type: "editor",
      extensionDirPath: desiredEditor.extensionDirPath,
      entry: desiredEditor.entry,
      props: {
        filePath: desiredEditor.filePath,
        fileName: desiredEditor.fileName,
        langId: desiredEditor.langId,
      },
      onClose: requestCloseEditor,
      onDirtyChange: setEditorDirty,
    });
  }, [closeDialog, dialog, editorFile, editorResolved, replaceDialog, requestCloseEditor, showDialog]);

  return {
    handleViewFile,
    handleEditFile,
    handleOpenCreateFileConfirm,
    requestCloseViewer,
    requestCloseEditor,
    viewerOpen: viewerFile !== null,
  };
}
