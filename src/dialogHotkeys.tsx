/**
 * Dialog hotkey system.
 *
 * HotkeyProvider: mount once per dialog; listens for Alt+<char> and dispatches
 * to the registered action.
 *
 * SmartLabel: replace plain label text nodes with <SmartLabel>text</SmartLabel>.
 * It walks up the DOM to find the nearest <button> or <label> ancestor and
 * registers that element's .click() as the action. After assignment, it renders
 * the hotkey character highlighted with the `hotkey-char` CSS class.
 *
 * Assignment algorithm:
 *  - Sort all registered labels by text length ascending (shorter = higher priority).
 *  - For each label, scan left-to-right for the first Unicode letter not yet taken.
 *  - Hotkey is the physical key code (e.g. KeyM → 'm'), so it works regardless
 *    of the OS input language.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { HelpDialog } from './HelpDialog';

interface Registration {
  label: string;
  action: () => void;
}

interface HotkeyContextValue {
  register: (id: string, label: string, action: () => void) => void;
  unregister: (id: string) => void;
  assignments: ReadonlyMap<string, string>;
}

const HotkeyContext = createContext<HotkeyContextValue | null>(null);

function computeAssignments(registrations: Map<string, Registration>): Map<string, string> {
  const sorted = Array.from(registrations.entries()).sort(
    ([, a], [, b]) => a.label.length - b.label.length,
  );
  const used = new Set<string>();
  const result = new Map<string, string>();

  for (const [id, { label }] of sorted) {
    for (const char of label) {
      const lower = char.toLowerCase();
      if (/\p{L}/u.test(lower) && !used.has(lower)) {
        used.add(lower);
        result.set(id, lower);
        break;
      }
    }
  }
  return result;
}

function mapsEqual(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

export function HotkeyProvider({ children, helpText }: { children: ReactNode; helpText?: string }) {
  const registrationsRef = useRef(new Map<string, Registration>());
  const [assignments, setAssignments] = useState<Map<string, string>>(() => new Map());
  const assignmentsRef = useRef(assignments);
  const helpTextRef = useRef(helpText);
  helpTextRef.current = helpText;
  const [showHelp, setShowHelp] = useState(false);
  // Bumped by register/unregister to trigger recompute after children's effects settle.
  const [version, setVersion] = useState(0);

  const register = useCallback((id: string, label: string, action: () => void) => {
    registrationsRef.current.set(id, { label, action });
    setVersion((v) => v + 1);
  }, []);

  const unregister = useCallback((id: string) => {
    registrationsRef.current.delete(id);
    setVersion((v) => v + 1);
  }, []);

  // Children's useLayoutEffects run before the parent's, so by the time this
  // fires, all SmartLabels have already called register().
  useLayoutEffect(() => {
    const next = computeAssignments(registrationsRef.current);
    if (!mapsEqual(next, assignmentsRef.current)) {
      assignmentsRef.current = next;
      setAssignments(next);
    }
  }, [version]);

  // Keyboard handler: F1 for help, Alt+<physical key> for hotkeys.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        if (helpTextRef.current) {
          e.preventDefault();
          e.stopPropagation();
          setShowHelp(true);
        }
        return;
      }

      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      // Use the physical key code so the hotkey works with any OS input language.
      if (!e.code.startsWith('Key')) return;
      const baseKey = e.code.slice(3).toLowerCase(); // 'KeyM' → 'm'

      for (const [id, char] of assignmentsRef.current) {
        if (char === baseKey) {
          const reg = registrationsRef.current.get(id);
          if (reg) {
            e.preventDefault();
            reg.action();
          }
          return;
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []); // refs are stable; no deps needed

  const value = useMemo(
    () => ({ register, unregister, assignments }),
    [register, unregister, assignments],
  );

  return (
    <HotkeyContext.Provider value={value}>
      {children}
      {showHelp && helpText && (
        <HelpDialog content={helpText} onClose={() => setShowHelp(false)} />
      )}
    </HotkeyContext.Provider>
  );
}

/**
 * Drop-in replacement for plain text inside a <button> or <label>.
 * Finds the nearest <button> or <label> ancestor and registers its .click()
 * as the hotkey action. Renders with the assigned character highlighted.
 *
 * Usage:
 *   <button><SmartLabel>Cancel</SmartLabel></button>
 *   <label><input type="checkbox" /> <SmartLabel>Copy permissions</SmartLabel></label>
 *   <label htmlFor="x"><SmartLabel>Folder name</SmartLabel></label>
 */
export function SmartLabel({ children }: { children: string }) {
  const ctx = useContext(HotkeyContext);
  const id = useId();
  const spanRef = useRef<HTMLSpanElement>(null);

  const { register, unregister } = ctx ?? {};

  useLayoutEffect(() => {
    if (!register || !unregister) return;
    const span = spanRef.current;
    if (!span) return;

    // Walk up to the nearest <button> or <label> ancestor.
    let el: HTMLElement | null = span.parentElement;
    while (el && el.tagName !== 'BUTTON' && el.tagName !== 'LABEL') {
      el = el.parentElement;
    }
    if (!el) return;

    const target = el;
    register(id, children, () => target.click());
    return () => unregister(id);
  }, [id, children, register, unregister]);

  const assignedChar = ctx?.assignments.get(id) ?? null;

  if (!assignedChar) {
    return <span ref={spanRef}>{children}</span>;
  }

  // Highlight the first occurrence of the assigned char (case-insensitive).
  const idx = children.toLowerCase().indexOf(assignedChar);
  if (idx < 0) {
    return <span ref={spanRef}>{children}</span>;
  }

  return (
    <span ref={spanRef}>
      {children.slice(0, idx)}
      <span className="hotkey-char">{children[idx]}</span>
      {children.slice(idx + 1)}
    </span>
  );
}
