import { bridge } from './bridge';
import { FileHandle } from './fsa';
import { dirname, join, normalizePath } from './path';

export const MARKETPLACE_URL = 'https://faraday-marketplace.troubleshooters.dev';

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

export interface ExtensionViewerContribution {
  id: string;
  label: string;
  patterns: string[];
  mimeTypes?: string[];
  entry: string;
  priority?: number;
}

export interface ExtensionEditorContribution {
  id: string;
  label: string;
  patterns: string[];
  mimeTypes?: string[];
  langId?: string;
  entry: string;
  priority?: number;
}

export interface ExtensionColorTheme {
  id?: string;
  label: string;
  uiTheme: string; // 'vs-dark' | 'vs' | 'hc-black' | 'hc-light'
  path: string; // relative path to JSON file
}

export interface ExtensionContributions {
  iconTheme?: ExtensionIconTheme; // FSS format (single)
  iconThemes?: ExtensionIconThemeVSCode[]; // VS Code format (array)
  themes?: ExtensionColorTheme[]; // VS Code color themes
  languages?: ExtensionLanguage[];
  grammars?: ExtensionGrammar[];
  commands?: ExtensionCommand[];
  keybindings?: ExtensionKeybinding[];
  menus?: {
    commandPalette?: ExtensionMenu[];
    'explorer/context'?: ExtensionMenu[];
  };
  viewers?: ExtensionViewerContribution[];
  editors?: ExtensionEditorContribution[];
}

export interface ExtensionManifest {
  name: string;
  version: string;
  publisher: string;
  displayName?: string;
  description?: string;
  icon?: string; // relative path to icon image
  /**
   * Optional browser activation script entry.
   * If present, the host will load it and call its exported `activate()` / `deactivate()`.
   */
  browser?: string;
  contributes?: ExtensionContributions;
}

export interface ExtensionRef {
  publisher: string;
  name: string;
  version: string;
  /** Optional absolute path for development; when set, load extension from this dir instead of ~/.faraday/extensions/<publisher>-<name>-<version>. */
  path?: string;
}

export interface LoadedGrammar {
  contribution: ExtensionGrammar;
  content: object; // parsed TextMate grammar JSON
}

export interface LoadedGrammarRef {
  contribution: ExtensionGrammar;
  /** Absolute path to the grammar JSON file on disk. */
  path: string;
}

export interface LoadedColorTheme {
  id: string;
  label: string;
  uiTheme: string;
  jsonPath: string; // absolute path to theme JSON
}

export interface LoadedExtension {
  ref: ExtensionRef;
  manifest: ExtensionManifest;
  dirPath: string;
  iconUrl?: string;
  /** FSS-based icon theme content (lazy-loaded when active). */
  iconThemeFss?: string;
  /** Absolute path to the FSS icon theme file on disk (lazy-loaded). */
  iconThemeFssPath?: string;
  /** Directory containing the icon theme FSS file, for resolving relative url() paths */
  iconThemeBasePath?: string;
  /** VS Code icon theme JSON path (absolute) */
  vscodeIconThemePath?: string;
  /** VS Code icon theme ID */
  vscodeIconThemeId?: string;
  /** Color theme contributions from this extension */
  colorThemes?: LoadedColorTheme[];
  /** Language contributions from this extension */
  languages?: ExtensionLanguage[];
  /** Grammar contributions (lazy JSON loading for editor). */
  grammarRefs?: LoadedGrammarRef[];
  /** Previously loaded grammars (kept for compatibility). */
  grammars?: LoadedGrammar[];
  /** Command contributions from this extension */
  commands?: ExtensionCommand[];
  /** Keybinding contributions from this extension */
  keybindings?: ExtensionKeybinding[];
  /** Viewer contributions from this extension */
  viewers?: ExtensionViewerContribution[];
  /** Editor contributions from this extension */
  editors?: ExtensionEditorContribution[];
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
      const extDir = ref.path ? normalizePath(ref.path) : join(extensionsDir, extensionDirName(ref));
      const manifest: ExtensionManifest = JSON.parse(
        await readTextFile(join(extDir, 'package.json')),
      );

      let iconThemeFss: string | undefined;
      let iconThemeFssPath: string | undefined;
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
          // Lazy: don't read FSS contents for all extensions.
          iconThemeFssPath = themePath;
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
      let grammarRefs: LoadedGrammarRef[] | undefined;
      if (manifest.contributes?.grammars?.length) {
        grammarRefs = [];
        for (const grammarContrib of manifest.contributes.grammars) {
          try {
            const grammarPath = join(extDir, grammarContrib.path);
            grammarRefs.push({ contribution: grammarContrib, path: grammarPath });
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

      // Load color theme contributions
      let colorThemes: LoadedColorTheme[] | undefined;
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

      // Load viewer and editor contributions
      const viewers = manifest.contributes?.viewers;
      const editors = manifest.contributes?.editors;

      loaded.push({
        ref,
        manifest,
        dirPath: extDir,
        iconUrl,
        iconThemeFss,
        iconThemeFssPath,
        iconThemeBasePath,
        vscodeIconThemePath,
        vscodeIconThemeId,
        colorThemes,
        languages,
        grammarRefs,
        commands,
        keybindings,
        viewers,
        editors,
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

/**
 * If the zip has a single top-level directory (e.g. "ext-name-1.0.0/package.json"),
 * return the prefix to strip ("ext-name-1.0.0/"). Otherwise return "" so paths are kept as-is.
 */
function getZipStripPrefix(fileNames: Iterable<string>): string {
  const names = [...fileNames];
  if (names.length === 0) return '';
  const first = names[0];
  const slash = first.indexOf('/');
  if (slash === -1) return '';
  const prefix = first.slice(0, slash + 1);
  const allSamePrefix = names.every((n) => n.startsWith(prefix));
  return allSamePrefix ? prefix : '';
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

  const stripPrefix = getZipStripPrefix(files.keys());

  for (const [fileName, content] of files) {
    const normalizedName = stripPrefix ? fileName.slice(stripPrefix.length) : fileName;
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
    const msg = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err) ? String((err as { message: unknown }).message) : String(err);
    throw new Error(`Download failed: ${msg}`);
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
      await bridge.fsa.writeBinaryFile(filePath, content);
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

export interface PersistedTab {
  type: 'filelist';
  path: string;
}

export interface PanelPersistedState {
  currentPath: string;
  tabs?: PersistedTab[];
  activeTabIndex?: number;
  selectedName?: string;
  topmostName?: string;
}

export interface FaradaySettings {
  iconTheme?: string; // "publisher.name" of the active icon theme
  colorTheme?: string; // "publisher.name:themeId" of the active color theme
  /**
   * Max file size in bytes to open for editing.
   * Use 0 (or any negative value) to disable the limit.
   */
  editorFileSizeLimit?: number;
  leftPanel?: PanelPersistedState;
  rightPanel?: PanelPersistedState;
  activePanel?: 'left' | 'right';
}

// 0 disables the limit (allows editing any size file).
export const DEFAULT_EDITOR_FILE_SIZE_LIMIT = 0;

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
  if (ext.iconThemeFss || ext.iconThemeFssPath || ext.vscodeIconThemePath) {
    return `${ext.ref.publisher}.${ext.ref.name}`;
  }
  return null;
}

export function isVSCodeIconTheme(ext: LoadedExtension): boolean {
  return ext.vscodeIconThemePath != null;
}

export function colorThemeKey(ext: LoadedExtension, themeId: string): string {
  return `${ext.ref.publisher}.${ext.ref.name}:${themeId}`;
}

export function findColorTheme(
  exts: LoadedExtension[],
  key: string,
): { ext: LoadedExtension; theme: LoadedColorTheme } | null {
  for (const ext of exts) {
    if (!ext.colorThemes) continue;
    for (const theme of ext.colorThemes) {
      if (colorThemeKey(ext, theme.id) === key) {
        return { ext, theme };
      }
    }
  }
  return null;
}
