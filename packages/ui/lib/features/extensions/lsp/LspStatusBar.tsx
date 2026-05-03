import { useExtensionHostClient } from "@/features/extensions/extensionHostClient";
import { useLspManager } from "./lspContext";
import { useEffect, useRef, useState } from "react";

interface LspStatusBarProps {
  languageId: string;
  filePath: string;
}

interface ServerEntry {
  languageId: string;
  state: string;
  workspaceRoot: string;
}

function stateLabel(state: string): string {
  switch (state) {
    case "running":
      return "Running";
    case "initializing":
      return "Initializing";
    case "shutting-down":
      return "Shutting down";
    case "crashed":
      return "Crashed";
    case "exited":
      return "Offline";
    default:
      return state;
  }
}

function stateColor(state: string): string {
  switch (state) {
    case "running":
      return "var(--accent, #4caf50)";
    case "initializing":
      return "#ff9800";
    case "crashed":
      return "#f44336";
    default:
      return "#888";
  }
}

export function LspStatusBar({ languageId, filePath }: LspStatusBarProps) {
  const lspManager = useLspManager();
  const extHost = useExtensionHostClient();
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [extActiveLanguages, setExtActiveLanguages] = useState<string[]>([]);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!lspManager) return;
    const poll = () => {
      setServers(lspManager.getServerStates().filter((s) => {
        if (s.languageId !== languageId) return false;
        if (!filePath) return true;
        return filePath.startsWith(s.workspaceRoot + "/") || filePath === s.workspaceRoot;
      }));
      setExtActiveLanguages(extHost.getActiveLanguages());
    };
    poll();
    const interval = setInterval(poll, 1200);
    return () => clearInterval(interval);
  }, [lspManager, extHost, languageId, filePath]);

  const lspRunning = servers.filter((s) => s.state === "running");
  const hasExtProvider = extActiveLanguages.includes(languageId);

  return (
    <div
      ref={barRef}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
        padding: "2px 10px",
        fontSize: 11,
        borderTop: "1px solid var(--border, #333)",
        flexShrink: 0,
        minHeight: 22,
        boxSizing: "border-box",
        color: "var(--text-muted, #999)",
        userSelect: "none",
      }}
    >
      <span>{languageId}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {lspRunning.length > 0 ? (
          servers.filter((s) => s.state === "running" || s.state === "initializing").map((s) => (
            <span
              key={s.languageId}
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              title={`${s.languageId} LSP: ${stateLabel(s.state)}`}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  backgroundColor: stateColor(s.state),
                  flexShrink: 0,
                }}
              />
              LSP
            </span>
          ))
        ) : hasExtProvider ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                backgroundColor: "var(--accent, #4caf50)",
                flexShrink: 0,
              }}
              title="Extension-host provider active"
            />
            Ext
          </span>
        ) : (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                backgroundColor: "#888",
                flexShrink: 0,
              }}
            />
            —
          </span>
        )}
      </span>
    </div>
  );
}
