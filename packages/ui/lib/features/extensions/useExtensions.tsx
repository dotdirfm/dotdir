import type { LoadedExtension } from "@/features/extensions/types";
import { createContext, createElement, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

type ExtensionsContextValue = {
  loadedExtensions: LoadedExtension[];
  setLoadedExtensions: Dispatch<SetStateAction<LoadedExtension[]>>;
};

const ExtensionsContext = createContext<ExtensionsContextValue | null>(null);

export function ExtensionsProvider({ children }: { children: ReactNode }) {
  const [loadedExtensions, setLoadedExtensions] = useState<LoadedExtension[]>([]);
  const value = useMemo<ExtensionsContextValue>(
    () => ({
      loadedExtensions,
      setLoadedExtensions,
    }),
    [loadedExtensions],
  );
  return createElement(ExtensionsContext.Provider, { value }, children);
}

function useExtensionsContext(): ExtensionsContextValue {
  const value = useContext(ExtensionsContext);
  if (!value) {
    throw new Error("useExtensionsContext must be used within ExtensionsProvider");
  }
  return value;
}

export function useLoadedExtensions(): LoadedExtension[] {
  return useExtensionsContext().loadedExtensions;
}

export function useSetLoadedExtensions(): Dispatch<SetStateAction<LoadedExtension[]>> {
  return useExtensionsContext().setLoadedExtensions;
}

export function useExtensions() {
  return useExtensionsContext();
}
