export interface ActivePanelGroupHandlers {
  newTab(): void;
  closeActiveTab(): Promise<void>;
}

let current: ActivePanelGroupHandlers | null = null;

export function setActivePanelGroupHandlers(handlers: ActivePanelGroupHandlers | null): void {
  current = handlers;
}

export function getActivePanelGroupHandlers(): ActivePanelGroupHandlers | null {
  return current;
}
