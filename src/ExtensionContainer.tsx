/**
 * ExtensionContainer
 *
 * Loads an extension entry script in the main window and gives it a mount root.
 * Extension renders into the provided div; no iframes, no Comlink.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileHandle } from './fsa';
import { bridge } from './bridge';
import { basename, normalizePath } from './path';
import { getExtensionScriptUrl } from './extensionLoader';
import type {
  HostApi,
  ColorThemeData,
  ViewerExtensionApi,
  EditorExtensionApi,
  ViewerProps,
  EditorProps,
} from './extensionApi';
import { getActiveColorThemeData, onColorThemeChange } from './vscodeColorTheme';
import { focusContext } from './focusContext';
import {
  getCachedEditorExtension,
  takeCachedEditorExtension,
  setCachedEditorExtension,
} from './editorExtensionCache';

// Oniguruma WASM for TextMate grammars in editor extensions
import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';

// ── Load extension script and get API via __faradayHostReady ─────────────

function loadExtensionApi(scriptUrl: string): Promise<ViewerExtensionApi | EditorExtensionApi> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Extension ready timed out (5s)')),
      5000,
    );
    (window as Window & { __faradayHostReady?: (api: unknown) => void }).__faradayHostReady = (api) => {
      clearTimeout(timeout);
      delete (window as Window & { __faradayHostReady?: (api: unknown) => void }).__faradayHostReady;
      resolve(api as ViewerExtensionApi | EditorExtensionApi);
    };
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.onerror = () => {
      clearTimeout(timeout);
      delete (window as Window & { __faradayHostReady?: (api: unknown) => void }).__faradayHostReady;
      reject(new Error('Failed to load extension script'));
    };
    document.head.appendChild(script);
    script.onload = () => {
      // Script runs synchronously; __faradayHostReady may have been called already
      if (!script.parentNode) return;
      script.remove();
    };
  });
}

// ── Container props ─────────────────────────────────────────────────────

interface ExtensionContainerProps {
  extensionDirPath: string;
  entry: string;
  className?: string;
  style?: React.CSSProperties;
}

interface ViewerContainerProps extends ExtensionContainerProps {
  kind: 'viewer';
  props: ViewerProps;
  onClose: () => void;
  onExecuteCommand?: (command: string, args?: unknown) => Promise<unknown>;
}

interface EditorContainerProps extends ExtensionContainerProps {
  kind: 'editor';
  props: EditorProps;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onEditorReady?: (api: EditorExtensionApi) => void;
}

export type ContainerProps = ViewerContainerProps | EditorContainerProps;

export function ExtensionContainer(containerProps: ContainerProps) {
  const {
    extensionDirPath,
    entry,
    kind,
    props,
    onClose,
    className,
    style,
  } = containerProps;

  const mountRef = useRef<HTMLDivElement | null>(null);
  const extensionApiRef = useRef<ViewerExtensionApi | EditorExtensionApi | null>(null);
  const scriptUrlRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hasCachedEditor =
    kind === 'editor' && !!getCachedEditorExtension(extensionDirPath, entry);

  const onExecuteCommandRef = useRef(
    containerProps.kind === 'viewer' ? containerProps.onExecuteCommand : undefined,
  );
  if (containerProps.kind === 'viewer') {
    onExecuteCommandRef.current = containerProps.onExecuteCommand;
  }

  const onDirtyChangeRef = useRef(
    containerProps.kind === 'editor' ? containerProps.onDirtyChange : undefined,
  );
  const onEditorReadyRef = useRef(
    containerProps.kind === 'editor' ? containerProps.onEditorReady : undefined,
  );
  if (containerProps.kind === 'editor') {
    onDirtyChangeRef.current = containerProps.onDirtyChange;
    onEditorReadyRef.current = containerProps.onEditorReady;
  }

  const buildHostApi = useCallback((): HostApi => ({
    async readFile(path: string): Promise<ArrayBuffer> {
      const handle = new FileHandle(path, basename(path));
      const file = await handle.getFile();
      return file.arrayBuffer();
    },
    async readFileRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
      const handle = new FileHandle(path, basename(path));
      const file = await handle.getFile();
      const slice = file.slice(offset, offset + length);
      return slice.arrayBuffer();
    },
    async readFileText(path: string): Promise<string> {
      const handle = new FileHandle(path, basename(path));
      const file = await handle.getFile();
      return file.text();
    },
    async writeFile(path: string, content: string): Promise<void> {
      await bridge.fsa.writeFile(path, content);
    },
    async getTheme(): Promise<string> {
      return bridge.theme.get();
    },
    getColorTheme(): ColorThemeData | null {
      return getActiveColorThemeData();
    },
    onThemeChange(callback: (theme: ColorThemeData) => void): () => void {
      return onColorThemeChange(callback);
    },
    onClose(): void {
      onCloseRef.current();
    },
    async executeCommand<T = unknown>(command: string, args?: unknown): Promise<T> {
      const handler = onExecuteCommandRef.current;
      if (!handler) throw new Error(`No command handler registered`);
      return handler(command, args) as Promise<T>;
    },
    async getOnigurumaWasm(): Promise<ArrayBuffer> {
      const r = await fetch(onigWasmUrl);
      return r.arrayBuffer();
    },
    async getExtensionResourceUrl(relativePath: string): Promise<string> {
      const safe = normalizePath(relativePath).replace(/^\/+/, '');
      if (safe.includes('..')) throw new Error('Invalid extension resource path');
      // Extensions run in host; no VFS base URL. Could add bridge to read and return blob URL if needed.
      throw new Error('Extension resource URL not available in mount-point mode');
    },
  }), []);

  useEffect(() => {
    const mountEl = mountRef.current;
    if (!mountEl) return;

    let cancelled = false;
    let api: ViewerExtensionApi | EditorExtensionApi | null = null;
    let scriptUrl: string | null = null;

    (async () => {
      try {
        let resolvedApi: ViewerExtensionApi | EditorExtensionApi;

        if (kind === 'editor' && hasCachedEditor) {
          const cached = takeCachedEditorExtension(extensionDirPath, entry);
          if (cached?.api) {
            resolvedApi = cached.api;
            scriptUrl = cached.scriptUrl;
            scriptUrlRef.current = scriptUrl;
          } else {
            const { scriptUrl: url } = await getExtensionScriptUrl(extensionDirPath, entry);
            scriptUrl = url;
            scriptUrlRef.current = url;
            resolvedApi = await loadExtensionApi(url);
          }
        } else {
          const { scriptUrl: url } = await getExtensionScriptUrl(extensionDirPath, entry);
          scriptUrl = url;
          scriptUrlRef.current = url;
          resolvedApi = await loadExtensionApi(url);
        }

        if (cancelled) return;

        api = resolvedApi;
        extensionApiRef.current = api;
        const hostApi = buildHostApi();
        if (kind === 'viewer') {
          await (api as ViewerExtensionApi).mount(mountEl, hostApi, props as ViewerProps);
        } else {
          await (api as EditorExtensionApi).mount(mountEl, hostApi, props as EditorProps);
          onEditorReadyRef.current?.(api as EditorExtensionApi);
        }

        if (!cancelled) setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      const currentApi = extensionApiRef.current;
      const currentScriptUrl = scriptUrlRef.current;
      if (kind === 'editor' && currentApi && currentScriptUrl) {
        (currentApi as EditorExtensionApi).unmount().catch(() => {});
        setCachedEditorExtension(extensionDirPath, entry, { api: currentApi as EditorExtensionApi, scriptUrl: currentScriptUrl });
        extensionApiRef.current = null;
        scriptUrlRef.current = null;
      } else if (currentApi) {
        currentApi.unmount().catch(() => {});
        extensionApiRef.current = null;
      }
      if (scriptUrlRef.current?.startsWith('blob:')) {
        URL.revokeObjectURL(scriptUrlRef.current);
      }
      scriptUrlRef.current = null;
    };
  }, [extensionDirPath, entry, kind, buildHostApi]); // intentionally exclude props

  // Re-mount when props change (e.g. file path)
  const prevPropsRef = useRef(props);
  useEffect(() => {
    const api = extensionApiRef.current;
    const mountEl = mountRef.current;
    if (!api || !mountEl || loading || error) return;
    if (prevPropsRef.current === props) return;
    prevPropsRef.current = props;
    const hostApi = buildHostApi();
    if (kind === 'viewer') {
      (api as ViewerExtensionApi).mount(mountEl, hostApi, props as ViewerProps).catch(() => {});
    } else {
      (api as EditorExtensionApi).mount(mountEl, hostApi, props as EditorProps).catch(() => {});
    }
  }, [props, kind, loading, error, buildHostApi]);

  if (error) {
    return (
      <div className={className} style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--error-fg, #f44)' }}>
        Failed to load {kind}: {error}
      </div>
    );
  }

  return (
    <div className={className} style={{ ...style, position: 'relative' }}>
      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted, #888)' }}>
          Loading {kind}…
        </div>
      )}
      <div
        ref={mountRef}
        style={{
          width: '100%',
          height: '100%',
          minHeight: 0,
          display: loading ? 'none' : 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        tabIndex={kind === 'viewer' && (props as ViewerProps).inline ? -1 : 0}
      />
    </div>
  );
}

// ── Convenience wrappers ───────────────────────────────────────────────

interface ViewerContainerWrapperProps {
  extensionDirPath: string;
  entry: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  inline?: boolean;
  onClose: () => void;
  onExecuteCommand?: (command: string, args?: unknown) => Promise<unknown>;
}

export function ViewerContainer({
  extensionDirPath,
  entry,
  filePath,
  fileName,
  fileSize,
  inline,
  onClose,
  onExecuteCommand,
}: ViewerContainerWrapperProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (inline) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    focusContext.push('viewer');
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('close', handleClose);
      focusContext.pop('viewer');
    };
  }, [inline, onClose]);

  const viewerProps: ViewerProps = { filePath, fileName, fileSize, inline };

  const toolbarHeight = 38;
  const toolbar = (
    <div className="extension-dialog-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border, #333)', flexShrink: 0, minHeight: toolbarHeight, boxSizing: 'border-box' }}>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fileName}>{fileName}</span>
      <button
        type="button"
        title="Close (Esc)"
        onClick={inline ? onClose : () => dialogRef.current?.close()}
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 18, padding: '0 8px', flexShrink: 0, color: 'inherit' }}
        aria-label="Close"
      >
        ×
      </button>
    </div>
  );

  const container = (
    <ExtensionContainer
      kind="viewer"
      extensionDirPath={extensionDirPath}
      entry={entry}
      props={viewerProps}
      onClose={inline ? onClose : () => dialogRef.current?.close()}
      onExecuteCommand={onExecuteCommand}
      className="extension-viewer-frame"
      style={{ width: '100%', height: '100%' }}
    />
  );

  if (inline) {
    return (
      <div className="file-viewer file-viewer-inline" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ flex: 1, minHeight: 0 }}>{container}</div>
      </div>
    );
  }

  return (
    <dialog ref={dialogRef} className="file-viewer" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
      {toolbar}
      <div style={{ flex: 1, minHeight: 0 }}>{container}</div>
    </dialog>
  );
}

interface EditorContainerWrapperProps {
  extensionDirPath: string;
  entry: string;
  filePath: string;
  fileName: string;
  langId: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  languages?: EditorProps['languages'];
  grammars?: EditorProps['grammars'];
}

export function EditorContainer({
  extensionDirPath,
  entry,
  filePath,
  fileName,
  langId,
  onClose,
  onDirtyChange,
  languages,
  grammars,
}: EditorContainerWrapperProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const editorApiRef = useRef<EditorExtensionApi | null>(null);
  const [currentLangId, setCurrentLangId] = useState(langId);

  useEffect(() => {
    setCurrentLangId(langId);
  }, [langId]);

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
      editorApiRef.current = null;
    };
  }, [onClose]);

  const editorProps: EditorProps = { filePath, fileName, langId, extensionDirPath, languages, grammars, inline: false };

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    setCurrentLangId(next);
    const api = editorApiRef.current;
    if (api && typeof api.setLanguage === 'function') api.setLanguage(next);
  };

  const langList = useMemo(() => {
    const list = languages ?? [];
    const seen = new Set<string>();
    return list.filter((lang) => {
      if (seen.has(lang.id)) return false;
      seen.add(lang.id);
      return true;
    });
  }, [languages]);
  const showLangSelect = langList.length > 0;

  return (
    <dialog ref={dialogRef} className="file-editor" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
      <div className="extension-dialog-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border, #333)', flexShrink: 0, minHeight: 38, boxSizing: 'border-box' }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fileName}>{fileName}</span>
        {showLangSelect && (
          <>
            <label htmlFor="editor-lang-select" style={{ whiteSpace: 'nowrap' }}>Language:</label>
            <select
              id="editor-lang-select"
              value={currentLangId}
              onChange={handleLanguageChange}
              style={{ minWidth: 120, padding: '2px 6px' }}
            >
              <option value="plaintext">Plain Text</option>
              {langList.map((lang) => (
                <option key={lang.id} value={lang.id}>
                  {lang.aliases?.[0] ?? lang.id}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          type="button"
          title="Close (Esc)"
          onClick={() => dialogRef.current?.close()}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 18, padding: '0 8px', flexShrink: 0, color: 'inherit' }}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ExtensionContainer
          kind="editor"
          extensionDirPath={extensionDirPath}
          entry={entry}
          props={editorProps}
          onClose={() => dialogRef.current?.close()}
          onDirtyChange={onDirtyChange}
          onEditorReady={(api) => { editorApiRef.current = api; }}
          className="extension-editor-frame"
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </dialog>
  );
}
