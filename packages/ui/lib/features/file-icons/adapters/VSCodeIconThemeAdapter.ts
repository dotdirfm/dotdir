import type { Bridge } from "@/features/bridge";
import { readFileBuffer, readFileText } from "@/features/file-system/fs";
import { dirname, join } from "@/utils/path";
import { parse as parseJsonc } from "jsonc-parser";
import type { IconAssetStore } from "../iconCache";
import type { IconLookupInput, IconThemeAdapter, ResolvedThemeIcon } from "./types";

type VSCodeIconDefinition = {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontId?: string;
  fontSize?: string;
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

type VSCodeThemeFont = {
  id: string;
  src?: Array<{ path: string; format?: string }>;
  weight?: string;
  style?: string;
  size?: string;
};

type VSCodeIconThemeJson = IconsSet & {
  iconDefinitions: Record<string, VSCodeIconDefinition>;
  fonts?: VSCodeThemeFont[];
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
  private loadedFonts = new Map<string, Promise<void>>();

  constructor(private bridge: Bridge) {}

  async load(path: string): Promise<void> {
    const text = await readFileText(this.bridge, path);
    const json: VSCodeIconThemeJson = parseJsonc(text, undefined, { allowTrailingComma: true });
    this.theme = {
      json,
      basePath: dirname(path),
    };
    this.loadedFonts.clear();
  }

  clear(): void {
    this.theme = null;
    this.loadedFonts.clear();
  }

  setThemeKind(kind: "dark" | "light"): void {
    this.themeKind = kind;
  }

  resolve(input: IconLookupInput): ResolvedThemeIcon | null {
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
    if (!def) return null;
    if (def.iconPath) {
      return {
        kind: "image",
        path: join(this.theme.basePath, def.iconPath),
      };
    }
    if (!def.fontCharacter) return null;

    const font = this.resolveFontDefinition(def);
    if (!font) return null;
    return {
      kind: "font",
      character: this.decodeFontCharacter(def.fontCharacter),
      fontFamily: font.id,
      color: def.fontColor,
      fontSize: def.fontSize ?? font.size,
    };
  }

  async prepareIcons(icons: ResolvedThemeIcon[], iconAssets: IconAssetStore): Promise<void> {
    const imagePaths: string[] = [];
    const fontFamilies = new Set<string>();

    for (const icon of icons) {
      if (icon.kind === "image") {
        imagePaths.push(icon.path);
        continue;
      }
      fontFamilies.add(icon.fontFamily);
    }

    if (imagePaths.length > 0) {
      await iconAssets.loadIcons(imagePaths);
    }

    await Promise.all([...fontFamilies].map(async (fontFamily) => this.ensureFontLoaded(fontFamily)));
  }

  private getEffectiveMap<T>(darkValue: T | undefined, lightValue: T | undefined): T | undefined {
    if (this.themeKind === "light" && lightValue !== undefined) {
      return lightValue;
    }
    return darkValue;
  }

  private resolveFontDefinition(def: VSCodeIconDefinition): VSCodeThemeFont | null {
    if (!this.theme?.json.fonts?.length) return null;
    if (def.fontId) {
      return this.theme.json.fonts.find((font) => font.id === def.fontId) ?? null;
    }
    return this.theme.json.fonts[0] ?? null;
  }

  private decodeFontCharacter(raw: string): string {
    const trimmed = raw.trim();
    const withoutPrefix = trimmed.replace(/^\\u?/i, "");
    const codePoint = Number.parseInt(withoutPrefix, 16);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : trimmed;
  }

  private async ensureFontLoaded(fontId: string): Promise<void> {
    if (!this.theme?.json.fonts?.length) return;
    const existing = this.loadedFonts.get(fontId);
    if (existing) return existing;

    const promise = (async () => {
      const font = this.theme?.json.fonts?.find((item) => item.id === fontId);
      const src = font?.src?.[0];
      if (!font || !src?.path || !this.theme) return;
      const fontPath = join(this.theme.basePath, src.path.replace(/^\/+/, ""));
      const source = await readFileBuffer(this.bridge, fontPath);
      const face = new FontFace(font.id, source, {
        weight: font.weight ?? "normal",
        style: font.style ?? "normal",
      });
      await face.load();
      document.fonts.add(face);
    })();

    this.loadedFonts.set(fontId, promise);
    return promise;
  }
}
