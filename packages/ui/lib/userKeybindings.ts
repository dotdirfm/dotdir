/**
 * User Keybindings
 *
 * Loads and watches user-defined keybindings from ~/.dotdir/keybindings.json
 */

import { Bridge } from "@/features/bridge";
import { commandRegistry, type Keybinding } from "@/features/commands/commands";
import { createJsoncFileWatcher, type JsoncFileWatcher } from "@/jsoncFileWatcher";
import { join } from "@/utils/path";

let watcher: JsoncFileWatcher<Keybinding[]> | null = null;

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

export async function initUserKeybindings(bridge: Bridge): Promise<void> {
  watcher = await createJsoncFileWatcher<Keybinding[]>(bridge, {
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
  });
}

export async function disposeUserKeybindings(): Promise<void> {
  await watcher?.dispose();
  watcher = null;
}
