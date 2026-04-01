import type { Keybinding, KeybindingLayer } from "@/features/commands/commands";

export type Disposable = () => void;

type CommandRegistryLike = {
  registerKeybinding: (binding: Keybinding, layer?: KeybindingLayer) => Disposable;
};

function registerKeybindings(registry: CommandRegistryLike, bindings: Keybinding[], layer: KeybindingLayer): Disposable[] {
  return bindings.map((binding) => registry.registerKeybinding(binding, layer));
}

const appBuiltInKeybindings: Keybinding[] = [
  // View commands
  { command: "toggleHiddenFiles", key: "ctrl+.", mac: "cmd+." },
  { command: "togglePanels", key: "ctrl+o", mac: "cmd+o", when: "!terminalCommandRunning" },
  { command: "showExtensions", key: "f11" },

  // Navigation commands
  { command: "switchPanel", key: "tab", when: "focusPanel && !dialogOpen" },
  { command: "dotdir.cancelNavigation", key: "escape", when: "focusPanel && !commandLineHasText" },
  { command: "filelist.goToParent", key: "alt+pageup", when: "focusPanel" },
  { command: "filelist.goHome", key: "ctrl+home", mac: "cmd+home" },

  // File commands
  { command: "newTab", key: "ctrl+t", mac: "cmd+t", when: "focusPanel" },
  { command: "closeTab", key: "ctrl+w", mac: "cmd+w", when: "focusPanel" },
  { command: "previewInOppositePanel", key: "ctrl+f3", mac: "cmd+f3", when: "focusPanel && listItemIsFile" },
  { command: "editInOppositePanel", key: "ctrl+f4", mac: "cmd+f4", when: "focusPanel && listItemHasEditor" },
  { command: "filelist.refresh", key: "ctrl+r", mac: "cmd+r", when: "focusPanel" },
  { command: "openCreateFile", key: "shift+f4", when: "focusPanel" },
  { command: "list.makeDir", key: "f7", when: "focusPanel" },

  // Command palette
  { command: "showCommandPalette", key: "cmd+shift+p" },
  { command: "showCommandPalette", key: "cmd+p" },

  // Close viewer/editor commands
  { command: "closeViewer", key: "escape", when: "focusViewer" },
  { command: "closeEditor", key: "escape", when: "focusEditor" },

  // Exit command
  { command: "dotdir.exit", key: "f10" },
  { command: "dotdir.exit", key: "cmd+q", mac: "cmd+q" },
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
  { command: "filelist.cursorUp", key: "up", when: "focusPanel" },
  { command: "filelist.cursorDown", key: "down", when: "focusPanel" },
  { command: "filelist.cursorLeft", key: "left", when: "focusPanel" },
  { command: "filelist.cursorRight", key: "right", when: "focusPanel" },
  { command: "filelist.cursorHome", key: "home", when: "focusPanel" },
  { command: "filelist.cursorEnd", key: "end", when: "focusPanel" },
  { command: "filelist.cursorPageUp", key: "pageup", when: "focusPanel" },
  { command: "filelist.cursorPageDown", key: "pagedown", when: "focusPanel" },

  // Selection commands (Shift+Arrow)
  { command: "filelist.selectUp", key: "shift+up", when: "focusPanel" },
  { command: "filelist.selectDown", key: "shift+down", when: "focusPanel" },
  { command: "filelist.selectLeft", key: "shift+left", when: "focusPanel" },
  { command: "filelist.selectRight", key: "shift+right", when: "focusPanel" },
  { command: "filelist.selectHome", key: "shift+home", when: "focusPanel" },
  { command: "filelist.selectEnd", key: "shift+end", when: "focusPanel" },
  { command: "filelist.selectPageUp", key: "shift+pageup", when: "focusPanel" },
  { command: "filelist.selectPageDown", key: "shift+pagedown", when: "focusPanel" },

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
  { command: "pasteFilename", key: "ctrl+enter", when: "focusPanel" },
  { command: "pastePath", key: "ctrl+f", when: "focusPanel" },
  { command: "pasteLeftPanelPath", key: "ctrl+[", when: "focusPanel" },
  { command: "pasteRightPanelPath", key: "ctrl+]", when: "focusPanel" },
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
