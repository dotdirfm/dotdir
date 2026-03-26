import type { CommandContribution } from "./commands";

export const builtInCommandContributions: CommandContribution[] = [
  // ── View ──────────────────────────────────────────────────────────────────
  { command: "faraday.toggleHiddenFiles", title: "Toggle Hidden Files", category: "View" },
  { command: "faraday.togglePanels", title: "Toggle Panels", category: "View" },
  { command: "faraday.showExtensions", title: "Show Extensions", shortTitle: "Plugins", category: "View" },
  { command: "faraday.showCommandPalette", title: "Show All Commands", category: "View" },
  { command: "faraday.closeViewer", title: "Close Viewer", category: "View" },
  { command: "faraday.closeEditor", title: "Close Editor", category: "View" },

  // ── Navigation ────────────────────────────────────────────────────────────
  { command: "faraday.switchPanel", title: "Switch Panel", category: "Navigation" },
  { command: "faraday.focusLeftPanel", title: "Focus Left Panel", category: "Navigation" },
  { command: "faraday.focusRightPanel", title: "Focus Right Panel", category: "Navigation" },
  { command: "faraday.cancelNavigation", title: "Cancel Navigation", category: "Navigation" },
  { command: "faraday.goToParent", title: "Go to Parent Directory", category: "Navigation" },
  { command: "faraday.goHome", title: "Go to Home Directory", category: "Navigation" },

  // ── File ──────────────────────────────────────────────────────────────────
  { command: "faraday.refresh", title: "Refresh", category: "File" },
  { command: "faraday.newTab", title: "New Tab", category: "File" },
  { command: "faraday.closeTab", title: "Close Tab", category: "File" },
  { command: "faraday.previewInOppositePanel", title: "Show Preview in Opposite Panel", category: "File" },
  { command: "faraday.openCurrentFolderInOppositePanelCurrentTab", title: "Open Current Folder in Opposite Panel (Current Tab)", category: "File" },
  { command: "faraday.openCurrentFolderInOppositePanelNewTab", title: "Open Current Folder in Opposite Panel (New Tab)", category: "File" },
  { command: "faraday.openSelectedFolderInOppositePanelCurrentTab", title: "Open Selected Folder in Opposite Panel (Current Tab)", category: "File" },
  { command: "faraday.openSelectedFolderInOppositePanelNewTab", title: "Open Selected Folder in Opposite Panel (New Tab)", category: "File" },
  { command: "faraday.openCreateFile", title: "Open / Create File", shortTitle: "New File", category: "File" },
  { command: "faraday.makeFolder", title: "Make Folder", shortTitle: "MkDir", category: "File" },
  { command: "faraday.viewFile", title: "View File", shortTitle: "View", category: "File" },
  { command: "faraday.editFile", title: "Edit File", shortTitle: "Edit", category: "File" },

  // ── Application ───────────────────────────────────────────────────────────
  { command: "faraday.exit", title: "Exit", shortTitle: "Quit", category: "Application" },

  // ── Terminal ──────────────────────────────────────────────────────────────
  { command: "terminal.execute", title: "Execute in Terminal", category: "Terminal" },

  // ── File List ─────────────────────────────────────────────────────────────
  { command: "list.cursorUp", title: "Cursor Up", category: "Navigation" },
  { command: "list.cursorDown", title: "Cursor Down", category: "Navigation" },
  { command: "list.cursorLeft", title: "Cursor Left (Previous Column)", category: "Navigation" },
  { command: "list.cursorRight", title: "Cursor Right (Next Column)", category: "Navigation" },
  { command: "list.cursorHome", title: "Cursor to First", category: "Navigation" },
  { command: "list.cursorEnd", title: "Cursor to Last", category: "Navigation" },
  { command: "list.cursorPageUp", title: "Cursor Page Up", category: "Navigation" },
  { command: "list.cursorPageDown", title: "Cursor Page Down", category: "Navigation" },
  { command: "list.selectUp", title: "Select Up", category: "Navigation" },
  { command: "list.selectDown", title: "Select Down", category: "Navigation" },
  { command: "list.selectLeft", title: "Select Left", category: "Navigation" },
  { command: "list.selectRight", title: "Select Right", category: "Navigation" },
  { command: "list.selectHome", title: "Select to First", category: "Navigation" },
  { command: "list.selectEnd", title: "Select to Last", category: "Navigation" },
  { command: "list.selectPageUp", title: "Select Page Up", category: "Navigation" },
  { command: "list.selectPageDown", title: "Select Page Down", category: "Navigation" },
  { command: "list.execute", title: "Execute in Terminal", category: "Navigation" },
  { command: "list.open", title: "Open", category: "Navigation" },
  { command: "list.viewFile", title: "View File", shortTitle: "View", category: "Navigation" },
  { command: "list.editFile", title: "Edit File", shortTitle: "Edit", category: "Navigation" },
  { command: "list.moveToTrash", title: "Move to Trash", shortTitle: "Trash", category: "File" },
  { command: "list.permanentDelete", title: "Permanently Delete", shortTitle: "Del Perm", category: "File" },
  { command: "list.copy", title: "Copy", shortTitle: "Copy", category: "File" },
  { command: "list.move", title: "Move", shortTitle: "Move", category: "File" },
  { command: "list.rename", title: "Rename", shortTitle: "Rename", category: "File" },
  { command: "list.pasteFilename", title: "Paste Filename to Command Line", category: "File" },
  { command: "list.pastePath", title: "Paste Path to Command Line", category: "File" },

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
