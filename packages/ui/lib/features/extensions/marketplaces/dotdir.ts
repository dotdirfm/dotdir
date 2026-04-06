import { coerce, compare, valid } from "semver";
import type { MarketplaceExtension, MarketplaceUpdateInfo } from "../types";
import type { MarketplaceDetails, MarketplaceProvider, MarketplaceSearchItem } from "./provider";

export const MARKETPLACE_URL = "https://dotdir.dev";

function normalizeDotDirItem(ext: MarketplaceExtension): MarketplaceSearchItem {
  return {
    provider: "dotdir",
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
  };
}

function normalizeDotDirDetails(ext: MarketplaceExtension): MarketplaceDetails {
  const base = normalizeDotDirItem(ext);
  return {
    ...base,
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

export async function searchDotDirMarketplace(query = "", page = 1): Promise<{ extensions: MarketplaceExtension[]; total: number }> {
  const pageSize = 30;
  const params = new URLSearchParams({
    size: String(pageSize),
    offset: String((page - 1) * pageSize),
  });
  if (query) params.set("query", query);
  const res = await fetch(`${MARKETPLACE_URL}/api/-/search?${params}`);
  if (!res.ok) throw new Error("Failed to search marketplace");
  const data = (await res.json()) as { extensions?: MarketplaceExtension[]; totalSize?: number };
  return {
    extensions: Array.isArray(data.extensions) ? data.extensions : [],
    total: data.totalSize ?? 0,
  };
}

export async function fetchDotDirExtensionDetails(namespace: string, name: string): Promise<MarketplaceExtension> {
  const res = await fetch(`${MARKETPLACE_URL}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/latest`);
  if (!res.ok) throw new Error("Failed to fetch marketplace extension details");
  return res.json() as Promise<MarketplaceExtension>;
}

export async function checkDotDirUpdates(extensions: Array<{ publisher: string; name: string; version: string }>): Promise<MarketplaceUpdateInfo[]> {
  return Promise.all(
    extensions.map(async (ext) => {
      try {
        const latest = await fetchDotDirExtensionDetails(ext.publisher, ext.name);
        const latestVersion = latest.version || null;
        return {
          publisher: ext.publisher,
          name: ext.name,
          currentVersion: ext.version,
          latestVersion,
          hasUpdate: latestVersion ? compareExtensionVersions(latestVersion, ext.version) > 0 : false,
        };
      } catch {
        return {
          publisher: ext.publisher,
          name: ext.name,
          currentVersion: ext.version,
          latestVersion: null,
          hasUpdate: false,
        };
      }
    }),
  );
}

export function compareExtensionVersions(left: string, right: string): number {
  if (left === right) return 0;
  const normalizedLeft = valid(left) ?? coerce(left)?.version;
  const normalizedRight = valid(right) ?? coerce(right)?.version;
  if (normalizedLeft && normalizedRight) {
    return compare(normalizedLeft, normalizedRight);
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export const dotdirMarketplaceProvider: MarketplaceProvider = {
  id: "dotdir",
  label: ".dir",
  async search(query, page = 1) {
    const result = await searchDotDirMarketplace(query, page);
    return {
      items: result.extensions.map(normalizeDotDirItem),
      total: result.total,
    };
  },
  async getDetails(publisher, name) {
    return normalizeDotDirDetails(await fetchDotDirExtensionDetails(publisher, name));
  },
  getInstallRequest(item) {
    return {
      source: "dotdir-marketplace",
      publisher: item.publisher,
      name: item.name,
      version: item.version,
    };
  },
  checkUpdates: checkDotDirUpdates,
};
