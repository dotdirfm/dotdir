import { useCommandRegistry } from "@/features/commands/commands";
import { useInteractionContext, type InteractionIntent } from "@/interactionContext";
import { useEffect } from "react";

const INTENT_COMMANDS: Array<{ command: string; intent: InteractionIntent }> = [
  { command: "cursorUp", intent: "cursorUp" },
  { command: "cursorDown", intent: "cursorDown" },
  { command: "cursorLeft", intent: "cursorLeft" },
  { command: "cursorRight", intent: "cursorRight" },
  { command: "cursorHome", intent: "cursorHome" },
  { command: "cursorEnd", intent: "cursorEnd" },
  { command: "cursorPageUp", intent: "cursorPageUp" },
  { command: "cursorPageDown", intent: "cursorPageDown" },
  { command: "selectUp", intent: "selectUp" },
  { command: "selectDown", intent: "selectDown" },
  { command: "selectLeft", intent: "selectLeft" },
  { command: "selectRight", intent: "selectRight" },
  { command: "selectHome", intent: "selectHome" },
  { command: "selectEnd", intent: "selectEnd" },
  { command: "selectPageUp", intent: "selectPageUp" },
  { command: "selectPageDown", intent: "selectPageDown" },
  { command: "accept", intent: "accept" },
  { command: "cancel", intent: "cancel" },
  { command: "filelist.cursorUp", intent: "cursorUp" },
  { command: "filelist.cursorDown", intent: "cursorDown" },
  { command: "filelist.cursorLeft", intent: "cursorLeft" },
  { command: "filelist.cursorRight", intent: "cursorRight" },
  { command: "filelist.cursorHome", intent: "cursorHome" },
  { command: "filelist.cursorEnd", intent: "cursorEnd" },
  { command: "filelist.cursorPageUp", intent: "cursorPageUp" },
  { command: "filelist.cursorPageDown", intent: "cursorPageDown" },
  { command: "filelist.selectUp", intent: "selectUp" },
  { command: "filelist.selectDown", intent: "selectDown" },
  { command: "filelist.selectLeft", intent: "selectLeft" },
  { command: "filelist.selectRight", intent: "selectRight" },
  { command: "filelist.selectHome", intent: "selectHome" },
  { command: "filelist.selectEnd", intent: "selectEnd" },
  { command: "filelist.selectPageUp", intent: "selectPageUp" },
  { command: "filelist.selectPageDown", intent: "selectPageDown" },
];

export function useInteractionCommands(): void {
  const commandRegistry = useCommandRegistry();
  const interactionContext = useInteractionContext();

  useEffect(() => {
    const disposables = INTENT_COMMANDS.map(({ command, intent }) =>
      commandRegistry.registerCommand(command, () => {
        interactionContext.dispatchIntent(intent);
      }),
    );
    return () => {
      disposables.forEach((dispose) => dispose());
    };
  }, [commandRegistry, interactionContext]);
}
