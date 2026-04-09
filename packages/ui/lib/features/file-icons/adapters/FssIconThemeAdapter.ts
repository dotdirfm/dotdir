import type { IconAssetStore } from "../iconCache";
import type { IconLookupInput, IconThemeAdapter } from "./types";

export class FssIconThemeAdapter implements IconThemeAdapter {
  readonly kind = "fss" as const;

  constructor(private iconAssets: IconAssetStore) {}

  resolve(input: IconLookupInput): string | null {
    return input.fssIconPath ?? null;
  }

  async preload(keys: string[]): Promise<void> {
    await this.iconAssets.loadIcons(keys);
  }

  getCachedUrl(key: string): string | null {
    return this.iconAssets.getCachedIconUrl(key) ?? null;
  }

  clear(): void {}
}
