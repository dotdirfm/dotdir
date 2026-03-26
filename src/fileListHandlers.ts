export interface ActiveFileListHandlers {
  cursorUp(): void;
  cursorDown(): void;
  cursorLeft(): void;
  cursorRight(): void;
  cursorHome(): void;
  cursorEnd(): void;
  cursorPageUp(): void;
  cursorPageDown(): void;
  selectUp(): void;
  selectDown(): void;
  selectLeft(): void;
  selectRight(): void;
  selectHome(): void;
  selectEnd(): void;
  selectPageUp(): void;
  selectPageDown(): void;
  execute(): void;
  open(): void;
  viewFile(): void;
  editFile(): void;
  moveToTrash(): void;
  permanentDelete(): void;
  copy(): void;
  move(): void;
  rename(): void;
  pasteFilename(): void;
  pastePath(): void;
}

let current: ActiveFileListHandlers | null = null;

export function setActiveFileListHandlers(handlers: ActiveFileListHandlers | null): void {
  current = handlers;
}

export function getActiveFileListHandlers(): ActiveFileListHandlers | null {
  return current;
}
