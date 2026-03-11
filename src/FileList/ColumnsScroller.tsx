import { type ReactNode, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ScrollableContainer } from './ScrollableContainer';
import { useElementSize } from './useElementSize';

export interface ColumnsScrollerProps {
  topmostIndex: number;
  activeIndex: number;
  columnCount: number;
  totalCount: number;
  itemHeight: number;
  renderItem(index: number): ReactNode;
  onPosChange: (newTopmostItem: number, newActiveItem: number) => void;
  onItemsPerColumnChanged?: (count: number) => void;
}

function Borders({ columnCount }: { columnCount: number }) {
  const borders = [];
  for (let i = 0; i < columnCount; i++) {
    borders.push(<div className="columns-border" key={i} />);
  }
  return <div className="columns-borders">{borders}</div>;
}

export const ColumnsScroller = memo(function ColumnsScroller(props: ColumnsScrollerProps) {
  let { topmostIndex } = props;
  const { activeIndex, columnCount, totalCount, itemHeight, renderItem, onPosChange, onItemsPerColumnChanged } = props;

  if (!Number.isInteger(itemHeight) || itemHeight <= 0) {
    throw new Error('itemHeight should be positive');
  }

  const onPosChangeRef = useRef(onPosChange);
  const onItemsPerColumnChangedRef = useRef(onItemsPerColumnChanged);
  onPosChangeRef.current = onPosChange;
  onItemsPerColumnChangedRef.current = onItemsPerColumnChanged;

  const rootRef = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(rootRef);
  const itemsPerColumn = Math.max(1, Math.floor(height / itemHeight));

  useLayoutEffect(() => {
    onItemsPerColumnChangedRef.current?.(itemsPerColumn);
  }, [itemsPerColumn]);

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
    const slice = [];
    const end = Math.min(totalCount, topmostIndex + itemsPerColumn * columnCount);
    for (let i = topmostIndex; i < end; i++) {
      slice.push(
        <div key={i} style={{ height: itemHeight }}>
          {renderItem(i)}
        </div>,
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
      <Borders columnCount={columnCount} />
      <ScrollableContainer
        scrollTop={scrollTop}
        scrollHeight={(totalCount - 1) * itemHeight}
        lineSize={itemHeight}
        style={{ height: '100%' }}
        innerContainerStyle={{ width: '100%', height: '100%' }}
        onScroll={onScroll}
      >
        <div
          className="columns-scroller-content"
          style={{ columnCount, height: itemsPerColumn * itemHeight }}
        >
          {/* Workaround for Chrome macOS column layout bug */}
          {/* <div style={{ height: 0.1, overflow: 'hidden' }} /> */}
          {items}
        </div>
      </ScrollableContainer>
    </div>
  );
});
