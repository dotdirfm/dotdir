import { Bridge, type CwdEscapeMode, type DeleteProgressEvent } from "@/features/bridge";
import { readFileBuffer, readFileText } from "@/fs";
import { dirname, join, normalizePath } from "@/utils/path";

export const MARKETPLACE_URL = "https://dotdir.dev";

// FSS-based icon theme (.dir format)
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

/**
 * An fsProvider contribution allows an extension to expose the contents of a
 * file (e.g. a ZIP archive) as a browsable directory tree.
 * Patterns match the container file name (same glob syntax as viewers/editors).
 */
export interface ExtensionFsProviderContribution {
  id: string;
  label: string;
  patterns: string[];
  entry: string;
  priority?: number;
  /**
   * Where the provider runs.
   * - 'frontend' (default): a JS/CJS bundle loaded in the browser context.
   * - 'backend': a WASM module executed by the Rust host via wasmtime.
   */
  runtime?: "frontend" | "backend";
}

export interface ExtensionColorTheme {
  id?: string;
  label: string;
  uiTheme: string; // 'vs-dark' | 'vs' | 'hc-black' | 'hc-light'
  path: string; // relative path to JSON file
}

/**
 * A shellIntegration contribution declares a shell that .dir can spawn:
 * how to find its executable and what init script to inject.
 *
 * The `shell` value matches the executable basename (without .exe on Windows),
 * e.g. "bash", "zsh", "fish", "pwsh", "cmd".
 */
export interface ExtensionShellIntegration {
  shell: string;
  /** Display label shown in the shell picker dropdown. */
  label: string;
  /** Relative path to the init script file within the extension directory. */
  scriptPath: string;
  /**
   * Ordered list of filesystem paths to check for the shell executable.
   * Supports $VAR substitution from environment variables.
   * The first existing path wins for each platform.
   */
  executableCandidates: string[];
  /** Optional platform filter. If omitted, applies to all platforms. */
  platforms?: ("darwin" | "linux" | "unix" | "windows")[];
  /** Hidden `cd` line before running a command from the UI; must contain `{{cwd}}`. */
  hiddenCdTemplate?: string;
  cwdEscape?: CwdEscapeMode;
  lineEnding?: "\n" | "\r\n";
  /** Extra argv after the shell executable (e.g. `--noprofile` for bash). */
  spawnArgs?: string[];
  /**
   * When true, the init script is passed as the last CLI argument (after spawnArgs)
   * rather than written to PTY stdin. Use for shells like pwsh that accept `-Command <script>`.
   */
  scriptArg?: boolean;
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
    "explorer/context"?: ExtensionMenu[];
  };
  viewers?: ExtensionViewerContribution[];
  editors?: ExtensionEditorContribution[];
  fsProviders?: ExtensionFsProviderContribution[];
  shellIntegrations?: ExtensionShellIntegration[];
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
  /** Optional absolute path for development; when set, load extension from this dir instead of ~/.dotdir/extensions/<publisher>-<name>-<version>. */
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
  /** FsProvider contributions from this extension */
  fsProviders?: ExtensionFsProviderContribution[];
  /** Shell integration contributions from this extension (fully resolved). */
  shellIntegrations?: Array<{
    shell: string;
    label: string;
    script: string;
    executableCandidates: string[];
    platforms?: ("darwin" | "linux" | "unix" | "windows")[];
    hiddenCdTemplate?: string;
    cwdEscape?: CwdEscapeMode;
    lineEnding?: "\n" | "\r\n";
    spawnArgs?: string[];
    scriptArg?: boolean;
  }>;
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
  latest_version: {
    version: string;
    archive_size: number;
    created_at: string;
  } | null;
}

function extensionDirName(ref: ExtensionRef): string {
  return `${ref.publisher}-${ref.name}-${ref.version}`;
}

async function getExtensionsDir(bridge: Bridge): Promise<string> {
  const homePath = await bridge.utils.getHomePath();
  return join(homePath, ".dotdir", "extensions");
}

async function readRefs(bridge: Bridge): Promise<ExtensionRef[]> {
  const extensionsDir = await getExtensionsDir(bridge);
  try {
    const text = await readFileText(bridge, join(extensionsDir, "extensions.json"));
    const refs = JSON.parse(text);
    return Array.isArray(refs) ? refs : [];
  } catch {
    return [];
  }
}

async function writeRefs(bridge: Bridge, refs: ExtensionRef[]): Promise<void> {
  const extensionsDir = await getExtensionsDir(bridge);
  await bridge.fs.writeFile(join(extensionsDir, "extensions.json"), JSON.stringify(refs, null, 2));
}

export async function loadExtensions(bridge: Bridge): Promise<LoadedExtension[]> {
  const extensionsDir = await getExtensionsDir(bridge);
  const refs = await readRefs(bridge);

  const loaded: LoadedExtension[] = [];
  for (const ref of refs) {
    if (!ref.publisher || !ref.name || !ref.version) continue;
    try {
      const extDir = ref.path ? normalizePath(ref.path) : join(extensionsDir, extensionDirName(ref));
      const manifest: ExtensionManifest = JSON.parse(await readFileText(bridge, join(extDir, "package.json")));

      let iconThemeFssPath: string | undefined;
      let iconThemeBasePath: string | undefined;
      let vscodeIconThemePath: string | undefined;
      let vscodeIconThemeId: string | undefined;

      // Check for FSS-based icon theme (.dir format)
      if (manifest.contributes?.iconTheme?.path) {
        const themePath = join(extDir, manifest.contributes.iconTheme.path);
        // Detect if it's FSS or JSON based on extension
        if (themePath.endsWith(".json")) {
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
            grammarRefs.push({
              contribution: grammarContrib,
              path: grammarPath,
            });
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
          const buf = await readFileBuffer(bridge, iconPath);
          const ext = manifest.icon.split(".").pop()?.toLowerCase() ?? "";
          const mime =
            ext === "svg"
              ? "image/svg+xml"
              : ext === "png"
                ? "image/png"
                : ext === "jpg" || ext === "jpeg"
                  ? "image/jpeg"
                  : ext === "webp"
                    ? "image/webp"
                    : "application/octet-stream";
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

      // Load viewer, editor, and fsProvider contributions
      const viewers = manifest.contributes?.viewers;
      const editors = manifest.contributes?.editors;
      const fsProviders = manifest.contributes?.fsProviders;

      // Load shell integration contributions
      let shellIntegrations: LoadedExtension["shellIntegrations"];
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
        ref,
        manifest,
        dirPath: extDir,
        iconUrl,
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
        fsProviders,
        shellIntegrations,
      });
    } catch {
      continue;
    }
  }

  return loaded;
}

export async function searchMarketplace(query = "", page = 1): Promise<{ extensions: MarketplaceExtension[]; total: number }> {
  const params = new URLSearchParams({ page: String(page), pageSize: "30" });
  if (query) params.set("q", query);
  const res = await fetch(`${MARKETPLACE_URL}/api/extensions/search?${params}`);
  if (!res.ok) throw new Error("Failed to search marketplace");
  return res.json();
}

/**
 * Recursively delete a path using the same engine as permanent delete (no UI).
 */
async function deleteFilesystemPathRecursive(bridge: Bridge, absPath: string): Promise<void> {
  if (!(await bridge.fs.exists(absPath))) return;
  const deleteId = await bridge.fs.delete.start([absPath]);
  await new Promise<void>((resolve, reject) => {
    const unsub = bridge.fs.delete.onProgress((payload: DeleteProgressEvent) => {
      if (payload.deleteId !== deleteId) return;
      const ev = payload.event;
      if (ev.kind === "done") {
        unsub();
        resolve();
      } else if (ev.kind === "error") {
        unsub();
        reject(new Error(ev.message));
      }
    });
  });
}

export async function uninstallExtension(bridge: Bridge, publisherUsername: string, extName: string): Promise<void> {
  const refs = await readRefs(bridge);
  const target = refs.find((r) => r.publisher === publisherUsername && r.name === extName);
  if (target && !target.path) {
    const extensionsDir = await getExtensionsDir(bridge);
    const extDir = join(extensionsDir, extensionDirName(target));
    await deleteFilesystemPathRecursive(bridge, extDir);
  }
  const filtered = refs.filter((r) => !(r.publisher === publisherUsername && r.name === extName));
  await writeRefs(bridge, filtered);
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

export function findColorTheme(exts: LoadedExtension[], key: string): { ext: LoadedExtension; theme: LoadedColorTheme } | null {
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
