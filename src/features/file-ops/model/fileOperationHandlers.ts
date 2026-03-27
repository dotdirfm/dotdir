export interface FileOperationHandlers {
  moveToTrash(sourcePaths: string[], refresh: () => void): void;
  permanentDelete(sourcePaths: string[], refresh: () => void): void;
  copy(sourcePaths: string[], refresh: () => void): void;
  move(sourcePaths: string[], refresh: () => void): void;
  rename(sourcePath: string, currentName: string, refresh: () => void): void;
  pasteToCommandLine(text: string): void;
}

let current: FileOperationHandlers | null = null;

export function setFileOperationHandlers(handlers: FileOperationHandlers): void {
  current = handlers;
}

export function getFileOperationHandlers(): FileOperationHandlers | null {
  return current;
}
