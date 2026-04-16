type ExtensionCommandHandler = (...args: unknown[]) => void | Promise<void>;

type RegisteredHandler = {
  token: symbol;
  handler: ExtensionCommandHandler;
  isActive?: () => boolean;
};

const handlersByCommand = new Map<string, RegisteredHandler[]>();

export function registerMountedExtensionCommandHandler(
  commandId: string,
  handler: ExtensionCommandHandler,
  options?: { isActive?: () => boolean },
): () => void {
  const token = Symbol(commandId);
  const handlers = handlersByCommand.get(commandId) ?? [];
  handlers.push({ token, handler, isActive: options?.isActive });
  handlersByCommand.set(commandId, handlers);

  return () => {
    const current = handlersByCommand.get(commandId);
    if (!current) return;
    const next = current.filter((entry) => entry.token !== token);
    if (next.length === 0) handlersByCommand.delete(commandId);
    else handlersByCommand.set(commandId, next);
  };
}

export async function executeMountedExtensionCommand(
  commandId: string,
  args: unknown[],
): Promise<boolean> {
  const handlers = handlersByCommand.get(commandId);
  const active =
    handlers && handlers.length > 0
      ? [...handlers].reverse().find((entry) => {
          if (!entry.isActive) return false;
          try {
            return entry.isActive();
          } catch {
            return false;
          }
        }) ?? handlers[handlers.length - 1]
      : null;
  if (!active) return false;
  await active.handler(...args);
  return true;
}
