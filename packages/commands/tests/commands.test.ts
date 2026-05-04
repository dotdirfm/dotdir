import { describe, expect, it } from "vitest";
import { CommandRegistry, formatKeybinding } from "../src";

function createRegistry(): CommandRegistry {
  return new CommandRegistry();
}

describe("CommandRegistry", () => {
  describe("command registration", () => {
    it("registers and retrieves a command via contributions", () => {
      const registry = createRegistry();
      registry.registerContributions([
        {
          command: "test.command",
          title: "Test Command",
          category: "Test",
        },
      ]);

      const cmd = registry.getCommand("test.command");
      expect(cmd).toBeDefined();
      expect(cmd!.id).toBe("test.command");
      expect(cmd!.title).toBe("Test Command");
      expect(cmd!.category).toBe("Test");
    });

    it("registers multiple commands and returns all", () => {
      const registry = createRegistry();
      registry.registerContributions([
        { command: "cmd.a", title: "A" },
        { command: "cmd.b", title: "B" },
      ]);

      const all = registry.getAllCommands();
      expect(all).toHaveLength(2);
    });
  });

  describe("executeCommand", () => {
    it("executes a registered command handler", async () => {
      const registry = createRegistry();
      let executed = false;

      registry.registerCommand("test.run", () => {
        executed = true;
      });

      await registry.executeCommand("test.run");
      expect(executed).toBe(true);
    });

    it("passes arguments to the handler", async () => {
      const registry = createRegistry();
      let receivedArgs: unknown[] = [];

      registry.registerCommand("test.args", (...args) => {
        receivedArgs = args;
      });

      await registry.executeCommand("test.args", "a", 42, { key: "val" });
      expect(receivedArgs).toEqual(["a", 42, { key: "val" }]);
    });

    it("executes async handlers", async () => {
      const registry = createRegistry();
      let executed = false;

      registry.registerCommand("test.async", async () => {
        await new Promise((r) => setTimeout(r, 1));
        executed = true;
      });

      await registry.executeCommand("test.async");
      expect(executed).toBe(true);
    });

    it("does not throw when command is not found", async () => {
      const registry = createRegistry();
      await expect(
        registry.executeCommand("nonexistent.command"),
      ).resolves.toBeUndefined();
    });

    it("prefers active-scoped handlers over inactive ones", async () => {
      const registry = createRegistry();
      const results: string[] = [];

      registry.registerCommand("test.scope", () => results.push("default"));

      registry.registerCommand(
        "test.scope",
        () => results.push("active"),
        { isActive: () => true },
      );

      registry.registerCommand(
        "test.scope",
        () => results.push("inactive"),
        { isActive: () => false },
      );

      await registry.executeCommand("test.scope");
      expect(results).toEqual(["active"]);
    });

    it("falls back to the last registered handler when no active scope matches", async () => {
      const registry = createRegistry();
      const results: string[] = [];

      registry.registerCommand(
        "test.fallback",
        () => results.push("inactive"),
        { isActive: () => false },
      );

      registry.registerCommand("test.fallback", () =>
        results.push("fallback"),
      );

      await registry.executeCommand("test.fallback");
      expect(results).toEqual(["fallback"]);
    });
  });

  describe("keybindings", () => {
    it("returns empty keybindings by default", () => {
      const registry = createRegistry();
      expect(registry.getKeybindings()).toEqual([]);
    });

    it("adds and retrieves keybindings for a layer", () => {
      const registry = createRegistry();
      registry.registerKeybinding(
        { command: "test.cmd", key: "ctrl+a" },
        "default",
      );
      const bindings = registry.getKeybindings();
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.key).toBe("ctrl+a");
    });

    it("filters out keybindings with empty command", () => {
      const registry = createRegistry();
      registry.registerKeybinding(
        { command: "", key: "ctrl+a" },
        "default",
      );
      expect(registry.getKeybindings()).toHaveLength(0);
    });

    it("resolves keybindings for a specific layer", () => {
      const registry = createRegistry();
      registry.registerKeybinding(
        { command: "cmd.a", key: "ctrl+x" },
        "default",
      );
      registry.registerKeybinding(
        { command: "cmd.b", key: "ctrl+y" },
        "user",
      );

      const defaultBindings = registry.getKeybindingsForLayer("default");
      expect(defaultBindings).toHaveLength(1);
      expect(defaultBindings[0]!.command).toBe("cmd.a");
    });
  });

  describe("context", () => {
    it("updates and retrieves context values", () => {
      const registry = createRegistry();
      registry.setContext("panelActive", true);
      expect(registry.getContext("panelActive")).toBe(true);

      registry.setContext("readonly", false);
      expect(registry.getContext("readonly")).toBe(false);
    });
  });
});

describe("formatKeybinding", () => {
  it("formats a simple key", () => {
    const result = formatKeybinding({ command: "test", key: "a" });
    expect(result.toUpperCase()).toBe("A");
  });

  it("formats a keybinding with modifiers", () => {
    const result = formatKeybinding({ command: "test", key: "ctrl+shift+p" });
    expect(result).toContain("P");
  });

  it("formats special keys", () => {
    expect(formatKeybinding({ command: "test", key: "enter" })).toContain("↵");
    expect(formatKeybinding({ command: "test", key: "escape" })).toContain("Esc");
    expect(formatKeybinding({ command: "test", key: "tab" })).toContain("Tab");
    expect(formatKeybinding({ command: "test", key: "up" })).toContain("↑");
    expect(formatKeybinding({ command: "test", key: "down" })).toContain("↓");
    expect(formatKeybinding({ command: "test", key: "left" })).toContain("←");
    expect(formatKeybinding({ command: "test", key: "right" })).toContain("→");
    expect(formatKeybinding({ command: "test", key: "space" })).toContain("Space");
    expect(formatKeybinding({ command: "test", key: "backspace" })).toContain("⌫");
    expect(formatKeybinding({ command: "test", key: "delete" })).toContain("Del");
  });

  it("formats f-keys", () => {
    const result = formatKeybinding({ command: "test", key: "f5" });
    expect(result).toBe("F5");
  });

  it("does not throw when called in node environment", () => {
    // formatKeybinding uses isMac() which falls back gracefully
    expect(() => formatKeybinding({ command: "test", key: "a" })).not.toThrow();
  });
});
