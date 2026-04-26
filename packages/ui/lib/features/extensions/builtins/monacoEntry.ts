/**
 * Monaco entry backed by CodinGame's VS Code editor API.
 *
 * The previous file deep-imported many official `monaco-editor/esm/*`
 * contribution modules. With the VS Code-service runtime, those deep imports
 * are no longer the extension/provider integration point; services and
 * extensions register language features through the VS Code API layer.
 */

export * from "monaco-editor/esm/vs/editor/editor.api.js";

import "monaco-editor/esm/vs/editor/browser/coreCommands.js";
import "monaco-editor/esm/vs/editor/browser/config/tabFocus.js";
import "monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController.js";
import "monaco-editor/esm/vs/editor/contrib/format/browser/formatActions.js";
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/esm/vs/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js";
