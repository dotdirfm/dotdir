/**
 * VS Code Icon Theme Support
 *
 * Parses VS Code icon theme JSON format and provides icon resolution.
 */

import { FileHandle } from './fs';
import { join, dirname } from './path';

export interface VSCodeIconDefinition {
  iconPath: string;
}

export interface VSCodeIconThemeJson {
  iconDefinitions: Record<string, VSCodeIconDefinition>;
  file?: string;
  folder?: string;
  folderExpanded?: string;
  rootFolder?: string;
  rootFolderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
  light?: {
    file?: string;
    folder?: string;
    folderExpanded?: string;
    fileExtensions?: Record<string, string>;
    fileNames?: Record<string, string>;
    folderNames?: Record<string, string>;
    folderNamesExpanded?: Record<string, string>;
  };
  highContrast?: {
    file?: string;
    folder?: string;
    folderExpanded?: string;
    fileExtensions?: Record<string, string>;
    fileNames?: Record<string, string>;
    folderNames?: Record<string, string>;
    folderNamesExpanded?: Record<string, string>;
  };
}

export interface LoadedVSCodeIconTheme {
  json: VSCodeIconThemeJson;
  basePath: string;
  iconCache: Map<string, string>; // iconPath → data URL
}

export interface IconMatch {
  iconPath: string | null;
  iconUrl: string | null;
}

async function readBinaryFile(path: string): Promise<ArrayBuffer> {
  const name = path.split('/').pop() ?? path;
  const handle = new FileHandle(path, name);
  const file = await handle.getFile();
  return file.arrayBuffer();
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export class VSCodeIconThemeResolver {
  private theme: LoadedVSCodeIconTheme | null = null;
  private loadingIcons = new Map<string, Promise<string | null>>();
  private themeKind: 'dark' | 'light' = 'dark';

  async load(jsonPath: string): Promise<void> {
    const name = jsonPath.split('/').pop() ?? jsonPath;
    const handle = new FileHandle(jsonPath, name);
    const file = await handle.getFile();
    const text = await file.text();
    const json: VSCodeIconThemeJson = JSON.parse(text);
    
    this.theme = {
      json,
      basePath: dirname(jsonPath),
      iconCache: new Map(),
    };
  }

  setTheme(kind: 'dark' | 'light'): void {
    this.themeKind = kind;
  }

  clear(): void {
    this.theme = null;
    this.loadingIcons.clear();
  }

  isLoaded(): boolean {
    return this.theme !== null;
  }

  private getEffectiveMap<T>(
    darkValue: T | undefined,
    lightValue: T | undefined,
  ): T | undefined {
    if (this.themeKind === 'light' && lightValue !== undefined) {
      return lightValue;
    }
    return darkValue;
  }

  resolveIcon(
    name: string,
    isDirectory: boolean,
    isExpanded: boolean,
    isRoot: boolean,
    langId?: string,
  ): string | null {
    if (!this.theme) return null;
    const { json } = this.theme;
    const light = this.themeKind === 'light' ? json.light : undefined;

    let iconKey: string | undefined;

    if (isDirectory) {
      const folderNames = this.getEffectiveMap(
        isExpanded ? json.folderNamesExpanded : json.folderNames,
        isExpanded ? light?.folderNamesExpanded : light?.folderNames,
      );
      if (folderNames?.[name]) {
        iconKey = folderNames[name];
      } else if (folderNames?.[name.toLowerCase()]) {
        iconKey = folderNames[name.toLowerCase()];
      } else if (isRoot) {
        iconKey = this.getEffectiveMap(
          isExpanded ? json.rootFolderExpanded : json.rootFolder,
          undefined,
        ) ?? this.getEffectiveMap(
          isExpanded ? json.folderExpanded : json.folder,
          isExpanded ? light?.folderExpanded : light?.folder,
        );
      } else {
        iconKey = this.getEffectiveMap(
          isExpanded ? json.folderExpanded : json.folder,
          isExpanded ? light?.folderExpanded : light?.folder,
        );
      }
    } else {
      // File: check filename, then extension, then languageId, then default
      const fileNames = this.getEffectiveMap(json.fileNames, light?.fileNames);
      if (fileNames?.[name]) {
        iconKey = fileNames[name];
      } else if (fileNames?.[name.toLowerCase()]) {
        iconKey = fileNames[name.toLowerCase()];
      } else {
        // Try extensions (longest match first)
        const fileExtensions = this.getEffectiveMap(json.fileExtensions, light?.fileExtensions);
        if (fileExtensions) {
          const parts = name.split('.');
          for (let i = 1; i < parts.length; i++) {
            const ext = parts.slice(i).join('.').toLowerCase();
            if (fileExtensions[ext]) {
              iconKey = fileExtensions[ext];
              break;
            }
          }
        }

        // Try languageId
        if (!iconKey && langId && json.languageIds?.[langId]) {
          iconKey = json.languageIds[langId];
        }

        // Default file icon
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

  async loadIcon(iconPath: string): Promise<string | null> {
    if (!this.theme) return null;

    const cached = this.theme.iconCache.get(iconPath);
    if (cached) return cached;

    const existing = this.loadingIcons.get(iconPath);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const buf = await readBinaryFile(iconPath);
        const ext = iconPath.split('.').pop()?.toLowerCase() ?? '';
        
        let dataUrl: string;
        if (ext === 'svg') {
          const text = new TextDecoder().decode(buf);
          dataUrl = svgToDataUrl(text);
        } else {
          const mime = ext === 'png' ? 'image/png'
            : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'webp' ? 'image/webp'
            : 'application/octet-stream';
          const blob = new Blob([buf], { type: mime });
          dataUrl = URL.createObjectURL(blob);
        }

        this.theme?.iconCache.set(iconPath, dataUrl);
        return dataUrl;
      } catch {
        return null;
      } finally {
        this.loadingIcons.delete(iconPath);
      }
    })();

    this.loadingIcons.set(iconPath, promise);
    return promise;
  }

  async preloadIcons(paths: string[]): Promise<void> {
    await Promise.all(paths.map(p => this.loadIcon(p)));
  }

  getCachedIcon(iconPath: string): string | null {
    return this.theme?.iconCache.get(iconPath) ?? null;
  }
}

export const vscodeIconTheme = new VSCodeIconThemeResolver();
