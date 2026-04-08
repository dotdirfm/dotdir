/**
 * Language Registry (host-only)
 *
 * Manages language and grammar metadata from extension contributions.
 * Used for language detection (filename -> langId) when opening files.
 * Syntax highlighting and tokenization are handled inside editor extensions.
 */

import { extensionGrammarRefs, extensionLanguages, type ExtensionLanguage, type LoadedGrammarRef } from "@/features/extensions/types";
import { useLoadedExtensions } from "@/features/extensions/useLoadedExtensions";
import { useMemo } from "react";

export interface LanguageOption {
  id: string;
  label: string;
}

export class LanguageRegistry {
  constructor(
    private extToLang: ReadonlyMap<string, string>,
    private filenameToLang: ReadonlyMap<string, string>,
    readonly options: LanguageOption[],
    readonly languages: ExtensionLanguage[],
    readonly grammarRefs: LoadedGrammarRef[],
  ) {}

  getLanguageForFilename(filename: string): string {
    const byName = this.filenameToLang.get(filename) ?? this.filenameToLang.get(filename.toLowerCase());
    if (byName) return byName;
    const dotIndex = filename.lastIndexOf(".");
    if (dotIndex >= 0) {
      const ext = filename.slice(dotIndex).toLowerCase();
      const byExt = this.extToLang.get(ext);
      if (byExt) return byExt;
    }
    return "plaintext";
  }
}

export function useLanguageRegistry(): LanguageRegistry {
  const loadedExtensions = useLoadedExtensions();

  return useMemo(() => {
    const extToLang = new Map<string, string>();
    const filenameToLang = new Map<string, string>();
    const seen = new Set<string>();
    const options: LanguageOption[] = [];
    const languages: ExtensionLanguage[] = [];
    const grammarRefs: LoadedGrammarRef[] = [];

    for (const extension of loadedExtensions) {
      grammarRefs.push(...extensionGrammarRefs(extension));
      for (const language of extensionLanguages(extension)) {
        languages.push(language);
        if (!seen.has(language.id)) {
          seen.add(language.id);
          options.push({
            id: language.id,
            label: language.aliases?.[0] ?? language.id,
          });
        }
        if (language.extensions) {
          for (const ext of language.extensions) {
            extToLang.set(ext.toLowerCase(), language.id);
          }
        }
        if (language.filenames) {
          for (const filename of language.filenames) {
            filenameToLang.set(filename, language.id);
            filenameToLang.set(filename.toLowerCase(), language.id);
          }
        }
      }
    }

    return new LanguageRegistry(extToLang, filenameToLang, options, languages, grammarRefs);
  }, [loadedExtensions]);
}
