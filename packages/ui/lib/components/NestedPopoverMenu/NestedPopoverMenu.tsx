import { cx } from "@/utils/cssModules";
import { useFocusContext } from "@/focusContext";
import { useInteractionContext, type InteractionIntent } from "@/interactionContext";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { VscChevronLeft, VscChevronRight } from "react-icons/vsc";
import styles from "./NestedPopoverMenu.module.css";

export type NestedPopoverMenuDirection = "top" | "bottom" | "left" | "right";
export type NestedPopoverMenuAlign = "start" | "end" | "center";
export type NestedPopoverMenuPlacement =
  | "top-start"
  | "top-end"
  | "top-center"
  | "bottom-start"
  | "bottom-end"
  | "bottom-center"
  | "left-start"
  | "left-end"
  | "left-center"
  | "right-start"
  | "right-end"
  | "right-center";

export interface NestedPopoverMenuItem {
  id: string;
  label: string;
  title?: string;
  disabled?: boolean;
  onSelect?: () => void | Promise<void>;
  onOpenInNewTab?: () => void | Promise<void>;
  items?: NestedPopoverMenuItem[];
}

interface NestedPopoverMenuProps {
  items: NestedPopoverMenuItem[];
  placement?: NestedPopoverMenuPlacement;
  className?: string;
  popoverClassName?: string;
  viewTitle?: string;
  renderAnchor: (props: {
    ref: React.RefObject<HTMLElement | null>;
    id: string;
    open: boolean;
    toggle: () => void;
    close: () => void;
  }) => React.ReactNode;
}

export interface NestedPopoverMenuHandle {
  open: () => void;
  close: () => void;
  toggle: () => void;
}

interface MenuView {
  id: string;
  title?: string;
  items: NestedPopoverMenuItem[];
}

const ANIMATION_MS = 200;

function parsePlacement(placement: NestedPopoverMenuPlacement): {
  direction: NestedPopoverMenuDirection;
  align: NestedPopoverMenuAlign;
} {
  const [direction, align = "start"] = placement.split("-") as [
    NestedPopoverMenuDirection,
    NestedPopoverMenuAlign?,
  ];
  return { direction, align };
}

function toFixedPosition(
  anchorRect: DOMRect,
  popoverSize: { width: number; height: number },
  placement: NestedPopoverMenuPlacement,
): React.CSSProperties {
  const gap = 6;
  const { direction, align } = parsePlacement(placement);
  let top = 0;
  let left = 0;

  if (direction === "bottom") {
    top = anchorRect.bottom + gap;
    if (align === "end") left = anchorRect.right - popoverSize.width;
    else if (align === "center") left = anchorRect.left + (anchorRect.width - popoverSize.width) / 2;
    else left = anchorRect.left;
  } else if (direction === "top") {
    top = anchorRect.top - popoverSize.height - gap;
    if (align === "end") left = anchorRect.right - popoverSize.width;
    else if (align === "center") left = anchorRect.left + (anchorRect.width - popoverSize.width) / 2;
    else left = anchorRect.left;
  } else if (direction === "right") {
    left = anchorRect.right + gap;
    if (align === "end") top = anchorRect.bottom - popoverSize.height;
    else if (align === "center") top = anchorRect.top + (anchorRect.height - popoverSize.height) / 2;
    else top = anchorRect.top;
  } else {
    left = anchorRect.left - popoverSize.width - gap;
    if (align === "end") top = anchorRect.bottom - popoverSize.height;
    else if (align === "center") top = anchorRect.top + (anchorRect.height - popoverSize.height) / 2;
    else top = anchorRect.top;
  }

  const maxLeft = Math.max(8, window.innerWidth - popoverSize.width - 8);
  const maxTop = Math.max(8, window.innerHeight - popoverSize.height - 8);

  return {
    position: "fixed",
    left: Math.max(8, Math.min(maxLeft, left)),
    top: Math.max(8, Math.min(maxTop, top)),
  };
}

function measureElementSize(element: HTMLElement | null): { width: number; height: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
  };
}

function getFirstEnabledIndex(items: NestedPopoverMenuItem[]): number {
  return items.findIndex((item) => !item.disabled);
}

function getLastEnabledIndex(items: NestedPopoverMenuItem[]): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (!items[index]?.disabled) return index;
  }
  return -1;
}

function getNextEnabledIndex(items: NestedPopoverMenuItem[], startIndex: number, delta: 1 | -1): number {
  if (items.length === 0) return -1;
  let index = startIndex;
  for (let step = 0; step < items.length; step++) {
    index = (index + delta + items.length) % items.length;
    if (!items[index]?.disabled) return index;
  }
  return startIndex;
}

export const NestedPopoverMenu = forwardRef<NestedPopoverMenuHandle, NestedPopoverMenuProps>(function NestedPopoverMenu({
  items,
  placement = "bottom-end",
  className,
  popoverClassName,
  viewTitle,
  renderAnchor,
}, ref) {
  const focusContext = useFocusContext();
  const interactionContext = useInteractionContext();
  const anchorRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const currentContentRef = useRef<HTMLDivElement | null>(null);
  const prevContentRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLAnchorElement | null>());
  const previousFocusedRef = useRef<HTMLElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const animationTimeoutRef = useRef<number | null>(null);
  const generatedId = useId().replace(/:/g, "");
  const popoverId = `nested-menu-${generatedId}`;

  const rootView = useMemo<MenuView>(
    () => ({
      id: "root",
      title: viewTitle,
      items,
    }),
    [items, viewTitle],
  );

  const [open, setOpen] = useState(false);
  const [stack, setStack] = useState<MenuView[]>([rootView]);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([getFirstEnabledIndex(rootView.items)]);
  const [prevView, setPrevView] = useState<MenuView | null>(null);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | undefined>(undefined);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties | null>(null);

  const currentView = stack[stack.length - 1] ?? rootView;
  const selectedIndex = selectedIndices[selectedIndices.length - 1] ?? getFirstEnabledIndex(currentView.items);
  const selectedItem = selectedIndex >= 0 ? currentView.items[selectedIndex] : undefined;
  const selectedItemId = selectedItem ? `${currentView.id}:${selectedItem.id}` : null;

  useEffect(() => {
    setStack([rootView]);
    setSelectedIndices([getFirstEnabledIndex(rootView.items)]);
    setPrevView(null);
  }, [rootView]);

  useEffect(() => {
    resizeObserverRef.current = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setContentSize({
        width: Math.ceil(width),
        height: Math.ceil(height),
      });
    });
    return () => {
      resizeObserverRef.current?.disconnect();
      if (animationTimeoutRef.current != null) {
        window.clearTimeout(animationTimeoutRef.current);
      }
    };
  }, []);

  const observeCurrentContent = useCallback((element: HTMLDivElement | null) => {
    if (currentContentRef.current && resizeObserverRef.current) {
      resizeObserverRef.current.unobserve(currentContentRef.current);
    }
    currentContentRef.current = element;
    if (element && resizeObserverRef.current) {
      resizeObserverRef.current.observe(element);
      const measured = measureElementSize(element);
      if (measured) setContentSize(measured);
    }
  }, []);

  const finishPreviousView = useCallback(() => {
    prevContentRef.current = null;
    setPrevView(null);
  }, []);

  const runAnimation = useCallback(() => {
    const previous = prevContentRef.current;
    const current = currentContentRef.current;
    if (!previous || !current) {
      finishPreviousView();
      return;
    }

    previous.getAnimations().forEach((animation) => animation.cancel());
    current.getAnimations().forEach((animation) => animation.cancel());

    previous.animate(
      [
        { transform: "translateX(0)", opacity: 1 },
        { transform: `translateX(${-direction * 40}px)`, opacity: 0 },
      ],
      { duration: ANIMATION_MS, easing: "ease-out", fill: "forwards" },
    );

    current.animate(
      [
        { transform: `translateX(${direction * 40}px)`, opacity: 0 },
        { transform: "translateX(0)", opacity: 1 },
      ],
      { duration: ANIMATION_MS, easing: "ease-out", fill: "forwards" },
    );

    if (animationTimeoutRef.current != null) {
      window.clearTimeout(animationTimeoutRef.current);
    }
    animationTimeoutRef.current = window.setTimeout(() => {
      finishPreviousView();
    }, ANIMATION_MS + 20);
  }, [direction, finishPreviousView]);

  useLayoutEffect(() => {
    if (!prevView) return;
    requestAnimationFrame(() => {
      runAnimation();
    });
  }, [prevView, runAnimation]);

  const resetToRoot = useCallback(() => {
    setStack([rootView]);
    setSelectedIndices([getFirstEnabledIndex(rootView.items)]);
    finishPreviousView();
  }, [finishPreviousView, rootView]);

  const close = useCallback(() => {
    setOpen(false);
    resetToRoot();
  }, [resetToRoot]);

  const openMenu = useCallback(() => {
    setOpen((value) => {
      if (value) return value;
      resetToRoot();
      return true;
    });
  }, [resetToRoot]);

  const toggle = useCallback(() => {
    setOpen((value) => {
      const next = !value;
      if (!next) {
        resetToRoot();
      } else {
        resetToRoot();
      }
      return next;
    });
  }, [resetToRoot]);

  useImperativeHandle(
    ref,
    () => ({
      open: openMenu,
      close,
      toggle,
    }),
    [close, openMenu, toggle],
  );

  const pushView = useCallback((item: NestedPopoverMenuItem) => {
    if (!item.items?.length) return;
    setDirection(1);
    setPrevView(currentView);
    prevContentRef.current = currentContentRef.current;
    setStack((views) => [
      ...views,
      {
        id: item.id,
        title: item.label,
        items: item.items ?? [],
      },
    ]);
    setSelectedIndices((indices) => [...indices, getFirstEnabledIndex(item.items ?? [])]);
  }, [currentView]);

  const popView = useCallback(() => {
    setStack((views) => {
      if (views.length <= 1) return views;
      setDirection(-1);
      setPrevView(views[views.length - 1] ?? null);
      prevContentRef.current = currentContentRef.current;
      return views.slice(0, -1);
    });
    setSelectedIndices((indices) => (indices.length > 1 ? indices.slice(0, -1) : indices));
  }, []);

  const handleItemClick = useCallback(async (item: NestedPopoverMenuItem, alternate = false) => {
    if (item.disabled) return;
    if (item.items?.length) {
      pushView(item);
      return;
    }
    if (alternate && item.onOpenInNewTab) {
      await item.onOpenInNewTab();
    } else {
      await item.onSelect?.();
    }
    close();
  }, [close, pushView]);

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover || !("showPopover" in popover)) return;
    const element = popover as HTMLDivElement & {
      showPopover: () => void;
      hidePopover: () => void;
      matches: (selector: string) => boolean;
    };
    const isOpen = element.matches(":popover-open");
    if (open) {
      if (!isOpen) element.showPopover();
      return;
    }
    if (isOpen) element.hidePopover();
  }, [open]);

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const onToggle = (event: Event) => {
      const nextState = (event as ToggleEvent).newState;
      if (nextState === "closed") {
        setOpen(false);
        resetToRoot();
      }
    };
    popover.addEventListener("toggle", onToggle);
    return () => {
      popover.removeEventListener("toggle", onToggle);
    };
  }, [resetToRoot]);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      const size = contentSize ?? { width: 220, height: 160 };
      setPopoverStyle(toFixedPosition(anchorRect, size, placement));
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [contentSize, open, placement]);

  useEffect(() => {
    const container = popoverRef.current;
    if (!container) return;
    return focusContext.registerAdapter("menu", {
      focus() {
        if (selectedItemId) {
          itemRefs.current.get(selectedItemId)?.focus();
          return;
        }
        anchorRef.current?.focus();
      },
      contains(node) {
        return node instanceof Node ? container.contains(node) || anchorRef.current?.contains(node) === true : false;
      },
      allowCommandRouting: true,
    });
  }, [focusContext, selectedItemId]);

  useEffect(() => {
    if (!open) return;
    previousFocusedRef.current = document.activeElement as HTMLElement | null;
    focusContext.push("menu");
    const frame = requestAnimationFrame(() => {
      focusContext.focusCurrent();
    });
    return () => {
      cancelAnimationFrame(frame);
      focusContext.pop("menu");
      requestAnimationFrame(() => {
        if (focusContext.is("panel")) {
          focusContext.focusCurrent();
          return;
        }
        previousFocusedRef.current?.focus?.();
      });
    };
  }, [focusContext, open]);

  useEffect(() => {
    if (!open || !selectedItemId) return;
    itemRefs.current.get(selectedItemId)?.focus();
  }, [open, selectedItemId]);

  const updateSelectedIndex = useCallback((nextIndex: number) => {
    setSelectedIndices((indices) => {
      const next = [...indices];
      next[next.length - 1] = nextIndex;
      return next;
    });
  }, []);

  const handleIntent = useCallback((intent: InteractionIntent, event?: KeyboardEvent | null): boolean => {
    if (!open) return false;

    switch (intent) {
      case "cursorUp": {
        if (selectedIndex < 0) {
          updateSelectedIndex(getLastEnabledIndex(currentView.items));
          return true;
        }
        updateSelectedIndex(getNextEnabledIndex(currentView.items, selectedIndex, -1));
        return true;
      }
      case "cursorDown": {
        if (selectedIndex < 0) {
          updateSelectedIndex(getFirstEnabledIndex(currentView.items));
          return true;
        }
        updateSelectedIndex(getNextEnabledIndex(currentView.items, selectedIndex, 1));
        return true;
      }
      case "cursorHome":
      case "cursorPageUp":
        updateSelectedIndex(getFirstEnabledIndex(currentView.items));
        return true;
      case "cursorEnd":
      case "cursorPageDown":
        updateSelectedIndex(getLastEnabledIndex(currentView.items));
        return true;
      case "cursorLeft":
        if (stack.length <= 1) return false;
        popView();
        return true;
      case "cursorRight":
        if (!selectedItem?.items?.length) return false;
        pushView(selectedItem);
        return true;
      case "accept":
        if (!selectedItem) return false;
        void handleItemClick(selectedItem, Boolean(event?.shiftKey && selectedItem.onOpenInNewTab));
        return true;
      case "cancel":
        close();
        return true;
      default:
        return false;
    }
  }, [close, currentView.items, handleItemClick, open, popView, pushView, selectedIndex, selectedItem, stack.length, updateSelectedIndex]);

  useEffect(() => {
    return interactionContext.registerController({
      contains(node) {
        const popover = popoverRef.current;
        return node instanceof Node
          ? (popover?.contains(node) ?? false) || (anchorRef.current?.contains(node) ?? false)
          : false;
      },
      isActive() {
        return open && focusContext.is("menu");
      },
      handleIntent(intent, event) {
        return handleIntent(intent, event);
      },
    });
  }, [focusContext, handleIntent, interactionContext, open]);

  return (
    <>
      {renderAnchor({
        ref: anchorRef,
        id: popoverId,
        open,
        toggle,
        close,
      })}
      <div
        ref={popoverRef}
        popover="auto"
        id={popoverId}
        className={cx(styles, "popover", className, popoverClassName)}
        style={{
          ...(popoverStyle ?? {}),
          width: contentSize?.width,
          height: contentSize?.height,
        }}
      >
        <div className={styles.viewport}>
          {currentView ? (
            <div key={currentView.id} ref={observeCurrentContent} className={styles["screen-current"]}>
              <MenuViewBody
                view={currentView}
                canGoBack={stack.length > 1}
                onBack={popView}
                onItemClick={handleItemClick}
                selectedItemId={selectedItemId}
                setItemRef={(itemId, element) => {
                  itemRefs.current.set(itemId, element);
                }}
                onItemPointerMove={updateSelectedIndex}
              />
            </div>
          ) : null}
          {prevView && prevView.id !== currentView.id ? (
            <div key={`prev-${prevView.id}`} ref={prevContentRef} className={styles["screen-previous"]}>
              <MenuViewBody
                view={prevView}
                canGoBack={stack.length > 1}
                onBack={popView}
                onItemClick={handleItemClick}
                selectedItemId={null}
                setItemRef={() => {}}
                onItemPointerMove={() => {}}
              />
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
});

function MenuViewBody({
  view,
  canGoBack,
  onBack,
  onItemClick,
  selectedItemId,
  setItemRef,
  onItemPointerMove,
}: {
  view: MenuView;
  canGoBack: boolean;
  onBack: () => void;
  onItemClick: (item: NestedPopoverMenuItem) => void | Promise<void>;
  selectedItemId: string | null;
  setItemRef: (itemId: string, element: HTMLAnchorElement | null) => void;
  onItemPointerMove: (index: number) => void;
}) {
  return (
    <div className={styles["menu-view"]}>
      {canGoBack ? (
        <div className={styles.header}>
          <button type="button" className={styles["back-button"]} onClick={onBack} aria-label="Back">
            <VscChevronLeft aria-hidden />
          </button>
          <div className={styles["header-title"]}>{view.title}</div>
        </div>
      ) : null}
      <ul className={styles.list}>
        {view.items.map((item, index) => {
          const hasChildren = Boolean(item.items?.length);
          const itemKey = `${view.id}:${item.id}`;
          return (
            <li key={item.id} className={styles["list-item"]}>
              <a
                ref={(element) => {
                  setItemRef(itemKey, element);
                }}
                href="#"
                className={cx(styles, "item", item.disabled && "itemDisabled", selectedItemId === itemKey && "itemSelected")}
                title={item.title}
                aria-disabled={item.disabled || undefined}
                aria-current={selectedItemId === itemKey ? "true" : undefined}
                onPointerMove={() => {
                  if (!item.disabled) onItemPointerMove(index);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  void onItemClick(item);
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1 || item.disabled || !item.onOpenInNewTab) return;
                  event.preventDefault();
                  void item.onOpenInNewTab();
                }}
              >
                <span className={styles["item-label"]}>{item.label}</span>
                {hasChildren ? <VscChevronRight aria-hidden className={styles["item-chevron"]} /> : null}
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
