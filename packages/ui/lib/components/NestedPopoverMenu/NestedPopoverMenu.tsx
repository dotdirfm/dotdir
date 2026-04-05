import { cx } from "@/utils/cssModules";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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

export function NestedPopoverMenu({
  items,
  placement = "bottom-end",
  className,
  popoverClassName,
  viewTitle,
  renderAnchor,
}: NestedPopoverMenuProps) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const currentContentRef = useRef<HTMLDivElement | null>(null);
  const prevContentRef = useRef<HTMLDivElement | null>(null);
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
  const [prevView, setPrevView] = useState<MenuView | null>(null);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | undefined>(undefined);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties | null>(null);

  const currentView = stack[stack.length - 1] ?? rootView;

  useEffect(() => {
    setStack([rootView]);
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

  const close = useCallback(() => {
    setOpen(false);
    setStack([rootView]);
    finishPreviousView();
  }, [finishPreviousView, rootView]);

  const toggle = useCallback(() => {
    setOpen((value) => {
      const next = !value;
      if (!next) {
        setStack([rootView]);
        finishPreviousView();
      }
      return next;
    });
  }, [finishPreviousView, rootView]);

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
  }, [currentView]);

  const popView = useCallback(() => {
    setStack((views) => {
      if (views.length <= 1) return views;
      setDirection(-1);
      setPrevView(views[views.length - 1] ?? null);
      prevContentRef.current = currentContentRef.current;
      return views.slice(0, -1);
    });
  }, []);

  const handleItemClick = useCallback(async (item: NestedPopoverMenuItem) => {
    if (item.disabled) return;
    if (item.items?.length) {
      pushView(item);
      return;
    }
    await item.onSelect?.();
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
        setStack([rootView]);
        finishPreviousView();
      }
    };
    popover.addEventListener("toggle", onToggle);
    return () => {
      popover.removeEventListener("toggle", onToggle);
    };
  }, [finishPreviousView, rootView]);

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
              <MenuViewBody view={currentView} canGoBack={stack.length > 1} onBack={popView} onItemClick={handleItemClick} />
            </div>
          ) : null}
          {prevView && prevView.id !== currentView.id ? (
            <div key={`prev-${prevView.id}`} ref={prevContentRef} className={styles["screen-previous"]}>
              <MenuViewBody view={prevView} canGoBack={stack.length > 1} onBack={popView} onItemClick={handleItemClick} />
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function MenuViewBody({
  view,
  canGoBack,
  onBack,
  onItemClick,
}: {
  view: MenuView;
  canGoBack: boolean;
  onBack: () => void;
  onItemClick: (item: NestedPopoverMenuItem) => void | Promise<void>;
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
        {view.items.map((item) => {
          const hasChildren = Boolean(item.items?.length);
          return (
            <li key={item.id} className={styles["list-item"]}>
              <a
                href="#"
                className={cx(styles, "item", item.disabled && "itemDisabled")}
                title={item.title}
                aria-disabled={item.disabled || undefined}
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
