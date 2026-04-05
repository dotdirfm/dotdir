export type Action = () => Promise<void> | void;

export class ActionQueue {
  private tail = Promise.resolve();

  enqueue(action: Action): void {
    this.tail = this.tail.then(async () => {
      try {
        const result = action();
        if (result && typeof (result as Promise<void>).then === "function") {
          await result;
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      } catch {
        // Action errors must not block the queue
      }
    });
  }
}
