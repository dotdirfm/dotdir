import { useEffect, useRef, type ReactNode } from "react";
import styles from "./List.module.css";

const PAGE_STEP = 10;

export interface ListRenderState {
  active: boolean;
}

export interface ListProps<T> {
  items: T[];
  getKey: (item: T) => string;
  activeKey: string | null;
  onActiveKeyChange: (key: string) => void;
  onActivate?: (key: string) => void;
  className?: string;
  role?: string;
  hoverSelection?: boolean;
  renderItem: (item: T, state: ListRenderState) => ReactNode;
}

export function List<T>({
  items,
  getKey,
  activeKey,
  onActiveKeyChange,
  onActivate,
  className,
  role = "listbox",
  hoverSelection = false,
  renderItem,
}: ListProps<T>) {
  const itemRefs = useRef(new Map<string, HTMLLIElement | null>());
  const activeIndex = activeKey ? items.findIndex((item) => getKey(item) === activeKey) : -1;

  useEffect(() => {
    if (!activeKey) return;
    itemRefs.current.get(activeKey)?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  const moveToIndex = (index: number) => {
    const next = items[index];
    if (!next) return;
    onActiveKeyChange(getKey(next));
    requestAnimationFrame(() => {
      itemRefs.current.get(getKey(next))?.focus();
    });
  };

  return (
    <ul
      className={className ? `${styles.root} ${className}` : styles.root}
      role={role}
      aria-activedescendant={activeKey ?? undefined}
      onKeyDown={(event) => {
        if (items.length === 0) return;
        switch (event.key) {
          case "ArrowDown":
            event.preventDefault();
            moveToIndex(Math.min(items.length - 1, activeIndex < 0 ? 0 : activeIndex + 1));
            return;
          case "ArrowUp":
            event.preventDefault();
            moveToIndex(Math.max(0, activeIndex < 0 ? items.length - 1 : activeIndex - 1));
            return;
          case "PageDown":
            event.preventDefault();
            moveToIndex(Math.min(items.length - 1, Math.max(0, activeIndex) + PAGE_STEP));
            return;
          case "PageUp":
            event.preventDefault();
            moveToIndex(Math.max(0, Math.max(0, activeIndex) - PAGE_STEP));
            return;
          case "Home":
            event.preventDefault();
            moveToIndex(0);
            return;
          case "End":
            event.preventDefault();
            moveToIndex(items.length - 1);
            return;
          case "Enter":
          case " ":
            if (!activeKey || !onActivate) return;
            event.preventDefault();
            onActivate(activeKey);
            return;
          default:
            return;
        }
      }}
    >
      {items.map((item) => {
        const key = getKey(item);
        const active = key === activeKey;
        return (
          <li
            key={key}
            id={key}
            ref={(element) => {
              itemRefs.current.set(key, element);
            }}
            role="option"
            tabIndex={active ? 0 : -1}
            aria-selected={active}
            data-list-active={active ? "true" : "false"}
            className={styles.item}
            onFocus={() => onActiveKeyChange(key)}
            onMouseMove={hoverSelection ? () => onActiveKeyChange(key) : undefined}
            onClick={() => onActivate?.(key)}
          >
            {renderItem(item, { active })}
          </li>
        );
      })}
    </ul>
  );
}
