type FileListTab = {
  id: string;
  type: "filelist";
  path: string;
};

type PreviewTab = {
  id: string;
  type: "preview";
  path: string;
  name: string;
  size: number;
  isTemp: boolean;
  dirty?: boolean;
  mode?: "viewer" | "editor";
  langId?: string;
  sourcePanel?: "left" | "right";
};

export type PanelTab = FileListTab | PreviewTab;
