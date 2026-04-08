import { CommandRegistryProvider } from "@/features/commands/commands";
import { FileSystemWatchRegistryProvider } from "@/features/file-system/fs";
import { FocusProvider } from "@/focusContext";
import { InteractionProvider } from "@/interactionContext";
import { ViewerEditorRegistryProvider } from "@/viewerEditorRegistry";
import type { ReactNode } from "react";

export function AppServicesProvider({ children }: { children: ReactNode }) {
  return (
    <FileSystemWatchRegistryProvider>
      <CommandRegistryProvider>
        <FocusProvider>
          <InteractionProvider>
            <ViewerEditorRegistryProvider>{children}</ViewerEditorRegistryProvider>
          </InteractionProvider>
        </FocusProvider>
      </CommandRegistryProvider>
    </FileSystemWatchRegistryProvider>
  );
}
