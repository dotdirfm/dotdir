import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { showExtensionsAtom, activeIconThemeAtom, activeColorThemeAtom, loadedExtensionsAtom } from "../atoms";
import { focusContext } from "../focusContext";
import { useExtensionHostClient } from "../extensionHostClient";
import {
  type ExtensionRef,
  type MarketplaceExtension,
  searchMarketplace,
  installExtension,
  installVSCodeExtension,
  uninstallExtension,
  type LoadedExtension,
  extensionIconThemeId,
  colorThemeKey,
  readSettings,
  writeSettings,
} from "../extensions";
import {
  searchVSCodeMarketplace,
  type VSCodeExtension,
  getVSCodeInstallCount,
  getVSCodeLatestVersion,
  getVSCodeDownloadUrl,
  getVSCodeIconUrl,
} from "../vscodeMarketplace";
import { INPUT_NO_ASSIST } from "../inputNoAssist";
import { useBridge } from "../hooks/useBridge";

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
  const dialogRef = useRef<HTMLDialogElement>(null);
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

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    focusContext.push("modal");
    const handleClose = () => setShowExtensions(false);
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("close", handleClose);
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
      const settings = await readSettings(bridge);
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
      if (settingsChanged) await writeSettings(bridge, settings);
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
    const settings = await readSettings(bridge);
    if (newId) {
      settings.iconTheme = newId;
    } else {
      delete settings.iconTheme;
    }
    await writeSettings(bridge, settings);
    setActiveIconTheme(newId);
  };

  const handleSetColorTheme = async (ext: LoadedExtension, themeId: string) => {
    const key = colorThemeKey(ext, themeId);
    const newKey = key === activeColorTheme ? undefined : key;
    const settings = await readSettings(bridge);
    if (newKey) {
      settings.colorTheme = newKey;
    } else {
      delete settings.colorTheme;
    }
    await writeSettings(bridge, settings);
    setActiveColorTheme(newKey);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <dialog ref={dialogRef} className="ext-panel">
      <div className="ext-panel-header">
        <span className="ext-panel-title">Extensions</span>
        <button className="ext-panel-close" onClick={() => dialogRef.current?.close()}>
          ✕
        </button>
      </div>

      <div className="ext-panel-tabs">
        <button className={`ext-tab ${tab === "marketplace" ? "active" : ""}`} onClick={() => setTab("marketplace")}>
          Marketplace
        </button>
        <button className={`ext-tab ${tab === "installed" ? "active" : ""}`} onClick={() => setTab("installed")}>
          Installed ({installed.length})
        </button>
      </div>

      {tab === "marketplace" && (
        <div className="ext-search">
          <div className="ext-source-selector">
            <button
              className={`ext-source-btn ${marketplaceSource === "vscode" ? "active" : ""}`}
              onClick={() => {
                setMarketplaceSource("vscode");
                setQuery("");
              }}
            >
              VS Code
            </button>
            <button
              className={`ext-source-btn ${marketplaceSource === "dotdir" ? "active" : ""}`}
              onClick={() => {
                setMarketplaceSource("dotdir");
                setQuery("");
              }}
            >
              .dir
            </button>
          </div>
          <input
            type="text"
            placeholder="Search extensions..."
            value={query}
            onChange={(e) => handleSearchInput(e.target.value)}
            autoFocus
            {...INPUT_NO_ASSIST}
          />
        </div>
      )}

      {error && <div className="ext-error">{error}</div>}

      <div className="ext-list">
        {tab === "marketplace" &&
          marketplaceSource === "dotdir" &&
          (loading ? (
            <div className="ext-empty">Searching...</div>
          ) : results.length === 0 ? (
            <div className="ext-empty">No extensions found</div>
          ) : (
            results.map((ext) => {
              const key = `${ext.publisher.username}.${ext.name}`;
              const isInstalled = installedSet.has(key);
              const isBusy = installing === key;
              return (
                <div key={ext.id} className="ext-item">
                  <div className="ext-icon">
                    {ext.icon_url ? <img src={ext.icon_url} width={36} height={36} alt="" /> : (ext.display_name[0]?.toUpperCase() ?? "?")}
                  </div>
                  <div className="ext-info">
                    <div className="ext-name">{ext.display_name}</div>
                    <div className="ext-publisher">{ext.publisher.display_name || ext.publisher.username}</div>
                    <div className="ext-desc">{ext.description}</div>
                    <div className="ext-meta">
                      {ext.latest_version && <span>v{ext.latest_version.version}</span>}
                      {ext.latest_version && <span>{formatSize(ext.latest_version.archive_size)}</span>}
                      <span>↓ {ext.total_downloads}</span>
                    </div>
                  </div>
                  <div className="ext-actions">
                    {isInstalled ? (
                      <button className="ext-btn installed" disabled>
                        Installed
                      </button>
                    ) : (
                      <button className="ext-btn install" disabled={isBusy || !ext.latest_version} onClick={() => handleInstall(ext)}>
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
            <div className="ext-empty">Searching...</div>
          ) : vscodeResults.length === 0 ? (
            <div className="ext-empty">No extensions found</div>
          ) : (
            vscodeResults.map((ext) => {
              const key = `${ext.publisher.publisherName}.${ext.extensionName}`;
              const isInstalled = installedSet.has(key);
              const isBusy = installing === key;
              const version = getVSCodeLatestVersion(ext);
              const iconUrl = getVSCodeIconUrl(ext);
              const installs = getVSCodeInstallCount(ext);
              return (
                <div key={key} className="ext-item">
                  <div className="ext-icon">{iconUrl ? <img src={iconUrl} width={36} height={36} alt="" /> : (ext.displayName[0]?.toUpperCase() ?? "?")}</div>
                  <div className="ext-info">
                    <div className="ext-name">{ext.displayName}</div>
                    <div className="ext-publisher">{ext.publisher.displayName || ext.publisher.publisherName}</div>
                    <div className="ext-desc">{ext.shortDescription}</div>
                    <div className="ext-meta">
                      {version && <span>v{version}</span>}
                      <span>↓ {installs.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="ext-actions">
                    {isInstalled ? (
                      <button className="ext-btn installed" disabled>
                        Installed
                      </button>
                    ) : (
                      <button className="ext-btn install" disabled={isBusy || !version} onClick={() => handleVSCodeInstall(ext)}>
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
            <div className="ext-empty">No extensions installed</div>
          ) : (
            installed.map((ext) => {
              const key = `${ext.ref.publisher}.${ext.ref.name}`;
              const isBusy = installing === key;
              const iconThemeId = extensionIconThemeId(ext);
              const isActiveIconTheme = iconThemeId != null && iconThemeId === activeIconTheme;
              const hasColorThemes = ext.colorThemes && ext.colorThemes.length > 0;
              return (
                <div key={key} className="ext-item">
                  <div className="ext-icon">
                    {ext.iconUrl ? (
                      <img src={ext.iconUrl} width={36} height={36} alt="" />
                    ) : (
                      ((ext.manifest.displayName || ext.manifest.name)[0]?.toUpperCase() ?? "?")
                    )}
                  </div>
                  <div className="ext-info">
                    <div className="ext-name">{ext.manifest.displayName || ext.manifest.name}</div>
                    <div className="ext-publisher">{ext.manifest.publisher}</div>
                    <div className="ext-desc">{ext.manifest.description || ""}</div>
                    <div className="ext-meta">
                      <span>v{ext.ref.version}</span>
                      {iconThemeId && (
                        <span className={`ext-theme-badge${isActiveIconTheme ? " active" : ""}`}>{isActiveIconTheme ? "● Icon theme" : "Icon theme"}</span>
                      )}
                      {hasColorThemes && (
                        <span className="ext-theme-badge">
                          {ext.colorThemes!.length} color theme
                          {ext.colorThemes!.length > 1 ? "s" : ""}
                        </span>
                      )}
                      {ext.languages && ext.languages.length > 0 && (
                        <span className="ext-theme-badge">
                          {ext.languages.length} language{ext.languages.length > 1 ? "s" : ""}
                        </span>
                      )}
                      {ext.grammarRefs && ext.grammarRefs.length > 0 && (
                        <span className="ext-theme-badge">
                          {ext.grammarRefs.length} grammar{ext.grammarRefs.length > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    {hasColorThemes && (
                      <div className="ext-color-themes">
                        {ext.colorThemes!.map((ct) => {
                          const ctKey = colorThemeKey(ext, ct.id);
                          const isActive = ctKey === activeColorTheme;
                          return (
                            <button
                              key={ct.id}
                              className={`ext-btn ext-color-theme-btn ${isActive ? "installed" : "install"}`}
                              onClick={() => handleSetColorTheme(ext, ct.id)}
                            >
                              <span className="ext-color-theme-indicator" data-ui-theme={ct.uiTheme} />
                              {ct.label}
                              {isActive && " ●"}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="ext-actions">
                    {iconThemeId && (
                      <button className={`ext-btn ${isActiveIconTheme ? "installed" : "install"}`} onClick={() => handleSetIconTheme(ext)}>
                        {isActiveIconTheme ? "Deactivate" : "Activate"}
                      </button>
                    )}
                    <button className="ext-btn uninstall" disabled={isBusy} onClick={() => handleUninstall(ext.ref)}>
                      {isBusy ? "Removing..." : "Uninstall"}
                    </button>
                  </div>
                </div>
              );
            })
          ))}
      </div>
    </dialog>
  );
}
