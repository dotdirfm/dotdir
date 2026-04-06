import type { Bridge } from "@/features/bridge";
import { findColorTheme, findIconTheme } from "@/features/extensions/extensions";
import type { LoadedExtension } from "@/features/extensions/types";
import { readFileText } from "@/features/file-system/fs";
import { clearColorTheme, loadAndApplyColorTheme, uiThemeToKind } from "@/features/themes/vscodeColorTheme";
import { dirname } from "@/utils/path";
import { getStyleHostElement } from "@/utils/styleHost";
import { type RefObject, useCallback, useEffect } from "react";
import { useLatestRef } from "./shared";

type ThemeRuntimeParams = {
  activeIconTheme: string | undefined;
  activeColorTheme: string | undefined;
  systemTheme: "light" | "dark";
  settingsReady: boolean;
  themesReady: boolean;
  latestExtensionsRef: RefObject<LoadedExtension[]>;
  themesReadyRef: RefObject<boolean>;
  iconThemeApplyGenerationRef: RefObject<number>;
  colorThemeApplyGenerationRef: RefObject<number>;
  setThemesReady: (value: boolean) => void;
  bridgeRef: RefObject<Bridge>;
  setExtensionFssLayers: (extensions: LoadedExtension[], themeId: string | undefined) => void;
  setIconTheme: (kind: "fss" | "vscode" | "none", path?: string) => Promise<void>;
  setIconThemeKind: (kind: "light" | "dark") => void;
  refreshAll: () => void;
};

export function useExtensionThemeRuntime({
  activeIconTheme,
  activeColorTheme,
  systemTheme,
  settingsReady,
  themesReady,
  latestExtensionsRef,
  themesReadyRef,
  iconThemeApplyGenerationRef,
  colorThemeApplyGenerationRef,
  setThemesReady,
  bridgeRef,
  setExtensionFssLayers,
  setIconTheme,
  setIconThemeKind,
  refreshAll,
}: ThemeRuntimeParams) {
  const activeIconThemeRef = useLatestRef(activeIconTheme);
  const activeColorThemeRef = useLatestRef(activeColorTheme);
  const systemThemeRef = useLatestRef(systemTheme);
  const refreshAllRef = useLatestRef(refreshAll);
  const setIconThemeRef = useLatestRef(setIconTheme);
  const setIconThemeKindRef = useLatestRef(setIconThemeKind);

  useEffect(() => {
    const colorThemeMatch = activeColorTheme ? findColorTheme(latestExtensionsRef.current, activeColorTheme) : null;
    const effectiveKind = colorThemeMatch ? uiThemeToKind(colorThemeMatch.theme.uiTheme) : systemTheme;
    getStyleHostElement().dataset.theme = effectiveKind;
    setIconThemeKindRef.current(effectiveKind);
  }, [activeColorTheme, latestExtensionsRef, setIconThemeKindRef, systemTheme]);

  const ensureActiveIconThemeFssLoaded = useCallback(
    async (exts: LoadedExtension[], themeId: string | undefined): Promise<void> => {
      if (!themeId) return;
      const match = findIconTheme(exts, themeId);
      if (!match || match.theme.kind !== "fss" || match.theme.fss) return;
      try {
        match.theme.fss = await readFileText(bridgeRef.current, match.theme.path);
        if (!match.theme.basePath) match.theme.basePath = dirname(match.theme.path);
      } catch {
        // Ignore; resolver will fall back.
      }
    },
    [bridgeRef],
  );

  const applyInitialThemes = useCallback(async () => {
    const exts = latestExtensionsRef.current;
    const applyIconTheme = async (extensions: LoadedExtension[], themeId: string | undefined): Promise<void> => {
      const generation = ++iconThemeApplyGenerationRef.current;
      await ensureActiveIconThemeFssLoaded(extensions, themeId);
      if (generation !== iconThemeApplyGenerationRef.current) return;
      setExtensionFssLayers(extensions, themeId);
      if (!themeId) {
        await setIconThemeRef.current("fss");
      } else {
        const match = findIconTheme(extensions, themeId);
        if (match?.theme.kind === "vscode") {
          await setIconThemeRef.current("vscode", match.theme.path);
        } else if (match?.theme.kind === "fss") {
          await setIconThemeRef.current("fss");
        } else {
          await setIconThemeRef.current("none");
        }
      }
      if (generation !== iconThemeApplyGenerationRef.current) return;
      refreshAllRef.current();
    };
    const applyColorTheme = async (extensions: LoadedExtension[], themeKey: string | undefined): Promise<void> => {
      const generation = ++colorThemeApplyGenerationRef.current;
      if (!themeKey) {
        getStyleHostElement().dataset.theme = systemThemeRef.current;
        setIconThemeKindRef.current(systemThemeRef.current);
        clearColorTheme();
        return;
      }
      const match = findColorTheme(extensions, themeKey);
      if (!match) {
        getStyleHostElement().dataset.theme = systemThemeRef.current;
        setIconThemeKindRef.current(systemThemeRef.current);
        clearColorTheme();
        return;
      }
      const kind = uiThemeToKind(match.theme.uiTheme);
      getStyleHostElement().dataset.theme = kind;
      setIconThemeKindRef.current(kind);
      try {
        await loadAndApplyColorTheme(bridgeRef.current, match.theme.jsonPath, match.theme.uiTheme);
      } catch (error) {
        if (generation !== colorThemeApplyGenerationRef.current) return;
        console.warn("[ExtHost] Failed to load color theme:", themeKey, error);
        getStyleHostElement().dataset.theme = systemThemeRef.current;
        setIconThemeKindRef.current(systemThemeRef.current);
        clearColorTheme();
      }
    };
    await Promise.all([applyIconTheme(exts, activeIconThemeRef.current), applyColorTheme(exts, activeColorThemeRef.current)]);
    setThemesReady(true);
    themesReadyRef.current = true;
  }, [
    activeColorThemeRef,
    activeIconThemeRef,
    bridgeRef,
    colorThemeApplyGenerationRef,
    ensureActiveIconThemeFssLoaded,
    iconThemeApplyGenerationRef,
    latestExtensionsRef,
    refreshAllRef,
    setExtensionFssLayers,
    setIconThemeKindRef,
    setThemesReady,
    setIconThemeRef,
    systemThemeRef,
    themesReadyRef,
  ]);

  useEffect(() => {
    if (!themesReady) return;
    void (async () => {
      const exts = latestExtensionsRef.current;
      const generation = ++iconThemeApplyGenerationRef.current;
      await ensureActiveIconThemeFssLoaded(exts, activeIconTheme);
      if (generation !== iconThemeApplyGenerationRef.current) return;
      setExtensionFssLayers(exts, activeIconTheme);
      if (!activeIconTheme) {
        await setIconThemeRef.current("fss");
      } else {
        const match = findIconTheme(exts, activeIconTheme);
        if (match?.theme.kind === "vscode") {
          await setIconThemeRef.current("vscode", match.theme.path);
        } else if (match?.theme.kind === "fss") {
          await setIconThemeRef.current("fss");
        } else {
          await setIconThemeRef.current("none");
        }
      }
      if (generation !== iconThemeApplyGenerationRef.current) return;
      refreshAllRef.current();
    })();
  }, [activeIconTheme, ensureActiveIconThemeFssLoaded, iconThemeApplyGenerationRef, latestExtensionsRef, refreshAllRef, setExtensionFssLayers, setIconThemeRef, themesReady]);

  useEffect(() => {
    if (!themesReady) return;
    const generation = ++colorThemeApplyGenerationRef.current;
    if (!activeColorTheme) {
      getStyleHostElement().dataset.theme = systemTheme;
      setIconThemeKindRef.current(systemTheme);
      clearColorTheme();
      return;
    }
    const match = findColorTheme(latestExtensionsRef.current, activeColorTheme);
    if (!match) {
      getStyleHostElement().dataset.theme = systemTheme;
      setIconThemeKindRef.current(systemTheme);
      clearColorTheme();
      return;
    }
    const kind = uiThemeToKind(match.theme.uiTheme);
    getStyleHostElement().dataset.theme = kind;
    setIconThemeKindRef.current(kind);
    loadAndApplyColorTheme(bridgeRef.current, match.theme.jsonPath, match.theme.uiTheme).catch(() => {
      if (generation !== colorThemeApplyGenerationRef.current) return;
      getStyleHostElement().dataset.theme = systemTheme;
      setIconThemeKindRef.current(systemTheme);
      clearColorTheme();
    });
  }, [activeColorTheme, bridgeRef, colorThemeApplyGenerationRef, latestExtensionsRef, setIconThemeKindRef, systemTheme, themesReady]);

  useEffect(() => {
    if (!settingsReady || !themesReadyRef.current) return;
    void applyInitialThemes();
  }, [applyInitialThemes, settingsReady, themesReadyRef]);

  return { applyInitialThemes };
}
