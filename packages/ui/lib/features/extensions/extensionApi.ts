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

export type HostApi = BaseHostApi & {
  setDirty?(dirty: boolean): void;
};
