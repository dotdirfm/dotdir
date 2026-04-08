// .dir extension bootstrap (iframe) using explicit postMessage RPC.
//
// Host ↔ iframe protocol:
// - iframe -> host: `ext:call`, `ext:subscribe`, `ext:unsubscribe`
// - iframe -> host: `ext:registerCommand`
// - host -> iframe: `host:reply`, `host:callback`, `host:runCommand`
// - iframe -> host: `ext:commandResult`

function postToHost(msg) {
  try {
    window.parent?.postMessage(msg, "*");
  } catch {}
}

function applyThemeVars(themeVars) {
  if (!themeVars || typeof themeVars !== "object") return;
  for (const [k, v] of Object.entries(themeVars)) {
    if (typeof k === "string" && k.startsWith("--") && typeof v === "string") {
      document.documentElement.style.setProperty(k, v);
    }
  }
}

function detectModuleFormat(url) {
  if (/\.iife\.js(?:\?|$)/i.test(url)) return "iife";
  if (/\.mjs(?:\?|$)/i.test(url)) return "esm";
  return "cjs";
}

function loadExtensionApiIife(scriptUrl) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Extension ready timed out (10s)")), 10000);
    window.__dotdirHostReady = (api) => {
      clearTimeout(timeout);
      delete window.__dotdirHostReady;
      resolve(api);
    };
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.onerror = () => {
      clearTimeout(timeout);
      delete window.__dotdirHostReady;
      reject(new Error("Failed to load extension script"));
    };
    document.head.appendChild(script);
  });
}

function loadExtensionApiCjs(scriptUrl) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Extension ready timed out (10s)")), 10000);
    const mod = { exports: {} };
    window.module = mod;
    window.exports = mod.exports;
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.onload = () => {
      clearTimeout(timeout);
      delete window.module;
      delete window.exports;
      const api = mod.exports && mod.exports.__esModule ? mod.exports.default || mod.exports : mod.exports;
      resolve(api);
    };
    script.onerror = () => {
      clearTimeout(timeout);
      delete window.module;
      delete window.exports;
      reject(new Error("Failed to load extension script"));
    };
    document.head.appendChild(script);
  });
}

function loadExtensionApiEsm(scriptUrl, scriptText) {
  // Prefer loading the real extension URL so relative imports resolve against
  // the extension directory. Keep the blob fallback for environments where the
  // direct module import is rejected by the sandbox/custom protocol setup.
  return import(/* @vite-ignore */ scriptUrl).then(
    function (mod) {
      return mod.default || mod;
    },
    function (directErr) {
      if (typeof scriptText !== "string") {
        throw directErr;
      }
      var blob = new Blob([scriptText], { type: "application/javascript" });
      var blobUrl = URL.createObjectURL(blob);
      return import(/* @vite-ignore */ blobUrl).then(
        function (mod) {
          URL.revokeObjectURL(blobUrl);
          return mod.default || mod;
        },
        function (blobErr) {
          URL.revokeObjectURL(blobUrl);
          throw blobErr;
        },
      );
    },
  );
}

function loadExtensionApi(scriptUrl, scriptText) {
  var format = detectModuleFormat(scriptUrl);
  switch (format) {
    case "esm":
      return loadExtensionApiEsm(scriptUrl, scriptText);
    case "iife":
      return loadExtensionApiIife(scriptUrl);
    case "cjs":
    default:
      return loadExtensionApiCjs(scriptUrl);
  }
}

let hostApi = null;
let extApi = null;
let iframeKind = null;
let keyDownListener = null;
let interactPointerListener = null;
let interactFocusListener = null;
let cachedColorTheme = null;
let lastFilePath = null;
let lastLangId = null;
let lifecycleChain = Promise.resolve();

function serializeErr(err) {
  if (err instanceof Error) return err.stack || err.message || String(err);
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

const root = document.getElementById("root");

// RPC client (iframe -> host)
let rpcSeq = 1;
const pendingCalls = new Map(); // id -> { resolve, reject }
const callbackHandlers = new Map(); // cbId -> (payload?) => void
const commandHandlers = new Map(); // handlerId -> (...args)=>unknown

function uid() {
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function rpcCall(method, args) {
  return new Promise((resolve, reject) => {
    const id = rpcSeq++;
    pendingCalls.set(id, { resolve, reject });
    postToHost({ type: "ext:call", id, method, args });
  });
}

function cleanupIFrameState() {
  try {
    if (keyDownListener) {
      window.removeEventListener("keydown", keyDownListener, true);
      keyDownListener = null;
    }
    if (interactPointerListener) {
      document.removeEventListener("pointerdown", interactPointerListener, true);
      interactPointerListener = null;
    }
    if (interactFocusListener) {
      document.removeEventListener("focusin", interactFocusListener, true);
      interactFocusListener = null;
    }
  } catch {}

  callbackHandlers.clear();
  commandHandlers.clear();
  hostApi = null;
  extApi = null;
  iframeKind = null;
  try {
    delete globalThis.dotdir;
  } catch {}
}

async function mountWithProps(props) {
  if (!extApi || !hostApi) return;
  await extApi.mount(root, props);
}

async function focusExtension() {
  if (!extApi) return;
  try {
    if (typeof extApi.focus === "function") {
      await extApi.focus();
    }
  } catch {}
}

function createDotdirApi() {
  return {
    // File ops
    readFile: (path) => rpcCall("readFile", [path]),
    readFileText: (path) => rpcCall("readFileText", [path]),
    readFileRange: (path, offset, length) => rpcCall("readFileRange", [path, offset, length]),
    statFile: (path) => rpcCall("statFile", [path]),
    writeFile: (path, content) => rpcCall("writeFile", [path, content]),
    setDirty: (dirty) => rpcCall("setDirty", [dirty]),

    // Theme ops
    getTheme: () => rpcCall("getTheme", []),
    // Monaco expects this to be synchronous (no `await` in its call sites).
    getColorTheme: () => cachedColorTheme,
    onThemeChange: (cb) => {
      const cbId = uid();
      callbackHandlers.set(cbId, (payload) => {
        cachedColorTheme = payload ?? null;
        cb(payload);
      });
      postToHost({ type: "ext:subscribe", cbId, method: "onThemeChange", args: [] });
      return () => {
        callbackHandlers.delete(cbId);
        postToHost({ type: "ext:unsubscribe", cbId, method: "onThemeChange" });
      };
    },

    // Viewer/editor lifecycle
    onClose: () => {
      // Fire-and-forget; iframe ignores host reply if no pending call exists.
      postToHost({ type: "ext:call", id: 0, method: "onClose", args: [] });
    },

    // File change subscriptions (viewer)
    onFileChange: (cb) => {
      const cbId = uid();
      callbackHandlers.set(cbId, () => cb());
      postToHost({ type: "ext:subscribe", cbId, method: "onFileChange", args: [] });
      return () => {
        callbackHandlers.delete(cbId);
        postToHost({ type: "ext:unsubscribe", cbId, method: "onFileChange" });
      };
    },

    // Commands (host side)
    executeCommand: (command, args) => rpcCall("executeCommand", [command, args]),

    // VS Code-like commands API (functions remain inside iframe)
    commands: {
      registerCommand: (commandId, handler) => {
        const handlerId = uid();
        commandHandlers.set(handlerId, handler);
        postToHost({ type: "ext:registerCommand", handlerId, commandId });
        return {
          dispose: () => {
            commandHandlers.delete(handlerId);
            postToHost({ type: "ext:unregisterCommand", handlerId });
          },
        };
      },
    },
  };
}

function installInteractForwarding() {
  if (!interactPointerListener) {
    interactPointerListener = () => {
      postToHost({
        type: "dotdir:iframeInteract",
        kind: iframeKind,
        source: "pointerdown",
      });
    };
    document.addEventListener("pointerdown", interactPointerListener, true);
  }

  if (!interactFocusListener) {
    interactFocusListener = () => {
      postToHost({
        type: "dotdir:iframeInteract",
        kind: iframeKind,
        source: "focusin",
      });
    };
    document.addEventListener("focusin", interactFocusListener, true);
  }
}

window.addEventListener("message", async (e) => {
  const data = e?.data;
  if (!data || typeof data !== "object") return;

  try {
    if (data.type === "host:reply") {
      const pending = pendingCalls.get(data.id);
      if (!pending) return;
      pendingCalls.delete(data.id);
      if (data.error) pending.reject(new Error(String(data.error)));
      else pending.resolve(data.result);
      return;
    }

    if (data.type === "host:callback") {
      const cb = callbackHandlers.get(String(data.cbId ?? ""));
      if (cb) cb(data.payload);
      return;
    }

    if (data.type === "host:runCommand") {
      const handler = commandHandlers.get(String(data.handlerId ?? ""));
      const callId = data.callId;
      const args = Array.isArray(data.args) ? data.args : [];
      if (!handler) {
        postToHost({ type: "ext:commandResult", callId, error: "Missing command handler" });
        return;
      }
      try {
        const out = handler(...args);
        await Promise.resolve(out);
        postToHost({ type: "ext:commandResult", callId });
      } catch (err) {
        postToHost({
          type: "ext:commandResult",
          callId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (data.type === "dotdir:themeVars") {
      applyThemeVars(data.themeVars);
      return;
    }

    if (data.type === "dotdir:init") {
      lifecycleChain = lifecycleChain.then(async () => {
        iframeKind = data.kind ?? null;
        applyThemeVars(data.themeVars);

        // Global API for extensions: `dotdir.*`
        cachedColorTheme = data.colorTheme ?? null;
        hostApi = createDotdirApi();
        globalThis.dotdir = hostApi;

        extApi = await loadExtensionApi(data.entryUrl, data.entryScript);

        if (data.props && typeof data.props === "object") {
          lastFilePath = data.props.filePath ?? null;
          lastLangId = data.props.langId ?? null;
        }

        // Forward keydowns to the host frame for command keybindings.
        if (!keyDownListener) {
          keyDownListener = (ev) => {
            try {
              if (iframeKind === "viewer" && ev.key === "Tab" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
                ev.preventDefault();
                ev.stopPropagation();
              }
              postToHost({
                type: "dotdir:iframeKeyDown",
                kind: iframeKind,
                key: ev.key,
                ctrlKey: !!ev.ctrlKey,
                metaKey: !!ev.metaKey,
                altKey: !!ev.altKey,
                shiftKey: !!ev.shiftKey,
                repeat: !!ev.repeat,
              });
            } catch {}
          };
          window.addEventListener("keydown", keyDownListener, true);
        }

        installInteractForwarding();

        await mountWithProps(data.props);
        postToHost({ type: "dotdir:ready" });
      });
      await lifecycleChain;
      return;
    }

    if (data.type === "dotdir:update") {
      lifecycleChain = lifecycleChain.then(async () => {
        if (!extApi || !data.props || typeof data.props !== "object") return;

        const nextFilePath = data.props.filePath ?? null;
        const nextLangId = data.props.langId ?? null;

        // Empty filePath means the host is hiding this container — unmount to clear content.
        if (!nextFilePath) {
          if (lastFilePath) {
            try {
              await extApi.unmount?.();
            } catch {}
            lastFilePath = null;
          }
          return;
        }

        if (iframeKind === "editor") {
          if (nextFilePath !== lastFilePath) {
            await mountWithProps(data.props);
            lastFilePath = nextFilePath;
          } else if (nextLangId && nextLangId !== lastLangId) {
            try {
              extApi.setLanguage?.(nextLangId);
            } catch {}
          }
          lastLangId = nextLangId;
          return;
        }

        // viewer
        if (nextFilePath !== lastFilePath) {
          await mountWithProps(data.props);
          lastFilePath = nextFilePath;
        }
      });

      await lifecycleChain;
      return;
    }

    if (data.type === "dotdir:focus") {
      lifecycleChain = lifecycleChain.then(async () => {
        await focusExtension();
      });
      await lifecycleChain;
      return;
    }

    if (data.type === "dotdir:dispose") {
      if (extApi?.unmount) await extApi.unmount();
      cleanupIFrameState();
      return;
    }
  } catch (err) {
    postToHost({ type: "dotdir:error", message: serializeErr(err) });
  }
});

// Tell the host we are ready to receive `dotdir:init`.
postToHost({ type: "dotdir:bootstrap-ready" });

window.addEventListener("beforeunload", () => {
  try {
    extApi?.unmount?.();
  } catch {}
});
