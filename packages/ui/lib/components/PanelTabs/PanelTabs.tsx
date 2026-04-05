import { ActionBar } from "@/components/ActionBar/ActionBar";
import { Tabs, type TabsItem } from "@/components/Tabs/Tabs";
import type { PanelTab } from "@/entities/tab/model/types";
import { basename } from "@/utils/path";
import { memo, useMemo } from "react";
import panelTabsStyles from "./PanelTabs.module.css";

interface PanelTabsProps {
  tabs: PanelTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onDoubleClickTab: (id: string) => void;
  onCloseTab?: (id: string) => void;
  onNewTab: () => void;
  onReorderTabs?: (fromIndex: number, toIndex: number) => void;
}

function tabLabel(tab: PanelTab): string {
  if (tab.type === "filelist") {
    const base = basename(tab.path);
    return base || tab.path || "File list";
  }
  return `${tab.dirty ? "* " : ""}${tab.name}`;
}

export const PanelTabs = memo(function PanelTabs({ tabs, activeTabId, onSelectTab, onDoubleClickTab, onCloseTab, onNewTab, onReorderTabs }: PanelTabsProps) {
  const items = useMemo<Array<TabsItem & { temp?: boolean }>>(
    () =>
      tabs.map((tab) => {
        const isPreview = tab.type === "preview";
        const isTemp = isPreview && tab.isTemp && !tab.dirty;
        return {
          id: tab.id,
          label: tabLabel(tab),
          title: tab.path,
          temp: isTemp,
        };
      }),
    [tabs],
  );

  return (
    <Tabs
      items={items}
      activeItemId={activeTabId}
      onSelectItem={onSelectTab}
      onDoubleClickItem={onDoubleClickTab}
      onCloseItem={onCloseTab}
      onReorderItems={onReorderTabs}
      getItemClassName={(item) => (item.temp ? panelTabsStyles.temp : undefined)}
      rightSlot={
        <ActionBar>
          <a className={panelTabsStyles["panel-tab-new"]} onClick={onNewTab} aria-label="New tab" title="New tab">
            +
          </a>
        </ActionBar>
      }
    />
  );
});
