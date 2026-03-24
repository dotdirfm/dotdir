import { memo, useCallback, useEffect, useRef, useState } from "react";
import { basename } from "../path";

export type PanelTab =
  | { id: string; type: "filelist"; path: string }
  | {
      id: string;
      type: "preview";
      path: string;
      name: string;
      size: number;
      isTemp: boolean;
      sourcePanel?: "left" | "right";
    };

interface PanelTabsProps {
  tabs: PanelTab[];
  activeIndex: number;
  onSelectTab: (index: number) => void;
  onDoubleClickTab: (index: number) => void;
  onCloseTab?: (index: number) => void;
  onNewTab: () => void;
  onReorderTabs?: (fromIndex: number, toIndex: number) => void;
}

function tabLabel(tab: PanelTab): string {
  if (tab.type === "filelist") {
    const base = basename(tab.path);
    return base || tab.path || "File list";
  }
  return tab.name;
}

export const PanelTabs = memo(function PanelTabs({ tabs, activeIndex, onSelectTab, onDoubleClickTab, onCloseTab, onNewTab, onReorderTabs }: PanelTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dragFromRef = useRef<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  tabRefs.current = tabs.map((_, i) => tabRefs.current[i] ?? null);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
  }, []);

  const getDropIndex = useCallback((clientX: number): number | null => {
    const list = listRef.current;
    if (!list) return null;
    const refs = tabRefs.current;
    for (let i = 0; i < refs.length; i++) {
      const tab = refs[i];
      if (!tab) continue;
      const r = tab.getBoundingClientRect();
      const mid = r.left + r.width / 2;
      if (clientX < mid) return i;
    }
    return refs.length;
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    dragFromRef.current = index;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
    e.dataTransfer.setDragImage(new Image(), 0, 0);
    requestAnimationFrame(() => {
      (e.target as HTMLElement).classList.add("panel-tab-dragging");
    });
  }, []);

  const handleListDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const idx = getDropIndex(e.clientX);
      setDropIndex(idx);
    },
    [getDropIndex],
  );

  const handleListDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const from = dragFromRef.current;
      const to = getDropIndex(e.clientX);
      if (from != null && to != null && onReorderTabs) {
        if (to > from) onReorderTabs(from, to - 1);
        else if (to < from) onReorderTabs(from, to);
        else;
      }
      dragFromRef.current = null;
      setDropIndex(null);
    },
    [getDropIndex, onReorderTabs],
  );

  const handleListDragLeave = useCallback((e: React.DragEvent) => {
    if (!listRef.current?.contains(e.relatedTarget as Node)) {
      setDropIndex(null);
    }
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    (e.target as HTMLElement).classList.remove("panel-tab-dragging");
    dragFromRef.current = null;
    setDropIndex(null);
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const suppress = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", suppress, { passive: false });
    return () => el.removeEventListener("wheel", suppress);
  }, []);

  return (
    <div className="panel-tabs">
      <div
        className="panel-tabs-list"
        ref={listRef}
        onWheel={handleWheel}
        onDragOver={handleListDragOver}
        onDrop={handleListDrop}
        onDragLeave={handleListDragLeave}
      >
        {tabs.flatMap((tab, i) => {
          const isPreview = tab.type === "preview";
          const isTemp = isPreview && tab.isTemp;
          const isActive = i === activeIndex;
          const showDropBefore = dropIndex === i;
          return [
            showDropBefore ? <div key={`drop-${i}`} className="panel-tab-drop-indicator" aria-hidden /> : null,
            <div
              key={tab.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              className={"panel-tab" + (isActive ? " active" : "") + (isTemp ? " temp" : "")}
              onClick={() => onSelectTab(i)}
              onDoubleClick={(e) => {
                e.preventDefault();
                onDoubleClickTab(i);
              }}
              title={tab.path}
              draggable
              onDragStart={(e) => handleDragStart(e, i)}
              onDragEnd={handleDragEnd}
            >
              <span className="panel-tab-label">{tabLabel(tab)}</span>
              {onCloseTab && (
                <button
                  type="button"
                  className="panel-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(i);
                  }}
                  aria-label="Close tab"
                >
                  ×
                </button>
              )}
            </div>,
          ];
        })}
        {dropIndex === tabs.length ? <div key="drop-end" className="panel-tab-drop-indicator" aria-hidden /> : null}
      </div>
      <button type="button" className="panel-tab-new" onClick={onNewTab} aria-label="New tab" title="New tab">
        +
      </button>
    </div>
  );
});
