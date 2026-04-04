/**
 * UI State persistence
 *
 * Stores UI state (open tabs, active panel) in the host-provided data dir.
 * Read once on startup; written with a short debounce. Not watched for
 * external changes.
 */

import type { Bridge } from "@/features/bridge";
import { useBridge } from "@/features/bridge/useBridge";
import { readFileText } from "@/features/file-system/fs";
import { dirname, join } from "@/utils/path";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import type { DotDirUiState } from "./types";

type UiStateContextValue = {
  loadUiState(): Promise<DotDirUiState>;
  updateUiState(partial: Partial<DotDirUiState>): void;
  flushUiState(): Promise<void>;
};

const UiStateContext = createContext<UiStateContextValue | null>(null);

async function getStatePath(bridge: Bridge, statePathRef: MutableRefObject<string | null>): Promise<string> {
  if (!statePathRef.current) {
    const { dataDir } = await bridge.utils.getAppDirs();
    statePathRef.current = join(dataDir, "ui-state.json");
  }
  return statePathRef.current;
}

async function saveUiStateToDisk(bridge: Bridge, statePathRef: MutableRefObject<string | null>, state: DotDirUiState): Promise<void> {
  try {
    const path = await getStatePath(bridge, statePathRef);
    if (bridge.fs.createDir) {
      await bridge.fs.createDir(dirname(path));
    }
    await bridge.fs.writeFile(path, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[uiState] Failed to save:", err);
  }
}

export function UiStateProvider({ children }: { children: ReactNode }) {
  const bridge = useBridge();
  const currentStateRef = useRef<DotDirUiState>({});
  const statePathRef = useRef<string | null>(null);
  const saveDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadUiState = useCallback(async (): Promise<DotDirUiState> => {
    try {
      const path = await getStatePath(bridge, statePathRef);
      const text = await readFileText(bridge, path);
      const parsed = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        currentStateRef.current = parsed as DotDirUiState;
      } else {
        currentStateRef.current = {};
      }
    } catch {
      currentStateRef.current = {};
    }
    return currentStateRef.current;
  }, [bridge]);

  const flushUiState = useCallback(async (): Promise<void> => {
    if (saveDebounceTimerRef.current) {
      clearTimeout(saveDebounceTimerRef.current);
      saveDebounceTimerRef.current = null;
    }
    await saveUiStateToDisk(bridge, statePathRef, currentStateRef.current);
  }, [bridge]);

  const updateUiState = useCallback(
    (partial: Partial<DotDirUiState>): void => {
      currentStateRef.current = { ...currentStateRef.current, ...partial };
      if (saveDebounceTimerRef.current) clearTimeout(saveDebounceTimerRef.current);
      saveDebounceTimerRef.current = setTimeout(() => {
        saveDebounceTimerRef.current = null;
        void saveUiStateToDisk(bridge, statePathRef, currentStateRef.current);
      }, 500);
    },
    [bridge],
  );

  useEffect(() => {
    return () => {
      if (saveDebounceTimerRef.current) {
        clearTimeout(saveDebounceTimerRef.current);
        saveDebounceTimerRef.current = null;
      }
    };
  }, []);

  const value = useMemo<UiStateContextValue>(
    () => ({
      loadUiState,
      updateUiState,
      flushUiState,
    }),
    [flushUiState, loadUiState, updateUiState],
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
