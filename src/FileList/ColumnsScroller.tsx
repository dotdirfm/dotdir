import { type ReactNode, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ScrollableContainer } from './ScrollableContainer';
import { useElementSize } from './useElementSize';

export interface ColumnsScrollerProps {
  topmostIndex: number;
  activeIndex: number;
  totalCount: number;
  itemHeight: number;
  minColumnWidth?: number;
  renderItem(index: number): ReactNode;
  onPosChange: (newTopmostItem: number, newActiveItem: number) => void;
  onItemsPerColumnChanged?: (count: number) => void;
  onColumnCountChanged?: (count: number) => void;
}

export const ColumnsScroller = memo(function ColumnsScroller(props: ColumnsScrollerProps) {
  let { topmostIndex } = props;
  const { activeIndex, totalCount, itemHeight, minColumnWidth, renderItem, onPosChange, onItemsPerColumnChanged, onColumnCountChanged } = props;

  if (!Number.isInteger(itemHeight) || itemHeight <= 0) {
    throw new Error('itemHeight should be positive');
  }

  const onPosChangeRef = useRef(onPosChange);
  const onItemsPerColumnChangedRef = useRef(onItemsPerColumnChanged);
  const onColumnCountChangedRef = useRef(onColumnCountChanged);
  onPosChangeRef.current = onPosChange;
  onItemsPerColumnChangedRef.current = onItemsPerColumnChanged;
  onColumnCountChangedRef.current = onColumnCountChanged;

  const rootRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(rootRef);

  const columnCount = minColumnWidth != null && width > 0 ? Math.max(1, Math.floor(width / minColumnWidth)) : 1;
  const itemsPerColumn = Math.max(1, Math.floor(height / itemHeight));

  useLayoutEffect(() => {
    onItemsPerColumnChangedRef.current?.(itemsPerColumn);
  }, [itemsPerColumn]);

  useLayoutEffect(() => {
    onColumnCountChangedRef.current?.(columnCount);
  }, [columnCount]);

  if (activeIndex < topmostIndex) {
    topmostIndex = activeIndex;
  } else if (activeIndex > topmostIndex + columnCount * itemsPerColumn - 1) {
    topmostIndex = activeIndex - columnCount * itemsPerColumn + 1;
  } else if (topmostIndex > totalCount - columnCount * itemsPerColumn) {
    topmostIndex = Math.max(0, totalCount - columnCount * itemsPerColumn);
  }

  const topmostIndexRef = useRef(topmostIndex);
  const activeIndexRef = useRef(activeIndex);
  topmostIndexRef.current = topmostIndex;
  activeIndexRef.current = activeIndex;

  const items = useMemo(() => {
    const end = Math.min(totalCount, topmostIndex + itemsPerColumn * columnCount);
    const slice = [];
    for (let i = topmostIndex; i < end; i++) {
      slice.push(
        <div key={i} style={{ width: `${100 / columnCount}%`, height: itemHeight }}>
          {renderItem(i)}
        </div>,
      );
    }
    // Empty trailing columns to preserve flex layout
    const usedItems = end - topmostIndex;
    const emptyColumns = columnCount - Math.ceil(usedItems / itemsPerColumn);
    for (let i = 0; i < emptyColumns; i++) {
      slice.push(
        <div key={`empty-${i}`} style={{ height: '100%', width: `${100 / columnCount}%` }} />,
      );
    }
    return slice;
  }, [columnCount, renderItem, itemHeight, itemsPerColumn, topmostIndex, totalCount]);

  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    setScrollTop(activeIndex * itemHeight);
  }, [itemHeight, activeIndex]);

  const onScroll = useCallback(
    (scroll: number) => {
      setScrollTop(scroll);
      const newActiveItem = Math.round(scroll / itemHeight);
      const delta = newActiveItem - activeIndexRef.current;
      if (delta) {
        onPosChangeRef.current?.(topmostIndexRef.current + delta, newActiveItem);
      }
    },
    [itemHeight],
  );

  return (
    <div className="columns-scroller-root" ref={rootRef}>
      <div className="columns-borders" style={{ gridTemplateColumns: `repeat(${columnCount}, 1fr)` }}>
        {Array.from({ length: columnCount }, (_, i) => (
          <div className="columns-border" key={i} />
        ))}
      </div>
      <ScrollableContainer
        scrollTop={scrollTop}
        scrollHeight={(totalCount - 1) * itemHeight}
        lineSize={itemHeight}
        style={{ height: '100%' }}
        onScroll={onScroll}
      >
        <div
          className="columns-scroller-content"
          style={{ height: itemsPerColumn * itemHeight }}
        >
          {items}
        </div>
      </ScrollableContainer>
    </div>
  );
});
