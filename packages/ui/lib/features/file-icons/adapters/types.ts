import type { IconAssetStore } from "../iconCache";

export type IconThemeType = "fss" | "vscode" | "none";

export interface IconLookupInput {
  name: string;
  isDirectory: boolean;
  isExpanded: boolean;
  isRoot: boolean;
  langId?: string;
}

export interface ResolvedImageIcon {
  kind: "image";
  path: string;
}

export interface ResolvedFontIcon {
  kind: "font";
  character: string;
  fontFamily: string;
  color?: string;
  fontSize?: string;
}

export type ResolvedThemeIcon = ResolvedImageIcon | ResolvedFontIcon;

export interface IconThemeAdapter {
  kind: IconThemeType;
  resolve(input: IconLookupInput): ResolvedThemeIcon | null;
  clear(): void;
  prepareIcons?(icons: ResolvedThemeIcon[], iconAssets: IconAssetStore): Promise<void>;
  setThemeKind?(kind: "dark" | "light"): void;
  load?(path: string): Promise<void>;
}
