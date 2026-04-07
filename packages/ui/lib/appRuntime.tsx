import { useProvideCommandLine } from "@/features/command-line/useCommandLine";
import { useProvideTerminal } from "@/features/terminal/useTerminal";
import { useProvideUiState } from "@/features/ui-state/uiState";
import { useMemo, type ReactNode } from "react";
import { AppRuntimeContext, type AppRuntimeContextValue } from "./appRuntimeContext";

export function AppRuntimeProvider({ children }: { children: ReactNode }) {
  const uiState = useProvideUiState();
  const terminal = useProvideTerminal();
  const commandLine = useProvideCommandLine(terminal);

  const value = useMemo<AppRuntimeContextValue>(
    () => ({
      uiState,
      terminal,
      commandLine,
    }),
    [commandLine, terminal, uiState],
  );

  return <AppRuntimeContext.Provider value={value}>{children}</AppRuntimeContext.Provider>;
}
