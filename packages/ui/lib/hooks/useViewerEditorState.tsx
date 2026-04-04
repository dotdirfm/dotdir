import { editorFileAtom, viewerFileAtom } from "@/atoms";
import { useDialog } from "@/dialogs/dialogContext";
import { ModalDialog } from "@/dialogs/ModalDialog";
import { activePanelSideAtom, leftActiveTabAtom, leftActiveTabIdAtom, leftTabsAtom, rightActiveTabAtom, rightActiveTabIdAtom, rightTabsAtom } from "@/entities/tab/model/tabsAtoms";
import { useBridge } from "@/features/bridge/useBridge";
import { EditorContainer, ViewerContainer } from "@/features/extensions/ExtensionContainer";
import { showHiddenAtom } from "@/features/settings/useUserSettings";
import { useActivePanelNavigation } from "@/panelControllers";
import { CONTAINER_SEP } from "@/utils/containerPath";
import { isMediaFile } from "@/utils/mediaFiles";
import { basename } from "@/utils/path";
import { editorRegistry, fsProviderRegistry, viewerRegistry } from "@/viewerEditorRegistry";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type UseViewerEditorStateResult = {
  handleViewFile: (filePath: string, fileName: string, fileSize: number) => void;
  handleEditFile: (filePath: string, fileName: string, fileSize: number, langId: string) => void;
  handleOpenCreateFileConfirm: (filePath: string, fileName: string, langId: string) => Promise<void>;
  requestCloseEditor: () => void;
  overlays: ReactNode;
};

type CachedViewerOverlay = {
  cacheKey: string;
  dirPath: string;
  entry: string;
  lastUsedAt: number;
  file: {
    path: string;
    name: string;
    size: number;
    panel: "left" | "right";
  };
};

type CachedEditorOverlay = {
  cacheKey: string;
  dirPath: string;
  entry: string;
  lastUsedAt: number;
  file: {
    path: string;
    name: string;
    size: number;
    langId: string;
  };
};

const MAX_CACHED_VIEWER_OVERLAYS = 3;
const MAX_CACHED_EDITOR_OVERLAYS = 2;

function upsertBoundedCacheEntry<T extends { cacheKey: string; lastUsedAt: number }>(
  entries: T[],
  nextEntry: T,
  limit: number,
): T[] {
  const existingIndex = entries.findIndex((entry) => entry.cacheKey === nextEntry.cacheKey);
  const updatedEntries =
    existingIndex < 0
      ? [...entries, nextEntry]
      : entries.map((entry, index) => (index === existingIndex ? nextEntry : entry));

  if (updatedEntries.length <= limit) {
    return updatedEntries;
  }

  const sortedEvictionCandidates = [...updatedEntries]
    .filter((entry) => entry.cacheKey !== nextEntry.cacheKey)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

  let trimmed = updatedEntries;
  while (trimmed.length > limit && sortedEvictionCandidates.length > 0) {
    const evict = sortedEvictionCandidates.shift();
    if (!evict) break;
    trimmed = trimmed.filter((entry) => entry.cacheKey !== evict.cacheKey);
  }

  return trimmed;
}

export function useViewerEditorState(): UseViewerEditorStateResult {
  const bridge = useBridge();
  const { navigateTo } = useActivePanelNavigation();
  const [viewerFile, setViewerFile] = useAtom(viewerFileAtom);
  const [editorFile, setEditorFile] = useAtom(editorFileAtom);
  const setLeftTabs = useSetAtom(leftTabsAtom);
  const setRightTabs = useSetAtom(rightTabsAtom);
  const leftActiveTabId = useAtomValue(leftActiveTabIdAtom);
  const rightActiveTabId = useAtomValue(rightActiveTabIdAtom);
  const leftActiveTab = useAtomValue(leftActiveTabAtom);
  const rightActiveTab = useAtomValue(rightActiveTabAtom);
  const [viewerCache, setViewerCache] = useState<CachedViewerOverlay[]>([]);
  const [editorCache, setEditorCache] = useState<CachedEditorOverlay[]>([]);
  const [editorDirty, setEditorDirty] = useState(false);
  const showHidden = useAtomValue(showHiddenAtom);
  const { showDialog } = useDialog();

  const [activePanelSide] = useAtom(activePanelSideAtom);
  const activePanelSideRef = useRef(activePanelSide);
  activePanelSideRef.current = activePanelSide;

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
  const activeViewerCacheKey =
    viewerResolved ? `viewer:${viewerResolved.extensionDirPath}:${viewerResolved.contribution.entry}` : null;
  const activeEditorCacheKey =
    editorResolved ? `editor:${editorResolved.extensionDirPath}:${editorResolved.contribution.entry}` : null;

  useEffect(() => {
    if (!viewerResolved || !viewerFile) return;

    const cacheKey = `viewer:${viewerResolved.extensionDirPath}:${viewerResolved.contribution.entry}`;
    setViewerCache((prev) => {
      const now = Date.now();
      const nextEntry: CachedViewerOverlay = {
        cacheKey,
        dirPath: viewerResolved.extensionDirPath,
        entry: viewerResolved.contribution.entry,
        lastUsedAt: now,
        file: viewerFile,
      };
      const index = prev.findIndex((entry) => entry.cacheKey === cacheKey);
      if (index < 0) {
        return upsertBoundedCacheEntry(prev, nextEntry, MAX_CACHED_VIEWER_OVERLAYS);
      }
      const current = prev[index]!;
      if (
        current.dirPath === nextEntry.dirPath &&
        current.entry === nextEntry.entry &&
        current.file.path === nextEntry.file.path &&
        current.file.name === nextEntry.file.name &&
        current.file.size === nextEntry.file.size &&
        current.file.panel === nextEntry.file.panel
      ) {
        return prev;
      }
      return upsertBoundedCacheEntry(prev, nextEntry, MAX_CACHED_VIEWER_OVERLAYS);
    });
  }, [viewerFile, viewerResolved]);

  useEffect(() => {
    if (!editorResolved || !editorFile) return;

    const cacheKey = `editor:${editorResolved.extensionDirPath}:${editorResolved.contribution.entry}`;
    setEditorCache((prev) => {
      const now = Date.now();
      const nextEntry: CachedEditorOverlay = {
        cacheKey,
        dirPath: editorResolved.extensionDirPath,
        entry: editorResolved.contribution.entry,
        lastUsedAt: now,
        file: editorFile,
      };
      const index = prev.findIndex((entry) => entry.cacheKey === cacheKey);
      if (index < 0) {
        return upsertBoundedCacheEntry(prev, nextEntry, MAX_CACHED_EDITOR_OVERLAYS);
      }
      const current = prev[index]!;
      if (
        current.dirPath === nextEntry.dirPath &&
        current.entry === nextEntry.entry &&
        current.file.path === nextEntry.file.path &&
        current.file.name === nextEntry.file.name &&
        current.file.size === nextEntry.file.size &&
        current.file.langId === nextEntry.file.langId
      ) {
        return prev;
      }
      return upsertBoundedCacheEntry(prev, nextEntry, MAX_CACHED_EDITOR_OVERLAYS);
    });
  }, [editorFile, editorResolved]);

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
        {viewerCache.map((cachedViewer) => {
          const isActive = cachedViewer.cacheKey === activeViewerCacheKey && !!viewerFile && !!viewerResolved;
          const file = isActive ? viewerFile : cachedViewer.file;
          return (
            <ViewerContainer
              key={cachedViewer.cacheKey}
              extensionDirPath={cachedViewer.dirPath}
              entry={cachedViewer.entry}
              filePath={file.path}
              fileName={file.name}
              fileSize={file.size}
              visible={isActive}
              onClose={() => setViewerFile(null)}
              onExecuteCommand={handleExecuteCommand}
            />
          );
        })}
        {editorFile && !editorResolved && (
          <ModalDialog
            title="No editor"
            message="No editor extension found for this file type. Install an editor extension (e.g. Monaco Editor) from the extensions panel."
            onClose={requestCloseEditor}
          />
        )}
        {editorCache.map((cachedEditor) => {
          const isActive = cachedEditor.cacheKey === activeEditorCacheKey && !!editorFile && !!editorResolved;
          const file = isActive ? editorFile : cachedEditor.file;
          return (
            <EditorContainer
              key={cachedEditor.cacheKey}
              extensionDirPath={cachedEditor.dirPath}
              entry={cachedEditor.entry}
              filePath={file.path}
              fileName={file.name}
              langId={file.langId}
              visible={isActive}
              onClose={requestCloseEditor}
              onDirtyChange={setEditorDirty}
            />
          );
        })}
      </>
    ),
    [
      activeEditorCacheKey,
      activeViewerCacheKey,
      editorCache,
      editorFile,
      editorResolved,
      handleExecuteCommand,
      requestCloseEditor,
      setViewerFile,
      viewerCache,
      viewerFile,
      viewerResolved,
    ],
  );

  return {
    handleViewFile,
    handleEditFile,
    handleOpenCreateFileConfirm,
    requestCloseEditor,
    overlays,
  };
}
