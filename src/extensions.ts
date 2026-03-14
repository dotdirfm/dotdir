import { bridge } from './bridge';
import { FileHandle } from './fsa';
import { dirname, join } from './path';

export const MARKETPLACE_URL = 'https://lastcompute.ru';

// FSS-based icon theme (Faraday format)
export interface ExtensionIconThemeFss {
  id: string;
  label: string;
  path: string;
}

// VS Code icon theme format
export interface ExtensionIconThemeVSCode {
  id: string;
  label: string;
  path: string; // path to JSON file
}

export type ExtensionIconTheme = ExtensionIconThemeFss | ExtensionIconThemeVSCode;

export interface ExtensionLanguage {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
  configuration?: string; // relative path to language-configuration.json
}

export interface ExtensionGrammar {
  language: string;
  scopeName: string;
  path: string; // relative path to .tmLanguage.json / .plist
  embeddedLanguages?: Record<string, string>;
}

export interface ExtensionCommand {
  command: string;
  title: string;
  category?: string;
  icon?: string;
}

export interface ExtensionKeybinding {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

export interface ExtensionMenu {
  command: string;
  group?: string;
  when?: string;
}

export interface ExtensionContributions {
  iconTheme?: ExtensionIconTheme; // FSS format (single)
  iconThemes?: ExtensionIconThemeVSCode[]; // VS Code format (array)
  languages?: ExtensionLanguage[];
  grammars?: ExtensionGrammar[];
  commands?: ExtensionCommand[];
  keybindings?: ExtensionKeybinding[];
  menus?: {
    commandPalette?: ExtensionMenu[];
    'explorer/context'?: ExtensionMenu[];
  };
}

export interface ExtensionManifest {
  name: string;
  version: string;
  publisher: string;
  displayName?: string;
  description?: string;
  icon?: string; // relative path to icon image
  contributes?: ExtensionContributions;
}

export interface ExtensionRef {
  publisher: string;
  name: string;
  version: string;
}

export interface LoadedGrammar {
  contribution: ExtensionGrammar;
  content: object; // parsed TextMate grammar JSON
}

export interface LoadedExtension {
  ref: ExtensionRef;
  manifest: ExtensionManifest;
  dirPath: string;
  iconUrl?: string;
  /** FSS-based icon theme content */
  iconThemeFss?: string;
  /** Directory containing the icon theme FSS file, for resolving relative url() paths */
  iconThemeBasePath?: string;
  /** VS Code icon theme JSON path (absolute) */
  vscodeIconThemePath?: string;
  /** VS Code icon theme ID */
  vscodeIconThemeId?: string;
  /** Language contributions from this extension */
  languages?: ExtensionLanguage[];
  /** Grammar contributions with their loaded content */
  grammars?: LoadedGrammar[];
  /** Command contributions from this extension */
  commands?: ExtensionCommand[];
  /** Keybinding contributions from this extension */
  keybindings?: ExtensionKeybinding[];
}

export interface MarketplaceExtension {
  id: string;
  name: string;
  display_name: string;
  description: string;
  icon_url: string | null;
  categories: string[];
  tags: string[];
  total_downloads: number;
  publisher: { username: string; display_name: string | null };
  latest_version: { version: string; archive_size: number; created_at: string } | null;
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

async function getExtensionsDir(): Promise<string> {
  const homePath = await bridge.utils.getHomePath();
  return join(homePath, '.faraday', 'extensions');
}

async function readRefs(): Promise<ExtensionRef[]> {
  const extensionsDir = await getExtensionsDir();
  try {
    const text = await readTextFile(join(extensionsDir, 'extensions.json'));
    const refs = JSON.parse(text);
    return Array.isArray(refs) ? refs : [];
  } catch {
    return [];
  }
}

async function writeRefs(refs: ExtensionRef[]): Promise<void> {
  const extensionsDir = await getExtensionsDir();
  await bridge.fsa.writeFile(
    join(extensionsDir, 'extensions.json'),
    JSON.stringify(refs, null, 2),
  );
}

export async function loadExtensions(): Promise<LoadedExtension[]> {
  const extensionsDir = await getExtensionsDir();
  const refs = await readRefs();

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
      let vscodeIconThemePath: string | undefined;
      let vscodeIconThemeId: string | undefined;

      // Check for FSS-based icon theme (Faraday format)
      if (manifest.contributes?.iconTheme?.path) {
        const themePath = join(extDir, manifest.contributes.iconTheme.path);
        // Detect if it's FSS or JSON based on extension
        if (themePath.endsWith('.json')) {
          vscodeIconThemePath = themePath;
          vscodeIconThemeId = manifest.contributes.iconTheme.id;
        } else {
          iconThemeFss = await readTextFile(themePath);
          iconThemeBasePath = dirname(themePath);
        }
      }

      // Check for VS Code icon themes (array format)
      if (manifest.contributes?.iconThemes?.length && !vscodeIconThemePath) {
        const firstTheme = manifest.contributes.iconThemes[0];
        vscodeIconThemePath = join(extDir, firstTheme.path);
        vscodeIconThemeId = firstTheme.id;
      }

      // Load language contributions
      const languages = manifest.contributes?.languages;

      // Load grammar contributions
      let grammars: LoadedGrammar[] | undefined;
      if (manifest.contributes?.grammars?.length) {
        grammars = [];
        for (const grammarContrib of manifest.contributes.grammars) {
          try {
            const grammarPath = join(extDir, grammarContrib.path);
            const grammarText = await readTextFile(grammarPath);
            const grammarContent = JSON.parse(grammarText);
            grammars.push({ contribution: grammarContrib, content: grammarContent });
          } catch {
            // Skip grammars that fail to load
          }
        }
      }

      // Load extension icon
      let iconUrl: string | undefined;
      if (manifest.icon) {
        try {
          const iconPath = join(extDir, manifest.icon);
          const iconHandle = new FileHandle(iconPath, manifest.icon.split('/').pop() ?? manifest.icon);
          const iconFile = await iconHandle.getFile();
          const buf = await iconFile.arrayBuffer();
          const ext = manifest.icon.split('.').pop()?.toLowerCase() ?? '';
          const mime = ext === 'svg' ? 'image/svg+xml'
            : ext === 'png' ? 'image/png'
            : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'webp' ? 'image/webp'
            : 'application/octet-stream';
          iconUrl = URL.createObjectURL(new Blob([buf], { type: mime }));
        } catch {
          // Icon file not found — ignore
        }
      }

      // Load command and keybinding contributions
      const commands = manifest.contributes?.commands;
      const keybindings = manifest.contributes?.keybindings;

      loaded.push({
        ref,
        manifest,
        dirPath: extDir,
        iconUrl,
        iconThemeFss,
        iconThemeBasePath,
        vscodeIconThemePath,
        vscodeIconThemeId,
        languages,
        grammars,
        commands,
        keybindings,
      });
    } catch {
      continue;
    }
  }

  return loaded;
}

export async function searchMarketplace(query = '', page = 1): Promise<{ extensions: MarketplaceExtension[]; total: number }> {
  const params = new URLSearchParams({ page: String(page), pageSize: '30' });
  if (query) params.set('q', query);
  const res = await fetch(`${MARKETPLACE_URL}/api/extensions/search?${params}`);
  if (!res.ok) throw new Error('Failed to search marketplace');
  return res.json();
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(compressed as unknown as ArrayBuffer);
  writer.close();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function extractZipFiles(buffer: ArrayBuffer): Promise<Map<string, string>> {
  const bytes = new Uint8Array(buffer);
  const files = new Map<string, string>();

  const read2 = (o: number) => bytes[o] | (bytes[o + 1] << 8);
  const read4 = (o: number) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;

  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (read4(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Invalid ZIP archive');

  const cdOffset = read4(eocdOffset + 16);
  const cdEntries = read2(eocdOffset + 10);

  let pos = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (read4(pos) !== 0x02014b50) break;

    const method = read2(pos + 10);
    const compSize = read4(pos + 20);
    const nameLen = read2(pos + 28);
    const extraLen = read2(pos + 30);
    const commentLen = read2(pos + 32);
    const localHeaderOffset = read4(pos + 42);

    const fileName = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (fileName.endsWith('/')) continue;

    const localNameLen = read2(localHeaderOffset + 26);
    const localExtraLen = read2(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.slice(dataStart, dataStart + compSize);

    let content: string;
    if (method === 0) {
      content = new TextDecoder().decode(raw);
    } else if (method === 8) {
      const decompressed = await inflateRaw(raw);
      content = new TextDecoder().decode(decompressed);
    } else {
      continue;
    }

    files.set(fileName, content);
  }

  return files;
}

export async function installExtension(publisherUsername: string, extName: string, version: string): Promise<void> {
  const downloadUrl = `${MARKETPLACE_URL}/api/extensions/${publisherUsername}/${extName}/${version}/download`;
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);

  const buffer = await res.arrayBuffer();
  const files = await extractZipFiles(buffer);

  const extensionsDir = await getExtensionsDir();
  const ref: ExtensionRef = { publisher: publisherUsername, name: extName, version };
  const extDir = join(extensionsDir, extensionDirName(ref));

  for (const [fileName, content] of files) {
    const normalizedName = fileName.replace(/^[^/]+\//, '');
    if (!normalizedName) continue;
    await bridge.fsa.writeFile(join(extDir, normalizedName), content);
  }

  const refs = await readRefs();
  const filtered = refs.filter(r => !(r.publisher === publisherUsername && r.name === extName));
  filtered.push(ref);
  await writeRefs(filtered);
}

/**
 * Extract files from a VSIX package (VS Code extension format).
 * VSIX files have contents under 'extension/' prefix.
 */
async function extractVsixFiles(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(buffer);
  const files = new Map<string, Uint8Array>();

  const read2 = (o: number) => bytes[o] | (bytes[o + 1] << 8);
  const read4 = (o: number) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;

  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (read4(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Invalid VSIX archive');

  const cdOffset = read4(eocdOffset + 16);
  const cdEntries = read2(eocdOffset + 10);

  let pos = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (read4(pos) !== 0x02014b50) break;

    const method = read2(pos + 10);
    const compSize = read4(pos + 20);
    const nameLen = read2(pos + 28);
    const extraLen = read2(pos + 30);
    const commentLen = read2(pos + 32);
    const localHeaderOffset = read4(pos + 42);

    const fileName = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (fileName.endsWith('/')) continue;

    // VSIX files have extension content under 'extension/' prefix
    if (!fileName.startsWith('extension/')) continue;

    const localNameLen = read2(localHeaderOffset + 26);
    const localExtraLen = read2(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.slice(dataStart, dataStart + compSize);

    let content: Uint8Array;
    if (method === 0) {
      content = raw;
    } else if (method === 8) {
      content = await inflateRaw(raw);
    } else {
      continue;
    }

    // Remove 'extension/' prefix
    const normalizedName = fileName.slice('extension/'.length);
    if (normalizedName) {
      files.set(normalizedName, content);
    }
  }

  return files;
}

export async function installVSCodeExtension(publisherName: string, extName: string, downloadUrl: string): Promise<void> {
  // Add timeout for CORS-blocked requests that hang
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  
  let res: Response;
  try {
    res = await fetch(downloadUrl, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Download timed out - VS Code marketplace may be blocked by CORS');
    }
    throw new Error(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timeoutId);
  
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  const buffer = await res.arrayBuffer();
  const files = await extractVsixFiles(buffer);

  // Find package.json to get version
  const packageJsonBytes = files.get('package.json');
  if (!packageJsonBytes) throw new Error('Invalid VSIX: no package.json');
  const packageJson = JSON.parse(new TextDecoder().decode(packageJsonBytes));
  const version = packageJson.version || '0.0.0';

  const extensionsDir = await getExtensionsDir();
  const ref: ExtensionRef = { publisher: publisherName, name: extName, version };
  const extDir = join(extensionsDir, extensionDirName(ref));

  for (const [fileName, content] of files) {
    const filePath = join(extDir, fileName);
    // Write as text for known text files, binary otherwise
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const isTextFile = ['json', 'txt', 'md', 'js', 'ts', 'css', 'html', 'xml', 'yaml', 'yml', 'tmLanguage', 'tmGrammar'].includes(ext)
      || fileName.endsWith('.tmLanguage.json')
      || fileName.endsWith('.language-configuration.json');
    
    if (isTextFile) {
      await bridge.fsa.writeFile(filePath, new TextDecoder().decode(content));
    } else {
      await bridge.fsa.writeFile(filePath, new TextDecoder().decode(content));
    }
  }

  const refs = await readRefs();
  const filtered = refs.filter(r => !(r.publisher === publisherName && r.name === extName));
  filtered.push(ref);
  await writeRefs(filtered);
}

export async function uninstallExtension(publisherUsername: string, extName: string): Promise<void> {
  const refs = await readRefs();
  const filtered = refs.filter(r => !(r.publisher === publisherUsername && r.name === extName));
  await writeRefs(filtered);
}

// ── Settings ────────────────────────────────────────────────────────

export interface PanelPersistedState {
  currentPath: string;
  selectedName?: string;
  topmostName?: string;
}

export interface FaradaySettings {
  iconTheme?: string; // "publisher.name" of the active icon theme
  editorFileSizeLimit?: number; // Max file size in bytes to open for editing (default: 1MB)
  leftPanel?: PanelPersistedState;
  rightPanel?: PanelPersistedState;
  activePanel?: 'left' | 'right';
}

export const DEFAULT_EDITOR_FILE_SIZE_LIMIT = 1024 * 1024; // 1MB

async function getSettingsPath(): Promise<string> {
  const homePath = await bridge.utils.getHomePath();
  return join(homePath, '.faraday', 'settings.json');
}

export async function readSettings(): Promise<FaradaySettings> {
  try {
    const text = await readTextFile(await getSettingsPath());
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function writeSettings(settings: FaradaySettings): Promise<void> {
  await bridge.fsa.writeFile(await getSettingsPath(), JSON.stringify(settings, null, 2));
}

export function extensionIconThemeId(ext: LoadedExtension): string | null {
  if (ext.iconThemeFss || ext.vscodeIconThemePath) {
    return `${ext.ref.publisher}.${ext.ref.name}`;
  }
  return null;
}

export function isVSCodeIconTheme(ext: LoadedExtension): boolean {
  return ext.vscodeIconThemePath != null;
}
