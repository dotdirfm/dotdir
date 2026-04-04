import type { CommandRegistry } from "./commands";

export type RunCommandsStep =
  | string
  | {
      command: string;
      args?: unknown;
    };

export type RunCommandsArgs = {
  commands: RunCommandsStep[];
};

export async function runCommandSequence(commandRegistry: CommandRegistry, commands: RunCommandsStep[]): Promise<void> {
  for (const step of commands) {
    if (typeof step === "string") {
      await commandRegistry.executeCommand(step);
      continue;
    }

    if (Array.isArray(step.args)) {
      await commandRegistry.executeCommand(step.command, ...step.args);
      continue;
    }

    if (step.args !== undefined) {
      await commandRegistry.executeCommand(step.command, step.args);
      continue;
    }

    await commandRegistry.executeCommand(step.command);
  }
}
