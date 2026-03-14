import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import { FileHandle } from './fsa';
import { bridge } from './bridge';
import { languageRegistry } from './languageRegistry';

// Configure Monaco editor worker
(self as unknown as Record<string, unknown>).MonacoEnvironment = {
  getWorker: () =>
    new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' },
    ),
};

interface FileEditorProps {
  filePath: string;
  fileName: string;
  langId: string;
  onClose: () => void;
}

export function FileEditor({ filePath, fileName, langId, onClose }: FileEditorProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const dirtyRef = useRef(false);

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

    if (editorRef.current) {
      editorRef.current.dispose();
      editorRef.current = null;
    }

    const isDark =
      typeof document !== 'undefined' ? document.documentElement.dataset.theme !== 'light' : true;

    // Use the langId from detection; Monaco will only highlight if a grammar is registered
    const monacoLangId = languageRegistry.hasGrammar(langId) ? langId : 'plaintext';

    const editor = monaco.editor.create(editorHostRef.current, {
      value: content,
      language: monacoLangId,
      theme: isDark ? 'faraday-dark' : 'faraday-light',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: 'monospace',
      lineNumbers: 'on',
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      tabSize: 4,
      insertSpaces: true,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      scrollbar: {
        verticalScrollbarSize: 14,
        horizontalScrollbarSize: 14,
      },
    });

    editorRef.current = editor;

    // Track dirty state
    editor.onDidChangeModelContent(() => {
      dirtyRef.current = true;
    });

    const save = async (): Promise<boolean> => {
      try {
        const text = editor.getValue();
        await bridge.fsa.writeFile(filePath, text);
        dirtyRef.current = false;
        return true;
      } catch (err) {
        console.error('Failed to save file', err);
        return false;
      }
    };

    // F2 to save
    editor.addAction({
      id: 'faraday.save',
      label: 'Save File',
      keybindings: [monaco.KeyCode.F2],
      run: () => { void save(); },
    });

    // Escape to close (with dirty check)
    editor.addAction({
      id: 'faraday.close',
      label: 'Close Editor',
      keybindings: [monaco.KeyCode.Escape],
      run: () => {
        if (!dirtyRef.current) {
          dialogRef.current?.close();
          return;
        }
        const shouldSave = window.confirm('Save changes before closing?');
        if (shouldSave) {
          void save().then((ok) => {
            if (ok) dialogRef.current?.close();
          });
        } else {
          dialogRef.current?.close();
        }
      },
    });

    editor.focus();

    return () => {
      editor.dispose();
      editorRef.current = null;
    };
  }, [content, langId]);

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
