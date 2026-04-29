import { use, useMemo } from "react";
import type { AppDirs, Bridge } from "./bridge";
import { useBridge } from "./useBridge";

export async function readAppDirs(bridge: Bridge): Promise<AppDirs> {
  return await bridge.utils.getAppDirs();
}

export function useAppDirs(): AppDirs {
  const bridge = useBridge();
  const promise = useMemo(() => readAppDirs(bridge), [bridge]);
  return use(promise);
}
