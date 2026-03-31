/**
 * User Keybindings
 *
 * Loads and watches user-defined keybindings from ~/.dotdir/keybindings.json
 */

import { useBridge } from "@/features/bridge/useBridge";
import { type Keybinding, useCommandRegistry } from "@/features/commands/commands";
import { createJsoncFileWatcher, type JsoncFileWatcher } from "@/jsoncFileWatcher";
import { join } from "@/utils/path";
import { useEffect } from "react";

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
    }));
}

export function useUserKeybindings(): void {
  const bridge = useBridge();
  const commandRegistry = useCommandRegistry();

  useEffect(() => {
    let watcher: JsoncFileWatcher<Keybinding[]> | null = null;
    let cancelled = false;

    void createJsoncFileWatcher<Keybinding[]>(bridge, {
      name: "userKeybindings",
      getPath: async () => {
        const homePath = await bridge.utils.getHomePath();
        return join(homePath, ".dotdir", "keybindings.json");
      },
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
  }, [bridge, commandRegistry]);
}
