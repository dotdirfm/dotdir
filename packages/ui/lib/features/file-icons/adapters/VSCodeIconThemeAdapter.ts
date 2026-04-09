import type { Bridge } from "@/features/bridge";
import { readFileText } from "@/features/file-system/fs";
import { dirname, join } from "@/utils/path";
import { parse as parseJsonc } from "jsonc-parser";
import type { IconAssetStore } from "../iconCache";
import type { IconLookupInput, IconThemeAdapter } from "./types";

type VSCodeIconDefinition = {
  iconPath: string;
};

type IconsSet = {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  rootFolder?: string;
  rootFolderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
};

type VSCodeIconThemeJson = IconsSet & {
  iconDefinitions: Record<string, VSCodeIconDefinition>;
  languageIds?: Record<string, string>;
  light?: IconsSet;
  highContrast?: IconsSet;
};

type LoadedVSCodeIconTheme = {
  json: VSCodeIconThemeJson;
  basePath: string;
};

export class VSCodeIconThemeAdapter implements IconThemeAdapter {
  readonly kind = "vscode" as const;
  private theme: LoadedVSCodeIconTheme | null = null;
  private themeKind: "dark" | "light" = "dark";

  constructor(
    private bridge: Bridge,
    private iconAssets: IconAssetStore,
  ) {}

  async load(path: string): Promise<void> {
    const text = await readFileText(this.bridge, path);
    const json: VSCodeIconThemeJson = parseJsonc(text, undefined, { allowTrailingComma: true });
    this.theme = {
      json,
      basePath: dirname(path),
    };
  }

  private getEffectiveMap<T>(darkValue: T | undefined, lightValue: T | undefined): T | undefined {
    if (this.themeKind === "light" && lightValue !== undefined) {
      return lightValue;
    }
    return darkValue;
  }

  resolve(input: IconLookupInput): string | null {
    if (!this.theme) return null;
    const { json } = this.theme;
    const light = this.themeKind === "light" ? json.light : undefined;

    let iconKey: string | undefined;

    if (input.isDirectory) {
      const folderNames = this.getEffectiveMap(
        input.isExpanded ? json.folderNamesExpanded : json.folderNames,
        input.isExpanded ? light?.folderNamesExpanded : light?.folderNames,
      );
      if (folderNames?.[input.name]) {
        iconKey = folderNames[input.name];
      } else if (folderNames?.[input.name.toLowerCase()]) {
        iconKey = folderNames[input.name.toLowerCase()];
      } else if (input.isRoot) {
        iconKey =
          this.getEffectiveMap(input.isExpanded ? json.rootFolderExpanded : json.rootFolder, undefined) ??
          this.getEffectiveMap(input.isExpanded ? json.folderExpanded : json.folder, input.isExpanded ? light?.folderExpanded : light?.folder);
      } else {
        iconKey = this.getEffectiveMap(input.isExpanded ? json.folderExpanded : json.folder, input.isExpanded ? light?.folderExpanded : light?.folder);
      }
    } else {
      const fileNames = this.getEffectiveMap(json.fileNames, light?.fileNames);
      if (fileNames?.[input.name]) {
        iconKey = fileNames[input.name];
      } else if (fileNames?.[input.name.toLowerCase()]) {
        iconKey = fileNames[input.name.toLowerCase()];
      } else {
        const fileExtensions = this.getEffectiveMap(json.fileExtensions, light?.fileExtensions);
        if (fileExtensions) {
          const parts = input.name.split(".");
          for (let i = 1; i < parts.length; i++) {
            const ext = parts.slice(i).join(".").toLowerCase();
            if (fileExtensions[ext]) {
              iconKey = fileExtensions[ext];
              break;
            }
          }
        }

        if (!iconKey && input.langId && json.languageIds?.[input.langId]) {
          iconKey = json.languageIds[input.langId];
        }

        if (!iconKey) {
          iconKey = this.getEffectiveMap(json.file, light?.file);
        }
      }
    }

    if (!iconKey) return null;

    const def = json.iconDefinitions[iconKey];
    if (!def?.iconPath) return null;

    return join(this.theme.basePath, def.iconPath);
  }

  async preload(keys: string[]): Promise<void> {
    if (!this.theme) return;
    await this.iconAssets.loadIcons(keys);
  }

  getCachedUrl(key: string): string | null {
    return this.iconAssets.getCachedIconUrl(key) ?? null;
  }

  clear(): void {
    this.theme = null;
  }

  setThemeKind(kind: "dark" | "light"): void {
    this.themeKind = kind;
  }
}
