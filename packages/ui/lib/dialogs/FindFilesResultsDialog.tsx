import type { FileSearchMatch, FileSearchProgressEvent, FileSearchRequest } from "@/features/bridge";
import { useBridge } from "@/features/bridge/useBridge";
import {
  ACCEPT,
  CANCEL,
  CURSOR_DOWN,
  CURSOR_END,
  CURSOR_HOME,
  CURSOR_PAGE_DOWN,
  CURSOR_PAGE_UP,
  CURSOR_UP,
} from "@/features/commands/commandIds";
import { useCommandRegistry } from "@/features/commands/commands";
import { useVirtualizer } from "@tanstack/react-virtual";
import { basename, dirname } from "@/utils/path";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { SmartLabel } from "./dialogHotkeys";
import styles from "./dialogs.module.css";
import { OverlayDialog } from "./OverlayDialog";

type SearchStatus = "running" | "finished" | "suspended" | "error";

const SEARCH_RESULTS_FLUSH_MS = 32;
const SEARCH_RESULTS_FLUSH_SIZE = 100;

type ResultRow =
  | { kind: "directory"; path: string }
  | { kind: "match"; matchIndex: number; match: FileSearchMatch };

export interface FindFilesResultsDialogProps {
  request: FileSearchRequest;
  onAgain: (request: FileSearchRequest) => void;
  onClose: () => void;
  onChdir: (path: string) => void;
  onViewFile: (path: string) => void | Promise<void>;
  onEditFile: (path: string) => void | Promise<void>;
  onPanelize?: (matches: FileSearchMatch[]) => void;
  stackIndex?: number;
}

function statusLabel(status: SearchStatus): string {
  switch (status) {
    case "finished":
      return "Finished";
    case "suspended":
      return "Suspended";
    case "error":
      return "Error";
    default:
      return "Searching...";
  }
}

export function FindFilesResultsDialog({
  request,
  onAgain,
  onClose,
  onChdir,
  onViewFile,
  onEditFile,
  onPanelize,
  stackIndex = 0,
}: FindFilesResultsDialogProps) {
  const bridge = useBridge();
  const commandRegistry = useCommandRegistry();
  const matchesRef = useRef<FileSearchMatch[]>([]);
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndexState] = useState<number | null>(null);
  const [status, setStatus] = useState<SearchStatus>("running");
  const [error, setError] = useState<string | null>(null);
  const [foundCount, setFoundCount] = useState(0);
  const searchIdRef = useRef<number | null>(null);
  const activeIndexRef = useRef<number | null>(null);
  const statusRef = useRef<SearchStatus>("running");
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingMatchesRef = useRef<FileSearchMatch[]>([]);
  const pendingFlushTimerRef = useRef<number | null>(null);
  const pendingInitialSelectionRef = useRef(false);
  activeIndexRef.current = activeIndex;
  statusRef.current = status;

  useEffect(() => {
    const clearPendingFlushTimer = () => {
      if (pendingFlushTimerRef.current !== null) {
        window.clearTimeout(pendingFlushTimerRef.current);
        pendingFlushTimerRef.current = null;
      }
    };

    const flushPendingMatches = () => {
      clearPendingFlushTimer();
      const chunk = pendingMatchesRef.current;
      const shouldSelectFirst = pendingInitialSelectionRef.current;
      if (chunk.length === 0 && !shouldSelectFirst) return;
      pendingMatchesRef.current = [];
      pendingInitialSelectionRef.current = false;

      startTransition(() => {
        if (chunk.length > 0) {
          matchesRef.current.push(...chunk);
          setMatchCount(matchesRef.current.length);
          setFoundCount((count) => count + chunk.length);
        }
        if (activeIndexRef.current === null && shouldSelectFirst && matchesRef.current.length > 0) {
          setActiveIndexState(0);
        }
      });
    };

    const schedulePendingFlush = () => {
      if (pendingFlushTimerRef.current !== null) return;
      pendingFlushTimerRef.current = window.setTimeout(() => {
        flushPendingMatches();
      }, SEARCH_RESULTS_FLUSH_MS);
    };

    matchesRef.current = [];
    setMatchCount(0);
    setActiveIndexState(null);
    setStatus("running");
    setError(null);
    setFoundCount(0);
    pendingMatchesRef.current = [];
    pendingInitialSelectionRef.current = false;
    clearPendingFlushTimer();

    const unsubscribe = bridge.fs.search.onProgress((payload: FileSearchProgressEvent) => {
      if (searchIdRef.current === null) {
        searchIdRef.current = payload.searchId;
      }
      if (payload.searchId !== searchIdRef.current) return;
      const event = payload.event;
      switch (event.kind) {
        case "match":
          if (
            activeIndexRef.current === null &&
            !pendingInitialSelectionRef.current &&
            matchesRef.current.length === 0 &&
            pendingMatchesRef.current.length === 0
          ) {
            pendingInitialSelectionRef.current = true;
          }
          pendingMatchesRef.current.push(event.match);
          if (pendingMatchesRef.current.length >= SEARCH_RESULTS_FLUSH_SIZE) {
            flushPendingMatches();
          } else {
            schedulePendingFlush();
          }
          return;
        case "done":
          flushPendingMatches();
          setStatus("finished");
          setFoundCount(event.found);
          return;
        case "cancelled":
          flushPendingMatches();
          setStatus("suspended");
          setFoundCount(event.found);
          return;
        case "error":
          flushPendingMatches();
          setStatus("error");
          setError(event.message);
          setFoundCount(event.found);
          return;
      }
    });

    void bridge.fs.search.start(request).then((searchId) => {
      if (searchIdRef.current === null) {
        searchIdRef.current = searchId;
      }
    }).catch((err) => {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      unsubscribe();
      clearPendingFlushTimer();
      pendingMatchesRef.current = [];
      pendingInitialSelectionRef.current = false;
      const searchId = searchIdRef.current;
      if (searchId !== null && statusRef.current === "running") {
        void bridge.fs.search.cancel(searchId);
      }
      searchIdRef.current = null;
    };
  }, [bridge, request]);

  const selectedIndex =
    activeIndex !== null && activeIndex >= 0 && activeIndex < matchCount
      ? activeIndex
      : matchCount > 0
        ? 0
        : -1;
  const selectedMatch = selectedIndex >= 0 ? matchesRef.current[selectedIndex] ?? null : null;

  const getCurrentSelectedMatch = () => {
    const currentIndex = activeIndexRef.current;
    if (currentIndex !== null && currentIndex >= 0 && currentIndex < matchesRef.current.length) {
      return matchesRef.current[currentIndex] ?? null;
    }
    return matchesRef.current[0] ?? null;
  };
  const rows = useMemo(() => {
    const next: ResultRow[] = [];
    let currentDirectory: string | null = null;
    for (let i = 0; i < matchCount; i++) {
      const match = matchesRef.current[i];
      if (!match) continue;
      const directoryPath = match.isDirectory ? dirname(match.path) : dirname(match.path);
      if (directoryPath !== currentDirectory) {
        currentDirectory = directoryPath;
        next.push({ kind: "directory", path: directoryPath });
      }
      next.push({ kind: "match", matchIndex: i, match });
    }
    return next;
  }, [matchCount]);
  const selectedRowIndex = useMemo(
    () => rows.findIndex((row) => row.kind === "match" && row.matchIndex === selectedIndex),
    [rows, selectedIndex],
  );

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (rows[index]?.kind === "directory" ? 28 : 34),
    overscan: 10,
    useAnimationFrameWithResizeObserver: true,
    useScrollendEvent: false,
  });

  useEffect(() => {
    if (selectedRowIndex >= 0) {
      rowVirtualizer.scrollToIndex(selectedRowIndex, { align: "auto" });
    }
  }, [selectedRowIndex, rowVirtualizer]);

  const handleSuspend = () => {
    const searchId = searchIdRef.current;
    if (searchId === null || status !== "running") return;
    void bridge.fs.search.cancel(searchId);
  };

  const handleChdir = () => {
    const match = getCurrentSelectedMatch();
    if (!match) return;
    onChdir(match.isDirectory ? match.path : dirname(match.path));
    onClose();
  };

  const handleView = () => {
    const match = getCurrentSelectedMatch();
    if (!match || match.isDirectory) return;
    void Promise.resolve(onViewFile(match.path));
  };

  const handleEdit = () => {
    const match = getCurrentSelectedMatch();
    if (!match || match.isDirectory) return;
    void Promise.resolve(onEditFile(match.path));
  };

  const setActiveIndex = (index: number) => {
    if (index < 0 || index >= matchCount) return;
    activeIndexRef.current = index;
    setActiveIndexState(index);
  };

  useEffect(() => {
    const moveTo = (index: number) => {
      setActiveIndex(index);
    };
    const moveBy = (delta: number) => {
      if (matchCount === 0) return;
      const maxIndex = matchCount - 1;
      const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
      moveTo(Math.max(0, Math.min(maxIndex, currentIndex + delta)));
    };

    const disposables = [
      commandRegistry.registerCommand(CURSOR_UP, () => moveBy(-1)),
      commandRegistry.registerCommand(CURSOR_DOWN, () => moveBy(1)),
      commandRegistry.registerCommand(CURSOR_PAGE_UP, () => moveBy(-10)),
      commandRegistry.registerCommand(CURSOR_PAGE_DOWN, () => moveBy(10)),
      commandRegistry.registerCommand(CURSOR_HOME, () => moveTo(0)),
      commandRegistry.registerCommand(CURSOR_END, () => moveTo(Math.max(0, matchCount - 1))),
      commandRegistry.registerCommand(ACCEPT, () => {
        handleChdir();
      }),
      commandRegistry.registerCommand(CANCEL, () => {
        onClose();
      }),
    ];

    return () => {
      disposables.forEach((dispose) => dispose());
    };
  }, [commandRegistry, handleChdir, matchCount, onClose, selectedIndex]);

  return (
    <OverlayDialog
      className={styles["find-files-results-dialog"]}
      onClose={onClose}
      placement="top"
      stackIndex={stackIndex}
      focusLayer="searchResults"
      allowCommandRouting
      initialFocusRef={listRef}
      onKeyDown={(event) => {
        if (event.key === "F3") {
          event.preventDefault();
          handleView();
        } else if (event.key === "F4") {
          event.preventDefault();
          handleEdit();
        }
      }}
    >
      <div className={styles["find-files-results-title"]}>Find File: "{request.filePattern || "*"}"</div>
      <div className={styles["find-files-results-path"]}>{request.startPath}</div>
      <div className={styles["find-files-results-list"]}>
        {matchCount === 0 && status === "running" ? (
          <div className={styles["find-files-empty"]}>Searching...</div>
        ) : matchCount === 0 ? (
          <div className={styles["find-files-empty"]}>No matches</div>
        ) : (
          <div
            ref={listRef}
            className={styles["find-files-results-scroll"]}
            tabIndex={0}
            role="listbox"
            aria-label="Find files results"
            aria-activedescendant={selectedMatch ? `find-file-result-${selectedIndex}` : undefined}
          >
            <div
              className={styles["find-files-results-items"]}
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                if (!row) return null;
                if (row.kind === "directory") {
                  return (
                    <div
                      key={`dir:${row.path}`}
                      className={styles["find-files-result-directory"]}
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      {row.path}
                    </div>
                  );
                }
                const active = row.matchIndex === selectedIndex;
                return (
                  <div
                    key={row.match.path}
                    id={`find-file-result-${row.matchIndex}`}
                    role="option"
                    aria-selected={active}
                    className={active ? styles["find-files-result-active"] : styles["find-files-result"]}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                    onMouseDown={() => setActiveIndex(row.matchIndex)}
                    onDoubleClick={() => {
                      setActiveIndex(row.matchIndex);
                      handleChdir();
                    }}
                  >
                    <span className={styles["find-files-result-name"]}>{basename(row.match.path) || row.match.path}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <div className={styles["find-files-results-status"]}>
        <span>Found: {foundCount}</span>
        <span>{statusLabel(status)}</span>
        {error ? <span className={styles["find-files-error"]}>{error}</span> : null}
      </div>
      <div className={styles["find-files-results-actions"]}>
        <button type="button" onClick={handleChdir} disabled={!selectedMatch}>
          <SmartLabel>Chdir</SmartLabel>
        </button>
        <button type="button" onClick={() => onAgain(request)}>
          <SmartLabel>Again</SmartLabel>
        </button>
        <button type="button" onClick={handleSuspend} disabled={status !== "running"}>
          <SmartLabel>Suspend</SmartLabel>
        </button>
        <button type="button" onClick={onClose}>
          <SmartLabel>Quit</SmartLabel>
        </button>
        <button type="button" onClick={() => onPanelize?.(matchesRef.current)} disabled={!onPanelize || matchCount === 0}>
          <SmartLabel>Panelize</SmartLabel>
        </button>
        <button type="button" onClick={handleView} disabled={!selectedMatch || selectedMatch.isDirectory}>
          <SmartLabel>View - F3</SmartLabel>
        </button>
        <button type="button" onClick={handleEdit} disabled={!selectedMatch || selectedMatch.isDirectory}>
          <SmartLabel>Edit - F4</SmartLabel>
        </button>
      </div>
    </OverlayDialog>
  );
}
