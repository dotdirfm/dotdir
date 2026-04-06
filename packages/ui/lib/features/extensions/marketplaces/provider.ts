import type { ExtensionInstallRequest } from "@/features/bridge";
import type { MarketplaceUpdateInfo } from "../types";

export type MarketplaceProviderId = "dotdir" | "open-vsx";

export interface MarketplaceSearchItem {
  provider: MarketplaceProviderId;
  key: string;
  publisher: string;
  publisherDisplayName?: string;
  name: string;
  version: string;
  title: string;
  description: string;
  iconUrl: string | null;
  downloads: number | null;
  rating: number | null;
  reviewCount: number | null;
  categories: string[];
  tags: string[];
  publishedAt: string | null;
  downloadUrl?: string | null;
}

export interface MarketplaceDetails extends MarketplaceSearchItem {
  namespaceDisplayName: string | null;
  timestamp: string | null;
  homepage: string | null;
  repository: string | null;
  bugs: string | null;
  readmeUrl: string | null;
  changelogUrl: string | null;
  downloadUrl: string | null;
}

export interface MarketplaceProvider {
  id: MarketplaceProviderId;
  label: string;
  search(query: string, page?: number): Promise<{ items: MarketplaceSearchItem[]; total: number }>;
  getDetails(publisher: string, name: string): Promise<MarketplaceDetails>;
  getInstallRequest(item: MarketplaceSearchItem): ExtensionInstallRequest | null;
  checkUpdates?(extensions: Array<{ publisher: string; name: string; version: string }>): Promise<MarketplaceUpdateInfo[]>;
}
