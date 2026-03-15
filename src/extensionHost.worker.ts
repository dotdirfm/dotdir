/**
 * Extension Host Worker
 *
 * Runs in a Web Worker to isolate extension loading from the main thread.
 * Can be safely terminated and restarted to pick up extension changes.
 *
 * Communication protocol with main thread:
 *   Main → Worker:
 *     { type: 'start', homePath: string }           — begin loading extensions
 *     { type: 'readFileResult', id, data, error? }   — response to a file read request
 *   Worker → Main:
 *     { type: 'readFile', id, path }                 — request file contents
 *     { type: 'loaded', extensions }                 — all extensions loaded
 *     { type: 'error', message }                     — fatal loading error
 */

import { dirname, join } from './path';

// ── Types (duplicated subset to avoid importing DOM-dependent modules) ──

interface ExtensionIconTheme {
  id: string;
  label: string;
  path: string;
}

interface ExtensionLanguage {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
  configuration?: string;
}

interface ExtensionGrammar {
  language: string;
  scopeName: string;
  path: string;
  embeddedLanguages?: Record<string, string>;
}

interface LoadedGrammar {
  contribution: ExtensionGrammar;
  content: object;
}

interface ExtensionViewerContribution {
  id: string;
  label: string;
  patterns: string[];
  mimeTypes?: string[];
  entry: string;
  priority?: number;
}

interface ExtensionEditorContribution {
  id: string;
  label: string;
  patterns: string[];
  mimeTypes?: string[];
  langId?: string;
  entry: string;
  priority?: number;
}

interface ExtensionContributions {
  iconTheme?: ExtensionIconTheme;
  languages?: ExtensionLanguage[];
  grammars?: ExtensionGrammar[];
  viewers?: ExtensionViewerContribution[];
  editors?: ExtensionEditorContribution[];
}

interface ExtensionManifest {
  name: string;
  version: string;
  publisher: string;
  displayName?: string;
  description?: string;
  contributes?: ExtensionContributions;
}

interface ExtensionRef {
  publisher: string;
  name: string;
  version: string;
}

export interface WorkerLoadedExtension {
  ref: ExtensionRef;
  manifest: ExtensionManifest;
  dirPath: string;
  iconThemeFss?: string;
  iconThemeBasePath?: string;
  vscodeIconThemePath?: string;
  vscodeIconThemeId?: string;
  languages?: ExtensionLanguage[];
  grammars?: LoadedGrammar[];
  viewers?: ExtensionViewerContribution[];
  editors?: ExtensionEditorContribution[];
}

// ── File reading via RPC to main thread ─────────────────────────────

let nextRequestId = 0;
const pendingReads = new Map<number, { resolve: (data: string | null) => void; reject: (err: Error) => void }>();

function readTextFile(path: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pendingReads.set(id, { resolve, reject });
    self.postMessage({ type: 'readFile', id, path });
  });
}

// ── Extension loading logic ─────────────────────────────────────────

function extensionDirName(ref: ExtensionRef): string {
  return `${ref.publisher}-${ref.name}-${ref.version}`;
}

async function loadExtensionFromDir(extDir: string): Promise<WorkerLoadedExtension | null> {
  try {
    const manifestText = await readTextFile(join(extDir, 'package.json'));
    if (manifestText === null) return null;
    const manifest: ExtensionManifest = JSON.parse(manifestText);

    const ref: ExtensionRef = {
      publisher: manifest.publisher || 'unknown',
      name: manifest.name || 'unknown',
      version: manifest.version || '0.0.0',
    };

    let iconThemeFss: string | undefined;
    let iconThemeBasePath: string | undefined;
    if (manifest.contributes?.iconTheme?.path) {
      const fssPath = join(extDir, manifest.contributes.iconTheme.path);
      const fssText = await readTextFile(fssPath);
      if (fssText !== null) {
        iconThemeFss = fssText;
        iconThemeBasePath = dirname(fssPath);
      }
    }

    const languages = manifest.contributes?.languages;

    let grammars: LoadedGrammar[] | undefined;
    if (manifest.contributes?.grammars?.length) {
      grammars = [];
      for (const grammarContrib of manifest.contributes.grammars) {
        try {
          const grammarPath = join(extDir, grammarContrib.path);
          const grammarText = await readTextFile(grammarPath);
          if (grammarText !== null) {
            const grammarContent = JSON.parse(grammarText);
            grammars.push({ contribution: grammarContrib, content: grammarContent });
          }
        } catch {
          // Skip grammars that fail to load
        }
      }
    }

    const viewers = manifest.contributes?.viewers;
    const editors = manifest.contributes?.editors;

    return { ref, manifest, dirPath: extDir, iconThemeFss, iconThemeBasePath, languages, grammars, viewers, editors };
  } catch {
    return null;
  }
}

async function loadExtensions(homePath: string, builtInDirs: string[]): Promise<WorkerLoadedExtension[]> {
  const loaded: WorkerLoadedExtension[] = [];

  // 1. Load built-in extensions from provided dirs
  for (const dir of builtInDirs) {
    const ext = await loadExtensionFromDir(dir);
    if (ext) loaded.push(ext);
  }

  // 2. Load user extensions from ~/.faraday/extensions/
  const extensionsDir = join(homePath, '.faraday', 'extensions');
  let refs: ExtensionRef[];
  try {
    const text = await readTextFile(join(extensionsDir, 'extensions.json'));
    if (text === null) return loaded;
    const parsed = JSON.parse(text);
    refs = Array.isArray(parsed) ? parsed : [];
  } catch {
    return loaded;
  }

  for (const ref of refs) {
    if (!ref.publisher || !ref.name || !ref.version) continue;
    const extDir = join(extensionsDir, extensionDirName(ref));
    const ext = await loadExtensionFromDir(extDir);
    if (ext) loaded.push(ext);
  }

  console.log('[ExtHost] loaded', loaded.length, 'extensions; FSS:', loaded.filter((e) => e.iconThemeFss).map((e) => `${e.ref.publisher}.${e.ref.name}`), 'vscode:', loaded.filter((e) => e.vscodeIconThemePath).map((e) => `${e.ref.publisher}.${e.ref.name}`));
  return loaded;
}

// ── Message handler ─────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === 'start') {
    loadExtensions(msg.homePath, msg.builtInDirs || [])
      .then((extensions) => {
        self.postMessage({ type: 'loaded', extensions });
      })
      .catch((err: unknown) => {
        self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      });
  } else if (msg.type === 'readFileResult') {
    const pending = pendingReads.get(msg.id);
    if (pending) {
      pendingReads.delete(msg.id);
      if (msg.error) {
        pending.resolve(null);
      } else {
        pending.resolve(msg.data);
      }
    }
  }
};
