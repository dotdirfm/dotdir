/**
 * JSONC File Watcher
 *
 * Utility for loading and watching JSONC files (JSON with comments).
 * On file change, reloads automatically.
 * On parse error, keeps current value and logs error.
 */

import type { Bridge } from "@dotdirfm/ui-bridge";
import { readFileText } from "@/features/file-system/fs";
import { basename, dirname } from "@dotdirfm/ui-utils";
import type { ParseError} from "jsonc-parser";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

export interface JsoncFileWatcher<T> {
  getValue(): T;
  setValue(value: T): void;
  onChange(callback: (value: T) => void): () => void;
  dispose(): Promise<void>;
}

export interface JsoncFileWatcherOptions<T> {
  name: string;
  getPath: () => Promise<string>;
  validate: (parsed: unknown) => T | null;
  defaultValue: T;
  onLoad?: (value: T) => void;
}

export async function createJsoncFileWatcher<T>(bridge: Bridge, options: JsoncFileWatcherOptions<T>): Promise<JsoncFileWatcher<T>> {
  const { name, getPath, validate, defaultValue, onLoad } = options;

  let currentValue: T = defaultValue;
  let filePath: string | null = null;
  let watchId: string | null = null;
  let unsubscribeFsChange: (() => void) | null = null;
  const listeners = new Set<(value: T) => void>();

  function notifyListeners(): void {
    for (const listener of listeners) {
      try {
        listener(currentValue);
      } catch (err) {
        console.error(`[${name}] Listener error:`, err);
      }
    }
  }

  async function load(): Promise<void> {
    try {
      const path = filePath ?? (await getPath());
      filePath = path;

      const text = await readFileText(bridge, path);
      const errors: ParseError[] = [];
      const parsed = parseJsonc(text, errors, { allowTrailingComma: true });

      if (errors.length > 0) {
        console.error(`[${name}] Parse errors:`);
        for (const err of errors) {
          console.error(`  - ${printParseErrorCode(err.error)} at offset ${err.offset}`);
        }
        return; // Keep current value on parse error
      }

      const validated = validate(parsed);
      if (validated === null) {
        return; // Validation failed, keep current value
      }

      currentValue = validated;
      console.log(`[${name}] Loaded`);
      onLoad?.(currentValue);
      notifyListeners();
    } catch (err: any) {
      if (err && typeof err.message === "string" && (err.message === "ENOENT" || err.message?.includes("not found") || err.name === "NotFoundError")) {
        currentValue = defaultValue;
        onLoad?.(currentValue);
        notifyListeners();
      } else {
        console.error(`[${name}] Failed to load:`, err);
        // Keep current value on error
      }
    }
  }

  async function setupWatch(): Promise<void> {
    try {
      const path = filePath ?? (await getPath());
      filePath = path;

      const dirPath = dirname(path);
      const fileName = basename(path);
      watchId = `${name}-${Date.now()}`;

      await bridge.fs.watch(watchId, dirPath);

      unsubscribeFsChange = bridge.fs.onFsChange((event) => {
        if (event.watchId === watchId && event.name === fileName) {
          console.log(`[${name}] Detected change, reloading...`);
          load();
        }
      });
    } catch (err) {
      console.error(`[${name}] Failed to setup watch:`, err);
    }
  }

  // Initialize
  await load();
  await setupWatch();

  return {
    getValue: () => currentValue,

    setValue(value: T): void {
      currentValue = value;
      // Don't notify listeners - this is for internal updates before saving
    },

    onChange(callback: (value: T) => void): () => void {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    async dispose(): Promise<void> {
      if (unsubscribeFsChange) {
        unsubscribeFsChange();
        unsubscribeFsChange = null;
      }
      if (watchId) {
        try {
          await bridge.fs.unwatch(watchId);
        } catch {
          // Ignore unwatch errors
        }
        watchId = null;
      }
      listeners.clear();
    },
  };
}
