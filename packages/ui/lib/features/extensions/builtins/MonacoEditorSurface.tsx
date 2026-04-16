import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { StateStack } from "vscode-textmate";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import monacoCssUrl from "monaco-editor/min/vs/editor/editor.main.css?url";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import { useEffect, useRef } from "react";
import { useCommandRegistry } from "@/features/commands/commands";
import { registerMountedExtensionCommandHandler } from "@/features/extensions/extensionCommandHandlers";
import { useExtensionHostClient } from "@/features/extensions/extensionHostClient";
import {
  DOTDIR_MONACO_EXECUTE_ACTION,
  MONACO_QUICK_COMMAND_ACTION,
  registerMonacoCommandContributions,
  type MonacoCommandContribution,
} from "@/features/extensions/builtins/monacoCommandBridge";
import type { ColorThemeData, DotDirGlobalApi, EditorExtensionApi, EditorProps } from "@/features/extensions/extensionApi";

interface MonacoEditorSurfaceProps {
  hostApi: DotDirGlobalApi;
  props: EditorProps;
  active?: boolean;
  onInteract?: () => void;
}

interface MonacoEditorSurfaceRuntime {
  onCommandContributionsChange?: (commands: MonacoCommandContribution[]) => void;
}

type MonacoResolvedKeybindingLike = {
  getUserSettingsLabel?: () => string | null;
  hasMultipleChords?: () => boolean;
};

type MonacoStandaloneKeybindingServiceLike = {
  lookupKeybinding: (commandId: string) => MonacoResolvedKeybindingLike | undefined;
};

class TMState implements Monaco.languages.IState {
  constructor(private readonly ruleStackValue: StateStack) {}

  get ruleStack(): StateStack {
    return this.ruleStackValue;
  }

  clone(): TMState {
    return new TMState(this.ruleStackValue);
  }

  equals(other: Monaco.languages.IState): boolean {
    return other instanceof TMState && other.ruleStackValue === this.ruleStackValue;
  }
}

const COMMON_SCOPE_SUFFIXES = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "json",
  "yaml",
  "yml",
  "md",
  "rs",
  "py",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "css",
  "scss",
  "less",
  "html",
  "xml",
  "toml",
  "ini",
  "sh",
  "bash",
  "zsh",
]);

function stripLangSuffix(scope: string): string {
  const match = scope.match(/^(.*)\.([a-zA-Z0-9_-]+)$/);
  if (!match) return scope;
  const suffix = match[2]!.toLowerCase();
  if (!COMMON_SCOPE_SUFFIXES.has(suffix)) return scope;
  return match[1]!;
}

function getMonacoKeybindingService(
  editor: Monaco.editor.IStandaloneCodeEditor,
): MonacoStandaloneKeybindingServiceLike | null {
  const candidate = (editor as Monaco.editor.IStandaloneCodeEditor & {
    _standaloneKeybindingService?: unknown;
  })._standaloneKeybindingService;

  if (!candidate || typeof (candidate as { lookupKeybinding?: unknown }).lookupKeybinding !== "function") {
    return null;
  }

  return candidate as MonacoStandaloneKeybindingServiceLike;
}

function toDotdirMonacoKeybinding(
  resolvedKeybinding: MonacoResolvedKeybindingLike | undefined,
): Pick<NonNullable<MonacoCommandContribution["keybinding"]>, "key" | "mac"> | undefined {
  if (!resolvedKeybinding) return undefined;
  if (resolvedKeybinding.hasMultipleChords?.()) return undefined;

  const label = resolvedKeybinding.getUserSettingsLabel?.()?.trim().toLowerCase();
  if (!label || /\s/.test(label)) return undefined;
  if (label.includes("win+") || label.includes("meta+")) return undefined;

  return { key: label };
}

function normalizeColor(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length === 6 || hex.length === 8) return trimmed;
    if (hex.length === 3) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    if (hex.length === 4) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    return null;
  }
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = trimmed;
    return ctx.fillStyle.startsWith("#") ? ctx.fillStyle : null;
  } catch {
    return null;
  }
}

function normalizeTokenColor(value: string): string | null {
  const normalized = normalizeColor(value);
  if (!normalized) return null;
  const hex = normalized.slice(1);
  return hex.length === 8 ? hex.slice(0, 6) : hex;
}

function buildMonacoTheme(themeData: ColorThemeData): { base: "vs" | "vs-dark"; rules: Monaco.editor.ITokenThemeRule[]; colors: Record<string, string> } {
  const base: "vs" | "vs-dark" = themeData.kind === "light" ? "vs" : "vs-dark";
  const rules: Monaco.editor.ITokenThemeRule[] = [];
  const colors: Record<string, string> = {};

  if (themeData.colors) {
    for (const [key, value] of Object.entries(themeData.colors)) {
      const normalized = normalizeColor(value);
      if (normalized) colors[key] = normalized;
    }
  }

  if (Array.isArray(themeData.tokenColors)) {
    for (const entry of themeData.tokenColors) {
      if (!entry || typeof entry !== "object") continue;
      const tokenColor = entry as {
        scope?: string | string[];
        settings?: { foreground?: string; fontStyle?: string; background?: string };
      };
      if (!tokenColor.settings) continue;
      const rawScopes = Array.isArray(tokenColor.scope) ? tokenColor.scope : tokenColor.scope ? [tokenColor.scope] : [""];
      const scopes: string[] = [];
      for (const rawScope of rawScopes) {
        if (!rawScope) continue;
        for (const scopePart of String(rawScope).split(",")) {
          const trimmed = scopePart.trim();
          if (!trimmed) continue;
          const simple = trimmed.split(/\s+/)[0]!;
          if (simple.startsWith("-")) continue;
          scopes.push(simple);
          const stripped = stripLangSuffix(simple);
          if (stripped && stripped !== simple) scopes.push(stripped);
        }
      }
      if (scopes.length === 0) scopes.push("");
      for (const scope of scopes) {
        const rule: Monaco.editor.ITokenThemeRule = { token: scope };
        if (tokenColor.settings.foreground) {
          const fg = normalizeTokenColor(tokenColor.settings.foreground);
          if (fg) rule.foreground = fg;
        }
        if (tokenColor.settings.fontStyle) rule.fontStyle = tokenColor.settings.fontStyle;
        if (tokenColor.settings.background) {
          const bg = normalizeTokenColor(tokenColor.settings.background);
          if (bg) rule.background = bg;
        }
        rules.push(rule);
      }
    }
  }

  return { base, rules, colors };
}

function createMonacoEditorExtensionApi(hostApi: DotDirGlobalApi, runtime?: MonacoEditorSurfaceRuntime): EditorExtensionApi {
  let editorInstance: Monaco.editor.IStandaloneCodeEditor | null = null;
  let rootEl: HTMLDivElement | null = null;
  let mounted = false;
  let monacoReady = false;
  let monacoCssReady = false;
  let focusListener: (() => void) | null = null;
  let disposeSaveCommand: (() => void) | null = null;
  let disposeFindCommand: (() => void) | null = null;
  let monacoModule: typeof Monaco | null = null;
  let monacoModulePromise: Promise<any> | null = null;
  let textMateModulePromise: Promise<any> | null = null;
  let onigurumaModulePromise: Promise<any> | null = null;
  let onigWasmLoadPromise: Promise<void> | null = null;
  let themeUnsubscribe: (() => void) | null = null;
  let cssVarThemeObserver: MutationObserver | null = null;
  let lastFilePath: string | null = null;
  let latestProps: EditorProps | null = null;
  let unmountFn: (() => void) | null = null;
  const grammarJsonCache = new Map<string, object | null>();
  const activatedTokenProviders = new Set<string>();
  const reservedDotdirEditorKeys = new Set(["f1", "ctrl+f1", "cmd+f1", "f2", "ctrl+s", "cmd+s"]);

  function publishEditorCommands(editor: Monaco.editor.IStandaloneCodeEditor | null): void {
    if (!runtime?.onCommandContributionsChange) return;
    if (!editor) {
      runtime.onCommandContributionsChange([]);
      return;
    }

    const commands: MonacoCommandContribution[] = [];
    const keybindingService = getMonacoKeybindingService(editor);
    const seenDisplaySignatures = new Set<string>();
    for (const action of editor.getSupportedActions()) {
      if (action.id.startsWith("dotdir.")) continue;
      const title = action.label?.trim() || action.alias?.trim();
      if (!title) continue;
      const keybinding =
        action.id === MONACO_QUICK_COMMAND_ACTION
          ? undefined
          : toDotdirMonacoKeybinding(keybindingService?.lookupKeybinding(action.id));
      const sanitizedKeybinding =
        keybinding && !reservedDotdirEditorKeys.has(keybinding.key) && !(keybinding.mac && reservedDotdirEditorKeys.has(keybinding.mac))
          ? keybinding
          : undefined;
      const displaySignature = [
        title.toLowerCase(),
        sanitizedKeybinding?.key ?? "",
        sanitizedKeybinding?.mac ?? "",
      ].join("\u0000");
      if (seenDisplaySignatures.has(displaySignature)) continue;
      seenDisplaySignatures.add(displaySignature);
      commands.push({
        command: action.id,
        title,
        palette: action.id !== MONACO_QUICK_COMMAND_ACTION,
        keybinding: sanitizedKeybinding,
      });
    }

    runtime.onCommandContributionsChange(commands);
  }

  async function ensureOnigurumaWasmLoaded(): Promise<void> {
    if (onigWasmLoadPromise) return onigWasmLoadPromise;
    onigWasmLoadPromise = (async () => {
      let wasm: ArrayBuffer | null = null;
      try {
        const res = await fetch(onigWasmUrl);
        wasm = await res.arrayBuffer();
      } catch {
        wasm = null;
      }
      if (!wasm) return;
      const oniguruma = await (onigurumaModulePromise ??= import("vscode-oniguruma"));
      await oniguruma.loadWASM(wasm);
    })();
    return onigWasmLoadPromise;
  }

  async function ensureMonacoModule(): Promise<typeof Monaco> {
    if (monacoModule) return monacoModule;
    const loaded = await (monacoModulePromise ??= import("monaco-editor/esm/vs/editor/editor.main.js"));
    monacoModule = loaded;
    return loaded;
  }

  function getMonacoModule(): typeof Monaco {
    if (!monacoModule) throw new Error("Monaco runtime is not initialized");
    return monacoModule;
  }

  function focusEditorDomTarget(editor: Monaco.editor.IStandaloneCodeEditor | null): void {
    if (!editor) return;
    try {
      window.focus();
    } catch {
      // ignore
    }
    editor.focus();
  }

  function stabilizeInitialViewport(editor: Monaco.editor.IStandaloneCodeEditor | null): void {
    if (!editor) return;
    try {
      editor.layout();
      editor.setScrollTop(0);
      editor.setScrollLeft(0);
    } catch {
      // ignore
    }
  }

  function scheduleEditorFocus(editor: Monaco.editor.IStandaloneCodeEditor | null): void {
    if (!editor) return;
    const run = () => focusEditorDomTarget(editor);
    run();
    requestAnimationFrame(run);
    setTimeout(run, 0);
    setTimeout(run, 50);
    setTimeout(run, 150);
    setTimeout(run, 300);
    setTimeout(run, 600);
  }

  function scheduleInitialViewportStabilization(editor: Monaco.editor.IStandaloneCodeEditor | null): void {
    if (!editor) return;
    const run = () => stabilizeInitialViewport(editor);
    run();
    requestAnimationFrame(run);
    setTimeout(run, 0);
    setTimeout(run, 50);
    setTimeout(run, 150);
  }

  async function openFindWidget(editor: Monaco.editor.IStandaloneCodeEditor): Promise<void> {
    focusEditorDomTarget(editor);
    editor.layout();

    const findController = editor.getContribution("editor.contrib.findController") as
      | {
          start?: (
            opts: {
              forceRevealReplace: boolean;
              seedSearchStringFromSelection: "none" | "single" | "multiple";
              seedSearchStringFromNonEmptySelection: boolean;
              seedSearchStringFromGlobalClipboard: boolean;
              shouldFocus: 0 | 1 | 2;
              shouldAnimate: boolean;
              updateSearchScope: boolean;
              loop: boolean;
            },
            newState?: Record<string, unknown>,
          ) => Promise<void> | void;
        }
      | null;

    if (findController?.start) {
      await findController.start(
        {
          forceRevealReplace: false,
          seedSearchStringFromSelection: "single",
          seedSearchStringFromNonEmptySelection: false,
          seedSearchStringFromGlobalClipboard: false,
          shouldFocus: 1,
          shouldAnimate: false,
          updateSearchScope: false,
          loop: true,
        },
        {},
      );
      return;
    }

    const action = editor.getAction("actions.find");
    if (action) {
      await action.run();
      return;
    }

    editor.trigger("keyboard", "actions.find", {});
  }

  async function runEditorAction(editor: Monaco.editor.IStandaloneCodeEditor, actionId: string, payload?: unknown): Promise<void> {
    if (actionId === "actions.find") {
      await openFindWidget(editor);
      return;
    }

    const action = editor.getAction(actionId);
    if (action?.isSupported()) {
      await action.run(payload);
      return;
    }

    editor.trigger("keyboard", actionId, payload && typeof payload === "object" ? payload : {});
  }

  async function ensureTextMateLanguage(props: EditorProps, targetLangId: string): Promise<void> {
    const { languages = [], grammars = [] } = props;
    if (!targetLangId) return;
    if (languages.length === 0 && grammars.length === 0) return;
    const monaco = await ensureMonacoModule();

    for (const lang of languages) {
      const aliases = lang.aliases?.filter((alias): alias is string => typeof alias === "string" && alias.length > 0);
      monaco.languages.register({
        id: lang.id,
        extensions: lang.extensions,
        aliases: aliases?.length ? aliases : undefined,
        filenames: lang.filenames,
      });
    }

    if (grammars.length === 0) return;
    await ensureOnigurumaWasmLoaded();
    const textmate = await (textMateModulePromise ??= import("vscode-textmate"));
    const oniguruma = await (onigurumaModulePromise ??= import("vscode-oniguruma"));

    const languageToScope = new Map<string, string>();
    const scopeToPath = new Map<string, string>();
    for (const grammar of grammars) {
      const scopeName = grammar.contribution.scopeName;
      if (grammar.path) scopeToPath.set(scopeName, grammar.path);
      if (grammar.contribution.language) {
        languageToScope.set(grammar.contribution.language.toLowerCase(), scopeName);
      }
    }

    const targetLanguageId = targetLangId.toLowerCase();
    const targetScopeName = languageToScope.get(targetLanguageId);
    if (!targetScopeName) return;
    const activatedKey = `${targetLanguageId}\0${targetScopeName}`;
    if (activatedTokenProviders.has(activatedKey)) return;

    const tmRegistry = new textmate.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (patterns: string[]) => oniguruma.createOnigScanner(patterns),
        createOnigString: (value: string) => oniguruma.createOnigString(value),
      }),
      loadGrammar: async (scopeName: string) => {
        const cached = grammarJsonCache.get(scopeName);
        if (cached !== undefined) return cached ? (cached as never) : null;
        const grammarPath = scopeToPath.get(scopeName);
        if (!grammarPath) {
          grammarJsonCache.set(scopeName, null);
          return null;
        }
        try {
          const jsonText = await hostApi.readFileText(grammarPath);
          const parsed = JSON.parse(jsonText) as object;
          grammarJsonCache.set(scopeName, parsed);
          return parsed as never;
        } catch {
          grammarJsonCache.set(scopeName, null);
          return null;
        }
      },
    });

    const grammar = await tmRegistry.loadGrammar(targetScopeName).catch(() => null);
    if (!grammar) return;
    monaco.languages.setTokensProvider(targetLangId, {
      getInitialState: () => new TMState(textmate.INITIAL),
      tokenize: (line: string, state: Monaco.languages.IState) => {
        const tmState = state as TMState;
        const result = grammar.tokenizeLine(line, tmState.ruleStack);
        const tokens: Monaco.languages.IToken[] = result.tokens.map((token: { startIndex: number; scopes: string[] }) => ({
          startIndex: token.startIndex,
          scopes: stripLangSuffix(token.scopes[token.scopes.length - 1] ?? "source"),
        }));
        return {
          tokens,
          endState: new TMState(result.ruleStack),
        };
      },
    });

    activatedTokenProviders.add(activatedKey);
  }

  async function ensureMonacoReady(): Promise<void> {
    if (!monacoCssReady && typeof document !== "undefined" && document.head && monacoCssUrl) {
      const link = document.createElement("link");
      link.setAttribute("data-monaco", "true");
      link.rel = "stylesheet";
      link.href = monacoCssUrl;
      document.head.appendChild(link);
      monacoCssReady = true;
    }
    if (monacoReady) return;
    const monaco = await ensureMonacoModule();
    const globalTarget = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : self;
    (globalTarget as typeof globalThis & { MonacoEnvironment?: { getWorker: () => Worker } }).MonacoEnvironment = {
      getWorker: () => new (EditorWorker as new () => Worker)(),
    };
    monaco.editor.defineTheme("dotdir-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6A9955", fontStyle: "italic" },
        { token: "string", foreground: "CE9178" },
        { token: "keyword", foreground: "569CD6" },
        { token: "entity.name.type", foreground: "4EC9B0" },
        { token: "entity.name.function", foreground: "DCDCAA" },
        { token: "variable", foreground: "9CDCFE" },
      ],
      colors: { "editor.background": "#1e1e1e", "editor.foreground": "#d4d4d4" },
    });
    monaco.editor.defineTheme("dotdir-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "008000", fontStyle: "italic" },
        { token: "string", foreground: "A31515" },
        { token: "keyword", foreground: "0000FF" },
        { token: "entity.name.type", foreground: "267F99" },
        { token: "entity.name.function", foreground: "795E26" },
        { token: "variable", foreground: "001080" },
      ],
      colors: {},
    });
    monacoReady = true;
  }

  function applyColorThemeToEditor(themeData: ColorThemeData): void {
    const monaco = getMonacoModule();
    const { base, rules, colors } = buildMonacoTheme(themeData);
    monaco.editor.defineTheme("dotdir-custom", { base, inherit: true, rules, colors });
    monaco.editor.setTheme("dotdir-custom");
    if (rootEl?.parentElement) {
      rootEl.parentElement.className = themeData.kind === "light" ? "dotdir-light" : "dotdir-dark";
    }
  }

  function applyCssVarThemeToEditor(isDark: boolean): void {
    const monaco = getMonacoModule();
    const computed = getComputedStyle(document.documentElement);
    const bg = normalizeColor(computed.getPropertyValue("--bg")) ?? (isDark ? "#1e1e1e" : "#ffffff");
    const fg = normalizeColor(computed.getPropertyValue("--fg")) ?? (isDark ? "#d4d4d4" : "#1e1e1e");
    monaco.editor.defineTheme("dotdir-css", {
      base: isDark ? "vs-dark" : "vs",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": bg,
        "editor.foreground": fg,
      },
    });
    monaco.editor.setTheme("dotdir-css");
  }

  async function createEditorMount(root: HTMLElement, props: EditorProps): Promise<() => void> {
    await ensureMonacoReady();
    await ensureTextMateLanguage(props, props.langId);
    const monaco = getMonacoModule();

    const colorTheme = hostApi.getColorTheme();
    let monacoTheme: string;
    let isDark: boolean;
    let usingVsCodeTheme = false;

    if (colorTheme && (colorTheme.colors || (Array.isArray(colorTheme.tokenColors) && colorTheme.tokenColors.length > 0))) {
      const { base, rules, colors } = buildMonacoTheme(colorTheme);
      monaco.editor.defineTheme("dotdir-custom", { base, inherit: true, rules, colors });
      monacoTheme = "dotdir-custom";
      isDark = colorTheme.kind !== "light";
      usingVsCodeTheme = true;
    } else {
      const theme = await hostApi.getTheme();
      isDark = theme !== "light";
      applyCssVarThemeToEditor(isDark);
      monacoTheme = "dotdir-css";
      usingVsCodeTheme = false;
    }

    const content = await hostApi.readFileText(props.filePath);

    root.innerHTML = "";
    root.style.margin = "0";
    root.style.padding = "0";
    root.style.height = "100%";
    root.style.overflow = "hidden";
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.className = isDark ? "dotdir-dark" : "dotdir-light";

    const editorHost = document.createElement("div");
    editorHost.style.cssText = "position:relative;flex:1;min-height:0;width:100%;overflow:hidden;";
    editorHost.dataset.dotdirFocusTarget = "true";
    root.appendChild(editorHost);
    rootEl = editorHost;

    const editor = monaco.editor.create(editorHost, {
      value: content,
      language: props.langId || "plaintext",
      theme: monacoTheme,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "monospace",
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      wordWrap: "off",
      tabSize: 4,
      insertSpaces: true,
      quickSuggestions: {
        other: true,
        comments: true,
        strings: true,
      },
      quickSuggestionsDelay: 120,
      wordBasedSuggestions: "currentDocument",
      suggestOnTriggerCharacters: true,
      selectionHighlight: true,
      occurrencesHighlight: "singleFile",
      tabCompletion: "on",
      find: {
        addExtraSpaceOnTop: false,
      },
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: editorHost,
    });
    editorInstance = editor;

    if (themeUnsubscribe) themeUnsubscribe();
    if (cssVarThemeObserver) {
      cssVarThemeObserver.disconnect();
      cssVarThemeObserver = null;
    }

    themeUnsubscribe = hostApi.onThemeChange((newTheme) => {
      if (newTheme.colors || (Array.isArray(newTheme.tokenColors) && newTheme.tokenColors.length > 0)) {
        usingVsCodeTheme = true;
        applyColorThemeToEditor(newTheme);
      } else {
        usingVsCodeTheme = false;
        isDark = newTheme.kind !== "light";
        applyCssVarThemeToEditor(isDark);
        root.className = newTheme.kind === "light" ? "dotdir-light" : "dotdir-dark";
      }
    });

    cssVarThemeObserver = new MutationObserver(() => {
      if (usingVsCodeTheme) return;
      applyCssVarThemeToEditor(isDark);
    });
    cssVarThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

    let dirty = false;
    hostApi.setDirty?.(false);
    const save = async (): Promise<boolean> => {
      try {
        await hostApi.writeFile(props.filePath, editor.getValue());
        dirty = false;
        hostApi.setDirty?.(false);
        return true;
      } catch {
        return false;
      }
    };

    disposeSaveCommand?.();
    disposeSaveCommand = null;
    disposeFindCommand?.();
    disposeFindCommand = null;
    disposeSaveCommand = registerMountedExtensionCommandHandler(
      "dotdir.save",
      async () => {
        await save();
      },
      { isActive: () => editor.hasWidgetFocus() },
    );
    disposeFindCommand = registerMountedExtensionCommandHandler(
      "dotdir.find",
      async () => {
        await openFindWidget(editor);
      },
      { isActive: () => editor.hasWidgetFocus() },
    );
    const disposeExecuteActionCommand = registerMountedExtensionCommandHandler(
      DOTDIR_MONACO_EXECUTE_ACTION,
      async (actionId, payload) => {
        if (typeof actionId !== "string" || actionId.length === 0) return;
        await runEditorAction(editor, actionId, payload);
      },
      { isActive: () => editor.hasWidgetFocus() },
    );

    editor.onDidChangeModelContent(() => {
      if (dirty) return;
      dirty = true;
      hostApi.setDirty?.(true);
    });

    editor.addAction({
      id: "dotdir.find",
      label: "Find",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF],
      run: () => {
        return openFindWidget(editor);
      },
    });
    editor.addAction({
      id: "dotdir.triggerSuggest",
      label: "Trigger Suggest",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space],
      run: () => {
        editor.trigger("keyboard", "editor.action.triggerSuggest", {});
      },
    });
    editor.addAction({
      id: "dotdir.save",
      label: "Save File",
      run: () => {
        void save();
      },
    });
    editor.addAction({
      id: "dotdir.close",
      label: "Close Editor",
      run: () => {
        hostApi.onClose();
      },
    });

    publishEditorCommands(editor);
    scheduleInitialViewportStabilization(editor);
    scheduleEditorFocus(editor);

    const handleWindowFocus = () => {
      scheduleEditorFocus(editor);
    };
    window.addEventListener("focus", handleWindowFocus);
    focusListener = () => {
      window.removeEventListener("focus", handleWindowFocus);
      focusListener = null;
    };

    return () => {
      if (disposeSaveCommand) {
        disposeSaveCommand();
        disposeSaveCommand = null;
      }
      if (disposeFindCommand) {
        disposeFindCommand();
        disposeFindCommand = null;
      }
      disposeExecuteActionCommand();
      if (focusListener) focusListener();
      if (themeUnsubscribe) {
        themeUnsubscribe();
        themeUnsubscribe = null;
      }
      if (cssVarThemeObserver) {
        cssVarThemeObserver.disconnect();
        cssVarThemeObserver = null;
      }
      editor.dispose();
      editorInstance = null;
      publishEditorCommands(null);
      if (rootEl?.parentNode) rootEl.parentNode.removeChild(rootEl);
      rootEl = null;
    };
  }

  function setEditorLanguage(langId: string): void {
    if (!editorInstance) return;
    const monaco = getMonacoModule();
    const model = editorInstance.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, langId);
    }
    publishEditorCommands(editorInstance);
  }

  function focusEditor(): void {
    if (!editorInstance) return;
    scheduleEditorFocus(editorInstance);
  }

  return {
    async mount(root: HTMLElement, props: EditorProps): Promise<void> {
      latestProps = props;
      if (mounted && lastFilePath === props.filePath) return;
      if (mounted && lastFilePath !== props.filePath) {
        unmountFn?.();
        unmountFn = null;
        mounted = false;
      }
      unmountFn = await createEditorMount(root, props);
      mounted = true;
      lastFilePath = props.filePath;
    },
    async unmount(): Promise<void> {
      if (!mounted) return;
      unmountFn?.();
      unmountFn = null;
      mounted = false;
      lastFilePath = null;
    },
    focus(): void {
      if (!mounted) return;
      focusEditor();
    },
    setLanguage(langId: string): void {
      if (!mounted) return;
      void (async () => {
        if (latestProps) {
          await ensureTextMateLanguage(latestProps, langId);
        }
        setEditorLanguage(langId);
      })().catch(() => {
        setEditorLanguage(langId);
      });
    },
  };
}

export function MonacoEditorSurface({ hostApi, props, active, onInteract }: MonacoEditorSurfaceProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<EditorExtensionApi | null>(null);
  const commandRegistry = useCommandRegistry();
  const extensionHost = useExtensionHostClient();
  const monacoCommandDisposerRef = useRef<(() => void) | null>(null);
  const monacoCommandSignatureRef = useRef<string>("");
  const activatedLanguageEventsRef = useRef(new Set<string>());

  if (!apiRef.current) {
    apiRef.current = createMonacoEditorExtensionApi(hostApi, {
      onCommandContributionsChange(commands) {
        const nextSignature = commands
          .slice()
          .sort((left, right) => left.command.localeCompare(right.command))
          .map((command) =>
            [
              command.command,
              command.title,
              command.shortTitle ?? "",
              command.palette === false ? "0" : "1",
              command.keybinding?.key ?? "",
              command.keybinding?.mac ?? "",
            ].join("\u0000"),
          )
          .join("\u0001");
        if (nextSignature === monacoCommandSignatureRef.current) return;
        monacoCommandSignatureRef.current = nextSignature;
        monacoCommandDisposerRef.current?.();
        monacoCommandDisposerRef.current = registerMonacoCommandContributions(commandRegistry, commands);
      },
    });
  }

  useEffect(() => {
    const root = rootRef.current;
    const api = apiRef.current;
    if (!root || !api) return;
    void api.mount(root, props);
  }, [props]);

  useEffect(() => {
    const langId = String(props.langId ?? "").trim();
    if (!langId) return;
    const event = `onLanguage:${langId}`;
    if (activatedLanguageEventsRef.current.has(event)) return;
    activatedLanguageEventsRef.current.add(event);
    void extensionHost.activateByEvent(event).catch((error) => {
      console.warn(`[ExtHost] Failed to activate language event ${event}`, error);
      activatedLanguageEventsRef.current.delete(event);
    });
  }, [extensionHost, props.langId]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api?.setLanguage) return;
    api.setLanguage(props.langId);
  }, [props.langId]);

  useEffect(() => {
    const api = apiRef.current;
    return () => {
      monacoCommandDisposerRef.current?.();
      monacoCommandDisposerRef.current = null;
      monacoCommandSignatureRef.current = "";
      void api?.unmount();
    };
  }, []);

  useEffect(() => {
    if (active === false) return;
    const api = apiRef.current;
    const run = () => {
      void api?.focus?.();
    };
    const frame = requestAnimationFrame(run);
    const timeoutId = setTimeout(run, 0);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeoutId);
    };
  }, [active]);

  return (
    <div
      ref={rootRef}
      style={{ width: "100%", height: "100%" }}
      onFocusCapture={() => onInteract?.()}
      onMouseDownCapture={() => onInteract?.()}
    />
  );
}
