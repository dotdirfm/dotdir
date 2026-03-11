import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view';
import { history, historyKeymap } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput } from '@codemirror/language';
import { lineNumbers } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { FileHandle } from './fsa';
import { bridge } from './bridge';

interface FileEditorProps {
  filePath: string;
  fileName: string;
  langId: string;
  onClose: () => void;
}

function getLanguageExtensions(langId: string): Extension | null {
  switch (langId) {
    case 'javascript':
    case 'javascriptreact':
      return javascript({ jsx: true, typescript: false });
    case 'typescript':
    case 'typescriptreact':
      return javascript({ jsx: true, typescript: true });
    case 'json':
    case 'jsonc':
    case 'json5':
      return json();
    case 'html':
      return html();
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return css();
    case 'markdown':
      return markdown();
    case 'python':
      return python();
    case 'rust':
      return rust();
    case 'sql':
    case 'kql':
      return sql();
    case 'yaml':
      return yaml();
    case 'xml':
    case 'xsl':
    case 'xquery':
      return xml();
    default:
      return null;
  }
}

export function FileEditor({ filePath, fileName, langId, onClose }: FileEditorProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  const languageExtension = useMemo<Extension | null>(() => getLanguageExtensions(langId), [langId]);

  useEffect(() => {
    const handle = new FileHandle(filePath, fileName);
    handle
      .getFile()
      .then((file) => file.text())
      .then((text) => {
        setContent(text);
      })
      .catch(() => {
        setContent('');
      });
  }, [filePath, fileName]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  useEffect(() => {
    if (content === null) return;
    if (!editorHostRef.current) return;

    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    const save = async (): Promise<boolean> => {
      const view = viewRef.current;
      if (!view) return false;
      try {
        const text = view.state.doc.toString();
        await bridge.fsa.writeFile(filePath, text);
        dirtyRef.current = false;
        return true;
      } catch (err) {
        console.error('Failed to save file', err);
        return false;
      }
    };

    const isDark =
      typeof document !== 'undefined' ? document.documentElement.dataset.theme !== 'light' : true;

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      highlightActiveLine(),
      highlightSelectionMatches(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          dirtyRef.current = true;
        }
      }),
      keymap.of([
        {
          key: 'F2',
          run: () => {
            void save();
            return true;
          },
        },
        {
          key: 'Escape',
          run: () => {
            if (!dirtyRef.current) {
              dialogRef.current?.close();
              return true;
            }
            const shouldSave = window.confirm('Save changes before closing?');
            if (shouldSave) {
              void save().then((ok) => {
                if (ok) dialogRef.current?.close();
              });
            } else {
              dialogRef.current?.close();
            }
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      EditorView.theme(
        {
          '&': {
            backgroundColor: 'var(--bg)',
            color: 'var(--fg)',
            height: '100%',
          },
          '.cm-scroller': {
            fontFamily: 'monospace',
            fontSize: '13px',
          },
          '.cm-content': {
            caretColor: 'var(--fg)',
          },
          '.cm-cursor': {
            borderLeftColor: 'var(--fg)',
          },
          '&.cm-focused .cm-cursor': {
            borderLeftColor: 'var(--fg)',
          },
          '.cm-gutters': {
            backgroundColor: 'var(--bg-secondary)',
            borderRight: '1px solid var(--border)',
            color: 'var(--fg-secondary)',
          },
          '.cm-selectionBackground': {
            backgroundColor: isDark ? 'rgba(148, 163, 184, 0.35)' : 'rgba(37, 99, 235, 0.25)',
          },
          '&.cm-focused .cm-selectionBackground': {
            backgroundColor: isDark ? 'rgba(148, 163, 184, 0.45)' : 'rgba(37, 99, 235, 0.35)',
          },
        },
        { dark: isDark },
      ),
      bracketMatching(),
    ];

    if (languageExtension) {
      extensions.push(languageExtension);
    }

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorHostRef.current,
    });

    viewRef.current = view;
    view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [content, languageExtension]);

  return (
    <dialog
      ref={dialogRef}
      className="file-editor"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="file-editor-header">
        <span style={{ flex: 1 }}>{fileName}</span>
        {langId && <span style={{ marginLeft: 12 }}>{langId}</span>}
      </div>
      <div className="file-editor-body">
        <div ref={editorHostRef} className="file-editor-editor" />
      </div>
    </dialog>
  );
}

