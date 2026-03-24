/**
 * Viewer, Editor & FsProvider Registries
 *
 * Resolves which extension should handle a given file
 * based on glob patterns and priority.
 */

import type { ExtensionViewerContribution, ExtensionEditorContribution, ExtensionFsProviderContribution, LoadedExtension } from "./extensions";

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
    const ext = pattern.slice(1); // e.g. ".png"
    return fileName.toLowerCase().endsWith(ext.toLowerCase());
  }

  // Exact match
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

class ViewerRegistry {
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

  getAll(): readonly RegistryEntry<ExtensionViewerContribution>[] {
    return this.entries;
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

class EditorRegistry {
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

  getAll(): readonly RegistryEntry<ExtensionEditorContribution>[] {
    return this.entries;
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

class FsProviderRegistry {
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

export const viewerRegistry = new ViewerRegistry();
export const editorRegistry = new EditorRegistry();
export const fsProviderRegistry = new FsProviderRegistry();

/** Populate registries from loaded extensions. Called when extensions finish loading. */
export function populateRegistries(extensions: LoadedExtension[]): void {
  viewerRegistry.clear();
  editorRegistry.clear();
  fsProviderRegistry.clear();

  for (const ext of extensions) {
    if (ext.viewers) {
      for (const v of ext.viewers) {
        viewerRegistry.register(v, ext.dirPath);
      }
    }
    if (ext.editors) {
      for (const e of ext.editors) {
        editorRegistry.register(e, ext.dirPath);
      }
    }
    if (ext.fsProviders) {
      for (const p of ext.fsProviders) {
        fsProviderRegistry.register(p, ext.dirPath);
      }
    }
  }

  viewerRegistry.notifyListeners();
  editorRegistry.notifyListeners();
  fsProviderRegistry.notifyListeners();
}
