/// Dynamic bridge provider - detects Tauri vs browser and loads the right backend.
///
/// Uses ES module live bindings: importers of `bridge` always see the current value.
/// Must call `initBridge()` before rendering (from main.tsx).
import { isTauri as isTauriApp } from '@tauri-apps/api/core';
import type { FsRawEntry, FsChangeEvent } from './types';
import { tauriBridge } from './tauriBridge';
import { createWsBridge } from './wsBridge';

// ── Copy types ──────────────────────────────────────────────────────

export type ConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename' | 'append' | 'onlyNewer';
export type SymlinkMode = 'smart' | 'alwaysLink' | 'alwaysTarget';

export interface CopyOptions {
  conflictPolicy: ConflictPolicy;
  copyPermissions: boolean;
  copyXattrs: boolean;
  sparseFiles: boolean;
  useCow: boolean;
  symlinkMode: SymlinkMode;
  disableWriteCache: boolean;
}

export type ConflictResolution =
  | { type: 'overwrite' }
  | { type: 'skip' }
  | { type: 'rename'; newName: string }
  | { type: 'overwriteAll' }
  | { type: 'skipAll' }
  | { type: 'cancel' };

export interface CopyProgress {
  bytesCopied: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  currentFile: string;
}

export type CopyProgressEvent = {
  copyId: number;
  event:
    | { kind: 'progress'; bytesCopied: number; bytesTotal: number; filesDone: number; filesTotal: number; currentFile: string }
    | { kind: 'conflict'; src: string; dest: string; srcSize: number; srcMtimeMs: number; destSize: number; destMtimeMs: number }
    | { kind: 'done'; filesDone: number; bytesCopied: number }
    | { kind: 'error'; message: string };
};

// ── Move types ──────────────────────────────────────────────────────

export interface MoveOptions {
  conflictPolicy: ConflictPolicy;
}

export type MoveProgressEvent = {
  moveId: number;
  event:
    | { kind: 'progress'; bytesCopied: number; bytesTotal: number; filesDone: number; filesTotal: number; currentFile: string }
    | { kind: 'conflict'; src: string; dest: string; srcSize: number; srcMtimeMs: number; destSize: number; destMtimeMs: number }
    | { kind: 'done'; filesDone: number; bytesCopied: number }
    | { kind: 'error'; message: string };
};

// ── Delete types ─────────────────────────────────────────────────────

export type DeleteProgressEvent = {
  deleteId: number;
  event:
    | { kind: 'progress'; filesDone: number; currentFile: string }
    | { kind: 'done'; filesDone: number }
    | { kind: 'error'; message: string };
};

export interface PtyLaunchInfo {
  ptyId: number;
  cwd: string;
  shell: string;
}

/** How to embed `{{cwd}}` in `hiddenCdTemplate` — set per shell-integration contribution. */
export type CwdEscapeMode = 'posix' | 'powershell' | 'cmd';

export interface TerminalProfile {
  id: string;
  label: string;
  shell: string;
  /**
   * Hidden cd before running a command from the UI; must contain `{{cwd}}`.
   * From shell-integration contributions (e.g. `cd {{cwd}}`).
   */
  hiddenCdTemplate: string;
  cwdEscape: CwdEscapeMode;
  /** Line ending appended after the hidden cd line. */
  lineEnding: '\n' | '\r\n';
  /** Extra argv after the shell executable (e.g. `--noprofile` for bash). From contributions. */
  spawnArgs: string[];
}

// ── FsProvider (WASM backend) types ─────────────────────────────────

export interface FspEntry {
  name: string;
  /** "file" or "directory" */
  kind: 'file' | 'directory';
  size?: number;
  mtimeMs?: number;
}

export interface Bridge {
  fs: {
    entries(dirPath: string): Promise<FsRawEntry[]>;
    stat(filePath: string): Promise<{ size: number; mtimeMs: number }>;
    exists(filePath: string): Promise<boolean>;
    readFile(filePath: string): Promise<ArrayBuffer>;
    open(filePath: string): Promise<number>;
    read(fd: number, offset: number, length: number): Promise<ArrayBuffer>;
    close(fd: number): Promise<void>;
    watch(watchId: string, dirPath: string): Promise<boolean>;
    unwatch(watchId: string): Promise<void>;
    onFsChange(callback: (event: FsChangeEvent) => void): () => void;
    writeFile(filePath: string, data: string): Promise<void>;
    writeBinaryFile(filePath: string, data: Uint8Array): Promise<void>;
    /** Create directory (and parents). */
    createDir?(dirPath: string): Promise<void>;
    /** Move files/folders to OS trash (batched for single trash sound). */
    moveToTrash(paths: string[]): Promise<void>;
  };
  pty: {
    spawn(cwd: string, shellPath: string, options?: { spawnArgs?: string[] }): Promise<PtyLaunchInfo>;
    write(ptyId: number, data: string): Promise<void>;
    resize(ptyId: number, cols: number, rows: number): Promise<void>;
    close(ptyId: number): Promise<void>;
    onData(callback: (ptyId: number, data: string | Uint8Array) => void): () => void;
    onExit(callback: (ptyId: number) => void): () => void;
    /** Register shell init scripts from extensions (shell path → init info). */
    setShellIntegrations?(integrations: Record<string, { script: string; scriptArg: boolean }>): Promise<void>;
  };
  utils: {
    getHomePath(): Promise<string>;
    /** Returns all process environment variables plus `__platform__` (e.g. "macos", "linux", "windows"). */
    getEnv(): Promise<Record<string, string>>;
  };
  copy: {
    start(sources: string[], destDir: string, options: CopyOptions): Promise<number>;
    cancel(copyId: number): Promise<void>;
    resolveConflict(copyId: number, resolution: ConflictResolution): Promise<void>;
    onProgress(callback: (event: CopyProgressEvent) => void): () => void;
  };
  move: {
    start(sources: string[], destDir: string, options: MoveOptions): Promise<number>;
    cancel(moveId: number): Promise<void>;
    resolveConflict(moveId: number, resolution: ConflictResolution): Promise<void>;
    onProgress(callback: (event: MoveProgressEvent) => void): () => void;
  };
  delete: {
    start(paths: string[]): Promise<number>;
    cancel(deleteId: number): Promise<void>;
    onProgress(callback: (event: DeleteProgressEvent) => void): () => void;
  };
  rename: {
    rename(source: string, newName: string): Promise<void>;
  };
  theme: {
    get(): Promise<string>;
    onChange(callback: (theme: string) => void): () => void;
  };
  onReconnect?(callback: () => void): () => void;
  /** Backend WASM fsProvider. Present only when the runtime supports it. */
  fsProvider?: {
    /** Compile and cache a WASM plugin. Safe to call multiple times (idempotent). */
    load(wasmPath: string): Promise<void>;
    /** List entries at innerPath inside the container at containerPath. */
    listEntries(wasmPath: string, containerPath: string, innerPath: string): Promise<FspEntry[]>;
    /** Read a byte range of a file inside the container. */
    readFileRange(wasmPath: string, containerPath: string, innerPath: string, offset: number, length: number): Promise<ArrayBuffer>;
  };
}

// Live-binding: fs.ts and iconCache.ts import `bridge` and always get the current value.
// eslint-disable-next-line import/no-mutable-exports
export let bridge: Bridge;

export async function initBridge(): Promise<void> {
  if (isTauriApp()) {
    bridge = tauriBridge;
  } else {
    bridge = await createWsBridge(`ws://${location.host}/ws`);
  }
}
