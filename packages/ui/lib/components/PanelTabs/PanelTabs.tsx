import { ActionBar } from "@/components/ActionBar/ActionBar";
import {
  NestedPopoverMenu,
  type NestedPopoverMenuHandle,
  type NestedPopoverMenuItem,
} from "@/components/NestedPopoverMenu/NestedPopoverMenu";
import { Tabs, type TabsItem } from "@/components/Tabs/Tabs";
import type { PanelTab } from "@/entities/tab/model/types";
import { basename } from "@/utils/path";
import { memo, useMemo, type RefObject } from "react";
import { VscEllipsis } from "react-icons/vsc";
import panelTabsStyles from "./PanelTabs.module.css";

interface PanelTabsProps {
  tabs: PanelTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onDoubleClickTab: (id: string) => void;
  onCloseTab?: (id: string) => void;
  onReorderTabs?: (fromIndex: number, toIndex: number) => void;
  menuItems: NestedPopoverMenuItem[];
  menuRef?: RefObject<NestedPopoverMenuHandle | null>;
}

function tabLabel(tab: PanelTab): string {
  if (tab.type === "filelist") {
    const base = basename(tab.path);
    return base || tab.path || "File list";
  }
  return `${tab.dirty ? "* " : ""}${tab.name}`;
}

export const PanelTabs = memo(function PanelTabs({
  tabs,
  activeTabId,
  onSelectTab,
  onDoubleClickTab,
  onCloseTab,
  onReorderTabs,
  menuItems,
  menuRef,
}: PanelTabsProps) {
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
          <NestedPopoverMenu
            ref={menuRef}
            items={menuItems}
            placement="bottom-end"
            renderAnchor={({ ref, open, toggle }) => (
              <button
                ref={ref as RefObject<HTMLButtonElement | null>}
                type="button"
                className={panelTabsStyles["panel-tab-menu"]}
                onClick={toggle}
                aria-label="Tab actions"
                aria-expanded={open}
                title="Tab actions"
              >
                <VscEllipsis aria-hidden />
              </button>
            )}
          />
        </ActionBar>
      }
    />
  );
});
