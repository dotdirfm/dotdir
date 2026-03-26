import { useEffect, useState, useCallback } from "react";
import { commandRegistry, type Command, type Keybinding } from "./commands";

interface ActionBarItem {
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

export function ActionBar() {
  const [items, setItems] = useState<ActionBarItem[]>([]);
  const [modifiers, setModifiers] = useState({
    ctrl: false,
    shift: false,
    alt: false,
  });

  const updateItems = useCallback(() => {
    const prefix = getModifierPrefix(modifiers.ctrl, modifiers.shift, modifiers.alt);
    const keybindings = commandRegistry.getKeybindings();
    const newItems: ActionBarItem[] = [];

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
  }, [modifiers]);

  useEffect(() => {
    updateItems();
    return commandRegistry.onChange(updateItems);
  }, [updateItems]);

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
  }, []);

  const handleClick = useCallback((item: ActionBarItem) => {
    if (item.command) {
      commandRegistry.executeCommand(item.command.id);
    }
  }, []);

  return (
    <div className="action-bar">
      {items.map((item) => (
        <div key={item.fKey} className={`action-bar-item${item.command ? "" : " disabled"}`} onClick={() => handleClick(item)}>
          <span className="action-bar-key">F{item.fKey}</span>
          <span className="action-bar-label">{item.command?.title ?? ""}</span>
        </div>
      ))}
    </div>
  );
}
