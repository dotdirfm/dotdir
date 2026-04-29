import { useRef } from "react";

/**
 * Returns a ref whose `.current` property always holds the latest value
 * without causing re-renders. Useful for capturing changing values inside
 * long-lived effects (e.g. command registrations) without breaking the
 * dependency array.
 *
 * ```ts
 * function MyComponent({ onClick }) {
 *   const onClickRef = useLatestRef(onClick);
 *   useEffect(() => {
 *     return registry.register("click", () => onClickRef.current());
 *   }, [registry]);
 * }
 * ```
 */
export function useLatestRef<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
