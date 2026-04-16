/**
 * Shared runtime state + transport for the vscode shim inside the
 * extension host worker.
 *
 * All APIs route requests/events through `rpc`, which is injected by
 * `extensionHost.worker.ts` at startup. The shim itself has no idea how
 * messages reach the main thread — it just calls `rpc.send`/`rpc.request`
 * and subscribes to inbound events via `rpc.dispatch`.
 */

import type {
  HostToMainMessage,
  MainToHostMessage,
  ProviderKind,
  DocumentSelectorPayload,
} from "../ehProtocol";

export type WorkerRpcHandler = (msg: MainToHostMessage) => void;

export interface WorkerRpc {
  send(msg: HostToMainMessage): void;
  request<T = unknown>(msg: HostToMainMessage & { requestId: number }): Promise<T>;
  nextRequestId(): number;
  dispatch(msg: MainToHostMessage): boolean;
  subscribe(type: MainToHostMessage["type"], handler: WorkerRpcHandler): () => void;
}

interface RuntimeState {
  rpc: WorkerRpc;
  currentExtensionKey: string | null;
  dataDir: string | null;
}

// Singleton mutable state — the shim is instantiated once per worker.
const state: RuntimeState = {
  rpc: null as unknown as WorkerRpc,
  currentExtensionKey: null,
  dataDir: null,
};

export function installWorkerRpc(rpc: WorkerRpc): void {
  state.rpc = rpc;
}

export function getRpc(): WorkerRpc {
  if (!state.rpc) throw new Error("vscode shim: worker RPC not installed");
  return state.rpc;
}

export function setActiveExtensionKey(key: string | null): void {
  state.currentExtensionKey = key;
}

export function getActiveExtensionKey(): string {
  return state.currentExtensionKey ?? "unknown.extension";
}

export function setDataDir(dataDir: string | null): void {
  state.dataDir = dataDir;
}

export function getDataDir(): string | null {
  return state.dataDir;
}

// ── Logging helper that routes through activation log channel ──────

export function logActivation(level: "info" | "warn" | "error", message: string, event?: string): void {
  state.rpc?.send({
    type: "activationLog",
    level,
    extension: getActiveExtensionKey(),
    event,
    message,
  });
}

// ── Provider registry (shared by languages.*) ───────────────────────

let nextProviderId = 1;
export function allocProviderId(): number {
  return nextProviderId++;
}

export interface ProviderRecord {
  id: number;
  kind: ProviderKind;
  selector: DocumentSelectorPayload;
  provider: unknown;
  metadata?: Record<string, unknown>;
}

const providerRegistry = new Map<number, ProviderRecord>();

export function registerProvider(record: ProviderRecord): void {
  providerRegistry.set(record.id, record);
  getRpc().send({
    type: "provider/register",
    providerId: record.id,
    kind: record.kind,
    selector: record.selector,
    metadata: record.metadata,
  });
}

export function unregisterProvider(id: number): void {
  if (!providerRegistry.delete(id)) return;
  getRpc().send({ type: "provider/unregister", providerId: id });
}

export function getProvider(id: number): ProviderRecord | undefined {
  return providerRegistry.get(id);
}
