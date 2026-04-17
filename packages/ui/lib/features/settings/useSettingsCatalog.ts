import { useLoadedExtensions } from "@/features/extensions/useLoadedExtensions";
import { buildSettingsCatalog, filterSettingsEntries, type SettingsEntry } from "@/features/settings/catalog";
import { useMemo } from "react";

export function useSettingsCatalog(searchQuery: string): {
  entries: SettingsEntry[];
  allEntries: SettingsEntry[];
  groups: string[];
} {
  const loadedExtensions = useLoadedExtensions();
  const allEntries = useMemo(() => buildSettingsCatalog(loadedExtensions), [loadedExtensions]);
  const entries = useMemo(() => filterSettingsEntries(allEntries, searchQuery), [allEntries, searchQuery]);
  const groups = useMemo(() => {
    const unique = new Set<string>();
    for (const entry of entries) unique.add(entry.category);
    return Array.from(unique);
  }, [entries]);
  return { entries, allEntries, groups };
}

