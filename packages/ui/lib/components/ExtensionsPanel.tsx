import { activeColorThemeAtom, activeIconThemeAtom, loadedExtensionsAtom, showExtensionsAtom } from "@/atoms";
import { useBridge } from "@/features/bridge/useBridge";
import { useExtensionHostClient } from "@/features/extensions/extensionHostClient";
import {
  type ExtensionRef,
  type LoadedExtension,
  type MarketplaceExtension,
  colorThemeKey,
  extensionIconThemeId,
  installExtension,
  installVSCodeExtension,
  searchMarketplace,
  uninstallExtension,
} from "@/features/extensions/extensions";
import {
  type VSCodeExtension,
  getVSCodeDownloadUrl,
  getVSCodeIconUrl,
  getVSCodeInstallCount,
  getVSCodeLatestVersion,
  searchVSCodeMarketplace,
} from "@/features/marketplace/vscodeMarketplace";
import { useUserSettings } from "@/features/settings/useUserSettings";
import { focusContext } from "@/focusContext";
import { INPUT_NO_ASSIST } from "@/utils/inputNoAssist";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../styles/extensions.module.css";
import { cx } from "../utils/cssModules";
import { OverlayDialog } from "../dialogs/OverlayDialog";

/** Extract a message from Tauri invoke errors (plain {errno,message} objects) or Error instances. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

type Tab = "marketplace" | "installed";
type MarketplaceSource = "dotdir" | "vscode";

export function ExtensionsPanel() {
  const bridge = useBridge();
  const setShowExtensions = useSetAtom(showExtensionsAtom);
  const [activeIconTheme, setActiveIconTheme] = useAtom(activeIconThemeAtom);
  const [activeColorTheme, setActiveColorTheme] = useAtom(activeColorThemeAtom);
  const installed = useAtomValue(loadedExtensionsAtom);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const extensionHost = useExtensionHostClient();
  const [tab, setTab] = useState<Tab>("marketplace");
  const [marketplaceSource, setMarketplaceSource] = useState<MarketplaceSource>("vscode");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketplaceExtension[]>([]);
  const [vscodeResults, setVscodeResults] = useState<VSCodeExtension[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const{settings,updateSettings} = useUserSettings();

  useEffect(() => {
    focusContext.push("modal");
    return () => {
      focusContext.pop("modal");
    };
  }, [setShowExtensions]);

  const doSearch = useCallback(async (q: string, source: MarketplaceSource) => {
    setLoading(true);
    setError("");
    try {
      if (source === "vscode") {
        const data = await searchVSCodeMarketplace(q);
        setVscodeResults(data.extensions);
        setResults([]);
      } else {
        const data = await searchMarketplace(q);
        setResults(data.extensions);
        setVscodeResults([]);
      }
    } catch {
      setError(`Could not reach ${source === "vscode" ? "VS Code" : ".dir"} marketplace`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    doSearch("", marketplaceSource);
  }, [doSearch, marketplaceSource]);

  const handleSearchInput = (value: string) => {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => doSearch(value, marketplaceSource), 300);
  };

  const handleVSCodeInstall = async (ext: VSCodeExtension) => {
    const downloadUrl = getVSCodeDownloadUrl(ext);
    if (!downloadUrl) return;
    const key = `${ext.publisher.publisherName}.${ext.extensionName}`;
    setInstalling(key);
    setError("");
    try {
      await installVSCodeExtension(bridge, ext.publisher.publisherName, ext.extensionName, downloadUrl);
      void extensionHost.restart();
    } catch (err) {
      setError(`Install failed: ${errMsg(err)}`);
    }
    setInstalling(null);
  };

  const installedSet = new Set(installed.map((e) => `${e.ref.publisher}.${e.ref.name}`));

  const handleInstall = async (ext: MarketplaceExtension) => {
    if (!ext.latest_version) return;
    const key = `${ext.publisher.username}.${ext.name}`;
    setInstalling(key);
    setError("");
    try {
      await installExtension(bridge, ext.publisher.username, ext.name, ext.latest_version.version);
      void extensionHost.restart();
    } catch (err) {
      setError(`Install failed: ${errMsg(err)}`);
    }
    setInstalling(null);
  };

  const handleUninstall = async (ref: ExtensionRef) => {
    const key = `${ref.publisher}.${ref.name}`;
    setInstalling(key);
    setError("");
    try {
      await uninstallExtension(bridge, ref.publisher, ref.name);
      let settingsChanged = false;
      if (activeIconTheme === key) {
        delete settings.iconTheme;
        setActiveIconTheme(undefined);
        settingsChanged = true;
      }
      if (activeColorTheme?.startsWith(key + ":")) {
        delete settings.colorTheme;
        setActiveColorTheme(undefined);
        settingsChanged = true;
      }
      if (settingsChanged) updateSettings(settings);
      void extensionHost.restart();
    } catch (err) {
      setError(`Uninstall failed: ${errMsg(err)}`);
    }
    setInstalling(null);
  };

  const handleSetIconTheme = async (ext: LoadedExtension) => {
    const themeId = extensionIconThemeId(ext);
    if (!themeId) return;
    const newId = themeId === activeIconTheme ? undefined : themeId;
    if (newId) {
      settings.iconTheme = newId;
    } else {
      delete settings.iconTheme;
    }
    updateSettings(settings);
    setActiveIconTheme(newId);
  };

  const handleSetColorTheme = async (ext: LoadedExtension, themeId: string) => {
    const key = colorThemeKey(ext, themeId);
    const newKey = key === activeColorTheme ? undefined : key;
    if (newKey) {
      settings.colorTheme = newKey;
    } else {
      delete settings.colorTheme;
    }
    updateSettings(settings);
    setActiveColorTheme(newKey);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <OverlayDialog className={styles["ext-panel"]} onClose={() => setShowExtensions(false)} initialFocusRef={searchInputRef}>
      <div className={styles["ext-panel-header"]}>
        <span className={styles["ext-panel-title"]}>Extensions</span>
        <button className={styles["ext-panel-close"]} onClick={() => setShowExtensions(false)}>
          ✕
        </button>
      </div>

      <div className={styles["ext-panel-tabs"]}>
        <button className={cx(styles, "ext-tab", tab === "marketplace" && "active")} onClick={() => setTab("marketplace")}>
          Marketplace
        </button>
        <button className={cx(styles, "ext-tab", tab === "installed" && "active")} onClick={() => setTab("installed")}>
          Installed ({installed.length})
        </button>
      </div>

      {tab === "marketplace" && (
        <div className={styles["ext-search"]}>
          <div className={styles["ext-source-selector"]}>
            <button
              className={cx(styles, "ext-source-btn", marketplaceSource === "vscode" && "active")}
              onClick={() => {
                setMarketplaceSource("vscode");
                setQuery("");
              }}
            >
              VS Code
            </button>
            <button
              className={cx(styles, "ext-source-btn", marketplaceSource === "dotdir" && "active")}
              onClick={() => {
                setMarketplaceSource("dotdir");
                setQuery("");
              }}
            >
              .dir
            </button>
          </div>
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search extensions..."
            value={query}
            onChange={(e) => handleSearchInput(e.target.value)}
            {...INPUT_NO_ASSIST}
          />
        </div>
      )}

      {error && <div className={styles["ext-error"]}>{error}</div>}

      <div className={styles["ext-list"]}>
        {tab === "marketplace" &&
          marketplaceSource === "dotdir" &&
          (loading ? (
            <div className={styles["ext-empty"]}>Searching...</div>
          ) : results.length === 0 ? (
            <div className={styles["ext-empty"]}>No extensions found</div>
          ) : (
            results.map((ext) => {
              const key = `${ext.publisher.username}.${ext.name}`;
              const isInstalled = installedSet.has(key);
              const isBusy = installing === key;
              return (
                <div key={ext.id} className={styles["ext-item"]}>
                  <div className={styles["ext-icon"]}>
                    {ext.icon_url ? <img src={ext.icon_url} width={36} height={36} alt="" /> : (ext.display_name[0]?.toUpperCase() ?? "?")}
                  </div>
                  <div className={styles["ext-info"]}>
                    <div className={styles["ext-name"]}>{ext.display_name}</div>
                    <div className={styles["ext-publisher"]}>{ext.publisher.display_name || ext.publisher.username}</div>
                    <div className={styles["ext-desc"]}>{ext.description}</div>
                    <div className={styles["ext-meta"]}>
                      {ext.latest_version && <span>v{ext.latest_version.version}</span>}
                      {ext.latest_version && <span>{formatSize(ext.latest_version.archive_size)}</span>}
                      <span>↓ {ext.total_downloads}</span>
                    </div>
                  </div>
                  <div className={styles["ext-actions"]}>
                    {isInstalled ? (
                      <button className={cx(styles, "ext-btn", "installed")} disabled>
                        Installed
                      </button>
                    ) : (
                      <button className={cx(styles, "ext-btn", "install")} disabled={isBusy || !ext.latest_version} onClick={() => handleInstall(ext)}>
                        {isBusy ? "Installing..." : "Install"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          ))}

        {tab === "marketplace" &&
          marketplaceSource === "vscode" &&
          (loading ? (
            <div className={styles["ext-empty"]}>Searching...</div>
          ) : vscodeResults.length === 0 ? (
            <div className={styles["ext-empty"]}>No extensions found</div>
          ) : (
            vscodeResults.map((ext) => {
              const key = `${ext.publisher.publisherName}.${ext.extensionName}`;
              const isInstalled = installedSet.has(key);
              const isBusy = installing === key;
              const version = getVSCodeLatestVersion(ext);
              const iconUrl = getVSCodeIconUrl(ext);
              const installs = getVSCodeInstallCount(ext);
              return (
                <div key={key} className={styles["ext-item"]}>
                  <div className={styles["ext-icon"]}>{iconUrl ? <img src={iconUrl} width={36} height={36} alt="" /> : (ext.displayName[0]?.toUpperCase() ?? "?")}</div>
                  <div className={styles["ext-info"]}>
                    <div className={styles["ext-name"]}>{ext.displayName}</div>
                    <div className={styles["ext-publisher"]}>{ext.publisher.displayName || ext.publisher.publisherName}</div>
                    <div className={styles["ext-desc"]}>{ext.shortDescription}</div>
                    <div className={styles["ext-meta"]}>
                      {version && <span>v{version}</span>}
                      <span>↓ {installs.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className={styles["ext-actions"]}>
                    {isInstalled ? (
                      <button className={cx(styles, "ext-btn", "installed")} disabled>
                        Installed
                      </button>
                    ) : (
                      <button className={cx(styles, "ext-btn", "install")} disabled={isBusy || !version} onClick={() => handleVSCodeInstall(ext)}>
                        {isBusy ? "Installing..." : "Install"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          ))}

        {tab === "installed" &&
          (installed.length === 0 ? (
            <div className={styles["ext-empty"]}>No extensions installed</div>
          ) : (
            installed.map((ext) => {
              const key = `${ext.ref.publisher}.${ext.ref.name}`;
              const isBusy = installing === key;
              const iconThemeId = extensionIconThemeId(ext);
              const isActiveIconTheme = iconThemeId != null && iconThemeId === activeIconTheme;
              const hasColorThemes = ext.colorThemes && ext.colorThemes.length > 0;
              return (
                <div key={key} className={styles["ext-item"]}>
                  <div className={styles["ext-icon"]}>
                    {ext.iconUrl ? (
                      <img src={ext.iconUrl} width={36} height={36} alt="" />
                    ) : (
                      ((ext.manifest.displayName || ext.manifest.name)[0]?.toUpperCase() ?? "?")
                    )}
                  </div>
                  <div className={styles["ext-info"]}>
                    <div className={styles["ext-name"]}>{ext.manifest.displayName || ext.manifest.name}</div>
                    <div className={styles["ext-publisher"]}>{ext.manifest.publisher}</div>
                    <div className={styles["ext-desc"]}>{ext.manifest.description || ""}</div>
                    <div className={styles["ext-meta"]}>
                      <span>v{ext.ref.version}</span>
                      {iconThemeId && (
                        <span className={cx(styles, "ext-theme-badge", isActiveIconTheme && "active")}>{isActiveIconTheme ? "● Icon theme" : "Icon theme"}</span>
                      )}
                      {hasColorThemes && (
                        <span className={styles["ext-theme-badge"]}>
                          {ext.colorThemes!.length} color theme
                          {ext.colorThemes!.length > 1 ? "s" : ""}
                        </span>
                      )}
                      {ext.languages && ext.languages.length > 0 && (
                        <span className={styles["ext-theme-badge"]}>
                          {ext.languages.length} language{ext.languages.length > 1 ? "s" : ""}
                        </span>
                      )}
                      {ext.grammarRefs && ext.grammarRefs.length > 0 && (
                        <span className={styles["ext-theme-badge"]}>
                          {ext.grammarRefs.length} grammar{ext.grammarRefs.length > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    {hasColorThemes && (
                      <div className={styles["ext-color-themes"]}>
                        {ext.colorThemes!.map((ct) => {
                          const ctKey = colorThemeKey(ext, ct.id);
                          const isActive = ctKey === activeColorTheme;
                          return (
                            <button
                              key={ct.id}
                              className={cx(styles, "ext-btn", "ext-color-theme-btn", isActive ? "installed" : "install")}
                              onClick={() => handleSetColorTheme(ext, ct.id)}
                            >
                              <span className={styles["ext-color-theme-indicator"]} data-ui-theme={ct.uiTheme} />
                              {ct.label}
                              {isActive && " ●"}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className={styles["ext-actions"]}>
                    {iconThemeId && (
                      <button className={cx(styles, "ext-btn", isActiveIconTheme ? "installed" : "install")} onClick={() => handleSetIconTheme(ext)}>
                        {isActiveIconTheme ? "Deactivate" : "Activate"}
                      </button>
                    )}
                    <button className={cx(styles, "ext-btn", "uninstall")} disabled={isBusy} onClick={() => handleUninstall(ext.ref)}>
                      {isBusy ? "Removing..." : "Uninstall"}
                    </button>
                  </div>
                </div>
              );
            })
          ))}
      </div>
    </OverlayDialog>
  );
}
