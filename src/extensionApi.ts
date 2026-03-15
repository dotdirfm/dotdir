/**
 * Shared types for the host ↔ extension iframe communication via Comlink.
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
  mediaFiles?: MediaFileRef[];
  /** When set (e.g. Web VFS), extension can load scripts/workers from this base URL. */
  extensionScriptBaseUrl?: string;
}

/** Grammar contribution + loaded content (from host, for custom syntax highlighting). */
export interface EditorGrammarPayload {
  contribution: { language: string; scopeName: string; path: string; embeddedLanguages?: Record<string, string> };
  content: object;
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

export interface MediaFileRef {
  path: string;
  name: string;
  size: number;
}

// ── Host API (host exposes to iframe) ────────────────────────────────

export interface HostApi {
  readFile(path: string): Promise<ArrayBuffer>;
  readFileText(path: string): Promise<string>;
  /** Read a byte range (for chunked viewing). */
  readFileRange?(path: string, offset: number, length: number): Promise<ArrayBuffer>;
  writeFile(path: string, content: string): Promise<void>;
  getTheme(): Promise<string>;
  onClose(): void;
  onNavigateMedia?(file: MediaFileRef): void;
  /** Oniguruma WASM binary for TextMate grammars (optional). */
  getOnigurumaWasm?(): Promise<ArrayBuffer>;
  /** URL to a file inside the extension dir (for lazy-loading workers). Returns blob URL. */
  getExtensionResourceUrl?(relativePath: string): Promise<string>;
}

// ── Extension APIs (iframe exposes to host) ──────────────────────────

export interface ViewerExtensionApi {
  mount(props: ViewerProps): Promise<void>;
  unmount(): Promise<void>;
}

export interface EditorExtensionApi {
  mount(props: EditorProps): Promise<void>;
  unmount(): Promise<void>;
  setDirty?(dirty: boolean): void;
  /** Change the editor language (e.g. for syntax highlighting). */
  setLanguage?(langId: string): void | Promise<void>;
}

// ── Handshake message types ──────────────────────────────────────────

export interface FaradayInitMessage {
  type: 'faraday-init';
  port: MessagePort;
}

export interface FaradayReadyMessage {
  type: 'faraday-ready';
  port: MessagePort;
}
