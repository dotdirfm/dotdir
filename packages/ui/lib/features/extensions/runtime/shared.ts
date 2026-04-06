import { useRef } from "react";

export const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const AUTO_UPDATE_INITIAL_DELAY_MS = 60 * 1000;

export type InstallRequest =
  | { source: "dotdir-marketplace"; publisher: string; name: string; version: string }
  | { source: "open-vsx-marketplace"; publisher: string; name: string; downloadUrl: string };

export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
