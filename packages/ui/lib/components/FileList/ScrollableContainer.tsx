import { useMediaQuery } from "@/hooks/useMediaQuery";
import type React from "react";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";

interface ScrollableContainerProps {
  children: ReactNode;
  scrollHeight: number;
  scrollTop: number;
  lineSize?: number;
  velocityFactor?: number;
  frictionFactor?: number;
  style?: CSSProperties;
  onScroll?: (scrollTop: number) => void;
}

export const ScrollableContainer: React.FC<ScrollableContainerProps> = ({
  children,
  scrollHeight,
  scrollTop,
  lineSize,
  velocityFactor = 20,
  frictionFactor = 0.95,
  style,
  onScroll,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(scrollTop);
  const onScrollRef = useRef(onScroll);
  const isTouchscreen = useMediaQuery("(pointer: coarse)");

  scrollTopRef.current = scrollTop;
  onScrollRef.current = onScroll;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let touchStartY: number | undefined;
    let touchStartTime = 0;
    let velocity = 0;
    let isInertiaScrolling = false;

    const updateScrollTop = (scrollDelta: number) => {
      if (!onScrollRef.current) return;
      let newScrollTop = scrollTopRef.current + scrollDelta;
      newScrollTop = Math.min(newScrollTop, scrollHeight);
      newScrollTop = Math.max(0, newScrollTop);
      if (scrollTopRef.current !== newScrollTop) {
        scrollTopRef.current = newScrollTop;
        onScrollRef.current(newScrollTop);
      }
    };

    const isWindows = navigator.platform.startsWith("Win");

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const delta = lineSize && isWindows ? Math.sign(event.deltaY) * lineSize : event.deltaY;
      updateScrollTop(delta);
    };

    const handlePointerDown = (event: PointerEvent) => {
      touchStartY = event.clientY;
      touchStartTime = performance.now();
      isInertiaScrolling = false;
      velocity = 0;
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (touchStartY == null) return;
      const touchCurrentY = event.clientY;
      const deltaY = touchStartY - touchCurrentY;
      if (Math.abs(deltaY) < 3) return;

      container.setPointerCapture(event.pointerId);
      updateScrollTop(deltaY);
      touchStartY = touchCurrentY;
      const currentTime = performance.now();
      const timeDelta = currentTime - touchStartTime;
      touchStartTime = currentTime;
      if (timeDelta > 0) velocity = deltaY / timeDelta;
      event.preventDefault();
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (touchStartY == null) return;
      touchStartY = undefined;
      container.releasePointerCapture(event.pointerId);
      const inertiaScroll = () => {
        if (Math.abs(velocity) > 0.1) {
          updateScrollTop(velocity * velocityFactor);
          velocity *= frictionFactor;
          requestAnimationFrame(inertiaScroll);
        } else {
          isInertiaScrolling = false;
        }
      };
      if (!isInertiaScrolling) {
        isInertiaScrolling = true;
        requestAnimationFrame(inertiaScroll);
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    if (isTouchscreen) {
      container.addEventListener("pointerdown", handlePointerDown);
      container.addEventListener("pointermove", handlePointerMove);
      container.addEventListener("pointerup", handlePointerUp);
      container.addEventListener("pointercancel", handlePointerUp);
    }

    return () => {
      container.removeEventListener("wheel", handleWheel);
      if (isTouchscreen) {
        container.removeEventListener("pointerdown", handlePointerDown);
        container.removeEventListener("pointermove", handlePointerMove);
        container.removeEventListener("pointerup", handlePointerUp);
        container.removeEventListener("pointercancel", handlePointerUp);
      }
    };
  }, [velocityFactor, frictionFactor, scrollHeight, lineSize, isTouchscreen]);

  return (
    <div
      style={{
        overflow: "hidden",
        position: "relative",
        touchAction: "none",
        ...style,
      }}
    >
      <div ref={containerRef} style={{ position: "absolute", inset: 0, pointerEvents: "auto" }}>
        {children}
      </div>
    </div>
  );
};
