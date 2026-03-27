/**
 * ExtensionContainer
 *
 * Loads viewer/editor extensions inside an iframe (VFS origin) and bridges HostApi via postMessage RPC.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../bridge";
import { commandRegistry } from "../commands";
import { registerExtensionKeybinding } from "../registerKeybindings";
import { readFileText as readFileTextFromFs } from "../fs";
import { basename, dirname, join, normalizePath } from "../path";
import { vfsUrl } from "../vfs";
import type { HostApi, ColorThemeData, ViewerProps, EditorProps } from "../extensionApi";
import { getActiveColorThemeData, onColorThemeChange } from "../vscodeColorTheme";
import { focusContext } from "../focusContext";
import { isContainerPath, parseContainerPath } from "../containerPath";
import { fsProviderRegistry } from "../viewerEditorRegistry";
import { loadFsProvider } from "../browserFsProvider";

// ── Container props ─────────────────────────────────────────────────────

interface ExtensionContainerProps {
  extensionDirPath: string;
  entry: string;
  active?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

interface ViewerContainerProps extends ExtensionContainerProps {
  kind: "viewer";
  props: ViewerProps;
  onClose: () => void;
  onExecuteCommand?: (command: string, args?: unknown) => Promise<unknown>;
}

interface EditorContainerProps extends ExtensionContainerProps {
  kind: "editor";
  props: EditorProps;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export type ContainerProps = ViewerContainerProps | EditorContainerProps;

/** Read a byte range from a file inside a container (e.g. ZIP) via the fsProvider. */
async function readFromContainer(path: string, offset: number, length: number): Promise<ArrayBuffer> {
  const { containerFile: hostFile, innerPath } = parseContainerPath(path);
  const match = fsProviderRegistry.resolve(basename(hostFile));
  if (!match) throw new Error(`No fsProvider registered for "${basename(hostFile)}"`);
  if (match.contribution.runtime === "backend" && bridge.fsProvider) {
    const wasmPath = join(match.extensionDirPath, match.contribution.entry);
    return bridge.fsProvider.readFileRange(wasmPath, hostFile, innerPath, offset, length);
  }
  const provider = await loadFsProvider(match.extensionDirPath, match.contribution.entry);
  if (!provider.readFileRange) throw new Error("Provider does not support readFileRange");
  return provider.readFileRange(hostFile, innerPath, offset, length);
}

export function ExtensionContainer(containerProps: ContainerProps) {
  const { extensionDirPath, entry, kind, props, onClose, className, style, active } = containerProps;

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const isInlineViewer = kind === "viewer" && !!(props as ViewerProps).inline;
  const shouldAutoFocusIframe = kind === "editor" || (kind === "viewer" && !isInlineViewer);
  const panelFocusElRef = useRef<HTMLElement | null>(null);
  const inlineIframeFocusedRef = useRef(false);
  const autoFocusOnceRef = useRef(false);

  useEffect(() => {
    if (!isInlineViewer) return;
    panelFocusElRef.current = document.activeElement as HTMLElement | null;
    inlineIframeFocusedRef.current = false;
    autoFocusOnceRef.current = false;
  }, [isInlineViewer]);

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

  // Inline/preview viewer: keep panel focused until user presses Tab.
  // First Tab: focus preview iframe + route keybindings via focusViewer.
  // Second Tab: return focus to the panel + route keybindings back.
  useEffect(() => {
    if (!isInlineViewer) return;

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
  }, [isInlineViewer]);

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
        iframe.contentWindow?.postMessage({ type: "faraday:update", props: emptyProps }, "*");
      } catch {
        // ignore
      }
    }
    const current = currentFileRef.current;
    if (current) {
      bridge.fs.close(current.fd).catch(() => {});
      currentFileRef.current = null;
    }
  }, [active, kind]);

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
        if (isContainerPath(normalized)) return readFromContainer(normalized, 0, 64 * 1024 * 1024);
        return bridge.fs.readFile(normalized);
      },
      async readFileRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
        const normalized = normalizePath(path);
        if (isContainerPath(normalized)) return readFromContainer(normalized, offset, length);
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
        return readFileTextFromFs(normalized);
      },
      async statFile(path: string): Promise<{ size: number; mtimeMs: number }> {
        const normalized = normalizePath(path);
        if (isContainerPath(normalized)) {
          const data = await readFromContainer(normalized, 0, 64 * 1024 * 1024);
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
      async getTheme(): Promise<string> {
        return bridge.theme.get();
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

      registerCommand(commandId: string, handler: (...args: unknown[]) => void | Promise<void>): () => void {
        return commandRegistry.registerCommand(commandId, handler);
      },

      registerKeybinding(binding: { command: string; key: string; mac?: string; when?: string }): () => void {
        const dispose = registerExtensionKeybinding(commandRegistry, { command: binding.command, key: binding.key, mac: binding.mac, when: binding.when });
        return dispose;
      },

      async getExtensionResourceUrl(relativePath: string): Promise<string> {
        const safe = normalizePath(relativePath).replace(/^\/+/, "");
        if (safe.includes("..")) throw new Error("Invalid extension resource path");
        // Extensions run in host; no VFS base URL. Could add bridge to read and return blob URL if needed.
        throw new Error("Extension resource URL not available in mount-point mode");
      },
    }),
    [],
  );

  const getThemeVars = useCallback((): Record<string, string> => {
    const out: Record<string, string> = {};
    // Copy all CSS custom properties from the host document into the iframe.
    // This keeps extensions compatible with existing `var(--bg)` styling.
    try {
      const cs = getComputedStyle(document.documentElement);
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

  useEffect(() => {
    let cancelled = false;
    const iframe = iframeRef.current;
    if (!iframe) return;

    setLoading(true);
    setError(null);

    const hostApi = buildHostApi();
    const iframeWin = iframe.contentWindow;
    if (!iframeWin) return;

    const entryRel = normalizePath(entry.replace(/^\.\//, "")) || "index.js";
    const entryPath = join(extensionDirPath, entryRel);
    const entryUrl = vfsUrl(entryPath);
    const isEsm = /\.mjs(?:\?|$)/i.test(entryRel);

    // postMessage RPC state
    let nextCallId = 1;
    const pendingCommandCalls = new Map<number, { resolve: () => void; reject: (err: unknown) => void }>();
    const rpcSubscriptions = new Map<string, () => void>(); // cbId -> disposer()
    const extensionCommandDisposers = new Map<string, () => void>(); // handlerId -> disposer()
    const extensionKeybindingDisposers = new Map<string, () => void>(); // bindingId -> disposer()

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

        const dispose = commandRegistry.registerCommand(commandId, async (...args: unknown[]) => {
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

      if (data.type === "ext:registerKeybinding") {
        const bindingId = String(data.bindingId ?? "");
        const binding = data.binding;
        if (!bindingId || !binding || typeof binding !== "object") return;
        if (extensionKeybindingDisposers.has(bindingId)) return;

        const dispose = registerExtensionKeybinding(commandRegistry, { command: binding.command, key: binding.key, mac: binding.mac, when: binding.when });
        extensionKeybindingDisposers.set(bindingId, dispose);
        return;
      }

      if (data.type === "ext:unregisterKeybinding") {
        const bindingId = String(data.bindingId ?? "");
        const dispose = extensionKeybindingDisposers.get(bindingId);
        if (dispose) {
          try {
            dispose();
          } catch {
            // ignore
          }
          extensionKeybindingDisposers.delete(bindingId);
        }
        return;
      }

      if (data.type === "faraday:bootstrap-ready") {
        init();
      } else if (data.type === "faraday:ready") {
        if (!cancelled) setLoading(false);
      } else if (data.type === "faraday:error") {
        if (!cancelled) {
          setError(String(data.message ?? "Extension error"));
          setLoading(false);
        }
      } else if (data.type === "faraday:iframeKeyDown") {
        try {
          const key = String(data.key ?? "").toLowerCase();
          // Inline/preview viewer tab switching:
          // - Tab while panel-focused (host listener) moves focus into iframe (first Tab)
          // - Tab while iframe-focused (message handler) moves focus back to panel (second Tab)
          if (isInlineViewer && key === "tab" && inlineIframeFocusedRef.current) {
            inlineIframeFocusedRef.current = false;
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
          if (isInlineViewer && !inlineIframeFocusedRef.current) return;

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
        iframe.contentWindow?.postMessage({ type: "faraday:themeVars", themeVars: getThemeVars() }, "*");
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

      // ESM: the sandboxed iframe (no allow-same-origin) can't import() cross-origin
      // URLs, so we read the script content and send it via postMessage. The bootstrap
      // creates a local blob URL and import()s it.
      let entryScript: string | undefined;
      if (isEsm) {
        try {
          entryScript = await readFileTextFromFs(entryPath);
        } catch (err) {
          if (!cancelled) {
            const msg =
              err instanceof Error
                ? err.message
                : err && typeof err === "object" && "message" in err
                  ? String((err as { message: unknown }).message)
                  : String(err);
            setError(`Failed to read ESM entry: ${msg}`);
            setLoading(false);
          }
          return;
        }
      }

      iframe.contentWindow?.postMessage(
        {
          type: "faraday:init",
          kind,
          entryUrl,
          entryScript,
          props,
          themeVars: getThemeVars(),
          colorTheme: hostApi.getColorTheme?.() ?? null,
        },
        "*",
      );
    };

    // Deterministic handshake:
    // - iframe bootstrap posts `faraday:bootstrap-ready` when its listener is installed
    // - we respond with `faraday:init` exactly once via `postMessage` (no MessagePort)
    const onLoad = () => {
      // If the bootstrap-ready message gets lost for any reason, reloading iframe should re-send it.
      // Keep a small fallback: if we never receive bootstrap-ready, surface an error.
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
        iframe.contentWindow?.postMessage({ type: "faraday:dispose" }, "*");
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

      for (const [, dispose] of extensionKeybindingDisposers) {
        try {
          dispose();
        } catch {
          // ignore
        }
      }
      extensionKeybindingDisposers.clear();

      pendingCommandCalls.clear();

      const currentFile = currentFileRef.current;
      if (currentFile) {
        bridge.fs.close(currentFile.fd).catch(() => {});
        currentFileRef.current = null;
      }
    };
  }, [extensionDirPath, entry, kind, buildHostApi, getThemeVars]); // intentionally exclude props

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
      iframe.contentWindow?.postMessage({ type: "faraday:update", props }, "*");
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

  // Serve extension iframe `index.html` from the same `_ext/<bundleDir>/` VFS directory
  // as the extension entry bundle. This keeps relative asset URLs working.
  const entryRelForIframe = normalizePath(entry.replace(/^\.\//, "")) || "index.js";
  const entryPathForIframe = join(extensionDirPath, entryRelForIframe);
  const entryDirForIframe = dirname(entryPathForIframe);
  // Must keep `_ext/` and the Windows drive root separate: `/_ext` + `C:/...` → `_extC:` (broken).
  const iframeSrc = vfsUrl(`/_ext/${entryDirForIframe.replace(/^\//, "")}/`);

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
          ref={iframeRef}
          src={iframeSrc}
          // Chromium/WebView2: loading `vfs://…` as iframe `src` is top navigation to a custom
          // scheme; without this token the sandbox blocks it (Windows).
          sandbox="allow-scripts allow-top-navigation-to-custom-protocols"
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            display: loading ? "none" : "block",
            background: "transparent",
          }}
          title={`${kind} extension`}
        />
      )}
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
  visible?: boolean;
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
  visible,
  onClose,
  onExecuteCommand,
}: ViewerContainerWrapperProps) {
  const focusPushedRef = useRef(false);
  const isVisible = visible ?? true;

  // Manage focus context for non-inline overlay mode.
  useEffect(() => {
    if (inline) return;
    if (isVisible) {
      if (!focusPushedRef.current) {
        focusContext.push("viewer");
        focusPushedRef.current = true;
      }
    } else {
      if (focusPushedRef.current) {
        try {
          focusContext.pop("viewer");
        } catch {
          /* ignore */
        }
        focusPushedRef.current = false;
      }
    }
  }, [inline, isVisible]);

  // Cleanup focus context on unmount.
  useEffect(() => {
    return () => {
      if (focusPushedRef.current) {
        try {
          focusContext.pop("viewer");
        } catch {
          /* ignore */
        }
        focusPushedRef.current = false;
      }
    };
  }, []);

  // Keep props identity stable across app rerenders (e.g. opening command palette),
  // so the iframe doesn't get a `faraday:update` and remount/reload the extension.
  const viewerProps: ViewerProps = useMemo(() => ({ filePath, fileName, fileSize, inline }), [filePath, fileName, fileSize, inline]);

  const toolbarHeight = 38;
  const toolbar = (
    <div
      className="extension-dialog-toolbar"
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
        onClick={onClose}
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
      extensionDirPath={extensionDirPath}
      entry={entry}
      props={viewerProps}
      active={isVisible}
      onClose={onClose}
      onExecuteCommand={onExecuteCommand}
      className="extension-viewer-frame"
      style={{ width: "100%", height: "100%" }}
    />
  );

  if (inline) {
    return (
      <div className="file-viewer file-viewer-inline" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ flex: 1, minHeight: 0 }}>{container}</div>
      </div>
    );
  }

  return (
    <div className="file-viewer-overlay" style={{ display: isVisible ? "flex" : "none" }}>
      <div className="file-viewer" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
        {toolbar}
        <div style={{ flex: 1, minHeight: 0 }}>{container}</div>
      </div>
    </div>
  );
}

interface EditorContainerWrapperProps {
  extensionDirPath: string;
  entry: string;
  filePath: string;
  fileName: string;
  langId: string;
  visible?: boolean;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  languages?: EditorProps["languages"];
  grammars?: EditorProps["grammars"];
}

export function EditorContainer({
  extensionDirPath,
  entry,
  filePath,
  fileName,
  langId,
  visible,
  onClose,
  onDirtyChange,
  languages,
  grammars,
}: EditorContainerWrapperProps) {
  const [currentLangId, setCurrentLangId] = useState(langId);
  const focusPushedRef = useRef(false);
  const isVisible = visible ?? true;

  useEffect(() => {
    setCurrentLangId(langId);
  }, [langId]);

  // Manage focus context for overlay mode.
  useEffect(() => {
    if (isVisible) {
      if (!focusPushedRef.current) {
        focusContext.push("editor");
        focusPushedRef.current = true;
      }
    } else {
      if (focusPushedRef.current) {
        try {
          focusContext.pop("editor");
        } catch {
          /* ignore */
        }
        focusPushedRef.current = false;
      }
    }
  }, [isVisible]);

  // Cleanup focus context on unmount.
  useEffect(() => {
    return () => {
      if (focusPushedRef.current) {
        try {
          focusContext.pop("editor");
        } catch {
          /* ignore */
        }
        focusPushedRef.current = false;
      }
    };
  }, []);

  // Keep props identity stable to avoid unnecessary `faraday:update`.
  const editorProps: EditorProps = useMemo(
    () => ({
      filePath,
      fileName,
      langId: currentLangId,
      extensionDirPath,
      languages,
      grammars,
      inline: false,
    }),
    [filePath, fileName, currentLangId, extensionDirPath, languages, grammars],
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

  return (
    <div className="file-editor-overlay" style={{ display: isVisible ? "flex" : "none" }}>
      <div className="file-editor" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
        <div
          className="extension-dialog-toolbar"
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
            onClick={onClose}
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
            extensionDirPath={extensionDirPath}
            entry={entry}
            props={editorProps}
            active={isVisible}
            onClose={onClose}
            onDirtyChange={onDirtyChange}
            className="extension-editor-frame"
            style={{ width: "100%", height: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}
