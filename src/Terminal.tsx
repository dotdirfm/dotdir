import { Terminal } from '@xterm/xterm';
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

const MAX_COMMAND_LINES = 12;

interface TerminalPanelProps {
  cwd: string;
  onCwdChange?: (path: string) => void;
  onVisibleHeight?: (px: number) => void;
  onPromptActive?: (active: boolean) => void;
}

export function TerminalPanel({ cwd, onCwdChange, onVisibleHeight, onPromptActive }: TerminalPanelProps) {
  const windowsPipeMode = isWindowsPath(cwd);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const lastTerminalCwdRef = useRef<string>(cwd);
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;
  const onVisibleHeightRef = useRef(onVisibleHeight);
  onVisibleHeightRef.current = onVisibleHeight;
  const onPromptActiveRef = useRef(onPromptActive);
  onPromptActiveRef.current = onPromptActive;
  const suppressRef = useRef(false);
  const suppressBufRef = useRef('');
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const lineBufferRef = useRef('');
  const promptAbsRowRef = useRef<number | null>(null);
  const trackingRef = useRef(false);
  const lastVisibleHeightRef = useRef(0);
  const cellHeightRef = useRef(18);
  const pendingPromptRef = useRef(false);

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
    const parentEl = container.parentElement;
    if (!parentEl) return;

    const measureCells = () => {
      const screen = container.querySelector('.xterm-screen') as HTMLElement;
      if (screen && term.rows > 0 && term.cols > 0) {
        const rect = screen.getBoundingClientRect();
        cellHeightRef.current = rect.height / term.rows;
      }
    };

    const reportVisibleHeight = () => {
      let lines = 1;
      if (trackingRef.current && promptAbsRowRef.current !== null) {
        const buf = term.buffer.active;
        const currentAbsRow = buf.baseY + buf.cursorY;
        lines = currentAbsRow - promptAbsRowRef.current + 1;
        if (lines > MAX_COMMAND_LINES || lines < 1) {
          trackingRef.current = false;
          lines = 1;
        }
      }
      const height = Math.max(lines, 1) * cellHeightRef.current;
      if (Math.abs(height - lastVisibleHeightRef.current) > 0.5) {
        lastVisibleHeightRef.current = height;
        onVisibleHeightRef.current?.(height);
      }
    };

    const updatePromptPosition = () => {
      const buf = term.buffer.active;
      promptAbsRowRef.current = buf.baseY + buf.cursorY;
      trackingRef.current = true;
      reportVisibleHeight();
    };

    const doFit = () => {
      const parentRect = parentEl.getBoundingClientRect();
      if (parentRect.width === 0 || parentRect.height === 0) return;

      measureCells();
      const cellH = cellHeightRef.current;
      if (cellH <= 0) return;

      const screen = container.querySelector('.xterm-screen') as HTMLElement;
      let cellW = 7;
      if (screen && term.cols > 0) {
        cellW = screen.getBoundingClientRect().width / term.cols;
      }
      if (cellW <= 0) return;

      const cols = Math.max(2, Math.floor((parentRect.width - 4) / cellW));
      const rows = Math.max(1, Math.floor(parentRect.height / cellH));

      if (cols !== term.cols || rows !== term.rows) {
        term.resize(cols, rows);
      }
    };

    const scheduleFit = () => {
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = requestAnimationFrame(() => {
        fitFrameRef.current = null;
        doFit();
        measureCells();
        reportVisibleHeight();
      });
    };

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e2e',
      },
    });
    term.open(container);
    termRef.current = term;

    // Prevent xterm from consuming Ctrl+O so the app-level handler can toggle panels
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === 'o' && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        return false; // let event propagate to window handler
      }
      return true;
    });

    term.parser.registerOscHandler(7, (data) => {
      const match = data.match(/^file:\/\/[^/]*(\/.*)/);
      if (match) {
        const path = normalizePtyPath(decodeURIComponent(match[1]));
        lastTerminalCwdRef.current = path;
        onCwdChangeRef.current?.(path);
      }
      pendingPromptRef.current = true;
      return true;
    });

    // Shell integration: OSC 133 markers (like iTerm2/VS Code)
    // A = prompt start (command finished), C = command execution start
    term.parser.registerOscHandler(133, (data) => {
      if (data === 'A') {
        onPromptActiveRef.current?.(true);
      } else if (data === 'C') {
        onPromptActiveRef.current?.(false);
      }
      return true;
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
          updatePromptPosition();
        }
        return;
      }

      term.write(data);

      if (pendingPromptRef.current) {
        pendingPromptRef.current = false;
        updatePromptPosition();
      } else {
        reportVisibleHeight();
      }
    });

    const cleanupExit = bridge.pty.onExit((id) => {
      if (id === ptyIdRef.current) {
        term.write('\r\n[Process exited]\r\n');
        ptyIdRef.current = null;
      }
    });

    const ro = new ResizeObserver(() => scheduleFit());
    ro.observe(parentEl);

    // Initial fit + cursor positioning in first frame, then spawn PTY
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      doFit();
      measureCells();

      if (term.rows > 1) {
        term.write(`\x1b[${term.rows};1H`);
      }

      reportVisibleHeight();

      bridge.pty.spawn(cwd, term.cols, term.rows).then((id) => {
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

        if (!windowsPipeMode) {
          bridge.pty.write(id, buildCdCommand(cwd));
        }
      }).catch((err) => {
        term.write('\r\n[Terminal failed to start: ' + String(err) + ']\r\n');
      });
    });

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
