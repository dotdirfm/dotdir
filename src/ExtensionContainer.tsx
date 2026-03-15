/**
 * ExtensionContainer
 *
 * Loads an extension entry JS file, creates a sandboxed iframe with a host-generated
 * shell HTML, and establishes two-way Comlink RPC between the host and the iframe.
 */

import * as Comlink from 'comlink';
import type { Remote } from 'comlink';
import { useCallback, useEffect, useRef, useState } from 'react';
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

function buildShellHtml(
  comlinkSrc: string,
  scriptBlobUrl: string,
  themeClass: string,
): string {
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
<body class="${themeClass}">
<script>${comlinkSrc}<\/script>
<script src="${scriptBlobUrl}"><\/script>
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

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const extensionApiRef = useRef<Remote<ViewerExtensionApi> | Remote<EditorExtensionApi> | null>(null);
  const scriptBlobUrlRef = useRef<string | null>(null);
  const htmlBlobUrlRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const onNavigateMediaRef = useRef(
    containerProps.kind === 'viewer' ? containerProps.onNavigateMedia : undefined,
  );
  if (containerProps.kind === 'viewer') {
    onNavigateMediaRef.current = containerProps.onNavigateMedia;
  }

  const onDirtyChangeRef = useRef(
    containerProps.kind === 'editor' ? containerProps.onDirtyChange : undefined,
  );
  if (containerProps.kind === 'editor') {
    onDirtyChangeRef.current = containerProps.onDirtyChange;
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
    extensionApiRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const abortCtrl = new AbortController();

    (async () => {
      try {
        // 1. Read entry JS
        const jsContent = await readEntryScript(extensionDirPath, entry);
        if (cancelled) return;

        // 2. Create script blob
        const scriptBlob = new Blob([jsContent], { type: 'application/javascript' });
        const scriptUrl = URL.createObjectURL(scriptBlob);
        scriptBlobUrlRef.current = scriptUrl;

        // 3. Build shell HTML (with inlined Comlink UMD)
        const [theme, comlinkSrc] = await Promise.all([
          bridge.theme.get(),
          getComlinkSource(),
        ]);
        const themeClass = theme === 'light' || theme === 'high-contrast-light'
          ? 'faraday-light'
          : 'faraday-dark';
        const html = buildShellHtml(comlinkSrc, scriptUrl, themeClass);
        const htmlBlob = new Blob([html], { type: 'text/html' });
        const htmlUrl = URL.createObjectURL(htmlBlob);
        htmlBlobUrlRef.current = htmlUrl;

        if (cancelled) return;

        // 4. Listen for faraday-loaded BEFORE setting src so we don't miss the message
        // (extension posts it as soon as it runs, which is during iframe load).
        const iframe = iframeRef.current;
        if (!iframe) return;

        const loadedPromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Extension ready timed out (3s)')),
            3000,
          );
          const handler = (event: MessageEvent) => {
            if (event.source !== iframe.contentWindow) return;
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
        };

        // 6. Comlink handshake — send port to iframe, receive extension API back
        const { port1, port2 } = new MessageChannel();
        Comlink.expose(hostApi, port1);

        iframe.contentWindow!.postMessage(
          { type: 'faraday-init', port: port2 },
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
              if (event.source !== iframe.contentWindow) return;
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

        // 7. Call mount
        if (kind === 'viewer') {
          await (extensionApi as Remote<ViewerExtensionApi>).mount(props as ViewerProps);
        } else {
          await (extensionApi as Remote<EditorExtensionApi>).mount(props as EditorProps);
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
      const api = extensionApiRef.current;
      if (api) {
        api.unmount().catch(() => {});
      }
      cleanup();
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
    <div className={className} style={{ ...style, position: 'relative' }}>
      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted, #888)' }}>
          Loading {kind}…
        </div>
      )}
      <iframe
        ref={iframeRef}
        style={{ width: '100%', height: '100%', border: 'none', display: loading ? 'none' : 'block' }}
        sandbox="allow-scripts allow-same-origin"
      />
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
    return <div className="file-viewer file-viewer-inline" style={{ display: 'flex', flexDirection: 'column' }}>{container}</div>;
  }

  return (
    <dialog ref={dialogRef} className="file-viewer">
      {container}
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
}

export function EditorContainer({
  extensionDirPath,
  entry,
  filePath,
  fileName,
  langId,
  onClose,
}: EditorContainerWrapperProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

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

  const editorProps: EditorProps = { filePath, fileName, langId };

  return (
    <dialog ref={dialogRef} className="file-editor">
      <ExtensionContainer
        kind="editor"
        extensionDirPath={extensionDirPath}
        entry={entry}
        props={editorProps}
        onClose={() => dialogRef.current?.close()}
        className="extension-editor-frame"
        style={{ width: '100%', height: '100%' }}
      />
    </dialog>
  );
}
