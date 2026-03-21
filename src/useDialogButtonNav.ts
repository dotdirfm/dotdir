import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * Arrow-key navigation between buttons inside a dialog.
 * Left/Right arrows cycle focus; the default button is focused on mount.
 */
export function useDialogButtonNav(
  containerRef: RefObject<HTMLElement | null>,
  opts?: { defaultIndex?: number },
) {
  const ready = useRef(false);

  useEffect(() => {
    // Focus the default button after the dialog is mounted and visible.
    // We use rAF to run after showModal() has finished its own focus logic.
    const id = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const buttons = container.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      const idx = opts?.defaultIndex ?? -1;
      const target = idx >= 0 && idx < buttons.length ? buttons[idx] : buttons[buttons.length - 1];
      target?.focus();
      ready.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, [containerRef, opts?.defaultIndex]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // Don't steal arrows from text inputs, textareas, or selects.
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement
      ) return;
      const container = containerRef.current;
      if (!container) return;

      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      if (buttons.length === 0) return;

      const idx = buttons.indexOf(active as HTMLButtonElement);

      let next: number;
      if (e.key === 'ArrowLeft') {
        next = idx <= 0 ? buttons.length - 1 : idx - 1;
      } else {
        next = idx >= buttons.length - 1 ? 0 : idx + 1;
      }

      buttons[next].focus();
      e.preventDefault();
    },
    [containerRef],
  );

  return { onKeyDown };
}
