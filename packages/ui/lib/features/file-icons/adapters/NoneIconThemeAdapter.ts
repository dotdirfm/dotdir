import type { IconThemeAdapter } from "./types";

export class NoneIconThemeAdapter implements IconThemeAdapter {
  readonly kind = "none" as const;

  resolve() {
    return null;
  }

  clear(): void {}
}
