const STYLE_HOST_SELECTOR = "[data-dotdir-style-host='true']";

export function getStyleHostElement(): HTMLElement {
  return (document.querySelector(STYLE_HOST_SELECTOR) as HTMLElement | null) ?? document.documentElement;
}
