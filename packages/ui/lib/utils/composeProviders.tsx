import type { FunctionComponent, ReactNode } from "react";
import { createElement } from "react";

/**
 * Composes multiple React context providers without deep nesting.
 *
 * ```tsx
 * <ComposeProviders
 *   providers={[
 *     [ThemeProvider, { theme }],
 *     [AuthProvider, { userId }],
 *     [RouterProvider],
 *   ]}
 * >
 *   <App />
 * </ComposeProviders>
 * ```
 *
 * This is equivalent to:
 * ```tsx
 * <ThemeProvider theme={theme}>
 *   <AuthProvider userId={userId}>
 *     <RouterProvider>
 *       <App />
 *     </RouterProvider>
 *   </AuthProvider>
 * </ThemeProvider>
 * ```
 */
export function ComposeProviders({
  providers,
  children,
}: {
  providers: Array<[FunctionComponent<any>, Record<string, unknown>?]>;
  children: ReactNode;
}) {
  return providers.reduceRight(
    (acc, [Provider, props]) =>
      createElement(Provider, { ...props, children: acc }),
    children as React.ReactElement,
  );
}
