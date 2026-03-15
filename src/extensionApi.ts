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
}

export interface EditorProps {
  filePath: string;
  fileName: string;
  langId: string;
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
  writeFile(path: string, content: string): Promise<void>;
  getTheme(): Promise<string>;
  onClose(): void;
  onNavigateMedia?(file: MediaFileRef): void;
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
