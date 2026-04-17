import { extensionManifest, extensionRef, type ExtensionConfigurationContribution, type ExtensionConfigurationPropertySchema, type LoadedExtension } from "@/features/extensions/types";
import type { DotDirSettings } from "@/features/settings/types";

export type SettingsValueType = "boolean" | "number" | "string" | "enum" | "object" | "array";
export type SettingsSource = "dotdir" | "extension";

export interface SettingsEntry {
  key: string;
  title: string;
  description?: string;
  source: SettingsSource;
  sourceLabel: string;
  category: string;
  valueType: SettingsValueType;
  enumValues?: unknown[];
  enumDescriptions?: string[];
  defaultValue: unknown;
  order: number;
  minimum?: number;
  maximum?: number;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function keyLabel(key: string): string {
  const tail = key.split(".").pop() ?? key;
  return tail
    .replace(/[-_]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function inferValueType(schema: ExtensionConfigurationPropertySchema): SettingsValueType | null {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return "enum";
  const declared = schema.type;
  const first = Array.isArray(declared) ? declared[0] : declared;
  if (first === "boolean" || first === "number" || first === "string" || first === "object" || first === "array") {
    return first;
  }
  if (Array.isArray(schema.default)) return "array";
  if (schema.default && typeof schema.default === "object") return "object";
  if (typeof schema.default === "boolean") return "boolean";
  if (typeof schema.default === "number") return "number";
  if (typeof schema.default === "string") return "string";
  return null;
}

function dotdirEntries(): SettingsEntry[] {
  const entries: SettingsEntry[] = [
    {
      key: "showHidden",
      title: "Show Hidden Files",
      description: "Show hidden files and directories in panel file lists.",
      source: "dotdir",
      sourceLabel: "dotdir",
      category: "General",
      valueType: "boolean",
      defaultValue: false,
      order: 0,
    },
    {
      key: "editorFileSizeLimit",
      title: "Editor File Size Limit",
      description: "Maximum file size in bytes for opening a file in the editor. Set 0 to disable the limit.",
      source: "dotdir",
      sourceLabel: "dotdir",
      category: "Editor",
      valueType: "number",
      defaultValue: 0,
      minimum: 0,
      order: 1,
    },
    {
      key: "colorTheme",
      title: "Color Theme",
      description: "Active color theme id.",
      source: "dotdir",
      sourceLabel: "dotdir",
      category: "Appearance",
      valueType: "string",
      defaultValue: "",
      order: 2,
    },
    {
      key: "iconTheme",
      title: "Icon Theme",
      description: "Active icon theme id.",
      source: "dotdir",
      sourceLabel: "dotdir",
      category: "Appearance",
      valueType: "string",
      defaultValue: "",
      order: 3,
    },
    {
      key: "extensions.autoUpdate",
      title: "Extensions Auto Update",
      description: "Automatically install updates for extensions when available.",
      source: "dotdir",
      sourceLabel: "dotdir",
      category: "Extensions",
      valueType: "boolean",
      defaultValue: true,
      order: 4,
    },
    {
      key: "pathAliases",
      title: "Path Aliases",
      description: "Command-line aliases map used by cd:name shortcuts.",
      source: "dotdir",
      sourceLabel: "dotdir",
      category: "Command Line",
      valueType: "object",
      defaultValue: {},
      order: 5,
    },
  ];
  return entries;
}

function extensionEntries(extensions: LoadedExtension[]): SettingsEntry[] {
  const out: SettingsEntry[] = [];
  for (const ext of extensions) {
    const manifest = extensionManifest(ext);
    const extId = `${extensionRef(ext).publisher}.${extensionRef(ext).name}`;
    const sourceLabel = extId;
    const configs = toArray<ExtensionConfigurationContribution>(manifest.contributes?.configuration);
    for (const cfg of configs) {
      const category = cfg.title || manifest.displayName || manifest.name || extId;
      const props = cfg.properties ?? {};
      for (const [key, schema] of Object.entries(props)) {
        const valueType = inferValueType(schema);
        if (!valueType) continue;
        out.push({
          key,
          title: keyLabel(key),
          description: schema.markdownDescription || schema.description,
          source: "extension",
          sourceLabel,
          category,
          valueType,
          enumValues: Array.isArray(schema.enum) ? schema.enum : undefined,
          enumDescriptions: schema.markdownEnumDescriptions || schema.enumDescriptions,
          defaultValue: schema.default,
          order: typeof schema.order === "number" ? schema.order : Number.MAX_SAFE_INTEGER,
          minimum: typeof schema.minimum === "number" ? schema.minimum : undefined,
          maximum: typeof schema.maximum === "number" ? schema.maximum : undefined,
        });
      }
    }
  }
  out.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if (a.order !== b.order) return a.order - b.order;
    return a.key.localeCompare(b.key);
  });
  return out;
}

function getDotdirSettingValue(settings: DotDirSettings, key: string): unknown {
  if (!key.includes(".")) return (settings as Record<string, unknown>)[key];
  const parts = key.split(".");
  let current: unknown = settings;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function filterSettingsEntries(entries: SettingsEntry[], query: string): SettingsEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((entry) => {
    const haystack = `${entry.key}\n${entry.title}\n${entry.description ?? ""}\n${entry.sourceLabel}\n${entry.category}`.toLowerCase();
    return haystack.includes(q);
  });
}

export function buildSettingsCatalog(extensions: LoadedExtension[]): SettingsEntry[] {
  return [...dotdirEntries(), ...extensionEntries(extensions)];
}

export function dotdirEffectiveValue(settings: DotDirSettings, entry: SettingsEntry): unknown {
  const userValue = getDotdirSettingValue(settings, entry.key);
  return userValue === undefined ? entry.defaultValue : userValue;
}

