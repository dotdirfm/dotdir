export type {
  ColorThemeData,
  DotDirCommandsApi,
  DotDirGlobalApi,
  DotDirHostReadyCallback,
  EditorExtensionApi,
  EditorGrammarPayload,
  EditorLanguagePayload,
  EditorProps,
  FsProviderEntry,
  FsProviderExtensionApi,
  FsProviderFactory,
  FsProviderHostApi,
  ViewerExtensionApi,
  ViewerProps,
} from "@dotdirfm/extension-api";

import type { HostApi as BaseHostApi } from "@dotdirfm/extension-api";

export type HostApi = Omit<BaseHostApi, "registerCommand" | "registerKeybinding"> & {
  setDirty?(dirty: boolean): void;
};
