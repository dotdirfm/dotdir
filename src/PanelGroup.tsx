import type { FsNode } from 'fss-lang';
import { FileList } from './FileList';
import { PanelTabs, type PanelTab } from './FileList/PanelTabs';
import type { PanelPersistedState } from './extensions';
import { ViewerContainer } from './ExtensionContainer';
import { viewerRegistry } from './viewerEditorRegistry';
import type { LayeredResolver } from 'fss-lang';

type PanelSide = 'left' | 'right';

interface PanelModel {
  currentPath: string;
  parentNode?: FsNode;
  entries: FsNode[];
  navigating: boolean;
  resolver: LayeredResolver;
  navigateTo: (path: string, force?: boolean) => Promise<void>;
}

interface PanelGroupProps {
  side: PanelSide;
  active: boolean;
  panel: PanelModel;
  tabs: PanelTab[];
  activeIndex: number;
  onSelectTab: (idx: number) => void;
  onDoubleClickTab: (idx: number) => void;
  onCloseTab: (idx: number) => void;
  onNewTab: () => void;
  onReorderTabs: (from: number, to: number) => void;
  filteredEntries: FsNode[];
  editorFileSizeLimit: number;
  onActivatePanel: () => void;
  onRememberExpectedTerminalCwd: (path: string) => void;
  onViewFile: (filePath: string, fileName: string, fileSize: number) => void;
  onEditFile: (filePath: string, fileName: string, fileSize: number, langId: string) => void;
  onMoveToTrash: (sourcePaths: string[], refresh: () => void) => void;
  onPermanentDelete: (sourcePaths: string[], refresh: () => void) => void;
  onCopy?: (sourcePaths: string[], refresh: () => void) => void;
  onMove?: (sourcePaths: string[], refresh: () => void) => void;
  onRename?: (sourcePath: string, currentName: string, refresh: () => void) => void;
  onExecuteInTerminal: (cmd: string) => Promise<void>;
  onPasteToCommandLine?: (text: string) => void;
  selectionKey?: number;
  requestedActiveName?: string;
  requestedTopmostName?: string;
  initialPanelState?: PanelPersistedState;
  onStateChange: (selectedName: string | undefined, topmostName: string | undefined) => void;
}

export function PanelGroup({
  active,
  panel,
  tabs,
  activeIndex,
  onSelectTab,
  onDoubleClickTab,
  onCloseTab,
  onNewTab,
  onReorderTabs,
  filteredEntries,
  editorFileSizeLimit,
  onActivatePanel,
  onRememberExpectedTerminalCwd,
  onViewFile,
  onEditFile,
  onMoveToTrash,
  onPermanentDelete,
  onCopy,
  onMove,
  onRename,
  onExecuteInTerminal,
  onPasteToCommandLine,
  selectionKey,
  requestedActiveName,
  requestedTopmostName,
  initialPanelState,
  onStateChange,
}: PanelGroupProps) {
  const activeTab = tabs[activeIndex];

  return (
    <div className={`panel ${active ? 'active' : ''}`} onClick={onActivatePanel}>
      {panel.navigating && <div className="panel-progress" />}
      <PanelTabs
        tabs={tabs}
        activeIndex={activeIndex}
        onSelectTab={onSelectTab}
        onDoubleClickTab={onDoubleClickTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
        onReorderTabs={onReorderTabs}
      />
      <div className="panel-content">
        {activeTab?.type === 'filelist' ? (
          <FileList
            key={activeTab.id}
            currentPath={panel.currentPath}
            parentNode={panel.parentNode}
            entries={filteredEntries}
            onNavigate={(path) => {
              onActivatePanel();
              onRememberExpectedTerminalCwd(path);
              return panel.navigateTo(path);
            }}
            onViewFile={onViewFile}
            onEditFile={onEditFile}
            onMoveToTrash={onMoveToTrash}
            onPermanentDelete={onPermanentDelete}
            onCopy={onCopy}
            onMove={onMove}
            onRename={onRename}
            onExecuteInTerminal={onExecuteInTerminal}
            onPasteToCommandLine={onPasteToCommandLine}
            selectionKey={selectionKey}
            editorFileSizeLimit={editorFileSizeLimit}
            active={active}
            resolver={panel.resolver}
            requestedActiveName={requestedActiveName ?? initialPanelState?.selectedName}
            requestedTopmostName={requestedTopmostName ?? initialPanelState?.topmostName}
            onStateChange={onStateChange}
          />
        ) : activeTab?.type === 'preview' ? (
          (() => {
            const tab = activeTab;
            if (tab.type !== 'preview') return null;
            const resolved = viewerRegistry.resolve(tab.name);
            if (resolved) {
              return (
                <ViewerContainer
                  extensionDirPath={resolved.extensionDirPath}
                  entry={resolved.contribution.entry}
                  filePath={tab.path}
                  fileName={tab.name}
                  fileSize={tab.size}
                  inline
                  onClose={() => onCloseTab(activeIndex)}
                />
              );
            }
            return (
              <div style={{ padding: 16, color: 'var(--fg-muted, #888)', textAlign: 'center' }}>
                No viewer extension for this file type. Install viewer extensions from the extensions panel.
              </div>
            );
          })()
        ) : null}
      </div>
    </div>
  );
}

