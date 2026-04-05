import { loadedExtensionsAtom } from "@/atoms";
import { OverlayDialog } from "@/dialogs/OverlayDialog";
import { SmartLabel } from "@/dialogs/dialogHotkeys";
import { Tabs, type TabsItem } from "@/components/Tabs/Tabs";
import type { ExtensionInstallProgressEvent } from "@/features/bridge";
import { useBridge } from "@/features/bridge/useBridge";
import { type LoadedColorTheme, type LoadedExtension, type MarketplaceExtension, colorThemeKey, extensionIconThemeId, fetchMarketplaceExtensionDetails, searchMarketplace, setExtensionAutoUpdate, uninstallExtension } from "@/features/extensions/extensions";
import { useExtensionHostClient } from "@/features/extensions/extensionHostClient";
import {
  type OpenVsxExtension,
  fetchOpenVsxExtensionDetails,
  getOpenVsxDownloadUrl,
  getOpenVsxIconUrl,
  searchOpenVsxMarketplace,
} from "@/features/marketplace/openVsxMarketplace";
import { activeColorThemeAtom, activeIconThemeAtom, useUserSettings } from "@/features/settings/useUserSettings";
import { readFileText } from "@/features/file-system/fs";
import { join } from "@/utils/path";
import { cx } from "@/utils/cssModules";
import { INPUT_NO_ASSIST } from "@/utils/inputNoAssist";
import { useAtomValue } from "jotai";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./ExtensionsPanel.module.css";

type MarketplaceSource = "dotdir" | "open-vsx";
type InstallPhase = "download" | "extract" | "write" | "finalize";
type BusyState = { kind: "install"; phase: InstallPhase } | { kind: "uninstall" };
type FilterKind = "none" | "featured" | "recent" | "recommended" | "category";
type ContentTab = "details" | "features" | "changelog";

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
      kind: "dotdir";
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
      raw: MarketplaceExtension;
    }
  | {
      kind: "open-vsx";
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
      source: MarketplaceSource;
      raw: OpenVsxExtension;
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

type RemoteMetadata = {
  averageRating: number | null;
  reviewCount: number | null;
  downloadCount: number | null;
  categories: string[];
  tags: string[];
  timestamp: string | null;
  namespaceDisplayName: string | null;
  homepage: string | null;
  repository: string | null;
  bugs: string | null;
  readme: string | null;
  changelog: string | null;
};

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

function keyForInstalled(ext: LoadedExtension): string {
  return `${ext.ref.publisher}.${ext.ref.name}`;
}

function normalizeInstalled(ext: LoadedExtension): SidebarItem {
  return {
    kind: "installed",
    key: keyForInstalled(ext),
    title: ext.manifest.displayName || ext.manifest.name,
    publisher: ext.manifest.publisher,
    description: ext.manifest.description || "",
    version: ext.ref.version,
    iconUrl: ext.iconUrl ?? null,
    downloads: null,
    rating: null,
    categories: [],
    tags: [],
    source: "installed",
    loaded: ext,
  };
}

function normalizeDotdir(ext: MarketplaceExtension): SidebarItem {
  return {
    kind: "dotdir",
    key: `${ext.namespace}.${ext.name}`,
    title: ext.displayName,
    publisher: ext.namespaceDisplayName || ext.namespace,
    description: ext.description,
    version: ext.version,
    iconUrl: ext.files?.icon ?? null,
    downloads: ext.downloadCount,
    rating: ext.averageRating ?? null,
    categories: ext.categories ?? [],
    tags: ext.tags ?? [],
    publishedAt: ext.timestamp ?? null,
    source: "dotdir",
    raw: ext,
  };
}

function normalizeOpenVsx(ext: OpenVsxExtension): SidebarItem {
  return {
    kind: "open-vsx",
    key: `${ext.namespace}.${ext.name}`,
    title: ext.displayName,
    publisher: ext.namespace,
    description: ext.description,
    version: ext.version,
    iconUrl: getOpenVsxIconUrl(ext),
    downloads: ext.downloadCount,
    rating: null,
    categories: [],
    tags: [],
    source: "open-vsx",
    raw: ext,
  };
}

function formatNumber(value: number | null): string {
  return value == null ? "Unavailable" : value.toLocaleString();
}

function formatVersion(value: string): string {
  return value ? `v${value}` : "Unknown version";
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

function buildFallbackDetails(item: SidebarItem): string {
  const lines = [
    `# ${item.title}`,
    "",
    item.description || "No description provided.",
    "",
    `- Publisher: ${item.publisher}`,
    `- Version: ${formatVersion(item.version)}`,
    `- Source: ${item.source === "installed" ? "Installed" : item.source === "dotdir" ? ".dir Marketplace" : "Open VSX"}`,
    `- Downloads: ${formatNumber(item.downloads)}`,
    `- Rating: ${item.rating == null ? "Unavailable" : String(item.rating)}`,
  ];

  if (item.categories.length > 0) {
    lines.push(`- Categories: ${item.categories.join(", ")}`);
  }
  if (item.tags.length > 0) {
    lines.push(`- Tags: ${item.tags.join(", ")}`);
  }

  return lines.join("\n");
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

function openVsxExtensionUrl(namespace: string, name: string): string {
  return `https://open-vsx.org/extension/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
}

function openVsxNamespaceUrl(namespace: string): string {
  return `https://open-vsx.org/namespace/${encodeURIComponent(namespace)}`;
}

function scheduleDeferredWork(work: () => void): () => void {
  if (typeof window.requestIdleCallback === "function" && typeof window.cancelIdleCallback === "function") {
    const id = window.requestIdleCallback(work);
    return () => window.cancelIdleCallback(id);
  }
  const id = globalThis.setTimeout(work, 0);
  return () => globalThis.clearTimeout(id);
}

function featureSectionsForInstalled(ext: LoadedExtension): Array<{ label: string; items: string[] }> {
  const commands = (ext.commands ?? []).map((item) => item.title || item.command);
  const keybindings = (ext.keybindings ?? []).map((item) => `${item.key} → ${item.command}`);
  const viewers = (ext.viewers ?? []).map((item) => item.label);
  const editors = (ext.editors ?? []).map((item) => item.label);
  const fsProviders = (ext.fsProviders ?? []).map((item) => item.label);
  const languages = (ext.languages ?? []).map((item) => item.aliases?.[0] ?? item.id);
  const grammars = (ext.grammarRefs ?? []).map((item) => item.contribution.scopeName);
  const shells = (ext.shellIntegrations ?? []).map((item) => item.label);
  const iconThemes = [
    ...(ext.iconThemeFssPath ? ["FSS icon theme"] : []),
    ...(ext.vscodeIconThemePath ? [`VS Code icon theme${ext.vscodeIconThemeId ? ` (${ext.vscodeIconThemeId})` : ""}`] : []),
  ];
  const colorThemes = (ext.colorThemes ?? []).map((item) => item.label);

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
  const bridge = useBridge();
  const activeIconTheme = useAtomValue(activeIconThemeAtom);
  const activeColorTheme = useAtomValue(activeColorThemeAtom);
  const installed = useAtomValue(loadedExtensionsAtom);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const extensionHost = useExtensionHostClient();
  const [marketplaceSource, setMarketplaceSource] = useState<MarketplaceSource>("open-vsx");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketplaceExtension[]>([]);
  const [openVsxResults, setOpenVsxResults] = useState<OpenVsxExtension[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyByKey, setBusyByKey] = useState<Record<string, BusyState>>({});
  const [pendingAutoUpdateByKey, setPendingAutoUpdateByKey] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [filterKind, setFilterKind] = useState<FilterKind>("none");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const [contentTab, setContentTab] = useState<ContentTab>("details");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [docsByKey, setDocsByKey] = useState<Record<string, LoadedDocs>>({});
  const [remoteMetaByKey, setRemoteMetaByKey] = useState<Record<string, RemoteMetadata>>({});
  const [renderedDocsByKey, setRenderedDocsByKey] = useState<Record<string, RenderedDocs>>({});
  const [docsLoadingKey, setDocsLoadingKey] = useState<string | null>(null);
  const installIdToKeyRef = useRef(new Map<number, string>());
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { updateSettings } = useUserSettings();

  const installedItems = useMemo(() => installed.map(normalizeInstalled), [installed]);
  const installedByKey = useMemo(() => new Map(installed.map((ext) => [keyForInstalled(ext), ext])), [installed]);

  const doSearch = useCallback(async (q: string, source: MarketplaceSource) => {
    setLoading(true);
    setError("");
    try {
      if (source === "open-vsx") {
        const data = await searchOpenVsxMarketplace(q);
        setOpenVsxResults(data.extensions);
        setResults([]);
      } else {
        const data = await searchMarketplace(q);
        setResults(data.extensions);
        setOpenVsxResults([]);
      }
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
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!filterMenuRef.current?.contains(target)) {
        setFilterMenuOpen(false);
        setCategoryMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, []);

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

  const marketplaceItems = useMemo(() => {
    if (marketplaceSource === "dotdir") return results.map(normalizeDotdir);
    return openVsxResults.map(normalizeOpenVsx);
  }, [marketplaceSource, openVsxResults, results]);

  const availableCategories = useMemo(() => {
    const all = new Set<string>();
    for (const item of marketplaceItems) {
      for (const category of item.categories) {
        all.add(category);
      }
    }
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [marketplaceItems]);

  const showingMarketplace = query.trim().length > 0 || filterKind !== "none";

  const filteredMarketplaceItems = useMemo(() => {
    let items = marketplaceItems;

    if (filterKind === "category" && selectedCategory) {
      items = items.filter((item) => item.categories.includes(selectedCategory));
    } else if (filterKind === "recommended") {
      items = [...items].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
    } else if (filterKind === "recent") {
      items = [...items].sort((a, b) => {
        const left = a.kind === "dotdir" && a.publishedAt ? Date.parse(a.publishedAt) : 0;
        const right = b.kind === "dotdir" && b.publishedAt ? Date.parse(b.publishedAt) : 0;
        return right - left;
      });
    }

    return items;
  }, [filterKind, marketplaceItems, selectedCategory]);

  const sidebarItems = showingMarketplace ? filteredMarketplaceItems : installedItems;

  useEffect(() => {
    if (sidebarItems.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !sidebarItems.some((item) => item.key === selectedKey)) {
      setSelectedKey(sidebarItems[0]!.key);
    }
  }, [selectedKey, sidebarItems]);

  const selectedItem = useMemo(() => sidebarItems.find((item) => item.key === selectedKey) ?? null, [selectedKey, sidebarItems]);
  const selectedInstalled = selectedItem ? installedByKey.get(selectedItem.key) ?? (selectedItem.kind === "installed" ? selectedItem.loaded : null) : null;
  const selectedBusy = selectedItem ? busyByKey[selectedItem.key] : undefined;
  const selectedAutoUpdate = selectedInstalled ? (pendingAutoUpdateByKey[selectedInstalled.ref.publisher + "." + selectedInstalled.ref.name] ?? selectedInstalled.ref.autoUpdate ?? true) : false;
  const selectedIconThemeId = selectedInstalled ? extensionIconThemeId(selectedInstalled) : null;
  const selectedColorThemes = selectedInstalled?.colorThemes ?? [];
  const selectedDocs = selectedItem ? docsByKey[selectedItem.key] : undefined;
  const selectedRemoteMeta = selectedItem ? remoteMetaByKey[selectedItem.key] : undefined;
  const selectedRenderedDocs = selectedItem ? renderedDocsByKey[selectedItem.key] : undefined;

  useEffect(() => {
    if (!selectedInstalled || !selectedItem) return;
    if (docsByKey[selectedItem.key]) return;
    if (contentTab === "features") return;

    let cancelled = false;
    setDocsLoadingKey(selectedItem.key);
    void (async () => {
      const readme = await tryReadOptionalDoc(bridge, selectedInstalled.dirPath, ["README.md", "readme.md"]);
      const changelog = await tryReadOptionalDoc(bridge, selectedInstalled.dirPath, ["CHANGELOG.md", "Changelog.md", "changelog.md"]);
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
    if (!selectedItem || (selectedItem.kind !== "open-vsx" && selectedItem.kind !== "dotdir")) return;
    if (remoteMetaByKey[selectedItem.key]) return;

    let cancelled = false;
    setDocsLoadingKey(selectedItem.key);

    void (async () => {
      try {
        const details =
          selectedItem.kind === "open-vsx"
            ? await fetchOpenVsxExtensionDetails(selectedItem.raw.namespace, selectedItem.raw.name)
            : await fetchMarketplaceExtensionDetails(selectedItem.raw.namespace, selectedItem.raw.name);
        const [readme, changelog] = await Promise.all([
          details.files?.readme ? fetch(details.files.readme).then((res) => (res.ok ? res.text() : null)) : Promise.resolve(null),
          details.files?.changelog ? fetch(details.files.changelog).then((res) => (res.ok ? res.text() : null)) : Promise.resolve(null),
        ]);

        if (cancelled) return;

        setRemoteMetaByKey((current) => ({
          ...current,
          [selectedItem.key]: {
            averageRating: details.averageRating ?? null,
            reviewCount: details.reviewCount ?? null,
            downloadCount: details.downloadCount ?? null,
            categories: details.categories ?? [],
            tags: details.tags ?? [],
            timestamp: details.timestamp ?? null,
            namespaceDisplayName: details.namespaceDisplayName ?? null,
            homepage: details.homepage ?? null,
            repository: details.repository ?? null,
            bugs: ("bugs" in details ? details.bugs : null) ?? null,
            readme,
            changelog,
          },
        }));
      } catch {
        if (cancelled) return;
        setRemoteMetaByKey((current) => ({
          ...current,
          [selectedItem.key]: {
            averageRating: null,
            reviewCount: null,
            downloadCount: selectedItem.downloads,
            categories: selectedItem.categories,
            tags: selectedItem.tags,
            timestamp: null,
            namespaceDisplayName: selectedItem.publisher,
            homepage: null,
            repository: null,
            bugs: null,
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

  const handleInstall = useCallback(
    async (item: SidebarItem) => {
      setError("");
      try {
        if (item.kind === "dotdir") {
          await runBridgeInstall(item.key, {
            source: "dotdir-marketplace",
            publisher: item.raw.namespace,
            name: item.raw.name,
            version: item.raw.version,
          });
          return;
        }
        if (item.kind === "open-vsx") {
          const downloadUrl = getOpenVsxDownloadUrl(item.raw);
          if (!downloadUrl) return;
          await runBridgeInstall(item.key, {
            source: "open-vsx-marketplace",
            publisher: item.raw.namespace,
            name: item.raw.name,
            downloadUrl,
          });
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
      const key = keyForInstalled(ext);
      setBusyByKey((current) => ({
        ...current,
        [key]: { kind: "uninstall" },
      }));
      setError("");
      try {
        await uninstallExtension(bridge, ext.ref.publisher, ext.ref.name);
        if (activeIconTheme === key) {
          updateSettings({ iconTheme: undefined });
        }
        if (activeColorTheme?.startsWith(key + ":")) {
          updateSettings({ colorTheme: undefined });
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
    [activeColorTheme, activeIconTheme, bridge, extensionHost, updateSettings],
  );

  const handleSetIconTheme = useCallback(
    (ext: LoadedExtension) => {
      const themeId = extensionIconThemeId(ext);
      if (!themeId) return;
      const newId = themeId === activeIconTheme ? undefined : themeId;
      updateSettings({ iconTheme: newId });
    },
    [activeIconTheme, updateSettings],
  );

  const handleSetColorTheme = useCallback(
    (ext: LoadedExtension, themeId: string) => {
      const key = colorThemeKey(ext, themeId);
      const newKey = key === activeColorTheme ? undefined : key;
      updateSettings({ colorTheme: newKey });
    },
    [activeColorTheme, updateSettings],
  );

  const handleSetAutoUpdate = useCallback(
    async (ext: LoadedExtension, autoUpdate: boolean) => {
      const key = `${ext.ref.publisher}.${ext.ref.name}`;
      setPendingAutoUpdateByKey((current) => ({ ...current, [key]: autoUpdate }));
      try {
        await setExtensionAutoUpdate(bridge, ext.ref.publisher, ext.ref.name, autoUpdate);
        await extensionHost.restart();
      } catch (err) {
        setPendingAutoUpdateByKey((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        throw err;
      }
    },
    [bridge, extensionHost],
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
        const key = `${ext.ref.publisher}.${ext.ref.name}`;
        if (key in next && next[key] === (ext.ref.autoUpdate ?? true)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [installed]);

  const detailsSource = useMemo(() => {
    if (!selectedItem) return "";
    if (selectedRemoteMeta?.readme) return selectedRemoteMeta.readme;
    if (selectedDocs?.readme) return selectedDocs.readme;
    return buildFallbackDetails(selectedItem);
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
      { label: "Published", value: selectedItem.kind === "dotdir" ? formatRelativeDate(selectedItem.publishedAt) : null },
      { label: "Last Released", value: selectedRemoteMeta?.timestamp ? formatRelativeDate(selectedRemoteMeta.timestamp) : null },
    ].filter((row) => row.value);

    const categories = selectedRemoteMeta?.categories?.length ? selectedRemoteMeta.categories : selectedItem.categories;
    const resources = [
      selectedRemoteMeta?.repository ? { label: "Repository", href: selectedRemoteMeta.repository } : null,
      selectedRemoteMeta?.homepage ? { label: selectedRemoteMeta.namespaceDisplayName ?? selectedItem.publisher, href: selectedRemoteMeta.homepage } : null,
      selectedRemoteMeta?.bugs ? { label: "Issues", href: selectedRemoteMeta.bugs } : null,
      selectedItem.kind === "open-vsx" ? { label: "Marketplace", href: openVsxExtensionUrl(selectedItem.raw.namespace, selectedItem.raw.name) } : null,
      selectedItem.kind === "open-vsx" ? { label: selectedItem.publisher, href: openVsxNamespaceUrl(selectedItem.raw.namespace) } : null,
    ].filter((row): row is { label: string; href: string } => Boolean(row));

    return [
      installRows.length > 0 ? { title: "Installation", rows: installRows } : null,
      marketplaceRows.length > 0 ? { title: "Marketplace", rows: marketplaceRows } : null,
      categories.length > 0 ? { title: "Categories", rows: categories.map((value) => ({ label: value, value })) } : null,
      resources.length > 0 ? { title: "Resources", links: resources } : null,
    ].filter(Boolean) as Array<
      | { title: string; rows: Array<{ label: string; value: string | null }> }
      | { title: string; links: Array<{ label: string; href: string }> }
    >;
  }, [selectedItem, selectedRemoteMeta]);

  useEffect(() => {
    if (!selectedItem) return;

    const key = selectedItem.key;
    const current = renderedDocsByKey[key];
    const needsDetails = contentTab === "details" && (current?.detailsHtml == null || current.detailsSource !== detailsSource);
    const needsChangelog = contentTab === "changelog" && (current?.changelogHtml == null || current.changelogSource !== changelogSource);
    if (!needsDetails && !needsChangelog) return;

    return scheduleDeferredWork(() => {
      setRenderedDocsByKey((existing) => {
        const prev = existing[key] ?? { detailsSource: null, changelogSource: null, detailsHtml: null, changelogHtml: null };
        let next = prev;

        if (needsDetails) {
          const detailsHtml =
            selectedRemoteMeta?.readme && isProbablyHtml(selectedRemoteMeta.readme)
              ? selectedRemoteMeta.readme
              : (marked.parse(detailsSource) as string);
          next = { ...next, detailsSource, detailsHtml };
        }

        if (needsChangelog) {
          const changelogHtml =
            selectedRemoteMeta?.changelog && isProbablyHtml(selectedRemoteMeta.changelog)
              ? selectedRemoteMeta.changelog
              : (marked.parse(changelogSource) as string);
          next = { ...next, changelogSource, changelogHtml };
        }

        if (next === prev) return existing;
        return { ...existing, [key]: next };
      });
    });
  }, [changelogSource, contentTab, detailsSource, renderedDocsByKey, selectedItem, selectedRemoteMeta?.changelog, selectedRemoteMeta?.readme]);

  return (
    <OverlayDialog className={styles["ext-dialog"]} onClose={onClose} initialFocusRef={searchInputRef}>
      <div className={styles["ext-shell"]}>
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
              <select
                className={styles["ext-source-select"]}
                value={marketplaceSource}
                onChange={(event) => {
                  setMarketplaceSource(event.target.value as MarketplaceSource);
                  if (query.trim() || filterKind !== "none") {
                    void doSearch(query.trim(), event.target.value as MarketplaceSource);
                  }
                }}
              >
                <option value="open-vsx">Open VSX</option>
                <option value="dotdir">.dir</option>
              </select>

              <div className={styles["ext-filter-wrap"]} ref={filterMenuRef}>
                <button
                  className={cx(styles, "ext-filter-button", filterKind !== "none" && "active")}
                  onClick={() => setFilterMenuOpen((open) => !open)}
                >
                  <SmartLabel>{formatFilterLabel(filterKind, selectedCategory)}</SmartLabel>
                </button>
                {filterMenuOpen && (
                  <div className={styles["ext-filter-menu"]}>
                    <button
                      className={cx(styles, "ext-filter-item", filterKind === "none" && "active")}
                      onClick={() => {
                        setFilterKind("none");
                        setSelectedCategory(null);
                        setFilterMenuOpen(false);
                        setCategoryMenuOpen(false);
                      }}
                    >
                      Installed
                    </button>
                    <button
                      className={cx(styles, "ext-filter-item", filterKind === "featured" && "active")}
                      onClick={() => {
                        setFilterKind("featured");
                        setSelectedCategory(null);
                        setFilterMenuOpen(false);
                        setCategoryMenuOpen(false);
                      }}
                    >
                      Featured
                    </button>
                    <button
                      className={cx(styles, "ext-filter-item", filterKind === "recent" && "active")}
                      onClick={() => {
                        setFilterKind("recent");
                        setSelectedCategory(null);
                        setFilterMenuOpen(false);
                        setCategoryMenuOpen(false);
                      }}
                    >
                      Recently Published
                    </button>
                    <button
                      className={cx(styles, "ext-filter-item", filterKind === "recommended" && "active")}
                      onClick={() => {
                        setFilterKind("recommended");
                        setSelectedCategory(null);
                        setFilterMenuOpen(false);
                        setCategoryMenuOpen(false);
                      }}
                    >
                      Recommended
                    </button>
                    <button
                      className={cx(styles, "ext-filter-item", filterKind === "category" && "active")}
                      onClick={() => setCategoryMenuOpen((open) => !open)}
                    >
                      Category
                    </button>
                    {categoryMenuOpen && (
                      <div className={styles["ext-category-menu"]}>
                        {availableCategories.length === 0 ? (
                          <div className={styles["ext-filter-empty"]}>No categories from current source</div>
                        ) : (
                          availableCategories.map((category) => (
                            <button
                              key={category}
                              className={cx(styles, "ext-filter-item", selectedCategory === category && "active")}
                              onClick={() => {
                                setFilterKind("category");
                                setSelectedCategory(category);
                                setFilterMenuOpen(false);
                                setCategoryMenuOpen(false);
                              }}
                            >
                              {category}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {error && <div className={styles["ext-error"]}>{error}</div>}

          <div className={styles["ext-sidebar-list"]}>
            {loading && showingMarketplace && <div className={styles["ext-empty"]}>Loading extensions…</div>}
            {!loading && sidebarItems.length === 0 && (
              <div className={styles["ext-empty"]}>{showingMarketplace ? "No matching extensions" : "No installed extensions"}</div>
            )}
            {sidebarItems.map((item) => {
              const isSelected = item.key === selectedKey;
              const installedExtension = installedByKey.get(item.key);
              const busy = busyByKey[item.key];
              return (
                <button
                  key={item.key}
                  className={cx(styles, "ext-sidebar-item", isSelected && "selected")}
                  onClick={() => {
                    setSelectedKey(item.key);
                    setContentTab("details");
                  }}
                >
                  <div className={styles["ext-item-icon"]}>
                    {item.iconUrl ? <img src={item.iconUrl} alt="" /> : (item.title[0]?.toUpperCase() ?? "?")}
                  </div>
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
                </button>
              );
            })}
          </div>
        </aside>

        <main className={styles["ext-main"]}>
          {!selectedItem ? (
            <div className={styles["ext-main-empty"]}>Select an extension to view details.</div>
          ) : (
            <>
              <header className={styles["ext-hero"]}>
                <div className={styles["ext-hero-icon"]}>
                  {selectedItem.iconUrl ? <img src={selectedItem.iconUrl} alt="" /> : (selectedItem.title[0]?.toUpperCase() ?? "?")}
                </div>
                <div className={styles["ext-hero-copy"]}>
                  <div className={styles["ext-hero-title-row"]}>
                    <h1>{selectedItem.title}</h1>
                    <span className={styles["ext-source-pill"]}>
                      {selectedItem.source === "installed" ? "Installed" : selectedItem.source === "dotdir" ? ".dir" : "Open VSX"}
                    </span>
                  </div>
                  <div className={styles["ext-hero-publisher"]}>{selectedItem.publisher}</div>
                  <p className={styles["ext-hero-description"]}>{selectedItem.description || "No description available."}</p>
                  <div className={styles["ext-stats"]}>
                    <div>
                      <span>Version</span>
                      <strong>{formatVersion(selectedItem.version)}</strong>
                    </div>
                    <div>
                      <span>Downloads</span>
                      <strong>{formatNumber(selectedRemoteMeta?.downloadCount ?? selectedItem.downloads)}</strong>
                    </div>
                    <div>
                      <span>Rating</span>
                      <strong>
                        {selectedRemoteMeta?.averageRating != null
                          ? `${selectedRemoteMeta.averageRating} (${selectedRemoteMeta.reviewCount ?? 0})`
                          : selectedItem.rating == null
                            ? "Unavailable"
                            : selectedItem.rating}
                      </strong>
                    </div>
                    <div>
                      <span>Publisher</span>
                      <strong>{selectedItem.publisher}</strong>
                    </div>
                  </div>
                </div>
                <div className={styles["ext-hero-actions"]}>
                  {selectedInstalled ? (
                    <>
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
                      {selectedIconThemeId && (
                        <button
                          className={cx(styles, "ext-action", selectedIconThemeId === activeIconTheme && "active")}
                          onClick={() => handleSetIconTheme(selectedInstalled)}
                        >
                          <SmartLabel>{selectedIconThemeId === activeIconTheme ? "Deactivate Icon Theme" : "Activate Icon Theme"}</SmartLabel>
                        </button>
                      )}
                      {selectedColorThemes.map((theme: LoadedColorTheme) => {
                        const themeKey = colorThemeKey(selectedInstalled, theme.id);
                        const active = themeKey === activeColorTheme;
                        return (
                          <button key={theme.id} className={cx(styles, "ext-action", active && "active")} onClick={() => handleSetColorTheme(selectedInstalled, theme.id)}>
                            <SmartLabel>{active ? `Deactivate ${theme.label}` : `Activate ${theme.label}`}</SmartLabel>
                          </button>
                        );
                      })}
                      <button className={cx(styles, "ext-action", "danger")} disabled={selectedBusy?.kind === "uninstall"} onClick={() => handleUninstall(selectedInstalled)}>
                        <SmartLabel>{selectedBusy?.kind === "uninstall" ? "Removing…" : "Uninstall"}</SmartLabel>
                      </button>
                    </>
                  ) : (
                    <button className={cx(styles, "ext-action", "primary")} disabled={selectedBusy?.kind === "install"} onClick={() => handleInstall(selectedItem)}>
                      <SmartLabel>{selectedBusy?.kind === "install" ? (selectedBusy.phase === "finalize" ? "Finalizing…" : "Installing…") : "Install"}</SmartLabel>
                    </button>
                  )}
                </div>
              </header>

              <Tabs items={contentTabs} activeItemId={contentTab} onSelectItem={(id) => setContentTab(id as ContentTab)} variant="subtle" />

              <div className={styles["ext-content-body"]}>
                <div className={styles["ext-content-layout"]}>
                  <div className={styles["ext-content-main"]}>
                    {contentTab === "details" && (
                      selectedRenderedDocs?.detailsHtml ? (
                        <div className={styles["ext-markdown"]} dangerouslySetInnerHTML={{ __html: selectedRenderedDocs.detailsHtml }} />
                      ) : (
                        <div className={styles["ext-empty-panel"]}>Loading details…</div>
                      )
                    )}

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

                    {contentTab === "changelog" && (
                      docsLoadingKey === selectedItem.key && !selectedRemoteMeta?.changelog && !selectedDocs?.changelog ? (
                        <div className={styles["ext-empty-panel"]}>Loading changelog…</div>
                      ) : selectedRenderedDocs?.changelogHtml ? (
                        <div className={styles["ext-markdown"]} dangerouslySetInnerHTML={{ __html: selectedRenderedDocs.changelogHtml }} />
                      ) : (
                        <div className={styles["ext-empty-panel"]}>Loading changelog…</div>
                      )
                    )}
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
                          ) : (
                            <ul className={styles["ext-info-links"]}>
                              {section.links.map((link) => (
                                <li key={`${section.title}-${link.href}`}>
                                  <a href={link.href} target="_blank" rel="noreferrer">
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
