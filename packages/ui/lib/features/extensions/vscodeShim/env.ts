/**
 * vscode.env namespace.
 * Mostly static values — only `openExternal` and `clipboard.writeText`
 * forward to the main thread.
 */

import { UIKind } from "./enums";
import { EventEmitter } from "./events";
import { getRpc, logActivation } from "./runtime";
import { Uri } from "./types";

function uuid(): string {
  // RFC4122 v4-ish; cryptographically-strong isn't required for session id.
  const bytes = new Uint8Array(16);
  const g = globalThis as unknown as { crypto?: Crypto };
  if (g.crypto?.getRandomValues) g.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const sessionId = uuid();
const machineId = uuid();

export const onDidChangeTelemetryEnabled = new EventEmitter<boolean>();
export const onDidChangeShell = new EventEmitter<string>();

export const env = {
  appName: ".dir",
  appRoot: "",
  appHost: "desktop",
  uriScheme: "dotdir",
  language: "en",
  clipboard: {
    async readText(): Promise<string> {
      return "";
    },
    async writeText(_value: string): Promise<void> {
      // not wired yet; silent no-op
    },
  },
  machineId,
  sessionId,
  remoteName: undefined as string | undefined,
  shell: "/bin/sh",
  uiKind: UIKind.Desktop as UIKind,
  isTelemetryEnabled: false,
  logLevel: 1,
  onDidChangeLogLevel: new EventEmitter<number>().event,
  onDidChangeTelemetryEnabled: onDidChangeTelemetryEnabled.event,
  onDidChangeShell: onDidChangeShell.event,
  isNewAppInstall: false,

  async openExternal(target: Uri | string): Promise<boolean> {
    const uri = target instanceof Uri ? target.toString() : String(target);
    logActivation("info", `vscode.env.openExternal ${uri}`);
    const rpc = getRpc();
    const requestId = rpc.nextRequestId();
    try {
      await rpc.request({ type: "env/openExternal", requestId, uri });
      return true;
    } catch {
      return false;
    }
  },

  async asExternalUri(target: Uri): Promise<Uri> {
    return target;
  },

  createTelemetryLogger(): {
    onDidChangeEnableStates: typeof onDidChangeTelemetryEnabled.event;
    isUsageEnabled: boolean;
    isErrorsEnabled: boolean;
    logUsage: () => void;
    logError: () => void;
    dispose: () => void;
  } {
    // TODO(vscode-shim): implement telemetry logger routing and enable-state updates.
    return {
      onDidChangeEnableStates: onDidChangeTelemetryEnabled.event,
      isUsageEnabled: false,
      isErrorsEnabled: false,
      // TODO(vscode-shim): forward usage telemetry events.
      logUsage: () => {},
      // TODO(vscode-shim): forward error telemetry events.
      logError: () => {},
      // TODO(vscode-shim): unregister telemetry logger resources.
      dispose: () => {},
    };
  },
};
