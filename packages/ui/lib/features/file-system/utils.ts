import type { Bridge } from "@/features/bridge";

/** True if path exists and can be listed as a directory. */
export async function isExistingDirectory(bridge: Bridge, path: string): Promise<boolean> {
  if (!(await bridge.fs.exists(path))) return false;
  try {
    await bridge.fs.entries(path);
    return true;
  } catch {
    return false;
  }
}
