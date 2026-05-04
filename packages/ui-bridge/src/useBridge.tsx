import { atom, useAtom, useAtomValue } from "jotai";
import type { Bridge } from ".";

export const bridgeAtom = atom<Bridge | null>(null);

export function useBridge(): Bridge {
  const bridge = useAtomValue(bridgeAtom);
  if (!bridge) {
    throw new Error(
      "Bridge not initialized. Make sure to call initBridge() before rendering.",
    );
  }
  return bridge;
}

export function BridgeProvider({ bridge, children }: { bridge: Bridge; children: React.ReactNode }) {
  const [bridgeState, setBridge] = useAtom(bridgeAtom);
  
  if (bridgeState !== bridge) {
    setBridge(bridge);
  }

  if (!bridgeState) {
    return null;
  }

  return <>{children}</>;
}
