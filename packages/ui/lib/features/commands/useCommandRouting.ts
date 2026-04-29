import { useCommandRegistry } from "@dotdirfm/commands";
import { useFocusContext } from "@dotdirfm/ui-focus";
import { useEffect, type RefObject } from "react";

export function useCommandRouting(rootRef: RefObject<HTMLElement | null>): void {
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const shouldRoute = focusContext.shouldRouteCommandEvent(event, root);
      if (!shouldRoute) return;
      commandRegistry.handleKeyboardEvent(event);
    };

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (!focusContext.is("panel")) return;
      const isPlainTab = event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey;
      const isFunctionKey = /^F\d{1,2}$/.test(event.key);
      if (!isPlainTab && !isFunctionKey) return;
      commandRegistry.handleKeyboardEvent(event);
    };

    root.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keydown", handleWindowKeyDown, true);
    return () => {
      root.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keydown", handleWindowKeyDown, true);
    };
  }, [commandRegistry, focusContext, rootRef]);
}
