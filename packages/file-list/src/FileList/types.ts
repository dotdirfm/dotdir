import type { FsNode } from "@dotdirfm/fss-lang";
import type { ReactNode } from "react";

export interface ResolvedEntryStyle {
  color?: string;
  opacity?: number;
  fontWeight?: string | number;
  fontStyle?: string;
  fontStretch?: string;
  fontVariant?: string;
  textDecoration?: string;
  icon: string | null;
  sortPriority: number;
  groupFirst: boolean;
}

export interface FilePresentation<TIcon = unknown> {
  style: ResolvedEntryStyle;
  icon: TIcon;
}

export type FileListState = {
  path: string;
  entry?: FsNode;
  entries: FsNode[];
  activeEntryName?: string;
  topmostEntryName?: string;
  selectedEntryNames?: string[];
};

export interface FileOperationHandlers {
  moveToTrash(sourcePaths: string[], refresh: () => void): void;
  permanentDelete(sourcePaths: string[], refresh: () => void): void;
  copy(sourcePaths: string[], refresh: () => void): void;
  move(sourcePaths: string[], refresh: () => void): void;
  rename(sourcePath: string, currentName: string, refresh: () => void): void;
}

export interface LanguageResolver {
  getLanguageForFilename(filename: string): string;
}

export interface DisplayEntry<TIcon = unknown> {
  entry: FsNode;
  presentation: FilePresentation<TIcon>;
}

export type RenderFileIcon<TIcon = unknown> = (icon: TIcon, entry: FsNode) => ReactNode;
