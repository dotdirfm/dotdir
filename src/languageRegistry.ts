/**
 * Language Registry
 *
 * Manages language and grammar registration with Monaco editor.
 * Extensions contribute languages (file associations) and grammars
 * (TextMate tokenization) through their package.json contribution points.
 *
 * Without any extensions installed, the editor has no syntax highlighting.
 */

import * as monaco from 'monaco-editor';
import { Registry as TMRegistry, INITIAL, type IGrammar, type StateStack } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';

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

// ── TextMate state wrapper for Monaco ────────────────────────────────

class TMState implements monaco.languages.IState {
  constructor(private _ruleStack: StateStack) {}
  get ruleStack() { return this._ruleStack; }
  clone() { return new TMState(this._ruleStack); }
  equals(other: monaco.languages.IState) {
    return other instanceof TMState && other._ruleStack === this._ruleStack;
  }
}

// ── Language Registry ────────────────────────────────────────────────

class LanguageRegistry {
  private registeredLanguages = new Set<string>();
  private grammarContents = new Map<string, object>(); // scopeName → raw grammar JSON
  private languageToScope = new Map<string, string>();  // langId → scopeName
  private tmRegistry: TMRegistry | null = null;
  private onigurumaLoaded = false;
  private initPromise: Promise<void> | null = null;

  /** Initialize the oniguruma WASM engine. Call once at app startup. */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    if (this.onigurumaLoaded) return;

    const wasmUrl = new URL('vscode-oniguruma/release/onig.wasm', import.meta.url);
    const response = await fetch(wasmUrl);
    const wasmBin = await response.arrayBuffer();
    await loadWASM(wasmBin);
    this.onigurumaLoaded = true;

    this.tmRegistry = new TMRegistry({
      onigLib: Promise.resolve({
        createOnigScanner: (patterns: string[]) => createOnigScanner(patterns),
        createOnigString: (s: string) => createOnigString(s),
      }),
      loadGrammar: async (scopeName: string) => {
        const content = this.grammarContents.get(scopeName);
        if (!content) return null;
        return content as never;
      },
    });
  }

  /** Register a language contributed by an extension. */
  registerLanguage(lang: LanguageContribution): void {
    if (this.registeredLanguages.has(lang.id)) return;
    this.registeredLanguages.add(lang.id);

    monaco.languages.register({
      id: lang.id,
      extensions: lang.extensions,
      aliases: lang.aliases,
      filenames: lang.filenames,
    });
  }

  /** Register a TextMate grammar contributed by an extension. */
  async registerGrammar(data: GrammarData): Promise<void> {
    const { contribution, content } = data;
    this.grammarContents.set(contribution.scopeName, content);
    this.languageToScope.set(contribution.language, contribution.scopeName);

    // Ensure the language is registered
    if (!this.registeredLanguages.has(contribution.language)) {
      this.registerLanguage({ id: contribution.language });
    }

    // Wait for oniguruma to be ready before setting up tokenization
    await this.initialize();
    await this.setupTokenization(contribution.language, contribution.scopeName);
  }

  /** Clear all registrations. Called before re-loading extensions. */
  clear(): void {
    this.grammarContents.clear();
    this.languageToScope.clear();
    // Note: Monaco doesn't support un-registering languages, so registeredLanguages
    // is kept to avoid double-registration. Tokenization providers will be overwritten.
  }

  /** Check if a grammar is registered for a language. */
  hasGrammar(langId: string): boolean {
    return this.languageToScope.has(langId);
  }

  /** Get the Monaco language ID for a filename, or 'plaintext' if none matched. */
  getLanguageForFilename(filename: string): string {
    // Monaco's built-in language detection using registered extensions/filenames
    const languages = monaco.languages.getLanguages();
    for (const lang of languages) {
      if (lang.filenames) {
        for (const fn of lang.filenames) {
          if (filename === fn || filename.toLowerCase() === fn.toLowerCase()) {
            return lang.id;
          }
        }
      }
      if (lang.extensions) {
        for (const ext of lang.extensions) {
          if (filename.endsWith(ext)) {
            return lang.id;
          }
        }
      }
    }
    return 'plaintext';
  }

  private async setupTokenization(languageId: string, scopeName: string): Promise<void> {
    if (!this.tmRegistry) return;

    let grammar: IGrammar | null;
    try {
      grammar = await this.tmRegistry.loadGrammar(scopeName);
    } catch {
      return;
    }
    if (!grammar) return;

    monaco.languages.setTokensProvider(languageId, {
      getInitialState: () => new TMState(INITIAL),
      tokenize: (line: string, state: monaco.languages.IState) => {
        const tmState = state as TMState;
        const result = grammar.tokenizeLine(line, tmState.ruleStack);
        const tokens: monaco.languages.IToken[] = result.tokens.map((t) => ({
          startIndex: t.startIndex,
          // Use the most specific scope (last in the array) for Monaco theme matching
          scopes: t.scopes[t.scopes.length - 1] ?? 'source',
        }));
        return {
          tokens,
          endState: new TMState(result.ruleStack),
        };
      },
    });
  }
}

export const languageRegistry = new LanguageRegistry();

// ── Monaco themes with TextMate scope mappings ───────────────────────

function defineThemes(): void {
  const commonRules: monaco.editor.ITokenThemeRule[] = [
    { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
    { token: 'comment.line', foreground: '6A9955', fontStyle: 'italic' },
    { token: 'comment.block', foreground: '6A9955', fontStyle: 'italic' },
    { token: 'string', foreground: 'CE9178' },
    { token: 'string.quoted', foreground: 'CE9178' },
    { token: 'string.template', foreground: 'CE9178' },
    { token: 'string.regexp', foreground: 'D16969' },
    { token: 'constant', foreground: 'B5CEA8' },
    { token: 'constant.numeric', foreground: 'B5CEA8' },
    { token: 'constant.language', foreground: '569CD6' },
    { token: 'constant.character', foreground: 'D7BA7D' },
    { token: 'keyword', foreground: '569CD6' },
    { token: 'keyword.control', foreground: 'C586C0' },
    { token: 'keyword.operator', foreground: 'D4D4D4' },
    { token: 'storage', foreground: '569CD6' },
    { token: 'storage.type', foreground: '569CD6' },
    { token: 'storage.modifier', foreground: '569CD6' },
    { token: 'entity.name.type', foreground: '4EC9B0' },
    { token: 'entity.name.class', foreground: '4EC9B0' },
    { token: 'entity.name.function', foreground: 'DCDCAA' },
    { token: 'entity.name.tag', foreground: '569CD6' },
    { token: 'entity.other.attribute-name', foreground: '9CDCFE' },
    { token: 'variable', foreground: '9CDCFE' },
    { token: 'variable.other', foreground: '9CDCFE' },
    { token: 'variable.parameter', foreground: '9CDCFE' },
    { token: 'variable.language', foreground: '569CD6' },
    { token: 'support.type', foreground: '4EC9B0' },
    { token: 'support.class', foreground: '4EC9B0' },
    { token: 'support.function', foreground: 'DCDCAA' },
    { token: 'support.variable', foreground: '9CDCFE' },
    { token: 'punctuation', foreground: 'D4D4D4' },
    { token: 'meta.tag', foreground: '569CD6' },
    { token: 'markup.heading', foreground: '569CD6', fontStyle: 'bold' },
    { token: 'markup.bold', fontStyle: 'bold' },
    { token: 'markup.italic', fontStyle: 'italic' },
    { token: 'markup.inline.raw', foreground: 'CE9178' },
  ];

  monaco.editor.defineTheme('faraday-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: commonRules,
    colors: {
      'editor.background': '#1e1e1e',
      'editor.foreground': '#d4d4d4',
    },
  });

  monaco.editor.defineTheme('faraday-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '008000', fontStyle: 'italic' },
      { token: 'comment.line', foreground: '008000', fontStyle: 'italic' },
      { token: 'comment.block', foreground: '008000', fontStyle: 'italic' },
      { token: 'string', foreground: 'A31515' },
      { token: 'string.quoted', foreground: 'A31515' },
      { token: 'string.template', foreground: 'A31515' },
      { token: 'string.regexp', foreground: '811F3F' },
      { token: 'constant', foreground: '098658' },
      { token: 'constant.numeric', foreground: '098658' },
      { token: 'constant.language', foreground: '0000FF' },
      { token: 'keyword', foreground: '0000FF' },
      { token: 'keyword.control', foreground: 'AF00DB' },
      { token: 'keyword.operator', foreground: '000000' },
      { token: 'storage', foreground: '0000FF' },
      { token: 'storage.type', foreground: '0000FF' },
      { token: 'entity.name.type', foreground: '267F99' },
      { token: 'entity.name.class', foreground: '267F99' },
      { token: 'entity.name.function', foreground: '795E26' },
      { token: 'entity.name.tag', foreground: '800000' },
      { token: 'entity.other.attribute-name', foreground: 'FF0000' },
      { token: 'variable', foreground: '001080' },
      { token: 'variable.other', foreground: '001080' },
      { token: 'variable.parameter', foreground: '001080' },
      { token: 'support.type', foreground: '267F99' },
      { token: 'support.function', foreground: '795E26' },
      { token: 'punctuation', foreground: '000000' },
      { token: 'markup.heading', foreground: '0000FF', fontStyle: 'bold' },
      { token: 'markup.bold', fontStyle: 'bold' },
      { token: 'markup.italic', fontStyle: 'italic' },
      { token: 'markup.inline.raw', foreground: 'A31515' },
    ],
    colors: {},
  });
}

defineThemes();
