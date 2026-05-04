import { describe, expect, it } from "vitest";
import { ActionQueue } from "../src";

describe("ActionQueue", () => {
  it("executes actions sequentially", async () => {
    const queue = new ActionQueue();
    const results: number[] = [];

    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 5));
      results.push(1);
    });

    queue.enqueue(() => {
      results.push(2);
    });

    queue.enqueue(async () => {
      results.push(3);
    });

    // Wait for the queued actions to complete
    await new Promise((r) => setTimeout(r, 20));

    expect(results).toEqual([1, 2, 3]);
  });

  it("executes sync actions", async () => {
    const queue = new ActionQueue();
    const results: number[] = [];

    queue.enqueue(() => {
      results.push(1);
    });

    queue.enqueue(() => {
      results.push(2);
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(results).toEqual([1, 2]);
  });

  it("does not block the queue when an action throws", async () => {
    const queue = new ActionQueue();
    const results: number[] = [];

    queue.enqueue(() => {
      throw new Error("first action fails");
    });

    queue.enqueue(() => {
      results.push(2);
    });

    queue.enqueue(() => {
      results.push(3);
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(results).toEqual([2, 3]);
  });

  it("does not block the queue when an async action rejects", async () => {
    const queue = new ActionQueue();
    const results: number[] = [];

    queue.enqueue(async () => {
      throw new Error("async failure");
    });

    queue.enqueue(() => {
      results.push(2);
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(results).toEqual([2]);
  });

  it("waits for async actions before executing the next", async () => {
    const queue = new ActionQueue();
    const results: number[] = [];
    let firstCompleted = false;

    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 10));
      firstCompleted = true;
      results.push(1);
    });

    queue.enqueue(() => {
      expect(firstCompleted).toBe(true);
      results.push(2);
    });

    await new Promise((r) => setTimeout(r, 30));

    expect(results).toEqual([1, 2]);
  });
});
