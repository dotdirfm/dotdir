import { CommandRegistryProvider } from "@/features/commands/commands";
import { FileSystemWatchRegistryProvider } from "@/features/file-system/fs";
import { LanguageRegistryProvider } from "@/features/languages/languageRegistry";
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
            <LanguageRegistryProvider>
              <ViewerEditorRegistryProvider>{children}</ViewerEditorRegistryProvider>
            </LanguageRegistryProvider>
          </InteractionProvider>
        </FocusProvider>
      </CommandRegistryProvider>
    </FileSystemWatchRegistryProvider>
  );
}
