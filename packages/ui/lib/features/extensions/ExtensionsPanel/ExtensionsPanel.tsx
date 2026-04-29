import { DropdownSelect, type DropdownSelectOption } from "@/components/DropdownSelect/DropdownSelect";
import { List } from "@/components/List/List";
import { NestedPopoverMenu, type NestedPopoverMenuItem } from "@/components/NestedPopoverMenu/NestedPopoverMenu";
import { Tabs, type TabsItem } from "@/components/Tabs/Tabs";
import { OverlayDialog } from "@/dialogs/OverlayDialog";
import { SmartLabel } from "@/dialogs/dialogHotkeys";
import type { ExtensionInstallProgressEvent } from "@dotdirfm/ui-bridge";
import { readAppDirs } from "@dotdirfm/ui-bridge";
import { useBridge } from "@dotdirfm/ui-bridge";
import { useExtensionHostClient } from "@/features/extensions/extensionHostClient";
import { colorThemeKey, extensionIconThemeKey, setExtensionAutoUpdate, uninstallExtension } from "@/features/extensions/extensions";
import { getMarketplaceProvider, type MarketplaceDetails, type MarketplaceProviderId, type MarketplaceSearchItem } from "@/features/extensions/marketplaces";
import { compareExtensionVersions, fetchDotDirExtensionDetails } from "@/features/extensions/marketplaces/dotdir";
import {
  extensionColorThemes,
  extensionCommands,
  extensionDirPath,
  extensionEditors,
  extensionFsProviders,
  extensionGrammarRefs,
  extensionIconThemes,
  extensionKeybindings,
  extensionLanguages,
  extensionManifest,
  extensionRef,
  extensionShellIntegrations,
  extensionViewers,
  type LoadedExtension,
} from "@/features/extensions/types";
import { useLoadedExtensions, useSetLoadedExtensions } from "@/features/extensions/useLoadedExtensions";
import { readFileText } from "@/features/file-system/fs";
import { useVfsUrlResolver } from "@/features/file-system/vfs";
import { useActiveColorTheme, useActiveIconTheme } from "@/features/settings/useUserSettings";
import { cx } from "@dotdirfm/ui-utils";
import { INPUT_NO_ASSIST } from "@dotdirfm/ui-utils";
import { join } from "@dotdirfm/ui-utils";
import { marked } from "marked";
import { type MouseEvent as ReactMouseEvent, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaGithub } from "react-icons/fa6";
import { VscArrowLeft, VscChevronDown, VscCloudDownload, VscStarEmpty, VscStarFull, VscVerifiedFilled } from "react-icons/vsc";
import styles from "./ExtensionsPanel.module.css";

type MarketplaceSource = MarketplaceProviderId;
type InstallPhase = "download" | "extract" | "write" | "finalize";
type BusyState = { kind: "install"; phase: InstallPhase } | { kind: "uninstall" };
type FilterKind = "none" | "featured" | "recent" | "recommended" | "category";
type ContentTab = "details" | "features" | "changelog";

const DEFAULT_VSCODE_CATEGORIES = [
  "Programming Languages",
  "Snippets",
  "Linters",
  "Themes",
  "Formatters",
  "Keymaps",
  "Debuggers",
  "SCM Providers",
  "Other",
  "Extension Packs",
  "Language Packs",
  "Data Science",
  "Machine Learning",
  "Visualization",
  "Notebooks",
  "Testing",
];

type SidebarItem =
  | {
      kind: "installed";
      key: string;
      title: string;
      publisher: string;
      description: string;
      version: string;
      iconUrl: string | null;
      downloads: number | null;
      rating: number | null;
      categories: string[];
      tags: string[];
      source: "installed";
      loaded: LoadedExtension;
    }
  | {
      kind: "marketplace";
      key: string;
      title: string;
      publisher: string;
      description: string;
      version: string;
      iconUrl: string | null;
      downloads: number | null;
      rating: number | null;
      categories: string[];
      tags: string[];
      publishedAt: string | null;
      source: MarketplaceSource;
      remote: MarketplaceSearchItem;
    };

type LoadedDocs = {
  readme: string | null;
  changelog: string | null;
};

type RenderedDocs = {
  detailsSource: string | null;
  changelogSource: string | null;
  detailsHtml: string | null;
  changelogHtml: string | null;
};

type RemoteMetadata = MarketplaceDetails & {
  readme: string | null;
  changelog: string | null;
};

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

function keyForInstalled(ext: LoadedExtension): string {
  const ref = extensionRef(ext);
  return `${ref.publisher}.${ref.name}`;
}

function normalizeInstalled(ext: LoadedExtension, resolveVfsUrl: (absPath: string) => string): SidebarItem {
  const manifest = extensionManifest(ext);
  const ref = extensionRef(ext);
  const iconPath = manifest.icon ? join(extensionDirPath(ext), manifest.icon.replace(/^\/+/, "")) : null;
  return {
    kind: "installed",
    key: keyForInstalled(ext),
    title: manifest.displayName || manifest.name,
    publisher: manifest.publisher,
    description: manifest.description || "",
    version: ref.version,
    iconUrl: iconPath ? resolveVfsUrl(iconPath) : null,
    downloads: null,
    rating: null,
    categories: [],
    tags: [],
    source: "installed",
    loaded: ext,
  };
}

function normalizeMarketplaceItem(ext: MarketplaceSearchItem): SidebarItem {
  return {
    kind: "marketplace",
    key: ext.key,
    title: ext.title,
    publisher: ext.publisherDisplayName || ext.publisher,
    description: ext.description,
    version: ext.version,
    iconUrl: ext.iconUrl,
    downloads: ext.downloads,
    rating: ext.rating,
    categories: ext.categories,
    tags: ext.tags,
    publishedAt: ext.publishedAt,
    source: ext.provider,
    remote: ext,
  };
}

function formatNumber(value: number | null): string {
  return value == null ? "Unavailable" : value.toLocaleString();
}

function formatHostLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function formatFilterLabel(kind: FilterKind, category: string | null): string {
  switch (kind) {
    case "featured":
      return "Featured";
    case "recent":
      return "Recently Published";
    case "recommended":
      return "Recommended";
    case "category":
      return category ? `Category: ${category}` : "Category";
    default:
      return "Installed";
  }
}

async function tryReadOptionalDoc(bridge: ReturnType<typeof useBridge>, dirPath: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    const path = join(dirPath, name);
    if (await bridge.fs.exists(path)) {
      return readFileText(bridge, path);
    }
  }
  return null;
}

function renderFeatureGroup(label: string, items: string[]) {
  if (items.length === 0) return null;
  return (
    <section key={label} className={styles["ext-feature-group"]}>
      <h3>{label}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function isProbablyHtml(value: string | null): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return /^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed) || /^<body[\s>]/i.test(trimmed) || /^<div[\s>]/i.test(trimmed);
}

function toOpenVsxContentUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/api\/([^/]+)\/([^/]+)\/(.+)\/file\/([^/]+)$/);
    if (!match) return url;
    const [, namespace, name, versionPath, fileName] = match;
    return `https://openvsx.eclipsecontent.org/${namespace}/${name}/${versionPath}/${fileName}`;
  } catch {
    return url;
  }
}

async function fetchRemoteText(url: string, options?: { openVsx?: boolean }): Promise<string | null> {
  const candidates = options?.openVsx ? [toOpenVsxContentUrl(url), url] : [url];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate);
      if (!response.ok) continue;
      return await response.text();
    } catch {
      continue;
    }
  }
  return null;
}

function formatRelativeDate(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  const diffMs = timestamp - Date.now();
  const absMs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 365 * day;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (absMs >= year) return rtf.format(Math.round(diffMs / year), "year");
  if (absMs >= month) return rtf.format(Math.round(diffMs / month), "month");
  if (absMs >= day) return rtf.format(Math.round(diffMs / day), "day");
  if (absMs >= hour) return rtf.format(Math.round(diffMs / hour), "hour");
  return rtf.format(Math.round(diffMs / minute), "minute");
}

function renderStars(rating: number | null, reviewCount: number | null, loading = false) {
  if (loading) return null;
  if (rating == null) return <span className={styles["ext-meta-muted"]}>No ratings</span>;
  const rounded = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span className={styles["ext-stars"]} title={`${rating.toFixed(1)} / 5`}>
      {Array.from({ length: 5 }, (_, index) =>
        index < rounded ? <VscStarFull key={index} aria-hidden="true" /> : <VscStarEmpty key={index} aria-hidden="true" />,
      )}
      <span className={styles["ext-stars-count"]}>({reviewCount ?? 0})</span>
    </span>
  );
}

function openVsxExtensionUrl(namespace: string, name: string): string {
  return `https://open-vsx.org/extension/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
}

function openVsxNamespaceUrl(namespace: string): string {
  return `https://open-vsx.org/namespace/${encodeURIComponent(namespace)}`;
}

function featureSectionsForInstalled(ext: LoadedExtension): Array<{ label: string; items: string[] }> {
  const commands = extensionCommands(ext).map((item) => item.title || item.command);
  const keybindings = extensionKeybindings(ext).map((item) => `${item.key} → ${item.command}`);
  const viewers = extensionViewers(ext).map((item) => item.label);
  const editors = extensionEditors(ext).map((item) => item.label);
  const fsProviders = extensionFsProviders(ext).map((item) => item.label);
  const languages = extensionLanguages(ext).map((item) => item.aliases?.[0] ?? item.id);
  const grammars = extensionGrammarRefs(ext).map((item) => item.contribution.scopeName);
  const shells = extensionShellIntegrations(ext).map((item) => item.label);
  const iconThemes = extensionIconThemes(ext).map((item) => (item.kind === "vscode" && item.sourceId ? `${item.label} (${item.sourceId})` : item.label));
  const colorThemes = extensionColorThemes(ext).map((item) => item.label);

  return [
    { label: "Icon Themes", items: iconThemes },
    { label: "Color Themes", items: colorThemes },
    { label: "Languages", items: languages },
    { label: "Grammars", items: grammars },
    { label: "Viewers", items: viewers },
    { label: "Editors", items: editors },
    { label: "FS Providers", items: fsProviders },
    { label: "Commands", items: commands },
    { label: "Keybindings", items: keybindings },
    { label: "Shell Integrations", items: shells },
  ].filter((section) => section.items.length > 0);
}

export function ExtensionsPanel({ onClose }: { onClose: () => void }) {
  const resolveVfsUrl = useVfsUrlResolver();
  const bridge = useBridge();
  const [dataDir, setDataDir] = useState<string | null>(null);
  const { activeIconTheme, setActiveIconTheme } = useActiveIconTheme();
  const { activeColorTheme, setActiveColorTheme } = useActiveColorTheme();
  const installed = useLoadedExtensions();
  const setInstalled = useSetLoadedExtensions();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const extensionHost = useExtensionHostClient();
  const [marketplaceSource, setMarketplaceSource] = useState<MarketplaceSource>("open-vsx");
  const [query, setQuery] = useState("");
  const [marketplaceResults, setMarketplaceResults] = useState<MarketplaceSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyByKey, setBusyByKey] = useState<Record<string, BusyState>>({});
  const [pendingAutoUpdateByKey, setPendingAutoUpdateByKey] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [filterKind, setFilterKind] = useState<FilterKind>("none");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [contentTab, setContentTab] = useState<ContentTab>("details");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [docsByKey, setDocsByKey] = useState<Record<string, LoadedDocs>>({});
  const [remoteMetaByKey, setRemoteMetaByKey] = useState<Record<string, RemoteMetadata>>({});
  const [docsLoadingKey, setDocsLoadingKey] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [availableUpdateByKey, setAvailableUpdateByKey] = useState<Record<string, string | null>>({});
  const checkedUpdateKeysRef = useRef(new Set<string>());
  const installIdToKeyRef = useRef(new Map<number, string>());
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const dirs = await readAppDirs(bridge);
      if (!cancelled) {
        setDataDir(dirs.dataDir);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const installedItems = useMemo(() => installed.map((ext) => normalizeInstalled(ext, resolveVfsUrl)), [installed, resolveVfsUrl]);
  const installedByKey = useMemo(() => new Map(installed.map((ext) => [keyForInstalled(ext), ext])), [installed]);
  const doSearch = useCallback(async (q: string, source: MarketplaceSource) => {
    setLoading(true);
    setError("");
    try {
      const data = await getMarketplaceProvider(source).search(q);
      setMarketplaceResults(data.items);
    } catch {
      setError(`Could not reach ${source === "open-vsx" ? "Open VSX" : ".dir"} marketplace`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (query.trim() || filterKind !== "none") {
      void doSearch(query.trim(), marketplaceSource);
    }
  }, [doSearch, filterKind, marketplaceSource, query]);

  useEffect(() => {
    return bridge.extensions.install.onProgress((payload: ExtensionInstallProgressEvent) => {
      const key = installIdToKeyRef.current.get(payload.installId);
      if (!key) return;
      const event = payload.event;

      if (event.kind === "error") {
        installIdToKeyRef.current.delete(payload.installId);
        setError(`Install failed: ${event.message}`);
        setBusyByKey((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        return;
      }

      if (event.kind === "done") {
        installIdToKeyRef.current.delete(payload.installId);
        setAvailableUpdateByKey((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        void (async () => {
          try {
            await extensionHost.restart();
          } finally {
            setBusyByKey((current) => {
              const next = { ...current };
              delete next[key];
              return next;
            });
          }
        })();
        return;
      }

      if (event.kind !== "progress") return;
      setBusyByKey((current) => ({
        ...current,
        [key]: { kind: "install", phase: event.phase },
      }));
    });
  }, [bridge, extensionHost]);

  const runBridgeInstall = useCallback(
    async (
      key: string,
      request:
        | { source: "dotdir-marketplace"; publisher: string; name: string; version: string }
        | { source: "open-vsx-marketplace"; publisher: string; name: string; downloadUrl: string },
    ) => {
      setBusyByKey((current) => ({
        ...current,
        [key]: { kind: "install", phase: "download" },
      }));
      const installId = await bridge.extensions.install.start(request);
      installIdToKeyRef.current.set(installId, key);
    },
    [bridge],
  );

  const handleSearchInput = (value: string) => {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      if (value.trim() || filterKind !== "none") {
        void doSearch(value.trim(), marketplaceSource);
      }
    }, 250);
  };

  const marketplaceItems = useMemo(() => marketplaceResults.map(normalizeMarketplaceItem), [marketplaceResults]);

  const availableCategories = useMemo(() => {
    const all = new Set<string>();
    for (const category of DEFAULT_VSCODE_CATEGORIES) {
      all.add(category);
    }
    for (const item of marketplaceItems) {
      for (const category of item.categories) {
        all.add(category);
      }
    }
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [marketplaceItems]);

  const showingMarketplace = query.trim().length > 0 || filterKind !== "none";

  const marketplaceSourceOptions = useMemo<DropdownSelectOption[]>(
    () => [
      { value: "open-vsx", label: "Open VSX" },
      { value: "dotdir", label: ".dir" },
    ],
    [],
  );

  const filterMenuItems = useMemo<NestedPopoverMenuItem[]>(
    () => [
      {
        id: "installed",
        label: "Installed",
        onSelect: () => {
          setFilterKind("none");
          setSelectedCategory(null);
        },
      },
      {
        id: "featured",
        label: "Featured",
        onSelect: () => {
          setFilterKind("featured");
          setSelectedCategory(null);
        },
      },
      {
        id: "recent",
        label: "Recently Published",
        onSelect: () => {
          setFilterKind("recent");
          setSelectedCategory(null);
        },
      },
      {
        id: "recommended",
        label: "Recommended",
        onSelect: () => {
          setFilterKind("recommended");
          setSelectedCategory(null);
        },
      },
      {
        id: "category",
        label: "Category",
        items:
          availableCategories.length > 0
            ? availableCategories.map((category) => ({
                id: `category:${category}`,
                label: category,
                onSelect: () => {
                  setFilterKind("category");
                  setSelectedCategory(category);
                },
              }))
            : [
                {
                  id: "category:none",
                  label: "No categories from current source",
                  disabled: true,
                },
              ],
      },
    ],
    [availableCategories],
  );

  const filteredMarketplaceItems = useMemo(() => {
    let items = marketplaceItems;

    if (filterKind === "category" && selectedCategory) {
      items = items.filter((item) => item.categories.includes(selectedCategory));
    } else if (filterKind === "recommended") {
      items = [...items].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
    } else if (filterKind === "recent") {
      items = [...items].sort((a, b) => {
        const left = a.kind === "marketplace" && a.publishedAt ? Date.parse(a.publishedAt) : 0;
        const right = b.kind === "marketplace" && b.publishedAt ? Date.parse(b.publishedAt) : 0;
        return right - left;
      });
    }

    return items;
  }, [filterKind, marketplaceItems, selectedCategory]);

  const sidebarItems = showingMarketplace ? filteredMarketplaceItems : installedItems;

  useEffect(() => {
    if (sidebarItems.length === 0) {
      setSelectedKey(null);
      setMobileDetailOpen(false);
      return;
    }
    if (!selectedKey || !sidebarItems.some((item) => item.key === selectedKey)) {
      setSelectedKey(sidebarItems[0]!.key);
    }
  }, [selectedKey, sidebarItems]);

  const selectedItem = useMemo(() => sidebarItems.find((item) => item.key === selectedKey) ?? null, [selectedKey, sidebarItems]);

  useEffect(() => {
    if (!selectedItem) {
      setMobileDetailOpen(false);
    }
  }, [selectedItem]);
  const selectedInstalled = selectedItem ? (installedByKey.get(selectedItem.key) ?? (selectedItem.kind === "installed" ? selectedItem.loaded : null)) : null;
  const selectedBusy = selectedItem ? busyByKey[selectedItem.key] : undefined;
  const selectedAutoUpdate = selectedInstalled
    ? (pendingAutoUpdateByKey[`${extensionRef(selectedInstalled).publisher}.${extensionRef(selectedInstalled).name}`] ??
      extensionRef(selectedInstalled).autoUpdate ??
      true)
    : false;
  const selectedIconThemes = selectedInstalled ? extensionIconThemes(selectedInstalled) : [];
  const selectedIconThemeValue = selectedInstalled
    ? (selectedIconThemes.find((theme) => extensionIconThemeKey(selectedInstalled, theme.id) === activeIconTheme)?.id ?? "")
    : "";
  const selectedColorThemes = selectedInstalled ? extensionColorThemes(selectedInstalled) : [];
  const selectedColorThemeValue = selectedInstalled
    ? (selectedColorThemes.find((theme) => colorThemeKey(selectedInstalled, theme.id) === activeColorTheme)?.id ?? "")
    : "";
  const selectedIconThemeOptions = useMemo<DropdownSelectOption[]>(
    () => [{ value: "", label: "Default" }, ...selectedIconThemes.map((theme) => ({ value: theme.id, label: theme.label }))],
    [selectedIconThemes],
  );
  const selectedColorThemeOptions = useMemo<DropdownSelectOption[]>(
    () => [{ value: "", label: "Default" }, ...selectedColorThemes.map((theme) => ({ value: theme.id, label: theme.label }))],
    [selectedColorThemes],
  );
  const selectedDocs = selectedItem ? docsByKey[selectedItem.key] : undefined;
  const selectedRemoteMeta = selectedItem ? remoteMetaByKey[selectedItem.key] : undefined;
  const selectedReviewCount = selectedRemoteMeta?.reviewCount ?? (selectedItem?.kind === "marketplace" ? (selectedItem.remote.reviewCount ?? 0) : 0);
  const selectedHomepageLabel = formatHostLabel(selectedRemoteMeta?.homepage ?? null);
  const selectedAvailableUpdate = selectedInstalled
    ? (availableUpdateByKey[`${extensionRef(selectedInstalled).publisher}.${extensionRef(selectedInstalled).name}@${extensionRef(selectedInstalled).version}`] ?? null)
    : null;

  const openExternalLink = useCallback(
    async (url: string) => {
      if (bridge.utils.openExternal) {
        await bridge.utils.openExternal(url);
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    },
    [bridge],
  );

  const handleExternalLinkClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const anchor = (event.target as HTMLElement | null)?.closest("a");
      const href = anchor?.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      void openExternalLink(href);
    },
    [openExternalLink],
  );

  useEffect(() => {
    if (!selectedInstalled || !selectedItem) return;
    if (docsByKey[selectedItem.key]) return;
    if (contentTab === "features") return;

    let cancelled = false;
    setDocsLoadingKey(selectedItem.key);
    void (async () => {
      const readme = await tryReadOptionalDoc(bridge, extensionDirPath(selectedInstalled), ["README.md", "readme.md"]);
      const changelog = await tryReadOptionalDoc(bridge, extensionDirPath(selectedInstalled), ["CHANGELOG.md", "Changelog.md", "changelog.md"]);
      if (cancelled) return;
      setDocsByKey((current) => ({
        ...current,
        [selectedItem.key]: { readme, changelog },
      }));
      setDocsLoadingKey((current) => (current === selectedItem.key ? null : current));
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, contentTab, docsByKey, selectedInstalled, selectedItem]);

  useEffect(() => {
    if (!selectedItem || selectedItem.kind !== "marketplace") return;
    if (remoteMetaByKey[selectedItem.key]) return;

    let cancelled = false;
    setDocsLoadingKey(selectedItem.key);

    void (async () => {
      try {
        const provider = getMarketplaceProvider(selectedItem.source);
        const details = await provider.getDetails(selectedItem.remote.publisher, selectedItem.remote.name);
        const [readme, changelog] = await Promise.all([
          details.readmeUrl ? fetchRemoteText(details.readmeUrl, { openVsx: selectedItem.source === "open-vsx" }) : Promise.resolve(null),
          details.changelogUrl ? fetchRemoteText(details.changelogUrl, { openVsx: selectedItem.source === "open-vsx" }) : Promise.resolve(null),
        ]);

        if (cancelled) return;

        setRemoteMetaByKey((current) => ({
          ...current,
          [selectedItem.key]: {
            ...details,
            readme,
            changelog,
          },
        }));
      } catch {
        if (cancelled) return;
        setRemoteMetaByKey((current) => ({
          ...current,
          [selectedItem.key]: {
            provider: selectedItem.source,
            key: selectedItem.key,
            publisher: selectedItem.remote.publisher,
            publisherDisplayName: selectedItem.publisher,
            name: selectedItem.remote.name,
            version: selectedItem.version,
            title: selectedItem.title,
            description: selectedItem.description,
            iconUrl: selectedItem.iconUrl,
            downloads: selectedItem.downloads,
            rating: selectedItem.rating,
            reviewCount: null,
            categories: selectedItem.categories,
            tags: selectedItem.tags,
            publishedAt: selectedItem.publishedAt,
            namespaceDisplayName: selectedItem.publisher,
            timestamp: null,
            homepage: null,
            repository: null,
            bugs: null,
            readmeUrl: null,
            changelogUrl: null,
            downloadUrl: selectedItem.remote.downloadUrl ?? null,
            readme: null,
            changelog: null,
          },
        }));
      } finally {
        if (!cancelled) {
          setDocsLoadingKey((current) => (current === selectedItem.key ? null : current));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [remoteMetaByKey, selectedItem]);

  useEffect(() => {
    if (!selectedInstalled) return;
    const ref = extensionRef(selectedInstalled);
    if (ref.source !== "dotdir-marketplace") return;
    const key = `${ref.publisher}.${ref.name}@${ref.version}`;
    if (checkedUpdateKeysRef.current.has(key)) return;
    checkedUpdateKeysRef.current.add(key);

    let cancelled = false;
    void (async () => {
      try {
        const details = await fetchDotDirExtensionDetails(ref.publisher, ref.name);
        if (cancelled) return;
        const latestVersion = details.version || null;
        const hasUpdate = latestVersion ? compareExtensionVersions(latestVersion, ref.version) > 0 : false;
        setAvailableUpdateByKey((current) => ({ ...current, [key]: hasUpdate ? latestVersion : null }));
      } catch {
        if (cancelled) return;
        checkedUpdateKeysRef.current.delete(key); // allow retry on next selection
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedInstalled]);

  const handleInstall = useCallback(
    async (item: SidebarItem) => {
      setError("");
      try {
        if (item.kind === "marketplace") {
          const request = getMarketplaceProvider(item.source).getInstallRequest(item.remote);
          if (!request) return;
          await runBridgeInstall(item.key, request);
        }
      } catch (err) {
        setError(`Install failed: ${errMsg(err)}`);
        setBusyByKey((current) => {
          const next = { ...current };
          delete next[item.key];
          return next;
        });
      }
    },
    [runBridgeInstall],
  );

  const handleUninstall = useCallback(
    async (ext: LoadedExtension) => {
      if (!dataDir) return;
      const key = keyForInstalled(ext);
      setBusyByKey((current) => ({
        ...current,
        [key]: { kind: "uninstall" },
      }));
      setError("");
      try {
        await uninstallExtension(bridge, dataDir, extensionRef(ext).publisher, extensionRef(ext).name);
        if (activeIconTheme === key) {
          setActiveIconTheme(undefined);
        }
        if (activeColorTheme?.startsWith(key + ":")) {
          setActiveColorTheme(undefined);
        }
        await extensionHost.restart();
      } catch (err) {
        setError(`Uninstall failed: ${errMsg(err)}`);
      }
      setBusyByKey((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [activeColorTheme, activeIconTheme, bridge, dataDir, extensionHost, setActiveColorTheme, setActiveIconTheme],
  );

  const handleUpdateExtension = useCallback(
    async (ext: LoadedExtension, version: string) => {
      const ref = extensionRef(ext);
      const key = `${ref.publisher}.${ref.name}@${ref.version}`;
      await runBridgeInstall(key, {
        source: "dotdir-marketplace",
        publisher: ref.publisher,
        name: ref.name,
        version,
      });
    },
    [runBridgeInstall],
  );

  const handleSetIconTheme = useCallback(
    (ext: LoadedExtension, themeId: string) => {
      const key = extensionIconThemeKey(ext, themeId);
      const newId = key === activeIconTheme ? undefined : key;
      setActiveIconTheme(newId);
    },
    [activeIconTheme, setActiveIconTheme],
  );

  const handleSetColorTheme = useCallback(
    (ext: LoadedExtension, themeId: string) => {
      const key = colorThemeKey(ext, themeId);
      const newKey = key === activeColorTheme ? undefined : key;
      setActiveColorTheme(newKey);
    },
    [activeColorTheme, setActiveColorTheme],
  );

  const handleSetAutoUpdate = useCallback(
    async (ext: LoadedExtension, autoUpdate: boolean) => {
      if (!dataDir) return;
      const key = `${extensionRef(ext).publisher}.${extensionRef(ext).name}`;
      setPendingAutoUpdateByKey((current) => ({ ...current, [key]: autoUpdate }));
      try {
        await setExtensionAutoUpdate(bridge, dataDir, extensionRef(ext).publisher, extensionRef(ext).name, autoUpdate);
        setInstalled((current) =>
          current.map((item) =>
            extensionRef(item).publisher === extensionRef(ext).publisher && extensionRef(item).name === extensionRef(ext).name
              ? { ...item, identity: { ...item.identity, ref: { ...item.identity.ref, autoUpdate } } }
              : item,
          ),
        );
      } catch (err) {
        setPendingAutoUpdateByKey((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        throw err;
      }
    },
    [bridge, dataDir, setInstalled],
  );

  useEffect(() => {
    if (installed.length === 0) {
      setPendingAutoUpdateByKey({});
      return;
    }
    setPendingAutoUpdateByKey((current) => {
      let changed = false;
      const next = { ...current };
      for (const ext of installed) {
        const key = `${extensionRef(ext).publisher}.${extensionRef(ext).name}`;
        if (key in next && next[key] === (extensionRef(ext).autoUpdate ?? true)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [installed]);

  const detailsSource = useMemo(() => {
    if (!selectedItem) return null;
    if (selectedRemoteMeta?.readme) return selectedRemoteMeta.readme;
    if (selectedDocs?.readme) return selectedDocs.readme;
    return null;
  }, [selectedDocs?.readme, selectedItem, selectedRemoteMeta?.readme]);

  const changelogSource = useMemo(() => {
    if (!selectedItem) return "";
    if (selectedRemoteMeta?.changelog) return selectedRemoteMeta.changelog;
    if (selectedDocs?.changelog) return selectedDocs.changelog;
    return `# Changelog\n\nNo changelog available for ${selectedItem.title}.`;
  }, [selectedDocs?.changelog, selectedItem, selectedRemoteMeta?.changelog]);

  const featureSections = useMemo(() => (selectedInstalled ? featureSectionsForInstalled(selectedInstalled) : []), [selectedInstalled]);
  const contentTabs = useMemo<TabsItem[]>(
    () => [
      { id: "details", label: "Details" },
      { id: "features", label: "Features" },
      { id: "changelog", label: "Changelog" },
    ],
    [],
  );
  const infoSections = useMemo(() => {
    if (!selectedItem) return [];

    const installRows = [
      { label: "Identifier", value: selectedItem.key },
      { label: "Version", value: selectedItem.version || "Unknown" },
      { label: "Last Updated", value: selectedRemoteMeta?.timestamp ? formatRelativeDate(selectedRemoteMeta.timestamp) : null },
    ].filter((row) => row.value);

    const marketplaceRows = [
      { label: "Published", value: selectedItem.kind === "marketplace" ? formatRelativeDate(selectedItem.publishedAt) : null },
      { label: "Last Released", value: selectedRemoteMeta?.timestamp ? formatRelativeDate(selectedRemoteMeta.timestamp) : null },
    ].filter((row) => row.value);

    const categories = selectedRemoteMeta?.categories?.length ? selectedRemoteMeta.categories : selectedItem.categories;
    const resources = [
      selectedRemoteMeta?.repository ? { label: "Repository", href: selectedRemoteMeta.repository } : null,
      selectedRemoteMeta?.homepage ? { label: selectedRemoteMeta.namespaceDisplayName ?? selectedItem.publisher, href: selectedRemoteMeta.homepage } : null,
      selectedRemoteMeta?.bugs ? { label: "Issues", href: selectedRemoteMeta.bugs } : null,
      selectedItem.kind === "marketplace" && selectedItem.source === "open-vsx"
        ? { label: "Marketplace", href: openVsxExtensionUrl(selectedItem.remote.publisher, selectedItem.remote.name) }
        : null,
      selectedItem.kind === "marketplace" && selectedItem.source === "open-vsx"
        ? { label: selectedItem.publisher, href: openVsxNamespaceUrl(selectedItem.remote.publisher) }
        : null,
    ].filter((row): row is { label: string; href: string } => Boolean(row));

    return [
      installRows.length > 0 ? { title: "Installation", rows: installRows } : null,
      marketplaceRows.length > 0 ? { title: "Marketplace", rows: marketplaceRows } : null,
      categories.length > 0 ? { title: "Categories", badges: categories } : null,
      resources.length > 0 ? { title: "Resources", links: resources } : null,
    ].filter(Boolean) as Array<
      | { title: string; rows: Array<{ label: string; value: string | null }> }
      | { title: string; badges: string[] }
      | { title: string; links: Array<{ label: string; href: string }> }
    >;
  }, [selectedItem, selectedRemoteMeta]);

  const selectedRenderedDocs = useMemo<RenderedDocs | undefined>(() => {
    if (!selectedItem) return undefined;
    const detailsHtml = !detailsSource
      ? null
      : selectedRemoteMeta?.readme && isProbablyHtml(selectedRemoteMeta.readme)
        ? selectedRemoteMeta.readme
        : (marked.parse(detailsSource) as string);
    const changelogHtml =
      selectedRemoteMeta?.changelog && isProbablyHtml(selectedRemoteMeta.changelog) ? selectedRemoteMeta.changelog : (marked.parse(changelogSource) as string);
    return {
      detailsSource,
      changelogSource,
      detailsHtml,
      changelogHtml,
    };
  }, [changelogSource, detailsSource, selectedItem, selectedRemoteMeta?.changelog, selectedRemoteMeta?.readme]);

  const detailsLoading = !!selectedItem && docsLoadingKey === selectedItem.key && !selectedRemoteMeta?.readme && !selectedDocs?.readme;
  const remoteMetaLoading = !!selectedItem && docsLoadingKey === selectedItem.key && selectedItem.kind !== "installed" && !selectedRemoteMeta;

  return (
    <OverlayDialog className={styles["ext-dialog"]} onClose={onClose} initialFocusRef={searchInputRef}>
      <div className={cx(styles, "ext-shell", mobileDetailOpen && "mobile-detail-open")}>
        <aside className={styles["ext-sidebar"]}>
          <div className={styles["ext-sidebar-header"]}>
            <div className={styles["ext-dialog-title"]}>Extensions</div>
            <button className={styles["ext-close"]} onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>

          <div className={styles["ext-search-block"]}>
            <div className={styles["ext-search-row"]}>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search extensions"
                value={query}
                onChange={(event) => handleSearchInput(event.target.value)}
                {...INPUT_NO_ASSIST}
              />
            </div>
            <div className={styles["ext-toolbar-row"]}>
              <DropdownSelect
                triggerClassName={styles["ext-source-select"]}
                value={marketplaceSource}
                options={marketplaceSourceOptions}
                onChange={(nextValue) => {
                  const nextSource = nextValue as MarketplaceSource;
                  setMarketplaceSource(nextSource);
                  if (query.trim() || filterKind !== "none") {
                    void doSearch(query.trim(), nextSource);
                  }
                }}
              />
              <NestedPopoverMenu
                items={filterMenuItems}
                placement="bottom-end"
                popoverClassName={styles["ext-filter-menu"]}
                renderAnchor={({ ref, id, open, toggle }) => (
                  <button
                    ref={ref as RefObject<HTMLButtonElement | null>}
                    id={id}
                    type="button"
                    className={cx(styles, "ext-filter-button", filterKind !== "none" && "active")}
                    style={{
                      appearance: "none",
                      WebkitAppearance: "none",
                      background: "var(--bg)",
                      backgroundImage: "none",
                      boxShadow: "none",
                      color: "var(--fg)",
                      borderColor: "var(--border)",
                    }}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    onClick={toggle}
                  >
                    <SmartLabel>{formatFilterLabel(filterKind, selectedCategory)}</SmartLabel>
                    <VscChevronDown aria-hidden="true" />
                  </button>
                )}
              />
            </div>
          </div>

          {error && <div className={styles["ext-error"]}>{error}</div>}

          <div className={styles["ext-sidebar-list"]}>
            {loading && showingMarketplace && <div className={styles["ext-empty"]}>Loading extensions…</div>}
            {!loading && sidebarItems.length === 0 && (
              <div className={styles["ext-empty"]}>{showingMarketplace ? "No matching extensions" : "No installed extensions"}</div>
            )}
            <List
              items={sidebarItems}
              getKey={(item) => item.key}
              activeKey={selectedKey}
              onActiveKeyChange={(key) => setSelectedKey(key)}
              onActivate={(key) => {
                setSelectedKey(key);
                setContentTab("details");
                setMobileDetailOpen(true);
              }}
              className={styles["ext-sidebar-items"]}
              renderItem={(item, { active }) => {
                const installedExtension = installedByKey.get(item.key);
                const busy = busyByKey[item.key];
                return (
                  <div className={cx(styles, "ext-sidebar-item", active && "selected")}>
                    <div className={styles["ext-item-icon"]}>{item.iconUrl ? <img src={item.iconUrl} alt="" /> : (item.title[0]?.toUpperCase() ?? "?")}</div>
                    <div className={styles["ext-item-copy"]}>
                      <div className={styles["ext-item-title"]}>{item.title}</div>
                      <div className={styles["ext-item-subtitle"]}>{item.publisher}</div>
                      <div className={styles["ext-item-description"]}>{item.description || "No description"}</div>
                      <div className={styles["ext-item-flags"]}>
                        {installedExtension && <span>Installed</span>}
                        {busy?.kind === "install" && <span>{busy.phase === "finalize" ? "Finalizing" : "Installing"}</span>}
                        {busy?.kind === "uninstall" && <span>Removing</span>}
                      </div>
                    </div>
                  </div>
                );
              }}
            />
          </div>
        </aside>

        <main className={styles["ext-main"]}>
          {!selectedItem ? (
            <div className={styles["ext-main-empty"]}>Select an extension to view details.</div>
          ) : (
            <>
              <header className={styles["ext-hero"]}>
                <div className={styles["ext-hero-mobile-top"]}>
                  <button className={styles["ext-back"]} onClick={() => setMobileDetailOpen(false)} type="button">
                    <VscArrowLeft aria-hidden="true" />
                    Back
                  </button>
                </div>
                <div className={styles["ext-hero-icon"]}>
                  {selectedItem.iconUrl ? <img src={selectedItem.iconUrl} alt="" /> : (selectedItem.title[0]?.toUpperCase() ?? "?")}
                </div>
                <div className={styles["ext-hero-copy"]}>
                  <div className={styles["ext-hero-title-row"]}>
                    <h1>{selectedItem.title}</h1>
                  </div>
                  <div className={styles["ext-hero-meta-row"]}>
                    <span className={styles["ext-source-pill"]}>
                      {selectedItem.source === "installed" ? "Installed" : selectedItem.source === "dotdir" ? ".dir" : "Open VSX"}
                    </span>
                    {selectedItem.kind !== "installed" && selectedItem.publisher.toLowerCase().includes("github") && (
                      <span className={styles["ext-meta-with-icon"]}>
                        <FaGithub aria-hidden="true" /> {selectedItem.publisher}
                      </span>
                    )}
                    {selectedItem.kind === "installed" && <span className={styles["ext-meta-with-icon"]}>{selectedItem.publisher}</span>}
                    {selectedRemoteMeta?.homepage && (
                      <>
                        <span className={styles["ext-meta-separator"]}>|</span>
                        <a className={styles["ext-meta-link"]} href={selectedRemoteMeta.homepage} onClick={handleExternalLinkClick}>
                          {selectedHomepageLabel}
                        </a>
                      </>
                    )}
                    {selectedItem.kind === "marketplace" && selectedItem.source === "dotdir" && (
                      <>
                        <span className={styles["ext-meta-separator"]}>|</span>
                        <span className={styles["ext-meta-with-icon"]}>
                          <VscVerifiedFilled aria-hidden="true" />
                          Trusted
                        </span>
                      </>
                    )}
                    {(selectedRemoteMeta?.downloads ?? selectedItem.downloads) != null && (
                      <>
                        <span className={styles["ext-meta-separator"]}>|</span>
                        <span className={styles["ext-meta-with-icon"]}>
                          <VscCloudDownload aria-hidden="true" />
                          {formatNumber(selectedRemoteMeta?.downloads ?? selectedItem.downloads)}
                        </span>
                      </>
                    )}
                    <>
                      <span className={styles["ext-meta-separator"]}>|</span>
                      {renderStars(selectedRemoteMeta?.rating ?? selectedItem.rating, selectedReviewCount, remoteMetaLoading)}
                    </>
                  </div>
                  <p className={styles["ext-hero-description"]}>{selectedItem.description || "No description available."}</p>
                  <div className={styles["ext-hero-actions"]}>
                    {selectedInstalled ? (
                      <>
                        {selectedAvailableUpdate && (
                          <button
                            className={cx(styles, "ext-action", "primary")}
                            disabled={!!selectedBusy}
                            onClick={() => void handleUpdateExtension(selectedInstalled, selectedAvailableUpdate)}
                            type="button"
                          >
                            <SmartLabel>
                              {selectedBusy?.kind === "install" ? "Updating…" : `Update to ${selectedAvailableUpdate}`}
                            </SmartLabel>
                          </button>
                        )}
                        <button
                          className={cx(styles, "ext-action")}
                          disabled={selectedBusy?.kind === "uninstall"}
                          onClick={() => handleUninstall(selectedInstalled)}
                          type="button"
                        >
                          <SmartLabel>{selectedBusy?.kind === "uninstall" ? "Removing…" : "Uninstall"}</SmartLabel>
                        </button>
                        <label className={styles["ext-toggle"]}>
                          <input
                            type="checkbox"
                            checked={selectedAutoUpdate}
                            onChange={(event) => {
                              void handleSetAutoUpdate(selectedInstalled, event.target.checked);
                            }}
                          />
                          <SmartLabel>Auto Update</SmartLabel>
                        </label>
                      </>
                    ) : (
                      <button
                        className={cx(styles, "ext-action", "primary")}
                        disabled={selectedBusy?.kind === "install"}
                        onClick={() => handleInstall(selectedItem)}
                        type="button"
                      >
                        <SmartLabel>
                          {selectedBusy?.kind === "install" ? (selectedBusy.phase === "finalize" ? "Finalizing…" : "Installing…") : "Install"}
                        </SmartLabel>
                      </button>
                    )}
                  </div>
                </div>
                {selectedInstalled && (selectedIconThemes.length > 0 || selectedColorThemes.length > 0) && (
                  <div className={styles["ext-hero-side-controls"]}>
                    {selectedIconThemes.length > 0 && (
                      <label className={styles["ext-select-wrap"]}>
                        <span className={styles["ext-select-label"]}>Icon Theme</span>
                        <DropdownSelect
                          triggerClassName={styles["ext-select"]}
                          value={selectedIconThemeValue}
                          options={selectedIconThemeOptions}
                          onChange={(nextValue) => {
                            if (!nextValue) {
                              setActiveIconTheme(undefined);
                              return;
                            }
                            handleSetIconTheme(selectedInstalled, nextValue);
                          }}
                        />
                      </label>
                    )}
                    {selectedColorThemes.length > 0 && (
                      <label className={styles["ext-select-wrap"]}>
                        <span className={styles["ext-select-label"]}>Color Theme</span>
                        <DropdownSelect
                          triggerClassName={styles["ext-select"]}
                          value={selectedColorThemeValue}
                          options={selectedColorThemeOptions}
                          onChange={(nextValue) => {
                            if (!nextValue) {
                              setActiveColorTheme(undefined);
                              return;
                            }
                            handleSetColorTheme(selectedInstalled, nextValue);
                          }}
                        />
                      </label>
                    )}
                  </div>
                )}
              </header>

              <Tabs items={contentTabs} activeItemId={contentTab} onSelectItem={(id) => setContentTab(id as ContentTab)} variant="subtle" />

              <div className={styles["ext-content-body"]}>
                <div className={styles["ext-content-layout"]}>
                  <div className={styles["ext-content-main"]}>
                    {contentTab === "details" &&
                      (detailsLoading ? (
                        <div className={styles["ext-empty-panel"]}>Loading README…</div>
                      ) : selectedRenderedDocs?.detailsHtml ? (
                        <div
                          className={styles["ext-markdown"]}
                          onClick={handleExternalLinkClick}
                          dangerouslySetInnerHTML={{ __html: selectedRenderedDocs.detailsHtml }}
                        />
                      ) : (
                        <div className={styles["ext-empty-panel"]}>No README available.</div>
                      ))}

                    {contentTab === "features" && (
                      <div className={styles["ext-features"]}>
                        {selectedInstalled ? (
                          featureSections.length > 0 ? (
                            featureSections.map((section) => renderFeatureGroup(section.label, section.items))
                          ) : (
                            <div className={styles["ext-empty-panel"]}>No contributed features declared.</div>
                          )
                        ) : (
                          <div className={styles["ext-features-marketplace"]}>
                            {(selectedRemoteMeta?.categories ?? selectedItem.categories).length > 0 &&
                              renderFeatureGroup("Categories", selectedRemoteMeta?.categories ?? selectedItem.categories)}
                            {(selectedRemoteMeta?.tags ?? selectedItem.tags).length > 0 &&
                              renderFeatureGroup("Tags", selectedRemoteMeta?.tags ?? selectedItem.tags)}
                            {(selectedRemoteMeta?.categories ?? selectedItem.categories).length === 0 &&
                              (selectedRemoteMeta?.tags ?? selectedItem.tags).length === 0 && (
                                <div className={styles["ext-empty-panel"]}>Detailed feature metadata is not available from this marketplace entry.</div>
                              )}
                          </div>
                        )}
                      </div>
                    )}

                    {contentTab === "changelog" &&
                      (docsLoadingKey === selectedItem.key && !selectedRemoteMeta?.changelog && !selectedDocs?.changelog ? (
                        <div className={styles["ext-empty-panel"]}>Loading changelog…</div>
                      ) : selectedRenderedDocs?.changelogHtml ? (
                        <div
                          className={styles["ext-markdown"]}
                          onClick={handleExternalLinkClick}
                          dangerouslySetInnerHTML={{ __html: selectedRenderedDocs.changelogHtml }}
                        />
                      ) : (
                        <div className={styles["ext-empty-panel"]}>Loading changelog…</div>
                      ))}
                  </div>

                  {infoSections.length > 0 && (
                    <aside className={styles["ext-info-rail"]}>
                      {infoSections.map((section) => (
                        <section key={section.title} className={styles["ext-info-section"]}>
                          <h3>{section.title}</h3>
                          {"rows" in section ? (
                            <dl className={styles["ext-info-list"]}>
                              {section.rows.map((row) => (
                                <div key={`${section.title}-${row.label}`} className={styles["ext-info-row"]}>
                                  <dt>{row.label}</dt>
                                  <dd>{row.value}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : "badges" in section ? (
                            <ul className={styles["ext-badges"]}>
                              {section.badges.map((badge) => (
                                <li key={`${section.title}-${badge}`} className={styles["ext-badge"]}>
                                  {badge}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <ul className={styles["ext-info-links"]}>
                              {section.links.map((link) => (
                                <li key={`${section.title}-${link.href}`}>
                                  <a href={link.href} onClick={handleExternalLinkClick}>
                                    {link.label}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          )}
                        </section>
                      ))}
                    </aside>
                  )}
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </OverlayDialog>
  );
}
