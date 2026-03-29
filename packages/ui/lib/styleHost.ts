let styleHostElement: HTMLElement | null = null;

export function setStyleHostElement(element: HTMLElement | null): void {
  styleHostElement = element;
}

export function getStyleHostElement(): HTMLElement {
  return styleHostElement ?? document.documentElement;
}
