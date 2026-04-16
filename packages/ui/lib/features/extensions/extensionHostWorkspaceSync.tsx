/**
 * Extension Host Workspace Sync
 *
 * Observes the active tab's current directory and pushes it to the
 * extension host worker as a single-entry workspaceFolders list. This
 * is what yaml-language-server (and similar LSP-backed extensions)
 * use as the workspace root when resolving relative schema paths,
 * loading `.yamlrc`, etc.
 */

import { activeTabAtom } from "@/entities/tab/model/tabsAtoms";
import { basename } from "@/utils/path";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { useExtensionHostClient } from "./extensionHostClient";

function pathToFileUri(path: string): string {
  if (!path) return "";
  const encoded = path
    .split("/")
    .map((part) => (part ? encodeURIComponent(part) : part))
    .join("/");
  if (encoded.startsWith("/")) return `file://${encoded}`;
  return `file:///${encoded}`;
}

export function ExtensionHostWorkspaceSync(): null {
  const client = useExtensionHostClient();
  const activeTab = useAtomValue(activeTabAtom);
  const dirPath = activeTab?.type === "preview" ? activeTab.path : (activeTab?.path ?? "");

  useEffect(() => {
    if (!dirPath) {
      client.setWorkspaceFolders([]);
      return;
    }
    const uri = pathToFileUri(dirPath);
    const name = basename(dirPath) || dirPath;
    client.setWorkspaceFolders([{ uri, name }]);
  }, [client, dirPath]);

  return null;
}
