import type { FsNode } from "fss-lang";

export type FileListTabState = {
  path: string;
  parent?: FileListTabState;
  entry?: FsNode;
  entries: FsNode[];
  topmostEntryName?: string;
  activeEntryName?: string;
  selectedEntryNames?: string[];
};

export type FileListTab = FileListTabState & {
  id: string;
  type: "filelist";
};

export type PreviewTabState = {
  path: string;
  name: string;
  size: number;
  surfaceKey?: string;
  isTemp: boolean;
  dirty?: boolean;
  mode?: "viewer" | "editor";
  langId?: string;
  sourcePanel?: "left" | "right";
};

export type PreviewTab = PreviewTabState & {
  id: string;
  type: "preview";
};

export type PanelTab = FileListTab | PreviewTab;

export type EditorSelection = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber?: number;
  endColumn?: number;
};

export type EditorDocumentTab = {
  id: string;
  type: "editor-document";
  filePath: string;
  fileName: string;
  fileSize: number;
  langId: string;
  dirty?: boolean;
  selection?: EditorSelection;
  navigationVersion?: number;
};
