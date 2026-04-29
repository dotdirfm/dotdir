import type { Bridge } from "@dotdirfm/ui-bridge";
import { readFileText } from "@/features/file-system/fs";
import { deleteFilesystemPathRecursive } from "@/features/file-system/utils";
import { dirname, join, normalizePath } from "@dotdirfm/ui-utils";
import {
  type ExtensionManifest,
  type ExtensionRef,
  type LoadedColorTheme,
  type LoadedExtension,
  type LoadedIconTheme,
  extensionColorThemes,
  extensionIconThemes,
  extensionRef,
} from "./types";

function extensionDirName(ref: ExtensionRef): string {
  return `${ref.publisher}-${ref.name}-${ref.version}`;
}

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
      const manifest: ExtensionManifest = JSON.parse(await readFileText(bridge, join(extDir, "package.json")));

      const iconThemes: LoadedExtension["assets"]["iconThemes"] = [];
      if (manifest.contributes?.iconTheme?.path) {
        const theme = manifest.contributes.iconTheme;
        const themePath = join(extDir, theme.path);
        if (themePath.endsWith(".json")) {
          iconThemes.push({
            id: theme.id || "default",
            label: theme.label || manifest.displayName || manifest.name,
            kind: "vscode",
            path: themePath,
            sourceId: theme.id,
          });
        } else {
          iconThemes.push({
            id: theme.id || "default",
            label: theme.label || manifest.displayName || manifest.name,
            kind: "fss",
            path: themePath,
            basePath: dirname(themePath),
            sourceId: theme.id,
          });
        }
      }
      if (manifest.contributes?.iconThemes?.length) {
        iconThemes.push(
          ...manifest.contributes.iconThemes.map((theme, index) => ({
            id: theme.id || `${theme.label}#${index}`,
            label: theme.label,
            kind: theme.path.endsWith(".json") ? "vscode" as const : "fss" as const,
            path: join(extDir, theme.path),
            basePath: theme.path.endsWith(".json") ? undefined : dirname(join(extDir, theme.path)),
            sourceId: theme.id,
          })),
        );
      }

      // Load language contributions
      const languages = manifest.contributes?.languages;

      // Load grammar contributions
      let grammarRefs: LoadedExtension["contributions"]["grammarRefs"];
      if (manifest.contributes?.grammars?.length) {
        grammarRefs = [];
        for (const grammarContrib of manifest.contributes.grammars) {
          try {
            const grammarPath = join(extDir, grammarContrib.path);
            grammarRefs.push({
              contribution: grammarContrib,
              path: grammarPath,
            });
          } catch {
            // Skip grammars that fail to load
          }
        }
      }

      // Load color theme contributions
      let colorThemes: LoadedExtension["assets"]["colorThemes"];
      if (manifest.contributes?.themes?.length) {
        colorThemes = manifest.contributes.themes.map((t, i) => ({
          id: t.id || `${t.label}#${i}`,
          label: t.label,
          uiTheme: t.uiTheme,
          jsonPath: join(extDir, t.path),
        }));
      }

      // Load command and keybinding contributions
      const commands = manifest.contributes?.commands;
      const keybindings = manifest.contributes?.keybindings;

      // Load viewer, editor, and fsProvider contributions
      const viewers = manifest.contributes?.viewers;
      const editors = manifest.contributes?.editors;
      const fsProviders = manifest.contributes?.fsProviders;

      // Load shell integration contributions
      let shellIntegrations: LoadedExtension["contributions"]["shellIntegrations"];
      if (manifest.contributes?.shellIntegrations?.length) {
        shellIntegrations = [];
        for (const si of manifest.contributes.shellIntegrations) {
          try {
            const script = await readFileText(bridge, join(extDir, si.scriptPath));
            shellIntegrations.push({
              shell: si.shell,
              label: si.label,
              script,
              executableCandidates: si.executableCandidates ?? [],
              platforms: si.platforms,
              hiddenCdTemplate: si.hiddenCdTemplate,
              cwdEscape: si.cwdEscape,
              lineEnding: si.lineEnding,
              spawnArgs: si.spawnArgs,
              scriptArg: si.scriptArg,
            });
          } catch {
            // Skip scripts that fail to load
          }
        }
      }

      loaded.push({
        identity: {
          ref,
          manifest,
        },
        location: {
          dirPath: extDir,
        },
        assets: {
          iconThemes: iconThemes.length > 0 ? iconThemes : undefined,
          colorThemes,
        },
        contributions: {
          languages,
          grammarRefs,
          commands,
          keybindings,
          viewers,
          editors,
          fsProviders,
          shellIntegrations,
        },
      });
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
