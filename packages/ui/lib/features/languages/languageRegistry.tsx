/**
 * Language Registry (host-only)
 *
 * Manages language and grammar metadata from extension contributions.
 * Used for language detection (filename -> langId) when opening files.
 * Syntax highlighting and tokenization are handled inside editor extensions.
 */

import { createContext, createElement, useContext, useRef, type ReactNode } from "react";
import { detectLang as detectLangFallback } from "./langDetect";

export interface LanguageContribution {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
}

export interface GrammarContribution {
  language: string;
  scopeName: string;
  path: string;
  embeddedLanguages?: Record<string, string>;
}

export interface GrammarData {
  contribution: GrammarContribution;
  content: object;
}

export class LanguageRegistry {
  private grammarContents = new Map<string, object>();
  private languageToScope = new Map<string, string>();
  private extToLang = new Map<string, string>();
  private filenameToLang = new Map<string, string>();

  async initialize(): Promise<void> {}

  registerLanguage(lang: LanguageContribution): void {
    if (lang.extensions) {
      for (const ext of lang.extensions) {
        this.extToLang.set(ext.toLowerCase(), lang.id);
      }
    }
    if (lang.filenames) {
      for (const fn of lang.filenames) {
        this.filenameToLang.set(fn, lang.id);
        this.filenameToLang.set(fn.toLowerCase(), lang.id);
      }
    }
  }

  registerGrammar(data: GrammarData): void {
    const { contribution, content } = data;
    this.grammarContents.set(contribution.scopeName, content);
    if (contribution.language) {
      this.languageToScope.set(contribution.language, contribution.scopeName);
    }
  }

  async activateGrammars(): Promise<void> {}

  clear(): void {
    this.grammarContents.clear();
    this.languageToScope.clear();
    this.extToLang.clear();
    this.filenameToLang.clear();
  }

  hasGrammar(langId: string): boolean {
    return this.languageToScope.has(langId);
  }

  detectLanguage(filename: string): string {
    const byName = this.filenameToLang.get(filename) ?? this.filenameToLang.get(filename.toLowerCase());
    if (byName) return byName;
    const dotIndex = filename.lastIndexOf(".");
    if (dotIndex >= 0) {
      const ext = filename.slice(dotIndex).toLowerCase();
      const byExt = this.extToLang.get(ext);
      if (byExt) return byExt;
    }
    return detectLangFallback(filename);
  }

  getLanguageForFilename(filename: string): string {
    return this.detectLanguage(filename) || "plaintext";
  }
}

const LanguageRegistryContext = createContext<LanguageRegistry | null>(null);

export function LanguageRegistryProvider({ children }: { children: ReactNode }) {
  const registryRef = useRef<LanguageRegistry | null>(null);
  if (!registryRef.current) {
    registryRef.current = new LanguageRegistry();
  }
  return createElement(LanguageRegistryContext.Provider, { value: registryRef.current }, children);
}

export function useLanguageRegistry(): LanguageRegistry {
  const value = useContext(LanguageRegistryContext);
  if (!value) {
    throw new Error("useLanguageRegistry must be used within LanguageRegistryProvider");
  }
  return value;
}
