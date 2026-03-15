/**
 * ExtensionContainer
 *
 * Loads an extension entry JS file, creates a sandboxed iframe with a host-generated
 * shell HTML, and establishes two-way Comlink RPC between the host and the iframe.
 */

import * as Comlink from 'comlink';
import type { Remote } from 'comlink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileHandle } from './fsa';
import { bridge } from './bridge';
import { join, basename } from './path';
import type {
  HostApi,
  ViewerExtensionApi,
  EditorExtensionApi,
  ViewerProps,
  EditorProps,
  MediaFileRef,
} from './extensionApi';
import { focusContext } from './focusContext';
import {
  getCachedEditorExtension,
  takeCachedEditorExtension,
  stashEditorExtension,
} from './editorExtensionCache';

// Oniguruma WASM for TextMate grammars in editor extensions (Vite ?url emits asset URL)
import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';

// ── Comlink UMD source (inlined into shell HTML) ─────────────────────

let comlinkUmdSource: string | null = null;

async function getComlinkSource(): Promise<string> {
  if (comlinkUmdSource) return comlinkUmdSource;
  try {
    const mod = await import('comlink/dist/umd/comlink.min.js?raw');
    const src = typeof mod.default === 'string' ? mod.default : '';
    if (!src || src.length < 100) {
      throw new Error('Comlink UMD source missing or too short');
    }
    comlinkUmdSource = src;
  } catch (e) {
    console.error('[ExtensionContainer] Failed to load Comlink UMD:', e);
    throw new Error('Failed to load Comlink for extension iframe');
  }
  return comlinkUmdSource;
}

// ── Shell HTML template ──────────────────────────────────────────────

/** Build shell HTML with no inline scripts (CSP-compliant when script-src uses hashes). */
function buildShellHtml(
  bootstrapScriptUrl: string,
  comlinkScriptUrl: string,
  entryScriptUrl: string,
  themeClass: string,
  handshakeId: string,
): string {
  const safeId = handshakeId.replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
  }
  body.faraday-dark { background: #1e1e1e; color: #ccc; }
  body.faraday-light { background: #fff; color: #333; }
</style>
</head>
<body class="${themeClass}" data-handshake-id="${safeId}">
<script src="${bootstrapScriptUrl}"><\/script>
<script src="${comlinkScriptUrl}"><\/script>
<script src="${entryScriptUrl}"><\/script>
</body>
</html>`;
}

// ── Read extension entry JS via bridge ───────────────────────────────

async function readEntryScript(extensionDirPath: string, entry: string): Promise<string> {
  const entryPath = join(extensionDirPath, entry);
  const name = basename(entryPath);
  const handle = new FileHandle(entryPath, name);
  const file = await handle.getFile();
  return file.text();
}

// ── Shared props ─────────────────────────────────────────────────────

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
  onNavigateMedia?: (file: MediaFileRef) => void;
}

interface EditorContainerProps extends ExtensionContainerProps {
  kind: 'editor';
  props: EditorProps;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Called when the editor extension is ready (after first mount). Use to e.g. call setLanguage. */
  onEditorReady?: (api: Remote<EditorExtensionApi>) => void;
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

  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const extensionApiRef = useRef<Remote<ViewerExtensionApi> | Remote<EditorExtensionApi> | null>(null);
  const scriptBlobUrlRef = useRef<string | null>(null);
  const htmlBlobUrlRef = useRef<string | null>(null);
  const bootstrapBlobUrlRef = useRef<string | null>(null);
  const comlinkBlobUrlRef = useRef<string | null>(null);
  /** Captured when editor is ready so cleanup can stash even if React has already nulled refs on unmount. */
  const editorStashPayloadRef = useRef<{
    iframe: HTMLIFrameElement;
    api: Remote<EditorExtensionApi>;
    scriptUrl: string;
    htmlUrl: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hasCachedEditor =
    kind === 'editor' && !!getCachedEditorExtension(extensionDirPath, entry);

  const onNavigateMediaRef = useRef(
    containerProps.kind === 'viewer' ? containerProps.onNavigateMedia : undefined,
  );
  if (containerProps.kind === 'viewer') {
    onNavigateMediaRef.current = containerProps.onNavigateMedia;
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

  const cleanup = useCallback(() => {
    if (scriptBlobUrlRef.current) {
      URL.revokeObjectURL(scriptBlobUrlRef.current);
      scriptBlobUrlRef.current = null;
    }
    if (htmlBlobUrlRef.current) {
      URL.revokeObjectURL(htmlBlobUrlRef.current);
      htmlBlobUrlRef.current = null;
    }
    if (bootstrapBlobUrlRef.current) {
      URL.revokeObjectURL(bootstrapBlobUrlRef.current);
      bootstrapBlobUrlRef.current = null;
    }
    if (comlinkBlobUrlRef.current) {
      URL.revokeObjectURL(comlinkBlobUrlRef.current);
      comlinkBlobUrlRef.current = null;
    }
    extensionApiRef.current = null;
  }, []);

  useEffect(() => {
    editorStashPayloadRef.current = null;
    let cached: { iframe: HTMLIFrameElement; scriptUrl: string; htmlUrl: string } | null = null;
    if (kind === 'editor' && hasCachedEditor) {
      const taken = takeCachedEditorExtension(extensionDirPath, entry);
      if (taken) {
        cached = { iframe: taken.iframe, scriptUrl: taken.scriptUrl, htmlUrl: taken.htmlUrl };
        const container = containerRef.current;
        if (container) {
          container.appendChild(cached.iframe);
          iframeRef.current = cached.iframe;
          scriptBlobUrlRef.current = cached.scriptUrl;
        }
      }
    }

    let cancelled = false;
    const abortCtrl = new AbortController();

    (async () => {
      try {
        let scriptUrl: string;
        let iframe: HTMLIFrameElement | null;

        if (cached) {
          scriptUrl = cached.scriptUrl;
          iframe = iframeRef.current;
          if (!iframe) return;
        } else {
          const jsContent = await readEntryScript(extensionDirPath, entry);
          if (cancelled) return;
          const scriptBlob = new Blob([jsContent], { type: 'application/javascript' });
          scriptUrl = URL.createObjectURL(scriptBlob);
          scriptBlobUrlRef.current = scriptUrl;
          if (cancelled) return;
          iframe = iframeRef.current;
          if (!iframe) return;
        }

        const [theme, comlinkSrc] = await Promise.all([
          bridge.theme.get(),
          getComlinkSource(),
        ]);
        if (cancelled) return;
        const themeClass = theme === 'light' || theme === 'high-contrast-light'
          ? 'faraday-light'
          : 'faraday-dark';
        const handshakeId = `faraday-${crypto.randomUUID()}`;
        const bootstrapScript = "window.__faradayHandshakeId=(document.body&&document.body.getAttribute('data-handshake-id'))||window.name||'';";
        const bootstrapBlob = new Blob([bootstrapScript], { type: 'application/javascript' });
        const bootstrapUrl = URL.createObjectURL(bootstrapBlob);
        bootstrapBlobUrlRef.current = bootstrapUrl;
        const comlinkBlob = new Blob([comlinkSrc], { type: 'application/javascript' });
        const comlinkUrl = URL.createObjectURL(comlinkBlob);
        comlinkBlobUrlRef.current = comlinkUrl;
        const html = buildShellHtml(bootstrapUrl, comlinkUrl, scriptUrl, themeClass, handshakeId);
        const htmlBlob = new Blob([html], { type: 'text/html' });
        const htmlUrl = URL.createObjectURL(htmlBlob);
        htmlBlobUrlRef.current = htmlUrl;
        if (cached?.htmlUrl) URL.revokeObjectURL(cached.htmlUrl);

        if (cancelled) return;
        if (!iframe) return;
        iframe.name = handshakeId;
        const loadedPromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Extension ready timed out (3s)')),
            3000,
          );
          const handler = (event: MessageEvent) => {
            if (event.data?.handshakeId !== handshakeId) return;
            if (event.data?.type === 'faraday-error') {
              clearTimeout(timeout);
              window.removeEventListener('message', handler);
              reject(new Error(event.data.message || 'Extension error'));
              return;
            }
            if (event.data?.type !== 'faraday-loaded') return;
            clearTimeout(timeout);
            window.removeEventListener('message', handler);
            resolve();
          };
          window.addEventListener('message', handler);
          abortCtrl.signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            window.removeEventListener('message', handler);
            reject(new Error('Aborted'));
          });
        });

        iframe.src = htmlUrl;
        await loadedPromise;
        if (cancelled) return;

        // 5. Build HostApi
        const hostApi: HostApi = {
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
          onClose(): void {
            onCloseRef.current();
          },
          onNavigateMedia(file: MediaFileRef): void {
            onNavigateMediaRef.current?.(file);
          },
          async getOnigurumaWasm(): Promise<ArrayBuffer> {
            const r = await fetch(onigWasmUrl);
            return r.arrayBuffer();
          },
        };

        // 6. Comlink handshake — send port to iframe, receive extension API back
        const { port1, port2 } = new MessageChannel();
        Comlink.expose(hostApi, port1);

        iframe.contentWindow!.postMessage(
          { type: 'faraday-init', port: port2, handshakeId },
          '*',
          [port2],
        );

        // Wait for the iframe to send back its extensionApi port
        const extensionApi = await new Promise<Remote<ViewerExtensionApi> | Remote<EditorExtensionApi>>(
          (resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('Extension handshake timed out (5s)')),
              5000,
            );
            const handler = (event: MessageEvent) => {
              if (event.data?.handshakeId !== handshakeId) return;
              if (event.data?.type === 'faraday-error') {
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                reject(new Error(event.data.message || 'Extension error'));
                return;
              }
              if (event.data?.type !== 'faraday-ready') return;
              clearTimeout(timeout);
              window.removeEventListener('message', handler);
              const extPort: MessagePort = event.data.port;
              if (kind === 'viewer') {
                resolve(Comlink.wrap<ViewerExtensionApi>(extPort));
              } else {
                resolve(Comlink.wrap<EditorExtensionApi>(extPort));
              }
            };
            window.addEventListener('message', handler);
            abortCtrl.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              window.removeEventListener('message', handler);
              reject(new Error('Aborted'));
            });
          },
        );
        if (cancelled) return;

        extensionApiRef.current = extensionApi;
        if (kind === 'editor' && iframeRef.current && scriptBlobUrlRef.current && htmlBlobUrlRef.current) {
          editorStashPayloadRef.current = {
            iframe: iframeRef.current,
            api: extensionApi as Remote<EditorExtensionApi>,
            scriptUrl: scriptBlobUrlRef.current,
            htmlUrl: htmlBlobUrlRef.current,
          };
        }

        // 7. Call mount
        if (kind === 'viewer') {
          await (extensionApi as Remote<ViewerExtensionApi>).mount(props as ViewerProps);
        } else {
          await (extensionApi as Remote<EditorExtensionApi>).mount(props as EditorProps);
          onEditorReadyRef.current?.(extensionApi as Remote<EditorExtensionApi>);
        }

        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      abortCtrl.abort();
      const payload = kind === 'editor' ? editorStashPayloadRef.current : null;
      if (payload) {
        payload.iframe.remove();
        stashEditorExtension(
          extensionDirPath,
          entry,
          payload.iframe,
          payload.api,
          payload.scriptUrl,
          payload.htmlUrl,
        );
        editorStashPayloadRef.current = null;
        scriptBlobUrlRef.current = null;
        htmlBlobUrlRef.current = null;
        extensionApiRef.current = null;
        iframeRef.current = null;
        if (bootstrapBlobUrlRef.current) {
          URL.revokeObjectURL(bootstrapBlobUrlRef.current);
          bootstrapBlobUrlRef.current = null;
        }
        if (comlinkBlobUrlRef.current) {
          URL.revokeObjectURL(comlinkBlobUrlRef.current);
          comlinkBlobUrlRef.current = null;
        }
      } else {
        const api = extensionApiRef.current;
        if (api) api.unmount().catch(() => {});
        cleanup();
      }
    };
  }, [extensionDirPath, entry, kind, cleanup]); // intentionally exclude `props`

  // Re-mount when props change (file path changed) without recreating the iframe
  const prevPropsRef = useRef(props);
  useEffect(() => {
    const api = extensionApiRef.current;
    if (!api || loading || error) return;
    if (prevPropsRef.current === props) return;
    prevPropsRef.current = props;

    if (kind === 'viewer') {
      (api as Remote<ViewerExtensionApi>).mount(props as ViewerProps).catch(() => {});
    } else {
      (api as Remote<EditorExtensionApi>).mount(props as EditorProps).catch(() => {});
    }
  }, [props, kind, loading, error]);

  if (error) {
    return (
      <div className={className} style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--error-fg, #f44)' }}>
        Failed to load {kind}: {error}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ ...style, position: 'relative' }}
    >
      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted, #888)' }}>
          Loading {kind}…
        </div>
      )}
      {!hasCachedEditor && (
        <iframe
          ref={iframeRef}
          style={{ width: '100%', height: '100%', border: 'none', display: loading ? 'none' : 'block' }}
          sandbox="allow-scripts allow-same-origin"
          tabIndex={kind === 'viewer' && (props as ViewerProps).inline ? -1 : 0}
        />
      )}
    </div>
  );
}

// ── Convenience wrappers ─────────────────────────────────────────────

interface ViewerContainerWrapperProps {
  extensionDirPath: string;
  entry: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  inline?: boolean;
  mediaFiles?: MediaFileRef[];
  onClose: () => void;
  onNavigateMedia?: (file: MediaFileRef) => void;
}

export function ViewerContainer({
  extensionDirPath,
  entry,
  filePath,
  fileName,
  fileSize,
  inline,
  mediaFiles,
  onClose,
  onNavigateMedia,
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

  const viewerProps: ViewerProps = { filePath, fileName, fileSize, inline, mediaFiles };

  const toolbarHeight = 38;
  const toolbar = (
    <div className="extension-dialog-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border, #333)', flexShrink: 0, minHeight: toolbarHeight, boxSizing: 'border-box' }}>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fileName}>{fileName}</span>
      <button
        type="button"
        title="Close (Esc)"
        onClick={inline ? onClose : () => dialogRef.current?.close()}
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 18, padding: '0 8px', flexShrink: 0 }}
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
      onNavigateMedia={onNavigateMedia}
      className="extension-viewer-frame"
      style={{ width: '100%', height: '100%' }}
    />
  );

  if (inline) {
    return (
      <div className="file-viewer file-viewer-inline" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {toolbar}
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
  /** All languages from loaded extensions (for custom grammars). */
  languages?: EditorProps['languages'];
  /** All grammars with content from loaded extensions (for TextMate tokenization). */
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
  const editorApiRef = useRef<Remote<EditorExtensionApi> | null>(null);
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

  // Deduplicate by lang.id so we don't get duplicate keys (e.g. "xml" from multiple extensions)
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

  const toolbarHeight = 38;

  return (
    <dialog ref={dialogRef} className="file-editor" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
      <div className="extension-dialog-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border, #333)', flexShrink: 0, minHeight: toolbarHeight, boxSizing: 'border-box' }}>
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
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 18, padding: '0 8px', flexShrink: 0 }}
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
