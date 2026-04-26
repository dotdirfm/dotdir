import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// `?worker&inline` so the worker source is embedded as a base64 blob inside the
// library bundle. Without `&inline` Vite's lib build emits a sibling
// `/assets/*.worker-*.js` that isn't served by the consuming app (lives only
// under `@dotdirfm/ui/dist/assets/`), causing Monaco to 404 and silently fall
// back to running the worker on the main thread.
//
// Only the bare editor worker is needed — this app uses `./monacoEntry` which
// drops Monaco's built-in JSON/CSS/HTML/TS language services (and all
// basic-languages Monarch tokenizers). Language services are expected to come
// from installed extensions, so the language-specific workers would just be
// dead weight (each pulls in a megabyte-class language server).
import { useCommandRegistry } from "@/features/commands/commands";
import {
  DOTDIR_MONACO_EXECUTE_ACTION,
  MONACO_QUICK_COMMAND_ACTION,
  registerMonacoCommandContributions,
  type MonacoCommandContribution,
} from "@/features/extensions/builtins/monacoCommandBridge";
import type { EditorOpenDocumentTarget } from "@/features/extensions/ExtensionContainer";
import type { EditorSelection } from "@/entities/tab/model/types";
import type { ColorThemeData, DotDirGlobalApi, EditorExtensionApi, EditorProps } from "@/features/extensions/extensionApi";
import { registerMountedExtensionCommandHandler } from "@/features/extensions/extensionCommandHandlers";
import { installExtensionHostIframeWorkerUrl, useExtensionHostClient } from "@/features/extensions/extensionHostClient";
import { dirname, join, normalizePath } from "@/utils/path";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker&inline";
import { useEffect, useRef } from "react";

interface MonacoEditorSurfaceProps {
  hostApi: DotDirGlobalApi;
  props: EditorProps;
  active?: boolean;
  onInteract?: () => void;
  selection?: EditorSelection;
  navigationVersion?: number;
  onOpenDocument?: (target: EditorOpenDocumentTarget) => void | Promise<void>;
}

interface MonacoEditorSurfaceRuntime {
  onCommandContributionsChange?: (commands: MonacoCommandContribution[]) => void;
  canOpenDocument?: () => boolean;
  onOpenDocument?: (target: EditorOpenDocumentTarget) => void | Promise<void>;
  getSelection?: () => EditorSelection | undefined;
}

type MonacoEditorExtensionApi = EditorExtensionApi & {
  revealSelection?: (selection: EditorSelection | undefined) => void;
};

type MonacoResolvedKeybindingLike = {
  getUserSettingsLabel?: () => string | null;
  hasMultipleChords?: () => boolean;
};

type MonacoStandaloneKeybindingServiceLike = {
  lookupKeybinding: (commandId: string) => MonacoResolvedKeybindingLike | undefined;
};

type MonacoEditorApiWithOpenHandler = typeof Monaco.editor & {
  registerEditorOpener?: (opener: {
    openCodeEditor: (
      source: Monaco.editor.ICodeEditor,
      resource: Monaco.Uri,
      selectionOrPosition?: Monaco.IRange | Monaco.IPosition | null,
    ) => boolean | Promise<boolean>;
  }) => { dispose: () => void };
};

/**
 * Shared body-level container for Monaco overflow widgets (suggestion popup,
 * hover, parameter hints, find widget, ...). Editors mount with
 * `overflow:hidden`, and when widgets live inside that clipped container they
 * get chopped off. VS Code solves this the same way: lift the widgets out to a
 * top-level fixed-position layer with a high z-index.
 */
let sharedOverflowWidgetsHost: HTMLDivElement | null = null;
function getOverflowWidgetsHost(): HTMLDivElement {
  if (sharedOverflowWidgetsHost && sharedOverflowWidgetsHost.isConnected) return sharedOverflowWidgetsHost;
  const existing = document.querySelector<HTMLDivElement>("div[data-dotdir-monaco-overflow]");
  if (existing) {
    sharedOverflowWidgetsHost = existing;
    return existing;
  }
  const host = document.createElement("div");
  host.dataset.dotdirMonacoOverflow = "true";
  host.className = "monaco-editor";
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:10000;";
  document.body.appendChild(host);
  sharedOverflowWidgetsHost = host;
  return host;
}

function builtInMonacoTheme(isDark: boolean): "vs" | "vs-dark" {
  return isDark ? "vs-dark" : "vs";
}

function safeSetMonacoTheme(monaco: typeof Monaco, name: string): void {
  try {
    monaco.editor.setTheme(name);
  } catch {
    // The VS Code service runtime owns theme application. This is best-effort.
  }
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

function selectionFromMonacoSelection(value: Monaco.IRange | Monaco.IPosition | null | undefined): EditorSelection | undefined {
  if (!value) return undefined;
  const maybeRange = value as Partial<Monaco.IRange & Monaco.IPosition>;
  if (typeof maybeRange.startLineNumber === "number" && typeof maybeRange.startColumn === "number") {
    return {
      startLineNumber: maybeRange.startLineNumber,
      startColumn: maybeRange.startColumn,
      endLineNumber: maybeRange.endLineNumber ?? maybeRange.startLineNumber,
      endColumn: maybeRange.endColumn ?? maybeRange.startColumn,
    };
  }
  return {
    startLineNumber: maybeRange.lineNumber ?? 1,
    startColumn: maybeRange.column ?? 1,
    endLineNumber: maybeRange.lineNumber ?? 1,
    endColumn: maybeRange.column ?? 1,
  };
}

function revealEditorSelection(editor: Monaco.editor.IStandaloneCodeEditor, selection: EditorSelection | undefined): void {
  if (!selection) return;
  const range = {
    startLineNumber: selection.startLineNumber,
    startColumn: selection.startColumn,
    endLineNumber: selection.endLineNumber ?? selection.startLineNumber,
    endColumn: selection.endColumn ?? selection.startColumn,
  };
  editor.setSelection(range);
  editor.revealRangeInCenter(range, 0);
}

function relativeImportSpecifierFromLine(line: string): string | null {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/,
    /\bimport\s*["']([^"']+)["']/,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/,
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    const specifier = match?.[1]?.trim();
    if (specifier?.startsWith(".")) return specifier;
  }
  return null;
}

async function fileExists(hostApi: DotDirGlobalApi, path: string): Promise<boolean> {
  try {
    await hostApi.statFile(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveSameFileImportTarget(
  hostApi: DotDirGlobalApi,
  sourceFilePath: string,
  model: Monaco.editor.ITextModel | null,
  selection: EditorSelection | undefined,
): Promise<string | null> {
  if (!model || !selection) return null;
  const line = model.getLineContent(selection.startLineNumber);
  const specifier = relativeImportSpecifierFromLine(line);
  if (!specifier) return null;

  const basePath = normalizePath(join(dirname(sourceFilePath), specifier));
  const lastSegment = basePath.split("/").pop() ?? "";
  const hasExtension = /\.[^/.]+$/.test(lastSegment);
  const candidates = hasExtension
    ? [basePath]
    : [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.js`,
        `${basePath}.jsx`,
        `${basePath}.mjs`,
        `${basePath}.cjs`,
        `${basePath}.json`,
        join(basePath, "index.ts"),
        join(basePath, "index.tsx"),
        join(basePath, "index.js"),
        join(basePath, "index.jsx"),
        join(basePath, "index.mjs"),
        join(basePath, "index.cjs"),
        join(basePath, "index.json"),
      ];

  for (const candidate of candidates) {
    if (await fileExists(hostApi, candidate)) return candidate;
  }
  return null;
}

function createMonacoEditorExtensionApi(hostApi: DotDirGlobalApi, runtime?: MonacoEditorSurfaceRuntime): MonacoEditorExtensionApi {
  let editorInstance: Monaco.editor.IStandaloneCodeEditor | null = null;
  let rootEl: HTMLDivElement | null = null;
  let mounted = false;
  let monacoReady = false;
  const monacoCssText = "";
  let monacoCssReady = false;
  let focusListener: (() => void) | null = null;
  let disposeSaveCommand: (() => void) | null = null;
  let disposeFindCommand: (() => void) | null = null;
  let monacoModule: typeof Monaco | null = null;
  let monacoModulePromise: Promise<any> | null = null;
  let themeUnsubscribe: (() => void) | null = null;
  let cssVarThemeObserver: MutationObserver | null = null;
  let lastFilePath: string | null = null;
  let latestProps: EditorProps | null = null;
  let unmountFn: (() => void) | null = null;
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

  async function ensureMonacoModule(): Promise<typeof Monaco> {
    if (monacoModule) return monacoModule;
    const loaded = await (monacoModulePromise ??= import("./monacoEntry"));
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

  // When the suggest widget is visible, Monaco's stock keybindings route
  // ArrowUp/Down/PageUp/PageDown/Home/End to the suggest-navigation actions
  // instead of moving the cursor. The dotdir keymap intercepts those keys at
  // the app level and dispatches `cursorUp`/etc. directly, so that context-
  // sensitive behavior is lost. This table lets us restore it: if we're being
  // asked to move the cursor while the suggest widget is open, we dispatch
  // the corresponding suggestion-select action instead.
  const SUGGEST_WIDGET_CURSOR_REMAP: Readonly<Record<string, string>> = {
    cursorUp: "selectPrevSuggestion",
    cursorDown: "selectNextSuggestion",
    cursorPageUp: "selectPrevPageSuggestion",
    cursorPageDown: "selectNextPageSuggestion",
    cursorHome: "selectFirstSuggestion",
    cursorEnd: "selectLastSuggestion",
  };

  // Monaco exposes suggest-widget visibility via a context key. There is no
  // public accessor for it, so reach into the standalone editor's context key
  // service. The shape has been stable for years; the `?? false` guard keeps
  // us safe if Monaco ever renames/removes it.
  function isSuggestWidgetVisible(editor: Monaco.editor.IStandaloneCodeEditor): boolean {
    const svc = (editor as unknown as { _contextKeyService?: { getContextKeyValue?: (key: string) => unknown } })._contextKeyService;
    return Boolean(svc?.getContextKeyValue?.("suggestWidgetVisible"));
  }

  async function runEditorAction(editor: Monaco.editor.IStandaloneCodeEditor, actionId: string, payload?: unknown): Promise<void> {
    if (actionId === "actions.find") {
      await openFindWidget(editor);
      return;
    }

    const remapped = SUGGEST_WIDGET_CURSOR_REMAP[actionId];
    if (remapped && isSuggestWidgetVisible(editor)) {
      editor.trigger("keyboard", remapped, {});
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
    const { languages = [] } = props;
    if (!targetLangId) return;
    if (languages.length === 0) return;
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
  }

  async function ensureMonacoReady(): Promise<void> {
    if (!monacoCssReady && typeof document !== "undefined" && document.head && monacoCssText) {
      const style = document.createElement("style");
      style.setAttribute("data-monaco", "true");
      style.textContent = monacoCssText;
      document.head.appendChild(style);
      monacoCssReady = true;
    }
    if (monacoReady) return;
    await ensureMonacoModule();
    const globalTarget = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : self;
    // We use `./monacoEntry` which strips out Monaco's built-in JSON/TS/CSS/HTML
    // language services, so there are no language-specific worker labels to
    // dispatch — only the core editor worker is ever requested.
    const existingMonacoEnvironment = (globalTarget as typeof globalThis & {
      MonacoEnvironment?: {
        getWorker?: (workerId: string, label: string) => Worker;
        getWorkerUrl?: (workerId: string, label: string) => string | undefined;
        getWorkerOptions?: (workerId: string, label: string) => WorkerOptions | undefined;
      };
    }).MonacoEnvironment ?? {};
    (globalTarget as typeof globalThis & {
      MonacoEnvironment?: {
        getWorker: (workerId: string, label: string) => Worker;
        getWorkerUrl?: (workerId: string, label: string) => string | undefined;
        getWorkerOptions?: (workerId: string, label: string) => WorkerOptions | undefined;
      };
    }).MonacoEnvironment = {
      ...existingMonacoEnvironment,
      getWorker: () => new (EditorWorker as new () => Worker)(),
    };
    installExtensionHostIframeWorkerUrl();
    monacoReady = true;
  }

  function applyColorThemeToEditor(themeData: ColorThemeData): void {
    if (rootEl?.parentElement) {
      rootEl.parentElement.className = themeData.kind === "light" ? "dotdir-light" : "dotdir-dark";
    }
  }

  function applyCssVarThemeToEditor(isDark: boolean): void {
    const monaco = getMonacoModule();
    safeSetMonacoTheme(monaco, builtInMonacoTheme(isDark));
  }

  async function createEditorMount(root: HTMLElement, props: EditorProps): Promise<() => void> {
    await ensureMonacoReady();
    await ensureTextMateLanguage(props, props.langId);
    const monaco = getMonacoModule();

    const colorTheme = hostApi.getColorTheme();
    let isDark: boolean;
    let usingVsCodeTheme = false;

    if (colorTheme && (colorTheme.colors || (Array.isArray(colorTheme.tokenColors) && colorTheme.tokenColors.length > 0))) {
      isDark = colorTheme.kind !== "light";
      usingVsCodeTheme = true;
    } else {
      const theme = await hostApi.getTheme();
      isDark = theme !== "light";
      applyCssVarThemeToEditor(isDark);
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

    // Create the Monaco model with an explicit URI so language servers /
    // extension-host providers have a stable document identity to sync
    // against. Reuse an existing model at the same URI if one is still in
    // Monaco's model registry.
    const modelUri = monaco.Uri.file(props.filePath);
    let model = monaco.editor.getModel(modelUri);
    if (model) {
      if (model.getValue() !== content) model.setValue(content);
      if (props.langId) monaco.editor.setModelLanguage(model, props.langId);
    } else {
      model = monaco.editor.createModel(content, props.langId || "plaintext", modelUri);
    }

    const editor = monaco.editor.create(editorHost, {
      model,
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
      overflowWidgetsDomNode: getOverflowWidgetsHost(),
    });
    editorInstance = editor;
    const editorOpenerDisposable = (monaco.editor as MonacoEditorApiWithOpenHandler).registerEditorOpener?.({
      async openCodeEditor(source, resource, selectionOrPosition) {
        if (source !== editor) return false;
        if (resource.scheme !== "file") return false;
        const filePath = resource.fsPath || resource.path;
        if (!filePath) return false;
        if (!runtime?.canOpenDocument?.()) return false;
        const handler = runtime.onOpenDocument;
        if (!handler) return false;
        const selection = selectionFromMonacoSelection(selectionOrPosition);
        if (filePath === props.filePath) {
          const importTarget = await resolveSameFileImportTarget(hostApi, props.filePath, editor.getModel(), selection);
          if (!importTarget) return false;
          await handler({ filePath: importTarget });
          return true;
        }
        await handler({
          filePath,
          selection,
        });
        return true;
      },
    });
    revealEditorSelection(editor, runtime?.getSelection?.());

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
      editorOpenerDisposable?.dispose();
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
    revealSelection(selection: EditorSelection | undefined): void {
      if (!mounted || !editorInstance) return;
      revealEditorSelection(editorInstance, selection);
    },
  };
}

export function MonacoEditorSurface({ hostApi, props, active, onInteract, selection, navigationVersion, onOpenDocument }: MonacoEditorSurfaceProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<MonacoEditorExtensionApi | null>(null);
  const commandRegistry = useCommandRegistry();
  const extensionHost = useExtensionHostClient();
  const monacoCommandDisposerRef = useRef<(() => void) | null>(null);
  const monacoCommandSignatureRef = useRef<string>("");
  const activatedLanguageEventsRef = useRef(new Set<string>());
  const selectionRef = useRef(selection);
  const onOpenDocumentRef = useRef(onOpenDocument);
  selectionRef.current = selection;
  onOpenDocumentRef.current = onOpenDocument;

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
      getSelection() {
        return selectionRef.current;
      },
      canOpenDocument() {
        return Boolean(onOpenDocumentRef.current);
      },
      onOpenDocument(target) {
        return onOpenDocumentRef.current?.(target);
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
    if (active === false) return;
    apiRef.current?.revealSelection?.(selection);
  }, [active, navigationVersion, selection]);

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
