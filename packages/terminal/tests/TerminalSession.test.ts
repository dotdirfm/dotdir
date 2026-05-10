import { describe, expect, it } from "vitest";
import { TerminalSession } from "../src";

describe("TerminalSession", () => {
  it("has correct initial status", () => {
    const bridge = {} as any;
    const session = new TerminalSession(
      bridge,
      "/home/user",
      { id: "test", shell: "/bin/bash", label: "Test", cwdEscape: "posix", hiddenCdTemplate: " cd {{cwd}}", lineEnding: "\n" },
      () => false,
    );
    const caps = session.getCapabilities();
    expect(caps.cwd).toBe("/home/user");
    expect(caps.profileId).toBe("test");
  });
});
