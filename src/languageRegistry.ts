/**
 * Language Registry (host-only)
 *
 * Manages language and grammar metadata from extension contributions.
 * Used for language detection (filename → langId) when opening files.
 * Syntax highlighting and tokenization are handled inside editor extensions (e.g. Monaco).
 */

import { detectLang as detectLangFallback } from './langDetect';

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

class LanguageRegistry {
  private grammarContents = new Map<string, object>();
  private languageToScope = new Map<string, string>();

  // Extension-based language detection
  private extToLang = new Map<string, string>();
  private filenameToLang = new Map<string, string>();

  /** No-op for compatibility; host does not run Monaco. */
  async initialize(): Promise<void> {}

  /** Register a language contributed by an extension. */
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

  /** Store grammar metadata (for hasGrammar); tokenization is done in editor extensions. */
  registerGrammar(data: GrammarData): void {
    const { contribution, content } = data;
    this.grammarContents.set(contribution.scopeName, content);
    if (contribution.language) {
      this.languageToScope.set(contribution.language, contribution.scopeName);
    }
  }

  /** No-op; tokenization is handled inside editor extensions. */
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
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex >= 0) {
      const ext = filename.slice(dotIndex).toLowerCase();
      const byExt = this.extToLang.get(ext);
      if (byExt) return byExt;
    }
    return detectLangFallback(filename);
  }

  getLanguageForFilename(filename: string): string {
    return this.detectLanguage(filename) || 'plaintext';
  }
}

export const languageRegistry = new LanguageRegistry();
