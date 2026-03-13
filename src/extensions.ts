import { bridge } from './bridge';
import { FileHandle } from './fsa';
import { dirname, join } from './path';

export interface ExtensionIconTheme {
  id: string;
  label: string;
  path: string;
}

export interface ExtensionContributions {
  iconTheme?: ExtensionIconTheme;
}

export interface ExtensionManifest {
  name: string;
  version: string;
  publisher: string;
  contributes?: ExtensionContributions;
}

export interface ExtensionRef {
  publisher: string;
  name: string;
  version: string;
}

export interface LoadedExtension {
  ref: ExtensionRef;
  manifest: ExtensionManifest;
  dirPath: string;
  iconThemeFss?: string;
  /** Directory containing the icon theme FSS file, for resolving relative url() paths */
  iconThemeBasePath?: string;
}

function extensionDirName(ref: ExtensionRef): string {
  return `${ref.publisher}-${ref.name}-${ref.version}`;
}

async function readTextFile(path: string): Promise<string> {
  const name = path.split('/').pop() ?? path;
  const handle = new FileHandle(path, name);
  const file = await handle.getFile();
  return file.text();
}

export async function loadExtensions(): Promise<LoadedExtension[]> {
  const homePath = await bridge.utils.getHomePath();
  const extensionsDir = join(homePath, '.faraday', 'extensions');

  let refs: ExtensionRef[];
  try {
    const text = await readTextFile(join(extensionsDir, 'extensions.json'));
    refs = JSON.parse(text);
  } catch {
    return [];
  }

  if (!Array.isArray(refs)) return [];

  const loaded: LoadedExtension[] = [];
  for (const ref of refs) {
    if (!ref.publisher || !ref.name || !ref.version) continue;
    try {
      const extDir = join(extensionsDir, extensionDirName(ref));
      const manifest: ExtensionManifest = JSON.parse(
        await readTextFile(join(extDir, 'package.json')),
      );

      let iconThemeFss: string | undefined;
      let iconThemeBasePath: string | undefined;
      if (manifest.contributes?.iconTheme?.path) {
        const fssPath = join(extDir, manifest.contributes.iconTheme.path);
        iconThemeFss = await readTextFile(fssPath);
        iconThemeBasePath = dirname(fssPath);
      }

      loaded.push({ ref, manifest, dirPath: extDir, iconThemeFss, iconThemeBasePath });
    } catch {
      continue;
    }
  }

  return loaded;
}
