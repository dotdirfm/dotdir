import { dotdirMarketplaceProvider } from "./dotdir";
import { openVsxMarketplaceProvider } from "./openVsx";
import type { MarketplaceProvider, MarketplaceProviderId } from "./provider";

export const marketplaceProviders: Record<MarketplaceProviderId, MarketplaceProvider> = {
  dotdir: dotdirMarketplaceProvider,
  "open-vsx": openVsxMarketplaceProvider,
};

export function getMarketplaceProvider(id: MarketplaceProviderId): MarketplaceProvider {
  return marketplaceProviders[id];
}

export type { MarketplaceDetails, MarketplaceProvider, MarketplaceProviderId, MarketplaceSearchItem } from "./provider";
