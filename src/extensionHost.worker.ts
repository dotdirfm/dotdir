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

import { dirname, join, normalizePath } from './path';

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

interface ExtensionIconThemeVSCode {
  id: string;
  label: string;
  path: string;
}

interface ExtensionContributions {
  iconTheme?: ExtensionIconTheme;
  iconThemes?: ExtensionIconThemeVSCode[];
  languages?: ExtensionLanguage[];
  grammars?: ExtensionGrammar[];
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

async function loadExtensions(homePath: string): Promise<WorkerLoadedExtension[]> {
  const extensionsDir = join(homePath, '.faraday', 'extensions');
  console.log('[ExtHost] loadExtensions start', { homePath, extensionsDir });

  // Read extensions.json
  let refs: ExtensionRef[];
  try {
    const extensionsJsonPath = join(extensionsDir, 'extensions.json');
    const text = await readTextFile(extensionsJsonPath);
    if (text === null) {
      console.log('[ExtHost] extensions.json read returned null');
      return [];
    }
    const parsed = JSON.parse(text);
    refs = Array.isArray(parsed) ? parsed : [];
    console.log('[ExtHost] extensions.json refs', refs.length, refs.map((r) => `${r.publisher}.${r.name}@${r.version}`));
  } catch (e) {
    console.log('[ExtHost] extensions.json parse failed', e);
    return [];
  }

  const loaded: WorkerLoadedExtension[] = [];
  for (const ref of refs) {
    if (!ref.publisher || !ref.name || !ref.version) continue;
    const extKey = `${ref.publisher}.${ref.name}`;
    try {
      const extDir = join(extensionsDir, extensionDirName(ref));
      const manifestText = await readTextFile(join(extDir, 'package.json'));
      if (manifestText === null) {
        console.log('[ExtHost] package.json null for', extKey, extDir);
        continue;
      }
      const manifest: ExtensionManifest = JSON.parse(manifestText);

      let iconThemeFss: string | undefined;
      let iconThemeBasePath: string | undefined;
      let vscodeIconThemePath: string | undefined;
      let vscodeIconThemeId: string | undefined;

      if (manifest.contributes?.iconTheme?.path) {
        const rawPath = manifest.contributes.iconTheme.path;
        const themePath = join(extDir, normalizePath(rawPath));
        console.log('[ExtHost] iconTheme', extKey, { rawPath, themePath });
        if (themePath.endsWith('.json')) {
          vscodeIconThemePath = themePath;
          vscodeIconThemeId = manifest.contributes.iconTheme.id;
          console.log('[ExtHost] iconTheme (vscode json)', extKey, themePath);
        } else {
          const fssText = await readTextFile(themePath);
          if (fssText !== null) {
            iconThemeFss = fssText;
            iconThemeBasePath = dirname(themePath);
            console.log('[ExtHost] iconTheme (FSS) loaded', extKey, { themePath, iconThemeBasePath, length: fssText.length });
          } else {
            console.log('[ExtHost] iconTheme (FSS) read returned null', extKey, themePath);
          }
        }
      }
      if (manifest.contributes?.iconThemes?.length && !vscodeIconThemePath) {
        const first = manifest.contributes.iconThemes[0];
        vscodeIconThemePath = join(extDir, first.path);
        vscodeIconThemeId = first.id;
        console.log('[ExtHost] iconThemes (vscode)', extKey, vscodeIconThemePath);
      }

      // Load language contributions
      const languages = manifest.contributes?.languages;

      // Load grammar contributions
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

      loaded.push({
        ref,
        manifest,
        dirPath: extDir,
        iconThemeFss,
        iconThemeBasePath,
        vscodeIconThemePath,
        vscodeIconThemeId,
        languages,
        grammars,
      });
    } catch (e) {
      console.log('[ExtHost] load extension failed', extKey, e);
      continue;
    }
  }

  console.log('[ExtHost] loaded', loaded.length, 'extensions; FSS:', loaded.filter((e) => e.iconThemeFss).map((e) => `${e.ref.publisher}.${e.ref.name}`), 'vscode:', loaded.filter((e) => e.vscodeIconThemePath).map((e) => `${e.ref.publisher}.${e.ref.name}`));
  return loaded;
}

// ── Message handler ─────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === 'start') {
    loadExtensions(msg.homePath)
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
