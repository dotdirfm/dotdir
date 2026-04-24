/**
 * Viewer, Editor & FsProvider Registries
 *
 * Resolves which extension should handle a given file
 * based on glob patterns and priority.
 */

import {
  extensionDirPath,
  extensionEditors,
  extensionFsProviders,
  extensionViewers,
  type ExtensionEditorContribution,
  type ExtensionFsProviderContribution,
  type ExtensionViewerContribution,
  type LoadedExtension,
} from "@/features/extensions/types";
import { createContext, createElement, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";

export const BUILTIN_EXTENSION_DIR_PATH = "__dotdir_builtin__";

export function isBuiltInExtensionDirPath(extensionDirPath: string): boolean {
  return extensionDirPath === BUILTIN_EXTENSION_DIR_PATH;
}

const BUILTIN_FILE_VIEWER: ExtensionViewerContribution = {
  id: "file-viewer",
  label: "File Viewer",
  patterns: ["*"],
  entry: "builtins/file-viewer",
  priority: -10_000,
};

const BUILTIN_MONACO_EDITOR: ExtensionEditorContribution = {
  id: "monaco",
  label: "Monaco Editor",
  patterns: ["*"],
  entry: "builtins/monaco",
  priority: -10_000,
};

export interface ResolvedViewer {
  contribution: ExtensionViewerContribution;
  extensionDirPath: string;
}

export interface ResolvedEditor {
  contribution: ExtensionEditorContribution;
  extensionDirPath: string;
}

export interface ResolvedFsProvider {
  contribution: ExtensionFsProviderContribution;
  extensionDirPath: string;
}

interface RegistryEntry<T> {
  contribution: T;
  extensionDirPath: string;
}

function matchPattern(pattern: string, fileName: string): boolean {
  if (pattern === "*" || pattern === "*.*") return true;

  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1);
    return fileName.toLowerCase().endsWith(ext.toLowerCase());
  }

  return fileName.toLowerCase() === pattern.toLowerCase();
}

function matchesAny(patterns: string[], fileName: string): boolean {
  return patterns.some((p) => matchPattern(p, fileName));
}

function resolve<T extends { patterns: string[]; priority?: number }>(entries: RegistryEntry<T>[], fileName: string): RegistryEntry<T> | null {
  const matches = entries.filter((e) => matchesAny(e.contribution.patterns, fileName));
  if (matches.length === 0) return null;
  matches.sort((a, b) => (b.contribution.priority ?? 0) - (a.contribution.priority ?? 0));
  return matches[0];
}

type RegistryListener = () => void;

export class ViewerRegistry {
  private entries: RegistryEntry<ExtensionViewerContribution>[] = [];
  private listeners = new Set<RegistryListener>();

  clear(): void {
    this.entries = [];
  }

  register(contribution: ExtensionViewerContribution, extensionDirPath: string): void {
    this.entries.push({ contribution, extensionDirPath });
  }

  resolve(fileName: string): ResolvedViewer | null {
    return resolve(this.entries, fileName);
  }

  onChange(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notifyListeners(): void {
    for (const listener of this.listeners) listener();
  }
}

export class EditorRegistry {
  private entries: RegistryEntry<ExtensionEditorContribution>[] = [];
  private listeners = new Set<RegistryListener>();

  clear(): void {
    this.entries = [];
  }

  register(contribution: ExtensionEditorContribution, extensionDirPath: string): void {
    this.entries.push({ contribution, extensionDirPath });
  }

  resolve(fileName: string): ResolvedEditor | null {
    return resolve(this.entries, fileName);
  }

  onChange(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notifyListeners(): void {
    for (const listener of this.listeners) listener();
  }
}

export class FsProviderRegistry {
  private entries: RegistryEntry<ExtensionFsProviderContribution>[] = [];
  private listeners = new Set<RegistryListener>();

  clear(): void {
    this.entries = [];
  }

  register(contribution: ExtensionFsProviderContribution, extensionDirPath: string): void {
    this.entries.push({ contribution, extensionDirPath });
  }

  resolve(fileName: string): ResolvedFsProvider | null {
    return resolve(this.entries, fileName);
  }

  onChange(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notifyListeners(): void {
    for (const listener of this.listeners) listener();
  }
}

export class ViewerEditorRegistryManager {
  readonly viewerRegistry = new ViewerRegistry();
  readonly editorRegistry = new EditorRegistry();
  readonly fsProviderRegistry = new FsProviderRegistry();
  private version = 0;
  private listeners = new Set<RegistryListener>();

  constructor() {
    this.registerBuiltIns();
  }

  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): number {
    return this.version;
  }

  private registerBuiltIns(): void {
    this.viewerRegistry.register(BUILTIN_FILE_VIEWER, BUILTIN_EXTENSION_DIR_PATH);
    this.editorRegistry.register(BUILTIN_MONACO_EDITOR, BUILTIN_EXTENSION_DIR_PATH);
  }

  replaceExtensions(extensions: LoadedExtension[]): void {
    this.viewerRegistry.clear();
    this.editorRegistry.clear();
    this.fsProviderRegistry.clear();
    this.registerBuiltIns();

    for (const ext of extensions) {
      for (const viewer of extensionViewers(ext)) {
        this.viewerRegistry.register(viewer, extensionDirPath(ext));
      }
      for (const editor of extensionEditors(ext)) {
        this.editorRegistry.register(editor, extensionDirPath(ext));
      }
      for (const provider of extensionFsProviders(ext)) {
        this.fsProviderRegistry.register(provider, extensionDirPath(ext));
      }
    }

    this.viewerRegistry.notifyListeners();
    this.editorRegistry.notifyListeners();
    this.fsProviderRegistry.notifyListeners();
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

const ViewerEditorRegistryContext = createContext<ViewerEditorRegistryManager | null>(null);

export function ViewerEditorRegistryProvider({ children }: { children: ReactNode }) {
  const managerRef = useRef<ViewerEditorRegistryManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = new ViewerEditorRegistryManager();
  }
  return createElement(ViewerEditorRegistryContext.Provider, { value: managerRef.current }, children);
}

export function useViewerEditorRegistry(): ViewerEditorRegistryManager {
  const value = useContext(ViewerEditorRegistryContext);
  if (!value) {
    throw new Error("useViewerEditorRegistry must be used within ViewerEditorRegistryProvider");
  }
  return value;
}

function useViewerEditorRegistryVersion(): number {
  const manager = useViewerEditorRegistry();
  return useSyncExternalStore(
    (listener) => manager.subscribe(listener),
    () => manager.getVersion(),
    () => manager.getVersion(),
  );
}

export function useViewerRegistry(): ViewerRegistry {
  const manager = useViewerEditorRegistry();
  void useViewerEditorRegistryVersion();
  return manager.viewerRegistry;
}

export function useEditorRegistry(): EditorRegistry {
  const manager = useViewerEditorRegistry();
  void useViewerEditorRegistryVersion();
  return manager.editorRegistry;
}

export function useFsProviderRegistry(): FsProviderRegistry {
  const manager = useViewerEditorRegistry();
  void useViewerEditorRegistryVersion();
  return manager.fsProviderRegistry;
}
