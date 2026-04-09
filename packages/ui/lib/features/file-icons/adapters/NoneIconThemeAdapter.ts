import type { IconThemeAdapter } from "./types";

export class NoneIconThemeAdapter implements IconThemeAdapter {
  readonly kind = "none" as const;

  resolve(): string | null {
    return null;
  }

  clear(): void {}
}
