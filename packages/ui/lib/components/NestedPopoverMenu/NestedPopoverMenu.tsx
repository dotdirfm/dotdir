import {
  ACCEPT,
  CANCEL,
  CURSOR_DOWN,
  CURSOR_END,
  CURSOR_HOME,
  CURSOR_LEFT,
  CURSOR_PAGE_DOWN,
  CURSOR_PAGE_UP,
  CURSOR_RIGHT,
  CURSOR_UP,
} from "@dotdirfm/commands";
import { useCommandRegistry } from "@dotdirfm/commands";
import { DropdownSurface } from "@/components/DropdownSurface/DropdownSurface";
import { useFocusContext, useManagedFocusLayer } from "@/focusContext";
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
  const commandRegistry = useCommandRegistry();
  const focusContext = useFocusContext();
  const anchorContainerRef = useRef<HTMLSpanElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const currentContentRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLAnchorElement | null>());
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
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
      allowCommandRouting(event) {
        const editableTarget = focusContext.isEditableTarget(document.activeElement);
        if (editableTarget) return event.key === "Escape";
        return true;
      },
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

  const handleMenuCommand = useCallback((commandId: string): void => {
    if (!open) return;

    switch (commandId) {
      case CURSOR_UP: {
        if (selectedIndex < 0) {
          updateSelectedIndex(getLastEnabledIndex(currentView.items));
          return;
        }
        updateSelectedIndex(getNextEnabledIndex(currentView.items, selectedIndex, -1));
        return;
      }
      case CURSOR_DOWN: {
        if (selectedIndex < 0) {
          updateSelectedIndex(getFirstEnabledIndex(currentView.items));
          return;
        }
        updateSelectedIndex(getNextEnabledIndex(currentView.items, selectedIndex, 1));
        return;
      }
      case CURSOR_HOME:
      case CURSOR_PAGE_UP:
        updateSelectedIndex(getFirstEnabledIndex(currentView.items));
        return;
      case CURSOR_END:
      case CURSOR_PAGE_DOWN:
        updateSelectedIndex(getLastEnabledIndex(currentView.items));
        return;
      case CURSOR_LEFT:
        if (stack.length <= 1) return;
        popView();
        return;
      case CURSOR_RIGHT:
        if (!selectedItem?.items?.length && !selectedItem?.renderView) return;
        pushView(selectedItem);
        return;
      case ACCEPT:
        if (!selectedItem) return;
        void handleItemClick(selectedItem);
        return;
      case CANCEL:
        close();
        return;
      default:
        return;
    }
  }, [close, currentView.items, handleItemClick, open, popView, pushView, selectedIndex, selectedItem, stack.length, updateSelectedIndex]);

  useEffect(() => {
    if (!open) return;
    const disposables = [
      commandRegistry.registerCommand(CURSOR_UP, () => { handleMenuCommand(CURSOR_UP); }),
      commandRegistry.registerCommand(CURSOR_DOWN, () => { handleMenuCommand(CURSOR_DOWN); }),
      commandRegistry.registerCommand(CURSOR_HOME, () => { handleMenuCommand(CURSOR_HOME); }),
      commandRegistry.registerCommand(CURSOR_PAGE_UP, () => { handleMenuCommand(CURSOR_PAGE_UP); }),
      commandRegistry.registerCommand(CURSOR_END, () => { handleMenuCommand(CURSOR_END); }),
      commandRegistry.registerCommand(CURSOR_PAGE_DOWN, () => { handleMenuCommand(CURSOR_PAGE_DOWN); }),
      commandRegistry.registerCommand(CURSOR_LEFT, () => { handleMenuCommand(CURSOR_LEFT); }),
      commandRegistry.registerCommand(CURSOR_RIGHT, () => { handleMenuCommand(CURSOR_RIGHT); }),
      commandRegistry.registerCommand(ACCEPT, () => { handleMenuCommand(ACCEPT); }),
      commandRegistry.registerCommand(CANCEL, () => { handleMenuCommand(CANCEL); }),
    ];
    return () => {
      disposables.forEach((dispose) => dispose());
    };
  }, [commandRegistry, handleMenuCommand, open]);

  return (
    <>
      <span
        ref={anchorContainerRef}
        className={styles.anchor}
      >
        {renderAnchor({
          ref: anchorRef,
          id: popoverId,
          open,
          toggle,
          close,
        })}
      </span>
      <DropdownSurface
        open={open}
        anchor={{ type: "element", ref: anchorRef }}
        placement={placement}
        popoverMode="auto"
        surfaceRef={popoverRef}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setOpen(false);
        }}
        className={cx(
          styles,
          "popover",
          sizeAnimating && "popoverSizeAnimated",
          className,
          popoverClassName,
        )}
        style={{
          width: contentSize?.width,
          height: contentSize?.height,
        } as React.CSSProperties}
        onKeyDownCapture={(event) => {
          switch (event.key) {
            case "ArrowUp":
              event.preventDefault();
              event.stopPropagation();
              handleMenuCommand(CURSOR_UP);
              return;
            case "ArrowDown":
              event.preventDefault();
              event.stopPropagation();
              handleMenuCommand(CURSOR_DOWN);
              return;
            case "ArrowLeft":
              event.preventDefault();
              event.stopPropagation();
              handleMenuCommand(CURSOR_LEFT);
              return;
            case "ArrowRight":
              event.preventDefault();
              event.stopPropagation();
              handleMenuCommand(CURSOR_RIGHT);
              return;
            case "Home":
              event.preventDefault();
              event.stopPropagation();
              handleMenuCommand(CURSOR_HOME);
              return;
            case "End":
              event.preventDefault();
              event.stopPropagation();
              handleMenuCommand(CURSOR_END);
              return;
            case "PageUp":
              event.preventDefault();
              event.stopPropagation();
              handleMenuCommand(CURSOR_PAGE_UP);
              return;
            case "PageDown":
              event.preventDefault();
              event.stopPropagation();
              handleMenuCommand(CURSOR_PAGE_DOWN);
              return;
            case "Enter":
              event.preventDefault();
              event.stopPropagation();
              handleMenuCommand(ACCEPT);
              return;
            case "Escape":
              event.preventDefault();
              event.stopPropagation();
              handleMenuCommand(CANCEL);
              return;
            default:
              return;
          }
        }}
      >
        <div className={styles.viewport}>
          <div key={currentView.id} ref={observeCurrentContent} className={styles["screen-current"]}>
            <MenuViewBody
              view={currentView}
              canGoBack={stack.length > 1}
              onBack={popView}
              onCommand={handleMenuCommand}
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
      </DropdownSurface>
    </>
  );
});

function MenuViewBody({
  view,
  canGoBack,
  onBack,
  onCommand,
  onItemClick,
  selectedItemId,
  setItemRef,
  onItemPointerMove,
  close,
}: {
  view: MenuView;
  canGoBack: boolean;
  onBack: () => void;
  onCommand: (commandId: string) => void;
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
                onKeyDown={(event) => {
                  switch (event.key) {
                    case "ArrowLeft":
                      event.preventDefault();
                      event.stopPropagation();
                      onCommand(CURSOR_LEFT);
                      return;
                    case "ArrowRight":
                      event.preventDefault();
                      event.stopPropagation();
                      onCommand(CURSOR_RIGHT);
                      return;
                    case "Enter":
                      event.preventDefault();
                      event.stopPropagation();
                      onCommand(ACCEPT);
                      return;
                    case "Escape":
                      event.preventDefault();
                      event.stopPropagation();
                      onCommand(CANCEL);
                      return;
                    default:
                      return;
                  }
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
