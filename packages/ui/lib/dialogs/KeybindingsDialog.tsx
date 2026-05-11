import { useDialog } from "@/dialogs/dialogContext";
import { extensionManifest, extensionRef } from "@/features/extensions/types";
import { useLoadedExtensions } from "@/features/extensions/useLoadedExtensions";
import { formatKeybinding, useCommandRegistry, type Command, type KeybindingLayer } from "@dotdirfm/commands";
import { cx } from "@dotdirfm/ui-utils";
import { useCallback, useMemo, useRef, useState } from "react";
import styles from "./KeybindingsDialog.module.css";
import { OverlayDialog } from "./OverlayDialog";

interface KeybindingsDialogProps {
  onClose: () => void;
}

const LAYER_LABELS: Record<KeybindingLayer, string> = {
  user: "User",
  extension: "Extension",
  default: "Built-in",
};

export function KeybindingsDialog({ onClose }: KeybindingsDialogProps) {
  const commandRegistry = useCommandRegistry();
  const { showDialog } = useDialog();
  const [search, setSearch] = useState("");
  const [sortByPrecedence, setSortByPrecedence] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const loadedExtensions = useLoadedExtensions();

  const sourceTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const ext of loadedExtensions) {
      const ref = extensionRef(ext);
      const manifest = extensionManifest(ext);
      const key = `${ref.publisher}.${ref.name}`;
      map.set(key, manifest.displayName || key);
    }
    return map;
  }, [loadedExtensions]);

  const allCommands = useMemo(() => commandRegistry.getAllCommands(), [commandRegistry]);
  const commandMap = useMemo(() => {
    const map = new Map<string, Command>();
    for (const c of allCommands) map.set(c.id, c);
    return map;
  }, [allCommands]);

  const bindingsByLayer = useMemo(() => {
    const layers: KeybindingLayer[] = ["user", "extension", "default"];
    return layers.map((layer) => ({
      layer,
      bindings: commandRegistry.getKeybindingsForLayer(layer),
    }));
  }, [commandRegistry]);

  const filteredRows = useMemo(() => {
    const q = search.toLowerCase();
      const rows: Array<{ command: string; title: string; keyParts: string[]; when: string; source: string; sourceKey?: string; layer: KeybindingLayer }> = [];

    for (const { layer, bindings } of bindingsByLayer) {
      for (const b of bindings) {
        if (!b.command) continue;
        const cmd = commandMap.get(b.command);
        const title = cmd?.title ?? b.command;
        if (q && !title.toLowerCase().includes(q) && !b.key.toLowerCase().includes(q) && !b.command.toLowerCase().includes(q)) continue;
        const sourceName = b.source ? (sourceTitles.get(b.source) ?? b.source) : LAYER_LABELS[layer];
        rows.push({
          command: b.command,
          title,
          keyParts: formatKeybinding(b),
          when: b.when ?? "",
          source: sourceName,
          sourceKey: b.source,
          layer,
        });
      }
    }

    if (sortByPrecedence) {
      const layerOrder: KeybindingLayer[] = ["user", "extension", "default"];
      rows.sort((a, b) => layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer));
    }

    return rows;
  }, [bindingsByLayer, commandMap, search, sortByPrecedence, sourceTitles]);

  const handleClearSearch = useCallback(() => {
    setSearch("");
    searchRef.current?.focus();
  }, []);

  const handleSourceClick = useCallback(
    (sourceKey: string) => {
      onClose();
      showDialog({ type: "extensions", activeExtensionKey: sourceKey });
    },
    [onClose, showDialog],
  );

  return (
    <OverlayDialog className={cx(styles, "keybindings-dialog")} onClose={onClose} initialFocusRef={searchRef} focusLayer="modal">
      <div className={styles["keybindings-header"]}>
        <div className={styles["keybindings-search"]}>
          <input
            ref={searchRef}
            type="text"
            placeholder="Type to search in keybindings"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (search) handleClearSearch();
                else onClose();
              }
            }}
            className={styles["keybindings-search-input"]}
          />
        </div>
        <div className={styles["keybindings-toolbar"]}>
          <button
            className={cx(styles, "keybindings-toolbar-button", sortByPrecedence && "active")}
            onClick={() => setSortByPrecedence((v) => !v)}
            title="Sort by Precedence (Highest first)"
          >
            Sort by Precedence
          </button>
          {search && (
            <button className={cx(styles, "keybindings-toolbar-button")} onClick={handleClearSearch} title="Clear Keybindings Search Input (Escape)">
              Clear
            </button>
          )}
        </div>
      </div>
      <div className={styles["keybindings-table-container"]}>
        <table className={styles["keybindings-table"]}>
          <thead>
            <tr>
              <th className={styles["col-keybinding"]}>Keybinding</th>
              <th className={styles["col-when"]}>When</th>
              <th className={styles["col-source"]}>Source</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row, i) => (
              <tr key={`${row.command}-${i}`}>
                <td className={styles["col-command"]} title={row.command}>
                  {row.title}
                </td>
                <td className={styles["col-keybinding"]}>
                  <span className={styles["keybinding-group"]}>
                    {row.keyParts.map((part, j) => (
                      <code key={j}>{part}</code>
                    ))}
                  </span>
                </td>
                <td className={styles["col-when"]}>
                  <code>{row.when || "—"}</code>
                </td>
                <td className={styles["col-source"]}>
                  {row.sourceKey ? (
                    <a className={styles["source-link"]} onClick={() => handleSourceClick(row.sourceKey!)} title={`Show ${row.source} extension`}>
                      {row.source}
                    </a>
                  ) : (
                    row.source
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </OverlayDialog>
  );
}
