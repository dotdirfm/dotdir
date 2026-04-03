import { type Command, type Keybinding, useCommandRegistry } from "@/features/commands/commands";
import { useFocusContext } from "@/focusContext";
import { cx } from "@/utils/cssModules";
import { useCallback, useEffect, useState } from "react";
import styles from "./KeyBar.module.css";

interface KeyBarItem {
  fKey: number;
  command?: Command;
  keybinding?: Keybinding;
}

function getModifierPrefix(ctrl: boolean, shift: boolean, alt: boolean): string {
  const parts: string[] = [];
  if (ctrl) parts.push("ctrl");
  if (alt) parts.push("alt");
  if (shift) parts.push("shift");
  return parts.length > 0 ? parts.join("+") + "+" : "";
}

export function KeyBar() {
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const [items, setItems] = useState<KeyBarItem[]>([]);
  const [modifiers, setModifiers] = useState({
    ctrl: false,
    shift: false,
    alt: false,
  });

  const updateItems = useCallback(() => {
    const prefix = getModifierPrefix(modifiers.ctrl, modifiers.shift, modifiers.alt);
    const keybindings = commandRegistry.getKeybindings();
    const newItems: KeyBarItem[] = [];

    for (let i = 1; i <= 12; i++) {
      const fKeyName = `f${i}`;
      const targetKey = prefix + fKeyName;

      // Find keybinding that matches this F-key with current modifiers
      const kb = keybindings.find((k) => {
        const key = k.key.toLowerCase().replace(/\s/g, "");
        return key === targetKey;
      });

      if (kb) {
        if (commandRegistry.evaluateWhen(kb.when)) {
          const cmd = commandRegistry.getCommand(kb.command);
          newItems.push({ fKey: i, command: cmd, keybinding: kb });
          continue;
        }
      }
      newItems.push({ fKey: i });
    }

    setItems(newItems);
  }, [commandRegistry, modifiers]);

  useEffect(() => {
    updateItems();
    const offCommands = commandRegistry.onChange(updateItems);
    const offFocus = focusContext.onChange(() => updateItems());
    return () => {
      offCommands();
      offFocus();
    };
  }, [commandRegistry, focusContext, updateItems]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      setModifiers({
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
      });
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      setModifiers({
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
      });
    };

    const handleBlur = () => {
      setModifiers({ ctrl: false, shift: false, alt: false });
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [commandRegistry]);

  const handleClick = useCallback((item: KeyBarItem) => {
    if (item.command) {
      commandRegistry.executeCommand(item.command.id);
    }
  }, [commandRegistry]);

  return (
    <div className={styles["key-bar"]}>
      {items.map((item) => (
        <div key={item.fKey} className={cx(styles, "key-bar-item", !item.command && "disabled")} onClick={() => handleClick(item)}>
          <span className={styles["key-bar-key"]}>F{item.fKey}</span>
          <span className={styles["key-bar-label"]}>{item.command ? (item.command.shortTitle ?? item.command.title) : ""}</span>
        </div>
      ))}
    </div>
  );
}
