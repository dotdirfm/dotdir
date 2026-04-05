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
