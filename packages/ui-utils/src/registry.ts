/**
 * Generic registry with pattern-based file-name resolution.
 *
 * Used by the viewer, editor, and fsProvider registries which all share the
 * same structure: register contributions with glob-like patterns, then resolve
 * the best matching entry for a given file name.
 */

export type RegistryListener = () => void;

/** A contribution must have at least patterns and an optional priority. */
export interface PatternContribution {
  patterns: string[];
  priority?: number;
}

export interface RegistryEntry<T extends PatternContribution> {
  contribution: T;
  extensionDirPath: string;
}

export type ResolvedResult<T extends PatternContribution> = RegistryEntry<T> | null;

function matchExtension(pattern: string, fileName: string): boolean {
  if (pattern === "*" || pattern === "*.*") return true;
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1);
    return fileName.toLowerCase().endsWith(ext.toLowerCase());
  }
  return fileName.toLowerCase() === pattern.toLowerCase();
}

function matchesAny(patterns: string[], fileName: string): boolean {
  return patterns.some((p) => matchExtension(p, fileName));
}

function resolveEntry<T extends PatternContribution>(
  entries: RegistryEntry<T>[],
  fileName: string,
): RegistryEntry<T> | null {
  const matches = entries.filter((e) => matchesAny(e.contribution.patterns, fileName));
  if (matches.length === 0) return null;
  matches.sort((a, b) => (b.contribution.priority ?? 0) - (a.contribution.priority ?? 0));
  return matches[0]!;
}

/**
 * A pattern-matching registry that maps file names (by extension/glob) to
 * registered contributions.
 *
 * ```ts
 * const registry = new Registry<ExtensionViewerContribution>();
 * registry.register({ patterns: ["*.jpg"], id: "jpeg-viewer", ... }, "/ext/jpeg");
 * registry.resolve("photo.jpg"); // => { contribution: {...}, extensionDirPath: "/ext/jpeg" }
 * ```
 */
export class Registry<T extends PatternContribution> {
  private entries: RegistryEntry<T>[] = [];
  private listeners = new Set<RegistryListener>();

  /** Remove all entries. */
  clear(): void {
    this.entries = [];
  }

  /** Register a contribution associated with an extension directory. */
  register(contribution: T, extensionDirPath: string): void {
    this.entries.push({ contribution, extensionDirPath });
  }

  /** Find the best-matching entry for a file name, or null. */
  resolve(fileName: string): ResolvedResult<T> {
    return resolveEntry(this.entries, fileName);
  }

  /** Subscribe to structural changes (register/clear). */
  onChange(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Notify all subscribers. */
  notifyListeners(): void {
    for (const listener of this.listeners) listener();
  }
}
