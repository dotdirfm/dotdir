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
  { command: "dotdir.openLeftPanelMenu", key: "alt+f1", when: "!dialogOpen" },
  { command: "dotdir.openRightPanelMenu", key: "alt+f2", when: "!dialogOpen" },
  { command: "dotdir.newWindow", key: "ctrl+n", mac: "cmd+n", when: "supportsWindowManagement && !dialogOpen" },

  // Navigation commands
  { command: "switchPanel", key: "tab", when: "focusPanel && !dialogOpen" },
  { command: "dotdir.panelEscape", key: "escape", when: "focusPanel" },
  { command: "filelist.goToParent", key: "alt+pageup", when: "focusPanel" },
  { command: "filelist.goHome", key: "ctrl+home", mac: "cmd+home" },

  // File commands
  { command: "newTab", key: "ctrl+t", mac: "cmd+t", when: "focusPanel" },
  { command: "closeTab", key: "ctrl+w", mac: "cmd+w", when: "focusPanel" },
  { command: "previewInOppositePanel", key: "ctrl+f3", mac: "ctrl+f3", when: "focusPanel && listItemIsFile" },
  { command: "previewInOppositePanel", key: "cmd+f3", mac: "cmd+f3", when: "focusPanel && listItemIsFile" },
  { command: "editInOppositePanel", key: "ctrl+f4", mac: "ctrl+f4", when: "focusPanel && listItemHasEditor" },
  { command: "editInOppositePanel", key: "cmd+f4", mac: "cmd+f4", when: "focusPanel && listItemHasEditor" },
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
  { command: "dotdir.closeWindow", key: "f10", when: "supportsWindowManagement" },
  { command: "dotdir.exit", key: "f10", when: "!supportsWindowManagement" },
  { command: "dotdir.exit", key: "cmd+q", mac: "cmd+q" },
];

const commandLineKeybindings: Keybinding[] = [
  { command: "commandLine.execute", key: "enter", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.deleteLeft", key: "backspace", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.deleteRight", key: "delete", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.moveWordLeft", key: "ctrl+left", mac: "cmd+alt+left", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.moveWordRight", key: "ctrl+right", mac: "cmd+alt+right", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.left", key: "left", mac: "cmd+left", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.right", key: "right", mac: "cmd+right", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.home", key: "home", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.end", key: "end", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.selectLeft", key: "ctrl+shift+left", mac: "cmd+shift+left", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.selectRight", key: "ctrl+shift+right", mac: "cmd+shift+right", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.selectWordLeft", key: "ctrl+alt+shift+left", mac: "cmd+alt+shift+left", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.selectWordRight", key: "ctrl+alt+shift+right", mac: "cmd+alt+shift+right", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.selectAll", key: "ctrl+a", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.copy", key: "ctrl+c", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.cut", key: "ctrl+x", when: "focusPanel && commandLineHasText" },
  { command: "commandLine.paste", key: "ctrl+v", when: "focusPanel" },
];

const fileListKeybindings: Keybinding[] = [
  // Cursor/navigation
  { command: "cursorUp", key: "up", when: "focusPanel" },
  { command: "cursorUp", key: "up", when: "focusMenu" },
  { command: "cursorDown", key: "down", when: "focusPanel" },
  { command: "cursorDown", key: "down", when: "focusMenu" },
  { command: "cursorLeft", key: "left", when: "focusPanel" },
  { command: "cursorLeft", key: "left", when: "focusMenu" },
  { command: "cursorRight", key: "right", when: "focusPanel" },
  { command: "cursorRight", key: "right", when: "focusMenu" },
  { command: "cursorHome", key: "home", when: "focusPanel" },
  { command: "cursorHome", key: "home", when: "focusMenu" },
  { command: "cursorEnd", key: "end", when: "focusPanel" },
  { command: "cursorEnd", key: "end", when: "focusMenu" },
  { command: "cursorPageUp", key: "pageup", when: "focusPanel" },
  { command: "cursorPageUp", key: "pageup", when: "focusMenu" },
  { command: "cursorPageDown", key: "pagedown", when: "focusPanel" },
  { command: "cursorPageDown", key: "pagedown", when: "focusMenu" },
  { command: "cancel", key: "escape", when: "focusMenu" },

  // Selection commands (Shift+Arrow)
  { command: "selectUp", key: "shift+up", when: "focusPanel" },
  { command: "selectDown", key: "shift+down", when: "focusPanel" },
  { command: "selectLeft", key: "shift+left", when: "focusPanel" },
  { command: "selectRight", key: "shift+right", when: "focusPanel" },
  { command: "selectHome", key: "shift+home", when: "focusPanel" },
  { command: "selectEnd", key: "shift+end", when: "focusPanel" },
  { command: "selectPageUp", key: "shift+pageup", when: "focusPanel" },
  { command: "selectPageDown", key: "shift+pagedown", when: "focusPanel" },

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
