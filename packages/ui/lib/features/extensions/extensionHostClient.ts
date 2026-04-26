import type { Bridge, FsChangeEvent, FsEntry } from "@/features/bridge";
import { readAppDirs } from "@/features/bridge/appDirs";
import { useBridge, useBridgeFactory } from "@/features/bridge/useBridge";
import { loadExtensions } from "@/features/extensions/extensions";
import { extensionManifest, extensionRef, type LoadedExtension } from "@/features/extensions/types";
import { dirname, join } from "@/utils/path";
import { initialize, getService, IExtensionService } from "@codingame/monaco-vscode-api";
import { registerAssets } from "@codingame/monaco-vscode-api/assets";
import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import getConfigurationServiceOverride, { initUserConfiguration, reinitializeWorkspace, updateUserConfiguration } from "@codingame/monaco-vscode-configuration-service-override";
import getEnvironmentServiceOverride from "@codingame/monaco-vscode-environment-service-override";
import getEditorServiceOverride from "@codingame/monaco-vscode-editor-service-override";
import getExtensionServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import { ExtensionHostKind, registerExtension, type IExtensionManifest, type RegisterExtensionResult } from "@codingame/monaco-vscode-api/extensions";
import getFileServiceOverride, {
  FileChangeType,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileSystemProviderCapabilities,
  FileType,
  registerCustomProvider,
  type IFileChange,
  type IFileDeleteOptions,
  type IFileOverwriteOptions,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IFileWriteOptions,
  type IStat,
  type IWatchOptions,
} from "@codingame/monaco-vscode-files-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getLifecycleServiceOverride from "@codingame/monaco-vscode-lifecycle-service-override";
import getLocalizationServiceOverride from "@codingame/monaco-vscode-localization-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getMonarchServiceOverride from "@codingame/monaco-vscode-monarch-service-override";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override";
import getTextMateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import { whenReady as defaultThemesReady } from "@codingame/monaco-vscode-theme-defaults-default-extension";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import extensionHostIframeUrl from "./vscodeRuntime/extensionHostIframe.html?url&no-inline";
import extensionHostWorkerMainUrl from "./vscodeRuntime/extensionHostWorkerMain.worker.ts?worker&url";

export type ExtensionsLoadedCallback = (extensions: LoadedExtension[]) => void;
export type OutputAppendListener = (event: { channel: string; text: string; newline: boolean }) => void;
export type StatusBarListener = (event: { id: string; text?: string }) => void;
export type MessageShowListener = (event: { level: "info" | "warn" | "error"; message: string }) => Promise<string | undefined>;
export type OpenExternalListener = (uri: string) => Promise<boolean>;
export type ApplyEditListener = (edit: unknown) => Promise<boolean>;
export type CommandRequestListener = (command: string, args: unknown[]) => Promise<unknown>;
export type ConfigReadListener = (key: string, section?: string) => unknown;
export type ConfigWriteListener = (msg: { section?: string; key: string; value: unknown; target?: string }) => Promise<void>;

type WorkspaceFolderInput = { uri: string; name: string };
type RegisterLocalExtensionFileUrl = RegisterExtensionResult & {
  registerFileUrl(path: string, url: string, metadata?: { mimeType?: string; size?: number }): { dispose(): void };
};
type RegisteredServiceExtension = {
  registration: RegisterExtensionResult;
  fileDisposables: Array<{ dispose(): void }>;
  objectUrls: string[];
};

const textEncoder = new TextEncoder();
const defaultUserConfiguration: Record<string, unknown> = {
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.iconTheme": "vs-minimal",
};

registerAssets({
  "vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html": extensionHostIframeUrl,
});

type MonacoEnvironmentLike = {
  getWorker?: (workerId: string, label: string) => Worker;
  getWorkerUrl?: (workerId: string, label: string) => string | undefined;
  getWorkerOptions?: (workerId: string, label: string) => WorkerOptions | undefined;
};

export function installExtensionHostIframeWorkerUrl(): void {
  if (typeof globalThis === "undefined") return;
  const target = globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironmentLike };
  const existing = target.MonacoEnvironment ?? {};
  if (existing.getWorkerUrl?.("__dotdir_probe__", "webWorkerExtensionHostIframe") === extensionHostIframeUrl) return;
  const previousGetWorkerUrl = existing.getWorkerUrl?.bind(existing);
  const previousGetWorkerOptions = existing.getWorkerOptions?.bind(existing);
  target.MonacoEnvironment = {
    ...existing,
    getWorkerUrl: (workerId, label) => {
      if (label === "webWorkerExtensionHostIframe") return extensionHostIframeUrl;
      if (label === "extensionHostWorkerMain") return extensionHostWorkerMainUrl;
      return previousGetWorkerUrl?.(workerId, label);
    },
    getWorkerOptions: (workerId, label) => {
      if (label === "extensionHostWorkerMain") return { type: "module", name: "ExtensionHostWorker" };
      return previousGetWorkerOptions?.(workerId, label);
    },
  };
}

installExtensionHostIframeWorkerUrl();

function pathFromUri(resource: URI): string {
  return decodeURIComponent(resource.path);
}

function fileTypeFromEntry(entry: FsEntry): FileType {
  if (entry.kind === "directory") return FileType.Directory;
  if (entry.kind === "symlink") return FileType.SymbolicLink;
  if (entry.kind === "unknown") return FileType.Unknown;
  return FileType.File;
}

function changeTypeFromBridge(event: FsChangeEvent): FileChangeType {
  if (event.type === "appeared") return FileChangeType.ADDED;
  if (event.type === "disappeared") return FileChangeType.DELETED;
  return FileChangeType.UPDATED;
}

function toFileNotFound(resource: URI): FileSystemProviderError {
  return FileSystemProviderError.create(`File not found: ${resource.toString()}`, FileSystemProviderErrorCode.FileNotFound);
}

function toProviderError(error: unknown, resource: URI): Error {
  if (error instanceof FileSystemProviderError) return error;
  const message = stringifyProviderError(error);
  if (/not found|no such file|does not exist|ENOENT/i.test(message)) return toFileNotFound(resource);
  return error instanceof Error ? error : new Error(message);
}

function stringifyProviderError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function optionalWorkspaceConfigContent(path: string): Uint8Array | null {
  if (path.endsWith("/.vscode/tasks.json")) return textEncoder.encode('{"version":"2.0.0","tasks":[]}\n');
  if (path.endsWith("/.vscode/launch.json")) return textEncoder.encode('{"version":"0.2.0","configurations":[]}\n');
  if (path.endsWith("/.vscode/mcp.json")) return textEncoder.encode("{}\n");
  return null;
}

function sanitizeServiceManifest(manifest: Record<string, unknown>, ext: LoadedExtension): IExtensionManifest {
  const ref = extensionRef(ext);
  const sanitized: Record<string, unknown> = {
    ...manifest,
    publisher: ref.publisher,
    name: ref.name,
    version: ref.version,
    engines: (manifest.engines as { vscode: string } | undefined) ?? { vscode: "*" },
  };
  const activationEntry = ext.runtime.activationEntry;
  if (activationEntry) {
    sanitized[activationEntry.sourceField] = relativeExtensionPath(ext, activationEntry.path);
  }
  delete sanitized.enabledApiProposals;
  delete sanitized.originalEnabledApiProposals;
  return sanitized as unknown as IExtensionManifest;
}

function relativeExtensionPath(ext: LoadedExtension, path: string): string {
  const root = ext.location.dirPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedPath.startsWith(`${root}/`)) return `./${normalizedPath.slice(root.length + 1)}`;
  return normalizedPath.startsWith("./") ? normalizedPath : `./${normalizedPath.replace(/^\/+/, "")}`;
}

function extensionFileMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "text/javascript";
  if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".wasm")) return "application/wasm";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

class DotDirFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
  readonly onDidChangeCapabilities = Event.None;

  private readonly changeListeners = new Set<(changes: readonly IFileChange[]) => void>();
  private watchCounter = 0;
  private readonly watchIds = new Map<string, string>();

  readonly onDidChangeFile = (listener: (changes: readonly IFileChange[]) => void): { dispose(): void } => {
    this.changeListeners.add(listener);
    return {
      dispose: () => {
        this.changeListeners.delete(listener);
      },
    };
  };

  constructor(private readonly bridge: Bridge) {
    this.bridge.fs.onFsChange((event) => {
      const watchRoot = this.watchIds.get(event.watchId);
      if (!watchRoot) return;
      const resource = URI.file(event.name ? join(watchRoot, event.name) : watchRoot);
      this.fire([{ resource, type: changeTypeFromBridge(event) }]);
    });
  }

  async stat(resource: URI): Promise<IStat> {
    const path = pathFromUri(resource);
    if (!(await this.exists(path))) throw toFileNotFound(resource);
    try {
      const entries = await this.bridge.fs.entries(path);
      return {
        type: FileType.Directory,
        ctime: 0,
        mtime: Date.now(),
        size: entries.length,
      };
    } catch {
      try {
        const stat = await this.bridge.fs.stat(path);
        return {
          type: FileType.File,
          ctime: stat.mtimeMs,
          mtime: stat.mtimeMs,
          size: stat.size,
        };
      } catch (error) {
        throw toProviderError(error, resource);
      }
    }
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const path = pathFromUri(resource);
    if (!(await this.exists(path))) throw toFileNotFound(resource);
    try {
      const entries = await this.bridge.fs.entries(path);
      return entries.map((entry) => [entry.name, fileTypeFromEntry(entry)]);
    } catch (error) {
      throw toProviderError(error, resource);
    }
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const path = pathFromUri(resource);
    const optionalContent = optionalWorkspaceConfigContent(path);
    if (optionalContent && !(await this.exists(path))) return optionalContent;
    if (!(await this.exists(path))) throw toFileNotFound(resource);
    try {
      return new Uint8Array(await this.bridge.fs.readFile(path));
    } catch (error) {
      throw toProviderError(error, resource);
    }
  }

  async writeFile(resource: URI, content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
    await this.bridge.fs.writeBinaryFile(pathFromUri(resource), content);
  }

  watch(resource: URI, _opts: IWatchOptions): { dispose(): void } {
    const path = pathFromUri(resource);
    const watchId = `vscode-service-${++this.watchCounter}`;
    this.watchIds.set(watchId, path);
    void this.bridge.fs.watch(watchId, path).catch(() => {
      this.watchIds.delete(watchId);
    });
    return {
      dispose: () => {
        this.watchIds.delete(watchId);
        void this.bridge.fs.unwatch(watchId).catch(() => {});
      },
    };
  }

  async mkdir(resource: URI): Promise<void> {
    await this.bridge.fs.createDir(pathFromUri(resource));
  }

  async delete(resource: URI, _opts: IFileDeleteOptions): Promise<void> {
    const path = pathFromUri(resource);
    if (this.bridge.fs.removeFile) {
      await this.bridge.fs.removeFile(path);
      return;
    }
    await this.bridge.fs.moveToTrash([path]);
  }

  async rename(from: URI, to: URI, _opts: IFileOverwriteOptions): Promise<void> {
    const fromPath = pathFromUri(from);
    const toPath = pathFromUri(to);
    if (dirname(fromPath) !== dirname(toPath)) {
      throw new Error("DotDir VS Code filesystem provider only supports same-directory rename.");
    }
    await this.bridge.fs.rename.rename(fromPath, toPath.split("/").pop() ?? toPath);
  }

  private fire(changes: IFileChange[]): void {
    for (const listener of this.changeListeners) listener(changes);
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return await this.bridge.fs.exists(path);
    } catch {
      return false;
    }
  }
}

let servicesPromise: Promise<void> | null = null;
let registeredFileProvider = false;

async function initializeVscodeServices(bridge: Bridge, dataDir: string): Promise<void> {
  if (servicesPromise) return servicesPromise;
  installExtensionHostIframeWorkerUrl();
  if (!registeredFileProvider) {
    registerCustomProvider("file", new DotDirFileSystemProvider(bridge));
    registeredFileProvider = true;
  }
  await initUserConfiguration(JSON.stringify(defaultUserConfiguration)).catch(() => {});
  servicesPromise = initialize({
    ...getEnvironmentServiceOverride(),
    ...getFileServiceOverride(),
    ...getConfigurationServiceOverride(),
    ...getModelServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getMonarchServiceOverride(),
    ...getEditorServiceOverride(async () => undefined),
    ...getKeybindingsServiceOverride(),
    ...getThemeServiceOverride(),
    ...getTextMateServiceOverride(),
    ...getQuickAccessServiceOverride(),
    ...getLifecycleServiceOverride(),
    ...getStorageServiceOverride(),
    ...getLocalizationServiceOverride({
      availableLanguages: [{ locale: "en", languageName: "English" }],
      setLocale: async () => {},
      clearLocale: async () => {},
    }),
    ...getExtensionServiceOverride({ enableWorkerExtensionHost: true }),
  }, undefined, {
    productConfiguration: {
      nameShort: "DotDir",
      nameLong: "DotDir",
      applicationName: "dotdir",
      dataFolderName: dataDir,
      version: "0.0.0",
    },
  })
    .then(async () => {
      await defaultThemesReady;
    })
    .catch((error) => {
      servicesPromise = null;
      throw error;
    });
  return servicesPromise;
}

export class ExtensionHostClient {
  private loadedSnapshot: LoadedExtension[] = [];
  private readonly loadedListeners = new Set<ExtensionsLoadedCallback>();
  private readonly configurationValues = new Map<string, unknown>();
  private readonly activatedEvents = new Set<string>();
  private registeredExtensions: RegisteredServiceExtension[] = [];
  private disposed = false;
  private lastWorkspaceFoldersSignature = "";
  private lastWorkspaceActivationSignature = "";

  constructor(
    private readonly bridge: Bridge,
    private readonly dataDir: string,
  ) {}

  onLoaded(cb: ExtensionsLoadedCallback): () => void {
    this.loadedListeners.add(cb);
    if (this.loadedSnapshot.length > 0) queueMicrotask(() => this.loadedListeners.has(cb) && cb(this.loadedSnapshot));
    return () => {
      this.loadedListeners.delete(cb);
    };
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    await initializeVscodeServices(this.bridge, this.dataDir);
    const extensions = await loadExtensions(this.bridge, this.dataDir);
    await this.replaceServiceExtensions(extensions);
    this.loadedSnapshot = extensions;
    for (const listener of this.loadedListeners) listener(extensions);
  }

  async restart(): Promise<void> {
    await this.disposeRegisteredExtensions();
    await this.start();
  }

  dispose(): void {
    this.disposed = true;
    this.loadedListeners.clear();
    void this.disposeRegisteredExtensions();
  }

  onOutput(_cb: OutputAppendListener): () => void {
    return () => {};
  }

  onStatusBar(_cb: StatusBarListener): () => void {
    return () => {};
  }

  setMessageShowListener(_listener: MessageShowListener | null): void {}
  setOpenExternalListener(_listener: OpenExternalListener | null): void {}
  setApplyEditListener(_listener: ApplyEditListener | null): void {}
  setCommandRequestListener(_listener: CommandRequestListener | null): void {}
  setConfigReadListener(_listener: ConfigReadListener | null): void {}
  setConfigWriteListener(_listener: ConfigWriteListener | null): void {}

  documentOpen(_uri: string, _languageId: string, _version: number, _text: string): void {}
  documentChange(_uri: string, _version: number, _text: string): void {}
  documentClose(_uri: string): void {}
  documentSave(_uri: string): void {}
  setActiveEditor(_uri: string | null): void {}

  setWorkspaceFolders(folders: WorkspaceFolderInput[]): void {
    const signature = JSON.stringify(folders.map((folder) => ({ uri: folder.uri, name: folder.name })).sort((a, b) => a.uri.localeCompare(b.uri)));
    if (this.lastWorkspaceFoldersSignature === signature) return;
    this.lastWorkspaceFoldersSignature = signature;
    const first = folders[0];
    const workspace = first ? { id: `dotdir:${first.uri}`, uri: URI.parse(first.uri) } : { id: "dotdir:empty" };
    void reinitializeWorkspace(workspace).catch((error) => {
      console.warn("[VscodeRuntime] failed to update workspace folders", error);
    });
  }

  setWorkspaceActivationContext(
    roots: Array<{ rootPath: string; uri: string; name: string; languages: string[]; activationEvents: string[] }>,
    _deactivateDelayMs: number,
  ): void {
    const signature = JSON.stringify(roots.map((root) => ({
      rootPath: root.rootPath,
      uri: root.uri,
      languages: [...root.languages].sort(),
      activationEvents: [...root.activationEvents].sort(),
    })).sort((a, b) => a.rootPath.localeCompare(b.rootPath)));
    if (this.lastWorkspaceActivationSignature === signature) return;
    this.lastWorkspaceActivationSignature = signature;
    for (const root of roots) {
      for (const event of root.activationEvents) {
        if (this.activatedEvents.has(event)) continue;
        this.activatedEvents.add(event);
        void this.activateByEvent(event).catch((error) => {
          this.activatedEvents.delete(event);
          console.warn(`[VscodeRuntime] activation failed for ${event}`, error);
        });
      }
    }
  }

  configurationUpdate(key: string, value: unknown, _section?: string): void {
    if (value === undefined) this.configurationValues.delete(key);
    else this.configurationValues.set(key, value);
    void updateUserConfiguration(JSON.stringify({ ...defaultUserConfiguration, ...Object.fromEntries(this.configurationValues) }, null, 2)).catch((error) => {
      console.warn("[VscodeRuntime] failed to update configuration", error);
    });
  }

  async activateByEvent(event: string): Promise<void> {
    await initializeVscodeServices(this.bridge, this.dataDir);
    const extensionService = await getService(IExtensionService);
    await extensionService.activateByEvent(event);
  }

  async executeCommand(command: string, args: unknown[] = []): Promise<unknown> {
    await initializeVscodeServices(this.bridge, this.dataDir);
    const vscode = await import("vscode");
    return vscode.commands.executeCommand(command, ...args);
  }

  private async replaceServiceExtensions(extensions: LoadedExtension[]): Promise<void> {
    await this.disposeRegisteredExtensions();
    this.activatedEvents.clear();
    for (const ext of extensions) {
      const manifest = extensionManifest(ext) as unknown as Record<string, unknown>;
      const serviceManifest = sanitizeServiceManifest(manifest, ext);
      const extensionHostKind = ext.runtime.activationEntry ? ExtensionHostKind.LocalWebWorker : undefined;
      const registration = registerExtension(
        serviceManifest,
        extensionHostKind,
      );
      const registered: RegisteredServiceExtension = {
        registration,
        fileDisposables: [],
        objectUrls: [],
      };
      this.registeredExtensions.push(registered);
      if ("registerFileUrl" in registration) {
        await this.registerExtensionPackageFiles(ext, registration as RegisterLocalExtensionFileUrl, registered);
      }
    }
    await Promise.all(this.registeredExtensions.map(({ registration }) => registration.whenReady().catch((error) => {
      console.warn(`[VscodeRuntime] extension ${registration.id} failed to become ready`, error);
    })));
  }

  private async disposeRegisteredExtensions(): Promise<void> {
    const registrations = this.registeredExtensions.splice(0);
    await Promise.all(registrations.map(async (registered) => {
      for (const disposable of registered.fileDisposables.splice(0)) {
        try {
          disposable.dispose();
        } catch {
          // ignore disposal failures from already-removed extension file entries
        }
      }
      for (const url of registered.objectUrls.splice(0)) {
        URL.revokeObjectURL(url);
      }
      await registered.registration.dispose().catch(() => {});
    }));
  }

  private async registerExtensionPackageFiles(
    ext: LoadedExtension,
    registration: RegisterLocalExtensionFileUrl,
    registered: RegisteredServiceExtension,
  ): Promise<void> {
    const seen = new Set<string>();
    const walk = async (dirPath: string, relativeDir: string): Promise<void> => {
      let entries: FsEntry[];
      try {
        entries = await this.bridge.fs.entries(dirPath);
      } catch (error) {
        console.warn(`[VscodeRuntime] failed to list extension files for ${registration.id}: ${dirPath}`, error);
        return;
      }
      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        const absolutePath = join(dirPath, entry.name);
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.kind === "directory") {
          await walk(absolutePath, relativePath);
          continue;
        }
        if (entry.kind !== "file" && entry.kind !== "symlink") continue;
        await this.registerExtensionPackageFile(registration, registered, seen, absolutePath, relativePath, entry.size);
      }
    };
    await walk(ext.location.dirPath, "");
  }

  private async registerExtensionPackageFile(
    registration: RegisterLocalExtensionFileUrl,
    registered: RegisteredServiceExtension,
    seen: Set<string>,
    absolutePath: string,
    relativePath: string,
    size: number,
  ): Promise<void> {
    const normalizedRelativePath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalizedRelativePath || seen.has(normalizedRelativePath)) return;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await this.bridge.fs.readFile(absolutePath));
    } catch (error) {
      console.warn(`[VscodeRuntime] failed to read extension file ${absolutePath}`, error);
      return;
    }
    const mimeType = extensionFileMimeType(normalizedRelativePath);
    const blobBytes: Uint8Array<ArrayBuffer> =
      bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
        : new Uint8Array(Array.from(bytes));
    const url = URL.createObjectURL(new Blob([blobBytes], { type: mimeType }));
    registered.objectUrls.push(url);
    const registerPath = (path: string) => {
      if (seen.has(path)) return;
      try {
        registered.fileDisposables.push(registration.registerFileUrl(path, url, { mimeType, size: size || bytes.byteLength }));
        seen.add(path);
      } catch {
        // Some VS Code paths normalize to the same extension-file URI. Keeping
        // the first registration is enough.
      }
    };
    registerPath(normalizedRelativePath);
    if (normalizedRelativePath.endsWith(".js")) registerPath(normalizedRelativePath.slice(0, -3));
  }
}

const ExtensionHostClientContext = createContext<ExtensionHostClient | null>(null);

export function ExtensionHostClientProvider({ children }: { children: ReactNode }) {
  const bridgeFactory = useBridgeFactory();
  const uiBridge = useBridge();
  const [extensionBridge, setExtensionBridge] = useState<Bridge | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setExtensionBridge(null);
    setDataDir(null);
    void (async () => {
      const nextBridge = await bridgeFactory({ purpose: "extension-host", workerId: `vscode-runtime-${Date.now().toString(36)}` });
      const dirs = await readAppDirs(nextBridge);
      if (cancelled) return;
      setExtensionBridge(nextBridge);
      setDataDir(dirs.dataDir);
    })().catch((error) => {
      void uiBridge.utils.debugLog?.(`[VscodeRuntime] failed to initialize bridge: ${String(error)}`);
      console.error("[VscodeRuntime] failed to initialize bridge", error);
    });
    return () => {
      cancelled = true;
    };
  }, [bridgeFactory, uiBridge]);

  const client = useMemo(() => {
    if (!extensionBridge || !dataDir) return null;
    return new ExtensionHostClient(extensionBridge, dataDir);
  }, [dataDir, extensionBridge]);

  useEffect(() => {
    if (!client) return;
    return () => client.dispose();
  }, [client]);

  if (!client) return null;
  return createElement(ExtensionHostClientContext.Provider, { value: client }, children);
}

export function useExtensionHostClient(): ExtensionHostClient {
  const value = useContext(ExtensionHostClientContext);
  if (!value) throw new Error("useExtensionHostClient must be used within ExtensionHostClientProvider");
  return value;
}
