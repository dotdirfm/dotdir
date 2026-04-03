import { createContext, createElement, type ReactNode, useContext } from "react";

export interface FileOperationHandlers {
  moveToTrash(sourcePaths: string[], refresh: () => void): void;
  permanentDelete(sourcePaths: string[], refresh: () => void): void;
  copy(sourcePaths: string[], refresh: () => void): void;
  move(sourcePaths: string[], refresh: () => void): void;
  rename(sourcePath: string, currentName: string, refresh: () => void): void;
}

const FileOperationHandlersContext = createContext<FileOperationHandlers | null>(null);

export function FileOperationHandlersProvider({
  handlers,
  children,
}: {
  handlers: FileOperationHandlers;
  children: ReactNode;
}) {
  return createElement(FileOperationHandlersContext.Provider, { value: handlers }, children);
}

export function useFileOperationHandlers(): FileOperationHandlers | null {
  return useContext(FileOperationHandlersContext);
}
