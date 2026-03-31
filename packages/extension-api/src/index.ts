export interface ViewerProps {
  filePath: string;
  fileName: string;
  fileSize: number;
  inline?: boolean;
  extensionScriptBaseUrl?: string;
}

export interface EditorGrammarPayload {
  contribution: {
    language: string;
    scopeName: string;
    path: string;
    embeddedLanguages?: Record<string, string>;
  };
  path?: string;
  content?: object;
}

export interface EditorLanguagePayload {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
}

export interface EditorProps {
  filePath: string;
  fileName: string;
  langId: string;
  extensionDirPath?: string;
  languages?: EditorLanguagePayload[];
  grammars?: EditorGrammarPayload[];
  inline?: boolean;
  extensionScriptBaseUrl?: string;
}

export interface ColorThemeData {
  kind: "dark" | "light";
  colors?: Record<string, string>;
  tokenColors?: unknown[];
}

export type SystemThemeKind = "light" | "dark";
export type ThemePreference = SystemThemeKind | "system";

export interface HostApi {
  readFile(path: string): Promise<ArrayBuffer>;
  readFileText(path: string): Promise<string>;
  readFileRange(path: string, offset: number, length: number): Promise<ArrayBuffer>;
  statFile(path: string): Promise<{ size: number; mtimeMs: number }>;
  onFileChange(callback: () => void): () => void;
  writeFile(path: string, content: string): Promise<void>;
  setDirty?(dirty: boolean): void;
  getTheme(): Promise<SystemThemeKind>;
  getColorTheme(): ColorThemeData | null;
  onThemeChange(callback: (theme: ColorThemeData) => void): () => void;
  onClose(): void;
  executeCommand<T = unknown>(command: string, args?: unknown): Promise<T>;
  getExtensionResourceUrl(relativePath: string): Promise<string>;
}

export interface ViewerExtensionApi {
  mount(root: HTMLElement, props: ViewerProps): Promise<void>;
  unmount(): Promise<void>;
}

export interface EditorExtensionApi {
  mount(root: HTMLElement, props: EditorProps): Promise<void>;
  unmount(): Promise<void>;
  setDirty?(dirty: boolean): void;
  setLanguage?(langId: string): void | Promise<void>;
}

export type EntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "block_device"
  | "char_device"
  | "named_pipe"
  | "socket"
  | "whiteout"
  | "door"
  | "event_port"
  | "unknown";

export interface FsProviderEntry {
  name: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  mode: number;
  nlink: number;
  hidden: boolean;
  /** Populated only when kind === 'symlink'. Omitted when not a symlink. */
  linkTarget?: string;
}

export interface FsProviderHostApi {
  readFile(realPath: string): Promise<ArrayBuffer>;
  readFileRange(realPath: string, offset: number, length: number): Promise<ArrayBuffer>;
}

export interface FsProviderExtensionApi {
  listEntries(containerPath: string, innerPath: string): Promise<FsProviderEntry[]>;
  readFileRange?(containerPath: string, innerPath: string, offset: number, length: number): Promise<ArrayBuffer>;
}

export type DotDirHostReadyCallback = (api: ViewerExtensionApi | EditorExtensionApi) => void;
export type FsProviderFactory = (hostApi: FsProviderHostApi) => FsProviderExtensionApi;

export interface DotDirCommandsApi {
  registerCommand: (commandId: string, handler: (...args: unknown[]) => void | Promise<void>) => { dispose: () => void };
}

export type DotDirGlobalApi = HostApi & {
  commands?: DotDirCommandsApi;
};

declare global {
  interface Window {
    __dotdirHostReady?: DotDirHostReadyCallback;
    __dotdirProviderReady?: FsProviderFactory;
    dotdir?: DotDirGlobalApi;
  }

  var dotdir: DotDirGlobalApi;
}
