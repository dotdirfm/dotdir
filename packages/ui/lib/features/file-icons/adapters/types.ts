export type IconThemeType = "fss" | "vscode" | "none";

export interface IconLookupInput {
  name: string;
  isDirectory: boolean;
  isExpanded: boolean;
  isRoot: boolean;
  langId?: string;
  fssIconPath?: string | null;
}

export interface IconThemeAdapter {
  kind: IconThemeType;
  resolve(input: IconLookupInput): string | null;
  preload(keys: string[]): Promise<void>;
  getCachedUrl(key: string): string | null;
  clear(): void;
  setThemeKind?(kind: "dark" | "light"): void;
  load?(path: string): Promise<void>;
}
