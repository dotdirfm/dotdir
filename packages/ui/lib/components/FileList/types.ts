import type { ResolvedEntryStyle } from "@/features/fss/types";
import type { FsNode } from "fss-lang";

export interface DisplayEntry {
  entry: FsNode;
  style: ResolvedEntryStyle;
}
