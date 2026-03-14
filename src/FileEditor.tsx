import { useEffect, useRef, useState, useCallback } from 'react';
import * as monaco from 'monaco-editor';
import { FileHandle } from './fsa';
import { bridge } from './bridge';
import { focusContext } from './focusContext';
import { languageRegistry } from './languageRegistry';

function getAvailableLanguages(): { id: string; name: string }[] {
  const langs = monaco.languages.getLanguages();
  return langs
    .map(l => ({ id: l.id, name: l.aliases?.[0] ?? l.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

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
  const [currentLangId, setCurrentLangId] = useState(langId);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const dirtyRef = useRef(false);

  const handleLanguageChange = useCallback((newLangId: string) => {
    setCurrentLangId(newLangId);
    setShowLangPicker(false);
    if (editorRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        monaco.editor.setModelLanguage(model, newLangId);
      }
    }
  }, []);

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
    focusContext.push('editor');
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('close', handleClose);
      focusContext.pop('editor');
    };
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

    // Use the currentLangId; Monaco will only highlight if a grammar is registered
    const monacoLangId = languageRegistry.hasGrammar(currentLangId) ? currentLangId : currentLangId;

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
  }, [content, currentLangId, filePath]);

  const availableLanguages = getAvailableLanguages();

  return (
    <dialog
      ref={dialogRef}
      className="file-editor"
    >
      <div className="file-editor-header">
        <span style={{ flex: 1 }}>{fileName}</span>
        <button
          className="lang-picker-btn"
          onClick={() => setShowLangPicker(!showLangPicker)}
          title="Change language"
        >
          {currentLangId}
        </button>
        {showLangPicker && (
          <div className="lang-picker-dropdown">
            {availableLanguages.map(lang => (
              <div
                key={lang.id}
                className={`lang-picker-item${lang.id === currentLangId ? ' active' : ''}`}
                onClick={() => handleLanguageChange(lang.id)}
              >
                {lang.name}
              </div>
            ))}
          </div>
        )}
        <button
          className="dialog-close-btn"
          onClick={() => dialogRef.current?.close()}
          title="Close (Esc)"
        >
          ×
        </button>
      </div>
      <div className="file-editor-body">
        <div ref={editorHostRef} className="file-editor-editor" />
      </div>
    </dialog>
  );
}
