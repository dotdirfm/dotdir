type ClassArg = string | false | null | undefined | ClassArg[];

/**
 * CSS Modules-aware classname helper.
 *
 * Accepts class names and resolves them through the CSS Modules map.
 * Supports conditional values (falsy values are skipped), nested arrays,
 * and runs all values through the module map.
 *
 * ```tsx
 * cx(styles, "panel", active && "active", ["foo", "bar"])
 * // => `${styles["panel"]} ${styles["active"]} ${styles["foo"]} ${styles["bar"]}`
 * ```
 */
export function cx(styles: Record<string, string>, ...classNames: ClassArg[]): string {
  const resolved: string[] = [];

  function append(value: ClassArg): void {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) append(item);
      return;
    }
    const mapped = styles[value];
    if (mapped) resolved.push(mapped);
  }

  for (const arg of classNames) append(arg);
  return resolved.join(" ");
}
