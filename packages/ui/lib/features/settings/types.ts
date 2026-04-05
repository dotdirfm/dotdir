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
}
