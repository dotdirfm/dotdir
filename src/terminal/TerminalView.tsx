import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSession } from './TerminalSession';

interface TerminalViewProps {
  session: TerminalSession;
  expanded?: boolean;
}

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

    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    term.attachCustomKeyEventHandler((event) => {
      if (event.key.toLowerCase() === 'o' && event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        return false;
      }
      return true;
    });
    scheduleLayout();

    const cleanupSession = session.subscribe((event) => {
      if (event.type === 'data') {
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
      term.focus();
    };
    container.addEventListener('pointerdown', handlePointerDown);
    scheduleLayout();

    return () => {
      container.removeEventListener('pointerdown', handlePointerDown);
      resizeObserver.disconnect();
      resizeDisposable.dispose();
      dataDisposable.dispose();
      cleanupSession();
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      termRef.current = null;
      fitRef.current = null;
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
      fit.fit();
      void session.resize(Math.max(2, term.cols), Math.max(1, term.rows));
      if (expanded) {
        term.scrollToBottom();
      }
      term.focus();
    });
  }, [expanded]);

  return <div ref={containerRef} className="terminal-container" />;
}
