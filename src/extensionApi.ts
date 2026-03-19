/**
 * Shared types for the host ↔ extension iframe communication (postMessage RPC).
 *
 * Host exposes HostApi to the iframe.
 * Viewer extensions expose ViewerExtensionApi; editor extensions expose EditorExtensionApi.
 */

// ── Host → Extension props ───────────────────────────────────────────

export interface ViewerProps {
  filePath: string;
  fileName: string;
  fileSize: number;
  inline?: boolean;
  /** When set (e.g. Web VFS), extension can load scripts/workers from this base URL. */
  extensionScriptBaseUrl?: string;
}

/** Grammar contribution + loaded content (from host, for custom syntax highlighting). */
export interface EditorGrammarPayload {
  contribution: { language: string; scopeName: string; path: string; embeddedLanguages?: Record<string, string> };
  /** Absolute path to grammar JSON file (used for lazy loading). */
  path?: string;
  /** Parsed TextMate grammar JSON (optional; host may lazy-load and fill it). */
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
  /** Extension root path (for reading package.json / grammars). */
  extensionDirPath?: string;
  /** All languages from loaded extensions (for Monaco registration). */
  languages?: EditorLanguagePayload[];
  /** All grammars with content from loaded extensions (for TextMate tokenization). */
  grammars?: EditorGrammarPayload[];
  /** True when shown inline (e.g. preview tab). Extensions should not steal focus when inline. */
  inline?: boolean;
  /** When set (e.g. Web VFS), extension can load scripts/workers from this base URL for lazy loading. */
  extensionScriptBaseUrl?: string;
}

// ── Host API (host exposes to iframe) ────────────────────────────────

export interface ColorThemeData {
  /** Theme kind: 'dark' or 'light'. */
  kind: 'dark' | 'light';
  /** VS Code color theme colors (e.g. 'editor.background' → '#1e1e2e'). Undefined when no VS Code theme active. */
  colors?: Record<string, string>;
  /** VS Code tokenColors for syntax highlighting. Undefined when no VS Code theme active. */
  tokenColors?: unknown[];
}

export interface HostApi {
  readFile(path: string): Promise<ArrayBuffer>;
  readFileText(path: string): Promise<string>;
  /** Read a byte range (for chunked viewing). */
  readFileRange?(path: string, offset: number, length: number): Promise<ArrayBuffer>;
  /** Lightweight stat for the currently viewed file. */
  statFile?(path: string): Promise<{ size: number; mtimeMs: number }>;
  /** Subscribe to external changes of the currently viewed file. */
  onFileChange?(callback: () => void): () => void;
  writeFile(path: string, content: string): Promise<void>;
  getTheme(): Promise<string>;
  /** Get the active color theme data (colors + tokenColors). Returns null if no VS Code theme is active. */
  getColorTheme?(): ColorThemeData | null;
  /** Subscribe to theme changes. Callback fires when the color theme changes. Returns unsubscribe function. */
  onThemeChange?(callback: (theme: ColorThemeData) => void): () => void;
  onClose(): void;
  /** Execute a host command (e.g. navigatePrev, navigateNext, getFileIndex). */
  executeCommand?<T = unknown>(command: string, args?: unknown): Promise<T>;

  /**
   * Commands API exposed to extensions running inside the iframe.
   * Implemented to mimic VS Code: `registerCommand(id, callback) -> Disposable`.
   */
  registerCommand?(
    commandId: string,
    handler: (...args: unknown[]) => void | Promise<void>,
    options?: { title?: string; category?: string; icon?: string; when?: string }
  ): () => void;

  /** Contribute a keybinding (extension layer). */
  registerKeybinding?(
    binding: { command: string; key: string; mac?: string; when?: string }
  ): () => void;

  /** Oniguruma WASM binary for TextMate grammars (optional). */
  getOnigurumaWasm?(): Promise<ArrayBuffer>;
  /** URL to a file inside the extension dir (for lazy-loading workers). Returns blob URL. */
  getExtensionResourceUrl?(relativePath: string): Promise<string>;
}

// ── Extension APIs (extension exposes to host via __faradayHostReady) ─

export interface ViewerExtensionApi {
  /** Render viewer UI into the provided root. */
  mount(root: HTMLElement, hostApi: HostApi, props: ViewerProps): Promise<void>;
  unmount(): Promise<void>;
}

export interface EditorExtensionApi {
  /** Render editor UI into the provided root. */
  mount(root: HTMLElement, hostApi: HostApi, props: EditorProps): Promise<void>;
  unmount(): Promise<void>;
  setDirty?(dirty: boolean): void;
  /** Change the editor language (e.g. for syntax highlighting). */
  setLanguage?(langId: string): void | Promise<void>;
}

/** Extension calls this when loaded; host sets it before injecting the script. */
export type FaradayHostReadyCallback = (api: ViewerExtensionApi | EditorExtensionApi) => void;

declare global {
  interface Window {
    __faradayHostReady?: FaradayHostReadyCallback;
    /**
     * Host API exposed to isolated extensions (iframe) as a global.
     * Extensions can call `window.frdy.readFile(...)`, etc.
     *
     * We'll later publish these typings via an npm package (`frdy`).
     */
    frdy?: HostApi & {
      commands?: {
        registerCommand: (
          commandId: string,
          handler: (...args: unknown[]) => void | Promise<void>,
          options?: { title?: string; category?: string; icon?: string; when?: string }
        ) => { dispose: () => void };
        registerKeybinding: (
          binding: { command: string; key: string; mac?: string; when?: string }
        ) => { dispose: () => void };
      };
    };
  }
}
