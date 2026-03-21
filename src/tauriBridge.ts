/// Tauri IPC bridge - replaces window.electron from the Electron version.
///
/// Provides the same interface so renderer components need minimal changes.
/// Uses Tauri's invoke() for commands and listen() for events.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { PtyLaunchInfo, TerminalProfile, CopyOptions, ConflictResolution, CopyProgressEvent, MoveOptions, MoveProgressEvent } from './bridge';
import type { FsaRawEntry, FsChangeEvent } from './types';
import { normalizePath } from './path';

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

interface RustPtyLaunchInfo {
  pty_id: number;
  cwd: string;
  shell: string;
  profile_id: string;
  profile_label: string;
}

interface RustTerminalProfile {
  id: string;
  label: string;
  shell: string;
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
    async writeBinaryFile(filePath: string, data: Uint8Array): Promise<void> {
      return invoke<void>('fsa_write_binary', { filePath, data: Array.from(data) });
    },
    async createDir(dirPath: string): Promise<void> {
      return invoke<void>('fsa_create_dir', { dirPath });
    },
    async moveToTrash(paths: string[]): Promise<void> {
      return invoke<void>('move_to_trash', { paths });
    },
    async deletePath(path: string): Promise<void> {
      return invoke<void>('fsa_delete_path', { path });
    },
    async open(filePath: string): Promise<number> {
      return invoke<number>('fsa_open', { filePath });
    },
    async read(fd: number, offset: number, length: number): Promise<ArrayBuffer> {
      const offsetInt = Math.max(0, Math.floor(offset));
      const lengthInt = Math.max(0, Math.floor(length));
      const bytes = await invoke<number[]>('fsa_read', { fd, offset: offsetInt, length: lengthInt });
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
      let disposed = false;
      const unlistenPromise = listen<RustFsChangeEvent>('fsa:change', (event) => {
        callback({
          watchId: event.payload.watch_id,
          type: event.payload.kind as FsChangeEvent['type'],
          name: event.payload.name,
        });
      }).then((fn) => {
        unlisten = fn;
        if (disposed) void fn();
        return fn;
      });
      return () => {
        disposed = true;
        if (unlisten) {
          void unlisten();
        } else {
          void unlistenPromise.then((fn) => fn());
        }
      };
    },
  },
  pty: {
    async spawn(cwd: string, profileId?: string): Promise<PtyLaunchInfo> {
      const raw = await invoke<RustPtyLaunchInfo>('pty_spawn', { cwd, profileId });
      return {
        ptyId: raw.pty_id,
        cwd: normalizePath(raw.cwd),
        shell: raw.shell,
        profileId: raw.profile_id,
        profileLabel: raw.profile_label,
      };
    },
    async write(ptyId: number, data: string): Promise<void> {
      return invoke<void>('pty_write', { ptyId, data });
    },
    async resize(ptyId: number, cols: number, rows: number): Promise<void> {
      return invoke<void>('pty_resize', {
        ptyId,
        cols: Math.max(2, Math.floor(cols)),
        rows: Math.max(1, Math.floor(rows)),
      });
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
    async getTerminalProfiles(): Promise<TerminalProfile[]> {
      return invoke<RustTerminalProfile[]>('get_terminal_profiles');
    },
  },
  copy: {
    async start(sources: string[], destDir: string, options: CopyOptions): Promise<number> {
      return invoke<number>('copy_start', { sources, destDir, options });
    },
    async cancel(copyId: number): Promise<void> {
      return invoke<void>('copy_cancel', { copyId });
    },
    async resolveConflict(copyId: number, resolution: ConflictResolution): Promise<void> {
      // Map TS discriminated union to Rust serde format
      let rustRes: unknown;
      switch (resolution.type) {
        case 'overwrite': rustRes = 'overwrite'; break;
        case 'skip': rustRes = 'skip'; break;
        case 'rename': rustRes = { rename: resolution.newName }; break;
        case 'overwriteAll': rustRes = 'overwriteAll'; break;
        case 'skipAll': rustRes = 'skipAll'; break;
        case 'cancel': rustRes = 'cancel'; break;
      }
      return invoke<void>('copy_resolve_conflict', { copyId, resolution: rustRes });
    },
    onProgress(callback: (event: CopyProgressEvent) => void): () => void {
      let unlisten: (() => void) | null = null;
      listen<CopyProgressEvent>('copy:progress', (event) => {
        callback(event.payload);
      }).then((fn) => { unlisten = fn; });
      return () => { unlisten?.(); };
    },
  },
  move: {
    async start(sources: string[], destDir: string, options: MoveOptions): Promise<number> {
      return invoke<number>('move_start', { sources, destDir, options });
    },
    async cancel(moveId: number): Promise<void> {
      return invoke<void>('move_cancel', { moveId });
    },
    async resolveConflict(moveId: number, resolution: ConflictResolution): Promise<void> {
      let rustRes: unknown;
      switch (resolution.type) {
        case 'overwrite': rustRes = 'overwrite'; break;
        case 'skip': rustRes = 'skip'; break;
        case 'rename': rustRes = { rename: resolution.newName }; break;
        case 'overwriteAll': rustRes = 'overwriteAll'; break;
        case 'skipAll': rustRes = 'skipAll'; break;
        case 'cancel': rustRes = 'cancel'; break;
      }
      return invoke<void>('move_resolve_conflict', { moveId, resolution: rustRes });
    },
    onProgress(callback: (event: MoveProgressEvent) => void): () => void {
      let unlisten: (() => void) | null = null;
      listen<MoveProgressEvent>('move:progress', (event) => {
        callback(event.payload);
      }).then((fn) => { unlisten = fn; });
      return () => { unlisten?.(); };
    },
  },
  rename: {
    async rename(source: string, newName: string): Promise<void> {
      return invoke<void>('rename_item', { source, newName });
    },
  },
  theme: {
    async get(): Promise<string> {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    },
    onChange(callback: (theme: string) => void): () => void {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = (e: MediaQueryListEvent) => callback(e.matches ? 'dark' : 'light');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    },
  },
};
