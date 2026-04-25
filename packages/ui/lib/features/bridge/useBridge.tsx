import { atom, useAtom, useAtomValue } from "jotai";
import { createContext, useContext, useEffect } from "react";
import type { Bridge, BridgeFactory } from ".";

export const bridgeAtom = atom<Bridge | null>(null);
const BridgeFactoryContext = createContext<BridgeFactory | null>(null);

export function useBridge(): Bridge {
  const bridge = useAtomValue(bridgeAtom);
  if (!bridge) {
    throw new Error(
      "Bridge not initialized. Make sure DotDir received a bridgeFactory.",
    );
  }
  return bridge;
}

export function BridgeProvider({ bridge, children }: { bridge: Bridge; children: React.ReactNode }) {
  const [bridgeState, setBridge] = useAtom(bridgeAtom);

  useEffect(() => {
    setBridge(bridge);
    return () => {
      setBridge(null);
    };
  }, [bridge, setBridge]);

  if (bridgeState !== bridge) {
    return null;
  }
  return <>{children}</>;
}

export function BridgeFactoryProvider({ bridgeFactory, children }: { bridgeFactory: BridgeFactory; children: React.ReactNode }) {
  return <BridgeFactoryContext.Provider value={bridgeFactory}>{children}</BridgeFactoryContext.Provider>;
}

export function useBridgeFactory(): BridgeFactory {
  const bridgeFactory = useContext(BridgeFactoryContext);
  if (!bridgeFactory) {
    throw new Error("Bridge factory not initialized. Make sure to render BridgeFactoryProvider.");
  }
  return bridgeFactory;
}
