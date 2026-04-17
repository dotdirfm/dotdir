import { OverlayDialog } from "@/dialogs/OverlayDialog";
import { List } from "@/components/List/List";
import { NestedPopoverMenu, type NestedPopoverMenuItem } from "@/components/NestedPopoverMenu/NestedPopoverMenu";
import { useSettingsCatalog } from "@/features/settings/useSettingsCatalog";
import { dotdirEffectiveValue, type SettingsEntry } from "@/features/settings/catalog";
import { useExtensionSettings } from "@/features/settings/useExtensionSettings";
import { useUserSettings } from "@/features/settings/useUserSettings";
import type { DotDirSettings } from "@/features/settings/types";
import { useEffect, useMemo, useState } from "react";
import { VscGear } from "react-icons/vsc";
import styles from "./SettingsDialog.module.css";

function readDotdirValue(settings: DotDirSettings, key: string): unknown {
  if (!key.includes(".")) return (settings as Record<string, unknown>)[key];
  const parts = key.split(".");
  let current: unknown = settings;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function writeDotdirValue(settings: DotDirSettings, updateSettings: (patch: Partial<DotDirSettings>) => void, key: string, value: unknown): void {
  switch (key) {
    case "showHidden":
      updateSettings({ showHidden: Boolean(value) });
      return;
    case "editorFileSizeLimit":
      updateSettings({ editorFileSizeLimit: typeof value === "number" ? value : 0 });
      return;
    case "colorTheme":
      updateSettings({ colorTheme: String(value || "") || undefined });
      return;
    case "iconTheme":
      updateSettings({ iconTheme: String(value || "") || undefined });
      return;
    case "extensions.autoUpdate":
      updateSettings({
        extensions: {
          ...settings.extensions,
          autoUpdate: Boolean(value),
        },
      });
      return;
    case "pathAliases":
      updateSettings({ pathAliases: typeof value === "object" && value ? (value as Record<string, string>) : {} });
      return;
    default:
      return;
  }
}

function resetDotdirValue(settings: DotDirSettings, updateSettings: (patch: Partial<DotDirSettings>) => void, key: string, defaultValue: unknown): void {
  switch (key) {
    case "showHidden":
      updateSettings({ showHidden: defaultValue as boolean });
      return;
    case "editorFileSizeLimit":
      updateSettings({ editorFileSizeLimit: defaultValue as number });
      return;
    case "colorTheme":
      updateSettings({ colorTheme: undefined });
      return;
    case "iconTheme":
      updateSettings({ iconTheme: undefined });
      return;
    case "extensions.autoUpdate":
      updateSettings({
        extensions: {
          ...settings.extensions,
          autoUpdate: defaultValue as boolean,
        },
      });
      return;
    case "pathAliases":
      updateSettings({ pathAliases: {} });
      return;
    default:
      return;
  }
}

function valueAsText(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function JsonEditor({
  initialValue,
  onApply,
}: {
  initialValue: unknown;
  onApply: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(initialValue ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(initialValue ?? {}, null, 2));
    setError(null);
  }, [initialValue]);

  return (
    <div className={styles.jsonEditor}>
      <textarea
        className={styles.jsonText}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
      />
      <div className={styles.row}>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => {
            try {
              const parsed = JSON.parse(text);
              setError(null);
              onApply(parsed);
            } catch {
              setError("Invalid JSON");
            }
          }}
        >
          Apply JSON
        </button>
        {error && <span className={styles.error}>{error}</span>}
      </div>
    </div>
  );
}

function SettingControl({
  entry,
  effectiveValue,
  onSet,
}: {
  entry: SettingsEntry;
  effectiveValue: unknown;
  onSet: (value: unknown) => void;
}) {
  if (entry.valueType === "boolean") {
    return (
      <label className={styles.checkboxLabel}>
        <input type="checkbox" checked={Boolean(effectiveValue)} onChange={(e) => onSet(e.target.checked)} />
        <span>Enabled</span>
      </label>
    );
  }

  if (entry.valueType === "number") {
    return (
      <input
        className={styles.input}
        type="number"
        value={typeof effectiveValue === "number" ? effectiveValue : Number(effectiveValue ?? 0)}
        min={entry.minimum}
        max={entry.maximum}
        onChange={(e) => onSet(Number(e.target.value))}
      />
    );
  }

  if (entry.valueType === "enum") {
    const options = entry.enumValues ?? [];
    return (
      <select className={styles.input} value={String(effectiveValue ?? "")} onChange={(e) => onSet(e.target.value)}>
        {options.map((value, idx) => (
          <option key={`${entry.key}-${idx}`} value={String(value)}>
            {entry.enumDescriptions?.[idx] || String(value)}
          </option>
        ))}
      </select>
    );
  }

  if (entry.valueType === "object" || entry.valueType === "array") {
    return <JsonEditor initialValue={effectiveValue} onApply={onSet} />;
  }

  return <input className={styles.input} type="text" value={String(effectiveValue ?? "")} onChange={(e) => onSet(e.target.value)} />;
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, updateSettings } = useUserSettings();
  const extSettings = useExtensionSettings();
  const [query, setQuery] = useState("");
  const { entries, groups } = useSettingsCatalog(query);
  const [selectedGroup, setSelectedGroup] = useState<string>("");

  useEffect(() => {
    if (!selectedGroup || !groups.includes(selectedGroup)) {
      setSelectedGroup(groups[0] ?? "");
    }
  }, [groups, selectedGroup]);

  const groupEntries = useMemo(() => entries.filter((entry) => entry.category === selectedGroup), [entries, selectedGroup]);
  const categoryItems = useMemo(() => groups.map((group) => ({ key: group, label: group })), [groups]);

  const setValue = (entry: SettingsEntry, value: unknown) => {
    if (entry.source === "dotdir") {
      writeDotdirValue(settings, updateSettings, entry.key, value);
      return;
    }
    extSettings.set(entry.key, value);
  };

  const resetValue = (entry: SettingsEntry) => {
    if (entry.source === "dotdir") {
      resetDotdirValue(settings, updateSettings, entry.key, entry.defaultValue);
      return;
    }
    extSettings.reset(entry.key);
  };

  const copyKey = async (entry: SettingsEntry) => {
    try {
      await navigator.clipboard.writeText(entry.key);
    } catch {
      // ignore
    }
  };

  return (
    <OverlayDialog className={styles.dialog} onClose={onClose} placement="top">
      <div className={styles.header}>
        <div className={styles.title}>Settings</div>
        <input autoFocus className={styles.search} placeholder="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <List
            items={categoryItems}
            getKey={(item) => item.key}
            activeKey={selectedGroup || null}
            onActiveKeyChange={setSelectedGroup}
            onActivate={setSelectedGroup}
            className={styles.groupList}
            renderItem={(item, { active }) => (
              <div className={active ? styles.groupActive : styles.group}>
                {item.label}
              </div>
            )}
          />
        </aside>
        <section className={styles.main}>
          <div className={styles.settingsPane}>
            {groupEntries.length === 0 && <div className={styles.empty}>No settings match your search.</div>}
            {groupEntries.map((entry) => {
              const effectiveValue =
                entry.source === "dotdir"
                  ? dotdirEffectiveValue(settings, entry)
                  : extSettings.get(entry.key) ?? entry.defaultValue;
              const userValue =
                entry.source === "dotdir"
                  ? readDotdirValue(settings, entry.key)
                  : extSettings.get(entry.key);
              const menuItems: NestedPopoverMenuItem[] = [
                {
                  id: `${entry.key}:reset`,
                  label: "Reset Setting",
                  onSelect: () => resetValue(entry),
                },
                {
                  id: `${entry.key}:copy-id`,
                  label: "Copy Setting ID",
                  onSelect: () => {
                    void copyKey(entry);
                  },
                },
                {
                  id: `${entry.key}:copy-json`,
                  label: "Copy Setting as JSON",
                  onSelect: () => {
                    const json = JSON.stringify({ [entry.key]: effectiveValue }, null, 2);
                    void navigator.clipboard.writeText(json).catch(() => {});
                  },
                },
              ];

              return (
                <div key={entry.key} className={styles.settingCard}>
                  <div className={styles.settingHeaderRow}>
                    <div className={styles.detailTitle}>{entry.title}</div>
                    <NestedPopoverMenu
                      items={menuItems}
                      placement="bottom-end"
                      popoverClassName={styles.settingMenu}
                      renderAnchor={({ ref, id, open, toggle }) => (
                        <button
                          ref={ref as React.RefObject<HTMLButtonElement | null>}
                          id={id}
                          type="button"
                          className={styles.settingMenuButton}
                          aria-haspopup="menu"
                          aria-expanded={open}
                          aria-label={`Open menu for ${entry.title}`}
                          onClick={toggle}
                        >
                          <VscGear aria-hidden="true" />
                        </button>
                      )}
                    />
                  </div>
                  <div className={styles.detailKey}>{entry.key}</div>
                  {entry.description && <div className={styles.description}>{entry.description}</div>}
                  <SettingControl entry={entry} effectiveValue={effectiveValue} onSet={(value) => setValue(entry, value)} />
                  <div className={styles.metaBlock}>
                    <div>Source: {entry.sourceLabel}</div>
                    <div>Default: {valueAsText(entry.defaultValue)}</div>
                    <div>User: {valueAsText(userValue)}</div>
                    <div>Effective: {valueAsText(effectiveValue)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
      {!extSettings.ready && <div className={styles.footer}>Loading extension settings...</div>}
      <div className={styles.footer}>
        <button type="button" className={styles.primaryButton} onClick={onClose}>
          Close
        </button>
      </div>
    </OverlayDialog>
  );
}

