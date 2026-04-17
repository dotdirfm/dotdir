import type { Keybinding, KeybindingLayer } from "@/features/commands/commands";
import { MONACO_QUICK_COMMAND_ACTION } from "@/features/extensions/builtins/monacoCommandBridge";
import {
  ACCEPT,
  CANCEL,
  CLOSE_EDITOR,
  CLOSE_TAB,
  CLOSE_VIEWER,
  COMMANDLINE_COPY,
  COMMANDLINE_CUT,
  COMMANDLINE_EXECUTE,
  COMMANDLINE_PASTE,
  CURSOR_DOCUMENT_END,
  CURSOR_DOCUMENT_START,
  CURSOR_DOWN,
  CURSOR_END,
  CURSOR_HOME,
  CURSOR_LEFT,
  CURSOR_PAGE_DOWN,
  CURSOR_PAGE_UP,
  CURSOR_RIGHT,
  CURSOR_UP,
  CURSOR_WORD_LEFT,
  CURSOR_WORD_RIGHT,
  DELETE_LEFT,
  DELETE_RIGHT,
  DOTDIR_CLOSE_WINDOW,
  DOTDIR_EDITOR_SAVE,
  DOTDIR_EXIT,
  DOTDIR_NEW_WINDOW,
  DOTDIR_OPEN_LEFT_PANEL_MENU,
  DOTDIR_OPEN_RIGHT_PANEL_MENU,
  DOTDIR_PANEL_ESCAPE,
  EDIT_IN_OPPOSITE_PANEL,
  FILELIST_GO_HOME,
  FILELIST_GO_TO_PARENT,
  FILELIST_REFRESH,
  LIST_COPY,
  LIST_EDIT_FILE,
  LIST_EXECUTE,
  LIST_MAKE_DIR,
  LIST_MOVE,
  LIST_MOVE_TO_TRASH,
  LIST_OPEN,
  LIST_PERMANENT_DELETE,
  LIST_RENAME,
  LIST_VIEW_FILE,
  NEW_TAB,
  OPEN_CREATE_FILE,
  PASTE_FILENAME,
  PASTE_LEFT_PANEL_PATH,
  PASTE_PATH,
  PASTE_RIGHT_PANEL_PATH,
  PREVIEW_IN_OPPOSITE_PANEL,
  SELECT_ALL,
  SELECT_DOWN,
  SELECT_END,
  SELECT_HOME,
  SELECT_LEFT,
  SELECT_PAGE_DOWN,
  SELECT_PAGE_UP,
  SELECT_RIGHT,
  SELECT_UP,
  SELECT_WORD_LEFT,
  SELECT_WORD_RIGHT,
  SHOW_COMMAND_PALETTE,
  SHOW_EXTENSIONS,
  SHOW_SETTINGS,
  SHOW_FIND_FILES,
  SWITCH_PANEL,
  TOGGLE_HIDDEN_FILES,
  TOGGLE_PANELS,
} from "./commandIds";

export type Disposable = () => void;

type CommandRegistryLike = {
  registerKeybinding: (binding: Keybinding, layer?: KeybindingLayer) => Disposable;
};

function registerKeybindings(registry: CommandRegistryLike, bindings: Keybinding[], layer: KeybindingLayer): Disposable[] {
  return bindings.map((binding) => registry.registerKeybinding(binding, layer));
}

const appBuiltInKeybindings: Keybinding[] = [
  // View commands
  { command: TOGGLE_HIDDEN_FILES, key: "ctrl+.", mac: "cmd+." },
  { command: TOGGLE_PANELS, key: "ctrl+o", mac: "cmd+o", when: "!terminalCommandRunning" },
  { command: SHOW_EXTENSIONS, key: "f11" },
  { command: SHOW_SETTINGS, key: "f9" },
  { command: SHOW_FIND_FILES, key: "alt+f7", when: "!dialogOpen" },
  { command: DOTDIR_OPEN_LEFT_PANEL_MENU, key: "alt+f1", when: "!dialogOpen" },
  { command: DOTDIR_OPEN_RIGHT_PANEL_MENU, key: "alt+f2", when: "!dialogOpen" },
  { command: DOTDIR_NEW_WINDOW, key: "ctrl+n", mac: "cmd+n", when: "supportsWindowManagement && !dialogOpen" },

  // Navigation commands
  { command: SWITCH_PANEL, key: "tab", when: "focusPanel && !dialogOpen" },
  { command: DOTDIR_PANEL_ESCAPE, key: "escape", when: "focusPanel" },
  { command: FILELIST_GO_TO_PARENT, key: "alt+pageup", when: "focusPanel" },
  { command: FILELIST_GO_HOME, key: "ctrl+home", mac: "cmd+home" },

  // File commands
  { command: NEW_TAB, key: "ctrl+t", mac: "cmd+t", when: "focusPanel" },
  { command: CLOSE_TAB, key: "ctrl+w", mac: "cmd+w", when: "focusPanel" },
  { command: PREVIEW_IN_OPPOSITE_PANEL, key: "ctrl+f3", mac: "ctrl+f3", when: "focusPanel && listItemIsFile" },
  { command: PREVIEW_IN_OPPOSITE_PANEL, key: "cmd+f3", mac: "cmd+f3", when: "focusPanel && listItemIsFile" },
  { command: EDIT_IN_OPPOSITE_PANEL, key: "ctrl+f4", mac: "ctrl+f4", when: "focusPanel && listItemHasEditor" },
  { command: EDIT_IN_OPPOSITE_PANEL, key: "cmd+f4", mac: "cmd+f4", when: "focusPanel && listItemHasEditor" },
  { command: FILELIST_REFRESH, key: "ctrl+r", mac: "cmd+r", when: "focusPanel" },
  { command: OPEN_CREATE_FILE, key: "shift+f4", when: "focusPanel" },
  { command: LIST_MAKE_DIR, key: "f7", when: "focusPanel" },

  // Command palette
  { command: SHOW_COMMAND_PALETTE, key: "f1" },
  { command: MONACO_QUICK_COMMAND_ACTION, key: "ctrl+f1", mac: "cmd+f1", when: "focusEditor" },

  // Close viewer/editor commands
  { command: CLOSE_VIEWER, key: "escape", when: "focusViewer" },
  { command: CLOSE_EDITOR, key: "escape", when: "focusEditor" },
  { command: DOTDIR_EDITOR_SAVE, key: "f2", when: "focusEditor" },
  { command: DOTDIR_EDITOR_SAVE, key: "ctrl+s", mac: "cmd+s", when: "focusEditor" },
  { command: CURSOR_UP, key: "up", when: "focusEditor" },
  { command: CURSOR_DOWN, key: "down", when: "focusEditor" },
  { command: CURSOR_LEFT, key: "left", when: "focusEditor" },
  { command: CURSOR_RIGHT, key: "right", when: "focusEditor" },
  { command: CURSOR_HOME, key: "home", mac: "cmd+left", when: "focusEditor" },
  { command: CURSOR_END, key: "end", mac: "cmd+right", when: "focusEditor" },
  { command: CURSOR_DOCUMENT_START, key: "ctrl+home", mac: "alt+home", when: "focusEditor" },
  { command: CURSOR_DOCUMENT_END, key: "ctrl+end", mac: "alt+end", when: "focusEditor" },
  { command: CURSOR_PAGE_UP, key: "pageup", when: "focusEditor" },
  { command: CURSOR_PAGE_DOWN, key: "pagedown", when: "focusEditor" },
  { command: CURSOR_WORD_LEFT, key: "ctrl+left", mac: "alt+left", when: "focusEditor" },
  { command: CURSOR_WORD_RIGHT, key: "ctrl+right", mac: "alt+right", when: "focusEditor" },
  { command: SELECT_UP, key: "shift+up", when: "focusEditor" },
  { command: SELECT_DOWN, key: "shift+down", when: "focusEditor" },
  { command: SELECT_LEFT, key: "shift+left", when: "focusEditor" },
  { command: SELECT_RIGHT, key: "shift+right", when: "focusEditor" },
  { command: SELECT_HOME, key: "shift+home", mac: "cmd+shift+left", when: "focusEditor" },
  { command: SELECT_END, key: "shift+end", mac: "cmd+shift+right", when: "focusEditor" },
  { command: SELECT_PAGE_UP, key: "shift+pageup", when: "focusEditor" },
  { command: SELECT_PAGE_DOWN, key: "shift+pagedown", when: "focusEditor" },
  { command: SELECT_WORD_LEFT, key: "ctrl+shift+left", mac: "alt+shift+left", when: "focusEditor" },
  { command: SELECT_WORD_RIGHT, key: "ctrl+shift+right", mac: "alt+shift+right", when: "focusEditor" },
  { command: SELECT_ALL, key: "ctrl+a", mac: "cmd+a", when: "focusEditor" },

  // Exit command
  { command: DOTDIR_CLOSE_WINDOW, key: "f10", when: "supportsWindowManagement" },
  { command: DOTDIR_EXIT, key: "f10", when: "!supportsWindowManagement" },
  { command: DOTDIR_EXIT, key: "cmd+q", mac: "cmd+q" },
];

const commandLineKeybindings: Keybinding[] = [
  { command: COMMANDLINE_EXECUTE, key: "enter", when: "focusPanel && commandLineHasText" },
  { command: DELETE_LEFT, key: "backspace", when: "focusPanel && commandLineHasText" },
  { command: DELETE_RIGHT, key: "delete", when: "focusPanel && commandLineHasText" },
  { command: CURSOR_WORD_LEFT, key: "ctrl+left", mac: "cmd+alt+left", when: "focusPanel && commandLineHasText" },
  { command: CURSOR_WORD_RIGHT, key: "ctrl+right", mac: "cmd+alt+right", when: "focusPanel && commandLineHasText" },
  { command: CURSOR_LEFT, key: "left", mac: "cmd+left", when: "focusPanel && commandLineHasText" },
  { command: CURSOR_RIGHT, key: "right", mac: "cmd+right", when: "focusPanel && commandLineHasText" },
  { command: CURSOR_HOME, key: "home", when: "focusPanel && commandLineHasText" },
  { command: CURSOR_END, key: "end", when: "focusPanel && commandLineHasText" },
  { command: SELECT_LEFT, key: "ctrl+shift+left", mac: "cmd+shift+left", when: "focusPanel && commandLineHasText" },
  { command: SELECT_RIGHT, key: "ctrl+shift+right", mac: "cmd+shift+right", when: "focusPanel && commandLineHasText" },
  { command: SELECT_WORD_LEFT, key: "ctrl+alt+shift+left", mac: "cmd+alt+shift+left", when: "focusPanel && commandLineHasText" },
  { command: SELECT_WORD_RIGHT, key: "ctrl+alt+shift+right", mac: "cmd+alt+shift+right", when: "focusPanel && commandLineHasText" },
  { command: SELECT_ALL, key: "ctrl+a", when: "focusPanel && commandLineHasText" },
  { command: COMMANDLINE_COPY, key: "ctrl+c", when: "focusPanel && commandLineHasText" },
  { command: COMMANDLINE_CUT, key: "ctrl+x", when: "focusPanel && commandLineHasText" },
  { command: COMMANDLINE_PASTE, key: "ctrl+v", when: "focusPanel" },
];

const fileListKeybindings: Keybinding[] = [
  // Cursor/navigation
  { command: CURSOR_UP, key: "up", when: "focusPanel" },
  { command: CURSOR_UP, key: "up", when: "focusMenu" },
  { command: CURSOR_DOWN, key: "down", when: "focusPanel" },
  { command: CURSOR_DOWN, key: "down", when: "focusMenu" },
  { command: CURSOR_LEFT, key: "left", when: "focusPanel" },
  { command: CURSOR_LEFT, key: "left", when: "focusMenu" },
  { command: CURSOR_RIGHT, key: "right", when: "focusPanel" },
  { command: CURSOR_RIGHT, key: "right", when: "focusMenu" },
  { command: CURSOR_HOME, key: "home", when: "focusPanel" },
  { command: CURSOR_HOME, key: "home", when: "focusMenu" },
  { command: CURSOR_END, key: "end", when: "focusPanel" },
  { command: CURSOR_END, key: "end", when: "focusMenu" },
  { command: CURSOR_PAGE_UP, key: "pageup", when: "focusPanel" },
  { command: CURSOR_PAGE_UP, key: "pageup", when: "focusMenu" },
  { command: CURSOR_PAGE_DOWN, key: "pagedown", when: "focusPanel" },
  { command: CURSOR_PAGE_DOWN, key: "pagedown", when: "focusMenu" },
  { command: CURSOR_UP, key: "up", when: "focusCommandPalette" },
  { command: CURSOR_UP, key: "up", when: "focusAutocomplete" },
  { command: CURSOR_UP, key: "up", when: "focusSearchResults" },
  { command: CURSOR_DOWN, key: "down", when: "focusCommandPalette" },
  { command: CURSOR_DOWN, key: "down", when: "focusAutocomplete" },
  { command: CURSOR_DOWN, key: "down", when: "focusSearchResults" },
  { command: CURSOR_HOME, key: "home", when: "focusCommandPalette" },
  { command: CURSOR_HOME, key: "home", when: "focusAutocomplete" },
  { command: CURSOR_HOME, key: "home", when: "focusSearchResults" },
  { command: CURSOR_END, key: "end", when: "focusCommandPalette" },
  { command: CURSOR_END, key: "end", when: "focusAutocomplete" },
  { command: CURSOR_END, key: "end", when: "focusSearchResults" },
  { command: CURSOR_PAGE_UP, key: "pageup", when: "focusCommandPalette" },
  { command: CURSOR_PAGE_UP, key: "pageup", when: "focusAutocomplete" },
  { command: CURSOR_PAGE_UP, key: "pageup", when: "focusSearchResults" },
  { command: CURSOR_PAGE_DOWN, key: "pagedown", when: "focusCommandPalette" },
  { command: CURSOR_PAGE_DOWN, key: "pagedown", when: "focusAutocomplete" },
  { command: CURSOR_PAGE_DOWN, key: "pagedown", when: "focusSearchResults" },
  { command: ACCEPT, key: "enter", when: "focusMenu" },
  { command: ACCEPT, key: "enter", when: "focusCommandPalette" },
  { command: ACCEPT, key: "enter", when: "focusAutocomplete" },
  { command: ACCEPT, key: "enter", when: "focusSearchResults" },
  { command: ACCEPT, key: "tab", when: "focusAutocomplete" },
  { command: CANCEL, key: "escape", when: "focusMenu" },
  { command: CANCEL, key: "escape", when: "focusCommandPalette" },
  { command: CANCEL, key: "escape", when: "focusAutocomplete" },
  { command: CANCEL, key: "escape", when: "focusSearchResults" },

  // Selection commands (Shift+Arrow)
  { command: SELECT_UP, key: "shift+up", when: "focusPanel" },
  { command: SELECT_DOWN, key: "shift+down", when: "focusPanel" },
  { command: SELECT_LEFT, key: "shift+left", when: "focusPanel" },
  { command: SELECT_RIGHT, key: "shift+right", when: "focusPanel" },
  { command: SELECT_HOME, key: "shift+home", when: "focusPanel" },
  { command: SELECT_END, key: "shift+end", when: "focusPanel" },
  { command: SELECT_PAGE_UP, key: "shift+pageup", when: "focusPanel" },
  { command: SELECT_PAGE_DOWN, key: "shift+pagedown", when: "focusPanel" },

  // Execute/open
  { command: LIST_EXECUTE, key: "enter", when: "focusPanel && listItemIsExecutable && !commandLineHasText" },
  { command: LIST_OPEN, key: "enter", when: "focusPanel && !listItemIsExecutable && !commandLineHasText" },
  { command: LIST_OPEN, key: "alt+pagedown", when: "focusPanel" },

  // Viewer/editor
  { command: LIST_VIEW_FILE, key: "f3", when: "focusPanel && listItemHasViewer" },
  { command: LIST_EDIT_FILE, key: "f4", when: "focusPanel && listItemHasEditor" },

  // File ops
  { command: LIST_MOVE_TO_TRASH, key: "f8", when: "focusPanel" },
  { command: LIST_PERMANENT_DELETE, key: "shift+delete", when: "focusPanel" },
  { command: LIST_COPY, key: "f5", when: "focusPanel" },
  { command: LIST_MOVE, key: "f6", when: "focusPanel" },
  { command: LIST_RENAME, key: "shift+f6", when: "focusPanel" },

  // Command line paste helpers
  { command: PASTE_FILENAME, key: "ctrl+enter", when: "focusPanel" },
  { command: PASTE_PATH, key: "ctrl+f", when: "focusPanel" },
  { command: PASTE_LEFT_PANEL_PATH, key: "ctrl+[", when: "focusPanel" },
  { command: PASTE_RIGHT_PANEL_PATH, key: "ctrl+]", when: "focusPanel" },
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
