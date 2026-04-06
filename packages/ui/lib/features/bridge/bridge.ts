export type Unsubscribe = () => void;
export type SystemThemeKind = "light" | "dark";
export type ThemePreference = SystemThemeKind | "system";

export interface AppDirs {
  homeDir: string;
  configDir: string;
  dataDir: string;
  cacheDir: string;
}

export type EntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "block_device"
  | "char_device"
  | "named_pipe"
  | "socket"
  | "whiteout"
  | "door"
  | "event_port"
  | "unknown";

export interface FsEntry {
  name: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  mode: number;
  nlink: number;
  hidden: boolean;
  /** Populated only when kind === 'symlink'. Omitted when not a symlink. */
  linkTarget?: string;
}

export type FsChangeType = "appeared" | "disappeared" | "modified" | "errored" | "unknown";

export interface FsChangeEvent {
  watchId: string;
  type: FsChangeType;
  name: string | null;
}

export type ConflictPolicy = "ask" | "overwrite" | "skip" | "rename" | "append" | "onlyNewer";
export type SymlinkMode = "smart" | "alwaysLink" | "alwaysTarget";

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
  | { type: "overwrite" }
  | { type: "skip" }
  | { type: "rename"; newName: string }
  | { type: "overwriteAll" }
  | { type: "skipAll" }
  | { type: "cancel" };

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
    | {
        kind: "progress";
        bytesCopied: number;
        bytesTotal: number;
        filesDone: number;
        filesTotal: number;
        currentFile: string;
      }
    | {
        kind: "conflict";
        src: string;
        dest: string;
        srcSize: number;
        srcMtimeMs: number;
        destSize: number;
        destMtimeMs: number;
      }
    | { kind: "done"; filesDone: number; bytesCopied: number }
    | { kind: "error"; message: string };
};

export interface MoveOptions {
  conflictPolicy: ConflictPolicy;
}

export type MoveProgressEvent = {
  moveId: number;
  event:
    | { kind: "progress"; bytesCopied: number; bytesTotal: number; filesDone: number; filesTotal: number; currentFile: string }
    | { kind: "conflict"; src: string; dest: string; srcSize: number; srcMtimeMs: number; destSize: number; destMtimeMs: number }
    | { kind: "done"; filesDone: number; bytesCopied: number }
    | { kind: "error"; message: string };
};

export type DeleteProgressEvent = {
  deleteId: number;
  event: { kind: "progress"; filesDone: number; currentFile: string } | { kind: "done"; filesDone: number } | { kind: "error"; message: string };
};

export type ExtensionInstallRequest =
  | { source: "dotdir-marketplace"; publisher: string; name: string; version: string }
  | { source: "open-vsx-marketplace"; publisher: string; name: string; downloadUrl: string };

export type ExtensionInstallProgressEvent = {
  installId: number;
  event:
    | {
        kind: "progress";
        phase: "download" | "extract" | "write" | "finalize";
        currentFile?: string;
        filesDone?: number;
        filesTotal?: number;
        bytesDone?: number;
        bytesTotal?: number;
      }
    | {
        kind: "done";
        ref: { publisher: string; name: string; version: string };
      }
    | { kind: "error"; message: string };
};

export interface PtyLaunchInfo {
  ptyId: number;
  cwd: string;
  shell: string;
}

export type CwdEscapeMode = "posix" | "powershell" | "cmd";

export interface TerminalProfile {
  id: string;
  label: string;
  shell: string;
  hiddenCdTemplate: string;
  cwdEscape: CwdEscapeMode;
  lineEnding: "\n" | "\r\n";
  spawnArgs: string[];
}

export interface WindowStateSnapshot {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface CreateWindowOptions {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isMaximized?: boolean;
}

export interface Bridge {
  fs: {
    entries(dirPath: string): Promise<FsEntry[]>;
    stat(filePath: string): Promise<{ size: number; mtimeMs: number }>;
    exists(filePath: string): Promise<boolean>;
    readFile(filePath: string): Promise<ArrayBuffer>;
    open(filePath: string): Promise<number>;
    read(fd: number, offset: number, length: number): Promise<ArrayBuffer>;
    close(fd: number): Promise<void>;
    watch(watchId: string, dirPath: string): Promise<boolean>;
    unwatch(watchId: string): Promise<void>;
    onFsChange(callback: (event: FsChangeEvent) => void): Unsubscribe;
    writeFile(filePath: string, data: string): Promise<void>;
    writeBinaryFile(filePath: string, data: Uint8Array): Promise<void>;
    createDir(dirPath: string): Promise<void>;
    removeFile?(filePath: string): Promise<void>;
    moveToTrash(paths: string[]): Promise<void>;
    copy: {
      start(sources: string[], destDir: string, options: CopyOptions): Promise<number>;
      cancel(copyId: number): Promise<void>;
      resolveConflict(copyId: number, resolution: ConflictResolution): Promise<void>;
      onProgress(callback: (event: CopyProgressEvent) => void): Unsubscribe;
    };
    move: {
      start(sources: string[], destDir: string, options: MoveOptions): Promise<number>;
      cancel(moveId: number): Promise<void>;
      resolveConflict(moveId: number, resolution: ConflictResolution): Promise<void>;
      onProgress(callback: (event: MoveProgressEvent) => void): Unsubscribe;
    };
    delete: {
      start(paths: string[]): Promise<number>;
      cancel(deleteId: number): Promise<void>;
      onProgress(callback: (event: DeleteProgressEvent) => void): Unsubscribe;
    };
    rename: {
      rename(source: string, newName: string): Promise<void>;
    };
  };
  pty: {
    spawn(cwd: string, shellPath: string, options?: { spawnArgs?: string[] }): Promise<PtyLaunchInfo>;
    write(ptyId: number, data: string): Promise<void>;
    resize(ptyId: number, cols: number, rows: number): Promise<void>;
    close(ptyId: number): Promise<void>;
    onData(callback: (ptyId: number, data: string | Uint8Array) => void): Unsubscribe;
    onExit(callback: (ptyId: number) => void): Unsubscribe;
    setShellIntegrations?(integrations: Record<string, { script: string; scriptArg: boolean }>): Promise<void>;
  };
  utils: {
    getHomePath(): Promise<string>;
    getMountedRoots(): Promise<string[]>;
    getAppDirs(): Promise<AppDirs>;
    getEnv(): Promise<Record<string, string>>;
    openExternal?(url: string): Promise<void>;
  };
  systemTheme: {
    get(): Promise<SystemThemeKind>;
    onChange(callback: (theme: SystemThemeKind) => void): Unsubscribe;
  };
  extensions: {
    install: {
      start(request: ExtensionInstallRequest): Promise<number>;
      cancel?(installId: number): Promise<void>;
      onProgress(callback: (event: ExtensionInstallProgressEvent) => void): Unsubscribe;
    };
  };
  window?: {
    getCurrentState(): Promise<WindowStateSnapshot>;
    create(options: CreateWindowOptions): Promise<void>;
    closeCurrent(): Promise<void>;
    exitApp?(): Promise<void>;
    onStateChanged?(callback: () => void): Unsubscribe;
  };
  onReconnect?(callback: () => void): Unsubscribe;
  fsProvider?: {
    load(wasmPath: string): Promise<void>;
    listEntries(wasmPath: string, containerPath: string, innerPath: string): Promise<FsEntry[]>;
    readFileRange(wasmPath: string, containerPath: string, innerPath: string, offset: number, length: number): Promise<ArrayBuffer>;
  };
}
