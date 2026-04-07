import { getMarketplaceProvider } from "@/features/extensions/marketplaces";
import { compareExtensionVersions } from "@/features/extensions/marketplaces/dotdir";
import { extensionRef, type ExtensionInstallSource } from "@/features/extensions/types";
import { useExtensionsAutoUpdateEnabled } from "@/features/settings/useUserSettings";
import { useCallback, useEffect, useRef } from "react";
import { useLoadedExtensions } from "../useLoadedExtensions";
import { AUTO_UPDATE_INITIAL_DELAY_MS, AUTO_UPDATE_INTERVAL_MS, useLatestRef, type InstallRequest } from "./shared";

type AutoUpdateRuntimeParams = {
  installExtensionAndWait: (request: InstallRequest) => Promise<void>;
  reloadExtensionRuntimeInPlace: () => Promise<void>;
};

export function useExtensionAutoUpdateRuntime({
  installExtensionAndWait,
  reloadExtensionRuntimeInPlace,
}: AutoUpdateRuntimeParams) {
  const autoUpdateInFlightRef = useRef(false);
  const { extensionsAutoUpdateEnabled } = useExtensionsAutoUpdateEnabled();
  const loadedExtensions = useLoadedExtensions();
  const latestExtensionsRef = useLatestRef(loadedExtensions);

  const runAutoUpdatePass = useCallback(async (): Promise<void> => {
    if (autoUpdateInFlightRef.current) return;
    autoUpdateInFlightRef.current = true;
    try {
      const installedForUpdate = latestExtensionsRef.current.filter(
        (ext) => !extensionRef(ext).path && extensionRef(ext).source && (extensionRef(ext).autoUpdate ?? true),
      );
      if (installedForUpdate.length === 0) return;

      const pendingInstalls: InstallRequest[] = [];
      const bySource = (source: ExtensionInstallSource) => installedForUpdate.filter((ext) => extensionRef(ext).source === source);

      const dotdirProvider = getMarketplaceProvider("dotdir");
      const dotdirExtensions = bySource("dotdir-marketplace");
      if (dotdirExtensions.length > 0 && dotdirProvider.checkUpdates) {
        const updates = await dotdirProvider.checkUpdates(
          dotdirExtensions.map((ext) => ({
            publisher: extensionRef(ext).publisher,
            name: extensionRef(ext).name,
            version: extensionRef(ext).version,
          })),
        );
        for (const update of updates) {
          if (!update.hasUpdate || !update.latestVersion) continue;
          pendingInstalls.push({
            source: "dotdir-marketplace",
            publisher: update.publisher,
            name: update.name,
            version: update.latestVersion,
          });
        }
      }

      const openVsxProvider = getMarketplaceProvider("open-vsx");
      for (const ext of bySource("open-vsx-marketplace")) {
        try {
          const ref = extensionRef(ext);
          const details = await openVsxProvider.getDetails(ref.publisher, ref.name);
          if (!details.version || compareExtensionVersions(details.version, ref.version) <= 0 || !details.downloadUrl) continue;
          pendingInstalls.push({
            source: "open-vsx-marketplace",
            publisher: ref.publisher,
            name: ref.name,
            downloadUrl: details.downloadUrl,
          });
        } catch (error) {
          const ref = extensionRef(ext);
          console.warn("[ExtHost] Failed to check Open VSX update for", `${ref.publisher}.${ref.name}`, error);
        }
      }

      if (pendingInstalls.length === 0) return;
      for (const request of pendingInstalls) {
        await installExtensionAndWait(request);
      }
      await reloadExtensionRuntimeInPlace();
    } finally {
      autoUpdateInFlightRef.current = false;
    }
  }, [installExtensionAndWait, latestExtensionsRef, reloadExtensionRuntimeInPlace]);

  useEffect(() => {
    if (!extensionsAutoUpdateEnabled) return;
    if (loadedExtensions.length === 0) return;
    if (!loadedExtensions.some((ext) => extensionRef(ext).autoUpdate ?? true)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      timer = setTimeout(() => {
        if (cancelled) return;
        void runAutoUpdatePass()
          .catch((error) => {
            console.warn("[ExtHost] Automatic extension update failed:", error);
          })
          .finally(() => {
            if (!cancelled) schedule(AUTO_UPDATE_INTERVAL_MS);
          });
      }, delay);
    };

    schedule(AUTO_UPDATE_INITIAL_DELAY_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [extensionsAutoUpdateEnabled, loadedExtensions, runAutoUpdatePass]);
}
