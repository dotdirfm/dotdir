import type { Bridge } from "@/features/bridge";
import { useBridge } from "@/features/bridge/useBridge";
import { readFileText } from "@/features/file-system/fs";
import { dirname, join } from "@/utils/path";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { DotDirUiLayoutIndex, DotDirWindowLayout, DotDirWindowState } from "./types";

type UiStateContextValue = {
  getCurrentWindowId(): Promise<string>;
  getWindowIds(): Promise<string[]>;
  ensureWindow(windowId?: string): Promise<void>;
  removeWindow(windowId: string): Promise<void>;
  loadCurrentWindowLayout(): Promise<DotDirWindowLayout>;
  updateCurrentWindowLayout(partial: Partial<DotDirWindowLayout>): void;
  flushCurrentWindowLayout(): Promise<void>;
  loadCurrentWindowState(): Promise<DotDirWindowState>;
  updateCurrentWindowState(partial: Partial<DotDirWindowState>): void;
  flushCurrentWindowState(): Promise<void>;
};

const UiStateContext = createContext<UiStateContextValue | null>(null);

const DEFAULT_WINDOW_ID = "window-1";

type Timer = ReturnType<typeof setTimeout>;

async function getDataDir(bridge: Bridge, dataDirRef: MutableRefObject<string | null>): Promise<string> {
  if (!dataDirRef.current) {
    const { dataDir } = await bridge.utils.getAppDirs();
    dataDirRef.current = dataDir;
  }
  return dataDirRef.current;
}

async function getCurrentWindowIdValue(bridge: Bridge, currentWindowIdRef: MutableRefObject<string | null>): Promise<string> {
  if (!currentWindowIdRef.current) {
    currentWindowIdRef.current = bridge.window ? (await bridge.window.getCurrentState()).id : DEFAULT_WINDOW_ID;
  }
  return currentWindowIdRef.current;
}

async function getIndexPath(bridge: Bridge, dataDirRef: MutableRefObject<string | null>): Promise<string> {
  return join(await getDataDir(bridge, dataDirRef), "ui-layout.json");
}

async function getWindowLayoutPath(
  bridge: Bridge,
  dataDirRef: MutableRefObject<string | null>,
  windowId: string,
): Promise<string> {
  return join(await getDataDir(bridge, dataDirRef), `window-layout-${windowId}.json`);
}

async function getWindowStatePath(
  bridge: Bridge,
  dataDirRef: MutableRefObject<string | null>,
  windowId: string,
): Promise<string> {
  return join(await getDataDir(bridge, dataDirRef), `window-state-${windowId}.json`);
}

async function ensureParentDir(bridge: Bridge, filePath: string): Promise<void> {
  if (bridge.fs.createDir) {
    await bridge.fs.createDir(dirname(filePath));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject<T extends object>(bridge: Bridge, filePath: string): Promise<T | null> {
  try {
    const text = await readFileText(bridge, filePath);
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

async function writeJsonFile(bridge: Bridge, filePath: string, value: object): Promise<void> {
  await ensureParentDir(bridge, filePath);
  await bridge.fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

export function UiStateProvider({ children }: { children: ReactNode }) {
  const bridge = useBridge();
  const dataDirRef = useRef<string | null>(null);
  const currentWindowIdRef = useRef<string | null>(null);
  const discardedWindowIdsRef = useRef(new Set<string>());
  const layoutRef = useRef<DotDirWindowLayout>({});
  const windowStateRef = useRef<DotDirWindowState>({});
  const layoutSaveTimerRef = useRef<Timer | null>(null);
  const windowStateSaveTimerRef = useRef<Timer | null>(null);

  const getCurrentWindowId = useCallback(async () => getCurrentWindowIdValue(bridge, currentWindowIdRef), [bridge]);

  const readIndex = useCallback(async (): Promise<DotDirUiLayoutIndex> => {
    const indexPath = await getIndexPath(bridge, dataDirRef);
    return (await readJsonObject<DotDirUiLayoutIndex>(bridge, indexPath)) ?? {};
  }, [bridge]);

  const writeIndex = useCallback(
    async (index: DotDirUiLayoutIndex): Promise<void> => {
      const indexPath = await getIndexPath(bridge, dataDirRef);
      await writeJsonFile(bridge, indexPath, index);
    },
    [bridge],
  );

  const getWindowIds = useCallback(async (): Promise<string[]> => {
    const index = await readIndex();
    return Array.isArray(index.windowIds) ? index.windowIds : [];
  }, [readIndex]);

  const ensureWindow = useCallback(
    async (windowId?: string): Promise<void> => {
      const id = windowId ?? (await getCurrentWindowId());
      discardedWindowIdsRef.current.delete(id);
      const current = await getWindowIds();
      if (current.includes(id)) return;
      await writeIndex({ windowIds: [...current, id] });
    },
    [getCurrentWindowId, getWindowIds, writeIndex],
  );

  const deleteWindowFiles = useCallback(
    async (windowId: string): Promise<void> => {
      if (!bridge.fs.removeFile) return;
      const [layoutPath, statePath] = await Promise.all([
        getWindowLayoutPath(bridge, dataDirRef, windowId),
        getWindowStatePath(bridge, dataDirRef, windowId),
      ]);
      await Promise.allSettled([bridge.fs.removeFile(layoutPath), bridge.fs.removeFile(statePath)]);
    },
    [bridge],
  );

  const removeWindow = useCallback(
    async (windowId: string): Promise<void> => {
      discardedWindowIdsRef.current.add(windowId);
      const current = await getWindowIds();
      const next = current.filter((id) => id !== windowId);
      await writeIndex({ windowIds: next });
      await deleteWindowFiles(windowId);
    },
    [deleteWindowFiles, getWindowIds, writeIndex],
  );

  const saveCurrentWindowLayout = useCallback(async (): Promise<void> => {
    try {
      const windowId = await getCurrentWindowId();
      if (discardedWindowIdsRef.current.has(windowId)) return;
      await ensureWindow(windowId);
      const path = await getWindowLayoutPath(bridge, dataDirRef, windowId);
      await writeJsonFile(bridge, path, layoutRef.current);
    } catch (err) {
      console.error("[uiState] Failed to save window layout:", err);
    }
  }, [bridge, ensureWindow, getCurrentWindowId]);

  const saveCurrentWindowState = useCallback(async (): Promise<void> => {
    try {
      const windowId = await getCurrentWindowId();
      if (discardedWindowIdsRef.current.has(windowId)) return;
      await ensureWindow(windowId);
      const path = await getWindowStatePath(bridge, dataDirRef, windowId);
      await writeJsonFile(bridge, path, windowStateRef.current);
    } catch (err) {
      console.error("[uiState] Failed to save window state:", err);
    }
  }, [bridge, ensureWindow, getCurrentWindowId]);

  const loadCurrentWindowLayout = useCallback(async (): Promise<DotDirWindowLayout> => {
    const windowId = await getCurrentWindowId();
    await ensureWindow(windowId);
    const path = await getWindowLayoutPath(bridge, dataDirRef, windowId);
    layoutRef.current = (await readJsonObject<DotDirWindowLayout>(bridge, path)) ?? {};
    return layoutRef.current;
  }, [bridge, ensureWindow, getCurrentWindowId]);

  const updateCurrentWindowLayout = useCallback(
    (partial: Partial<DotDirWindowLayout>): void => {
      layoutRef.current = { ...layoutRef.current, ...partial };
      if (layoutSaveTimerRef.current) {
        clearTimeout(layoutSaveTimerRef.current);
      }
      layoutSaveTimerRef.current = setTimeout(() => {
        layoutSaveTimerRef.current = null;
        void saveCurrentWindowLayout();
      }, 500);
    },
    [saveCurrentWindowLayout],
  );

  const flushCurrentWindowLayout = useCallback(async (): Promise<void> => {
    if (layoutSaveTimerRef.current) {
      clearTimeout(layoutSaveTimerRef.current);
      layoutSaveTimerRef.current = null;
    }
    await saveCurrentWindowLayout();
  }, [saveCurrentWindowLayout]);

  const loadCurrentWindowState = useCallback(async (): Promise<DotDirWindowState> => {
    const windowId = await getCurrentWindowId();
    await ensureWindow(windowId);
    const path = await getWindowStatePath(bridge, dataDirRef, windowId);
    windowStateRef.current = (await readJsonObject<DotDirWindowState>(bridge, path)) ?? {};
    return windowStateRef.current;
  }, [bridge, ensureWindow, getCurrentWindowId]);

  const updateCurrentWindowState = useCallback(
    (partial: Partial<DotDirWindowState>): void => {
      windowStateRef.current = { ...windowStateRef.current, ...partial };
      if (windowStateSaveTimerRef.current) {
        clearTimeout(windowStateSaveTimerRef.current);
      }
      windowStateSaveTimerRef.current = setTimeout(() => {
        windowStateSaveTimerRef.current = null;
        void saveCurrentWindowState();
      }, 500);
    },
    [saveCurrentWindowState],
  );

  const flushCurrentWindowState = useCallback(async (): Promise<void> => {
    if (windowStateSaveTimerRef.current) {
      clearTimeout(windowStateSaveTimerRef.current);
      windowStateSaveTimerRef.current = null;
    }
    await saveCurrentWindowState();
  }, [saveCurrentWindowState]);

  useEffect(() => {
    void ensureWindow();
    return () => {
      if (layoutSaveTimerRef.current) {
        clearTimeout(layoutSaveTimerRef.current);
        layoutSaveTimerRef.current = null;
      }
      if (windowStateSaveTimerRef.current) {
        clearTimeout(windowStateSaveTimerRef.current);
        windowStateSaveTimerRef.current = null;
      }
    };
  }, [ensureWindow]);

  const value = useMemo<UiStateContextValue>(
    () => ({
      getCurrentWindowId,
      getWindowIds,
      ensureWindow,
      removeWindow,
      loadCurrentWindowLayout,
      updateCurrentWindowLayout,
      flushCurrentWindowLayout,
      loadCurrentWindowState,
      updateCurrentWindowState,
      flushCurrentWindowState,
    }),
    [
      ensureWindow,
      flushCurrentWindowLayout,
      flushCurrentWindowState,
      getCurrentWindowId,
      getWindowIds,
      loadCurrentWindowLayout,
      loadCurrentWindowState,
      removeWindow,
      updateCurrentWindowLayout,
      updateCurrentWindowState,
    ],
  );

  return createElement(UiStateContext.Provider, { value }, children);
}

export function useUiState(): UiStateContextValue {
  const value = useContext(UiStateContext);
  if (!value) {
    throw new Error("useUiState must be used within UiStateProvider");
  }
  return value;
}
