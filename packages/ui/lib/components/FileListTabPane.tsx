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
  selectionKey?: number;
  requestedActiveName?: string;
  requestedTopmostName?: string;
  onStateChange?: (selectedName: string | undefined, topmostName: string | undefined) => void;
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
  selectionKey,
  requestedActiveName,
  requestedTopmostName,
  onStateChange,
  onActivatePanelFocus,
  onActivePanelChange,
}: FileListTabPaneProps) {
  const panel = useFileListPanel();
  const lastRequestedPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!path) return;
    if (lastRequestedPathRef.current === path) return;
    lastRequestedPathRef.current = path;
    void panel.navigateTo(path);
  }, [path, panel.navigateTo]);

  useEffect(() => {
    onActivePanelChange(panel);
  }, [panel, onActivePanelChange]);

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
        selectionKey={selectionKey}
        active={focused}
        resolver={panel.resolver}
        requestedActiveName={focused ? requestedActiveName : undefined}
        requestedTopmostName={focused ? requestedTopmostName : undefined}
        onStateChange={focused ? onStateChange : undefined}
      />
    </div>
  );
}
