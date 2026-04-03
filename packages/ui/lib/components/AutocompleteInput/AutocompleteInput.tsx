import { useCommandRegistry } from "@/features/commands/commands";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import styles from "./AutocompleteInput.module.css";

export interface AutocompleteOption {
  id: string;
  value: string;
  label: string;
  meta?: string;
}

export interface AutocompleteGroup {
  id: string;
  label: string;
  options: AutocompleteOption[];
}

interface FlattenedOption {
  groupId: string;
  option: AutocompleteOption;
}

const PAGE_STEP = 10;

export interface AutocompleteInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  groups: AutocompleteGroup[];
  inputRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
  inputClassName?: string;
  placeholder?: string;
  autoComplete?: string;
  autoCapitalize?: string;
  autoCorrect?: string;
  spellCheck?: boolean;
  enterKeyHint?: React.HTMLAttributes<HTMLInputElement>["enterKeyHint"];
  keepOpenOnSelect?: boolean;
}

export function AutocompleteInput({
  id,
  value,
  onChange,
  groups,
  inputRef,
  className,
  inputClassName,
  placeholder,
  autoComplete,
  autoCapitalize,
  autoCorrect,
  spellCheck,
  enterKeyHint,
  keepOpenOnSelect = false,
}: AutocompleteInputProps) {
  const commandRegistry = useCommandRegistry();
  const localInputRef = useRef<HTMLInputElement>(null);
  const mergedInputRef = inputRef ?? localInputRef;
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const pointerDownRef = useRef(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties | null>(null);
  const generatedId = useId();
  const anchorId = id ?? `autocomplete-${generatedId.replace(/:/g, "")}`;

  const flattened = useMemo<FlattenedOption[]>(
    () =>
      groups.flatMap((group) =>
        group.options.map((option) => ({
          groupId: group.id,
          option,
        })),
      ),
    [groups],
  );
  const dropdownOpen = open && flattened.length > 0;
  const flattenedRef = useRef(flattened);
  const selectedIndexRef = useRef(selectedIndex);
  const dropdownOpenRef = useRef(dropdownOpen);
  const hasSelection = dropdownOpen && selectedIndex !== null && selectedIndex >= 0 && selectedIndex < flattened.length;
  flattenedRef.current = flattened;
  selectedIndexRef.current = selectedIndex;
  dropdownOpenRef.current = dropdownOpen;

  const moveInputCursor = useCallback((position: "start" | "end") => {
    const input = mergedInputRef.current;
    if (!input) return;
    const nextPosition = position === "start" ? 0 : input.value.length;
    input.focus();
    input.setSelectionRange(nextPosition, nextPosition);
  }, [mergedInputRef]);

  useEffect(() => {
    setSelectedIndex((current) => {
      if (flattened.length === 0 || current === null) return null;
      return Math.min(current, flattened.length - 1);
    });
  }, [flattened.length]);

  const commitSelection = (nextValue: string) => {
    onChange(nextValue);
    if (!keepOpenOnSelect) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setSelectedIndex(null);
  };
  const commitSelectionRef = useRef(commitSelection);
  commitSelectionRef.current = commitSelection;

  useEffect(() => {
    commandRegistry.setContext("autocompleteFocused", focused);
    return () => {
      commandRegistry.setContext("autocompleteFocused", false);
    };
  }, [commandRegistry, focused]);

  useEffect(() => {
    commandRegistry.setContext("autocompleteOpen", dropdownOpen);
    return () => {
      commandRegistry.setContext("autocompleteOpen", false);
    };
  }, [commandRegistry, dropdownOpen]);

  useEffect(() => {
    commandRegistry.setContext("autocompleteHasSelection", hasSelection);
    return () => {
      commandRegistry.setContext("autocompleteHasSelection", false);
    };
  }, [commandRegistry, hasSelection]);

  useEffect(() => {
    const disposables = [
      commandRegistry.registerCommand("autocomplete.close", () => {
        if (!dropdownOpenRef.current) return;
        setOpen(false);
      }),
      commandRegistry.registerCommand("autocomplete.cursorDown", () => {
        if (!dropdownOpenRef.current) return;
        setSelectedIndex((current) =>
          current === null ? 0 : Math.min(flattenedRef.current.length - 1, current + 1),
        );
      }),
      commandRegistry.registerCommand("autocomplete.cursorUp", () => {
        if (!dropdownOpenRef.current) return;
        setSelectedIndex((current) =>
          current === null ? Math.max(0, flattenedRef.current.length - 1) : Math.max(0, current - 1),
        );
      }),
      commandRegistry.registerCommand("autocomplete.cursorPageDown", () => {
        if (!dropdownOpenRef.current) return;
        setSelectedIndex((current) =>
          current === null ? 0 : Math.min(flattenedRef.current.length - 1, current + PAGE_STEP),
        );
      }),
      commandRegistry.registerCommand("autocomplete.cursorPageUp", () => {
        if (!dropdownOpenRef.current) return;
        setSelectedIndex((current) =>
          current === null ? 0 : Math.max(0, current - PAGE_STEP),
        );
      }),
      commandRegistry.registerCommand("autocomplete.cursorHome", () => {
        if (!dropdownOpenRef.current) {
          moveInputCursor("start");
          return;
        }
        if (flattenedRef.current.length === 0) return;
        setSelectedIndex(0);
      }),
      commandRegistry.registerCommand("autocomplete.cursorEnd", () => {
        if (!dropdownOpenRef.current) {
          moveInputCursor("end");
          return;
        }
        if (flattenedRef.current.length === 0) return;
        setSelectedIndex(flattenedRef.current.length - 1);
      }),
      commandRegistry.registerCommand("autocomplete.accept", () => {
        if (!dropdownOpenRef.current) return;
        if (selectedIndexRef.current === null) return;
        const selected = flattenedRef.current[selectedIndexRef.current];
        if (!selected) return;
        commitSelectionRef.current(selected.option.value);
      }),
    ];
    return () => {
      disposables.forEach((dispose) => dispose());
    };
  }, [commandRegistry, moveInputCursor]);

  useEffect(() => {
    const disposables = [
      commandRegistry.registerKeybinding({
        command: "autocomplete.close",
        key: "escape",
        when: "focusModal && autocompleteFocused && autocompleteOpen",
      }),
      commandRegistry.registerKeybinding({
        command: "autocomplete.cursorDown",
        key: "down",
        when: "focusModal && autocompleteFocused && autocompleteOpen",
      }),
      commandRegistry.registerKeybinding({
        command: "autocomplete.cursorUp",
        key: "up",
        when: "focusModal && autocompleteFocused && autocompleteOpen",
      }),
      commandRegistry.registerKeybinding({
        command: "autocomplete.cursorPageDown",
        key: "pagedown",
        when: "focusModal && autocompleteFocused && autocompleteOpen",
      }),
      commandRegistry.registerKeybinding({
        command: "autocomplete.cursorPageUp",
        key: "pageup",
        when: "focusModal && autocompleteFocused && autocompleteOpen",
      }),
      commandRegistry.registerKeybinding({
        command: "autocomplete.cursorHome",
        key: "home",
        when: "focusModal && autocompleteFocused",
      }),
      commandRegistry.registerKeybinding({
        command: "autocomplete.cursorEnd",
        key: "end",
        when: "focusModal && autocompleteFocused",
      }),
      commandRegistry.registerKeybinding({
        command: "autocomplete.accept",
        key: "enter",
        when: "focusModal && autocompleteFocused && autocompleteOpen && autocompleteHasSelection",
      }),
      commandRegistry.registerKeybinding({
        command: "autocomplete.accept",
        key: "tab",
        when: "focusModal && autocompleteFocused && autocompleteOpen && autocompleteHasSelection",
      }),
    ];
    return () => {
      disposables.forEach((dispose) => dispose());
    };
  }, [commandRegistry]);

  useEffect(() => {
    const dropdown = dropdownRef.current;
    if (!dropdown) return;
    if (!("showPopover" in dropdown)) return;
    const popoverDropdown = dropdown as HTMLDivElement & {
      showPopover: () => void;
      hidePopover: () => void;
      matches: (selector: string) => boolean;
    };
    const isOpen = popoverDropdown.matches(":popover-open");
    if (dropdownOpen) {
      if (!isOpen) popoverDropdown.showPopover();
      return;
    }
    if (isOpen) popoverDropdown.hidePopover();
  }, [anchorId, dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen || selectedIndex === null) return;
    const dropdown = dropdownRef.current;
    if (!dropdown) return;
    const selectedEl = dropdown.querySelector<HTMLElement>('[data-selected="true"]');
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [dropdownOpen, selectedIndex]);

  useLayoutEffect(() => {
    if (!dropdownOpen) return;

    const updatePosition = () => {
      const input = mergedInputRef.current;
      if (!input) return;
      const rect = input.getBoundingClientRect();
      setDropdownStyle({
        position: "fixed",
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [dropdownOpen, mergedInputRef]);

  return (
    <div className={className ? `${styles["autocomplete"]} ${className}` : styles["autocomplete"]}>
      <input
        ref={mergedInputRef}
        id={anchorId}
        type="text"
        value={value}
        className={inputClassName ? `${styles["autocomplete-input"]} ${inputClassName}` : styles["autocomplete-input"]}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        spellCheck={spellCheck}
        enterKeyHint={enterKeyHint}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setSelectedIndex(null);
        }}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          if (pointerDownRef.current) return;
          setOpen(false);
          setSelectedIndex(null);
        }}
      />
      {flattened.length > 0 && (
        <div
          ref={dropdownRef}
          popover="manual"
          className={styles["autocomplete-dropdown"]}
          style={dropdownStyle ?? undefined}
        >
          {groups.map((group) => {
            if (group.options.length === 0) return null;
            return (
              <div key={group.id} className={styles["autocomplete-group"]}>
                {group.label ? <div className={styles["autocomplete-group-heading"]}>{group.label}</div> : null}
                <ul className={styles["autocomplete-list"]}>
                  {group.options.map((option) => {
                    const flatIndex = flattened.findIndex(
                      (item) => item.groupId === group.id && item.option.id === option.id,
                    );
                    const isSelected = flatIndex === selectedIndex;
                    return (
                      <li
                        key={option.id}
                        className={styles["autocomplete-item"]}
                        data-selected={isSelected ? "true" : "false"}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          pointerDownRef.current = true;
                          setSelectedIndex(flatIndex);
                          commitSelection(option.value);
                          requestAnimationFrame(() => {
                            pointerDownRef.current = false;
                            mergedInputRef.current?.focus();
                          });
                        }}
                        onMouseMove={() => {
                          if (flatIndex >= 0) setSelectedIndex(flatIndex);
                        }}
                      >
                        <span className={styles["autocomplete-item-label"]}>{option.label}</span>
                        {option.meta && <span className={styles["autocomplete-item-meta"]}>{option.meta}</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
