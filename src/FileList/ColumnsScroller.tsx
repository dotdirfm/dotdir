import { type ReactNode, memo, useCallback, useLayoutEffect, useRef, useEffect } from "react";
import { ScrollableContainer } from "./ScrollableContainer";
import { useElementSize } from "./useElementSize";

export interface ColumnsScrollerProps {
  topmostIndex: number;
  activeIndex: number;
  totalCount: number;
  itemHeight: number;
  minColumnWidth?: number;
  far?: boolean;
  selectedKeys?: ReadonlySet<string | number>;
  getItemKey?: (index: number) => string | number;
  renderItem(index: number, isActive: boolean, isSelected: boolean): ReactNode;
  onPosChange: (newTopmostItem: number, newActiveItem: number) => void;
  onItemsPerColumnChanged?: (count: number) => void;
  onColumnCountChanged?: (count: number) => void;
}

const ItemWrapper = memo(function ItemWrapper({
  index,
  isActive,
  isSelected,
  width,
  height,
  renderItem,
}: {
  index: number;
  isActive: boolean;
  isSelected: boolean;
  width: string;
  height: number;
  renderItem: (index: number, isActive: boolean, isSelected: boolean) => ReactNode;
}) {
  return <div style={{ width, height }}>{renderItem(index, isActive, isSelected)}</div>;
});

export const ColumnsScroller = memo(function ColumnsScroller(props: ColumnsScrollerProps) {
  let { topmostIndex } = props;
  const {
    activeIndex,
    totalCount,
    itemHeight,
    minColumnWidth,
    far = false,
    selectedKeys,
    getItemKey,
    renderItem,
    onPosChange,
    onItemsPerColumnChanged,
    onColumnCountChanged,
  } = props;

  if (!Number.isInteger(itemHeight) || itemHeight <= 0) {
    throw new Error("itemHeight should be positive");
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

  const propsTopmostIndex = props.topmostIndex;

  if (activeIndex < topmostIndex) {
    topmostIndex = activeIndex;
  } else if (activeIndex > topmostIndex + columnCount * itemsPerColumn - 1) {
    topmostIndex = activeIndex - columnCount * itemsPerColumn + 1;
  } else if (topmostIndex > totalCount - columnCount * itemsPerColumn) {
    topmostIndex = Math.max(0, totalCount - columnCount * itemsPerColumn);
  }

  // Propagate the clamped topmostIndex back to the parent whenever it diverges
  // from the incoming prop (e.g. keyboard navigation that scrolls the viewport).
  useEffect(() => {
    if (topmostIndex !== propsTopmostIndex) {
      onPosChangeRef.current?.(topmostIndex, activeIndex);
    }
  });

  const topmostIndexRef = useRef(topmostIndex);
  const activeIndexRef = useRef(activeIndex);
  topmostIndexRef.current = topmostIndex;
  activeIndexRef.current = activeIndex;

  const onScroll = useCallback(
    (scroll: number) => {
      const newActiveItem = Math.round(scroll / itemHeight);
      const delta = newActiveItem - activeIndexRef.current;
      if (delta) {
        const newTopmost = far ? topmostIndexRef.current + delta : topmostIndexRef.current;
        onPosChangeRef.current?.(newTopmost, newActiveItem);
      }
    },
    [itemHeight, far],
  );

  const end = Math.min(totalCount, topmostIndex + itemsPerColumn * columnCount);
  const widthPercent = `${100 / columnCount}%`;

  const items = [];
  for (let i = topmostIndex; i < end; i++) {
    const key = getItemKey ? getItemKey(i) : i;
    items.push(
      <ItemWrapper
        key={key}
        index={i}
        isActive={activeIndex === i}
        isSelected={selectedKeys?.has(key) ?? false}
        width={widthPercent}
        height={itemHeight}
        renderItem={renderItem}
      />,
    );
  }
  const usedItems = end - topmostIndex;
  const emptyColumns = columnCount - Math.ceil(usedItems / itemsPerColumn);
  for (let i = 0; i < emptyColumns; i++) {
    items.push(<div key={`empty-${i}`} style={{ height: "100%", width: widthPercent }} />);
  }

  return (
    <div className="columns-scroller-root" ref={rootRef}>
      <div className="columns-borders" style={{ gridTemplateColumns: `repeat(${columnCount}, 1fr)` }}>
        {Array.from({ length: columnCount }, (_, i) => (
          <div className="columns-border" key={i} />
        ))}
      </div>
      <ScrollableContainer
        scrollTop={activeIndex * itemHeight}
        scrollHeight={(totalCount - 1) * itemHeight}
        lineSize={itemHeight}
        style={{ height: "100%" }}
        onScroll={onScroll}
      >
        <div className="columns-scroller-content" style={{ height: itemsPerColumn * itemHeight }}>
          {items}
        </div>
      </ScrollableContainer>
    </div>
  );
});
