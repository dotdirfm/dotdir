import type { Bridge } from "@/features/bridge";
import { readFileText } from "@/features/file-system/fs";
import { deleteFilesystemPathRecursive } from "@/features/file-system/utils";
import { join, normalizePath } from "@/utils/path";
import { extensionDirName, normalizeExtensionManifest } from "./manifestNormalizer";
import {
  type ExtensionRef,
  type LoadedColorTheme,
  type LoadedExtension,
  type LoadedIconTheme,
  extensionColorThemes,
  extensionIconThemes,
  extensionRef,
} from "./types";

async function getExtensionsDir(dataDir: string): Promise<string> {
  return join(dataDir, "extensions");
}

async function readRefs(bridge: Bridge, dataDir: string): Promise<ExtensionRef[]> {
  const extensionsDir = await getExtensionsDir(dataDir);
  try {
    const text = await readFileText(bridge, join(extensionsDir, "extensions.json"));
    const refs = JSON.parse(text);
    return Array.isArray(refs) ? refs : [];
  } catch {
    return [];
  }
}

async function writeRefs(bridge: Bridge, dataDir: string, refs: ExtensionRef[]): Promise<void> {
  const extensionsDir = await getExtensionsDir(dataDir);
  await bridge.fs.createDir(extensionsDir);
  await bridge.fs.writeFile(join(extensionsDir, "extensions.json"), JSON.stringify(refs, null, 2));
}

export async function setExtensionAutoUpdate(bridge: Bridge, dataDir: string, publisher: string, name: string, autoUpdate: boolean): Promise<void> {
  const refs = await readRefs(bridge, dataDir);
  const next = refs.map((ref) => (ref.publisher === publisher && ref.name === name ? { ...ref, autoUpdate } : ref));
  await writeRefs(bridge, dataDir, next);
}

export async function loadExtensions(bridge: Bridge, dataDir: string): Promise<LoadedExtension[]> {
  const extensionsDir = await getExtensionsDir(dataDir);
  const refs = await readRefs(bridge, dataDir);

  const loaded: LoadedExtension[] = [];
  for (const ref of refs) {
    if (!ref.publisher || !ref.name || !ref.version) continue;
    try {
      const extDir = ref.path ? normalizePath(ref.path) : join(extensionsDir, extensionDirName(ref));
      const ext = await normalizeExtensionManifest({
        extDir,
        ref,
        readTextFile: async (path) => {
          try {
            return await readFileText(bridge, path);
          } catch {
            return null;
          }
        },
      });
      if (ext) loaded.push(ext);
    } catch {
      continue;
    }
  }

  return loaded;
}

export async function uninstallExtension(bridge: Bridge, dataDir: string, publisherUsername: string, extName: string): Promise<void> {
  const refs = await readRefs(bridge, dataDir);
  const target = refs.find((r) => r.publisher === publisherUsername && r.name === extName);
  if (target && !target.path) {
    const extensionsDir = await getExtensionsDir(dataDir);
    const extDir = join(extensionsDir, extensionDirName(target));
    await deleteFilesystemPathRecursive(bridge, extDir);
  }
  const filtered = refs.filter((r) => !(r.publisher === publisherUsername && r.name === extName));
  await writeRefs(bridge, dataDir, filtered);
}

export function extensionIconThemeId(ext: LoadedExtension): string | null {
  const firstTheme = extensionIconThemes(ext)[0];
  return firstTheme ? `${extensionRef(ext).publisher}.${extensionRef(ext).name}:${firstTheme.id}` : null;
}

export function extensionIconThemeKey(ext: LoadedExtension, themeId: string): string {
  return `${extensionRef(ext).publisher}.${extensionRef(ext).name}:${themeId}`;
}

export function findIconTheme(exts: LoadedExtension[], key: string): { ext: LoadedExtension; theme: LoadedIconTheme & { fss?: string } } | null {
  for (const ext of exts) {
    for (const theme of extensionIconThemes(ext)) {
      if (extensionIconThemeKey(ext, theme.id) === key) {
        return { ext, theme };
      }
    }
  }
  return null;
}

export function colorThemeKey(ext: LoadedExtension, themeId: string): string {
  return `${extensionRef(ext).publisher}.${extensionRef(ext).name}:${themeId}`;
}

export function findColorTheme(exts: LoadedExtension[], key: string): { ext: LoadedExtension; theme: LoadedColorTheme } | null {
  for (const ext of exts) {
    for (const theme of extensionColorThemes(ext)) {
      if (colorThemeKey(ext, theme.id) === key) {
        return { ext, theme };
      }
    }
  }
  return null;
}
