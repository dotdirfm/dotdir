import type { PanelSide } from "@/entities/panel/model/types";

export interface ActiveFileListHandlers {
  focus(): void;
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
const bySide = new Map<PanelSide, ActiveFileListHandlers>();

export function setActiveFileListHandlers(handlers: ActiveFileListHandlers | null): void {
  current = handlers;
}

export function getActiveFileListHandlers(): ActiveFileListHandlers | null {
  return current;
}

export function setFileListHandlers(side: PanelSide, handlers: ActiveFileListHandlers | null): void {
  if (handlers) bySide.set(side, handlers);
  else bySide.delete(side);
}

export function getFileListHandlers(side: PanelSide): ActiveFileListHandlers | null {
  return bySide.get(side) ?? null;
}
