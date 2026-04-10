import { themesReadyAtom } from "@/atoms";
import type { PanelSide } from "@/entities/panel/model/types";
import type { FileListTabState } from "@/entities/tab/model/types";
import { FileStyleResolverProvider } from "@/features/fss/fileStyleResolver";
import { usePanelControllerRegistry } from "@/features/panels/panelControllers";
import type { FileListPanelController } from "@/features/panels/useFileListPanel";
import { useFileListPanel } from "@/features/panels/useFileListPanel";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { FileList } from "./FileList/FileList";

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
        <FileList
          key={tabId}
          side={side}
          tabId={tabId}
          state={renderedState}
          showHidden={showHidden}
          onNavigate={(nextPath) => {
            onActivatePanelFocus();
            return panel.navigateTo(nextPath);
          }}
          active={focused}
          onStateChange={pathsInSync ? onStateChange : undefined}
        />
      </FileStyleResolverProvider>
    </div>
  );
}
