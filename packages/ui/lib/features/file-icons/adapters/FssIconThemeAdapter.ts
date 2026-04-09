import type { IconLookupInput, IconThemeAdapter } from "./types";

export class FssIconThemeAdapter implements IconThemeAdapter {
  readonly kind = "fss" as const;

  resolve(_input: IconLookupInput): string | null {
    return null;
  }

  clear(): void {}
}
