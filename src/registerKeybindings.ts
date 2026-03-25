import type { Keybinding, KeybindingLayer } from "./commands";

export type Disposable = () => void;

type CommandRegistryLike = {
  registerKeybinding: (binding: Keybinding, layer?: KeybindingLayer) => Disposable;
};

function registerKeybindings(registry: CommandRegistryLike, bindings: Keybinding[], layer: KeybindingLayer): Disposable[] {
  return bindings.map((binding) => registry.registerKeybinding(binding, layer));
}

const appBuiltInKeybindings: Keybinding[] = [
  // View commands
  { command: "faraday.toggleHiddenFiles", key: "ctrl+.", mac: "cmd+." },
  { command: "faraday.togglePanels", key: "ctrl+o", mac: "cmd+o", when: "!terminalCommandRunning" },
  { command: "faraday.showExtensions", key: "f11" },

  // Navigation commands
  { command: "faraday.switchPanel", key: "tab", when: "focusPanel && !dialogOpen" },
  { command: "faraday.cancelNavigation", key: "escape", when: "focusPanel" },
  { command: "faraday.goToParent", key: "alt+pageup", when: "focusPanel" },
  { command: "faraday.goHome", key: "ctrl+home", mac: "cmd+home" },

  // File commands
  { command: "faraday.newTab", key: "ctrl+t", mac: "cmd+t", when: "focusPanel" },
  { command: "faraday.closeTab", key: "ctrl+w", mac: "cmd+w", when: "focusPanel" },
  { command: "faraday.previewInOppositePanel", key: "ctrl+shift+o", mac: "cmd+shift+o", when: "focusPanel && listItemIsFile" },
  { command: "faraday.refresh", key: "ctrl+r", mac: "cmd+r", when: "focusPanel" },
  { command: "faraday.openCreateFile", key: "shift+f4", when: "focusPanel" },
  { command: "faraday.makeFolder", key: "f7", when: "focusPanel" },

  // Command palette
  { command: "faraday.showCommandPalette", key: "cmd+shift+p" },
  { command: "faraday.showCommandPalette", key: "cmd+p" },

  // Close viewer/editor commands
  { command: "faraday.closeViewer", key: "escape", when: "focusViewer" },
  { command: "faraday.closeEditor", key: "escape", when: "focusEditor" },

  // Exit command
  { command: "faraday.exit", key: "f10" },
  { command: "faraday.exit", key: "cmd+q", mac: "cmd+q" },
];

const commandLineKeybindings: Keybinding[] = [
  { command: "commandLine.execute", key: "enter", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.clear", key: "escape", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.deleteLeft", key: "backspace", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.deleteRight", key: "delete", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.moveWordLeft", key: "ctrl+left", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.moveWordRight", key: "ctrl+right", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.home", key: "home", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.end", key: "end", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.selectAll", key: "ctrl+a", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.copy", key: "ctrl+c", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.cut", key: "ctrl+x", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.paste", key: "ctrl+v", when: "focusPanel" },
];

const fileListKeybindings: Keybinding[] = [
  // Cursor/navigation
  { command: "list.cursorUp", key: "up", when: "focusPanel" },
  { command: "list.cursorDown", key: "down", when: "focusPanel" },
  { command: "list.cursorLeft", key: "left", when: "focusPanel" },
  { command: "list.cursorRight", key: "right", when: "focusPanel" },
  { command: "list.cursorHome", key: "home", when: "focusPanel" },
  { command: "list.cursorEnd", key: "end", when: "focusPanel" },
  { command: "list.cursorPageUp", key: "pageup", when: "focusPanel" },
  { command: "list.cursorPageDown", key: "pagedown", when: "focusPanel" },

  // Selection commands (Shift+Arrow)
  { command: "list.selectUp", key: "shift+up", when: "focusPanel" },
  { command: "list.selectDown", key: "shift+down", when: "focusPanel" },
  { command: "list.selectLeft", key: "shift+left", when: "focusPanel" },
  { command: "list.selectRight", key: "shift+right", when: "focusPanel" },
  { command: "list.selectHome", key: "shift+home", when: "focusPanel" },
  { command: "list.selectEnd", key: "shift+end", when: "focusPanel" },
  { command: "list.selectPageUp", key: "shift+pageup", when: "focusPanel" },
  { command: "list.selectPageDown", key: "shift+pagedown", when: "focusPanel" },

  // Execute/open
  { command: "list.execute", key: "enter", when: "focusPanel && listItemIsExecutable && !commandLineHasText" },
  { command: "list.open", key: "enter", when: "focusPanel && !listItemIsExecutable && !commandLineHasText" },
  { command: "list.open", key: "alt+pagedown", when: "focusPanel" },

  // Viewer/editor
  { command: "list.viewFile", key: "f3", when: "focusPanel && listItemHasViewer" },
  { command: "list.editFile", key: "f4", when: "focusPanel && listItemHasEditor" },

  // File ops
  { command: "list.moveToTrash", key: "f8", when: "focusPanel" },
  { command: "list.permanentDelete", key: "shift+delete", when: "focusPanel" },
  { command: "list.copy", key: "f5", when: "focusPanel" },
  { command: "list.move", key: "f6", when: "focusPanel" },
  { command: "list.rename", key: "shift+f6", when: "focusPanel" },

  // Command line paste helpers
  { command: "list.pasteFilename", key: "ctrl+enter", when: "focusPanel" },
  { command: "list.pastePath", key: "ctrl+f", when: "focusPanel" },
];

export function registerAppBuiltInKeybindings(registry: CommandRegistryLike): Disposable[] {
  // Built-ins live on the default layer.
  return bindingsOnLayer(registry, appBuiltInKeybindings, "default");
}

export function registerCommandLineKeybindings(registry: CommandRegistryLike): Disposable[] {
  return bindingsOnLayer(registry, commandLineKeybindings, "default");
}

export function registerFileListKeybindings(registry: CommandRegistryLike): Disposable[] {
  return bindingsOnLayer(registry, fileListKeybindings, "default");
}

function bindingsOnLayer(registry: CommandRegistryLike, bindings: Keybinding[], layer: KeybindingLayer): Disposable[] {
  return registerKeybindings(registry, bindings, layer);
}

export function registerExtensionKeybinding(registry: CommandRegistryLike, binding: Keybinding): Disposable {
  return registry.registerKeybinding(binding, "extension");
}

export function registerExtensionKeybindings(registry: CommandRegistryLike, bindings: Keybinding[]): Disposable[] {
  return registerKeybindings(registry, bindings, "extension");
}

