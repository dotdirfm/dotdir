import type { CwdEscapeMode } from "@/features/bridge";

export type ExtensionIconTheme = {
  id: string;
  label: string;
  path: string;
};

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
  args?: unknown;
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
  iconThemes?: ExtensionIconTheme[]; // VS Code format (array)
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

export type ExtensionInstallSource = "dotdir-marketplace" | "open-vsx-marketplace";

export interface ExtensionRef {
  publisher: string;
  name: string;
  version: string;
  source?: ExtensionInstallSource;
  autoUpdate?: boolean;
  /** Optional absolute path for development; when set, load extension from this dir. */
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

export interface LoadedIconTheme {
  id: string;
  label: string;
  kind: "fss" | "vscode";
  path: string; // absolute path to FSS or VS Code JSON file
  basePath?: string; // for FSS relative url() resolution
  sourceId?: string;
}

export type LoadedShellIntegration = Omit<ExtensionShellIntegration, "scriptPath"> & { script: string };

export interface LoadedExtension {
  ref: ExtensionRef;
  manifest: ExtensionManifest;
  dirPath: string;
  /** Icon theme contributions from this extension. */
  iconThemes?: Array<LoadedIconTheme & { fss?: string }>;
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
  shellIntegrations?: Array<LoadedShellIntegration>;
}

export interface MarketplaceExtension {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  namespaceDisplayName?: string;
  description: string;
  downloadCount: number;
  averageRating?: number;
  reviewCount?: number;
  categories?: string[];
  tags?: string[];
  timestamp?: string;
  homepage?: string;
  repository?: string;
  bugs?: string;
  files?: {
    download?: string;
    icon?: string;
    readme?: string;
    changelog?: string;
  };
}

export interface MarketplaceUpdateInfo {
  publisher: string;
  name: string;
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
}
