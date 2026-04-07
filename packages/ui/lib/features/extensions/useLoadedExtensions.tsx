import type { LoadedExtension } from "@/features/extensions/types";
import { atom, useAtom, useSetAtom } from "jotai";

export const loadedExtensionsAtom = atom<LoadedExtension[]>([]);

export function useLoadedExtensions(): LoadedExtension[] {
  const [loadedExtensions] = useAtom(loadedExtensionsAtom);
  return loadedExtensions;
}

export function useSetLoadedExtensions() {
  return useSetAtom(loadedExtensionsAtom);
}

export function useExtensions() {
  const [loadedExtensions, setLoadedExtensions] = useAtom(loadedExtensionsAtom);
  return { loadedExtensions, setLoadedExtensions };
}
