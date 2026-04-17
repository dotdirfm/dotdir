import { readAppDirs } from "@/features/bridge/appDirs";
import { useBridge } from "@/features/bridge/useBridge";
import { ExtensionSettingsStore, type ExtensionSettingsMap } from "@/features/extensions/extensionSettings";
import { useExtensionHostClient } from "@/features/extensions/extensionHostClient";
import { useCallback, useEffect, useRef, useState } from "react";

function mergePatch(base: ExtensionSettingsMap, patch: Record<string, unknown>): ExtensionSettingsMap {
  const next: ExtensionSettingsMap = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

export function useExtensionSettings(): {
  ready: boolean;
  values: ExtensionSettingsMap;
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  reset: (key: string) => void;
} {
  const bridge = useBridge();
  const client = useExtensionHostClient();
  const [store, setStore] = useState<ExtensionSettingsStore | null>(null);
  const [values, setValues] = useState<ExtensionSettingsMap>({});
  const [ready, setReady] = useState(false);
  const pendingPatchRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { dataDir } = await readAppDirs(bridge);
      if (cancelled) return;
      setStore(new ExtensionSettingsStore(bridge, dataDir));
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    void (async () => {
      const snapshot = await store.load();
      if (cancelled) return;
      setValues({ ...snapshot });
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const flush = useCallback(() => {
    const patch = pendingPatchRef.current;
    pendingPatchRef.current = {};
    timerRef.current = null;
    void (async () => {
      if (!store) return;
      const entries = Object.entries(patch);
      for (const [key, value] of entries) {
        const dot = key.lastIndexOf(".");
        const section = dot > 0 ? key.slice(0, dot) : undefined;
        const shortKey = dot > 0 ? key.slice(dot + 1) : key;
        await store.write({ target: "global", section, key: shortKey, value });
      }
    })();
  }, [store]);

  const set = useCallback(
    (key: string, value: unknown) => {
      setValues((prev) => mergePatch(prev, { [key]: value }));
      pendingPatchRef.current[key] = value;
      client.configurationUpdate(key, value);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, 450);
    },
    [client, flush],
  );

  const reset = useCallback(
    (key: string) => {
      setValues((prev) => mergePatch(prev, { [key]: undefined }));
      pendingPatchRef.current[key] = undefined;
      client.configurationUpdate(key, undefined);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, 450);
    },
    [client, flush],
  );

  const get = useCallback(
    (key: string) => {
      return values[key];
    },
    [values],
  );

  return { ready, values, get, set, reset };
}

