import { useCallback, useEffect, useRef, useState } from 'react';
import { focusContext } from './focusContext';
import {
  type ExtensionRef,
  type MarketplaceExtension,
  searchMarketplace,
  installExtension,
  installVSCodeExtension,
  uninstallExtension,
  loadExtensions,
  type LoadedExtension,
  extensionIconThemeId,
  readSettings,
  writeSettings,
} from './extensions';
import {
  searchVSCodeMarketplace,
  type VSCodeExtension,
  getVSCodeInstallCount,
  getVSCodeLatestVersion,
  getVSCodeDownloadUrl,
  getVSCodeIconUrl,
} from './vscodeMarketplace';

interface Props {
  onClose: () => void;
  onExtensionsChanged: () => void;
  activeIconTheme?: string;
  onIconThemeChange: (themeId: string | undefined) => void;
}

type Tab = 'marketplace' | 'installed';
type MarketplaceSource = 'faraday' | 'vscode';

export function ExtensionsPanel({ onClose, onExtensionsChanged, activeIconTheme, onIconThemeChange }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>('marketplace');
  const [marketplaceSource, setMarketplaceSource] = useState<MarketplaceSource>('vscode');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MarketplaceExtension[]>([]);
  const [vscodeResults, setVscodeResults] = useState<VSCodeExtension[]>([]);
  const [installed, setInstalled] = useState<LoadedExtension[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    focusContext.push('modal');
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('close', handleClose);
      focusContext.pop('modal');
    };
  }, [onClose]);

  const refreshInstalled = useCallback(async () => {
    try {
      const exts = await loadExtensions();
      setInstalled(exts);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refreshInstalled(); }, [refreshInstalled]);

  const doSearch = useCallback(async (q: string, source: MarketplaceSource) => {
    setLoading(true);
    setError('');
    try {
      if (source === 'vscode') {
        const data = await searchVSCodeMarketplace(q);
        setVscodeResults(data.extensions);
        setResults([]);
      } else {
        const data = await searchMarketplace(q);
        setResults(data.extensions);
        setVscodeResults([]);
      }
    } catch {
      setError(`Could not reach ${source === 'vscode' ? 'VS Code' : 'Faraday'} marketplace`);
    }
    setLoading(false);
  }, []);

  useEffect(() => { doSearch('', marketplaceSource); }, [doSearch, marketplaceSource]);

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
    setError('');
    try {
      await installVSCodeExtension(ext.publisher.publisherName, ext.extensionName, downloadUrl);
      await refreshInstalled();
      onExtensionsChanged();
    } catch (err) {
      setError(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setInstalling(null);
  };

  const installedSet = new Set(installed.map(e => `${e.ref.publisher}.${e.ref.name}`));

  const handleInstall = async (ext: MarketplaceExtension) => {
    if (!ext.latest_version) return;
    const key = `${ext.publisher.username}.${ext.name}`;
    setInstalling(key);
    setError('');
    try {
      await installExtension(ext.publisher.username, ext.name, ext.latest_version.version);
      await refreshInstalled();
      onExtensionsChanged();
    } catch (err) {
      setError(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setInstalling(null);
  };

  const handleUninstall = async (ref: ExtensionRef) => {
    const key = `${ref.publisher}.${ref.name}`;
    setInstalling(key);
    setError('');
    try {
      await uninstallExtension(ref.publisher, ref.name);
      if (activeIconTheme === key) {
        const settings = await readSettings();
        delete settings.iconTheme;
        await writeSettings(settings);
        onIconThemeChange(undefined);
      }
      await refreshInstalled();
      onExtensionsChanged();
    } catch (err) {
      setError(`Uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setInstalling(null);
  };

  const handleSetIconTheme = async (ext: LoadedExtension) => {
    const themeId = extensionIconThemeId(ext);
    if (!themeId) return;
    const newId = themeId === activeIconTheme ? undefined : themeId;
    const settings = await readSettings();
    if (newId) {
      settings.iconTheme = newId;
    } else {
      delete settings.iconTheme;
    }
    await writeSettings(settings);
    onIconThemeChange(newId);
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
        <button className="ext-panel-close" onClick={() => dialogRef.current?.close()}>✕</button>
      </div>

      <div className="ext-panel-tabs">
        <button className={`ext-tab ${tab === 'marketplace' ? 'active' : ''}`} onClick={() => setTab('marketplace')}>
          Marketplace
        </button>
        <button className={`ext-tab ${tab === 'installed' ? 'active' : ''}`} onClick={() => setTab('installed')}>
          Installed ({installed.length})
        </button>
      </div>

      {tab === 'marketplace' && (
        <div className="ext-search">
          <div className="ext-source-selector">
            <button
              className={`ext-source-btn ${marketplaceSource === 'vscode' ? 'active' : ''}`}
              onClick={() => { setMarketplaceSource('vscode'); setQuery(''); }}
            >
              VS Code
            </button>
            <button
              className={`ext-source-btn ${marketplaceSource === 'faraday' ? 'active' : ''}`}
              onClick={() => { setMarketplaceSource('faraday'); setQuery(''); }}
            >
              Faraday
            </button>
          </div>
          <input
            type="text"
            placeholder="Search extensions..."
            value={query}
            onChange={(e) => handleSearchInput(e.target.value)}
            autoFocus
          />
        </div>
      )}

      {error && <div className="ext-error">{error}</div>}

      <div className="ext-list">
        {tab === 'marketplace' && marketplaceSource === 'faraday' && (
          loading ? (
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
                    {ext.icon_url
                      ? <img src={ext.icon_url} width={36} height={36} alt="" />
                      : ext.display_name[0]?.toUpperCase() ?? '?'}
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
                      <button className="ext-btn installed" disabled>Installed</button>
                    ) : (
                      <button
                        className="ext-btn install"
                        disabled={isBusy || !ext.latest_version}
                        onClick={() => handleInstall(ext)}
                      >
                        {isBusy ? 'Installing...' : 'Install'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )
        )}

        {tab === 'marketplace' && marketplaceSource === 'vscode' && (
          loading ? (
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
                  <div className="ext-icon">
                    {iconUrl
                      ? <img src={iconUrl} width={36} height={36} alt="" />
                      : ext.displayName[0]?.toUpperCase() ?? '?'}
                  </div>
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
                      <button className="ext-btn installed" disabled>Installed</button>
                    ) : (
                      <button
                        className="ext-btn install"
                        disabled={isBusy || !version}
                        onClick={() => handleVSCodeInstall(ext)}
                      >
                        {isBusy ? 'Installing...' : 'Install'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )
        )}

        {tab === 'installed' && (
          installed.length === 0 ? (
            <div className="ext-empty">No extensions installed</div>
          ) : (
            installed.map((ext) => {
              const key = `${ext.ref.publisher}.${ext.ref.name}`;
              const isBusy = installing === key;
              const themeId = extensionIconThemeId(ext);
              const isActiveTheme = themeId != null && themeId === activeIconTheme;
              return (
                <div key={key} className="ext-item">
                  <div className="ext-icon">
                    {ext.iconUrl
                      ? <img src={ext.iconUrl} width={36} height={36} alt="" />
                      : (ext.manifest.displayName || ext.manifest.name)[0]?.toUpperCase() ?? '?'}
                  </div>
                  <div className="ext-info">
                    <div className="ext-name">{ext.manifest.displayName || ext.manifest.name}</div>
                    <div className="ext-publisher">{ext.manifest.publisher}</div>
                    <div className="ext-desc">{ext.manifest.description || ''}</div>
                    <div className="ext-meta">
                      <span>v{ext.ref.version}</span>
                      {themeId && (
                        <span className={`ext-theme-badge${isActiveTheme ? ' active' : ''}`}>
                          {isActiveTheme ? '● Active theme' : 'Icon theme'}
                        </span>
                      )}
                      {ext.languages && ext.languages.length > 0 && (
                        <span className="ext-theme-badge">
                          {ext.languages.length} language{ext.languages.length > 1 ? 's' : ''}
                        </span>
                      )}
                      {ext.grammars && ext.grammars.length > 0 && (
                        <span className="ext-theme-badge">
                          {ext.grammars.length} grammar{ext.grammars.length > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="ext-actions">
                    {themeId && (
                      <button
                        className={`ext-btn ${isActiveTheme ? 'installed' : 'install'}`}
                        onClick={() => handleSetIconTheme(ext)}
                      >
                        {isActiveTheme ? 'Deactivate' : 'Activate'}
                      </button>
                    )}
                    <button
                      className="ext-btn uninstall"
                      disabled={isBusy}
                      onClick={() => handleUninstall(ext.ref)}
                    >
                      {isBusy ? 'Removing...' : 'Uninstall'}
                    </button>
                  </div>
                </div>
              );
            })
          )
        )}
      </div>
    </dialog>
  );
}
