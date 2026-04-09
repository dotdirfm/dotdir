import type { ResolvedEntryStyle } from "@/features/fss/types";
import type { ResolvedFontIcon } from "@/features/file-icons/adapters";
import type { FsNode } from "fss-lang";

export interface DisplayEntry {
  entry: FsNode;
  style: ResolvedEntryStyle;
  iconKind: "image" | "font";
  iconPath: string | null;
  iconFont?: ResolvedFontIcon;
  iconFallbackUrl: string;
}
