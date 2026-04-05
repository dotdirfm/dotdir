import { cx } from "@/utils/cssModules";
import { memo, useCallback, useRef, useState } from "react";
import { VscClose } from "react-icons/vsc";
import styles from "./Tabs.module.css";

export type TabsVariant = "panel" | "subtle" | "terminal";

export interface TabsItem {
  id: string;
  label: string;
  title?: string;
  inactive?: boolean;
}

interface TabsProps<T extends TabsItem> {
  items: T[];
  activeItemId: string;
  onSelectItem: (id: string) => void;
  onDoubleClickItem?: (id: string) => void;
  onCloseItem?: (id: string) => void;
  onReorderItems?: (fromIndex: number, toIndex: number) => void;
  getItemClassName?: (item: T) => string | false | null | undefined;
  renderItemContent?: (item: T) => React.ReactNode;
  rightSlot?: React.ReactNode;
  variant?: TabsVariant;
}

function variantClassNames(variant: TabsVariant) {
  if (variant === "subtle") {
    return {
      root: "subtle",
      list: "subtleList",
      tab: "subtleTab",
      active: "subtleTabActive",
      drop: undefined,
      close: undefined,
    } as const;
  }

  if (variant === "terminal") {
    return {
      root: "terminal",
      list: "terminalList",
      tab: "terminalTab",
      active: "terminalTabActive",
      drop: undefined,
      close: "terminalClose",
    } as const;
  }

  return {
    root: "panel",
    list: undefined,
    tab: "panelTab",
    active: "panelTabActive",
    drop: "panelDropIndicator",
    close: "panelClose",
  } as const;
}

export const Tabs = memo(function Tabs<T extends TabsItem>({
  items,
  activeItemId,
  onSelectItem,
  onDoubleClickItem,
  onCloseItem,
  onReorderItems,
  getItemClassName,
  renderItemContent,
  rightSlot,
  variant = "panel",
}: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dragFromRef = useRef<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const classes = variantClassNames(variant);

  itemRefs.current = items.map((_, index) => itemRefs.current[index] ?? null);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    const element = listRef.current;
    if (!element) return;
    const canScrollHorizontally = element.scrollWidth > element.clientWidth + 1;
    if (!canScrollHorizontally) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    event.preventDefault();
    element.scrollLeft += delta;
  }, []);

  const getDropIndex = useCallback((clientX: number): number | null => {
    const list = listRef.current;
    if (!list) return null;
    for (let index = 0; index < itemRefs.current.length; index += 1) {
      const item = itemRefs.current[index];
      if (!item) continue;
      const rect = item.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return index;
    }
    return itemRefs.current.length;
  }, []);

  const handleDragStart = useCallback((event: React.DragEvent, index: number) => {
    dragFromRef.current = index;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
    event.dataTransfer.setDragImage(new Image(), 0, 0);
    requestAnimationFrame(() => {
      (event.target as HTMLElement).classList.add(styles.dragging);
    });
  }, []);

  const handleDragOver = useCallback(
    (event: React.DragEvent) => {
      if (!onReorderItems) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropIndex(getDropIndex(event.clientX));
    },
    [getDropIndex, onReorderItems],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      if (!onReorderItems) return;
      event.preventDefault();
      const from = dragFromRef.current;
      const to = getDropIndex(event.clientX);
      if (from != null && to != null) {
        if (to > from) onReorderItems(from, to - 1);
        else if (to < from) onReorderItems(from, to);
      }
      dragFromRef.current = null;
      setDropIndex(null);
    },
    [getDropIndex, onReorderItems],
  );

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    if (!listRef.current?.contains(event.relatedTarget as Node)) {
      setDropIndex(null);
    }
  }, []);

  const handleDragEnd = useCallback((event: React.DragEvent) => {
    (event.target as HTMLElement).classList.remove(styles.dragging);
    dragFromRef.current = null;
    setDropIndex(null);
  }, []);

  return (
    <div className={cx(styles, "tabs", classes.root)}>
      <div
        ref={listRef}
        className={cx(styles, "list", classes.list)}
        onWheel={handleWheel}
        onDragOver={onReorderItems ? handleDragOver : undefined}
        onDrop={onReorderItems ? handleDrop : undefined}
        onDragLeave={onReorderItems ? handleDragLeave : undefined}
      >
        {items.flatMap((item, index) => {
          const isActive = item.id === activeItemId;
          const itemClassName = getItemClassName?.(item);
          const showDropBefore = onReorderItems && dropIndex === index;
          return [
            showDropBefore ? <div key={`drop-${index}`} className={cx(styles, "dropIndicator", classes.drop)} aria-hidden /> : null,
            <div
              key={item.id}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              className={cx(styles, "tab", classes.tab, isActive && classes.active, item.inactive && "inactive", itemClassName)}
              onClick={() => onSelectItem(item.id)}
              onDoubleClick={onDoubleClickItem ? (event) => {
                event.preventDefault();
                onDoubleClickItem(item.id);
              } : undefined}
              title={item.title}
              draggable={Boolean(onReorderItems)}
              onDragStart={onReorderItems ? (event) => handleDragStart(event, index) : undefined}
              onDragEnd={onReorderItems ? handleDragEnd : undefined}
            >
              {renderItemContent ? renderItemContent(item) : <span className={styles.label}>{item.label}</span>}
              {onCloseItem ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className={cx(styles, "close", classes.close)}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseItem(item.id);
                  }}
                  aria-label="Close tab"
                >
                  <VscClose aria-hidden className={styles["close-icon"]} />
                </button>
              ) : null}
            </div>,
          ];
        })}
        {onReorderItems && dropIndex === items.length ? <div key="drop-end" className={cx(styles, "dropIndicator", classes.drop)} aria-hidden /> : null}
      </div>
      {rightSlot}
    </div>
  );
}) as <T extends TabsItem>(props: TabsProps<T>) => React.JSX.Element;
