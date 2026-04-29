import type { Bridge } from "@dotdirfm/ui-bridge";
import type { DeleteProgressEvent } from "@dotdirfm/ui-bridge";

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

/** Recursively delete a path using the same engine as permanent delete (no UI). */
export async function deleteFilesystemPathRecursive(bridge: Bridge, absPath: string): Promise<void> {
  if (!(await bridge.fs.exists(absPath))) return;
  await new Promise<void>((resolve, reject) => {
    let activeDeleteId: number | null = null;
    let finished = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      unsub();
    };

    const resolveDone = () => {
      cleanup();
      resolve();
    };

    const rejectWith = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const unsub = bridge.fs.delete.onProgress((payload: DeleteProgressEvent) => {
      if (finished) return;
      if (activeDeleteId == null) return;
      if (payload.deleteId !== activeDeleteId) return;
      const ev = payload.event;
      if (ev.kind === "done") {
        resolveDone();
      } else if (ev.kind === "error") {
        rejectWith(new Error(ev.message));
      }
    });

    const pollUntilGone = () => {
      if (finished) return;
      void bridge.fs
        .exists(absPath)
        .then((exists) => {
          if (!exists) {
            resolveDone();
            return;
          }
          pollTimer = setTimeout(pollUntilGone, 50);
        })
        .catch(rejectWith);
    };

    void bridge.fs.delete
      .start([absPath])
      .then((deleteId) => {
        activeDeleteId = deleteId;
        pollUntilGone();
      })
      .catch(rejectWith);
  });
}
