import { PanelSide } from "@/entities/panel/model/types";
import { PanelController, usePanel } from "@/hooks/usePanel";
import { useEffect, useRef } from "react";
import { FileList } from "./FileList/FileList";

interface FileListTabPaneProps {
  side: PanelSide;
  tabId: string;
  path: string;
  visible: boolean;
  focused: boolean;
  showHidden: boolean;
  showError: (message: string) => void;
  onRememberExpectedTerminalCwd: (path: string) => void;
  selectionKey?: number;
  requestedActiveName?: string;
  requestedTopmostName?: string;
  onStateChange?: (selectedName: string | undefined, topmostName: string | undefined) => void;
  onActivatePanelFocus: () => void;
  onActivePanelChange: (panel: PanelController) => void;
}

export function FileListTabPane({
  side,
  tabId,
  path,
  visible,
  focused,
  showHidden,
  showError,
  onRememberExpectedTerminalCwd,
  selectionKey,
  requestedActiveName,
  requestedTopmostName,
  onStateChange,
  onActivatePanelFocus,
  onActivePanelChange,
}: FileListTabPaneProps) {
  const panel = usePanel(showError);
  const lastRequestedPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!path) return;
    if (lastRequestedPathRef.current === path) return;
    lastRequestedPathRef.current = path;
    void panel.navigateTo(path);
  }, [path, panel.navigateTo]);

  useEffect(() => {
    if (!visible) return;
    onActivePanelChange(panel);
  }, [visible, panel, panel.currentPath, panel.parentNode, panel.entries, panel.navigating, panel.requestedCursor, onActivePanelChange]);

  const entries = showHidden ? panel.entries : panel.entries.filter((e) => !e.meta.hidden);

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
        currentPath={panel.currentPath}
        parentNode={panel.parentNode}
        entries={entries}
        onNavigate={(nextPath) => {
          onActivatePanelFocus();
          onRememberExpectedTerminalCwd(nextPath);
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
