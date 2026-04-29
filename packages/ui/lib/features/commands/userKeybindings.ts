/**
 * User Keybindings
 *
 * Loads and watches user-defined keybindings from the host-provided config dir.
 */

import { useAppDirs } from "@dotdirfm/ui-bridge";
import { useBridge } from "@dotdirfm/ui-bridge";
import { createJsoncFileWatcher, type JsoncFileWatcher } from "@/features/file-system/jsoncFileWatcher";
import { join } from "@dotdirfm/ui-utils";
import { useEffect } from "react";
import { type Keybinding, useCommandRegistry } from "@dotdirfm/commands";

function validateKeybindings(parsed: unknown): Keybinding[] | null {
  if (!Array.isArray(parsed)) {
    console.error("[userKeybindings] keybindings.json must be an array");
    return null;
  }

  return parsed
    .filter((item: unknown): item is Keybinding => {
      if (typeof item !== "object" || item === null) return false;
      const obj = item as Record<string, unknown>;
      return typeof obj.command === "string" && typeof obj.key === "string";
    })
    .map((item) => ({
      command: item.command,
      key: item.key,
      mac: typeof item.mac === "string" ? item.mac : undefined,
      when: typeof item.when === "string" ? item.when : undefined,
      args: "args" in item ? item.args : undefined,
    }));
}

export function useUserKeybindings(): void {
  const bridge = useBridge();
  const { configDir } = useAppDirs();
  const commandRegistry = useCommandRegistry();

  useEffect(() => {
    let watcher: JsoncFileWatcher<Keybinding[]> | null = null;
    let cancelled = false;

    void createJsoncFileWatcher<Keybinding[]>(bridge, {
      name: "userKeybindings",
      getPath: async () => join(configDir, "keybindings.json"),
      validate: validateKeybindings,
      defaultValue: [],
      onLoad: (keybindings) => {
        commandRegistry.setLayerKeybindings("user", keybindings);
        console.log(`[userKeybindings] Applied ${keybindings.length} keybindings`);
      },
    }).then((createdWatcher) => {
      if (cancelled) {
        void createdWatcher.dispose();
        return;
      }
      watcher = createdWatcher;
    });

    return () => {
      cancelled = true;
      void watcher?.dispose();
    };
  }, [bridge, commandRegistry, configDir]);
}
