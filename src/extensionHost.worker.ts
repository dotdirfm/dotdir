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

interface ExtensionContributions {
  iconTheme?: ExtensionIconTheme;
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

  // Read extensions.json
  let refs: ExtensionRef[];
  try {
    const text = await readTextFile(join(extensionsDir, 'extensions.json'));
    if (text === null) return [];
    const parsed = JSON.parse(text);
    refs = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }

  const loaded: WorkerLoadedExtension[] = [];
  for (const ref of refs) {
    if (!ref.publisher || !ref.name || !ref.version) continue;
    try {
      const extDir = join(extensionsDir, extensionDirName(ref));
      const manifestText = await readTextFile(join(extDir, 'package.json'));
      if (manifestText === null) continue;
      const manifest: ExtensionManifest = JSON.parse(manifestText);

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

      loaded.push({ ref, manifest, dirPath: extDir, iconThemeFss, iconThemeBasePath, languages, grammars });
    } catch {
      continue;
    }
  }

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
