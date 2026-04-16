/**
 * EventEmitter, Disposable and CancellationToken implementations for the
 * vscode shim. They mirror the shapes `vscode-languageclient/browser` and
 * other extensions expect to destructure.
 */

export interface IDisposable {
  dispose(): void;
}

export class Disposable implements IDisposable {
  private _dispose: () => void;

  static from(...disposables: Array<{ dispose: () => unknown } | null | undefined>): Disposable {
    return new Disposable(() => {
      for (const d of disposables) {
        try {
          d?.dispose();
        } catch {
          // ignore
        }
      }
    });
  }

  constructor(callOnDispose: () => unknown) {
    this._dispose = () => {
      try {
        callOnDispose();
      } catch {
        // swallow errors during dispose — vscode does the same
      }
    };
  }

  dispose(): void {
    const fn = this._dispose;
    this._dispose = () => {};
    fn();
  }
}

export type Event<T> = (listener: (e: T) => unknown, thisArg?: unknown, disposables?: IDisposable[]) => IDisposable;

export class EventEmitter<T> {
  private _listeners: Array<(e: T) => unknown> = [];
  private _disposed = false;

  readonly event: Event<T> = (listener, thisArg, disposables) => {
    if (this._disposed) {
      return new Disposable(() => {});
    }
    const bound = thisArg !== undefined ? listener.bind(thisArg) : listener;
    this._listeners.push(bound);
    const sub = new Disposable(() => {
      const idx = this._listeners.indexOf(bound);
      if (idx !== -1) this._listeners.splice(idx, 1);
    });
    if (disposables) disposables.push(sub);
    return sub;
  };

  fire(event: T): void {
    if (this._disposed) return;
    const copy = this._listeners.slice();
    for (const listener of copy) {
      try {
        listener(event);
      } catch (err) {
        console.error("[EventEmitter] listener threw", err);
      }
    }
  }

  dispose(): void {
    this._disposed = true;
    this._listeners = [];
  }

  get hasListeners(): boolean {
    return this._listeners.length > 0;
  }
}

// ── Cancellation ────────────────────────────────────────────────────

export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested: Event<unknown>;
}

const shortcutEvent: Event<unknown> = (_listener) => new Disposable(() => {});

class MutableToken implements CancellationToken {
  private _isCancelled = false;
  private _emitter: EventEmitter<unknown> | null = null;

  cancel(): void {
    if (this._isCancelled) return;
    this._isCancelled = true;
    if (this._emitter) {
      this._emitter.fire(undefined);
      this._emitter.dispose();
      this._emitter = null;
    }
  }

  get isCancellationRequested(): boolean {
    return this._isCancelled;
  }

  get onCancellationRequested(): Event<unknown> {
    if (this._isCancelled) return shortcutEvent;
    if (!this._emitter) this._emitter = new EventEmitter<unknown>();
    return this._emitter.event;
  }

  dispose(): void {
    if (this._emitter) {
      this._emitter.dispose();
      this._emitter = null;
    }
  }
}

export const CancellationTokenNone: CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: shortcutEvent,
};

export class CancellationTokenSource {
  private _token?: MutableToken;

  get token(): CancellationToken {
    if (!this._token) this._token = new MutableToken();
    return this._token;
  }

  cancel(): void {
    if (!this._token) {
      this._token = new MutableToken();
    }
    this._token.cancel();
  }

  dispose(cancel = false): void {
    if (cancel) this.cancel();
    this._token?.dispose();
  }
}

export class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "Canceled";
  }
}
