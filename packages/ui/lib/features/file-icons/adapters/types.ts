export type IconThemeType = "fss" | "vscode" | "none";

export interface IconLookupInput {
  name: string;
  isDirectory: boolean;
  isExpanded: boolean;
  isRoot: boolean;
  langId?: string;
}

export interface IconThemeAdapter {
  kind: IconThemeType;
  resolve(input: IconLookupInput): string | null;
  clear(): void;
  setThemeKind?(kind: "dark" | "light"): void;
  load?(path: string): Promise<void>;
}
