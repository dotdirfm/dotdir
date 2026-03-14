import { FsNode } from 'fss-lang';
import type { LayeredResolver } from 'fss-lang';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { actionQueue } from '../actionQueue';
import { commandRegistry } from '../commands';
import { resolveEntryStyle } from '../fss';
import { resolveIcon, loadIconsForPaths, getCachedIcon, onIconThemeChange } from '../iconResolver';
import { dirname, isRootPath, join } from '../path';
import { ColumnsScroller, type ColumnsScrollerProps } from './ColumnsScroller';
import { useElementSize } from './useElementSize';

const ROW_HEIGHT = 26;
const COLUMN_WIDTH = 350;

interface FileListProps {
  currentPath: string;
  parentNode?: FsNode;
  entries: FsNode[];
  onNavigate: (path: string) => Promise<void>;
  onViewFile?: (filePath: string, fileName: string, fileSize: number) => void;
  onEditFile?: (filePath: string, fileName: string, fileSize: number, langId: string) => void;
  editorFileSizeLimit?: number;
  active: boolean;
  resolver: LayeredResolver;
  requestedActiveName?: string;
}

interface DisplayEntry {
  entry: FsNode;
  style: { color?: string; opacity?: number; icon: string | null; sortPriority: number; groupFirst: boolean };
  iconPath: string | null;
}

function formatSize(sizeValue: unknown): string {
  let size: number;
  if (typeof sizeValue === 'number') size = sizeValue;
  else if (typeof sizeValue === 'bigint') size = Number(sizeValue);
  else return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} K`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} M`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} G`;
}

function formatDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getIconUrl(iconPath: string | null): string | undefined {
  if (iconPath) {
    return getCachedIcon(iconPath) ?? undefined;
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export const FileList = memo(function FileList({
  currentPath,
  parentNode,
  entries,
  onNavigate,
  onViewFile,
  onEditFile,
  editorFileSizeLimit = 1024 * 1024,
  active,
  resolver,
  requestedActiveName,
}: FileListProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [topmostIndex, setTopmostIndex] = useState(0);
  const [maxItemsPerColumn, setMaxItemsPerColumn] = useState(1);
  const [iconsVersion, setIconsVersion] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const prevPathRef = useRef(currentPath);
  const { width } = useElementSize(rootRef);

  const columnCount = Math.max(1, width ? Math.ceil(width / COLUMN_WIDTH) : 1);

  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const topmostIndexRef = useRef(topmostIndex);
  topmostIndexRef.current = topmostIndex;
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onViewFileRef = useRef(onViewFile);
  onViewFileRef.current = onViewFile;
  const onEditFileRef = useRef(onEditFile);
  onEditFileRef.current = onEditFile;
  const editorFileSizeLimitRef = useRef(editorFileSizeLimit);
  editorFileSizeLimitRef.current = editorFileSizeLimit;

  const sorted = useMemo(() => {
    const withStyle = entries.map((entry) => {
      entry = { ...entry, parent: parentNode };
      const style = resolveEntryStyle(resolver, entry);
      const isDir = entry.type === 'folder';
      const resolved = resolveIcon(entry.name, isDir, false, false, entry.lang, style.icon);
      return { entry, style, iconPath: resolved?.path ?? null };
    });
    withStyle.sort((a, b) => {
      if (a.style.groupFirst !== b.style.groupFirst) return a.style.groupFirst ? -1 : 1;
      if (a.style.sortPriority !== b.style.sortPriority) return b.style.sortPriority - a.style.sortPriority;
      return a.entry.name.localeCompare(b.entry.name);
    });
    return withStyle;
  }, [entries, currentPath]);

  const displayEntries: DisplayEntry[] = useMemo(() => {
    const result: DisplayEntry[] = [];
    if (parentNode) {
      const expandedParentNode = { ...parentNode, stateFlags: 1 };
      const style = resolveEntryStyle(resolver, expandedParentNode);
      const resolved = resolveIcon('..', true, true, false, '', style.icon);
      result.push({ entry: { ...expandedParentNode, name: '..' }, style, iconPath: resolved?.path ?? null });
    }
    for (const item of sorted) result.push(item);
    return result;
  }, [sorted, parentNode]);

  const displayEntriesRef = useRef(displayEntries);
  displayEntriesRef.current = displayEntries;

  const neededIcons = useMemo(() => {
    const paths = new Set<string>();
    for (const { iconPath } of displayEntries) {
      if (iconPath) paths.add(iconPath);
    }
    return [...paths];
  }, [displayEntries]);

  useEffect(() => {
    let cancelled = false;
    loadIconsForPaths(neededIcons).then(() => {
      if (!cancelled) setIconsVersion((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [neededIcons]);

  // Re-render when icon theme changes
  useEffect(() => {
    return onIconThemeChange(() => {
      setIconsVersion((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    const prevPath = prevPathRef.current;
    prevPathRef.current = currentPath;

    if (prevPath === currentPath) {
      setActiveIndex((i) => Math.min(i, displayEntries.length - 1));
      return;
    }
    if (prevPath.startsWith(currentPath)) {
      const remainder = prevPath.slice(currentPath.length).replace(/^\//, '');
      const childName = remainder.split('/')[0];
      if (childName) {
        const idx = displayEntries.findIndex((d) => d.entry.name === childName);
        if (idx >= 0) {
          setActiveIndex(idx);
          setTopmostIndex(0);
          return;
        }
      }
    }
    setActiveIndex(0);
    setTopmostIndex(0);
  }, [currentPath, displayEntries]);

  useEffect(() => {
    if (!requestedActiveName) return;
    const entries = displayEntriesRef.current;
    const idx = entries.findIndex(d => d.entry.name === requestedActiveName);
    if (idx >= 0) setActiveIndex(idx);
  }, [requestedActiveName]);

  const navigateToEntry = useCallback(async (entry: FsNode): Promise<void> => {
    if (entry.name === '..') {
      await onNavigateRef.current(dirname(currentPathRef.current));
    } else if (entry.type === 'folder') {
      await onNavigateRef.current(join(currentPathRef.current, entry.name));
    } else if (entry.type === 'file' && onViewFileRef.current) {
      onViewFileRef.current(entry.path as string, entry.name, Number(entry.meta.size));
    }
  }, []);

  const displayedItems = Math.min(displayEntries.length, maxItemsPerColumn * columnCount);
  const maxItemsPerColumnRef = useRef(maxItemsPerColumn);
  maxItemsPerColumnRef.current = maxItemsPerColumn;
  const displayedItemsRef = useRef(displayedItems);
  displayedItemsRef.current = displayedItems;

  useEffect(() => {
    setTopmostIndex((t) => {
      const totalVisible = maxItemsPerColumn * columnCount;
      if (activeIndex < t) return activeIndex;
      if (activeIndex > t + totalVisible - 1) return activeIndex - totalVisible + 1;
      return t;
    });
  }, [activeIndex, maxItemsPerColumn, columnCount]);

  // Update context when selection changes
  useEffect(() => {
    if (!active) return;
    const item = displayEntries[activeIndex];
    const isFile = item?.entry.type === 'file';
    commandRegistry.setContext('listItemIsFile', isFile);
    commandRegistry.setContext('listItemIsFolder', !isFile && item != null);
  }, [active, activeIndex, displayEntries]);

  // Register navigation commands when panel is active
  useEffect(() => {
    if (!active) return;

    const disposables: (() => void)[] = [];

    disposables.push(commandRegistry.registerCommand(
      'list.cursorUp',
      'Cursor Up',
      () => actionQueue.enqueue(() => setActiveIndex((i) => Math.max(0, i - 1))),
      { when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'list.cursorUp',
      key: 'up',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'list.cursorDown',
      'Cursor Down',
      () => actionQueue.enqueue(() => setActiveIndex((i) => Math.min(displayEntriesRef.current.length - 1, i + 1))),
      { when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'list.cursorDown',
      key: 'down',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'list.cursorLeft',
      'Cursor Left (Previous Column)',
      () => actionQueue.enqueue(() => setActiveIndex((i) => Math.max(0, i - maxItemsPerColumnRef.current))),
      { when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'list.cursorLeft',
      key: 'left',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'list.cursorRight',
      'Cursor Right (Next Column)',
      () => actionQueue.enqueue(() => setActiveIndex((i) => Math.min(displayEntriesRef.current.length - 1, i + maxItemsPerColumnRef.current))),
      { when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'list.cursorRight',
      key: 'right',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'list.cursorHome',
      'Cursor to First',
      () => actionQueue.enqueue(() => setActiveIndex(0)),
      { when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'list.cursorHome',
      key: 'home',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'list.cursorEnd',
      'Cursor to Last',
      () => actionQueue.enqueue(() => setActiveIndex(displayEntriesRef.current.length - 1)),
      { when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'list.cursorEnd',
      key: 'end',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'list.cursorPageUp',
      'Cursor Page Up',
      () => actionQueue.enqueue(() => setActiveIndex((i) => Math.max(0, i - displayedItemsRef.current + 1))),
      { when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'list.cursorPageUp',
      key: 'pageup',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'list.cursorPageDown',
      'Cursor Page Down',
      () => actionQueue.enqueue(() => setActiveIndex((i) => Math.min(displayEntriesRef.current.length - 1, i + displayedItemsRef.current - 1))),
      { when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'list.cursorPageDown',
      key: 'pagedown',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'list.open',
      'Open',
      () => actionQueue.enqueue(async () => {
        const item = displayEntriesRef.current[activeIndexRef.current];
        if (item) await navigateToEntry(item.entry);
      }),
      { when: 'focusPanel' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'list.open',
      key: 'enter',
      when: 'focusPanel',
    }));

    disposables.push(commandRegistry.registerCommand(
      'list.viewFile',
      'View File',
      () => actionQueue.enqueue(() => {
        const item = displayEntriesRef.current[activeIndexRef.current];
        if (item && item.entry.type === 'file' && onViewFileRef.current) {
          onViewFileRef.current(item.entry.path as string, item.entry.name, Number(item.entry.meta.size));
        }
      }),
      { when: 'focusPanel && listItemIsFile' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'list.viewFile',
      key: 'f3',
      when: 'focusPanel && listItemIsFile',
    }));

    disposables.push(commandRegistry.registerCommand(
      'list.editFile',
      'Edit File',
      () => actionQueue.enqueue(() => {
        const item = displayEntriesRef.current[activeIndexRef.current];
        if (item && item.entry.type === 'file' && onEditFileRef.current) {
          const fileSize = Number(item.entry.meta.size);
          if (fileSize <= editorFileSizeLimitRef.current) {
            const langId = typeof item.entry.lang === 'string' && item.entry.lang
              ? item.entry.lang
              : 'plaintext';
            onEditFileRef.current(
              item.entry.path as string,
              item.entry.name,
              fileSize,
              langId,
            );
          }
        }
      }),
      { when: 'focusPanel && listItemIsFile' }
    ));
    disposables.push(commandRegistry.registerKeybinding({
      command: 'list.editFile',
      key: 'f4',
      when: 'focusPanel && listItemIsFile',
    }));

    return () => {
      for (const dispose of disposables) dispose();
    };
  }, [active, navigateToEntry]);

  const columnCountRef = useRef(columnCount);
  columnCountRef.current = columnCount;

  const handleItemsPerColumnChanged = useCallback((count: number) => {
    setMaxItemsPerColumn(count);
    setTopmostIndex((t) => Math.max(0, Math.min(t, displayEntriesRef.current.length - count * columnCountRef.current)));
  }, []);

  const handlePosChange: ColumnsScrollerProps['onPosChange'] = useCallback((_topmost: number, active: number) => {
    actionQueue.enqueue(() => {
      setActiveIndex(clamp(active, 0, displayEntriesRef.current.length - 1));
    });
  }, []);

  const lastClickTimeRef = useRef(0);

  const renderItem = useCallback(
    (index: number) => {
      const item = displayEntriesRef.current[index];
      if (!item) return null;
      const { entry, style, iconPath } = item;
      const isActive = index === activeIndex;
      const iconUrl = getIconUrl(iconPath);

      return (
        <div
          className={`entry${isActive ? ' selected' : ''}`}
          style={{ height: ROW_HEIGHT, opacity: style.opacity }}
          onMouseDown={(e) => {
            e.stopPropagation();
            const now = Date.now();
            if (now - lastClickTimeRef.current < 300) {
              lastClickTimeRef.current = 0;
              actionQueue.enqueue(() => navigateToEntry(entry));
            } else {
              lastClickTimeRef.current = now;
              actionQueue.enqueue(() => setActiveIndex(index));
            }
          }}
        >
          <span className="entry-icon">{iconUrl && <img src={iconUrl} width={16} height={16} alt="" />}</span>
          <span className="entry-name" style={style.color ? { color: style.color } : undefined}>
            {entry.name}
          </span>
          {'size' in entry.meta && entry.type === 'file' && <span className="entry-size">{formatSize(entry.meta.size)}</span>}
        </div>
      );
    },
    [activeIndex, navigateToEntry, iconsVersion],
  );

  const activeEntry = displayEntries[activeIndex];
  const footerName = activeEntry?.entry.name ?? '';
  const footerDate = activeEntry ? formatDate(Number(activeEntry.entry.meta.mtimeMs ?? 0)) : '';
  const footerInfo = (() => {
    if (!activeEntry) return '';
    const entry = activeEntry.entry;
    if (entry.name === '..') return 'Up';
    const kind: string = (entry.meta.entryKind as string | undefined) ?? (entry.type === 'folder' ? 'directory' : 'file');
    const nlink: number = (entry.meta.nlink as number | undefined) ?? 1;
    switch (kind) {
      case 'directory':
        return nlink > 1 ? `DIR [${nlink}]` : 'DIR';
      case 'symlink':
        return '';
      case 'block_device':
        return 'BLK DEV';
      case 'char_device':
        return 'CHR DEV';
      case 'named_pipe':
        return 'FIFO';
      case 'socket':
        return 'SOCK';
      case 'whiteout':
        return 'WHT';
      case 'door':
        return 'DOOR';
      case 'event_port':
        return 'EVT PORT';
      case 'unknown':
        return '?';
      default: {
        const s = formatSize(entry.meta.size);
        return nlink > 1 ? `${s} [${nlink}]` : s;
      }
    }
  })();
  const footerLink = (() => {
    if (!activeEntry) return '';
    const kind: string = (activeEntry.entry.meta.entryKind as string | undefined) ?? '';
    if (kind !== 'symlink') return '';
    const target = activeEntry.entry.meta.linkTarget as string | undefined;
    return `\u2192 ${target ?? '?'}`;
  })();

  const totalFiles = useMemo(() => displayEntries.filter((d) => d.entry.type === 'file').length, [displayEntries]);
  const totalSize = useMemo(
    () =>
      displayEntries.reduce((acc, d) => {
        if (d.entry.type === 'file' && typeof d.entry.meta.size === 'number') return acc + d.entry.meta.size;
        return acc;
      }, 0),
    [displayEntries],
  );

  return (
    <div className="file-list">
      <div className="path-bar">{currentPath}</div>
      <div className="file-list-body" ref={rootRef}>
        <ColumnsScroller
          topmostIndex={topmostIndex}
          activeIndex={activeIndex}
          columnCount={columnCount}
          totalCount={displayEntries.length}
          itemHeight={ROW_HEIGHT}
          renderItem={renderItem}
          onPosChange={handlePosChange}
          onItemsPerColumnChanged={handleItemsPerColumnChanged}
        />
      </div>
      <div className="file-info-footer">
        <span className="file-info-name">{footerName}</span>
        {footerLink && <span className="file-info-link">{footerLink}</span>}
        <span className="file-info-size">{footerInfo}</span>
        <span className="file-info-date">{footerDate}</span>
      </div>
      <div className="panel-summary">
        {totalFiles.toLocaleString()} file{totalFiles !== 1 ? 's' : ''}, {formatSize(totalSize)}
      </div>
    </div>
  );
});
