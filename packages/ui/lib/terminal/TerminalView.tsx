import { useCommandRegistry } from "@/features/commands/commands";
import { useFocusContext } from "@/focusContext";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type IDisposable } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import styles from "../styles/terminal.module.css";
import { normalizeTerminalPath } from "./path";
import type { TerminalSession } from "./TerminalSession";

interface TerminalViewProps {
  session: TerminalSession;
  expanded?: boolean;
  focusRequestKey?: number;
}

function resolveTerminalTheme() {
  return {
    background: "#11131a",
    foreground: "#d7dae0",
    cursor: "#f5f7ff",
    selectionBackground: "rgba(128, 146, 255, 0.28)",
  };
}

export function TerminalView({ session, expanded = false, focusRequestKey = 0 }: TerminalViewProps) {
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const fitFrameRef = useRef<number | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const hasTerminalFocusRef = useRef(false);
  const suppressPtyInputRef = useRef(false);
  const suppressNextCtrlORef = useRef(false);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  /** Last viewport size we fitted to; avoids ResizeObserver loop from fit.fit() changing layout. */
  const lastFitSizeRef = useRef({ w: 0, h: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return focusContext.registerAdapter("terminal", {
      focus() {
        const term = termRef.current;
        if (!term) return;
        hasTerminalFocusRef.current = true;
        term.focus();
      },
      blur() {
        const term = termRef.current;
        if (!term) return;
        hasTerminalFocusRef.current = false;
        term.blur();
      },
      contains(node) {
        return node instanceof Node ? container.contains(node) : false;
      },
      allowCommandRouting(event) {
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
          if (key === "p") return true;
          if (key === ".") return true;
          if (key === "q") return true;
        }
        if (!event.ctrlKey && !event.metaKey && !event.altKey) {
          if (key === "f10" || key === "f11") return true;
        }
        return false;
      },
    });
  }, [focusContext]);

  useEffect(() => {
    // A profile switch replaces the TerminalSession without remounting this component.
    // Force a fresh measurement so FitAddon doesn't early-return on stale cached dimensions.
    lastFitSizeRef.current = { w: 0, h: 0 };

    const container = containerRef.current;
    if (!container) return;

    const fit = new FitAddon();
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: false,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollOnUserInput: true,
      scrollback: 1000,
      cursorStyle: "bar",
      cursorInactiveStyle: "none",
      theme: resolveTerminalTheme(),
    });

    const scheduleLayout = () => {
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = requestAnimationFrame(() => {
        fitFrameRef.current = null;
        const body = container.parentElement;
        if (!body || body.clientWidth < 20 || body.clientHeight < 20) return;
        const w = body.clientWidth;
        const h = body.clientHeight;
        const last = lastFitSizeRef.current;
        if (last.w === w && last.h === h) return;
        lastFitSizeRef.current = { w, h };
        fit.fit();
        void session.resize(Math.max(2, term.cols), Math.max(1, term.rows));
      });
    };

    const writeReplay = (replay: string) => {
      if (!replay) return;
      session.setOscHooksSuppressed(true);
      suppressPtyInputRef.current = true;
      term.write(replay, () => {
        suppressPtyInputRef.current = false;
        session.setOscHooksSuppressed(false);
      });
    };

    const renderReplay = () => {
      const replay = session.getReplayData();
      term.reset();
      writeReplay(replay);
    };

    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;

    const oscDisposables: IDisposable[] = [
      term.parser.registerOscHandler(7, (data) => {
        const pathMatch = data.match(/^file:\/\/[^/]*(\/.*)/);
        if (!pathMatch) return false;
        const cwd = normalizeTerminalPath(decodeURIComponent(pathMatch[1]));
        session.notifyOsc7FromXterm(cwd);
        return true;
      }),
      // .dir private OSC: prompt ready / command finished (shell integration scripts).
      term.parser.registerOscHandler(779, (data) => {
        session.notifyDotDirPromptOsc(data);
        return true;
      }),
    ];
    fitRef.current = fit;
    const setTerminalFocus = () => {
      if (hasTerminalFocusRef.current || !expandedRef.current) return;
      focusContext.request("terminal");
    };
    const clearTerminalFocus = () => {
      if (!hasTerminalFocusRef.current) return;
      focusContext.blurCurrent();
      focusContext.pop("terminal");
    };
    term.attachCustomKeyEventHandler((event) => {
      setTerminalFocus();
      if (event.key.toLowerCase() === "o" && event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        if (suppressNextCtrlORef.current) {
          suppressNextCtrlORef.current = false;
          return false;
        }
        void commandRegistry.executeCommand("togglePanels");
        return false;
      }
      return true;
    });
    scheduleLayout();
    renderReplay();

    const cleanupSession = session.subscribe((event) => {
      if (event.type === "data") {
        term.write(event.data);
        term.scrollToBottom();
        scheduleLayout();
      } else if (event.type === "status" && event.status === "error" && event.error) {
        term.write(`\r\n[Terminal error: ${event.error}]\r\n`);
        term.scrollToBottom();
        scheduleLayout();
      } else if (event.type === "status" && event.status === "exited") {
        term.write("\r\n[Process exited]\r\n");
        term.scrollToBottom();
        scheduleLayout();
      } else if (event.type === "capabilities") {
        scheduleLayout();
      }
    });

    const dataDisposable = term.onData((data) => {
      if (suppressPtyInputRef.current) return;
      term.scrollToBottom();
      void session.write(data);
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void session.resize(Math.max(2, cols), Math.max(1, rows));
    });

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width < 20 || height < 20) return;
      const last = lastFitSizeRef.current;
      if (last.w === width && last.h === height) return;
      scheduleLayout();
    });
    resizeObserver.observe(container.parentElement ?? container);
    const handlePointerDown = () => {
      setTerminalFocus();
      term.focus();
    };
    const handleFocusIn = () => {
      setTerminalFocus();
    };
    const handleFocusOut = (event: FocusEvent) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && container.contains(nextTarget)) return;
      clearTerminalFocus();
    };
    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("focusin", handleFocusIn);
    container.addEventListener("focusout", handleFocusOut);
    scheduleLayout();

    return () => {
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("focusin", handleFocusIn);
      container.removeEventListener("focusout", handleFocusOut);
      clearTerminalFocus();
      resizeObserver.disconnect();
      resizeDisposable.dispose();
      dataDisposable.dispose();
      cleanupSession();
      for (const d of oscDisposables) d.dispose();
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
  }, [commandRegistry, focusContext, session]);

  useEffect(() => {
    if (!expanded) return;
    suppressNextCtrlORef.current = true;
    focusContext.request("terminal");
  }, [expanded, focusContext, focusRequestKey]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      const replay = session.getReplayData();
      if (replay) {
        term.clear();
        session.setOscHooksSuppressed(true);
        suppressPtyInputRef.current = true;
        term.write(replay, () => {
          suppressPtyInputRef.current = false;
          session.setOscHooksSuppressed(false);
        });
      }
      fit.fit();
      void session.resize(Math.max(2, term.cols), Math.max(1, term.rows));
      if (expanded) {
        term.scrollToBottom();
      }
      if (expanded) {
        focusContext.request("terminal");
      } else if (hasTerminalFocusRef.current) {
        focusContext.blurCurrent();
        focusContext.pop("terminal");
      } else {
        // Panels are visible; ensure hidden terminal cannot keep keyboard focus.
        term.blur();
      }
    });
  }, [expanded, focusContext, session]);

  return <div ref={containerRef} className={styles["terminal-container"]} />;
}
