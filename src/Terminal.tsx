import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { bridge } from './bridge';

function shellQuote(path: string): string {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

/** OSC 7 delivers Windows paths with a leading slash: /C:/Users/… → C:/Users/… */
function normalizePtyPath(raw: string): string {
  const m = raw.match(/^\/([A-Za-z]:\/.*)/);
  return m ? m[1] : raw;
}

interface TerminalPanelProps {
  cwd: string;
  onCwdChange?: (path: string) => void;
}

export function TerminalPanel({ cwd, onCwdChange }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const lastTerminalCwdRef = useRef<string>(cwd);
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;
  const suppressRef = useRef(false);
  const suppressBufRef = useRef('');
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Send cd to terminal when panel navigates (suppressing echo)
  useEffect(() => {
    if (ptyIdRef.current === null) return;
    if (cwd === lastTerminalCwdRef.current) return;

    // Start output suppression — buffer PTY output until OSC 7 confirms cd
    suppressRef.current = true;
    suppressBufRef.current = '';

    // Timeout fallback: if no OSC 7 within 2s, flush buffer as-is
    if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = setTimeout(() => {
      if (suppressRef.current) {
        suppressRef.current = false;
        const buf = suppressBufRef.current;
        suppressBufRef.current = '';
        suppressTimerRef.current = null;
        if (buf) termRef.current?.write(buf);
      }
    }, 2000);

    lastTerminalCwdRef.current = cwd;
    // Leading space suppresses history (HISTCONTROL=ignoreboth / HIST_IGNORE_SPACE)
    bridge.pty.write(ptyIdRef.current, ` cd ${shellQuote(cwd)}\n`);
  }, [cwd]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: 'var(--bg)' === 'var(--bg)' ? '#1e1e2e' : undefined,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Register OSC 7 handler for cwd tracking (fires for user-typed cd)
    term.parser.registerOscHandler(7, (data) => {
      const match = data.match(/^file:\/\/[^/]*(\/.*)/);
      if (match) {
        const path = normalizePtyPath(decodeURIComponent(match[1]));
        lastTerminalCwdRef.current = path;
        onCwdChangeRef.current?.(path);
      }
      return true;
    });

    // Spawn PTY
    bridge.pty.spawn(cwd).then((id) => {
      ptyIdRef.current = id;

      term.onData((data) => {
        bridge.pty.write(id, data);
      });

      term.onResize(({ cols, rows }) => {
        bridge.pty.resize(id, cols, rows);
      });

      bridge.pty.resize(id, term.cols, term.rows);
    });

    // Receive PTY output
    const cleanupData = bridge.pty.onData((id, data) => {
      if (id !== ptyIdRef.current) return;

      if (suppressRef.current) {
        suppressBufRef.current += data;
        // Look for OSC 7: \x1b]7;...\x1b\\ or \x1b]7;...\x07
        const buf = suppressBufRef.current;
        const osc7Match = buf.match(/\x1b\]7;([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
        if (osc7Match) {
          const matchIdx = buf.indexOf(osc7Match[0]);
          const afterOsc = buf.slice(matchIdx + osc7Match[0].length);

          // Update cwd from the OSC 7 payload
          const pathMatch = osc7Match[1].match(/^file:\/\/[^/]*(\/.*)/);
          if (pathMatch) {
            lastTerminalCwdRef.current = normalizePtyPath(decodeURIComponent(pathMatch[1]));
          }

          suppressRef.current = false;
          suppressBufRef.current = '';
          if (suppressTimerRef.current) {
            clearTimeout(suppressTimerRef.current);
            suppressTimerRef.current = null;
          }

          // Clear old prompt line, then write new prompt
          term.write('\r\x1b[2K' + afterOsc);
        }
        return;
      }

      term.write(data);
    });

    const cleanupExit = bridge.pty.onExit((id) => {
      if (id === ptyIdRef.current) {
        term.write('\r\n[Process exited]\r\n');
        ptyIdRef.current = null;
      }
    });

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(container);

    return () => {
      ro.disconnect();
      cleanupData();
      cleanupExit();
      if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
      if (ptyIdRef.current !== null) {
        bridge.pty.close(ptyIdRef.current);
      }
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="terminal-container" />;
}
