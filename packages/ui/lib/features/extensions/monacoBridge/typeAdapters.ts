/**
 * Flat-payload ↔ Monaco model conversions.
 *
 * The extension host shim sends LSP-shaped JSON payloads, and Monaco
 * expects its own IRange/IPosition/CompletionItem/Hover shapes. This
 * module isolates the table-driven mapping in one place so enum
 * mismatches (a very common source of silent rendering bugs) are
 * localised.
 */

import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type {
  CompletionItemPayload,
  CompletionListPayload,
  DiagnosticPayload,
  DocumentHighlightPayload,
  DocumentSymbolPayload,
  FoldingRangePayload,
  HoverPayload,
  LocationPayload,
  PositionPayload,
  RangePayload,
  SelectionRangePayload,
  SignatureHelpPayload,
  SymbolInformationPayload,
  TextEditPayload,
  WorkspaceEditPayload,
  CodeActionPayload,
  CodeLensPayload,
  ColorInformationPayload,
  ColorPresentationPayload,
  DocumentLinkPayload,
} from "../ehProtocol";

export function positionToMonaco(p: PositionPayload): Monaco.IPosition {
  return { lineNumber: p.line + 1, column: p.character + 1 };
}

export function monacoPositionToPayload(p: Monaco.Position | Monaco.IPosition): PositionPayload {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

export function rangeToMonaco(r: RangePayload): Monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

export function monacoRangeToPayload(r: Monaco.Range | Monaco.IRange): RangePayload {
  return {
    start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
    end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
  };
}

// VS Code CompletionItemKind → Monaco CompletionItemKind
// Monaco enum uses different ordering, so we translate explicitly.
// Reference: monaco-editor's `languages.CompletionItemKind`.
const COMPLETION_KIND_MAP: Record<number, number> = {
  0: 18, // Text
  1: 0, // Method
  2: 1, // Function
  3: 2, // Constructor
  4: 3, // Field
  5: 4, // Variable
  6: 5, // Class
  7: 7, // Interface
  8: 8, // Module
  9: 9, // Property
  10: 12, // Unit
  11: 13, // Value
  12: 15, // Enum
  13: 17, // Keyword
  14: 27, // Snippet
  15: 19, // Color
  16: 20, // File
  17: 21, // Reference
  18: 23, // Folder
  19: 16, // EnumMember
  20: 14, // Constant
  21: 6, // Struct
  22: 10, // Event
  23: 11, // Operator
  24: 24, // TypeParameter
  25: 25, // User
  26: 26, // Issue
};

function mapCompletionKind(kind?: number): Monaco.languages.CompletionItemKind {
  if (kind == null) return 18 as Monaco.languages.CompletionItemKind;
  return ((COMPLETION_KIND_MAP[kind] ?? 18) as unknown) as Monaco.languages.CompletionItemKind;
}

// Diagnostic severity (vscode) → Monaco marker severity (8/4/2/1).
const MARKER_SEVERITY_MAP: Record<number, number> = {
  0: 8, // Error
  1: 4, // Warning
  2: 2, // Info
  3: 1, // Hint
};

export function severityToMarker(severity: number | undefined): Monaco.MarkerSeverity {
  const val = severity == null ? 8 : (MARKER_SEVERITY_MAP[severity] ?? 8);
  return val as Monaco.MarkerSeverity;
}

export function diagnosticToMarker(d: DiagnosticPayload, monaco: typeof Monaco): Monaco.editor.IMarkerData {
  const marker: Monaco.editor.IMarkerData = {
    severity: severityToMarker(d.severity),
    message: d.message,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    source: d.source,
    tags: d.tags as Monaco.MarkerTag[] | undefined,
  };
  if (d.code) {
    if (typeof d.code === "object" && "target" in d.code) {
      marker.code = { value: String(d.code.value), target: monaco.Uri.parse(d.code.target) };
    } else {
      marker.code = String(d.code);
    }
  }
  return marker;
}

function toStringArray(content: CompletionItemPayload["documentation"]): string | Monaco.IMarkdownString | undefined {
  if (!content) return undefined;
  if (typeof content === "string") return content;
  return { value: content.value, isTrusted: false };
}

export function completionItemToMonaco(
  item: CompletionItemPayload,
  defaultRange: Monaco.IRange,
): Monaco.languages.CompletionItem {
  const label = typeof item.label === "string" ? item.label : item.label.label;
  const insertText = item.insertText ?? label;
  let range: Monaco.IRange | { insert: Monaco.IRange; replace: Monaco.IRange };
  if (item.range) {
    if ("inserting" in item.range) {
      range = { insert: rangeToMonaco(item.range.inserting), replace: rangeToMonaco(item.range.replacing) };
    } else {
      range = rangeToMonaco(item.range);
    }
  } else {
    range = defaultRange;
  }
  return {
    label: typeof item.label === "string" ? item.label : {
      label: item.label.label,
      detail: item.label.detail,
      description: item.label.description,
    },
    kind: mapCompletionKind(item.kind),
    detail: item.detail,
    documentation: toStringArray(item.documentation),
    sortText: item.sortText,
    filterText: item.filterText,
    insertText,
    insertTextRules: item.insertTextFormat === 2 ? 4 : undefined,
    preselect: item.preselect,
    range,
    commitCharacters: item.commitCharacters,
    additionalTextEdits: item.additionalTextEdits?.map((e) => ({ range: rangeToMonaco(e.range), text: e.newText })),
    command: item.command
      ? { id: item.command.command, title: item.command.title, arguments: item.command.arguments as unknown[] | undefined }
      : undefined,
  } as Monaco.languages.CompletionItem;
}

export function completionListToMonaco(
  list: CompletionListPayload | null,
  defaultRange: Monaco.IRange,
): Monaco.languages.CompletionList | null {
  if (!list) return null;
  return {
    suggestions: list.items.map((item) => completionItemToMonaco(item, defaultRange)),
    incomplete: Boolean(list.isIncomplete),
  };
}

export function hoverToMonaco(hover: HoverPayload | null): Monaco.languages.Hover | null {
  if (!hover) return null;
  const contents: Monaco.IMarkdownString[] = [];
  for (const c of hover.contents) {
    if (typeof c === "string") contents.push({ value: c });
    else if ("language" in c) contents.push({ value: "```" + c.language + "\n" + c.value + "\n```" });
    else contents.push({ value: c.value });
  }
  return { contents, range: hover.range ? rangeToMonaco(hover.range) : undefined };
}

export function textEditToMonaco(edit: TextEditPayload): Monaco.languages.TextEdit {
  return { range: rangeToMonaco(edit.range), text: edit.newText };
}

export function locationToMonaco(l: LocationPayload, monaco: typeof Monaco): Monaco.languages.Location {
  return { uri: monaco.Uri.parse(l.uri), range: rangeToMonaco(l.range) };
}

// VS Code SymbolKind → Monaco SymbolKind (same numeric values, identity mapping for now).
export function symbolKindToMonaco(kind: number): Monaco.languages.SymbolKind {
  return kind as Monaco.languages.SymbolKind;
}

export function documentSymbolToMonaco(sym: DocumentSymbolPayload): Monaco.languages.DocumentSymbol {
  return {
    name: sym.name,
    detail: sym.detail ?? "",
    kind: symbolKindToMonaco(sym.kind),
    range: rangeToMonaco(sym.range),
    selectionRange: rangeToMonaco(sym.selectionRange),
    children: (sym.children ?? []).map(documentSymbolToMonaco),
    tags: (sym.tags ?? []) as unknown as readonly Monaco.languages.SymbolTag[],
  };
}

export function symbolInformationToMonaco(
  sym: SymbolInformationPayload,
  _monaco: typeof Monaco,
): Monaco.languages.DocumentSymbol {
  // Monaco's document symbol provider only returns DocumentSymbol[]; flatten the location range.
  return {
    name: sym.name,
    detail: sym.containerName ?? "",
    kind: symbolKindToMonaco(sym.kind),
    range: rangeToMonaco(sym.location.range),
    selectionRange: rangeToMonaco(sym.location.range),
    children: [],
    tags: (sym.tags ?? []) as unknown as readonly Monaco.languages.SymbolTag[],
  };
}

export function foldingRangeToMonaco(f: FoldingRangePayload): Monaco.languages.FoldingRange {
  const kindMap: Record<string, Monaco.languages.FoldingRangeKind | undefined> = {
    comment: { value: "comment" } as Monaco.languages.FoldingRangeKind,
    imports: { value: "imports" } as Monaco.languages.FoldingRangeKind,
    region: { value: "region" } as Monaco.languages.FoldingRangeKind,
  };
  return {
    start: f.start + 1,
    end: f.end + 1,
    kind: f.kind ? kindMap[f.kind] : undefined,
  };
}

export function selectionRangeToMonaco(r: SelectionRangePayload): Monaco.languages.SelectionRange {
  return { range: rangeToMonaco(r.range) };
}

export function signatureHelpToMonaco(sh: SignatureHelpPayload | null): Monaco.languages.SignatureHelp | null {
  if (!sh) return null;
  return {
    activeSignature: sh.activeSignature ?? 0,
    activeParameter: sh.activeParameter ?? 0,
    signatures: sh.signatures.map((s) => ({
      label: s.label,
      documentation: toStringArray(s.documentation),
      parameters: (s.parameters ?? []).map((p) => ({
        label: p.label,
        documentation: toStringArray(p.documentation),
      })),
      activeParameter: s.activeParameter,
    })),
  };
}

export function docHighlightToMonaco(h: DocumentHighlightPayload): Monaco.languages.DocumentHighlight {
  return {
    range: rangeToMonaco(h.range),
    kind: (h.kind as Monaco.languages.DocumentHighlightKind | undefined) ?? (0 as Monaco.languages.DocumentHighlightKind),
  };
}

export function colorInformationToMonaco(c: ColorInformationPayload): Monaco.languages.IColorInformation {
  return { range: rangeToMonaco(c.range), color: c.color };
}

export function colorPresentationToMonaco(p: ColorPresentationPayload): Monaco.languages.IColorPresentation {
  return {
    label: p.label,
    textEdit: p.textEdit ? textEditToMonaco(p.textEdit) : undefined,
    additionalTextEdits: p.additionalTextEdits?.map(textEditToMonaco),
  };
}

export function documentLinkToMonaco(l: DocumentLinkPayload, monaco: typeof Monaco): Monaco.languages.ILink {
  return {
    range: rangeToMonaco(l.range),
    url: l.target ? monaco.Uri.parse(l.target) : undefined,
    tooltip: l.tooltip,
  };
}

export function codeLensToMonaco(l: CodeLensPayload): Monaco.languages.CodeLens {
  return {
    range: rangeToMonaco(l.range),
    command: l.command
      ? { id: l.command.command, title: l.command.title, arguments: l.command.arguments as unknown[] | undefined }
      : undefined,
  };
}

export function codeActionToMonaco(a: CodeActionPayload, monaco: typeof Monaco): Monaco.languages.CodeAction {
  return {
    title: a.title,
    kind: a.kind,
    diagnostics: a.diagnostics?.map((d) => diagnosticToMarker(d, monaco)),
    edit: a.edit ? workspaceEditToMonaco(a.edit, monaco) : undefined,
    command: a.command
      ? { id: a.command.command, title: a.command.title, arguments: a.command.arguments as unknown[] | undefined }
      : undefined,
    isPreferred: a.isPreferred,
    disabled: a.disabled?.reason,
  };
}

export function workspaceEditToMonaco(edit: WorkspaceEditPayload, monaco: typeof Monaco): Monaco.languages.WorkspaceEdit {
  const edits: Monaco.languages.IWorkspaceTextEdit[] = [];
  if (edit.changes) {
    for (const [uriStr, textEdits] of Object.entries(edit.changes)) {
      const resource = monaco.Uri.parse(uriStr);
      for (const te of textEdits) {
        edits.push({
          resource,
          textEdit: { range: rangeToMonaco(te.range), text: te.newText },
          versionId: undefined,
        });
      }
    }
  }
  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      const resource = monaco.Uri.parse(dc.uri);
      for (const te of dc.edits) {
        edits.push({
          resource,
          textEdit: { range: rangeToMonaco(te.range), text: te.newText },
          versionId: dc.version,
        });
      }
    }
  }
  return { edits };
}
