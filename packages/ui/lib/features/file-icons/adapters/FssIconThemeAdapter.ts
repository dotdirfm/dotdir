import type { IconLookupInput, IconThemeAdapter } from "./types";

export class FssIconThemeAdapter implements IconThemeAdapter {
  readonly kind = "fss" as const;

  resolve(_input: IconLookupInput) {
    return null;
  }

  clear(): void {}
}
