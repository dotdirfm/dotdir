export interface DotDirSettings {
  iconTheme?: string; // "publisher.name" of the active icon theme
  colorTheme?: string; // "publisher.name:themeId" of the active color theme
  extensions?: {
    autoUpdate?: boolean;
  };
  /**
   * Max file size in bytes to open for editing.
   * Use 0 (or any negative value) to disable the limit.
   */
  editorFileSizeLimit?: number;
  showHidden?: boolean;
  /** Command-line folder aliases: `cd:name` navigates to the absolute path. Set with `cd::name`. */
  pathAliases?: Record<string, string>;
  /**
   * When true, this directory is a workspace root. The LSP subsystem
   * will initialize language servers in dedicated worker threads for
   * any files opened under this directory tree.
   */
  workspace?: boolean;
  /**
   * Per-language LSP server configuration. Keys are language IDs
   * (e.g. "yaml", "typescript", "rust").
   */
  languages?: Record<string, WorkspaceLanguageConfig>;
}

export interface WorkspaceLanguageConfig {
  /** Whether the LSP server for this language is enabled. Defaults to true if the key exists. */
  enabled?: boolean;
  /** Path to the language server executable or bundled JS file. */
  serverPath?: string;
  /** Additional arguments passed to the server process. */
  serverArgs?: string[];
  /** Initialization options sent to the server during the LSP handshake. */
  initializationOptions?: Record<string, unknown>;
  /** Settings forwarded as workspace/configuration to the server. */
  settings?: Record<string, unknown>;
}
