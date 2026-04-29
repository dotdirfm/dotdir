/**
 * Viewer, Editor & FsProvider Registries
 *
 * Resolves which extension should handle a given file
 * based on glob patterns and priority.
 *
 * The three registries are now backed by a single generic `Registry<T>` class,
 * eliminating ~90 lines of boilerplate.
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
import { Registry, type RegistryListener } from "@/utils/registry";
import { createContext, createElement, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";

const BUILTIN_EXTENSION_DIR_PATH = "__dotdir_builtin__";

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

// Re-export resolved types for backward compatibility.
export type ResolvedViewer = {
  contribution: ExtensionViewerContribution;
  extensionDirPath: string;
};

export type ResolvedEditor = {
  contribution: ExtensionEditorContribution;
  extensionDirPath: string;
};

export type ResolvedFsProvider = {
  contribution: ExtensionFsProviderContribution;
  extensionDirPath: string;
};

export class ViewerEditorRegistryManager {
  readonly viewerRegistry = new Registry<ExtensionViewerContribution>();
  readonly editorRegistry = new Registry<ExtensionEditorContribution>();
  readonly fsProviderRegistry = new Registry<ExtensionFsProviderContribution>();
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

export function useViewerRegistry(): Registry<ExtensionViewerContribution> {
  const manager = useViewerEditorRegistry();
  void useViewerEditorRegistryVersion();
  return manager.viewerRegistry;
}

export function useEditorRegistry(): Registry<ExtensionEditorContribution> {
  const manager = useViewerEditorRegistry();
  void useViewerEditorRegistryVersion();
  return manager.editorRegistry;
}

export function useFsProviderRegistry(): Registry<ExtensionFsProviderContribution> {
  const manager = useViewerEditorRegistry();
  void useViewerEditorRegistryVersion();
  return manager.fsProviderRegistry;
}
