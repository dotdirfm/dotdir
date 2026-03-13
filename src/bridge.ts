/// Dynamic bridge provider � detects Tauri vs browser and loads the right backend.
///
/// Uses ES module live bindings: importers of `bridge` always see the current value.
/// Must call `initBridge()` before rendering (from main.tsx).
import { isTauri as isTauriApp } from '@tauri-apps/api/core';
import type { FsaRawEntry, FsChangeEvent } from './types';
import { tauriBridge } from './tauriBridge';
import { createWsBridge } from './wsBridge';

export interface Bridge {
  fsa: {
    entries(dirPath: string): Promise<FsaRawEntry[]>;
    stat(filePath: string): Promise<{ size: number; mtimeMs: number }>;
    exists(filePath: string): Promise<boolean>;
    open(filePath: string): Promise<number>;
    read(fd: number, offset: number, length: number): Promise<ArrayBuffer>;
    close(fd: number): Promise<void>;
    watch(watchId: string, dirPath: string): Promise<boolean>;
    unwatch(watchId: string): Promise<void>;
    onFsChange(callback: (event: FsChangeEvent) => void): () => void;
    writeFile(filePath: string, data: string): Promise<void>;
  };
  pty: {
    spawn(cwd: string, cols?: number, rows?: number): Promise<number>;
    write(ptyId: number, data: string): Promise<void>;
    resize(ptyId: number, cols: number, rows: number): Promise<void>;
    close(ptyId: number): Promise<void>;
    onData(callback: (ptyId: number, data: string) => void): () => void;
    onExit(callback: (ptyId: number) => void): () => void;
  };
  utils: {
    getHomePath(): Promise<string>;
    getIconsPath(): Promise<string>;
  };
  theme: {
    get(): Promise<string>;
    onChange(callback: (theme: string) => void): () => void;
  };
  onReconnect?(callback: () => void): () => void;
}

// Live-binding: fsa.ts and iconCache.ts import `bridge` and always get the current value.
// eslint-disable-next-line import/no-mutable-exports
export let bridge: Bridge;

export async function initBridge(): Promise<void> {
  if (isTauriApp()) {
    bridge = tauriBridge;
  } else {
    bridge = await createWsBridge(`ws://${location.host}/ws`);
  }
}
