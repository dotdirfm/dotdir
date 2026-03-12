import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { bridge } from './bridge';

function shellQuote(path: string): string {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

/** OSC 7 delivers Windows paths with a leading slash: /C:/Users/... -> C:/Users/... */
function normalizePtyPath(raw: string): string {
  const normalized = raw.replace(/\\/g, '/');
  const m = normalized.match(/^\/([A-Za-z]:\/.*)/);
  return m ? m[1] : normalized;
}

function buildCdCommand(path: string): string {
  if (isWindowsPath(path)) {
    const cmdPath = path.replace(/\//g, '\\').replace(/"/g, '""');
    return `cd /d "${cmdPath}"\r`;
  }
  return ` cd ${shellQuote(path)}\n`;
}

interface TerminalPanelProps {
  cwd: string;
  onCwdChange?: (path: string) => void;
}

export function TerminalPanel({ cwd, onCwdChange }: TerminalPanelProps) {
  const windowsPipeMode = isWindowsPath(cwd);
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
  const fitFrameRef = useRef<number | null>(null);
  const lineBufferRef = useRef('');

  useEffect(() => {
    if (ptyIdRef.current === null) return;
    if (cwd === lastTerminalCwdRef.current) return;

    suppressRef.current = true;
    suppressBufRef.current = '';

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
    bridge.pty.write(ptyIdRef.current, buildCdCommand(cwd));
  }, [cwd]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scheduleFit = () => {
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = requestAnimationFrame(() => {
        fitFrameRef.current = null;
        fit.fit();
      });
    };

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
    scheduleFit();
    termRef.current = term;
    fitRef.current = fit;

    term.parser.registerOscHandler(7, (data) => {
      const match = data.match(/^file:\/\/[^/]*(\/.*)/);
      if (match) {
        const path = normalizePtyPath(decodeURIComponent(match[1]));
        lastTerminalCwdRef.current = path;
        onCwdChangeRef.current?.(path);
      }
      return true;
    });

    bridge.pty.spawn(cwd).then((id) => {
      ptyIdRef.current = id;

      term.onData((data) => {
        if (!windowsPipeMode) {
          bridge.pty.write(id, data);
          return;
        }

        for (const ch of data) {
          if (ch === '\r') {
            const line = lineBufferRef.current;
            lineBufferRef.current = '';
            term.write('\r\n');
            bridge.pty.write(id, line + '\r\n');
          } else if (ch === '\u007f') {
            if (lineBufferRef.current.length > 0) {
              lineBufferRef.current = lineBufferRef.current.slice(0, -1);
              term.write('\b \b');
            }
          } else if (ch >= ' ' || ch === '\t') {
            lineBufferRef.current += ch;
            term.write(ch);
          }
        }
      });

      term.onResize(({ cols, rows }) => {
        bridge.pty.resize(id, cols, rows);
      });

      scheduleFit();
      bridge.pty.resize(id, term.cols, term.rows);
      if (!windowsPipeMode) {
        bridge.pty.write(id, buildCdCommand(cwd));
      }
    }).catch((err) => {
      term.write('\\r\\n[Terminal failed to start: ' + String(err) + ']\\r\\n');
    });

    const cleanupData = bridge.pty.onData((id, data) => {
      if (id !== ptyIdRef.current) return;

      if (suppressRef.current) {
        suppressBufRef.current += data;
        const buf = suppressBufRef.current;
        const osc7Match = buf.match(/\x1b\]7;([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
        if (osc7Match) {
          const matchIdx = buf.indexOf(osc7Match[0]);
          const afterOsc = buf.slice(matchIdx + osc7Match[0].length);
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

    const ro = new ResizeObserver(() => scheduleFit());
    ro.observe(container);

    return () => {
      ro.disconnect();
      cleanupData();
      cleanupExit();
      if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      if (ptyIdRef.current !== null) {
        bridge.pty.close(ptyIdRef.current);
      }
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="terminal-container" />;
}
