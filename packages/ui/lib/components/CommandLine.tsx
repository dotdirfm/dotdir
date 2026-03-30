import { commandLineCwdAtom, commandLineOnExecuteAtom, commandLinePasteFnAtom, panelsVisibleAtom } from "@/atoms";
import { commandRegistry } from "@/features/commands/commands";
import { registerCommandLineKeybindings } from "@/registerKeybindings";
import { useAtomValue, useSetAtom } from "jotai";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../styles/terminal.module.css";
import { cx } from "../utils/cssModules";

export function CommandLine() {
  const cwd = useAtomValue(commandLineCwdAtom);
  const visible = useAtomValue(panelsVisibleAtom);
  const onExecute = useAtomValue(commandLineOnExecuteAtom);
  const setPasteFn = useSetAtom(commandLinePasteFnAtom);
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState(0);
  const isDragging = useRef(false);
  const inputRef = useRef<HTMLSpanElement>(null);

  // Refs so handlers always see latest state without re-registration
  const valueRef = useRef(value);
  const cursorRef = useRef(cursor);
  const anchorRef = useRef(anchor);
  const onExecuteRef = useRef<((cmd: string) => void) | null>(null);
  valueRef.current = value;
  cursorRef.current = cursor;
  anchorRef.current = anchor;
  if (onExecute) onExecuteRef.current = onExecute;

  // Expose paste injection via atom — inserts at cursor position, replacing any selection
  useEffect(() => {
    setPasteFn(() => (text: string) => {
      const pos = cursorRef.current;
      const anch = anchorRef.current;
      const s = Math.min(pos, anch);
      const e = Math.max(pos, anch);
      const newPos = s + text.length;
      setValue((v) => v.slice(0, s) + text + v.slice(e));
      setCursor(newPos);
      setAnchor(newPos);
    });
    return () => setPasteFn(() => () => {});
  }, [setPasteFn]);

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

    d.push(
      commandRegistry.registerCommand("commandLine.execute", () => {
        const cmd = valueRef.current.trim();
        if (!cmd) return;
        onExecuteRef.current?.(cmd);
        setValue("");
        setCursor(0);
        setAnchor(0);
      }),
    );

    d.push(
      commandRegistry.registerCommand("commandLine.clear", () => {
        if (cursorRef.current !== anchorRef.current) {
          setAnchor(cursorRef.current); // collapse selection first
        } else {
          setValue("");
          setCursor(0);
          setAnchor(0);
        }
      }),
    );

    d.push(
      commandRegistry.registerCommand("commandLine.deleteLeft", () => {
        const pos = cursorRef.current;
        const anch = anchorRef.current;
        if (pos !== anch) {
          deleteSelection();
        } else if (pos > 0) {
          setValue((v) => v.slice(0, pos - 1) + v.slice(pos));
          setCursor(pos - 1);
          setAnchor(pos - 1);
        }
      }),
    );

    d.push(
      commandRegistry.registerCommand("commandLine.deleteRight", () => {
        if (!deleteSelection()) {
          const pos = cursorRef.current;
          if (pos < valueRef.current.length) {
            setValue((v) => v.slice(0, pos) + v.slice(pos + 1));
          }
        }
      }),
    );

    d.push(
      commandRegistry.registerCommand("commandLine.moveWordLeft", () => {
        const v = valueRef.current;
        let p = cursorRef.current;
        while (p > 0 && v[p - 1] === " ") p--;
        while (p > 0 && v[p - 1] !== " ") p--;
        moveCursor(p, false);
      }),
    );

    d.push(
      commandRegistry.registerCommand("commandLine.moveWordRight", () => {
        const v = valueRef.current;
        let p = cursorRef.current;
        while (p < v.length && v[p] !== " ") p++;
        while (p < v.length && v[p] === " ") p++;
        moveCursor(p, false);
      }),
    );

    d.push(commandRegistry.registerCommand("commandLine.home", () => moveCursor(0, false)));
    d.push(commandRegistry.registerCommand("commandLine.end", () => moveCursor(valueRef.current.length, false)));

    d.push(
      commandRegistry.registerCommand("commandLine.selectAll", () => {
        if (valueRef.current.length === 0) return;
        setAnchor(0);
        setCursor(valueRef.current.length);
      }),
    );

    // Selection commands — registered without keybindings; user can bind manually
    d.push(commandRegistry.registerCommand("commandLine.selectLeft", () => moveCursor(Math.max(0, cursorRef.current - 1), true)));
    d.push(commandRegistry.registerCommand("commandLine.selectRight", () => moveCursor(Math.min(valueRef.current.length, cursorRef.current + 1), true)));
    d.push(commandRegistry.registerCommand("commandLine.selectHome", () => moveCursor(0, true)));
    d.push(commandRegistry.registerCommand("commandLine.selectEnd", () => moveCursor(valueRef.current.length, true)));

    d.push(
      commandRegistry.registerCommand("commandLine.copy", () => {
        const pos = cursorRef.current;
        const anch = anchorRef.current;
        if (pos === anch) return;
        const s = Math.min(pos, anch);
        const e = Math.max(pos, anch);
        navigator.clipboard.writeText(valueRef.current.slice(s, e)).catch(() => {});
      }),
    );

    d.push(
      commandRegistry.registerCommand("commandLine.cut", () => {
        const pos = cursorRef.current;
        const anch = anchorRef.current;
        if (pos === anch) return;
        const s = Math.min(pos, anch);
        const e = Math.max(pos, anch);
        navigator.clipboard.writeText(valueRef.current.slice(s, e)).catch(() => {});
        deleteSelection();
      }),
    );

    d.push(
      commandRegistry.registerCommand("commandLine.paste", () => {
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
      }),
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

    const isEditableElement = (element: HTMLElement | null) => {
      if (!element) return false;
      const tag = element.tagName?.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable;
    };

    const shouldIgnoreTyping = (element: HTMLElement | null) => {
      if (!element) return false;
      if (element.closest?.(`.${styles["terminal-container"]}`)) return true;
      if (element.closest?.('[role="dialog"], [aria-modal="true"], dialog')) return true;
      return isEditableElement(element);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const active = document.activeElement as HTMLElement | null;
      if (shouldIgnoreTyping(target) || shouldIgnoreTyping(active)) return;
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
        <span className={styles["command-line-text"]} data-start={0}>
          {value.slice(0, cursor)}
        </span>
        <span className={styles["command-line-cursor"]} />
        <span className={styles["command-line-text"]} data-start={cursor}>
          {value.slice(cursor)}
        </span>
      </>
    );
  } else if (cursor <= anchor) {
    // cursor at start of selection
    inputContent = (
      <>
        <span className={styles["command-line-text"]} data-start={0}>
          {value.slice(0, cursor)}
        </span>
        <span className={styles["command-line-cursor"]} />
        <span className={styles["command-line-selected"]} data-start={cursor}>
          {value.slice(cursor, anchor)}
        </span>
        <span className={styles["command-line-text"]} data-start={anchor}>
          {value.slice(anchor)}
        </span>
      </>
    );
  } else {
    // cursor at end of selection
    inputContent = (
      <>
        <span className={styles["command-line-text"]} data-start={0}>
          {value.slice(0, anchor)}
        </span>
        <span className={styles["command-line-selected"]} data-start={anchor}>
          {value.slice(anchor, cursor)}
        </span>
        <span className={styles["command-line-cursor"]} />
        <span className={styles["command-line-text"]} data-start={cursor}>
          {value.slice(cursor)}
        </span>
      </>
    );
  }

  return (
    <div className={cx(styles, "command-line")}>
      <span className={styles["command-line-prompt"]}>{promptLabel}&gt;</span>
      <span ref={inputRef} className={styles["command-line-input"]} onMouseDown={handleMouseDown}>
        {inputContent}
      </span>
    </div>
  );
}
