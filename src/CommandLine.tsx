import { useCallback, useEffect, useRef, useState } from 'react';
import { focusContext } from './focusContext';

interface CommandLineProps {
  cwd: string;
  visible: boolean;
  onExecute: (command: string) => void;
  pasteRef?: React.MutableRefObject<(text: string) => void>;
}

export function CommandLine({ cwd, visible, onExecute, pasteRef }: CommandLineProps) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [, setHistoryPos] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  if (pasteRef) {
    pasteRef.current = (text: string) => {
      setValue((v) => v + text);
      inputRef.current?.focus();
    };
  }

  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);

  const handleFocus = useCallback(() => {
    focusContext.push('commandLine');
  }, []);

  const handleBlur = useCallback(() => {
    focusContext.pop('commandLine');
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        const cmd = value.trim();
        if (cmd) {
          setHistory((prev) => [cmd, ...prev.slice(0, 99)]);
          onExecute(cmd);
          setValue('');
          setHistoryPos(-1);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHistoryPos((prev) => {
          const next = Math.min(prev + 1, history.length - 1);
          if (next >= 0) setValue(history[next]);
          return next;
        });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHistoryPos((prev) => {
          const next = Math.max(prev - 1, -1);
          setValue(next === -1 ? '' : (history[next] ?? ''));
          return next;
        });
      } else if (e.key === 'Escape') {
        setValue('');
        setHistoryPos(-1);
      }
    },
    [value, history, onExecute],
  );

  const promptLabel = cwd.length > 40 ? '\u2026' + cwd.slice(cwd.length - 39) : cwd;

  return (
    <div className={`command-line${visible ? '' : ' hidden'}`}>
      <span className="command-line-prompt">{promptLabel}&gt;</span>
      <input
        ref={inputRef}
        className="command-line-input"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setHistoryPos(-1);
        }}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />
    </div>
  );
}
