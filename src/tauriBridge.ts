/// Tauri IPC bridge - replaces window.electron from the Electron version.
///
/// Provides the same interface so renderer components need minimal changes.
/// Uses Tauri's invoke() for commands and listen() for events.
import type {
  Bridge,
  CreateWindowOptions,
  ConflictResolution,
  CopyOptions,
  CopyProgressEvent,
  DeleteProgressEvent,
  ExtensionInstallProgressEvent,
  ExtensionInstallRequest,
  FsChangeEvent,
  FsEntry,
  MoveOptions,
  MoveProgressEvent,
  PtyLaunchInfo,
} from "@dotdirfm/ui";
import { normalizePath } from "@dotdirfm/ui";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";

const ptyWriteEncoder = new TextEncoder();
const extensionInstallRequestListeners = new Set<(request: ExtensionInstallRequest) => void>();

interface RustFsChangeEvent {
  watch_id: string;
  kind: string;
  name: string | null;
}

interface RustPtySpawnResult {
  ptyId: number;
  cwd: string;
  shell: string;
}

interface RustPtyDataEvent {
  ptyId: number;
  data: number[];
}

interface RustPtyExitEvent {
  ptyId: number;
}

export const tauriBridge: Bridge = {
  fs: {
    async entries(dirPath: string): Promise<FsEntry[]> {
      return await invoke<FsEntry[]>("fs_entries", { dirPath });
    },
    async stat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
      return await invoke<{ size: number; mtimeMs: number }>("fs_stat", {
        filePath,
      });
    },
    async exists(filePath: string): Promise<boolean> {
      return invoke<boolean>("fs_exists", { filePath });
    },
    async readFile(filePath: string): Promise<ArrayBuffer> {
      const bytes = await invoke<number[]>("fs_read_file", { filePath });
      return new Uint8Array(bytes).buffer;
    },
    async writeFile(filePath: string, data: string): Promise<void> {
      return invoke<void>("fs_write_text", { filePath, data });
    },
    async writeBinaryFile(filePath: string, data: Uint8Array): Promise<void> {
      return invoke<void>("fs_write_binary", {
        filePath,
        data: Array.from(data),
      });
    },
    async createDir(dirPath: string): Promise<void> {
      return invoke<void>("fs_create_dir", { dirPath });
    },
    async removeFile(filePath: string): Promise<void> {
      return invoke<void>("fs_remove_file", { filePath });
    },
    async moveToTrash(paths: string[]): Promise<void> {
      return invoke<void>("move_to_trash", { paths });
    },
    async open(filePath: string): Promise<number> {
      return invoke<number>("fs_open", { filePath });
    },
    async read(
      fd: number,
      offset: number,
      length: number,
    ): Promise<ArrayBuffer> {
      const offsetInt = Math.max(0, Math.floor(offset));
      const lengthInt = Math.max(0, Math.floor(length));
      const bytes = await invoke<number[]>("fs_read", {
        fd,
        offset: offsetInt,
        length: lengthInt,
      });
      return new Uint8Array(bytes).buffer;
    },
    async close(fd: number): Promise<void> {
      return invoke<void>("fs_close", { fd });
    },
    async watch(watchId: string, dirPath: string): Promise<boolean> {
      return invoke<boolean>("fs_watch", { watchId, dirPath });
    },
    async unwatch(watchId: string): Promise<void> {
      return invoke<void>("fs_unwatch", { watchId });
    },
    onFsChange(callback: (event: FsChangeEvent) => void): () => void {
      let unlisten: UnlistenFn | null = null;
      let disposed = false;
      const unlistenPromise = listen<RustFsChangeEvent>(
        "fsa:change",
        (event) => {
          callback({
            watchId: event.payload.watch_id,
            type: event.payload.kind as FsChangeEvent["type"],
            name: event.payload.name,
          });
        },
      ).then((fn) => {
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
    copy: {
      async start(
        sources: string[],
        destDir: string,
        options: CopyOptions,
      ): Promise<number> {
        return invoke<number>("copy_start", { sources, destDir, options });
      },
      async cancel(copyId: number): Promise<void> {
        return invoke<void>("copy_cancel", { copyId });
      },
      async resolveConflict(
        copyId: number,
        resolution: ConflictResolution,
      ): Promise<void> {
        // Map TS discriminated union to Rust serde format
        let rustRes: unknown;
        switch (resolution.type) {
          case "overwrite":
            rustRes = "overwrite";
            break;
          case "skip":
            rustRes = "skip";
            break;
          case "rename":
            rustRes = { rename: resolution.newName };
            break;
          case "overwriteAll":
            rustRes = "overwriteAll";
            break;
          case "skipAll":
            rustRes = "skipAll";
            break;
          case "cancel":
            rustRes = "cancel";
            break;
        }
        return invoke<void>("copy_resolve_conflict", {
          copyId,
          resolution: rustRes,
        });
      },
      onProgress(callback: (event: CopyProgressEvent) => void): () => void {
        let unlisten: (() => void) | null = null;
        listen<CopyProgressEvent>("copy:progress", (event) => {
          callback(event.payload);
        }).then((fn) => {
          unlisten = fn;
        });
        return () => {
          unlisten?.();
        };
      },
    },
    move: {
      async start(
        sources: string[],
        destDir: string,
        options: MoveOptions,
      ): Promise<number> {
        return invoke<number>("move_start", { sources, destDir, options });
      },
      async cancel(moveId: number): Promise<void> {
        return invoke<void>("move_cancel", { moveId });
      },
      async resolveConflict(
        moveId: number,
        resolution: ConflictResolution,
      ): Promise<void> {
        let rustRes: unknown;
        switch (resolution.type) {
          case "overwrite":
            rustRes = "overwrite";
            break;
          case "skip":
            rustRes = "skip";
            break;
          case "rename":
            rustRes = { rename: resolution.newName };
            break;
          case "overwriteAll":
            rustRes = "overwriteAll";
            break;
          case "skipAll":
            rustRes = "skipAll";
            break;
          case "cancel":
            rustRes = "cancel";
            break;
        }
        return invoke<void>("move_resolve_conflict", {
          moveId,
          resolution: rustRes,
        });
      },
      onProgress(callback: (event: MoveProgressEvent) => void): () => void {
        let unlisten: (() => void) | null = null;
        listen<MoveProgressEvent>("move:progress", (event) => {
          callback(event.payload);
        }).then((fn) => {
          unlisten = fn;
        });
        return () => {
          unlisten?.();
        };
      },
    },
    delete: {
      async start(paths: string[]): Promise<number> {
        return invoke<number>("delete_start", { paths });
      },
      async cancel(deleteId: number): Promise<void> {
        return invoke<void>("delete_cancel", { deleteId });
      },
      onProgress(callback: (event: DeleteProgressEvent) => void): () => void {
        let unlisten: (() => void) | null = null;
        listen<DeleteProgressEvent>("delete:progress", (event) => {
          callback(event.payload);
        }).then((fn) => {
          unlisten = fn;
        });
        return () => {
          unlisten?.();
        };
      },
    },
    rename: {
      async rename(source: string, newName: string): Promise<void> {
        return invoke<void>("rename_item", { source, newName });
      },
    },
  },
  pty: {
    async spawn(
      cwd: string,
      shellPath: string,
      options?: { spawnArgs?: string[] },
    ): Promise<PtyLaunchInfo> {
      const raw = await invoke<RustPtySpawnResult>("pty_spawn", {
        cwd,
        shellPath,
        spawnArgs:
          options?.spawnArgs && options.spawnArgs.length > 0
            ? options.spawnArgs
            : null,
      });
      return {
        ptyId: raw.ptyId,
        cwd: normalizePath(raw.cwd),
        shell: raw.shell,
      };
    },
    async write(ptyId: number, data: string): Promise<void> {
      return invoke<void>("pty_write", {
        ptyId,
        dataBytes: Array.from(ptyWriteEncoder.encode(data)),
      });
    },
    async resize(ptyId: number, cols: number, rows: number): Promise<void> {
      return invoke<void>("pty_resize", {
        ptyId,
        cols: Math.max(2, Math.floor(cols)),
        rows: Math.max(1, Math.floor(rows)),
      });
    },
    async close(ptyId: number): Promise<void> {
      return invoke<void>("pty_close", { ptyId });
    },
    async setShellIntegrations(
      integrations: Record<string, { script: string; scriptArg: boolean }>,
    ): Promise<void> {
      return invoke<void>("pty_set_shell_integrations", { integrations });
    },
    onData(callback: (ptyId: number, data: Uint8Array) => void): () => void {
      let unlisten: UnlistenFn | null = null;
      listen<RustPtyDataEvent>("pty:data", (event) => {
        callback(event.payload.ptyId, new Uint8Array(event.payload.data));
      }).then((fn) => {
        unlisten = fn;
      });
      return () => {
        unlisten?.();
      };
    },
    onExit(callback: (ptyId: number) => void): () => void {
      let unlisten: UnlistenFn | null = null;
      listen<RustPtyExitEvent>("pty:exit", (event) => {
        callback(event.payload.ptyId);
      }).then((fn) => {
        unlisten = fn;
      });
      return () => {
        unlisten?.();
      };
    },
  },
  utils: {
    async getHomePath(): Promise<string> {
      return normalizePath(await invoke<string>("get_home_path"));
    },
    async getMountedRoots(): Promise<string[]> {
      const roots = await invoke<string[]>("get_mounted_roots");
      return roots.map((root) => normalizePath(root));
    },
    async getAppDirs(): Promise<{ homeDir: string; configDir: string; dataDir: string; cacheDir: string }> {
      const dirs = await invoke<{ homeDir: string; configDir: string; dataDir: string; cacheDir: string }>("get_app_dirs");
      return {
        homeDir: normalizePath(dirs.homeDir),
        configDir: normalizePath(dirs.configDir),
        dataDir: normalizePath(dirs.dataDir),
        cacheDir: normalizePath(dirs.cacheDir),
      };
    },
    async getEnv(): Promise<Record<string, string>> {
      return invoke<Record<string, string>>("get_env");
    },
    async openExternal(url: string): Promise<void> {
      await openUrl(url);
    },
  },
  systemTheme: {
    async get(): Promise<"light" | "dark"> {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    },
    onChange(callback: (theme: "light" | "dark") => void): () => void {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent) =>
        callback(e.matches ? "dark" : "light");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    },
  },
  extensions: {
    install: {
      async start(request: ExtensionInstallRequest): Promise<number> {
        return invoke<number>("extensions_install_start", { request });
      },
      async cancel(installId: number): Promise<void> {
        return invoke<void>("extensions_install_cancel", { installId });
      },
      onProgress(callback: (event: ExtensionInstallProgressEvent) => void): () => void {
        let unlisten: UnlistenFn | null = null;
        listen<ExtensionInstallProgressEvent>("extensions:install:progress", (event) => {
          callback(event.payload);
        }).then((fn) => {
          unlisten = fn;
        });
        return () => {
          unlisten?.();
        };
      },
      onRequest(callback: (request: ExtensionInstallRequest) => void): () => void {
        extensionInstallRequestListeners.add(callback);
        return () => {
          extensionInstallRequestListeners.delete(callback);
        };
      },
      emitRequest(request: ExtensionInstallRequest): void {
        for (const listener of extensionInstallRequestListeners) {
          listener(request);
        }
      },
    },
  },
  window: {
    async getCurrentState() {
      const currentWindow = getCurrentWindow();
      const [position, size, isMaximized] = await Promise.all([
        currentWindow.outerPosition(),
        currentWindow.innerSize(),
        currentWindow.isMaximized(),
      ]);
      return {
        id: currentWindow.label,
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        isMaximized,
      };
    },
    async create(options: CreateWindowOptions) {
      return invoke<void>("create_window", { options });
    },
    async showCurrent() {
      return invoke<void>("show_current_window");
    },
    async closeCurrent() {
      await getCurrentWindow().close();
    },
    async exitApp() {
      return invoke<void>("app_exit");
    },
    onStateChanged(callback: () => void) {
      let disposed = false;
      const unlisteners: Array<() => void> = [];

      const register = async () => {
        const currentWindow = getCurrentWindow();
        const handlers = await Promise.all([
          currentWindow.onMoved(() => {
            callback();
          }),
          currentWindow.onResized(() => {
            callback();
          }),
        ]);
        if (disposed) {
          for (const unlisten of handlers) {
            unlisten();
          }
          return;
        }
        unlisteners.push(...handlers);
      };

      void register();

      return () => {
        disposed = true;
        for (const unlisten of unlisteners.splice(0)) {
          unlisten();
        }
      };
    },
  },
  fsProvider: {
    async load(wasmPath: string): Promise<void> {
      return invoke<void>("fsp_load", { wasmPath });
    },
    async listEntries(
      wasmPath: string,
      containerPath: string,
      innerPath: string,
    ): Promise<FsEntry[]> {
      return await invoke<FsEntry[]>("fsp_list_entries", {
        wasmPath,
        containerPath,
        innerPath,
      });
    },
    async readFileRange(
      wasmPath: string,
      containerPath: string,
      innerPath: string,
      offset: number,
      length: number,
    ): Promise<ArrayBuffer> {
      const bytes = await invoke<number[]>("fsp_read_file_range", {
        wasmPath,
        containerPath,
        innerPath,
        offset,
        length,
      });
      return new Uint8Array(bytes).buffer;
    },
  },
};
