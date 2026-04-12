import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEventHandler, type MutableRefObject, type ReactNode } from "react";
import styles from "./DropdownSurface.module.css";

export type DropdownPlacement =
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

export type DropdownAnchor =
  | { type: "element"; ref: React.RefObject<HTMLElement | null> }
  | { type: "virtual"; getRect: () => DOMRect | null };

type ToggleEventLike = Event & {
  newState?: "open" | "closed";
};

export interface DropdownSurfaceProps {
  open: boolean;
  anchor: DropdownAnchor;
  className?: string;
  children: ReactNode;
  placement?: DropdownPlacement;
  offset?: number;
  popoverMode?: "manual" | "auto";
  matchAnchorWidth?: boolean;
  style?: CSSProperties;
  surfaceRef?: MutableRefObject<HTMLDivElement | null>;
  onOpenChange?: (open: boolean) => void;
  onKeyDownCapture?: KeyboardEventHandler<HTMLDivElement>;
}

const VIEWPORT_PADDING = 8;

function getPositionArea(placement: DropdownPlacement): string {
  switch (placement) {
    case "top-start":
      return "top span-right";
    case "top-end":
      return "top span-left";
    case "top-center":
      return "top center";
    case "bottom-start":
      return "bottom span-right";
    case "bottom-end":
      return "bottom span-left";
    case "bottom-center":
      return "bottom center";
    case "left-start":
      return "left span-bottom";
    case "left-end":
      return "left span-top";
    case "left-center":
      return "left center";
    case "right-start":
      return "right span-bottom";
    case "right-end":
      return "right span-top";
    case "right-center":
      return "right center";
  }
}

function getPlacementTranslate(placement: DropdownPlacement, offset: number): string {
  switch (placement) {
    case "top-start":
    case "top-end":
    case "top-center":
      return `0 ${-offset}px`;
    case "bottom-start":
    case "bottom-end":
    case "bottom-center":
      return `0 ${offset}px`;
    case "left-start":
    case "left-end":
    case "left-center":
      return `${-offset}px 0`;
    case "right-start":
    case "right-end":
    case "right-center":
      return `${offset}px 0`;
  }
}

function resolveAnchorRect(anchor: DropdownAnchor): DOMRect | null {
  if (anchor.type === "element") {
    return anchor.ref.current?.getBoundingClientRect() ?? null;
  }
  return anchor.getRect();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function computePosition(
  anchorRect: DOMRect,
  surfaceRect: DOMRect,
  placement: DropdownPlacement,
  offset: number,
): { left: number; top: number } {
  let left = anchorRect.left;
  let top = anchorRect.bottom + offset;

  switch (placement) {
    case "bottom-start":
      left = anchorRect.left;
      top = anchorRect.bottom + offset;
      break;
    case "bottom-end":
      left = anchorRect.right - surfaceRect.width;
      top = anchorRect.bottom + offset;
      break;
    case "bottom-center":
      left = anchorRect.left + (anchorRect.width - surfaceRect.width) / 2;
      top = anchorRect.bottom + offset;
      break;
    case "top-start":
      left = anchorRect.left;
      top = anchorRect.top - surfaceRect.height - offset;
      break;
    case "top-end":
      left = anchorRect.right - surfaceRect.width;
      top = anchorRect.top - surfaceRect.height - offset;
      break;
    case "top-center":
      left = anchorRect.left + (anchorRect.width - surfaceRect.width) / 2;
      top = anchorRect.top - surfaceRect.height - offset;
      break;
    case "left-start":
      left = anchorRect.left - surfaceRect.width - offset;
      top = anchorRect.top;
      break;
    case "left-end":
      left = anchorRect.left - surfaceRect.width - offset;
      top = anchorRect.bottom - surfaceRect.height;
      break;
    case "left-center":
      left = anchorRect.left - surfaceRect.width - offset;
      top = anchorRect.top + (anchorRect.height - surfaceRect.height) / 2;
      break;
    case "right-start":
      left = anchorRect.right + offset;
      top = anchorRect.top;
      break;
    case "right-end":
      left = anchorRect.right + offset;
      top = anchorRect.bottom - surfaceRect.height;
      break;
    case "right-center":
      left = anchorRect.right + offset;
      top = anchorRect.top + (anchorRect.height - surfaceRect.height) / 2;
      break;
  }

  const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - surfaceRect.width - VIEWPORT_PADDING);
  const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - surfaceRect.height - VIEWPORT_PADDING);

  return {
    left: clamp(left, VIEWPORT_PADDING, maxLeft),
    top: clamp(top, VIEWPORT_PADDING, maxTop),
  };
}

export function DropdownSurface({
  open,
  anchor,
  className,
  children,
  placement = "bottom-start",
  offset = 6,
  popoverMode = "manual",
  matchAnchorWidth = false,
  style,
  surfaceRef,
  onOpenChange,
  onKeyDownCapture,
}: DropdownSurfaceProps) {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const [positionStyle, setPositionStyle] = useState<CSSProperties>({});
  const [positionReady, setPositionReady] = useState(false);
  const anchorNameRef = useRef(`--dropdown-anchor-${Math.random().toString(36).slice(2, 10)}`);

  useEffect(() => {
    if (surfaceRef) {
      surfaceRef.current = internalRef.current;
    }
  });

  useEffect(() => {
    const surface = internalRef.current;
    if (!surface) return;
    if (!("showPopover" in surface)) return;
    const popoverSurface = surface as HTMLDivElement & {
      showPopover: () => void;
      hidePopover: () => void;
      matches: (selector: string) => boolean;
    };
    const isOpen = popoverSurface.matches(":popover-open");
    if (open) {
      if (!isOpen) popoverSurface.showPopover();
      return;
    }
    if (isOpen) popoverSurface.hidePopover();
  }, [open]);

  useEffect(() => {
    const surface = internalRef.current;
    if (!surface || !onOpenChange) return;
    const handleToggle = (event: Event) => {
      onOpenChange((event as ToggleEventLike).newState === "open");
    };
    surface.addEventListener("toggle", handleToggle);
    return () => {
      surface.removeEventListener("toggle", handleToggle);
    };
  }, [onOpenChange]);

  useLayoutEffect(() => {
    if (!open) {
      setPositionReady(false);
      setPositionStyle({});
      return;
    }

    if (anchor.type === "element") {
      setPositionReady(true);
      setPositionStyle(matchAnchorWidth && anchor.ref.current ? { width: anchor.ref.current.getBoundingClientRect().width } : {});
      return;
    }

    const updatePosition = () => {
      const surface = internalRef.current;
      const anchorRect = resolveAnchorRect(anchor);
      if (!surface || !anchorRect) return;

      const nextStyle: CSSProperties = {};
      if (matchAnchorWidth) {
        nextStyle.width = anchorRect.width;
      }

      const surfaceRect = surface.getBoundingClientRect();
      const { left, top } = computePosition(anchorRect, surfaceRect, placement, offset);
      nextStyle.left = left;
      nextStyle.top = top;
      setPositionStyle(nextStyle);
      setPositionReady(true);
    };

    setPositionReady(false);

    let frame1 = 0;
    let frame2 = 0;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            updatePosition();
          });
    frame1 = requestAnimationFrame(() => {
      updatePosition();
      frame2 = requestAnimationFrame(updatePosition);
    });

    const surface = internalRef.current;
    if (surface && observer) {
      observer.observe(surface);
    }
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      cancelAnimationFrame(frame1);
      cancelAnimationFrame(frame2);
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchor, matchAnchorWidth, offset, open, placement, children]);

  useEffect(() => {
    if (anchor.type !== "element") return;
    const element = anchor.ref.current;
    if (!element) return;
    const previousAnchorName = element.style.getPropertyValue("anchor-name");
    element.style.setProperty("anchor-name", anchorNameRef.current);
    return () => {
      if (previousAnchorName) {
        element.style.setProperty("anchor-name", previousAnchorName);
      } else {
        element.style.removeProperty("anchor-name");
      }
    };
  }, [anchor]);

  const anchoredStyle =
    anchor.type === "element"
      ? ({
          positionAnchor: anchorNameRef.current,
          positionArea: getPositionArea(placement),
          translate: getPlacementTranslate(placement, offset),
          width: matchAnchorWidth && anchor.ref.current ? anchor.ref.current.getBoundingClientRect().width : undefined,
        } as CSSProperties)
      : undefined;

  return (
    <div
      ref={internalRef}
      popover={popoverMode}
      inert={open ? undefined : true}
      aria-hidden={open ? undefined : true}
      className={className ? `${styles.surface} ${className}` : styles.surface}
      style={{
        visibility: open && !positionReady ? "hidden" : undefined,
        ...anchoredStyle,
        ...positionStyle,
        ...style,
      }}
      onKeyDownCapture={onKeyDownCapture}
    >
      {children}
    </div>
  );
}
