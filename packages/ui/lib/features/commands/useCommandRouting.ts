import { useCommandRegistry } from "@/features/commands/commands";
import { useFocusContext } from "@/focusContext";
import { useInteractionContext } from "@/interactionContext";
import { useEffect, type RefObject } from "react";

export function useCommandRouting(rootRef: RefObject<HTMLElement | null>): void {
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const interactionContext = useInteractionContext();

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (interactionContext.handleKeyboardEvent(event, root)) return;
      const shouldRoute = focusContext.shouldRouteCommandEvent(event, root);
      if (!shouldRoute) return;
      commandRegistry.handleKeyboardEvent(event);
    };

    root.addEventListener("keydown", handleKeyDown, true);
    return () => root.removeEventListener("keydown", handleKeyDown, true);
  }, [commandRegistry, focusContext, interactionContext, rootRef]);
}
