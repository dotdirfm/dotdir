import { useBridge } from "@dotdirfm/ui-bridge";
import { findColorTheme, findIconTheme } from "@/features/extensions/extensions";
import type { LoadedExtension } from "@/features/extensions/types";
import { useSetIconTheme, useSetIconThemeKind } from "@/features/file-icons/iconResolver";
import { readFileText } from "@/features/file-system/fs";
import { useActivePanelNavigation } from "@/features/panels/panelControllers";
import { clearColorTheme, loadAndApplyColorTheme, uiThemeToKind } from "@/features/themes/vscodeColorTheme";
import { dirname } from "@dotdirfm/ui-utils";
import { getStyleHostElement } from "@dotdirfm/ui-utils";
import { type RefObject, useCallback, useEffect } from "react";
import { useLoadedExtensions } from "../useLoadedExtensions";
import { useLatestRef } from "./shared";

type ThemeRuntimeParams = {
  activeIconTheme: string | undefined;
  activeColorTheme: string | undefined;
  systemTheme: "light" | "dark";
  themesReady: boolean;
  themesReadyRef: RefObject<boolean>;
  iconThemeApplyGenerationRef: RefObject<number>;
  colorThemeApplyGenerationRef: RefObject<number>;
  setThemesReady: (value: boolean) => void;
  setExtensionFssLayers: (extensions: LoadedExtension[], themeId: string | undefined) => void;
};

export function useExtensionThemeRuntime({
  activeIconTheme,
  activeColorTheme,
  systemTheme,
  themesReady,
  themesReadyRef,
  iconThemeApplyGenerationRef,
  colorThemeApplyGenerationRef,
  setThemesReady,
  setExtensionFssLayers,
}: ThemeRuntimeParams) {
  const bridge = useBridge();
  const activeIconThemeRef = useLatestRef(activeIconTheme);
  const activeColorThemeRef = useLatestRef(activeColorTheme);
  const systemThemeRef = useLatestRef(systemTheme);
  const { refreshAll } = useActivePanelNavigation();
  const refreshAllRef = useLatestRef(refreshAll);
  const loadedExtensions = useLoadedExtensions();
  const latestExtensionsRef = useLatestRef(loadedExtensions);

  const { setIconTheme } = useSetIconTheme();
  const setIconThemeRef = useLatestRef(setIconTheme);

  const { setIconThemeKind } = useSetIconThemeKind();
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
        match.theme.fss = await readFileText(bridge, match.theme.path);
        if (!match.theme.basePath) match.theme.basePath = dirname(match.theme.path);
      } catch {
        // Ignore; resolver will fall back.
      }
    },
    [bridge],
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
        await loadAndApplyColorTheme(bridge, match.theme.jsonPath, match.theme.uiTheme);
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
    bridge,
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
    loadAndApplyColorTheme(bridge, match.theme.jsonPath, match.theme.uiTheme).catch(() => {
      if (generation !== colorThemeApplyGenerationRef.current) return;
      getStyleHostElement().dataset.theme = systemTheme;
      setIconThemeKindRef.current(systemTheme);
      clearColorTheme();
    });
  }, [activeColorTheme, bridge, colorThemeApplyGenerationRef, latestExtensionsRef, setIconThemeKindRef, systemTheme, themesReady]);

  return { applyInitialThemes };
}
