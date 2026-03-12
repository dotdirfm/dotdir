import './index.css';

import { invoke, isTauri as isTauriApp } from '@tauri-apps/api/core';
import { initBridge } from './bridge';
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { App } from './app';

declare global {
  interface Window {
    __faradayBoot?: (message: string) => void;
  }
}

async function writeBootLog(message: string): Promise<void> {
  window.__faradayBoot?.(message);
  try {
    if (isTauriApp()) {
      await invoke('debug_log', { message });
    }
  } catch {
    // Ignore logging failures so diagnostics never block startup.
  }
}

function renderBootError(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const pre = document.createElement('pre');
  pre.textContent = `Faraday failed to start\n\n${message}`;
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.fontFamily = 'Consolas, monospace';
  pre.style.fontSize = '14px';
  pre.style.padding = '16px';
  pre.style.margin = '0';
  pre.style.minHeight = '100vh';
  pre.style.background = '#1e1e2e';
  pre.style.color = '#f38ba8';
  document.body.innerHTML = '';
  document.body.appendChild(pre);
}

window.addEventListener('error', (event) => {
  void writeBootLog(`window.error: ${String(event.error ?? event.message)}`);
  renderBootError(event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  void writeBootLog(`unhandledrejection: ${String(event.reason)}`);
  renderBootError(event.reason);
});

try {
  await writeBootLog('main.tsx starting');
  await initBridge();
  await writeBootLog('bridge initialized');

  const container = document.getElementById('app');
  if (!container) {
    throw new Error('Missing #app root element');
  }

  document.getElementById('boot-status')?.remove();
  const root = createRoot(container);
  root.render(createElement(App));
  await writeBootLog('React render started');
} catch (error) {
  await writeBootLog(`startup catch: ${String(error)}`);
  renderBootError(error);
}
