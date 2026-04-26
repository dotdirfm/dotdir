import {
  ACCEPT,
  CANCEL,
  CURSOR_DOWN,
  CURSOR_END,
  CURSOR_HOME,
  CURSOR_PAGE_DOWN,
  CURSOR_PAGE_UP,
  CURSOR_UP,
} from "@dotdirfm/commands";
import { useCommandRegistry } from "@dotdirfm/commands";
import { useFocusContext, useManagedFocusLayer } from "@/focusContext";
import { DropdownSurface } from "@/components/DropdownSurface/DropdownSurface";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
  enterKeyHint,
  keepOpenOnSelect = false,
}: AutocompleteInputProps) {
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const localInputRef = useRef<HTMLInputElement>(null);
  const mergedInputRef = inputRef ?? localInputRef;
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const pointerDownRef = useRef(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
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
  useManagedFocusLayer("autocomplete", dropdownOpen);
  const flattenedRef = useRef(flattened);
  const selectedIndexRef = useRef(selectedIndex);
  const dropdownOpenRef = useRef(dropdownOpen);
  flattenedRef.current = flattened;
  selectedIndexRef.current = selectedIndex;
  dropdownOpenRef.current = dropdownOpen;

  useEffect(() => {
    return focusContext.registerAdapter("autocomplete", {
      focus() {
        mergedInputRef.current?.focus();
      },
      contains(node) {
        return node instanceof Node
          ? mergedInputRef.current?.contains(node) === true || dropdownRef.current?.contains(node) === true
          : false;
      },
      isEditableTarget(node) {
        return mergedInputRef.current?.contains(node as Node) === true;
      },
      allowCommandRouting(event) {
        if (!dropdownOpenRef.current) return false;
        switch (event.key) {
          case "Tab":
          case "ArrowUp":
          case "ArrowDown":
          case "PageUp":
          case "PageDown":
          case "Home":
          case "End":
          case "Enter":
          case "Escape":
            return true;
          default:
            return false;
        }
      },
    });
  }, [focusContext, mergedInputRef]);

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
    if (!dropdownOpen) return;
    const disposables = [
      commandRegistry.registerCommand(
        CANCEL,
        () => {
          setOpen(false);
          setSelectedIndex(null);
        },
      ),
      commandRegistry.registerCommand(
        CURSOR_DOWN,
        () => {
          setSelectedIndex((current) =>
            current === null ? 0 : Math.min(flattenedRef.current.length - 1, current + 1),
          );
        },
      ),
      commandRegistry.registerCommand(
        CURSOR_UP,
        () => {
          setSelectedIndex((current) =>
            current === null ? Math.max(0, flattenedRef.current.length - 1) : Math.max(0, current - 1),
          );
        },
      ),
      commandRegistry.registerCommand(
        CURSOR_PAGE_DOWN,
        () => {
          setSelectedIndex((current) =>
            current === null ? 0 : Math.min(flattenedRef.current.length - 1, current + PAGE_STEP),
          );
        },
      ),
      commandRegistry.registerCommand(
        CURSOR_PAGE_UP,
        () => {
          setSelectedIndex((current) => (current === null ? 0 : Math.max(0, current - PAGE_STEP)));
        },
      ),
      commandRegistry.registerCommand(
        CURSOR_HOME,
        () => {
          if (flattenedRef.current.length === 0) return;
          setSelectedIndex(0);
        },
      ),
      commandRegistry.registerCommand(
        CURSOR_END,
        () => {
          if (flattenedRef.current.length === 0) return;
          setSelectedIndex(flattenedRef.current.length - 1);
        },
      ),
      commandRegistry.registerCommand(
        ACCEPT,
        () => {
          if (selectedIndexRef.current === null) return;
          const selected = flattenedRef.current[selectedIndexRef.current];
          if (!selected) return;
          commitSelectionRef.current(selected.option.value);
        },
      ),
    ];
    return () => {
      disposables.forEach((dispose) => dispose());
    };
  }, [commandRegistry, dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen || selectedIndex === null) return;
    const dropdown = dropdownRef.current;
    if (!dropdown) return;
    const selectedEl = dropdown.querySelector<HTMLElement>('[data-selected="true"]');
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [dropdownOpen, selectedIndex]);

  return (
    <div className={className ? `${styles["autocomplete"]} ${className}` : styles["autocomplete"]}>
      <input
        ref={mergedInputRef}
        id={anchorId}
        type="text"
        value={value}
        className={inputClassName ? `${styles["autocomplete-input"]} ${inputClassName}` : styles["autocomplete-input"]}
        placeholder={placeholder}
        spellCheck={false}
        enterKeyHint={enterKeyHint}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setSelectedIndex(null);
        }}
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape") return;
          if (!dropdownOpenRef.current) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          setSelectedIndex(null);
        }}
        onBlur={() => {
          if (pointerDownRef.current) return;
          setOpen(false);
          setSelectedIndex(null);
        }}
      />
      {flattened.length > 0 && (
        <DropdownSurface
          open={dropdownOpen}
          anchor={{ type: "element", ref: mergedInputRef }}
          placement="bottom-start"
          offset={4}
          matchAnchorWidth
          className={styles["autocomplete-dropdown"]}
          surfaceRef={dropdownRef}
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
        </DropdownSurface>
      )}
    </div>
  );
}
