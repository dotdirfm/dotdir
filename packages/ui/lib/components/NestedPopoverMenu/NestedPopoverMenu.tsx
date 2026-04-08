import { useFocusContext, useManagedFocusLayer } from "@/focusContext";
import { useInteractionContext, type InteractionIntent } from "@/interactionContext";
import { cx } from "@/utils/cssModules";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
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
  sectionLabel?: boolean;
  showHeader?: boolean;
  onSelect?: () => void | Promise<void>;
  onOpenInNewTab?: () => void | Promise<void>;
  items?: NestedPopoverMenuItem[];
  renderView?: (props: { close: () => void; goBack: () => void }) => React.ReactNode;
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
  showHeader?: boolean;
  renderView?: (props: { close: () => void; goBack: () => void }) => React.ReactNode;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: Document["startViewTransition"];
};

function measureElementSize(element: HTMLElement | null): { width: number; height: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
  };
}

function getFirstEnabledIndex(items: NestedPopoverMenuItem[]): number {
  return items.findIndex((item) => !item.disabled && !item.sectionLabel);
}

function getLastEnabledIndex(items: NestedPopoverMenuItem[]): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (!items[index]?.disabled && !items[index]?.sectionLabel) return index;
  }
  return -1;
}

function getNextEnabledIndex(items: NestedPopoverMenuItem[], startIndex: number, delta: 1 | -1): number {
  if (items.length === 0) return -1;
  let index = startIndex;
  for (let step = 0; step < items.length; step++) {
    index = (index + delta + items.length) % items.length;
    if (!items[index]?.disabled && !items[index]?.sectionLabel) return index;
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
  const anchorContainerRef = useRef<HTMLSpanElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const currentContentRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLAnchorElement | null>());
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const generatedId = useId().replace(/:/g, "");
  const popoverId = `nested-menu-${generatedId}`;
  const anchorName = `--nested-menu-anchor-${generatedId}`;

  const rootView = useMemo<MenuView>(
    () => ({
      id: "root",
      title: viewTitle,
      items,
    }),
    [items, viewTitle],
  );

  const [open, setOpen] = useState(false);
  useManagedFocusLayer("menu", open);
  const [stack, setStack] = useState<MenuView[]>([rootView]);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([getFirstEnabledIndex(rootView.items)]);
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | undefined>(undefined);
  const rootViewSizeRef = useRef<{ width: number; height: number } | undefined>(undefined);
  const [sizeAnimating, setSizeAnimating] = useState(false);
  const currentView = stack[stack.length - 1] ?? rootView;
  const currentViewHasList = !currentView.renderView;
  const selectedIndex = currentViewHasList
    ? (selectedIndices[selectedIndices.length - 1] ?? getFirstEnabledIndex(currentView.items))
    : -1;
  const selectedItem = currentViewHasList && selectedIndex >= 0 ? currentView.items[selectedIndex] : undefined;
  const selectedItemId = selectedItem ? `${currentView.id}:${selectedItem.id}` : null;

  useEffect(() => {
    resizeObserverRef.current = new ResizeObserver((entries) => {
      const entry = entries[0];
      const element = entry?.target;
      if (!(element instanceof HTMLElement)) return;
      const measured = measureElementSize(element);
      if (!measured) return;
      setContentSize(measured);
    });
    return () => {
      resizeObserverRef.current?.disconnect();
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
      if (measured) {
        setContentSize(measured);
        if ((stack[stack.length - 1] ?? rootView).id === rootView.id) {
          rootViewSizeRef.current = measured;
        }
      }
    }
  }, [rootView, stack]);

  const runViewTransition = useCallback((direction: "forward" | "backward", update: () => void) => {
    const html = document.documentElement;
    html.dataset.nestedMenuDirection = direction;
    setSizeAnimating(true);
    const clear = () => {
      delete html.dataset.nestedMenuDirection;
      setSizeAnimating(false);
    };
    const transition = (document as ViewTransitionDocument).startViewTransition?.(() => {
      update();
    });
    if (transition) {
      void transition.finished.finally(clear);
      return;
    }
    update();
    requestAnimationFrame(clear);
  }, []);

  const resetToRoot = useCallback(() => {
    setStack([rootView]);
    setSelectedIndices([getFirstEnabledIndex(rootView.items)]);
    setContentSize(rootViewSizeRef.current);
  }, [rootView]);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

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
      if (next) {
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
    if (!item.items?.length && !item.renderView) return;
    runViewTransition("forward", () => {
      setStack((views) => [
        ...views,
        {
          id: item.id,
          title: item.label,
          items: item.items ?? [],
          showHeader: item.showHeader,
          renderView: item.renderView,
        },
      ]);
      setSelectedIndices((indices) => [...indices, item.renderView ? -1 : getFirstEnabledIndex(item.items ?? [])]);
    });
  }, [runViewTransition]);

  const popView = useCallback(() => {
    runViewTransition("backward", () => {
      setStack((views) => {
        if (views.length <= 1) return views;
        return views.slice(0, -1);
      });
      setSelectedIndices((indices) => (indices.length > 1 ? indices.slice(0, -1) : indices));
    });
  }, [runViewTransition]);

  const handleItemClick = useCallback(async (item: NestedPopoverMenuItem, alternate = false) => {
    if (item.disabled) return;
    if (item.items?.length || item.renderView) {
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
      }
    };
    popover.addEventListener("toggle", onToggle);
    return () => {
      popover.removeEventListener("toggle", onToggle);
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const handleWindowBlur = () => {
      close();
    };

    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [close, open]);

  useEffect(() => {
    const container = popoverRef.current;
    if (!container) return;
    return focusContext.registerAdapter("menu", {
      focus() {
        if (selectedItemId) {
          itemRefs.current.get(selectedItemId)?.focus();
          return;
        }
        const currentContent = currentContentRef.current;
        const editable = currentContent?.querySelector<HTMLElement>(
          'input, textarea, select, [contenteditable="true"], [contenteditable=""], [tabindex]:not([tabindex="-1"])',
        );
        if (editable) {
          editable.focus();
          return;
        }
        anchorRef.current?.focus();
      },
      contains(node) {
        return node instanceof Node
          ? container.contains(node) ||
              anchorRef.current?.contains(node) === true ||
              anchorContainerRef.current?.contains(node) === true
          : false;
      },
      allowCommandRouting: true,
    });
  }, [focusContext, selectedItemId]);

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
    const editableTarget = focusContext.isEditableTarget(document.activeElement);

    if (editableTarget) {
      if (intent === "cancel") {
        close();
        return true;
      }
      return false;
    }

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
        if (!selectedItem?.items?.length && !selectedItem?.renderView) return false;
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
  }, [close, currentView.items, focusContext, handleItemClick, open, popView, pushView, selectedIndex, selectedItem, stack.length, updateSelectedIndex]);

  useEffect(() => {
    return interactionContext.registerController({
      contains(node) {
        const popover = popoverRef.current;
        return node instanceof Node
          ? (popover?.contains(node) ?? false) ||
              (anchorRef.current?.contains(node) ?? false) ||
              (anchorContainerRef.current?.contains(node) ?? false)
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
      <span
        ref={anchorContainerRef}
        className={styles.anchor}
        style={{ anchorName } as React.CSSProperties}
      >
        {renderAnchor({
          ref: anchorRef,
          id: popoverId,
          open,
          toggle,
          close,
        })}
      </span>
      <div
        ref={popoverRef}
        popover="auto"
        id={popoverId}
        className={cx(
          styles,
          "popover",
          sizeAnimating && "popoverSizeAnimated",
          `placement-${placement}`,
          className,
          popoverClassName,
        )}
        style={{
          positionAnchor: anchorName,
          width: contentSize?.width,
          height: contentSize?.height,
        } as React.CSSProperties}
      >
        <div className={styles.viewport}>
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
              close={close}
            />
          </div>
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
  close,
}: {
  view: MenuView;
  canGoBack: boolean;
  onBack: () => void;
  onItemClick: (item: NestedPopoverMenuItem) => void | Promise<void>;
  selectedItemId: string | null;
  setItemRef: (itemId: string, element: HTMLAnchorElement | null) => void;
  onItemPointerMove: (index: number) => void;
  close: () => void;
}) {
  if (view.renderView) {
    return (
      <div className={styles["menu-view"]}>
        {canGoBack && view.showHeader !== false ? (
          <div className={styles.header}>
            <button type="button" className={styles["back-button"]} onClick={onBack} aria-label="Back">
              <VscChevronLeft aria-hidden />
            </button>
            <div className={styles["header-title"]}>{view.title}</div>
          </div>
        ) : null}
        <div className={styles["custom-view"]}>{view.renderView?.({ close, goBack: onBack })}</div>
      </div>
    );
  }

  return (
    <div className={styles["menu-view"]}>
      {canGoBack && view.showHeader !== false ? (
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
          if (item.sectionLabel) {
            return (
              <li key={item.id} className={styles["list-item"]}>
                <div className={styles["section-label"]}>{item.label}</div>
              </li>
            );
          }
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
