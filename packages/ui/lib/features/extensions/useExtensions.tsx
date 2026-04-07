import type { LoadedExtension } from "@/features/extensions/types";
import { loadedExtensionsAtom } from "@/features/extensions/extensionsAtoms";
import { useAtom } from "jotai";
import type { Dispatch, ReactNode, SetStateAction } from "react";

export function ExtensionsProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useLoadedExtensions(): LoadedExtension[] {
  const [loadedExtensions] = useAtom(loadedExtensionsAtom);
  return loadedExtensions;
}

export function useSetLoadedExtensions(): Dispatch<SetStateAction<LoadedExtension[]>> {
  const [, setLoadedExtensions] = useAtom(loadedExtensionsAtom);
  return setLoadedExtensions;
}

export function useExtensions() {
  const [loadedExtensions, setLoadedExtensions] = useAtom(loadedExtensionsAtom);
  return { loadedExtensions, setLoadedExtensions };
}
