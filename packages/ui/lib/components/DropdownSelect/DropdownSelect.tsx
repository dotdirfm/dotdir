import { List } from "@/components/List/List";
import { DropdownSurface, type DropdownPlacement } from "@/components/DropdownSurface/DropdownSurface";
import { useFocusContext, useManagedFocusLayer } from "@dotdirfm/ui-focus";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { VscChevronDown } from "react-icons/vsc";
import styles from "./DropdownSelect.module.css";

export interface DropdownSelectOption {
  value: string;
  label: ReactNode;
}

export interface DropdownSelectProps {
  value: string;
  options: DropdownSelectOption[];
  onChange: (value: string) => void;
  triggerClassName?: string;
  menuClassName?: string;
  placement?: DropdownPlacement;
  offset?: number;
  matchAnchorWidth?: boolean;
  renderValue?: (selected: DropdownSelectOption | null) => ReactNode;
}

export function DropdownSelect({
  value,
  options,
  onChange,
  triggerClassName,
  menuClassName,
  placement = "bottom-start",
  offset = 4,
  matchAnchorWidth = true,
  renderValue,
}: DropdownSelectProps) {
  const focusContext = useFocusContext();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = useMemo(() => Math.max(0, options.findIndex((option) => option.value === value)), [options, value]);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const activeKey = options[activeIndex]?.value ?? null;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useManagedFocusLayer("menu", open);

  const closeMenu = (restoreFocus = true) => {
    setOpen(false);
    if (!restoreFocus) return;
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  };

  const selectedOption = useMemo(() => options.find((option) => option.value === value) ?? null, [options, value]);

  useEffect(() => {
    setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    return focusContext.registerAdapter("menu", {
      focus() {
        const next = menuRef.current?.querySelector<HTMLElement>("[data-list-active='true']");
        (next ?? triggerRef.current)?.focus();
      },
      contains(node) {
        return node instanceof Node
          ? triggerRef.current?.contains(node) === true || menuRef.current?.contains(node) === true
          : false;
      },
      allowCommandRouting: false,
    });
  }, [focusContext, open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const next = menuRef.current?.querySelector<HTMLElement>("[data-list-active='true']");
      next?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [activeKey, open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName ? `${styles.trigger} ${triggerClassName}` : styles.trigger}
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          background: "var(--bg)",
          backgroundImage: "none",
          boxShadow: "none",
          color: "var(--fg)",
          borderColor: "var(--input-border, var(--border))",
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (open) return;
          switch (event.key) {
            case "ArrowDown":
            case "Enter":
            case " ":
              event.preventDefault();
              setActiveIndex(selectedIndex);
              setOpen(true);
              return;
            case "ArrowUp":
              event.preventDefault();
              setActiveIndex(Math.max(0, options.length - 1));
              setOpen(true);
              return;
            default:
              return;
          }
        }}
      >
        <span>{renderValue ? renderValue(selectedOption) : (selectedOption?.label ?? "")}</span>
        <VscChevronDown className={styles.chevron} aria-hidden="true" />
      </button>
      <DropdownSurface
        open={open}
        anchor={{ type: "element", ref: triggerRef }}
        placement={placement}
        offset={offset}
        matchAnchorWidth={matchAnchorWidth}
        popoverMode="auto"
        surfaceRef={menuRef}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            requestAnimationFrame(() => {
              triggerRef.current?.focus();
            });
          }
        }}
        className={menuClassName ? `${styles.menu} ${menuClassName}` : styles.menu}
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
            return;
          }
          if (event.key === "Tab") {
            if (!activeKey) return;
            event.preventDefault();
            event.stopPropagation();
            onChange(activeKey);
            closeMenu();
          }
        }}
      >
        <List
          items={options}
          getKey={(option) => option.value}
          activeKey={activeKey}
          onActiveKeyChange={(key) => {
            const index = optionsRef.current.findIndex((option) => option.value === key);
            if (index >= 0) setActiveIndex(index);
          }}
          onActivate={(key) => {
            onChange(key);
            closeMenu();
          }}
          className={styles.list}
          role="listbox"
          renderItem={(option, { active }) => {
            const isSelected = option.value === value;
            const itemClassName = [
              styles.item,
              isSelected ? styles.itemSelected : "",
              active ? styles.itemActive : "",
            ]
              .filter(Boolean)
              .join(" ");
            return <div className={itemClassName}>{option.label}</div>;
          }}
        />
      </DropdownSurface>
    </>
  );
}
