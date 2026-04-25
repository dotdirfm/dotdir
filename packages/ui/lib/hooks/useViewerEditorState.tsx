import { useDialog } from "@/dialogs/dialogContext";
import type { EditorDocumentTab, EditorSelection } from "@/entities/tab/model/types";
import {
  activePanelSideAtom,
  genTabId,
  leftActiveTabAtom,
  leftActiveTabIdAtom,
  leftTabsAtom,
  modalEditorActiveTabIdAtom,
  modalEditorTabsAtom,
  rightActiveTabAtom,
  rightActiveTabIdAtom,
  rightTabsAtom,
} from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import type { EditorOpenDocumentTarget } from "@/features/extensions/ExtensionContainer";
import { useLanguageRegistry } from "@/features/languages/languageRegistry";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { useShowHidden } from "@/features/settings/useUserSettings";
import { useFocusContext } from "@/focusContext";
import { CONTAINER_SEP } from "@/utils/containerPath";
import { isMediaFile } from "@/utils/mediaFiles";
import { basename } from "@/utils/path";
import { useFsProviderRegistry, useViewerRegistry } from "@/viewerEditorRegistry";
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
  const fsProviderRegistry = useFsProviderRegistry();
  const languageRegistry = useLanguageRegistry();
  const focusContext = useFocusContext();
  const { navigateTo } = useActivePanelNavigation();
  const [viewerFile, setViewerFile] = useState<{ path: string; name: string; size: number; panel: "left" | "right" } | null>(null);
  const editorTabs = useAtomValue(modalEditorTabsAtom);
  const activeEditorTabId = useAtomValue(modalEditorActiveTabIdAtom);
  const setEditorTabs = useSetAtom(modalEditorTabsAtom);
  const setActiveEditorTabId = useSetAtom(modalEditorActiveTabIdAtom);
  const setLeftTabs = useSetAtom(leftTabsAtom);
  const setRightTabs = useSetAtom(rightTabsAtom);
  const leftActiveTabId = useAtomValue(leftActiveTabIdAtom);
  const rightActiveTabId = useAtomValue(rightActiveTabIdAtom);
  const leftActiveTab = useAtomValue(leftActiveTabAtom);
  const rightActiveTab = useAtomValue(rightActiveTabAtom);
  const editorCloseConfirmOpenRef = useRef(false);
  const editorNavigationVersionRef = useRef(0);
  const { showHidden } = useShowHidden();
  const { dialog, showDialog, replaceDialog, closeDialog } = useDialog();

  const activePanelSide = useAtomValue(activePanelSideAtom);
  const activePanelSideRef = useRef(activePanelSide);
  activePanelSideRef.current = activePanelSide;

  const openEditorTab = useCallback(
    (filePath: string, fileName: string, fileSize: number, langId: string, selection?: EditorSelection) => {
      const navigationVersion = selection ? ++editorNavigationVersionRef.current : undefined;
      setViewerFile(null);
      setEditorTabs((prev) => {
        const existing = prev.find((tab) => tab.filePath === filePath);
        if (existing) {
          setActiveEditorTabId(existing.id);
          return prev.map((tab) =>
            tab.id === existing.id
              ? {
                  ...tab,
                  fileName,
                  fileSize,
                  langId: langId || tab.langId,
                  selection,
                  navigationVersion: navigationVersion ?? tab.navigationVersion,
                }
              : tab,
          );
        }
        const tab: EditorDocumentTab = {
          id: genTabId(),
          type: "editor-document",
          filePath,
          fileName,
          fileSize,
          langId: langId || "plaintext",
          dirty: false,
          selection,
          navigationVersion,
        };
        setActiveEditorTabId(tab.id);
        return [...prev, tab];
      });
    },
    [setActiveEditorTabId, setEditorTabs],
  );

  const handleViewFile = useCallback(
    (filePath: string, fileName: string, fileSize: number) => {
      if (fsProviderRegistry.resolve(basename(filePath))) {
        void navigateTo(filePath + CONTAINER_SEP);
        return;
      }
      setEditorTabs([]);
      setActiveEditorTabId(null);
      setViewerFile({
        path: filePath,
        name: fileName,
        size: fileSize,
        panel: activePanelSideRef.current,
      });
    },
    [activePanelSideRef, fsProviderRegistry, navigateTo, setActiveEditorTabId, setEditorTabs, setViewerFile],
  );

  const handleEditFile = useCallback(
    (filePath: string, fileName: string, fileSize: number, langId: string) => {
      openEditorTab(filePath, fileName, fileSize, langId);
    },
    [openEditorTab],
  );

  const handleOpenCreateFileConfirm = useCallback(
    async (filePath: string, fileName: string, langId: string) => {
      const exists = await bridge.fs.exists(filePath);
      if (!exists) {
        await bridge.fs.writeFile(filePath, "");
      }
      const size = exists ? (await bridge.fs.stat(filePath)).size : 0;
      openEditorTab(filePath, fileName, size, langId);
    },
    [bridge, openEditorTab],
  );

  const requestCloseViewer = useCallback(() => {
    setViewerFile(null);
  }, []);

  const activeEditorTab = useMemo(
    () => editorTabs.find((tab) => tab.id === activeEditorTabId) ?? editorTabs[0] ?? null,
    [activeEditorTabId, editorTabs],
  );

  const closeEditorTabNow = useCallback(
    (id: string) => {
      setEditorTabs((prev) => {
        const index = prev.findIndex((tab) => tab.id === id);
        if (index < 0) return prev;
        const next = prev.filter((tab) => tab.id !== id);
        setActiveEditorTabId((current) => {
          if (current !== id) return current;
          return next[Math.min(index, next.length - 1)]?.id ?? null;
        });
        if (next.length === 0) {
          focusContext.restore();
        }
        return next;
      });
    },
    [focusContext, setActiveEditorTabId, setEditorTabs],
  );

  const requestCloseEditorTab = useCallback(
    (id: string) => {
      if (editorCloseConfirmOpenRef.current) return;
      const tab = editorTabs.find((item) => item.id === id);
      if (!tab) return;
      if (!tab.dirty) {
        closeEditorTabNow(id);
        return;
      }
      editorCloseConfirmOpenRef.current = true;
      showDialog({
        type: "message",
        title: "Unsaved Changes",
        message: `Close "${tab.fileName}" and discard unsaved changes?`,
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
              closeEditorTabNow(id);
            },
          },
        ],
      });
    },
    [closeEditorTabNow, editorTabs, focusContext, showDialog],
  );

  const requestCloseEditor = useCallback(() => {
    if (editorCloseConfirmOpenRef.current) return;
    if (!activeEditorTab) {
      focusContext.restore();
      return;
    }
    requestCloseEditorTab(activeEditorTab.id);
  }, [activeEditorTab, focusContext, requestCloseEditorTab]);

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

  const handleSelectEditorTab = useCallback(
    (id: string) => {
      setActiveEditorTabId(id);
    },
    [setActiveEditorTabId],
  );

  const handleReorderEditorTabs = useCallback(
    (fromIndex: number, toIndex: number) => {
      setEditorTabs((prev) => {
        if (fromIndex < 0 || fromIndex >= prev.length || toIndex < 0 || toIndex >= prev.length || fromIndex === toIndex) return prev;
        const next = [...prev];
        const [item] = next.splice(fromIndex, 1);
        if (!item) return prev;
        next.splice(toIndex, 0, item);
        return next;
      });
    },
    [setEditorTabs],
  );

  const handleEditorDirtyChange = useCallback(
    (id: string, dirty: boolean) => {
      setEditorTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, dirty } : tab)));
    },
    [setEditorTabs],
  );

  const handleOpenEditorDocument = useCallback(
    async (target: EditorOpenDocumentTarget) => {
      const stat = await bridge.fs.stat(target.filePath);
      const fileName = basename(target.filePath);
      openEditorTab(target.filePath, fileName, stat.size, languageRegistry.getLanguageForFilename(fileName), target.selection);
    },
    [bridge.fs, languageRegistry, openEditorTab],
  );

  const viewerResolved = viewerFile ? viewerRegistry.resolve(viewerFile.name) : null;
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
        contributionId: viewerResolved.contribution.id,
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
      contributionId: viewerResolved.contribution.id,
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
      contributionId: desiredViewer.contributionId,
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
    if (editorTabs.length === 0) {
      if (topDialogType === "editor") {
        closeDialog();
      }
      return;
    }

    const activeTabId = activeEditorTabId && editorTabs.some((tab) => tab.id === activeEditorTabId) ? activeEditorTabId : editorTabs[0]!.id;

    if (topDialogType === "findFilesResults") {
      showDialog({
        type: "editor",
        tabs: editorTabs,
        activeTabId,
        onClose: requestCloseEditor,
        onSelectTab: handleSelectEditorTab,
        onCloseTab: requestCloseEditorTab,
        onReorderTabs: handleReorderEditorTabs,
        onDirtyChange: handleEditorDirtyChange,
        onOpenDocument: handleOpenEditorDocument,
      });
      return;
    }

    if (topDialogType && topDialogType !== "editor") {
      return;
    }

    if (dialog?.type === "editor" && dialog.tabs === editorTabs && dialog.activeTabId === activeTabId) {
      return;
    }

    replaceDialog({
      type: "editor",
      tabs: editorTabs,
      activeTabId,
      onClose: requestCloseEditor,
      onSelectTab: handleSelectEditorTab,
      onCloseTab: requestCloseEditorTab,
      onReorderTabs: handleReorderEditorTabs,
      onDirtyChange: handleEditorDirtyChange,
      onOpenDocument: handleOpenEditorDocument,
    });
  }, [
    activeEditorTabId,
    closeDialog,
    dialog,
    editorTabs,
    handleEditorDirtyChange,
    handleOpenEditorDocument,
    handleReorderEditorTabs,
    handleSelectEditorTab,
    replaceDialog,
    requestCloseEditor,
    requestCloseEditorTab,
    showDialog,
  ]);

  return {
    handleViewFile,
    handleEditFile,
    handleOpenCreateFileConfirm,
    requestCloseViewer,
    requestCloseEditor,
    viewerOpen: viewerFile !== null,
  };
}
