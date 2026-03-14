import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getBreadcrumbSegments } from '../path';

interface BreadcrumbsProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

export const Breadcrumbs = memo(function Breadcrumbs({ currentPath, onNavigate }: BreadcrumbsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [fullWidths, setFullWidths] = useState<number[]>([]);
  const [truncated, setTruncated] = useState<Set<number>>(new Set());
  const [showCopiedTooltip, setShowCopiedTooltip] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const segments = useMemo(() => getBreadcrumbSegments(currentPath), [currentPath]);

  const handleSegmentClick = useCallback(
    (seg: { path: string }, i: number, isLast: boolean) => {
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

  const measure = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    const measureEls = root.querySelectorAll('.breadcrumb-segment-measure');
    const textEls = root.querySelectorAll('.breadcrumb-segment-text');
    if (measureEls.length === 0) return;
    const widths = Array.from(measureEls).map((el) => (el as HTMLElement).offsetWidth);
    const truncatedSet = new Set<number>();
    textEls.forEach((el, i) => {
      const text = el as HTMLElement;
      if (text.scrollWidth > text.clientWidth) truncatedSet.add(i);
    });
    setFullWidths((prev) => (prev.length === widths.length && prev.every((w, j) => w === widths[j]) ? prev : widths));
    setTruncated((prev) => {
      if (prev.size !== truncatedSet.size || [...prev].some((i) => !truncatedSet.has(i))) return truncatedSet;
      return prev;
    });
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [currentPath, measure]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [measure]);

  if (segments.length === 0) return null;

  const separator = /^[A-Za-z]:[\\/]/.test(currentPath) || currentPath.includes('\\') ? '\\' : '/';

  return (
    <div className="breadcrumbs" ref={containerRef}>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const fullWidth = fullWidths[i];
        const isHovered = hoveredIndex === i;
        const isTruncated = truncated.has(i);
        return (
          <Fragment key={`${i}-${seg.path}`}>
            <div
              className={`breadcrumb-segment${isTruncated ? ' is-truncated' : ''}`}
            style={{
              flex: isLast ? '0 0.15 auto' : '0 1 auto',
              minWidth: isHovered && fullWidth != null ? fullWidth + 12 : 0,
            }}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
              onClick={(e) => {
                e.stopPropagation();
                handleSegmentClick(seg, i, isLast);
              }}
            >
              <span className="breadcrumb-segment-measure" aria-hidden>
                {seg.label}
              </span>
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
