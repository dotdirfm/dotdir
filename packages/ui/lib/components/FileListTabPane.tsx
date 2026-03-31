import { PanelSide } from "@/entities/panel/model/types";
import { FileListPanelController, useFileListPanel } from "@/hooks/useFileListPanel";
import { useEffect, useRef } from "react";
import { FileList } from "./FileList/FileList";

interface FileListTabPaneProps {
  side: PanelSide;
  tabId: string;
  path: string;
  visible: boolean;
  focused: boolean;
  showHidden: boolean;
  requestedActiveName?: string;
  requestedTopmostName?: string;
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
  requestedActiveName,
  requestedTopmostName,
  onStateChange,
  onActivatePanelFocus,
  onActivePanelChange,
}: FileListTabPaneProps) {
  const panel = useFileListPanel();
  const lastRequestedPathRef = useRef<string | null>(null);
  const lastReportedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!path) return;
    if (lastRequestedPathRef.current === path) return;
    lastRequestedPathRef.current = path;
    void panel.navigateTo(path);
  }, [path, panel.navigateTo]);

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
      <FileList
        key={tabId}
        side={side}
        state={panel.state}
        showHidden={showHidden}
        onNavigate={(nextPath) => {
          onActivatePanelFocus();
          return panel.navigateTo(nextPath);
        }}
        active={focused}
        resolver={panel.resolver}
        requestedActiveName={focused ? requestedActiveName : undefined}
        requestedTopmostName={focused ? requestedTopmostName : undefined}
        onStateChange={focused ? onStateChange : undefined}
      />
    </div>
  );
}
