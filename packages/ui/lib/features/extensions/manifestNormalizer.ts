import { dirname, join, normalizePath } from "@/utils/path";
import type {
  ExtensionManifest,
  ExtensionRef,
  LoadedExtension,
  LoadedGrammarRef,
  LoadedIconTheme,
  LoadedShellIntegration,
} from "./types";

export type ExtensionManifestReadFile = (path: string) => Promise<string | null>;

export interface NormalizeExtensionOptions {
  extDir: string;
  ref?: ExtensionRef;
  readTextFile: ExtensionManifestReadFile;
  locale?: string;
  trustTier?: LoadedExtension["trustTier"];
}

type NlsBundle = Record<string, string>;

export function extensionDirName(ref: ExtensionRef): string {
  return `${ref.publisher}-${ref.name}-${ref.version}`;
}

function localeCandidates(locale: string): string[] {
  const normalized = locale.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return [];
  const parts = normalized.split("-");
  const candidates: string[] = [];
  for (let i = parts.length; i > 0; i--) {
    candidates.push(parts.slice(0, i).join("-"));
  }
  return candidates;
}

async function readNlsBundle(readTextFile: ExtensionManifestReadFile, path: string): Promise<NlsBundle | null> {
  const text = await readTextFile(path);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: NlsBundle = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

async function loadManifestNlsBundle(readTextFile: ExtensionManifestReadFile, extDir: string, locale: string): Promise<NlsBundle> {
  const merged: NlsBundle = {};

  const base = await readNlsBundle(readTextFile, join(extDir, "package.nls.json"));
  if (base) Object.assign(merged, base);

  for (const candidate of localeCandidates(locale)) {
    const localized = await readNlsBundle(readTextFile, join(extDir, `package.nls.${candidate}.json`));
    if (localized) {
      Object.assign(merged, localized);
      break;
    }
  }

  return merged;
}

function localizeManifestValue(value: unknown, bundle: NlsBundle): unknown {
  if (typeof value === "string") {
    const match = value.match(/^%([^%]+)%$/);
    if (!match) return value;
    const key = match[1] ?? "";
    return bundle[key] ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => localizeManifestValue(item, bundle));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = localizeManifestValue(child, bundle);
    }
    return out;
  }
  return value;
}

function normalizeRelativePath(path: string): string {
  return normalizePath(path).replace(/^\/+/, "");
}

function resolveActivationEntry(manifest: ExtensionManifest, extDir: string): LoadedExtension["runtime"]["activationEntry"] {
  const isModule = String(manifest.type ?? "").trim().toLowerCase() === "module";
  const format = isModule ? "esm" : "cjs";
  if (manifest.browser) {
    return {
      path: join(extDir, normalizeRelativePath(manifest.browser)),
      format,
      sourceField: "browser",
    };
  }
  if (manifest.main) {
    return {
      path: join(extDir, normalizeRelativePath(manifest.main)),
      format,
      sourceField: "main",
    };
  }
  return undefined;
}

function buildIconThemes(manifest: ExtensionManifest, extDir: string): Array<LoadedIconTheme & { fss?: string }> | undefined {
  const iconThemes: Array<LoadedIconTheme & { fss?: string }> = [];
  if (manifest.contributes?.iconTheme?.path) {
    const theme = manifest.contributes.iconTheme;
    const themePath = join(extDir, theme.path);
    if (themePath.endsWith(".json")) {
      iconThemes.push({
        id: theme.id || "default",
        label: theme.label || manifest.displayName || manifest.name,
        kind: "vscode",
        path: themePath,
        sourceId: theme.id,
      });
    } else {
      iconThemes.push({
        id: theme.id || "default",
        label: theme.label || manifest.displayName || manifest.name,
        kind: "fss",
        path: themePath,
        basePath: dirname(themePath),
        sourceId: theme.id,
      });
    }
  }

  if (manifest.contributes?.iconThemes?.length) {
    iconThemes.push(
      ...manifest.contributes.iconThemes.map((theme, index) => {
        const themePath = join(extDir, theme.path);
        return {
          id: theme.id || `${theme.label}#${index}`,
          label: theme.label,
          kind: themePath.endsWith(".json") ? ("vscode" as const) : ("fss" as const),
          path: themePath,
          basePath: themePath.endsWith(".json") ? undefined : dirname(themePath),
          sourceId: theme.id,
        };
      }),
    );
  }

  return iconThemes.length > 0 ? iconThemes : undefined;
}

async function buildShellIntegrations(
  manifest: ExtensionManifest,
  extDir: string,
  readTextFile: ExtensionManifestReadFile,
): Promise<LoadedShellIntegration[] | undefined> {
  if (!manifest.contributes?.shellIntegrations?.length) return undefined;

  const shellIntegrations: LoadedShellIntegration[] = [];
  for (const si of manifest.contributes.shellIntegrations) {
    const script = await readTextFile(join(extDir, si.scriptPath));
    if (script === null) continue;
    shellIntegrations.push({
      shell: si.shell,
      label: si.label,
      script,
      executableCandidates: si.executableCandidates ?? [],
      platforms: si.platforms,
      hiddenCdTemplate: si.hiddenCdTemplate,
      cwdEscape: si.cwdEscape,
      lineEnding: si.lineEnding,
      spawnArgs: si.spawnArgs,
      scriptArg: si.scriptArg,
    });
  }

  return shellIntegrations.length > 0 ? shellIntegrations : undefined;
}

export async function normalizeExtensionManifest({
  extDir,
  ref: inputRef,
  readTextFile,
  locale = "en",
  trustTier = "worker",
}: NormalizeExtensionOptions): Promise<LoadedExtension | null> {
  const manifestText = await readTextFile(join(extDir, "package.json"));
  if (manifestText === null) return null;

  const rawManifest = JSON.parse(manifestText) as ExtensionManifest;
  const nlsBundle = await loadManifestNlsBundle(readTextFile, extDir, locale);
  const manifest = localizeManifestValue(rawManifest, nlsBundle) as ExtensionManifest;

  const ref: ExtensionRef = {
    publisher: inputRef?.publisher ?? manifest.publisher ?? "unknown",
    name: inputRef?.name ?? manifest.name ?? "unknown",
    version: inputRef?.version ?? manifest.version ?? "0.0.0",
    source: inputRef?.source,
    autoUpdate: inputRef?.autoUpdate,
    path: inputRef?.path ? normalizePath(inputRef.path) : undefined,
  };

  const grammarRefs: LoadedGrammarRef[] | undefined = manifest.contributes?.grammars?.length
    ? manifest.contributes.grammars.map((contribution) => ({
        contribution,
        path: join(extDir, contribution.path),
      }))
    : undefined;

  const colorThemes = manifest.contributes?.themes?.map((theme, index) => ({
    id: theme.id || `${theme.label}#${index}`,
    label: theme.label,
    uiTheme: theme.uiTheme,
    jsonPath: join(extDir, theme.path),
  }));

  const activationEntry = resolveActivationEntry(manifest, extDir);

  return {
    identity: {
      ref,
      manifest,
    },
    location: {
      dirPath: extDir,
    },
    assets: {
      iconThemes: buildIconThemes(manifest, extDir),
      colorThemes,
    },
    contributions: {
      languages: manifest.contributes?.languages,
      grammarRefs,
      commands: manifest.contributes?.commands,
      keybindings: manifest.contributes?.keybindings,
      viewers: manifest.contributes?.viewers,
      editors: manifest.contributes?.editors,
      fsProviders: manifest.contributes?.fsProviders,
      shellIntegrations: await buildShellIntegrations(manifest, extDir, readTextFile),
    },
    compatibility: activationEntry
      ? { activation: "supported" }
      : { activation: "unsupported", reason: "No browser or main activation entry declared." },
    runtime: {
      activationEntry,
    },
    trustTier,
  };
}
