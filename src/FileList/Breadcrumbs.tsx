import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getBreadcrumbSegments } from '../path';

interface BreadcrumbsProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

export const Breadcrumbs = memo(function Breadcrumbs({ currentPath, onNavigate }: BreadcrumbsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToEndRef = useRef(true);
  const adjustingScrollRef = useRef(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [showCopiedTooltip, setShowCopiedTooltip] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const segments = useMemo(() => getBreadcrumbSegments(currentPath), [currentPath]);

  const handleSegmentClick = useCallback(
    (seg: { path: string }, _i: number, isLast: boolean) => {
      if (isLast) {
        void navigator.clipboard.writeText(currentPath).then(() => {
          if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
          setShowCopiedTooltip(true);
          copiedTimerRef.current = setTimeout(() => {
            setShowCopiedTooltip(false);
            copiedTimerRef.current = null;
          }, 1000);
        });
      } else {
        onNavigate(seg.path);
      }
    },
    [currentPath, onNavigate],
  );

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const updateOverflowState = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    const maxScrollLeft = Math.max(0, root.scrollWidth - root.clientWidth);
    const nextCanScrollLeft = root.scrollLeft > 0;
    const nextCanScrollRight = root.scrollLeft < maxScrollLeft - 1;
    setCanScrollLeft((prev) => (prev === nextCanScrollLeft ? prev : nextCanScrollLeft));
    setCanScrollRight((prev) => (prev === nextCanScrollRight ? prev : nextCanScrollRight));
  }, []);

  const scrollToEnd = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    adjustingScrollRef.current = true;
    root.scrollLeft = root.scrollWidth;
    queueMicrotask(() => {
      adjustingScrollRef.current = false;
    });
  }, []);

  useLayoutEffect(() => {
    // Keep the end of the path visible; leading segments crop first.
    scrollToEnd();
    stickToEndRef.current = true;
    updateOverflowState();
  }, [currentPath, scrollToEnd, updateOverflowState]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const onScroll = () => {
      updateOverflowState();
    };
    const ro = new ResizeObserver(() => {
      if (stickToEndRef.current) {
        scrollToEnd();
      } else if (root.scrollLeft > root.scrollWidth - root.clientWidth) {
        scrollToEnd();
      }
      updateOverflowState();
    });
    ro.observe(root);
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      root.removeEventListener('scroll', onScroll);
    };
  }, [scrollToEnd, updateOverflowState]);

  if (segments.length === 0) return null;

  const separator = /^[A-Za-z]:[\\/]/.test(currentPath) || currentPath.includes('\\') ? '\\' : '/';

  return (
    <div
      className={`breadcrumbs${canScrollLeft ? ' is-cropped-left' : ''}${canScrollRight ? ' is-cropped-right' : ''}`}
      ref={containerRef}
      onWheel={(e) => {
        const root = containerRef.current;
        if (!root) return;
        const maxScrollLeft = Math.max(0, root.scrollWidth - root.clientWidth);
        const nextScrollLeft = root.scrollLeft + (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX);
        // Only explicit wheel/trackpad scrolling changes stick-to-end intent.
        stickToEndRef.current = nextScrollLeft >= maxScrollLeft - 1;
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.deltaY !== 0) {
          root.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      }}
    >
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <Fragment key={`${i}-${seg.path}`}>
            <div
              className="breadcrumb-segment"
              onClick={(e) => {
                e.stopPropagation();
                handleSegmentClick(seg, i, isLast);
              }}
            >
              <span className="breadcrumb-segment-text">{seg.label}</span>
            </div>
            {!isLast && seg.label !== '/' && <span className="breadcrumb-separator" aria-hidden>{separator}</span>}
          </Fragment>
        );
      })}
      {showCopiedTooltip && (
        <span className="breadcrumb-copied-tooltip" role="status">
          Path copied to clipboard
        </span>
      )}
    </div>
  );
});
