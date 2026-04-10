import type { ResolvedIcon } from "@/features/file-icons/iconResolver";

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

export interface FilePresentation {
  style: ResolvedEntryStyle;
  icon: ResolvedIcon;
}
