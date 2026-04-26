import type { CommandContribution, CommandRegistry, Keybinding } from "@dotdirfm/commands";
import { executeMountedExtensionCommand } from "@/features/extensions/extensionCommandHandlers";

export type MonacoCommandContribution = {
  command: string;
  title: string;
  shortTitle?: string;
  palette?: boolean;
  keybinding?: Pick<Keybinding, "key" | "mac">;
};

export const DOTDIR_MONACO_EXECUTE_ACTION = "dotdir.monaco.executeAction";
export const MONACO_QUICK_COMMAND_ACTION = "editor.action.quickCommand";

type MonacoBridgeState = {
  refCounts: Map<string, number>;
  disposers: Map<string, () => void>;
};

const bridgeStateByRegistry = new WeakMap<CommandRegistry, MonacoBridgeState>();

function getBridgeState(commandRegistry: CommandRegistry): MonacoBridgeState {
  let state = bridgeStateByRegistry.get(commandRegistry);
  if (!state) {
    state = {
      refCounts: new Map(),
      disposers: new Map(),
    };
    bridgeStateByRegistry.set(commandRegistry, state);
  }
  return state;
}

function toCommandContribution(command: MonacoCommandContribution): CommandContribution {
  return {
    command: command.command,
    title: command.title,
    shortTitle: command.shortTitle,
    category: "Editor",
    when: "focusEditor",
    palette: command.palette,
  };
}

export function registerMonacoCommandContributions(
  commandRegistry: CommandRegistry,
  commands: MonacoCommandContribution[],
): () => void {
  const state = getBridgeState(commandRegistry);
  const uniqueCommands = Array.from(new Map(commands.map((command) => [command.command, command])).values());

  for (const command of uniqueCommands) {
    const currentCount = state.refCounts.get(command.command) ?? 0;
    state.refCounts.set(command.command, currentCount + 1);
    if (currentCount > 0) continue;

    const disposeContributions = commandRegistry.registerContributions([toCommandContribution(command)]);
    const disposeKeybinding = command.keybinding
      ? commandRegistry.registerKeybinding(
          {
            command: command.command,
            key: command.keybinding.key,
            mac: command.keybinding.mac,
            when: "focusEditor",
          },
          "extension",
        )
      : () => {};
    const disposeCommand = commandRegistry.registerCommand(command.command, async (...args: unknown[]) => {
      const payload = args.length <= 1 ? args[0] : args;
      await executeMountedExtensionCommand(DOTDIR_MONACO_EXECUTE_ACTION, [command.command, payload]);
    });

    state.disposers.set(command.command, () => {
      disposeCommand();
      disposeKeybinding();
      disposeContributions();
    });
  }

  return () => {
    for (const command of uniqueCommands) {
      const currentCount = state.refCounts.get(command.command);
      if (!currentCount) continue;
      if (currentCount > 1) {
        state.refCounts.set(command.command, currentCount - 1);
        continue;
      }
      state.refCounts.delete(command.command);
      const dispose = state.disposers.get(command.command);
      state.disposers.delete(command.command);
      dispose?.();
    }
  };
}
