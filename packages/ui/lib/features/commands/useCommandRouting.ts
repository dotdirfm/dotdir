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

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!focusContext.is("panel")) return;
      commandRegistry.handleKeyboardEvent(event);
    };

    root.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keydown", handleWindowKeyDown, true);
    return () => {
      root.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keydown", handleWindowKeyDown, true);
    };
  }, [commandRegistry, focusContext, interactionContext, rootRef]);
}
