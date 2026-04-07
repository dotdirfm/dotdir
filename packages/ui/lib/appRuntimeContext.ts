import { createContext, useContext } from "react";
import type { CommandLineContextValue } from "@/features/command-line/useCommandLine";
import type { TerminalContextValue } from "@/features/terminal/useTerminal";
import type { UiStateContextValue } from "@/features/ui-state/uiState";

export type AppRuntimeContextValue = {
  uiState: UiStateContextValue;
  terminal: TerminalContextValue;
  commandLine: CommandLineContextValue;
};

export const AppRuntimeContext = createContext<AppRuntimeContextValue | null>(null);

export function useAppRuntimeContext(): AppRuntimeContextValue {
  const value = useContext(AppRuntimeContext);
  if (!value) {
    throw new Error("App runtime not initialized. Make sure AppRuntimeProvider is mounted.");
  }
  return value;
}
