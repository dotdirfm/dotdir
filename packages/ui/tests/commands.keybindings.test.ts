import { describe, expect, it } from "vitest";

import { CommandRegistry } from "../lib/features/commands/commands";
import { runCommandSequence } from "../lib/features/commands/runCommands";

function createKeyboardEvent({
  key,
  code,
  ctrlKey = false,
  altKey = false,
  shiftKey = false,
  metaKey = false,
}: {
  key: string;
  code: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}) {
  return {
    key,
    code,
    ctrlKey,
    altKey,
    shiftKey,
    metaKey,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  } as KeyboardEvent & {
    defaultPrevented: boolean;
    propagationStopped: boolean;
  };
}

describe("CommandRegistry keybinding resolution", () => {
  it("removes a specific lower-layer keybinding with a user removal rule", () => {
    const registry = new CommandRegistry();

    registry.registerKeybinding({ key: "tab", command: "tab" }, "default");
    registry.registerKeybinding({ key: "tab", command: "jumpToNextSnippetPlaceholder" }, "extension");
    registry.setLayerKeybindings("user", [{ key: "tab", command: "-jumpToNextSnippetPlaceholder" }]);

    const commands = registry.getKeybindings().map((binding) => binding.command);

    expect(commands).toEqual(["tab"]);
  });

  it("disables a shortcut with an empty command and still consumes the event", () => {
    const registry = new CommandRegistry();
    let executed = false;

    registry.registerCommand("togglePanels", () => {
      executed = true;
    });
    registry.registerKeybinding({ key: "tab", command: "togglePanels" }, "default");
    registry.setLayerKeybindings("user", [{ key: "tab", command: "" }]);

    const handled = registry.handleKeyboardEvent(createKeyboardEvent({ key: "Tab", code: "Tab" }));

    expect(handled).toBe(true);
    expect(executed).toBe(false);
    expect(registry.getKeybindings()).toEqual([]);
  });

  it("applies removal rules to command matching as well as displayed bindings", () => {
    const registry = new CommandRegistry();

    registry.registerKeybinding({ key: "tab", command: "tab" }, "default");
    registry.registerKeybinding({ key: "tab", command: "jumpToNextSnippetPlaceholder" }, "extension");
    registry.setLayerKeybindings("user", [{ key: "tab", command: "-jumpToNextSnippetPlaceholder" }]);

    const matchesTab = registry.matchesEventForCommands(createKeyboardEvent({ key: "Tab", code: "Tab" }), ["tab"]);
    const matchesRemoved = registry.matchesEventForCommands(
      createKeyboardEvent({ key: "Tab", code: "Tab" }),
      ["jumpToNextSnippetPlaceholder"],
    );

    expect(matchesTab).toBe(true);
    expect(matchesRemoved).toBe(false);
  });

  it("only disables matching lower-layer bindings for when-scoped empty commands", () => {
    const registry = new CommandRegistry();

    registry.registerKeybinding({ key: "tab", command: "acceptSelectedSuggestion", when: "focusCommandPalette" }, "default");
    registry.registerKeybinding({ key: "tab", command: "tab" }, "default");
    registry.setLayerKeybindings("user", [{ key: "tab", command: "", when: "focusCommandPalette" }]);

    const commands = registry.getKeybindings().map((binding) => `${binding.command}|${binding.when ?? ""}`);

    expect(commands).toEqual(["tab|"]);
  });

  it("passes keybinding args as the first command argument", () => {
    const registry = new CommandRegistry();
    let received;

    registry.registerCommand("withArgs", (args) => {
      received = args;
    });
    registry.setLayerKeybindings("user", [{ key: "tab", command: "withArgs", args: { value: 42 } }]);

    const handled = registry.handleKeyboardEvent(createKeyboardEvent({ key: "Tab", code: "Tab" }));

    expect(handled).toBe(true);
    expect(received).toEqual({ value: 42 });
  });
});

describe("runCommandSequence", () => {
  it("runs string commands and object commands sequentially", async () => {
    const registry = new CommandRegistry();
    const events: unknown[] = [];

    registry.registerCommand("first", () => {
      events.push("first");
    });
    registry.registerCommand("second", (arg) => {
      events.push(["second", arg]);
    });
    registry.registerCommand("third", (...args) => {
      events.push(["third", args]);
    });

    await runCommandSequence(registry, [
      "first",
      { command: "second", args: { answer: 42 } },
      { command: "third", args: ["a", "b"] },
    ]);

    expect(events).toEqual(["first", ["second", { answer: 42 }], ["third", ["a", "b"]]]);
  });
});
