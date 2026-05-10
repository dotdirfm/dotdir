import type { CommandRegistry, RunCommandsStep } from "./commands";

/** @deprecated Use `registry.executeCommands(steps)` instead. */
export async function runCommandSequence(commandRegistry: CommandRegistry, commands: RunCommandsStep[]): Promise<void> {
  return commandRegistry.executeCommands(commands);
}

