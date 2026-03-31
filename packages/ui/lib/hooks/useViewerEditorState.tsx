import { editorFileAtom, viewerFileAtom } from "@/atoms";
import { EditorContainer, ViewerContainer } from "@/components/ExtensionContainer";
import { ModalDialog } from "@/dialogs/ModalDialog";
import type { PanelSide } from "@/entities/panel/model/types";
import { leftActiveTabAtom, rightActiveTabAtom } from "@/entities/tab/model/tabsAtoms";
import type { Bridge } from "@/features/bridge";
import { CONTAINER_SEP } from "@/utils/containerPath";
import { isMediaFile } from "@/utils/mediaFiles";
import { basename } from "@/utils/path";
import { editorRegistry, fsProviderRegistry, viewerRegistry } from "@/viewerEditorRegistry";
import type { FsNode } from "fss-lang";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

type MessageDialogSpec = {
  type: "message";
  title: string;
  message: string;
  variant?: "default" | "error";
  buttons?: Array<{
    label: string;
    default?: boolean;
    onClick?: () => void;
  }>;
};

type UseViewerEditorStateArgs = {
  bridge: Bridge;
  showHidden: boolean;
  leftFileListState: { entries: FsNode[] };
  rightFileListState: { entries: FsNode[] };
  activePanelSideRef: React.RefObject<PanelSide>;
  navigateTo: (path: string) => Promise<void> | void;
  showDialog: (dialog: MessageDialogSpec) => void;
};

type UseViewerEditorStateResult = {
  handleViewFile: (filePath: string, fileName: string, fileSize: number) => void;
  handleEditFile: (filePath: string, fileName: string, fileSize: number, langId: string) => void;
  handleOpenCreateFileConfirm: (filePath: string, fileName: string, langId: string) => Promise<void>;
  requestCloseEditor: () => void;
  leftRequestedCursor: string | undefined;
  rightRequestedCursor: string | undefined;
  overlays: ReactNode;
};

export function useViewerEditorState({
  bridge,
  showHidden,
  leftFileListState,
  rightFileListState,
  activePanelSideRef,
  navigateTo,
  showDialog,
}: UseViewerEditorStateArgs): UseViewerEditorStateResult {
  const [viewerFile, setViewerFile] = useAtom(viewerFileAtom);
  const [editorFile, setEditorFile] = useAtom(editorFileAtom);
  const leftActiveTab = useAtomValue(leftActiveTabAtom);
  const rightActiveTab = useAtomValue(rightActiveTabAtom);
  const [viewerExt, setViewerExt] = useState<{ dirPath: string; entry: string } | null>(null);
  const [editorExt, setEditorExt] = useState<{ dirPath: string; entry: string } | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);

  const handleViewFile = useCallback(
    (filePath: string, fileName: string, fileSize: number) => {
      if (fsProviderRegistry.resolve(basename(filePath))) {
        void navigateTo(filePath + CONTAINER_SEP);
        return;
      }
      setViewerFile({
        path: filePath,
        name: fileName,
        size: fileSize,
        panel: activePanelSideRef.current,
      });
    },
    [activePanelSideRef, navigateTo, setViewerFile],
  );

  const handleEditFile = useCallback(
    (filePath: string, fileName: string, fileSize: number, langId: string) => {
      setEditorDirty(false);
      setEditorFile({ path: filePath, name: fileName, size: fileSize, langId });
    },
    [setEditorFile],
  );

  const handleOpenCreateFileConfirm = useCallback(
    async (filePath: string, fileName: string, langId: string) => {
      const exists = await bridge.fs.exists(filePath);
      if (!exists) {
        await bridge.fs.writeFile(filePath, "");
      }
      const size = exists ? (await bridge.fs.stat(filePath)).size : 0;
      setEditorDirty(false);
      setEditorFile({ path: filePath, name: fileName, size, langId });
    },
    [bridge, setEditorFile],
  );

  const requestCloseEditor = useCallback(() => {
    if (!editorDirty || !editorFile) {
      setEditorDirty(false);
      setEditorFile(null);
      return;
    }
    showDialog({
      type: "message",
      title: "Unsaved Changes",
      message: `Close "${editorFile.name}" and discard unsaved changes?`,
      buttons: [
        { label: "Cancel", default: true },
        {
          label: "Discard",
          onClick: () => {
            setEditorDirty(false);
            setEditorFile(null);
          },
        },
      ],
    });
  }, [editorDirty, editorFile, setEditorFile, showDialog]);

  const viewerPanelEntries: FsNode[] = viewerFile ? (viewerFile.panel === "left" ? leftFileListState.entries : rightFileListState.entries) : [];

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
    if (!viewerResolved) return;
    setViewerExt((prev) => {
      if (prev?.dirPath === viewerResolved.extensionDirPath && prev?.entry === viewerResolved.contribution.entry) return prev;
      return {
        dirPath: viewerResolved.extensionDirPath,
        entry: viewerResolved.contribution.entry,
      };
    });
  }, [viewerResolved?.contribution.entry, viewerResolved?.extensionDirPath]);

  useEffect(() => {
    if (!editorResolved) return;
    setEditorExt((prev) => {
      if (prev?.dirPath === editorResolved.extensionDirPath && prev?.entry === editorResolved.contribution.entry) return prev;
      return {
        dirPath: editorResolved.extensionDirPath,
        entry: editorResolved.contribution.entry,
      };
    });
  }, [editorResolved?.contribution.entry, editorResolved?.extensionDirPath]);

  const viewerActiveName = viewerFile && isMediaFile(viewerFile.name) ? viewerFile.name : undefined;
  const leftRequestedCursor = viewerFile?.panel === "left" ? viewerActiveName : leftActiveTab?.type === "filelist" ? leftActiveTab.activeEntryName : undefined;
  const rightRequestedCursor =
    viewerFile?.panel === "right" ? viewerActiveName : rightActiveTab?.type === "filelist" ? rightActiveTab.activeEntryName : undefined;

  const overlays = useMemo(
    () => (
      <>
        {viewerFile && !viewerResolved && (
          <ModalDialog
            title="No viewer"
            message="No viewer extension found for this file type. Install viewer extensions (e.g. Image Viewer, File Viewer) from the extensions panel."
            onClose={() => setViewerFile(null)}
          />
        )}
        {viewerExt && viewerFile && viewerResolved && (
          <ViewerContainer
            key={`viewer:${viewerExt.dirPath}:${viewerExt.entry}`}
            extensionDirPath={viewerExt.dirPath}
            entry={viewerExt.entry}
            filePath={viewerFile.path}
            fileName={viewerFile.name}
            fileSize={viewerFile.size}
            onClose={() => setViewerFile(null)}
            onExecuteCommand={handleExecuteCommand}
          />
        )}
        {editorFile && !editorResolved && (
          <ModalDialog
            title="No editor"
            message="No editor extension found for this file type. Install an editor extension (e.g. Monaco Editor) from the extensions panel."
            onClose={requestCloseEditor}
          />
        )}
        {editorExt && editorFile && editorResolved && (
          <EditorContainer
            key={`editor:${editorExt.dirPath}:${editorExt.entry}`}
            extensionDirPath={editorExt.dirPath}
            entry={editorExt.entry}
            filePath={editorFile.path}
            fileName={editorFile.name}
            langId={editorFile.langId}
            onClose={requestCloseEditor}
            onDirtyChange={setEditorDirty}
          />
        )}
      </>
    ),
    [
      editorExt,
      editorFile,
      editorResolved,
      handleExecuteCommand,
      requestCloseEditor,
      setViewerFile,
      viewerExt,
      viewerFile,
      viewerResolved,
    ],
  );

  return {
    handleViewFile,
    handleEditFile,
    handleOpenCreateFileConfirm,
    requestCloseEditor,
    leftRequestedCursor,
    rightRequestedCursor,
    overlays,
  };
}
