import { useCommandRegistry } from "@/features/commands/commands";
import {
  ACCEPT,
  CANCEL,
  CURSOR_DOWN,
  CURSOR_END,
  CURSOR_HOME,
  CURSOR_LEFT,
  CURSOR_PAGE_DOWN,
  CURSOR_PAGE_UP,
  CURSOR_RIGHT,
  CURSOR_UP,
  FILELIST_CURSOR_DOWN,
  FILELIST_CURSOR_END,
  FILELIST_CURSOR_HOME,
  FILELIST_CURSOR_LEFT,
  FILELIST_CURSOR_PAGE_DOWN,
  FILELIST_CURSOR_PAGE_UP,
  FILELIST_CURSOR_RIGHT,
  FILELIST_CURSOR_UP,
  FILELIST_SELECT_DOWN,
  FILELIST_SELECT_END,
  FILELIST_SELECT_HOME,
  FILELIST_SELECT_LEFT,
  FILELIST_SELECT_PAGE_DOWN,
  FILELIST_SELECT_PAGE_UP,
  FILELIST_SELECT_RIGHT,
  FILELIST_SELECT_UP,
  SELECT_DOWN,
  SELECT_END,
  SELECT_HOME,
  SELECT_LEFT,
  SELECT_PAGE_DOWN,
  SELECT_PAGE_UP,
  SELECT_RIGHT,
  SELECT_UP,
} from "@/features/commands/commandIds";
import { useInteractionContext, type InteractionIntent } from "@/interactionContext";
import { useEffect } from "react";

const INTENT_COMMANDS: Array<{ command: string; intent: InteractionIntent }> = [
  { command: CURSOR_UP, intent: "cursorUp" },
  { command: CURSOR_DOWN, intent: "cursorDown" },
  { command: CURSOR_LEFT, intent: "cursorLeft" },
  { command: CURSOR_RIGHT, intent: "cursorRight" },
  { command: CURSOR_HOME, intent: "cursorHome" },
  { command: CURSOR_END, intent: "cursorEnd" },
  { command: CURSOR_PAGE_UP, intent: "cursorPageUp" },
  { command: CURSOR_PAGE_DOWN, intent: "cursorPageDown" },
  { command: SELECT_UP, intent: "selectUp" },
  { command: SELECT_DOWN, intent: "selectDown" },
  { command: SELECT_LEFT, intent: "selectLeft" },
  { command: SELECT_RIGHT, intent: "selectRight" },
  { command: SELECT_HOME, intent: "selectHome" },
  { command: SELECT_END, intent: "selectEnd" },
  { command: SELECT_PAGE_UP, intent: "selectPageUp" },
  { command: SELECT_PAGE_DOWN, intent: "selectPageDown" },
  { command: ACCEPT, intent: "accept" },
  { command: CANCEL, intent: "cancel" },
  { command: FILELIST_CURSOR_UP, intent: "cursorUp" },
  { command: FILELIST_CURSOR_DOWN, intent: "cursorDown" },
  { command: FILELIST_CURSOR_LEFT, intent: "cursorLeft" },
  { command: FILELIST_CURSOR_RIGHT, intent: "cursorRight" },
  { command: FILELIST_CURSOR_HOME, intent: "cursorHome" },
  { command: FILELIST_CURSOR_END, intent: "cursorEnd" },
  { command: FILELIST_CURSOR_PAGE_UP, intent: "cursorPageUp" },
  { command: FILELIST_CURSOR_PAGE_DOWN, intent: "cursorPageDown" },
  { command: FILELIST_SELECT_UP, intent: "selectUp" },
  { command: FILELIST_SELECT_DOWN, intent: "selectDown" },
  { command: FILELIST_SELECT_LEFT, intent: "selectLeft" },
  { command: FILELIST_SELECT_RIGHT, intent: "selectRight" },
  { command: FILELIST_SELECT_HOME, intent: "selectHome" },
  { command: FILELIST_SELECT_END, intent: "selectEnd" },
  { command: FILELIST_SELECT_PAGE_UP, intent: "selectPageUp" },
  { command: FILELIST_SELECT_PAGE_DOWN, intent: "selectPageDown" },
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
