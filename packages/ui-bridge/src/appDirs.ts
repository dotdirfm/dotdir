import { use, useRef } from "react";
import type { AppDirs, Bridge } from "./bridge";
import { useBridge } from "./useBridge";

export async function readAppDirs(bridge: Bridge): Promise<AppDirs> {
  return await bridge.utils.getAppDirs();
}

export function useAppDirs(): AppDirs {
  const bridge = useBridge();
  const cached = useRef<{ bridge: Bridge; promise: Promise<AppDirs> } | null>(null);

  if (!cached.current || cached.current.bridge !== bridge) {
    cached.current = { bridge, promise: readAppDirs(bridge) };
  }

  return use(cached.current.promise);
}
