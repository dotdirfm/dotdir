import "@dotdirfm/ui/dotdir.css";

import { DotDir } from "@dotdirfm/ui";
import { invoke, isTauri as isTauriApp } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { AccountWidget } from "./components/AccountWidget";
import { tauriBridge } from "./tauriBridge";
import { createWsBridge } from "./wsBridge";

declare global {
  interface Window {
    __dotdirBoot?: (message: string) => void;
  }
}

async function writeBootLog(message: string): Promise<void> {
  window.__dotdirBoot?.(message);
  try {
    if (isTauriApp()) {
      await invoke("debug_log", { message });
    }
  } catch {
    // Ignore logging failures so diagnostics never block startup.
  }
}

async function initBridge() {
  if (isTauriApp()) {
    return tauriBridge;
  } else {
    return await createWsBridge(`ws://${location.host}/ws`);
  }
}

function renderBootError(error: unknown): void {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const pre = document.createElement("pre");
  pre.textContent = `.dir failed to start\n\n${message}`;
  pre.style.whiteSpace = "pre-wrap";
  pre.style.fontFamily = "Consolas, monospace";
  pre.style.fontSize = "14px";
  pre.style.padding = "16px";
  pre.style.margin = "0";
  pre.style.minHeight = "100vh";
  pre.style.background = "#1e1e2e";
  pre.style.color = "#f38ba8";
  document.body.innerHTML = "";
  document.body.appendChild(pre);
}

// Track whether the app has booted successfully
let appBooted = false;

window.addEventListener("error", (event) => {
  void writeBootLog(`window.error: ${String(event.error ?? event.message)}`);
  if (!appBooted) renderBootError(event.error ?? event.message);
  // After boot, let React ErrorBoundary and console handle it
});

window.addEventListener("unhandledrejection", (event) => {
  void writeBootLog(`unhandledrejection: ${String(event.reason)}`);
  if (!appBooted) renderBootError(event.reason);
  // After boot, just log — don't nuke the DOM
});

// Disable native tab navigation — .dir uses its own key handling engine.
const FOCUSABLE =
  'a[href],button,input,select,textarea,dialog,iframe,[tabindex]:not([tabindex="-1"])';
function isInsideDotDir(node: Node | null): boolean {
  return node instanceof Element && !!node.closest(".dotdir-root");
}
function defocusAll(root: ParentNode) {
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (isInsideDotDir(el)) continue;
    el.tabIndex = -1;
  }
}
defocusAll(document);
new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      const el = node as HTMLElement;
      if (isInsideDotDir(el)) continue;
      if (el.matches?.(FOCUSABLE)) el.tabIndex = -1;
      defocusAll(el);
    }
  }
}).observe(document.body, { childList: true, subtree: true });

try {
  await writeBootLog("main.tsx starting");
  const bridge = await initBridge();
  await writeBootLog("bridge initialized");

  const container = document.getElementById("app");
  if (!container) {
    throw new Error("Missing #app root element");
  }

  document.getElementById("boot-status")?.remove();
  const root = createRoot(container);
  root.render(<DotDir bridge={bridge} widget={<AccountWidget />} />);
  appBooted = true;
  await writeBootLog("React render started");
} catch (error) {
  await writeBootLog(`startup catch: ${String(error)}`);
  renderBootError(error);
}
