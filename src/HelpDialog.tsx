import { marked } from 'marked';
import { useEffect, useRef } from 'react';
import { focusContext } from './focusContext';

interface HelpDialogProps {
  content: string;
  onClose: () => void;
}

export function HelpDialog({ content, onClose }: HelpDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // Focus the body so arrow/page keys scroll immediately.
    bodyRef.current?.focus();
    focusContext.push('modal');
    return () => { focusContext.pop('modal'); };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'F1') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [onClose]);

  const html = marked.parse(content) as string;

  return (
    <dialog
      ref={dialogRef}
      className="help-dialog"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
    >
      <div className="help-dialog-header">Help</div>
      <div
        ref={bodyRef}
        className="help-dialog-body"
        // tabIndex makes the div focusable so the browser scrolls it with keyboard.
        tabIndex={0}
        // Content is internal static strings — not user-provided.
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div className="help-dialog-buttons">
        <button onClick={onClose}>Close</button>
      </div>
    </dialog>
  );
}
