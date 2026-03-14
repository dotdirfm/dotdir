import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { focusContext } from '../focusContext';
import type { TerminalSession } from './TerminalSession';

interface TerminalViewProps {
  session: TerminalSession;
  expanded?: boolean;
}

type DebugWindow = Window & typeof globalThis & { __terminalDebugLogs?: string[] };

function resolveTerminalTheme() {
  return {
    background: '#11131a',
    foreground: '#d7dae0',
    cursor: '#f5f7ff',
    selectionBackground: 'rgba(128, 146, 255, 0.28)',
  };
}

export function TerminalView({ session, expanded = false }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitFrameRef = useRef<number | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const hasTerminalFocusRef = useRef(false);
  const replayFrameRef = useRef<number | null>(null);
  const syncInFlightRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const fit = new FitAddon();
    const term = new Terminal({
      cursorBlink: false,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollOnUserInput: true,
      scrollback: 1000,
      theme: resolveTerminalTheme(),
    });

    const scheduleLayout = () => {
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = requestAnimationFrame(() => {
        fitFrameRef.current = null;
        const body = container.parentElement;
        if (!body || body.clientWidth < 20 || body.clientHeight < 20) return;
        fit.fit();
        void session.resize(Math.max(2, term.cols), Math.max(1, term.rows));
        const screen = container.querySelector('.xterm-screen');
        if (screen instanceof HTMLElement) {
          screen.style.transform = '';
          const rows = Array.from(container.querySelectorAll('.xterm-rows > div'))
            .filter((row): row is HTMLElement => row instanceof HTMLElement && row.getBoundingClientRect().height > 0);
          const lastVisibleRow = [...rows].reverse().find((row) => row.textContent?.trim().length) ?? rows[rows.length - 1];
          if (lastVisibleRow) {
            const containerRect = container.getBoundingClientRect();
            const rowRect = lastVisibleRow.getBoundingClientRect();
            const offset = Math.max(0, containerRect.bottom - rowRect.bottom + 1);
            screen.style.transform = offset > 0 ? `translateY(${offset}px)` : '';
          }
        }
      });
    };

    const renderReplay = () => {
      const replay = session.getReplayData();
      term.reset();
      if (!replay) return;
      term.write(replay);
    };

    const scheduleReplayRender = () => {
      if (replayFrameRef.current !== null) cancelAnimationFrame(replayFrameRef.current);
      replayFrameRef.current = requestAnimationFrame(() => {
        replayFrameRef.current = null;
        const replay = session.getReplayData();
        const debugWindow = window as DebugWindow;
        debugWindow.__terminalDebugLogs ??= [];
        debugWindow.__terminalDebugLogs.push(replay);
        renderReplay();
        term.scrollToBottom();
        scheduleLayout();
      });
    };

    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    const setTerminalFocus = () => {
      if (hasTerminalFocusRef.current) return;
      hasTerminalFocusRef.current = true;
      focusContext.push('terminal');
    };
    const clearTerminalFocus = () => {
      if (!hasTerminalFocusRef.current) return;
      hasTerminalFocusRef.current = false;
      focusContext.pop('terminal');
    };
    term.attachCustomKeyEventHandler((event) => {
      setTerminalFocus();
      if (event.key.toLowerCase() === 'o' && event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        return false;
      }
      return true;
    });
    scheduleLayout();
    renderReplay();

    const cleanupSession = session.subscribe((event) => {
      if (event.type === 'sync-start') {
        syncInFlightRef.current = true;
      } else if (event.type === 'sync-complete') {
        syncInFlightRef.current = false;
        scheduleReplayRender();
      } else if (event.type === 'data') {
        if (syncInFlightRef.current) {
          return;
        }
        term.write(event.data);
        term.scrollToBottom();
        scheduleLayout();
      } else if (event.type === 'status' && event.status === 'error' && event.error) {
        term.write(`\r\n[Terminal error: ${event.error}]\r\n`);
        term.scrollToBottom();
        scheduleLayout();
      } else if (event.type === 'status' && event.status === 'exited') {
        term.write('\r\n[Process exited]\r\n');
        term.scrollToBottom();
        scheduleLayout();
      } else if (event.type === 'capabilities') {
        scheduleLayout();
      }
    });

    const dataDisposable = term.onData((data) => {
      term.scrollToBottom();
      void session.write(data);
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void session.resize(Math.max(2, cols), Math.max(1, rows));
    });

    const resizeObserver = new ResizeObserver(() => {
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
    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('focusin', handleFocusIn);
    container.addEventListener('focusout', handleFocusOut);
    scheduleLayout();

    return () => {
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('focusin', handleFocusIn);
      container.removeEventListener('focusout', handleFocusOut);
      clearTerminalFocus();
      resizeObserver.disconnect();
      resizeDisposable.dispose();
      dataDisposable.dispose();
      cleanupSession();
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      if (replayFrameRef.current !== null) cancelAnimationFrame(replayFrameRef.current);
      termRef.current = null;
      fitRef.current = null;
      syncInFlightRef.current = false;
      term.dispose();
    };
  }, [session]);

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
        term.write(replay);
      }
      fit.fit();
      void session.resize(Math.max(2, term.cols), Math.max(1, term.rows));
      if (expanded) {
        term.scrollToBottom();
      }
      if (!hasTerminalFocusRef.current) {
        hasTerminalFocusRef.current = true;
        focusContext.push('terminal');
      }
      term.focus();
    });
  }, [expanded]);

  return <div ref={containerRef} className="terminal-container" />;
}
