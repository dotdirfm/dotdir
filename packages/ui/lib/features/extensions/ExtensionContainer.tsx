/**
 * ExtensionContainer
 *
 * Loads viewer/editor extensions inside an iframe (VFS origin) and bridges HostApi via postMessage RPC.
 */

import type { Bridge } from "@/features/bridge";
import { useBridge } from "@/features/bridge/useBridge";
import { useCommandRegistry } from "@/features/commands/commands";
import { loadFsProvider } from "@/features/extensions/browserFsProvider";
import type { ColorThemeData, DotDirCommandsApi, DotDirGlobalApi, EditorProps, HostApi, ViewerProps } from "@/features/extensions/extensionApi";
import { registerMountedExtensionCommandHandler } from "@/features/extensions/extensionCommandHandlers";
import { readFileText as readFileTextFromFs } from "@/features/file-system/fs";
import { useVfsUrlResolver } from "@/features/file-system/vfs";
import { useLanguageRegistry } from "@/features/languages/languageRegistry";
import { getActiveColorThemeData, onColorThemeChange } from "@/features/themes/vscodeColorTheme";
import { useFocusContext, useManagedFocusLayer } from "@/focusContext";
import styles from "@/styles/viewers.module.css";
import { isContainerPath, parseContainerPath } from "@/utils/containerPath";
import { basename, dirname, join, normalizePath } from "@/utils/path";
import { getStyleHostElement } from "@/utils/styleHost";
import { isBuiltInExtensionDirPath, useFsProviderRegistry } from "@/viewerEditorRegistry";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

const LazyFileViewerSurface = lazy(async () => {
  const mod = await import("@/features/extensions/builtins/FileViewerSurface");
  return { default: mod.FileViewerSurface };
});

const LazyMonacoEditorSurface = lazy(async () => {
  const mod = await import("@/features/extensions/builtins/MonacoEditorSurface");
  return { default: mod.MonacoEditorSurface };
});

// ── Container props ─────────────────────────────────────────────────────

interface ExtensionContainerProps {
  contributionId?: string;
  extensionDirPath: string;
  entry: string;
  active?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onClose: () => void;
  onExecuteCommand?: (command: string, args?: unknown) => Promise<unknown>;
  inlineFocusMode?: "panel-first" | "viewer-first";
  onTabBackToPanel?: () => void;
  onInteract?: () => void;
}

interface ViewerContainerProps extends ExtensionContainerProps {
  kind: "viewer";
  props: ViewerProps;
}

interface EditorContainerProps extends ExtensionContainerProps {
  kind: "editor";
  props: EditorProps;
  onDirtyChange?: (dirty: boolean) => void;
}

export type ContainerProps = ViewerContainerProps | EditorContainerProps;

/** Read a byte range from a file inside a container (e.g. ZIP) via the fsProvider. */
async function readFromContainer(
  bridge: Bridge,
  fsProviderRegistry: ReturnType<typeof useFsProviderRegistry>,
  path: string,
  offset: number,
  length: number,
): Promise<ArrayBuffer> {
  const { containerFile: hostFile, innerPath } = parseContainerPath(path);
  const match = fsProviderRegistry.resolve(basename(hostFile));
  if (!match) throw new Error(`No fsProvider registered for "${basename(hostFile)}"`);
  if (match.contribution.runtime === "backend" && bridge.fsProvider) {
    const wasmPath = join(match.extensionDirPath, match.contribution.entry);
    return bridge.fsProvider.readFileRange(wasmPath, hostFile, innerPath, offset, length);
  }
  const provider = await loadFsProvider(bridge, match.extensionDirPath, match.contribution.entry);
  if (!provider.readFileRange) throw new Error("Provider does not support readFileRange");
  return provider.readFileRange(hostFile, innerPath, offset, length);
}

function resolveBuiltInSurface(kind: ContainerProps["kind"], extensionDirPath: string, contributionId?: string) {
  if (!isBuiltInExtensionDirPath(extensionDirPath)) return null;
  if (kind === "viewer" && contributionId === "file-viewer") {
    return LazyFileViewerSurface;
  }
  if (kind === "editor" && contributionId === "monaco") {
    return LazyMonacoEditorSurface;
  }
  return null;
}

function BuiltInExtensionContainer(containerProps: ContainerProps) {
  const BuiltInSurface = resolveBuiltInSurface(containerProps.kind, containerProps.extensionDirPath, containerProps.contributionId);
  const { kind, props, className, style, active } = containerProps;
  const bridge = useBridge();
  const fsProviderRegistry = useFsProviderRegistry();
  const currentFileRef = useRef<{ fd: number; size: number; path: string } | null>(null);
  const currentFilePathRef = useRef<string | null>(null);
  const onCloseRef = useRef(containerProps.onClose);
  onCloseRef.current = containerProps.onClose;
  const onInteractRef = useRef(containerProps.onInteract);
  onInteractRef.current = containerProps.onInteract;
  const onExecuteCommandRef = useRef(containerProps.kind === "viewer" ? containerProps.onExecuteCommand : undefined);
  if (containerProps.kind === "viewer") {
    onExecuteCommandRef.current = containerProps.onExecuteCommand;
  }
  const onDirtyChangeRef = useRef(containerProps.kind === "editor" ? containerProps.onDirtyChange : undefined);
  if (containerProps.kind === "editor") {
    onDirtyChangeRef.current = containerProps.onDirtyChange;
  }

  useEffect(() => {
    currentFilePathRef.current = kind === "viewer" ? (props as ViewerProps).filePath : (props as EditorProps).filePath;
  }, [kind, props]);

  useEffect(() => {
    if (active !== false) return;
    const current = currentFileRef.current;
    if (!current) return;
    void bridge.fs.close(current.fd).catch(() => {});
    currentFileRef.current = null;
  }, [active, bridge.fs]);

  useEffect(() => {
    return () => {
      const current = currentFileRef.current;
      if (!current) return;
      void bridge.fs.close(current.fd).catch(() => {});
      currentFileRef.current = null;
    };
  }, [bridge.fs]);

  const buildHostApi = useCallback(
    (): HostApi => ({
      async readFile(path: string): Promise<ArrayBuffer> {
        const normalized = normalizePath(path);
        if (isContainerPath(normalized)) return readFromContainer(bridge, fsProviderRegistry, normalized, 0, 64 * 1024 * 1024);
        return bridge.fs.readFile(normalized);
      },
      async readFileRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
        const normalized = normalizePath(path);
        if (isContainerPath(normalized)) return readFromContainer(bridge, fsProviderRegistry, normalized, offset, length);
        const current = currentFileRef.current;
        let target = current;
        if (!target || target.path !== normalized) {
          if (current) {
            try {
              await bridge.fs.close(current.fd);
            } catch {
              // ignore close errors
            }
          }
          const fd = await bridge.fs.open(normalized);
          const stat = await bridge.fs.stat(normalized);
          target = { fd, size: stat.size, path: normalized };
          currentFileRef.current = target;
        }
        const safeOffset = Math.max(0, Math.floor(offset));
        const maxLen = Math.max(0, Math.floor(length));
        const remaining = Math.max(0, target.size - safeOffset);
        const safeLen = Math.min(maxLen, remaining);
        if (safeLen === 0) return new ArrayBuffer(0);
        return bridge.fs.read(target.fd, safeOffset, safeLen);
      },
      async readFileText(path: string): Promise<string> {
        const normalized = normalizePath(path);
        if (isContainerPath(normalized)) {
          const buf = await this.readFile(path);
          return new TextDecoder().decode(buf);
        }
        return readFileTextFromFs(bridge, normalized);
      },
      async statFile(path: string): Promise<{ size: number; mtimeMs: number }> {
        const normalized = normalizePath(path);
        if (isContainerPath(normalized)) {
          const data = await readFromContainer(bridge, fsProviderRegistry, normalized, 0, 64 * 1024 * 1024);
          return { size: data.byteLength, mtimeMs: 0 };
        }
        const stat = await bridge.fs.stat(normalized);
        const current = currentFileRef.current;
        if (current && current.path === normalized && current.size !== stat.size) {
          current.size = stat.size;
        }
        return stat;
      },
      onFileChange(callback: () => void): () => void {
        const filePath = currentFilePathRef.current;
        if (!filePath) return () => {};
        const normalized = normalizePath(filePath);
        const dir = dirname(normalized);
        const name = basename(normalized);
        const watchId = `viewer-${Math.random().toString(36).slice(2)}`;
        let disposed = false;

        const stopFsChange = bridge.fs.onFsChange((event) => {
          if (disposed) return;
          if (event.watchId !== watchId || !event.name) return;
          if (event.name === name && (event.type === "modified" || event.type === "appeared")) {
            const current = currentFileRef.current;
            if (current && current.path === normalized) {
              void bridge.fs.close(current.fd).catch(() => {});
              currentFileRef.current = null;
            }
            callback();
          }
        });

        void (async () => {
          const ok = await bridge.fs.watch(watchId, dir);
          if (!ok) {
            disposed = true;
            stopFsChange();
          }
        })();

        return () => {
          if (disposed) return;
          disposed = true;
          bridge.fs.unwatch(watchId);
          stopFsChange();
        };
      },
      async writeFile(path: string, content: string): Promise<void> {
        await bridge.fs.writeFile(path, content);
      },
      setDirty(dirty: boolean): void {
        onDirtyChangeRef.current?.(dirty);
      },
      async getTheme(): Promise<"light" | "dark"> {
        return bridge.systemTheme.get();
      },
      getColorTheme(): ColorThemeData | null {
        return getActiveColorThemeData();
      },
      onThemeChange(callback: (theme: ColorThemeData) => void): () => void {
        const unsub = onColorThemeChange(callback);
        return () => unsub();
      },
      onClose(): void {
        onCloseRef.current();
      },
      async executeCommand<T = unknown>(command: string, args?: unknown): Promise<T> {
        const handler = onExecuteCommandRef.current;
        if (!handler) throw new Error("No command handler registered");
        return handler(command, args) as Promise<T>;
      },
      async getExtensionResourceUrl(): Promise<string> {
        throw new Error("Extension resource URL not available in built-in surface mode");
      },
    }),
    [bridge, fsProviderRegistry],
  );

  const hostApi = useMemo<DotDirGlobalApi>(() => {
    const base = buildHostApi();
    const commands: DotDirCommandsApi = {
      registerCommand(commandId, handler) {
        const dispose = registerMountedExtensionCommandHandler(commandId, (...args) => handler(...args));
        return { dispose };
      },
    };
    return { ...base, commands };
  }, [buildHostApi]);

  if (!BuiltInSurface) {
    return (
      <div className={className} style={style}>
        Unsupported built-in surface
      </div>
    );
  }

  return (
    <div className={className} style={{ ...style, width: "100%", height: "100%" }}>
      <Suspense
        fallback={
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--fg-muted, #888)",
            }}
          >
            Loading {kind}…
          </div>
        }
      >
        <BuiltInSurface hostApi={hostApi} props={props as never} active={active} onInteract={() => onInteractRef.current?.()} />
      </Suspense>
    </div>
  );
}

export function ExtensionContainer(containerProps: ContainerProps) {
  if (resolveBuiltInSurface(containerProps.kind, containerProps.extensionDirPath, containerProps.contributionId)) {
    return <BuiltInExtensionContainer {...containerProps} />;
  }

  return <IframeExtensionContainer {...containerProps} />;
}

function IframeExtensionContainer(containerProps: ContainerProps) {
  const { extensionDirPath, entry, kind, props, onClose, className, style, active } = containerProps;

  const bridge = useBridge();
  const commandRegistry = useCommandRegistry();
  const fsProviderRegistry = useFsProviderRegistry();
  const focusContext = useFocusContext();
  const resolveVfsUrl = useVfsUrlResolver();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onInteractRef = useRef(containerProps.onInteract);
  onInteractRef.current = containerProps.onInteract;
  const isInline = !!props.inline;
  const shouldAutoFocusIframe = !isInline;
  const inlineFocusMode = containerProps.inlineFocusMode ?? "panel-first";
  const panelFocusElRef = useRef<HTMLElement | null>(null);
  const inlineIframeFocusedRef = useRef(false);
  const autoFocusOnceRef = useRef(false);
  const [mountVersion, setMountVersion] = useState(0);
  const wasActiveRef = useRef(active !== false);

  useEffect(() => {
    if (!isInline) return;
    panelFocusElRef.current = document.activeElement as HTMLElement | null;
    inlineIframeFocusedRef.current = inlineFocusMode === "viewer-first";
    autoFocusOnceRef.current = false;
  }, [focusContext, inlineFocusMode, isInline]);

  useEffect(() => {
    const isActive = active !== false;
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (isInline) return;
    if (!wasActive && isActive) {
      setMountVersion((value) => value + 1);
    }
  }, [active, isInline]);

  // For non-preview viewer/editor, focus iframe automatically when it appears.
  useEffect(() => {
    if (!shouldAutoFocusIframe) return;
    if (loading) return;
    if (autoFocusOnceRef.current) return;
    autoFocusOnceRef.current = true;

    const iframe = iframeRef.current;
    if (!iframe) return;
    // Delay to ensure the iframe content is mounted.
    setTimeout(() => {
      try {
        iframe.focus();
        iframe.contentWindow?.focus?.();
      } catch {
        // ignore
      }
    }, 0);
  }, [shouldAutoFocusIframe, loading]);

  useEffect(() => {
    if (!shouldAutoFocusIframe) return;
    if (loading) return;
    if (active === false) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    const run = () => {
      try {
        iframe.focus();
        iframe.contentWindow?.focus?.();
        iframe.contentWindow?.postMessage({ type: "dotdir:focus" }, "*");
      } catch {
        // ignore
      }
    };

    const frame = requestAnimationFrame(run);
    const t1 = setTimeout(run, 0);
    const t2 = setTimeout(run, 50);
    const t3 = setTimeout(run, 150);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [active, loading, shouldAutoFocusIframe]);

  // Inline/preview viewer: keep panel focused until user presses Tab.
  // First Tab: focus preview iframe + route keybindings via focusViewer.
  // Second Tab: return focus to the panel + route keybindings back.
  useEffect(() => {
    if (!isInline) return;
    if (inlineFocusMode !== "panel-first") return;

    const shouldIgnoreTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName?.toLowerCase();
      const isForm = tag === "input" || tag === "textarea" || tag === "select" || tag === "button" || el.isContentEditable;
      return isForm;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.shiftKey) return; // keep simple: only Tab (not Shift+Tab) toggles per requirement
      if (inlineIframeFocusedRef.current) {
        // When iframe is focused, the iframe forwards keydown handling to the host.
        // Prevent parent keybinding handlers from also acting on this Tab event.
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (focusContext.current !== "panel") return;
      if (shouldIgnoreTarget(e.target)) return;

      e.preventDefault();
      e.stopPropagation();

      inlineIframeFocusedRef.current = true;
      // Route keybindings as if focus is on viewer.
      focusContext.push("viewer");

      try {
        iframeRef.current?.focus();
        iframeRef.current?.contentWindow?.focus?.();
      } catch {
        // ignore
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [focusContext, inlineFocusMode, isInline]);

  // Single open file descriptor per container (viewer/editor).
  // Bound to the currently viewed/edited file and closed on unmount or when file changes.
  const currentFileRef = useRef<{ fd: number; size: number; path: string } | null>(null);
  const currentFilePathRef = useRef<string | null>(null);

  // When hidden: tell the extension to clear its content, then close the file handle.
  useEffect(() => {
    if (active !== false) return;
    const iframe = iframeRef.current;
    if (iframe) {
      const emptyProps = kind === "viewer" ? { filePath: "", fileName: "", fileSize: 0 } : { filePath: "", fileName: "", langId: "plaintext" };
      try {
        iframe.contentWindow?.postMessage({ type: "dotdir:update", props: emptyProps }, "*");
      } catch {
        // ignore
      }
    }
    const current = currentFileRef.current;
    if (current) {
      bridge.fs.close(current.fd).catch(() => {});
      currentFileRef.current = null;
    }
  }, [active, bridge.fs, kind]);

  const onExecuteCommandRef = useRef(containerProps.kind === "viewer" ? containerProps.onExecuteCommand : undefined);
  if (containerProps.kind === "viewer") {
    onExecuteCommandRef.current = containerProps.onExecuteCommand;
  }

  const onDirtyChangeRef = useRef(containerProps.kind === "editor" ? containerProps.onDirtyChange : undefined);
  if (containerProps.kind === "editor") {
    onDirtyChangeRef.current = containerProps.onDirtyChange;
  }

  const buildHostApi = useCallback(
    (): HostApi => ({
      async readFile(path: string): Promise<ArrayBuffer> {
        const normalized = normalizePath(path);
        if (isContainerPath(normalized)) return readFromContainer(bridge, fsProviderRegistry, normalized, 0, 64 * 1024 * 1024);
        return bridge.fs.readFile(normalized);
      },
      async readFileRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
        const normalized = normalizePath(path);
        if (isContainerPath(normalized)) return readFromContainer(bridge, fsProviderRegistry, normalized, offset, length);
        const current = currentFileRef.current;
        let target = current;
        if (!target || target.path !== normalized) {
          if (current) {
            try {
              await bridge.fs.close(current.fd);
            } catch {
              // ignore close errors
            }
          }
          const fd = await bridge.fs.open(normalized);
          const stat = await bridge.fs.stat(normalized);
          target = { fd, size: stat.size, path: normalized };
          currentFileRef.current = target;
        }
        const safeOffset = Math.max(0, Math.floor(offset));
        const maxLen = Math.max(0, Math.floor(length));
        const remaining = Math.max(0, target.size - safeOffset);
        const safeLen = Math.min(maxLen, remaining);
        if (safeLen === 0) return new ArrayBuffer(0);
        return bridge.fs.read(target.fd, safeOffset, safeLen);
      },
      async readFileText(path: string): Promise<string> {
        const normalized = normalizePath(path);
        if (isContainerPath(normalized)) {
          const buf = await this.readFile(path);
          return new TextDecoder().decode(buf);
        }
        return readFileTextFromFs(bridge, normalized);
      },
      async statFile(path: string): Promise<{ size: number; mtimeMs: number }> {
        const normalized = normalizePath(path);
        if (isContainerPath(normalized)) {
          const data = await readFromContainer(bridge, fsProviderRegistry, normalized, 0, 64 * 1024 * 1024);
          return { size: data.byteLength, mtimeMs: 0 };
        }
        const stat = await bridge.fs.stat(normalized);
        const current = currentFileRef.current;
        if (current && current.path === normalized && current.size !== stat.size) {
          current.size = stat.size;
        }
        return stat;
      },
      onFileChange(callback: () => void): () => void {
        const filePath = currentFilePathRef.current;
        if (!filePath) return () => {};
        const normalized = normalizePath(filePath);
        const dir = dirname(normalized);
        const name = basename(normalized);
        const watchId = `viewer-${Math.random().toString(36).slice(2)}`;
        let disposed = false;

        const stopFsChange = bridge.fs.onFsChange((event) => {
          if (disposed) return;
          if (event.watchId !== watchId || !event.name) return;
          if (event.name === name && (event.type === "modified" || event.type === "appeared")) {
            const current = currentFileRef.current;
            if (current && current.path === normalized) {
              void bridge.fs.close(current.fd).catch(() => {});
              currentFileRef.current = null;
            }
            callback();
          }
        });

        void (async () => {
          const ok = await bridge.fs.watch(watchId, dir);
          if (!ok) {
            disposed = true;
            stopFsChange();
          }
        })();

        return () => {
          if (disposed) return;
          disposed = true;
          bridge.fs.unwatch(watchId);
          stopFsChange();
        };
      },
      async writeFile(path: string, content: string): Promise<void> {
        await bridge.fs.writeFile(path, content);
      },
      setDirty(dirty: boolean): void {
        onDirtyChangeRef.current?.(dirty);
      },
      async getTheme(): Promise<"light" | "dark"> {
        return bridge.systemTheme.get();
      },
      getColorTheme(): ColorThemeData | null {
        return getActiveColorThemeData();
      },
      onThemeChange(callback: (theme: ColorThemeData) => void): () => void {
        const unsub = onColorThemeChange(callback);
        return () => unsub();
      },
      onClose(): void {
        onCloseRef.current();
      },
      async executeCommand<T = unknown>(command: string, args?: unknown): Promise<T> {
        const handler = onExecuteCommandRef.current;
        if (!handler) throw new Error(`No command handler registered`);
        return handler(command, args) as Promise<T>;
      },

      async getExtensionResourceUrl(relativePath: string): Promise<string> {
        const safe = normalizePath(relativePath).replace(/^\/+/, "");
        if (safe.includes("..")) throw new Error("Invalid extension resource path");
        // Extensions run in host; no VFS base URL. Could add bridge to read and return blob URL if needed.
        throw new Error("Extension resource URL not available in mount-point mode");
      },
    }),
    [bridge, fsProviderRegistry],
  );
  const buildHostApiRef = useRef(buildHostApi);
  buildHostApiRef.current = buildHostApi;

  const getThemeVars = useCallback((): Record<string, string> => {
    const out: Record<string, string> = {};
    // Copy all CSS custom properties from the host document into the iframe.
    // This keeps extensions compatible with existing `var(--bg)` styling.
    try {
      const cs = getComputedStyle(getStyleHostElement());
      for (let i = 0; i < cs.length; i++) {
        const name = cs[i];
        if (!name || !name.startsWith("--")) continue;
        const val = cs.getPropertyValue(name);
        if (val) out[name] = val.trim();
      }
    } catch {
      // ignore
    }
    return out;
  }, []);
  const getThemeVarsRef = useRef(getThemeVars);
  getThemeVarsRef.current = getThemeVars;

  useEffect(() => {
    let cancelled = false;
    const iframe = iframeRef.current;
    if (!iframe) return;

    setLoading(true);
    setError(null);

    const hostApi = buildHostApiRef.current();
    const iframeWin = iframe.contentWindow;
    if (!iframeWin) return;

    const entryRel = normalizePath(entry.replace(/^\.\//, "")) || "index.js";
    const entryPath = join(extensionDirPath, entryRel);
    const entryUrl = resolveVfsUrl(entryPath);

    // postMessage RPC state
    let nextCallId = 1;
    const pendingCommandCalls = new Map<number, { resolve: () => void; reject: (err: unknown) => void }>();
    const rpcSubscriptions = new Map<string, () => void>(); // cbId -> disposer()
    const extensionCommandDisposers = new Map<string, () => void>(); // handlerId -> disposer()

    const handleMessage = (ev: MessageEvent) => {
      if (ev.source !== iframeWin) return;
      const data = ev.data as any;
      if (!data || typeof data !== "object") return;

      if (data.type === "ext:commandResult") {
        const callId = Number(data.callId);
        const pending = pendingCommandCalls.get(callId);
        if (!pending) return;
        pendingCommandCalls.delete(callId);
        if (data.error) pending.reject(new Error(String(data.error)));
        else pending.resolve();
        return;
      }

      if (data.type === "ext:call") {
        const id = data.id;
        const method = String(data.method ?? "");
        const args = Array.isArray(data.args) ? data.args : [];
        (async () => {
          try {
            const fn = (hostApi as any)[method];
            if (typeof fn !== "function") throw new Error(`Host method not found: ${method}`);
            // Important: some hostApi methods (e.g. readFileText) use `this.*`.
            // Extracting the method loses `this`, so we must re-bind it.
            const result = await fn.apply(hostApi, args);
            iframeWin.postMessage({ type: "host:reply", id, result }, "*");
          } catch (err) {
            const msg =
              err instanceof Error
                ? err.message
                : err && typeof err === "object" && "message" in err
                  ? String((err as { message: unknown }).message)
                  : String(err);
            iframeWin.postMessage({ type: "host:reply", id, error: msg }, "*");
          }
        })().catch(() => {});
        return;
      }

      if (data.type === "ext:subscribe") {
        const cbId = String(data.cbId ?? "");
        const method = String(data.method ?? "");
        if (!cbId) return;
        if (rpcSubscriptions.has(cbId)) return;
        if (method === "onFileChange") {
          if (!hostApi.onFileChange) return;
          const disposer = hostApi.onFileChange(() => {
            try {
              iframeWin.postMessage({ type: "host:callback", cbId }, "*");
            } catch {
              // ignore
            }
          });
          rpcSubscriptions.set(cbId, disposer);
          return;
        }
        if (method === "onThemeChange") {
          if (!hostApi.onThemeChange) return;
          const disposer = hostApi.onThemeChange((theme) => {
            try {
              iframeWin.postMessage({ type: "host:callback", cbId, payload: theme }, "*");
            } catch {
              // ignore
            }
          });
          rpcSubscriptions.set(cbId, disposer);
          return;
        }
        // Unknown subscription methods are ignored.
        return;
      }

      if (data.type === "ext:unsubscribe") {
        const cbId = String(data.cbId ?? "");
        const disposer = rpcSubscriptions.get(cbId);
        if (disposer) {
          try {
            disposer();
          } catch {
            // ignore
          }
          rpcSubscriptions.delete(cbId);
        }
        return;
      }

      if (data.type === "ext:registerCommand") {
        const handlerId = String(data.handlerId ?? "");
        const commandId = String(data.commandId ?? "");
        if (!handlerId || !commandId) return;
        if (extensionCommandDisposers.has(handlerId)) return;

        const dispose = registerMountedExtensionCommandHandler(commandId, async (...args: unknown[]) => {
          const callId = nextCallId++;
          await new Promise<void>((resolve, reject) => {
            pendingCommandCalls.set(callId, { resolve, reject });
            iframeWin.postMessage({ type: "host:runCommand", handlerId, callId, args }, "*");
          });
        });
        extensionCommandDisposers.set(handlerId, dispose);
        return;
      }

      if (data.type === "ext:unregisterCommand") {
        const handlerId = String(data.handlerId ?? "");
        const dispose = extensionCommandDisposers.get(handlerId);
        if (dispose) {
          try {
            dispose();
          } catch {
            // ignore
          }
          extensionCommandDisposers.delete(handlerId);
        }
        return;
      }

      if (data.type === "dotdir:bootstrap-ready") {
        init();
      } else if (data.type === "dotdir:ready") {
        if (!cancelled) {
          setLoading(false);
          if (shouldAutoFocusIframe && active !== false) {
            requestAnimationFrame(() => {
              try {
                iframe.focus();
                iframe.contentWindow?.focus?.();
                iframe.contentWindow?.postMessage({ type: "dotdir:focus" }, "*");
              } catch {
                // ignore
              }
            });
          }
        }
      } else if (data.type === "dotdir:error") {
        if (!cancelled) {
          setError(String(data.message ?? "Extension error"));
          setLoading(false);
        }
      } else if (data.type === "dotdir:iframeInteract") {
        onInteractRef.current?.();
      } else if (data.type === "dotdir:iframeKeyDown") {
        try {
          const key = String(data.key ?? "").toLowerCase();
          // Inline/preview viewer tab switching:
          // - Tab while panel-focused (host listener) moves focus into iframe (first Tab)
          // - Tab while iframe-focused (message handler) moves focus back to panel (second Tab)
          if (isInline && key === "tab" && inlineIframeFocusedRef.current) {
            inlineIframeFocusedRef.current = false;
            const tabBackHandler =
              containerProps.kind === "viewer" ? (containerProps as ViewerContainerProps & { onTabBackToPanel?: () => void }).onTabBackToPanel : undefined;
            if (tabBackHandler) {
              tabBackHandler();
              return;
            }
            try {
              focusContext.pop("viewer");
            } catch {
              // ignore
            }
            try {
              panelFocusElRef.current?.focus?.();
            } catch {
              // ignore
            }
            return;
          }

          // When inline preview isn't focused, ignore forwarded keys from the iframe.
          if (isInline && !inlineIframeFocusedRef.current) return;

          const synthetic = {
            key: data.key,
            ctrlKey: !!data.ctrlKey,
            metaKey: !!data.metaKey,
            altKey: !!data.altKey,
            shiftKey: !!data.shiftKey,
            repeat: !!data.repeat,
            preventDefault() {},
            stopPropagation() {},
          } as unknown as KeyboardEvent;
          commandRegistry.handleKeyboardEvent(synthetic);
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener("message", handleMessage);

    // Keep iframe theme vars in sync with host theme changes.
    const pushThemeVars = () => {
      try {
        iframe.contentWindow?.postMessage({ type: "dotdir:themeVars", themeVars: getThemeVarsRef.current() }, "*");
      } catch {
        // ignore
      }
    };
    const stopTheme = onColorThemeChange(() => pushThemeVars());

    let initSent = false;
    const init = async () => {
      if (initSent) return;
      initSent = true;
      // Track current file path for this container (viewer/editor).
      if (kind === "viewer") {
        currentFilePathRef.current = (props as ViewerProps).filePath;
      } else {
        currentFilePathRef.current = (props as EditorProps).filePath;
      }

      // ESM extensions are loaded from their real URL so relative imports can
      // resolve from the extension directory. CJS/IIFE entries still receive
      // their source text because the bootstrap evaluates them directly.
      let entryScript: string | undefined;
      if (!/\.mjs(?:\?|$)/i.test(entryUrl)) {
        try {
          entryScript = await readFileTextFromFs(bridge, entryPath);
        } catch (err) {
          if (!cancelled) {
            const msg =
              err instanceof Error
                ? err.message
                : err && typeof err === "object" && "message" in err
                  ? String((err as { message: unknown }).message)
                  : String(err);
            setError(`Failed to read extension entry: ${msg}`);
            setLoading(false);
          }
          return;
        }
      }

      iframe.contentWindow?.postMessage(
        {
          type: "dotdir:init",
          kind,
          entryUrl,
          entryScript,
          props,
          themeVars: getThemeVarsRef.current(),
          colorTheme: hostApi.getColorTheme?.() ?? null,
        },
        "*",
      );
    };

    // Deterministic handshake:
    // - iframe bootstrap posts `dotdir:bootstrap-ready` when its listener is installed
    // - we respond with `dotdir:init` exactly once via `postMessage` (no MessagePort)
    const onLoad = () => {
      // If the bootstrap-ready message gets lost for any reason, reloading iframe should re-send it.
      // Keep a small fallback: if we never receive dotdir:bootstrap-ready, surface an error.
      setTimeout(() => {
        if (!cancelled && !initSent) {
          setError("Extension bootstrap did not respond");
          setLoading(false);
        }
      }, 3000);
    };
    iframe.addEventListener("load", onLoad);

    return () => {
      cancelled = true;
      window.removeEventListener("message", handleMessage);
      iframe.removeEventListener("load", onLoad);
      stopTheme();
      try {
        iframe.contentWindow?.postMessage({ type: "dotdir:dispose" }, "*");
      } catch {
        // ignore
      }

      // Cleanup extension-level subscriptions/registrations.
      for (const [, dispose] of rpcSubscriptions) {
        try {
          dispose();
        } catch {
          // ignore
        }
      }
      rpcSubscriptions.clear();

      for (const [, dispose] of extensionCommandDisposers) {
        try {
          dispose();
        } catch {
          // ignore
        }
      }
      extensionCommandDisposers.clear();

      pendingCommandCalls.clear();

      const currentFile = currentFileRef.current;
      if (currentFile) {
        bridge.fs.close(currentFile.fd).catch(() => {});
        currentFileRef.current = null;
      }
    };
    // `props` updates are sent via postMessage to avoid unnecessary iframe remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensionDirPath, entry, kind, resolveVfsUrl]);

  // Re-mount when props change (e.g. file path). Skip when inactive.
  // Reset prevProps when hiding so the next activation always sends an update.
  const prevPropsRef = useRef(props);
  useEffect(() => {
    if (active === false) {
      prevPropsRef.current = null as any;
      return;
    }
    const iframe = iframeRef.current;
    if (!iframe || loading || error) return;
    if (prevPropsRef.current === props) return;
    prevPropsRef.current = props;
    if (kind === "viewer") {
      currentFilePathRef.current = (props as ViewerProps).filePath;
    } else {
      currentFilePathRef.current = (props as EditorProps).filePath;
    }
    try {
      iframe.contentWindow?.postMessage({ type: "dotdir:update", props }, "*");
    } catch {
      // ignore
    }
  }, [props, kind, loading, error, active]);

  if (error) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--error-fg, #f44)",
        }}
      >
        Failed to load {kind}: {error}
      </div>
    );
  }

  // Serve extension iframe `index.html` from the `_ext/<bundleDir>` VFS directory
  // that corresponds to the extension entry bundle. This keeps relative asset URLs working.
  const entryRelForIframe = normalizePath(entry.replace(/^\.\//, "")) || "index.js";
  const entryPathForIframe = join(extensionDirPath, entryRelForIframe);
  const entryDirForIframe = dirname(entryPathForIframe);
  const iframeSrc = resolveVfsUrl(entryDirForIframe, "extension-directory");

  return (
    <div className={className} style={{ ...style, position: "relative" }}>
      {loading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-muted, #888)",
          }}
        >
          Loading {kind}…
        </div>
      )}
      {iframeSrc && (
        <iframe
          key={`${kind}:${mountVersion}`}
          ref={iframeRef}
          src={iframeSrc}
          // Chromium/WebView2: loading `vfs://…` as iframe `src` is top navigation to a custom
          // scheme; without this token the sandbox blocks it (Windows).
          sandbox="allow-same-origin allow-scripts allow-top-navigation-to-custom-protocols"
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            display: loading ? "none" : "block",
            background: "transparent",
          }}
          onFocus={() => onInteractRef.current?.()}
          onMouseDown={() => onInteractRef.current?.()}
          title={`${kind} extension`}
        />
      )}
    </div>
  );
}

// ── Convenience wrappers ───────────────────────────────────────────────

interface ViewerContainerWrapperProps {
  contributionId?: string;
  extensionDirPath: string;
  entry: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  stackIndex?: number;
  inline?: boolean;
  inlineFocusMode?: "panel-first" | "viewer-first";
  visible?: boolean;
  onClose: () => void;
  onExecuteCommand?: (command: string, args?: unknown) => Promise<unknown>;
  onTabBackToPanel?: () => void;
  onInteract?: () => void;
}

interface ExtensionShellLayoutProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  inline?: boolean;
  visible: boolean;
  stackIndex?: number;
  inlineClassName: string;
  overlayClassName: string;
  frameClassName: string;
  children: React.ReactNode;
}

function focusSurfaceWithin(root: HTMLElement | null): void {
  if (!root) return;
  const directTarget = root.querySelector<HTMLElement>("[data-dotdir-focus-target='true'], textarea.inputarea, textarea, [contenteditable='true']");
  if (directTarget) {
    const focusNow = () => {
      try {
        directTarget.focus();
      } catch {
        // ignore
      }
    };
    focusNow();
    requestAnimationFrame(focusNow);
    setTimeout(focusNow, 0);
    setTimeout(focusNow, 50);
    return;
  }
  const iframe = root.querySelector("iframe");
  if (!(iframe instanceof HTMLIFrameElement)) return;
  const focusNow = () => {
    try {
      iframe.focus();
      iframe.contentWindow?.focus?.();
      iframe.contentWindow?.postMessage({ type: "dotdir:focus" }, "*");
    } catch {
      // ignore
    }
  };
  focusNow();
  requestAnimationFrame(focusNow);
  setTimeout(focusNow, 0);
  setTimeout(focusNow, 50);
}

function useExtensionSurfaceFocus({
  focusLayer,
  inline,
  isVisible,
  isEditableTarget,
  allowCommandRouting,
}: {
  focusLayer: "viewer" | "editor";
  inline?: boolean;
  isVisible: boolean;
  isEditableTarget?: (node: EventTarget | null) => boolean;
  allowCommandRouting?: boolean | ((event: KeyboardEvent) => boolean);
}) {
  const focusContext = useFocusContext();
  const containerRef = useRef<HTMLDivElement>(null);

  const restorePanelFocus = useCallback(() => {
    focusContext.restore();
  }, [focusContext]);

  useManagedFocusLayer(focusLayer, !inline && isVisible);

  useEffect(() => {
    if (!isVisible) return;
    const root = containerRef.current;
    if (!root) return;
    return focusContext.registerAdapter(focusLayer, {
      focus() {
        focusSurfaceWithin(root);
      },
      contains(node) {
        return node instanceof Node ? root.contains(node) : false;
      },
      isEditableTarget,
      allowCommandRouting,
    });
  }, [allowCommandRouting, focusContext, focusLayer, isEditableTarget, isVisible]);

  useEffect(() => {
    if (!inline) return;
    if (isVisible) return;
    if (focusContext.is(focusLayer)) {
      focusContext.request("panel");
    }
  }, [focusContext, focusLayer, inline, isVisible]);

  return { containerRef, restorePanelFocus };
}

function ExtensionShellLayout({
  containerRef,
  inline,
  visible,
  stackIndex = 0,
  inlineClassName,
  overlayClassName,
  frameClassName,
  children,
}: ExtensionShellLayoutProps) {
  if (inline) {
    return (
      <div
        ref={containerRef}
        className={inlineClassName}
        style={{ display: "flex", flexDirection: "column", height: "100%", padding: 0 }}
      >
        {children}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={overlayClassName} style={{ display: visible ? "flex" : "none", zIndex: 200 + stackIndex * 10 }}>
      <div className={frameClassName} style={{ display: "flex", flexDirection: "column", padding: 0 }}>
        {children}
      </div>
    </div>
  );
}

export function ViewerContainer({
  contributionId,
  extensionDirPath,
  entry,
  filePath,
  fileName,
  fileSize,
  stackIndex = 0,
  inline,
  inlineFocusMode = "panel-first",
  visible,
  onClose,
  onExecuteCommand,
  onTabBackToPanel,
  onInteract,
}: ViewerContainerWrapperProps) {
  const isVisible = visible ?? true;
  const focusContext = useFocusContext();
  const { containerRef, restorePanelFocus } = useExtensionSurfaceFocus({
    focusLayer: "viewer",
    inline,
    isVisible,
    allowCommandRouting(event) {
      return event.ctrlKey || event.metaKey || event.altKey || /^F\d{1,2}$/.test(event.key) || event.key === "Escape";
    },
  });
  const handleClose = useCallback(() => {
    onClose();
    restorePanelFocus();
  }, [onClose, restorePanelFocus]);

  // Keep props identity stable across app rerenders (e.g. opening command palette),
  // so the iframe doesn't get a `dotdir:update` and remount/reload the extension.
  const viewerProps: ViewerProps = useMemo(() => ({ filePath, fileName, fileSize, inline }), [filePath, fileName, fileSize, inline]);

  useEffect(() => {
    if (!inline) return;
    if (!isVisible) return;
    if (inlineFocusMode !== "viewer-first") return;
    const frame = requestAnimationFrame(() => {
      focusContext.request("viewer");
    });
    return () => cancelAnimationFrame(frame);
  }, [focusContext, inline, inlineFocusMode, isVisible]);

  useEffect(() => {
    if (!inline) return;
    if (isVisible) return;
    if (focusContext.is("viewer")) {
      focusContext.request("panel");
    }
  }, [focusContext, inline, isVisible]);

  useEffect(() => {
    return () => {
      if (inline && focusContext.is("viewer")) {
        focusContext.request("panel");
      }
    };
  }, [focusContext, inline]);

  const toolbarHeight = 38;
  const toolbar = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderBottom: "1px solid var(--border, #333)",
        flexShrink: 0,
        minHeight: toolbarHeight,
        boxSizing: "border-box",
      }}
    >
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={fileName}>
        {fileName}
      </span>
      <button
        type="button"
        title="Close (Esc)"
        onClick={handleClose}
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontSize: 18,
          padding: "0 8px",
          flexShrink: 0,
          color: "inherit",
        }}
        aria-label="Close"
      >
        ×
      </button>
    </div>
  );

  const container = (
    <ExtensionContainer
      kind="viewer"
      contributionId={contributionId}
      extensionDirPath={extensionDirPath}
      entry={entry}
      props={viewerProps}
      active={isVisible}
      onClose={handleClose}
      onExecuteCommand={onExecuteCommand}
      inlineFocusMode={inlineFocusMode}
      onTabBackToPanel={onTabBackToPanel}
      onInteract={onInteract}
      style={{ width: "100%", height: "100%" }}
    />
  );
  return (
    <ExtensionShellLayout
      containerRef={containerRef}
      inline={inline}
      visible={isVisible}
      inlineClassName={styles["file-viewer-inline"]}
      overlayClassName={styles["file-viewer-overlay"]}
      frameClassName={styles["file-viewer"]}
      stackIndex={stackIndex}
    >
      {!inline && toolbar}
      <div style={{ flex: 1, minHeight: 0 }}>{container}</div>
    </ExtensionShellLayout>
  );
}

interface EditorContainerWrapperProps {
  contributionId?: string;
  extensionDirPath: string;
  entry: string;
  filePath: string;
  fileName: string;
  langId: string;
  stackIndex?: number;
  inline?: boolean;
  visible?: boolean;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  languages?: EditorProps["languages"];
  grammars?: EditorProps["grammars"];
  onInteract?: () => void;
}

export function EditorContainer({
  contributionId,
  extensionDirPath,
  entry,
  filePath,
  fileName,
  langId,
  stackIndex = 0,
  inline,
  visible,
  onClose,
  onDirtyChange,
  onInteract,
}: EditorContainerWrapperProps) {
  const languageRegistry = useLanguageRegistry();
  const languages = languageRegistry.languages;
  const grammars = languageRegistry.grammarRefs;
  const [currentLangId, setCurrentLangId] = useState(langId);
  const isVisible = visible ?? true;
  const { containerRef, restorePanelFocus } = useExtensionSurfaceFocus({
    focusLayer: "editor",
    inline,
    isVisible,
    isEditableTarget(node) {
      const el = node as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName?.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
    },
    allowCommandRouting(event) {
      const isMonacoEditorWidgetTarget = (node: EventTarget | null) => {
        const el = node as HTMLElement | null;
        return Boolean(el?.closest?.(".editor-widget"));
      };
      // When Monaco's suggest widget is open, keyboard focus stays in the
      // editor textarea — not in the widget — so the `.editor-widget` check
      // above doesn't apply. If we let the command router handle the event in
      // that case, Escape closes the editor and arrow keys move the cursor,
      // instead of dismissing/navigating the suggestion list the way Monaco
      // natively does. We explicitly carve those keys out here.
      const isSuggestWidgetOpen = (): boolean => {
        const widgets = document.querySelectorAll<HTMLElement>(".suggest-widget");
        for (const w of widgets) {
          if (w.classList.contains("visible")) return true;
          if (w.offsetParent !== null && w.getBoundingClientRect().height > 0) return true;
        }
        return false;
      };
      const isEditorNavigationKey =
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "ArrowLeft" ||
        event.key === "ArrowRight" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "PageUp" ||
        event.key === "PageDown";
      if (event.key === "Escape") {
        if (isMonacoEditorWidgetTarget(event.target) || isMonacoEditorWidgetTarget(document.activeElement)) {
          return false;
        }
        if (isSuggestWidgetOpen()) return false;
      }
      if (isEditorNavigationKey) {
        if (isMonacoEditorWidgetTarget(event.target) || isMonacoEditorWidgetTarget(document.activeElement)) {
          return false;
        }
        return true;
      }
      return event.ctrlKey || event.metaKey || event.altKey || /^F\d{1,2}$/.test(event.key) || event.key === "Escape";
    },
  });
  const handleClose = useCallback(() => {
    onClose();
    restorePanelFocus();
  }, [onClose, restorePanelFocus]);

  useEffect(() => {
    setCurrentLangId(langId);
  }, [langId]);

  // Keep props identity stable to avoid unnecessary `dotdir:update`.
  const editorProps: EditorProps = useMemo(
    () => ({
      filePath,
      fileName,
      langId: currentLangId,
      extensionDirPath,
      languages,
      grammars,
      inline: !!inline,
    }),
    [filePath, fileName, currentLangId, extensionDirPath, languages, grammars, inline],
  );

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    setCurrentLangId(next);
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

  const content = (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderBottom: "1px solid var(--border, #333)",
          flexShrink: 0,
          minHeight: 38,
          boxSizing: "border-box",
        }}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={fileName}>
          {fileName}
        </span>
        {showLangSelect && (
          <>
            <label htmlFor="editor-lang-select" style={{ whiteSpace: "nowrap" }}>
              Language:
            </label>
            <select id="editor-lang-select" value={currentLangId} onChange={handleLanguageChange} style={{ minWidth: 120, padding: "2px 6px" }}>
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
          onClick={handleClose}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: 18,
            padding: "0 8px",
            flexShrink: 0,
            color: "inherit",
          }}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ExtensionContainer
          kind="editor"
          contributionId={contributionId}
          extensionDirPath={extensionDirPath}
          entry={entry}
          props={editorProps}
          active={isVisible}
          onClose={handleClose}
          onDirtyChange={onDirtyChange}
          onInteract={onInteract}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </>
  );

  return (
    <ExtensionShellLayout
      containerRef={containerRef}
      inline={inline}
      visible={isVisible}
      inlineClassName={styles["file-viewer-inline"]}
      overlayClassName={styles["file-editor-overlay"]}
      frameClassName={styles["file-editor"]}
      stackIndex={stackIndex}
    >
      {content}
    </ExtensionShellLayout>
  );
}
