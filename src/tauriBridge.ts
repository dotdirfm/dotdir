/// Tauri IPC bridge — replaces window.electron from the Electron version.
///
/// Provides the same interface so renderer components need minimal changes.
/// Uses Tauri's invoke() for commands and listen() for events.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { FsaRawEntry, FsChangeEvent } from './types';
import { normalizePath } from './path';

// Rust returns snake_case fields — map to camelCase
interface RustFsEntry {
  name: string;
  kind: string;
  size: number;
  mtime_ms: number;
  mode: number;
  nlink: number;
  hidden: boolean;
  link_target: string | null;
}

interface RustFsChangeEvent {
  watch_id: string;
  kind: string;
  name: string | null;
}

function mapEntry(e: RustFsEntry): FsaRawEntry {
  return {
    name: e.name,
    kind: e.kind as FsaRawEntry['kind'],
    size: e.size,
    mtimeMs: e.mtime_ms,
    mode: e.mode,
    nlink: e.nlink,
    hidden: e.hidden,
    linkTarget: e.link_target ?? undefined,
  };
}

export const tauriBridge = {
  fsa: {
    async entries(dirPath: string): Promise<FsaRawEntry[]> {
      const raw = await invoke<RustFsEntry[]>('fsa_entries', { dirPath });
      return raw.map(mapEntry);
    },
    async stat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
      const raw = await invoke<{ size: number; mtime_ms: number }>('fsa_stat', { filePath });
      return { size: raw.size, mtimeMs: raw.mtime_ms };
    },
    async exists(filePath: string): Promise<boolean> {
      return invoke<boolean>('fsa_exists', { filePath });
    },
    async writeFile(filePath: string, data: string): Promise<void> {
      return invoke<void>('fsa_write_text', { filePath, data });
    },
    async open(filePath: string): Promise<number> {
      return invoke<number>('fsa_open', { filePath });
    },
    async read(fd: number, offset: number, length: number): Promise<ArrayBuffer> {
      const bytes = await invoke<number[]>('fsa_read', { fd, offset, length });
      return new Uint8Array(bytes).buffer;
    },
    async close(fd: number): Promise<void> {
      return invoke<void>('fsa_close', { fd });
    },
    async watch(watchId: string, dirPath: string): Promise<boolean> {
      return invoke<boolean>('fsa_watch', { watchId, dirPath });
    },
    async unwatch(watchId: string): Promise<void> {
      return invoke<void>('fsa_unwatch', { watchId });
    },
    onFsChange(callback: (event: FsChangeEvent) => void): () => void {
      let unlisten: UnlistenFn | null = null;
      listen<RustFsChangeEvent>('fsa:change', (event) => {
        callback({
          watchId: event.payload.watch_id,
          type: event.payload.kind as FsChangeEvent['type'],
          name: event.payload.name,
        });
      }).then((fn) => { unlisten = fn; });
      return () => { unlisten?.(); };
    },
  },
  pty: {
    async spawn(cwd: string, cols?: number, rows?: number): Promise<number> {
      return invoke<number>('pty_spawn', { cwd, cols, rows });
    },
    async write(ptyId: number, data: string): Promise<void> {
      return invoke<void>('pty_write', { ptyId, data });
    },
    async resize(ptyId: number, cols: number, rows: number): Promise<void> {
      return invoke<void>('pty_resize', { ptyId, cols: Math.floor(cols), rows: Math.floor(rows) });
    },
    async close(ptyId: number): Promise<void> {
      return invoke<void>('pty_close', { ptyId });
    },
    onData(callback: (ptyId: number, data: string) => void): () => void {
      let unlisten: UnlistenFn | null = null;
      listen<{ pty_id: number; data: string }>('pty:data', (event) => {
        callback(event.payload.pty_id, event.payload.data);
      }).then((fn) => { unlisten = fn; });
      return () => { unlisten?.(); };
    },
    onExit(callback: (ptyId: number) => void): () => void {
      let unlisten: UnlistenFn | null = null;
      listen<{ pty_id: number }>('pty:exit', (event) => {
        callback(event.payload.pty_id);
      }).then((fn) => { unlisten = fn; });
      return () => { unlisten?.(); };
    },
  },
  utils: {
    async getHomePath(): Promise<string> {
      return normalizePath(await invoke<string>('get_home_path'));
    },
    async getIconsPath(): Promise<string> {
      return normalizePath(await invoke<string>('get_icons_path'));
    },
  },
  theme: {
    async get(): Promise<string> {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    },
    onChange(callback: (theme: string) => void): () => void {
      // Tauri v2 doesn't have a native theme change event yet.
      // Use CSS prefers-color-scheme media query listener instead.
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = (e: MediaQueryListEvent) => callback(e.matches ? 'dark' : 'light');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    },
  },
};
