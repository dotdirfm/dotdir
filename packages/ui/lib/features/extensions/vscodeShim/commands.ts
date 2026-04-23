/**
 * vscode.commands namespace — routes through the extension host worker's
 * command registry (see `runCommand` in extensionHost.worker.ts).
 */

import { Disposable } from "./events";
import { getRpc, logActivation } from "./runtime";

export interface WorkerCommandRegistryAdapter {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown | Promise<unknown>): Disposable;
  executeWorkerCommand(id: string, args: unknown[]): Promise<unknown>;
  hasWorkerCommand(id: string): boolean;
  listCommands(): string[];
}

let adapter: WorkerCommandRegistryAdapter | null = null;
let nextStashedCommandArgsToken = 1;
const stashedCommandArgs = new Map<number, unknown[]>();

interface CommandArgsTokenPayload {
  __dotdirCommandArgsToken: number;
}

function isCommandArgsTokenPayload(value: unknown): value is CommandArgsTokenPayload {
  if (!value || typeof value !== "object") return false;
  const anyValue = value as { __dotdirCommandArgsToken?: unknown };
  return typeof anyValue.__dotdirCommandArgsToken === "number";
}

export function installCommandAdapter(impl: WorkerCommandRegistryAdapter): void {
  adapter = impl;
}

export function stashCommandArguments(args: unknown[] | undefined): CommandArgsTokenPayload | undefined {
  if (!args) return undefined;
  const token = nextStashedCommandArgsToken++;
  stashedCommandArgs.set(token, args);
  return { __dotdirCommandArgsToken: token };
}

export function resolveStashedCommandArguments(args: unknown[]): unknown[] {
  if (args.length !== 1 || !isCommandArgsTokenPayload(args[0])) return args;
  const token = args[0].__dotdirCommandArgsToken;
  const stashed = stashedCommandArgs.get(token);
  stashedCommandArgs.delete(token);
  if (!stashed) {
    logActivation("warn", `stashed command args token ${token} was not found`);
  }
  return stashed ?? [];
}

function getAdapter(): WorkerCommandRegistryAdapter {
  if (!adapter) throw new Error("vscode.commands: adapter not installed");
  return adapter;
}

export function registerCommand<T = unknown>(command: string, callback: (...args: unknown[]) => T | Promise<T>, thisArg?: unknown): Disposable {
  const bound = thisArg !== undefined ? callback.bind(thisArg) : callback;
  logActivation("info", `vscode.commands.registerCommand ${command}`);
  return getAdapter().registerCommand(command, bound as (...args: unknown[]) => unknown);
}

export function registerTextEditorCommand(
  command: string,
  callback: (...args: unknown[]) => unknown,
  thisArg?: unknown,
): Disposable {
  return registerCommand(command, callback, thisArg);
}

export async function executeCommand<T = unknown>(command: string, ...rest: unknown[]): Promise<T> {
  logActivation("info", `vscode.commands.executeCommand ${command}`);
  const registry = getAdapter();
  if (registry.hasWorkerCommand(command)) {
    return (await registry.executeWorkerCommand(command, resolveStashedCommandArguments(rest))) as T;
  }
  // Forward to main thread
  const rpc = getRpc();
  const requestId = rpc.nextRequestId();
  try {
    return (await rpc.request({
      type: "command/execute",
      requestId,
      command,
      args: rest,
    })) as T;
  } catch (err) {
    logActivation("warn", `executeCommand ${command} rejected: ${err instanceof Error ? err.message : String(err)}`);
    return undefined as unknown as T;
  }
}

export async function getCommands(_filterInternal?: boolean): Promise<string[]> {
  return getAdapter().listCommands();
}

export const commands = {
  registerCommand,
  registerTextEditorCommand,
  executeCommand,
  getCommands,
};
