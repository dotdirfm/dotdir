/**
 * vscode.extensions — tracks loaded extensions so `getExtension(id)` /
 * `all` work inside the worker.
 */

import { ExtensionMode } from "./enums";
import { EventEmitter } from "./events";
import type { ExtensionKind } from "./enums";
import type { Uri } from "./types";

export interface ExtensionMetadata {
  id: string;
  extensionUri: Uri;
  extensionPath: string;
  isActive: boolean;
  packageJSON: Record<string, unknown>;
  extensionKind: ExtensionKind;
  exports: unknown;
  activate: () => Promise<unknown>;
}

const registry = new Map<string, ExtensionMetadata>();
export const onDidChangeEmitter = new EventEmitter<void>();

export function registerExtension(ext: ExtensionMetadata): void {
  registry.set(ext.id, ext);
  onDidChangeEmitter.fire();
}

export function markExtensionActive(id: string, exports: unknown): void {
  const ext = registry.get(id);
  if (!ext) return;
  ext.isActive = true;
  ext.exports = exports;
}

export const extensions = {
  get all(): ExtensionMetadata[] {
    return Array.from(registry.values());
  },
  getExtension(id: string): ExtensionMetadata | undefined {
    return registry.get(id);
  },
  onDidChange: onDidChangeEmitter.event,
};

export { ExtensionMode };
