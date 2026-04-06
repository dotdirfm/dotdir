import type { MarketplaceProvider, MarketplaceDetails, MarketplaceSearchItem } from "./provider";
const OPEN_VSX_MARKETPLACE_URL = "https://open-vsx.org";

export interface OpenVsxExtension {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  downloadCount: number;
  files?: {
    download?: string;
    icon?: string;
  };
}

export interface OpenVsxExtensionDetails {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  namespaceDisplayName?: string;
  description: string;
  averageRating?: number;
  reviewCount?: number;
  downloadCount?: number;
  categories?: string[];
  tags?: string[];
  timestamp?: string;
  homepage?: string;
  repository?: string;
  bugs?: string;
  files?: {
    readme?: string;
    changelog?: string;
    icon?: string;
    download?: string;
  };
}

interface OpenVsxSearchResult {
  offset: number;
  totalSize: number;
  extensions: OpenVsxExtension[];
}

export async function searchOpenVsxMarketplace(query: string, page = 1): Promise<{ extensions: OpenVsxExtension[]; total: number }> {
  const pageSize = 30;
  const params = new URLSearchParams({
    size: String(pageSize),
    offset: String((page - 1) * pageSize),
  });
  if (query) params.set("query", query);

  const res = await fetch(`${OPEN_VSX_MARKETPLACE_URL}/api/-/search?${params.toString()}`);

  if (!res.ok) throw new Error("Open VSX marketplace request failed");
  const data: OpenVsxSearchResult = await res.json();
  return {
    extensions: data.extensions ?? [],
    total: data.totalSize ?? 0,
  };
}

export async function fetchOpenVsxExtensionDetails(namespace: string, name: string): Promise<OpenVsxExtensionDetails> {
  const res = await fetch(`${OPEN_VSX_MARKETPLACE_URL}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/latest`);
  if (!res.ok) throw new Error("Open VSX extension details request failed");
  return res.json() as Promise<OpenVsxExtensionDetails>;
}

export function getOpenVsxDownloadUrl(ext: OpenVsxExtension): string | null {
  return ext.files?.download ?? null;
}

export function getOpenVsxIconUrl(ext: OpenVsxExtension): string | null {
  return ext.files?.icon ?? null;
}

function normalizeOpenVsxItem(ext: OpenVsxExtension): MarketplaceSearchItem {
  return {
    provider: "open-vsx",
    key: `${ext.namespace}.${ext.name}`,
    publisher: ext.namespace,
    publisherDisplayName: ext.namespace,
    name: ext.name,
    version: ext.version,
    title: ext.displayName,
    description: ext.description,
    iconUrl: getOpenVsxIconUrl(ext),
    downloads: ext.downloadCount ?? null,
    rating: null,
    reviewCount: null,
    categories: [],
    tags: [],
    publishedAt: null,
    downloadUrl: ext.files?.download ?? null,
  };
}

function normalizeOpenVsxDetails(ext: OpenVsxExtensionDetails): MarketplaceDetails {
  return {
    provider: "open-vsx",
    key: `${ext.namespace}.${ext.name}`,
    publisher: ext.namespace,
    publisherDisplayName: ext.namespaceDisplayName ?? ext.namespace,
    name: ext.name,
    version: ext.version,
    title: ext.displayName,
    description: ext.description,
    iconUrl: ext.files?.icon ?? null,
    downloads: ext.downloadCount ?? null,
    rating: ext.averageRating ?? null,
    reviewCount: ext.reviewCount ?? null,
    categories: ext.categories ?? [],
    tags: ext.tags ?? [],
    publishedAt: ext.timestamp ?? null,
    namespaceDisplayName: ext.namespaceDisplayName ?? null,
    timestamp: ext.timestamp ?? null,
    homepage: ext.homepage ?? null,
    repository: ext.repository ?? null,
    bugs: ext.bugs ?? null,
    readmeUrl: ext.files?.readme ?? null,
    changelogUrl: ext.files?.changelog ?? null,
    downloadUrl: ext.files?.download ?? null,
  };
}

export const openVsxMarketplaceProvider: MarketplaceProvider = {
  id: "open-vsx",
  label: "Open VSX",
  async search(query, page = 1) {
    const result = await searchOpenVsxMarketplace(query, page);
    return {
      items: result.extensions.map(normalizeOpenVsxItem),
      total: result.total,
    };
  },
  async getDetails(publisher, name) {
    return normalizeOpenVsxDetails(await fetchOpenVsxExtensionDetails(publisher, name));
  },
  getInstallRequest(item) {
    return item.downloadUrl
      ? {
          source: "open-vsx-marketplace",
          publisher: item.publisher,
          name: item.name,
          downloadUrl: item.downloadUrl,
        }
      : null;
  },
};
