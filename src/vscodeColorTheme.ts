/**
 * VS Code Color Theme Support
 *
 * Loads VS Code color theme JSON files and maps their colors
 * to .dir's CSS custom properties.
 */

import { parse as parseJsonc } from "jsonc-parser";
import { readFileText } from "./fs";
import { dirname, join } from "./path";

export interface VSCodeColorThemeJson {
  name?: string;
  type?: "dark" | "light" | "hc";
  colors?: Record<string, string>;
  tokenColors?: unknown[];
  include?: string;
}

/**
 * Mapping from our CSS custom properties to VS Code color keys.
 * For each variable, the first matching key wins.
 */
const COLOR_MAPPING: Array<{ cssVar: string; keys: string[] }> = [
  { cssVar: "--bg", keys: ["editor.background"] },
  { cssVar: "--fg", keys: ["editor.foreground", "foreground"] },
  { cssVar: "--bg-secondary", keys: ["sideBar.background", "editorGroupHeader.tabsBackground"] },
  { cssVar: "--fg-secondary", keys: ["sideBar.foreground", "foreground"] },
  { cssVar: "--fg-muted", keys: ["descriptionForeground", "tab.inactiveForeground"] },
  {
    cssVar: "--border",
    keys: ["panel.border", "sideBar.border", "widget.border", "editorGroup.border"],
  },
  { cssVar: "--border-active", keys: ["focusBorder"] },
  { cssVar: "--entry-hover", keys: ["list.hoverBackground"] },
  {
    cssVar: "--entry-selected",
    keys: ["list.activeSelectionBackground", "list.focusBackground", "selection.background"],
  },
  {
    cssVar: "--entry-selected-fg",
    keys: ["list.activeSelectionForeground", "list.focusForeground"],
  },
  { cssVar: "--entry-selected-inactive", keys: ["list.inactiveSelectionBackground"] },
  { cssVar: "--entry-selected-inactive-fg", keys: ["list.inactiveSelectionForeground"] },
  { cssVar: "--error-bg", keys: ["inputValidation.errorBackground"] },
  { cssVar: "--error-fg", keys: ["errorForeground", "editorError.foreground"] },
  { cssVar: "--accent", keys: ["button.background", "textLink.foreground", "focusBorder"] },
  { cssVar: "--accent-fg", keys: ["button.foreground"] },
  { cssVar: "--action-bar-border", keys: ["activityBar.border"] },
  { cssVar: "--action-bar-bg", keys: ["activityBar.background"] },
  { cssVar: "--action-bar-fg", keys: ["activityBar.foreground"] },
  { cssVar: "--action-bar-badge-bg", keys: ["activityBarBadge.background"] },
  { cssVar: "--action-bar-badge-fg", keys: ["activityBarBadge.foreground"] },
];

async function loadThemeJson(jsonPath: string, maxDepth = 3): Promise<VSCodeColorThemeJson> {
  const text = await readFileText(jsonPath);
  const theme: VSCodeColorThemeJson = parseJsonc(text, undefined, { allowTrailingComma: true });

  // Handle `include` — merge base theme colors underneath
  if (theme.include && maxDepth > 0) {
    const basePath = join(dirname(jsonPath), theme.include);
    try {
      const base = await loadThemeJson(basePath, maxDepth - 1);
      theme.colors = { ...base.colors, ...theme.colors };
      if (!theme.tokenColors && base.tokenColors) {
        theme.tokenColors = base.tokenColors;
      }
    } catch {
      // Base theme not found — continue with what we have
    }
  }

  return theme;
}

export interface ActiveColorThemeData {
  kind: "dark" | "light";
  colors?: Record<string, string>;
  tokenColors?: unknown[];
}

let appliedVars: string[] = [];
let loadGeneration = 0;
let currentThemeData: ActiveColorThemeData | null = null;
let themeChangeListeners: Array<(data: ActiveColorThemeData) => void> = [];

export function getActiveColorThemeData(): ActiveColorThemeData | null {
  return currentThemeData;
}

export function onColorThemeChange(listener: (data: ActiveColorThemeData) => void): () => void {
  themeChangeListeners.push(listener);
  return () => {
    themeChangeListeners = themeChangeListeners.filter((l) => l !== listener);
  };
}

function notifyColorThemeListeners(): void {
  if (!currentThemeData) return;
  for (const listener of themeChangeListeners) {
    listener(currentThemeData);
  }
}

export function applyColorTheme(colors: Record<string, string>): void {
  clearColorTheme();
  const style = document.documentElement.style;

  for (const mapping of COLOR_MAPPING) {
    for (const key of mapping.keys) {
      const value = colors[key];
      if (value) {
        style.setProperty(mapping.cssVar, value);
        appliedVars.push(mapping.cssVar);
        break;
      }
    }
  }
}

export function clearColorTheme(): void {
  loadGeneration++;
  const style = document.documentElement.style;
  for (const cssVar of appliedVars) {
    style.removeProperty(cssVar);
  }
  appliedVars = [];
  const hadTheme = currentThemeData !== null;
  currentThemeData = null;
  if (hadTheme) {
    // Notify listeners that theme was cleared — they should revert to OS theme
    for (const listener of themeChangeListeners) {
      listener({ kind: document.documentElement.dataset.theme === "light" ? "light" : "dark" });
    }
  }
}

/**
 * Determine whether a uiTheme string means light or dark mode.
 */
export function uiThemeToKind(uiTheme: string): "dark" | "light" {
  if (uiTheme === "vs" || uiTheme === "hc-light") return "light";
  return "dark";
}

/**
 * Load a VS Code color theme JSON and apply its colors as CSS custom properties.
 * Returns the parsed theme for further use (e.g. tokenColors).
 * Uses a generation counter to prevent stale async loads from overwriting newer themes.
 */
export async function loadAndApplyColorTheme(jsonPath: string, uiTheme?: string): Promise<VSCodeColorThemeJson> {
  const gen = ++loadGeneration;
  const theme = await loadThemeJson(jsonPath);
  if (gen !== loadGeneration) return theme; // superseded by a newer load or clear
  if (theme.colors) {
    applyColorTheme(theme.colors);
  }
  const kind = uiTheme ? uiThemeToKind(uiTheme) : theme.type === "light" ? "light" : "dark";
  currentThemeData = { kind, colors: theme.colors, tokenColors: theme.tokenColors as unknown[] };
  notifyColorThemeListeners();
  return theme;
}
