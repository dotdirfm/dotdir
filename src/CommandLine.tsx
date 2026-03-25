import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, MutableRefObject, ReactNode } from "react";
import { commandRegistry } from "./commands";
import { registerCommandLineKeybindings } from "./registerKeybindings";

interface CommandLineProps {
  cwd: string;
  visible: boolean;
  onExecute: (command: string) => void;
  pasteRef?: MutableRefObject<(text: string) => void>;
}

export function CommandLine({ cwd, visible, onExecute, pasteRef }: CommandLineProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState(0);
  const isDragging = useRef(false);
  const inputRef = useRef<HTMLSpanElement>(null);

  // Refs so handlers always see latest state without re-registration
  const valueRef = useRef(value);
  const cursorRef = useRef(cursor);
  const anchorRef = useRef(anchor);
  const onExecuteRef = useRef(onExecute);
  valueRef.current = value;
  cursorRef.current = cursor;
  anchorRef.current = anchor;
  onExecuteRef.current = onExecute;

  // Expose paste injection — inserts at cursor position, replacing any selection
  if (pasteRef) {
    pasteRef.current = (text: string) => {
      const pos = cursorRef.current;
      const anch = anchorRef.current;
      const s = Math.min(pos, anch);
      const e = Math.max(pos, anch);
      const newPos = s + text.length;
      setValue((v) => v.slice(0, s) + text + v.slice(e));
      setCursor(newPos);
      setAnchor(newPos);
    };
  }

  // Keep commandRegistry context in sync so Enter/Backspace route correctly
  useEffect(() => {
    commandRegistry.setContext("commandLineHasText", visible && value.length > 0);
  }, [visible, value]);

  // Helpers used inside command handlers (always read via refs)
  const deleteSelection = useCallback((): boolean => {
    const pos = cursorRef.current;
    const anch = anchorRef.current;
    if (pos === anch) return false;
    const s = Math.min(pos, anch);
    const e = Math.max(pos, anch);
    setValue((v) => v.slice(0, s) + v.slice(e));
    setCursor(s);
    setAnchor(s);
    return true;
  }, []);

  const moveCursor = useCallback((newPos: number, extendSel: boolean) => {
    setCursor(newPos);
    if (!extendSel) setAnchor(newPos);
  }, []);

  // Register all editing/navigation commands once; always read state via refs
  useEffect(() => {
    const d: Array<() => void> = [];
    const options = { category: "Command Line", when: "focusPanel" };
    const optionsWhenHasText = {
      category: "Command Line",
      when: "focusPanel && commandLineHasText",
    };

    d.push(
      commandRegistry.registerCommand(
        "commandLine.execute",
        "Execute Command Line",
        () => {
          const cmd = valueRef.current.trim();
          if (!cmd) return;
          onExecuteRef.current(cmd);
          setValue("");
          setCursor(0);
          setAnchor(0);
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.clear",
        "Clear Command Line",
        () => {
          if (cursorRef.current !== anchorRef.current) {
            setAnchor(cursorRef.current); // collapse selection first
          } else {
            setValue("");
            setCursor(0);
            setAnchor(0);
          }
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.deleteLeft",
        "Delete Left",
        () => {
          const pos = cursorRef.current;
          const anch = anchorRef.current;
          if (pos !== anch) {
            deleteSelection();
          } else if (pos > 0) {
            setValue((v) => v.slice(0, pos - 1) + v.slice(pos));
            setCursor(pos - 1);
            setAnchor(pos - 1);
          }
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.deleteRight",
        "Delete Right",
        () => {
          if (!deleteSelection()) {
            const pos = cursorRef.current;
            if (pos < valueRef.current.length) {
              setValue((v) => v.slice(0, pos) + v.slice(pos + 1));
            }
          }
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.moveWordLeft",
        "Move Cursor Word Left",
        () => {
          const v = valueRef.current;
          let p = cursorRef.current;
          while (p > 0 && v[p - 1] === " ") p--;
          while (p > 0 && v[p - 1] !== " ") p--;
          moveCursor(p, false);
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.moveWordRight",
        "Move Cursor Word Right",
        () => {
          const v = valueRef.current;
          let p = cursorRef.current;
          while (p < v.length && v[p] !== " ") p++;
          while (p < v.length && v[p] === " ") p++;
          moveCursor(p, false);
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.home",
        "Move Cursor to Start",
        () => {
          moveCursor(0, false);
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.end",
        "Move Cursor to End",
        () => {
          moveCursor(valueRef.current.length, false);
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.selectAll",
        "Select All",
        () => {
          if (valueRef.current.length === 0) return;
          setAnchor(0);
          setCursor(valueRef.current.length);
        },
        optionsWhenHasText,
      ),
    );

    // Selection commands — registered without keybindings; user can bind manually
    d.push(
      commandRegistry.registerCommand(
        "commandLine.selectLeft",
        "Extend Selection Left",
        () => {
          moveCursor(Math.max(0, cursorRef.current - 1), true);
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.selectRight",
        "Extend Selection Right",
        () => {
          moveCursor(Math.min(valueRef.current.length, cursorRef.current + 1), true);
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.selectHome",
        "Extend Selection to Start",
        () => {
          moveCursor(0, true);
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.selectEnd",
        "Extend Selection to End",
        () => {
          moveCursor(valueRef.current.length, true);
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.copy",
        "Copy Selection",
        () => {
          const pos = cursorRef.current;
          const anch = anchorRef.current;
          if (pos === anch) return;
          const s = Math.min(pos, anch);
          const e = Math.max(pos, anch);
          navigator.clipboard.writeText(valueRef.current.slice(s, e)).catch(() => {});
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.cut",
        "Cut Selection",
        () => {
          const pos = cursorRef.current;
          const anch = anchorRef.current;
          if (pos === anch) return;
          const s = Math.min(pos, anch);
          const e = Math.max(pos, anch);
          navigator.clipboard.writeText(valueRef.current.slice(s, e)).catch(() => {});
          deleteSelection();
        },
        optionsWhenHasText,
      ),
    );

    d.push(
      commandRegistry.registerCommand(
        "commandLine.paste",
        "Paste from Clipboard",
        () => {
          navigator.clipboard
            .readText()
            .then((text) => {
              if (!text) return;
              const pos = cursorRef.current;
              const anch = anchorRef.current;
              const s = Math.min(pos, anch);
              const e = Math.max(pos, anch);
              const newPos = s + text.length;
              setValue((v) => v.slice(0, s) + text + v.slice(e));
              setCursor(newPos);
              setAnchor(newPos);
            })
            .catch(() => {});
        },
        options,
      ),
    );

    return () => {
      for (const fn of d) fn();
    };
  }, [deleteSelection, moveCursor]);

  // Register keybindings only while visible
  useEffect(() => {
    if (!visible) return;
    const d: Array<() => void> = [];

    d.push(...registerCommandLineKeybindings(commandRegistry));

    return () => {
      for (const fn of d) fn();
    };
  }, [visible]);

  // Bubble-phase handler: only handles printable character input.
  // All other keys are routed through commandRegistry (capture phase above).
  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest?.(".terminal-container")) return;
      // Let native <dialog> modals (Make Folder, etc.) receive typing — not the prompt.
      if (target.closest?.("dialog")) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl && !e.altKey && !e.metaKey && e.key.length === 1) {
        e.preventDefault();
        e.stopPropagation();
        const pos = cursorRef.current;
        const anch = anchorRef.current;
        const s = Math.min(pos, anch);
        const e2 = Math.max(pos, anch);
        setValue((v) => v.slice(0, s) + e.key + v.slice(e2));
        setCursor(s + 1);
        setAnchor(s + 1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visible]);

  // Resolve click/drag position using elementFromPoint + Range binary search.
  // Avoids caretRangeFromPoint which can return the zero-width cursor span as
  // startContainer (an Element, not Text), causing a spurious jump to end.
  const getPositionFromPoint = useCallback((x: number, y: number): number => {
    const inputEl = inputRef.current;
    if (!inputEl) return valueRef.current.length;
    const inputRect = inputEl.getBoundingClientRect();

    // elementFromPoint respects pointer-events and skips 0-width elements
    const target = document.elementFromPoint(x, y);
    if (!target || !inputEl.contains(target)) {
      return x < inputRect.left ? 0 : valueRef.current.length;
    }

    // Walk up to nearest span with data-start
    let el: Element | null = target;
    while (el && el !== inputEl && !el.hasAttribute("data-start")) {
      el = el.parentElement;
    }
    if (!el || el === inputEl || !el.hasAttribute("data-start")) {
      return x < inputRect.left ? 0 : valueRef.current.length;
    }

    const spanStart = parseInt(el.getAttribute("data-start")!, 10);
    const textNode = el.firstChild;
    if (!(textNode instanceof Text) || !textNode.textContent?.length) {
      return spanStart;
    }

    // Binary search for the character boundary closest to x
    const len = textNode.textContent.length;
    const r = document.createRange();
    let lo = 0,
      hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      r.setStart(textNode, mid);
      r.setEnd(textNode, mid + 1);
      if (r.getBoundingClientRect().right <= x) lo = mid + 1;
      else hi = mid;
    }
    // Snap to nearest character edge
    if (lo < len) {
      r.setStart(textNode, lo);
      r.setEnd(textNode, lo + 1);
      const cr = r.getBoundingClientRect();
      if (x >= cr.left + cr.width / 2) lo++;
    }

    return Math.min(spanStart + lo, valueRef.current.length);
  }, []);

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const pos = getPositionFromPoint(e.clientX, e.clientY);
      setCursor(pos);
      setAnchor(pos);
      isDragging.current = true;

      const onMove = (me: MouseEvent) => {
        if (!isDragging.current) return;
        setCursor(getPositionFromPoint(me.clientX, me.clientY));
      };
      const onUp = () => {
        isDragging.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [getPositionFromPoint],
  );

  const promptLabel = cwd.length > 40 ? "\u2026" + cwd.slice(cwd.length - 39) : cwd;

  const selStart = Math.min(cursor, anchor);
  const selEnd = Math.max(cursor, anchor);
  const hasSelection = selStart < selEnd;

  let inputContent: ReactNode;
  if (!hasSelection) {
    inputContent = (
      <>
        <span className="command-line-text" data-start={0}>
          {value.slice(0, cursor)}
        </span>
        <span className="command-line-cursor" />
        <span className="command-line-text" data-start={cursor}>
          {value.slice(cursor)}
        </span>
      </>
    );
  } else if (cursor <= anchor) {
    // cursor at start of selection
    inputContent = (
      <>
        <span className="command-line-text" data-start={0}>
          {value.slice(0, cursor)}
        </span>
        <span className="command-line-cursor" />
        <span className="command-line-selected" data-start={cursor}>
          {value.slice(cursor, anchor)}
        </span>
        <span className="command-line-text" data-start={anchor}>
          {value.slice(anchor)}
        </span>
      </>
    );
  } else {
    // cursor at end of selection
    inputContent = (
      <>
        <span className="command-line-text" data-start={0}>
          {value.slice(0, anchor)}
        </span>
        <span className="command-line-selected" data-start={anchor}>
          {value.slice(anchor, cursor)}
        </span>
        <span className="command-line-cursor" />
        <span className="command-line-text" data-start={cursor}>
          {value.slice(cursor)}
        </span>
      </>
    );
  }

  return (
    <div className={`command-line${visible ? "" : " hidden"}`}>
      <span className="command-line-prompt">{promptLabel}&gt;</span>
      <span ref={inputRef} className="command-line-input" onMouseDown={handleMouseDown}>
        {inputContent}
      </span>
    </div>
  );
}
