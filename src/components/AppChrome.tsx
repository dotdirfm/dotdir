import type { DotDirTheme } from "@dotdirfm/ui";
import { isTauri as isTauriApp } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import styles from "./AppChrome.module.css";

const TITLE = ".dir";

function isMacPlatform(): boolean {
  return navigator.platform.toUpperCase().includes("MAC");
}

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 6.5h8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
    </svg>
  );
}

function MaximizeIcon({ maximized }: { maximized: boolean }) {
  if (maximized) {
    return (
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M3 4.5h5v5H3z" fill="none" stroke="currentColor" strokeWidth="1.1" />
        <path d="M4 3h5v5" fill="none" stroke="currentColor" strokeWidth="1.1" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 3l6 6M9 3L3 9" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" />
    </svg>
  );
}

const FALLBACK_THEME: DotDirTheme = {
  kind: "dark",
  colors: {
    background: "#1e1e2e",
    backgroundSecondary: "#181825",
    foreground: "#cdd6f4",
    foregroundSecondary: "#a6adc8",
    border: "#313244",
    borderActive: "#585b70",
    accent: "#89b4fa",
    accentForeground: "#1e1e2e",
  },
};

export function AppChrome({
  children,
  theme = FALLBACK_THEME,
}: {
  children: ReactNode;
  theme?: DotDirTheme;
}) {
  const isTauri = useMemo(() => isTauriApp(), []);
  const isMac = useMemo(() => isMacPlatform(), []);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri || isMac) return;

    const currentWindow = getCurrentWindow();
    let mounted = true;
    let disposeResize: (() => void) | undefined;

    const syncMaximized = async () => {
      try {
        const next = await currentWindow.isMaximized();
        if (mounted) setMaximized(next);
      } catch {
        // Ignore transient state read failures.
      }
    };

    void syncMaximized();
    void currentWindow.onResized(() => {
      void syncMaximized();
    }).then((dispose) => {
      if (!mounted) {
        void dispose();
        return;
      }
      disposeResize = dispose;
    });

    return () => {
      mounted = false;
      void disposeResize?.();
    };
  }, [isMac, isTauri]);

  const shellStyle = {
    "--app-chrome-bg": theme.colors.background,
    "--app-chrome-bg-secondary": theme.colors.backgroundSecondary,
    "--app-chrome-fg": theme.colors.foreground,
    "--app-chrome-fg-secondary": theme.colors.foregroundSecondary,
    "--app-chrome-border": theme.colors.border,
    "--app-chrome-border-active": theme.colors.borderActive,
    "--app-chrome-accent": theme.colors.accent,
    "--app-chrome-accent-fg": theme.colors.accentForeground,
  } as CSSProperties;

  if (!isTauri) {
    return <div className={styles["content"]}>{children}</div>;
  }

  const handleMinimize = async () => {
    await getCurrentWindow().minimize();
  };

  const handleToggleMaximize = async () => {
    await getCurrentWindow().toggleMaximize();
  };

  const handleClose = async () => {
    await getCurrentWindow().close();
  };

  const handleDoubleClick = () => {
    if (isMac) return;
    void handleToggleMaximize();
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!isTauri || isMac) return;
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button")) return;
    void getCurrentWindow().startDragging();
  };

  return (
    <div className={styles["shell"]} style={shellStyle}>
      <div className={styles["titleBar"]}>
        <div
          className={styles["titleBarDrag"]}
          data-tauri-drag-region
          onDoubleClick={handleDoubleClick}
          onMouseDown={handleMouseDown}
        >
          <div className={styles["titleSide"]} data-tauri-drag-region>
            {isMac && <div className={styles["macGap"]} data-tauri-drag-region />}
          </div>
          <div className={styles["titleText"]} data-tauri-drag-region>
            {TITLE}
          </div>
          <div className={styles["titleSide"]} data-tauri-drag-region />
        </div>
        {!isMac && (
          <div className={styles["windowControls"]}>
            <button
              type="button"
              className={styles["windowButton"]}
              data-tauri-drag-region="false"
              aria-label="Minimize window"
              onClick={() => void handleMinimize()}
            >
              <MinimizeIcon />
            </button>
            <button
              type="button"
              className={styles["windowButton"]}
              data-tauri-drag-region="false"
              aria-label={maximized ? "Restore window" : "Maximize window"}
              onClick={() => void handleToggleMaximize()}
            >
              <MaximizeIcon maximized={maximized} />
            </button>
            <button
              type="button"
              className={`${styles["windowButton"]} ${styles["windowButtonClose"]}`}
              data-tauri-drag-region="false"
              aria-label="Close window"
              onClick={() => void handleClose()}
            >
              <CloseIcon />
            </button>
          </div>
        )}
      </div>
      <div className={styles["content"]}>{children}</div>
    </div>
  );
}
