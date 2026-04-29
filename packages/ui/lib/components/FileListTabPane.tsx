import { themesReadyAtom } from "@/atoms";
import type { PanelSide } from "@/entities/panel/model/types";
import type { FileListTabState } from "@/entities/tab/model/types";
import { useBridge } from "@dotdirfm/ui-bridge";
import { useCommandLine } from "@/features/command-line/useCommandLine";
import { FileIcon } from "@/features/file-icons/FileIcon";
import type { ResolvedIcon } from "@/features/file-icons/iconResolver";
import { useFileOperationHandlers } from "@/features/file-ops/fileOperationHandlers";
import { FileStyleResolverProvider, useFileStyleResolver } from "@/features/fss/fileStyleResolver";
import { useLanguageRegistry } from "@/features/languages/languageRegistry";
import { usePanelControllerRegistry } from "@/features/panels/panelControllers";
import type { FileListPanelController } from "@/features/panels/useFileListPanel";
import { useFileListPanel } from "@/features/panels/useFileListPanel";
import { useEditorRegistry, useViewerRegistry } from "@/viewerEditorRegistry";
import { FileList, type FileListState, type RenderFileIcon } from "@dotdirfm/file-list";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";

interface FileListTabPaneProps {
  side: PanelSide;
  tabId: string;
  path: string;
  visible: boolean;
  focused: boolean;
  showHidden: boolean;
  tabState: Pick<FileListTabState, "activeEntryName" | "topmostEntryName" | "selectedEntryNames">;
  onStateChange?: (selectedName: string | undefined, topmostName: string | undefined, selectedNames: string[]) => void;
  onActivatePanelFocus: () => void;
  onActivePanelChange: (panel: FileListPanelController) => void;
}

interface FileListUiAdapterProps {
  side: PanelSide;
  tabId: string;
  state: FileListState;
  showHidden: boolean;
  focused: boolean;
  pathsInSync: boolean;
  onNavigate: (path: string) => Promise<void>;
  onStateChange?: (selectedName: string | undefined, topmostName: string | undefined, selectedNames: string[]) => void;
}

function FileListUiAdapter({ side, tabId, state, showHidden, focused, pathsInSync, onNavigate, onStateChange }: FileListUiAdapterProps) {
  const bridge = useBridge();
  const { paste } = useCommandLine();
  const fileOperations = useFileOperationHandlers();
  const { resolve } = useFileStyleResolver();
  const languageResolver = useLanguageRegistry();
  const viewerRegistry = useViewerRegistry();
  const editorRegistry = useEditorRegistry();
  const { registerVisibleFileListFocus } = usePanelControllerRegistry();

  const registerFocus = useCallback(
    (focus: () => void) => registerVisibleFileListFocus(side, tabId, focus),
    [registerVisibleFileListFocus, side, tabId],
  );

  const getHomePath = useCallback(() => bridge.utils.getHomePath(), [bridge]);
  const hasViewer = useCallback((fileName: string) => viewerRegistry.resolve(fileName) != null, [viewerRegistry]);
  const hasEditor = useCallback((fileName: string) => editorRegistry.resolve(fileName) != null, [editorRegistry]);

  const renderIcon = useCallback<RenderFileIcon<ResolvedIcon>>(
    (icon) => <FileIcon icon={icon} size={16} />,
    [],
  );

  return (
    <FileList
      key={tabId}
      state={state}
      showHidden={showHidden}
      onNavigate={onNavigate}
      active={focused}
      resolveEntry={resolve}
      renderIcon={renderIcon}
      registerFocus={registerFocus}
      fileOperations={fileOperations}
      pasteToCommandLine={paste}
      languageResolver={languageResolver}
      getHomePath={getHomePath}
      hasViewer={hasViewer}
      hasEditor={hasEditor}
      onStateChange={pathsInSync ? onStateChange : undefined}
    />
  );
}

export function FileListTabPane({
  side,
  tabId,
  path,
  visible,
  focused,
  showHidden,
  tabState,
  onStateChange,
  onActivatePanelFocus,
  onActivePanelChange,
}: FileListTabPaneProps) {
  const panel = useFileListPanel();
  const themesReady = useAtomValue(themesReadyAtom);
  const { clearVisibleFileListTab, setVisibleFileListTab } = usePanelControllerRegistry();
  const lastRequestedPathRef = useRef<string | null>(null);
  const lastThemeResyncedPathRef = useRef<string | null>(null);
  const lastReportedRef = useRef<string | null>(null);
  const lastSyncedStateRef = useRef<FileListTabState | null>(null);
  const pathsInSync = panel.state.path === path;

  useEffect(() => {
    if (!path) return;
    if (lastRequestedPathRef.current === path) return;
    lastRequestedPathRef.current = path;
    void panel.navigateTo(path);
  }, [path, panel]);

  useEffect(() => {
    if (!themesReady || !path) return;
    if (lastThemeResyncedPathRef.current === path) return;
    lastThemeResyncedPathRef.current = path;
    void panel.navigateTo(path);
  }, [path, panel, themesReady]);

  useEffect(() => {
    if (!visible) return;
    setVisibleFileListTab(side, tabId);
    return () => {
      clearVisibleFileListTab(side, tabId);
    };
  }, [clearVisibleFileListTab, setVisibleFileListTab, side, tabId, visible]);

  useEffect(() => {
    if (!visible) return;
    const signature = [
      panel.state.path,
      panel.state.activeEntryName ?? "",
      panel.state.topmostEntryName ?? "",
      panel.state.selectedEntryNames?.join("\0") ?? "",
      String(panel.state.entries.length),
      panel.navigating ? "1" : "0",
    ].join("|");
    if (lastReportedRef.current === signature) return;
    lastReportedRef.current = signature;
    onActivePanelChange(panel);
  }, [
    visible,
    panel,
    panel.navigating,
    panel.state.path,
    panel.state.activeEntryName,
    panel.state.topmostEntryName,
    panel.state.selectedEntryNames,
    panel.state.entries.length,
    onActivePanelChange,
  ]);

  const fileListState = useMemo(
    () => ({
      ...panel.state,
      activeEntryName: pathsInSync ? tabState.activeEntryName : panel.state.activeEntryName,
      topmostEntryName: pathsInSync ? tabState.topmostEntryName : panel.state.topmostEntryName,
      selectedEntryNames: pathsInSync ? tabState.selectedEntryNames : panel.state.selectedEntryNames,
    }),
    [panel.state, pathsInSync, tabState.activeEntryName, tabState.topmostEntryName, tabState.selectedEntryNames],
  );
  if (pathsInSync) {
    lastSyncedStateRef.current = fileListState;
  }
  const renderedState = pathsInSync ? fileListState : (lastSyncedStateRef.current ?? fileListState);

  return (
    <div
      inert={!visible}
      style={{
        visibility: visible ? "visible" : "hidden",
        height: "100%",
        position: "absolute",
        inset: 0,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <FileStyleResolverProvider path={renderedState.path} pathKind="directory">
        <FileListUiAdapter
          side={side}
          tabId={tabId}
          state={renderedState}
          showHidden={showHidden}
          focused={focused}
          pathsInSync={pathsInSync}
          onNavigate={(nextPath: string) => {
            onActivatePanelFocus();
            return panel.navigateTo(nextPath);
          }}
          onStateChange={onStateChange}
        />
      </FileStyleResolverProvider>
    </div>
  );
}
