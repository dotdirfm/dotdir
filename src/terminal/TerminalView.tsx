import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSession } from './TerminalSession';

interface TerminalViewProps {
  session: TerminalSession;
}

function resolveTerminalTheme() {
  return {
    background: '#11131a',
    foreground: '#d7dae0',
    cursor: '#f5f7ff',
    selectionBackground: 'rgba(128, 146, 255, 0.28)',
  };
}

export function TerminalView({ session }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const fit = new FitAddon();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollOnUserInput: true,
      scrollback: 1000,
      theme: resolveTerminalTheme(),
    });

    const scheduleFit = () => {
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = requestAnimationFrame(() => {
        fitFrameRef.current = null;
        if (container.clientWidth < 20 || container.clientHeight < 20) return;
        fit.fit();
        void session.resize(Math.max(2, term.cols), Math.max(1, term.rows));
      });
    };

    term.loadAddon(fit);
    term.open(container);
    scheduleFit();

    const cleanupSession = session.subscribe((event) => {
      if (event.type === 'data') {
        term.write(event.data);
        term.scrollToBottom();
      } else if (event.type === 'status' && event.status === 'error' && event.error) {
        term.write(`\r\n[Terminal error: ${event.error}]\r\n`);
        term.scrollToBottom();
      } else if (event.type === 'status' && event.status === 'exited') {
        term.write('\r\n[Process exited]\r\n');
        term.scrollToBottom();
      }
    });

    const dataDisposable = term.onData((data) => {
      term.scrollToBottom();
      void session.write(data);
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void session.resize(Math.max(2, cols), Math.max(1, rows));
    });

    const resizeObserver = new ResizeObserver(() => scheduleFit());
    resizeObserver.observe(container);
    const handlePointerDown = () => term.scrollToBottom();
    container.addEventListener('pointerdown', handlePointerDown);

    return () => {
      container.removeEventListener('pointerdown', handlePointerDown);
      resizeObserver.disconnect();
      resizeDisposable.dispose();
      dataDisposable.dispose();
      cleanupSession();
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      term.dispose();
    };
  }, [session]);

  return <div ref={containerRef} className="terminal-container" />;
}
