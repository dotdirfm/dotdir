import type { CommandContribution } from "./commands";

export const builtInCommandContributions: CommandContribution[] = [
  // ── View ──────────────────────────────────────────────────────────────────
  { command: "toggleHiddenFiles", title: "Toggle Hidden Files", category: "View" },
  { command: "togglePanels", title: "Toggle Panels", category: "View" },
  { command: "showExtensions", title: "Show Extensions", shortTitle: "Plugins", category: "View" },
  { command: "showCommandPalette", title: "Show All Commands", category: "View" },
  { command: "closeViewer", title: "Close Viewer", category: "View" },
  { command: "closeEditor", title: "Close Editor", category: "View" },

  // ── Navigation ────────────────────────────────────────────────────────────
  { command: "switchPanel", title: "Switch Panel", category: "Navigation" },
  { command: "dotdir.focusLeftPanel", title: "Focus Left Panel", category: "Navigation" },
  { command: "dotdir.focusRightPanel", title: "Focus Right Panel", category: "Navigation" },
  { command: "dotdir.cancelNavigation", title: "Cancel Navigation", category: "Navigation" },

  // ── File ──────────────────────────────────────────────────────────────────
  { command: "newTab", title: "New Tab", category: "File" },
  { command: "closeTab", title: "Close Tab", category: "File" },
  { command: "previewInOppositePanel", title: "Open Quick View in Opposite Panel", shortTitle: "View", category: "File" },
  { command: "editInOppositePanel", title: "Open Editor in Opposite Panel", shortTitle: "Edit", category: "File" },
  { command: "openCurrentDirInOppositePanelCurrentTab", title: "Open Current Directory in Opposite Panel (Current Tab)", category: "File" },
  { command: "openCurrentDirInOppositePanelNewTab", title: "Open Current Directory in Opposite Panel (New Tab)", category: "File" },
  { command: "openSelectedDirInOppositePanelCurrentTab", title: "Open Selected Directory in Opposite Panel (Current Tab)", category: "File" },
  { command: "openSelectedDirInOppositePanelNewTab", title: "Open Selected Directory in Opposite Panel (New Tab)", category: "File" },
  { command: "openCreateFile", title: "Open / Create File", shortTitle: "New File", category: "File" },
  { command: "viewFile", title: "View File", shortTitle: "View", category: "File" },
  { command: "editFile", title: "Edit File", shortTitle: "Edit", category: "File" },

  // ── Application ───────────────────────────────────────────────────────────
  { command: "dotdir.exit", title: "Exit", shortTitle: "Quit", category: "Application" },

  // ── Terminal ──────────────────────────────────────────────────────────────
  { command: "terminal.execute", title: "Execute in Terminal", category: "Terminal" },

  // ── File List ─────────────────────────────────────────────────────────────
  { command: "filelist.goToParent", title: "Go to Parent Directory", category: "File List" },
  { command: "filelist.goHome", title: "Go to Home Directory", category: "File List" },
  { command: "filelist.refresh", title: "Refresh", category: "File List" },
  { command: "filelist.cursorUp", title: "Cursor Up", category: "File List" },
  { command: "filelist.cursorDown", title: "Cursor Down", category: "File List" },
  { command: "filelist.cursorLeft", title: "Cursor Left (Previous Column)", category: "File List" },
  { command: "filelist.cursorRight", title: "Cursor Right (Next Column)", category: "File List" },
  { command: "filelist.cursorHome", title: "Cursor to First", category: "File List" },
  { command: "filelist.cursorEnd", title: "Cursor to Last", category: "File List" },
  { command: "filelist.cursorPageUp", title: "Cursor Page Up", category: "File List" },
  { command: "filelist.cursorPageDown", title: "Cursor Page Down", category: "File List" },
  { command: "filelist.selectUp", title: "Select Up", category: "File List" },
  { command: "filelist.selectDown", title: "Select Down", category: "File List" },
  { command: "filelist.selectLeft", title: "Select Left", category: "File List" },
  { command: "filelist.selectRight", title: "Select Right", category: "File List" },
  { command: "filelist.selectHome", title: "Select to First", category: "File List" },
  { command: "filelist.selectEnd", title: "Select to Last", category: "File List" },
  { command: "filelist.selectPageUp", title: "Select Page Up", category: "File List" },
  { command: "filelist.selectPageDown", title: "Select Page Down", category: "File List" },
  { command: "list.execute", title: "Execute in Terminal", category: "File List" },
  { command: "list.open", title: "Open", category: "File List" },
  { command: "list.viewFile", title: "View File", shortTitle: "View", category: "File List" },
  { command: "list.editFile", title: "Edit File", shortTitle: "Edit", category: "File List" },
  { command: "list.makeDir", title: "Make Directory", shortTitle: "MkDir", category: "File List" },
  { command: "list.moveToTrash", title: "Move to Trash", shortTitle: "Trash", category: "File List" },
  { command: "list.permanentDelete", title: "Permanently Delete", shortTitle: "Del Perm", category: "File List" },
  { command: "list.copy", title: "Copy", shortTitle: "Copy", category: "File List" },
  { command: "list.move", title: "Move", shortTitle: "Move", category: "File List" },
  { command: "list.rename", title: "Rename", shortTitle: "Rename", category: "File List" },
  { command: "pasteFilename", title: "Paste Filename to Command Line", category: "File List" },
  { command: "pastePath", title: "Paste Path to Command Line", category: "File List" },
  { command: "pasteLeftPanelPath", title: "Paste Left Panel Path to Command Line", category: "File List" },
  { command: "pasteRightPanelPath", title: "Paste Right Panel Path to Command Line", category: "File List" },

  // ── Command Line ──────────────────────────────────────────────────────────
  { command: "commandLine.execute", title: "Execute Command Line", category: "Command Line" },
  { command: "commandLine.clear", title: "Clear Command Line", category: "Command Line" },
  { command: "commandLine.deleteLeft", title: "Delete Left", category: "Command Line" },
  { command: "commandLine.deleteRight", title: "Delete Right", category: "Command Line" },
  { command: "commandLine.moveWordLeft", title: "Move Word Left", category: "Command Line" },
  { command: "commandLine.moveWordRight", title: "Move Word Right", category: "Command Line" },
  { command: "commandLine.home", title: "Move to Start", category: "Command Line" },
  { command: "commandLine.end", title: "Move to End", category: "Command Line" },
  { command: "commandLine.selectAll", title: "Select All", category: "Command Line" },
  { command: "commandLine.selectLeft", title: "Extend Selection Left", category: "Command Line" },
  { command: "commandLine.selectRight", title: "Extend Selection Right", category: "Command Line" },
  { command: "commandLine.selectHome", title: "Extend Selection to Start", category: "Command Line" },
  { command: "commandLine.selectEnd", title: "Extend Selection to End", category: "Command Line" },
  { command: "commandLine.copy", title: "Copy Selection", category: "Command Line" },
  { command: "commandLine.cut", title: "Cut Selection", category: "Command Line" },
  { command: "commandLine.paste", title: "Paste from Clipboard", category: "Command Line" },
];
