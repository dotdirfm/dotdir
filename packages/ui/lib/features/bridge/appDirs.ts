import type { AppDirs, Bridge } from "./bridge";

const appDirsCache = new WeakMap<Bridge, Promise<AppDirs>>();

export function getAppDirs(bridge: Bridge): Promise<AppDirs> {
  const cached = appDirsCache.get(bridge);
  if (cached) return cached;

  const pending = bridge.utils.getAppDirs().then((dirs) => ({
    homeDir: dirs.homeDir,
    configDir: dirs.configDir,
    dataDir: dirs.dataDir,
    cacheDir: dirs.cacheDir,
  }));
  appDirsCache.set(bridge, pending);
  return pending;
}
