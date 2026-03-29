export function cx(styles: Record<string, string>, ...classNames: Array<string | false | null | undefined>) {
  return classNames
    .filter((className): className is string => Boolean(className))
    .map((className) => styles[className])
    .join(" ");
}
