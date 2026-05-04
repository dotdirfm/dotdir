import { describe, expect, it } from "vitest";
import { FocusContextManager } from "../src";

function createManager(): FocusContextManager {
  return new FocusContextManager();
}

describe("FocusContextManager", () => {
  describe("initial state", () => {
    it("defaults to panel layer", () => {
      const mgr = createManager();
      expect(mgr.current).toBe("panel");
      expect(mgr.is("panel")).toBe(true);
    });

    it("has one entry in the stack", () => {
      const mgr = createManager();
      expect(mgr.state.stack).toHaveLength(1);
      expect(mgr.state.stack[0]!.layer).toBe("panel");
    });
  });

  describe("push", () => {
    it("pushes a new layer and remembers restore target", () => {
      const mgr = createManager();
      mgr.push("commandPalette");

      expect(mgr.current).toBe("commandPalette");
      expect(mgr.state.stack).toHaveLength(2);
      expect(mgr.state.stack[1]!.restoreTo).toBe("panel");
    });

    it("pushes multiple layers and tracks restore chain", () => {
      const mgr = createManager();
      mgr.push("modal");
      mgr.push("commandPalette");

      expect(mgr.current).toBe("commandPalette");
      expect(mgr.state.stack).toHaveLength(3);
      expect(mgr.state.stack[0]!.layer).toBe("panel");
      expect(mgr.state.stack[1]!.layer).toBe("modal");
      expect(mgr.state.stack[1]!.restoreTo).toBe("panel");
      expect(mgr.state.stack[2]!.layer).toBe("commandPalette");
      expect(mgr.state.stack[2]!.restoreTo).toBe("modal");
    });
  });

  describe("pop", () => {
    it("removes the specified layer from the stack", () => {
      const mgr = createManager();
      mgr.push("commandPalette");
      mgr.pop("commandPalette");

      expect(mgr.current).toBe("panel");
      expect(mgr.state.stack).toHaveLength(1);
    });

    it("maintains minimum stack of one panel entry", () => {
      const mgr = createManager();
      mgr.push("commandPalette");
      mgr.pop("commandPalette");
      mgr.pop("panel");

      expect(mgr.current).toBe("panel");
      expect(mgr.state.stack).toHaveLength(1);
    });

    it("does nothing when popping a layer not in the stack", () => {
      const mgr = createManager();
      mgr.pop("modal");

      expect(mgr.current).toBe("panel");
      expect(mgr.state.stack).toHaveLength(1);
    });
  });

  describe("set", () => {
    it("replaces the entire stack with a single layer", () => {
      const mgr = createManager();
      mgr.push("commandPalette");
      mgr.set("editor");

      expect(mgr.current).toBe("editor");
      expect(mgr.state.stack).toHaveLength(1);
      expect(mgr.state.stack[0]!.layer).toBe("editor");
    });

    it("does nothing when setting the same layer", () => {
      const mgr = createManager();
      mgr.set("panel");

      expect(mgr.state.stack).toHaveLength(1);
      expect(mgr.current).toBe("panel");
    });
  });

  describe("is", () => {
    it("returns true for the current layer", () => {
      const mgr = createManager();
      expect(mgr.is("panel")).toBe(true);
      expect(mgr.is("modal")).toBe(false);
    });

    it("reflects state after push/pop", () => {
      const mgr = createManager();
      mgr.push("modal");
      expect(mgr.is("modal")).toBe(true);
      expect(mgr.is("panel")).toBe(false);

      mgr.pop("modal");
      expect(mgr.is("panel")).toBe(true);
    });
  });

  describe("restore", () => {
    it("restores to the layer stored in the top restoreTo field", () => {
      const mgr = createManager();
      mgr.push("commandPalette");
      mgr.restore();

      expect(mgr.current).toBe("panel");
      expect(mgr.state.stack).toHaveLength(1);
    });

    it("falls back to panel when no restoreTo is set", () => {
      const mgr = createManager();
      mgr.set("editor");
      mgr.restore();

      expect(mgr.current).toBe("panel");
    });
  });

  describe("request", () => {
    it("sets the current layer", () => {
      const mgr = createManager();
      mgr.request("modal");

      expect(mgr.current).toBe("modal");
      expect(mgr.state.stack).toHaveLength(1);
    });
  });

  describe("adapter", () => {
    function fakeKeyEvent(): KeyboardEvent {
      return { key: "a", type: "keydown" } as KeyboardEvent;
    }

    it("registers and unregisters an adapter", () => {
      const mgr = createManager();
      let focused = false;

      const unregister = mgr.registerAdapter("panel", {
        focus: () => {
          focused = true;
        },
      });

      mgr.focusCurrent();
      expect(focused).toBe(true);

      unregister();
      // After unregister, focusCurrent on panel should be a no-op (adapter is gone)
    });

    it("allows command routing based on adapter config", () => {
      const mgr = createManager();
      mgr.registerAdapter("panel", { focus: () => {}, allowCommandRouting: false });
      expect(mgr.allowsCommandRouting(fakeKeyEvent(), "panel")).toBe(false);

      mgr.registerAdapter("panel", { focus: () => {}, allowCommandRouting: true });
      expect(mgr.allowsCommandRouting(fakeKeyEvent(), "panel")).toBe(true);
    });

    it("defaults to allowed command routing for panel layer", () => {
      const mgr = createManager();
      expect(mgr.allowsCommandRouting(fakeKeyEvent(), "panel")).toBe(true);
    });

    it("defaults to not allowing command routing for terminal layer", () => {
      const mgr = createManager();
      expect(mgr.allowsCommandRouting(fakeKeyEvent(), "terminal")).toBe(false);
    });
  });

  describe("change listeners", () => {
    it("notifies listeners on push", () => {
      const mgr = createManager();
      let lastLayer = "";

      mgr.onChange((layer) => {
        lastLayer = layer;
      });

      mgr.push("commandPalette");
      expect(lastLayer).toBe("commandPalette");
    });

    it("notifies state listeners on push", () => {
      const mgr = createManager();
      let lastState = mgr.state;

      mgr.onStateChange((state) => {
        lastState = state;
      });

      mgr.push("commandPalette");
      expect(lastState.current).toBe("commandPalette");
      expect(lastState.stack).toHaveLength(2);
    });

    it("returns an unsubscribe function from onChange", () => {
      const mgr = createManager();
      let callCount = 0;

      const unsub = mgr.onChange(() => callCount++);
      mgr.push("modal");
      expect(callCount).toBe(1);

      unsub();
      mgr.push("commandPalette");
      expect(callCount).toBe(1);
    });
  });

  describe("state immutability", () => {
    it("returns a copy of the stack, not a reference", () => {
      const mgr = createManager();
      const state1 = mgr.state;
      state1.stack.push({ layer: "modal" });

      expect(mgr.state.stack).toHaveLength(1);
    });
  });
});
