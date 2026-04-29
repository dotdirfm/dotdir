import { pathAutocompleteRecentAtom } from "@/atoms";
import { AutocompleteInput, type AutocompleteGroup } from "@/components/AutocompleteInput/AutocompleteInput";
import { useBridge } from "@dotdirfm/ui-bridge";
import { basename, dirname, join, normalizePath } from "@dotdirfm/ui-utils";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";

type SuggestionRoot = {
  id: string;
  label: string;
  path: string;
};

type EntrySuggestion = {
  path: string;
  kind: "file" | "directory";
};

type PathAutocompleteMode = "directories" | "all";

interface PathAutocompleteInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  roots: SuggestionRoot[];
  mode?: PathAutocompleteMode;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  inputClassName?: string;
}

function stripTrailingSlash(path: string): string {
  if (path === "/") return "/";
  return path.replace(/\/+$/, "");
}

function withTrailingSlash(path: string): string {
  return path === "/" ? "/" : `${stripTrailingSlash(path)}/`;
}

function pathStartsWith(path: string, prefix: string): boolean {
  return path.toLowerCase().startsWith(prefix.toLowerCase());
}

function isAutocompleteEntryKind(kind: string): kind is EntrySuggestion["kind"] {
  return kind === "file" || kind === "directory";
}

export function PathAutocompleteInput({
  id,
  value,
  onChange,
  roots,
  mode = "all",
  inputRef,
  inputClassName,
}: PathAutocompleteInputProps) {
  const bridge = useBridge();
  const recentPaths = useAtomValue(pathAutocompleteRecentAtom);
  const [dirEntries, setDirEntries] = useState<Record<string, EntrySuggestion[]>>({});

  const loadDirectory = useCallback(
    async (dirPath: string) => {
      const normalized = stripTrailingSlash(normalizePath(dirPath));
      if (dirEntries[normalized]) return;
      try {
        const entries = await bridge.fs.entries(normalized);
        const nextEntries = entries
          .filter((entry): entry is typeof entry & { kind: EntrySuggestion["kind"] } => isAutocompleteEntryKind(entry.kind))
          .map((entry) => ({
            path: stripTrailingSlash(join(normalized, entry.name)),
            kind: entry.kind,
          }))
          .sort((a, b) => a.path.localeCompare(b.path));
        setDirEntries((current) => (current[normalized] ? current : { ...current, [normalized]: nextEntries }));
      } catch {
        setDirEntries((current) => (current[normalized] ? current : { ...current, [normalized]: [] }));
      }
    },
    [bridge, dirEntries],
  );

  useEffect(() => {
    roots.forEach((root) => {
      void loadDirectory(root.path);
    });
  }, [loadDirectory, roots]);

  const rawValue = value.trim();
  const normalizedValue = rawValue ? stripTrailingSlash(normalizePath(rawValue)) : "";
  const activeBaseDir = useMemo(() => {
    if (!rawValue) return null;
    if (rawValue.endsWith("/")) return normalizedValue || "/";
    if (normalizedValue && dirEntries[normalizedValue]) return normalizedValue;
    if (!normalizedValue) return null;
    return dirname(normalizedValue);
  }, [dirEntries, normalizedValue, rawValue]);

  const leafPrefix = useMemo(() => {
    if (!rawValue || rawValue.endsWith("/")) return "";
    if (normalizedValue && dirEntries[normalizedValue]) return "";
    if (!normalizedValue) return "";
    return basename(normalizedValue);
  }, [dirEntries, normalizedValue, rawValue]);

  useEffect(() => {
    if (!activeBaseDir) return;
    void loadDirectory(activeBaseDir);
  }, [activeBaseDir, loadDirectory]);

  const groups = useMemo<AutocompleteGroup[]>(() => {
    if (!rawValue || rawValue.endsWith("/")) return [];

    const seen = new Set<string>();
    const currentPrefix = rawValue.toLowerCase();
    const prefixForChildren = leafPrefix.toLowerCase();
    const includeEntry = (entry: EntrySuggestion) => mode === "all" || entry.kind === "directory";
    const toOption = (id: string, entry: EntrySuggestion) => ({
      id,
      value: entry.kind === "directory" ? withTrailingSlash(entry.path) : entry.path,
      label: basename(stripTrailingSlash(entry.path)),
      key: stripTrailingSlash(entry.path),
    });

    const options = [
      ...recentPaths
        .filter((path) => pathStartsWith(path, rawValue))
        .map((path) => ({
          id: `recent:${path}`,
          value: withTrailingSlash(path),
          label: basename(stripTrailingSlash(path)),
          key: stripTrailingSlash(path),
        })),
      ...(activeBaseDir
        ? (dirEntries[activeBaseDir] ?? [])
            .filter((entry) => {
              if (!includeEntry(entry)) return false;
              if (!prefixForChildren) return true;
              return basename(entry.path).toLowerCase().startsWith(prefixForChildren);
            })
            .map((entry) => toOption(`base:${entry.kind}:${entry.path}`, entry))
        : []),
      ...roots.flatMap((root) =>
        [
          { path: stripTrailingSlash(root.path), kind: "directory" as const },
          ...(dirEntries[stripTrailingSlash(root.path)] ?? []),
        ]
          .filter((entry) => {
            if (!includeEntry(entry)) return false;
            if (!currentPrefix) return true;
            return pathStartsWith(entry.path, rawValue);
          })
          .map((entry) => toOption(`${root.id}:${entry.kind}:${entry.path}`, entry)),
      ),
    ].filter((option) => {
      if (seen.has(option.key)) return false;
      seen.add(option.key);
      return true;
    });

    return options.length
      ? [
          {
            id: "paths",
            label: "",
            options: options.map(({ id, value, label }) => ({
              id,
              value,
              label,
            })),
          },
        ]
      : [];
  }, [activeBaseDir, dirEntries, leafPrefix, mode, rawValue, recentPaths, roots]);

  return (
    <AutocompleteInput
      id={id}
      value={value}
      onChange={onChange}
      groups={groups}
      inputRef={inputRef}
      inputClassName={inputClassName}
      keepOpenOnSelect
    />
  );
}
