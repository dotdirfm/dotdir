import type { ProviderKind } from "./ehProtocol";

export type MonacoProviderSupport = "supported" | "unsupported";

export interface ProviderDefinition {
  kind: ProviderKind;
  methods: readonly string[];
  monacoSupport: MonacoProviderSupport;
  reason?: string;
}

export const PROVIDER_DEFINITIONS: Record<ProviderKind, ProviderDefinition> = {
  completion: {
    kind: "completion",
    methods: ["provideCompletionItems"],
    monacoSupport: "supported",
  },
  hover: {
    kind: "hover",
    methods: ["provideHover"],
    monacoSupport: "supported",
  },
  definition: {
    kind: "definition",
    methods: ["provideDefinition"],
    monacoSupport: "supported",
  },
  typeDefinition: {
    kind: "typeDefinition",
    methods: ["provideTypeDefinition"],
    monacoSupport: "supported",
  },
  implementation: {
    kind: "implementation",
    methods: ["provideImplementation"],
    monacoSupport: "supported",
  },
  declaration: {
    kind: "declaration",
    methods: ["provideDeclaration"],
    monacoSupport: "supported",
  },
  reference: {
    kind: "reference",
    methods: ["provideReferences"],
    monacoSupport: "supported",
  },
  documentHighlight: {
    kind: "documentHighlight",
    methods: ["provideDocumentHighlights"],
    monacoSupport: "supported",
  },
  documentSymbol: {
    kind: "documentSymbol",
    methods: ["provideDocumentSymbols"],
    monacoSupport: "supported",
  },
  workspaceSymbol: {
    kind: "workspaceSymbol",
    methods: ["provideWorkspaceSymbols"],
    monacoSupport: "unsupported",
    reason: "Monaco standalone does not currently have a DotDir workspace symbol bridge.",
  },
  codeAction: {
    kind: "codeAction",
    methods: ["provideCodeActions"],
    monacoSupport: "supported",
  },
  codeLens: {
    kind: "codeLens",
    methods: ["provideCodeLenses"],
    monacoSupport: "supported",
  },
  documentFormatting: {
    kind: "documentFormatting",
    methods: ["provideDocumentFormattingEdits"],
    monacoSupport: "supported",
  },
  documentRangeFormatting: {
    kind: "documentRangeFormatting",
    methods: ["provideDocumentRangeFormattingEdits"],
    monacoSupport: "supported",
  },
  onTypeFormatting: {
    kind: "onTypeFormatting",
    methods: ["provideOnTypeFormattingEdits"],
    monacoSupport: "supported",
  },
  rename: {
    kind: "rename",
    methods: ["provideRenameEdits"],
    monacoSupport: "supported",
  },
  linkedEditingRange: {
    kind: "linkedEditingRange",
    methods: ["provideLinkedEditingRanges"],
    monacoSupport: "unsupported",
    reason: "Provider is accepted by the VS Code shim but not yet adapted into Monaco.",
  },
  documentLink: {
    kind: "documentLink",
    methods: ["provideDocumentLinks"],
    monacoSupport: "supported",
  },
  color: {
    kind: "color",
    methods: ["provideDocumentColors", "provideColorPresentations"],
    monacoSupport: "supported",
  },
  folding: {
    kind: "folding",
    methods: ["provideFoldingRanges"],
    monacoSupport: "supported",
  },
  selectionRange: {
    kind: "selectionRange",
    methods: ["provideSelectionRanges"],
    monacoSupport: "supported",
  },
  signatureHelp: {
    kind: "signatureHelp",
    methods: ["provideSignatureHelp"],
    monacoSupport: "supported",
  },
  documentSemanticTokens: {
    kind: "documentSemanticTokens",
    methods: ["provideDocumentSemanticTokens"],
    monacoSupport: "unsupported",
    reason: "Semantic-token payload and legend mapping still need a Monaco adapter.",
  },
  documentRangeSemanticTokens: {
    kind: "documentRangeSemanticTokens",
    methods: ["provideDocumentRangeSemanticTokens"],
    monacoSupport: "unsupported",
    reason: "Semantic-token payload and legend mapping still need a Monaco adapter.",
  },
  callHierarchy: {
    kind: "callHierarchy",
    methods: ["prepareCallHierarchy", "provideCallHierarchyIncomingCalls", "provideCallHierarchyOutgoingCalls"],
    monacoSupport: "unsupported",
    reason: "Call hierarchy needs a dedicated UI/adapter beyond Monaco language registration.",
  },
};

export function providerDefinition(kind: ProviderKind): ProviderDefinition {
  return PROVIDER_DEFINITIONS[kind];
}

export function isMonacoProviderSupported(kind: ProviderKind): boolean {
  return providerDefinition(kind).monacoSupport === "supported";
}

export function providerSupportsMethod(kind: ProviderKind, method: string): boolean {
  return providerDefinition(kind).methods.includes(method);
}
