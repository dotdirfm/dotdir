import { CommandRegistryProvider } from "@/features/commands/commands";
import { FileSystemWatchRegistryProvider } from "@/features/file-system/fs";
import { FocusProvider } from "@/focusContext";
import { ViewerEditorRegistryProvider } from "@/viewerEditorRegistry";
import type { ReactNode } from "react";

export function AppServicesProvider({ children }: { children: ReactNode }) {
  return (
    <FileSystemWatchRegistryProvider>
      <CommandRegistryProvider>
        <FocusProvider>
          <ViewerEditorRegistryProvider>{children}</ViewerEditorRegistryProvider>
        </FocusProvider>
      </CommandRegistryProvider>
    </FileSystemWatchRegistryProvider>
  );
}
