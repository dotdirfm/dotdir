import { binarySearch } from "../utils/binarySearch";
import type { DisplayEntry } from "./types";

export function formatSize(sizeValue: unknown): string {
  let size: number;
  if (typeof sizeValue === "number") size = sizeValue;
  else if (typeof sizeValue === "bigint") size = Number(sizeValue);
  else return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} K`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} M`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} G`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getRequestedIndex(entries: DisplayEntry[], requestedName: string, comparer: (a: DisplayEntry, b: DisplayEntry) => number): number {
  const exact = entries.findIndex((item) => item.entry.name === requestedName);
  if (exact >= 0) return exact;
  const requested = {
    entry: { name: requestedName },
    presentation: {
      style: { groupFirst: false, sortPriority: 0 },
      icon: null,
    },
  } as DisplayEntry;
  let idx = binarySearch(entries, requested, comparer);
  if (idx < 0) idx = ~idx;
  return clamp(idx, 0, Math.max(0, entries.length - 1));
}
