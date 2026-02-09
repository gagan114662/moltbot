import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Must import AFTER the mock so the module gets the mocked execFileSync
const { tmuxSendKeys, DEFAULT_TMUX_TARGET } = await import("./tmux-send.js");

describe("tmuxSendKeys", () => {
  it("calls execFileSync with correct args and returns true on success", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));

    const result = tmuxSendKeys("moltbot:0.0", "hello world");

    expect(result).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      "tmux",
      ["send-keys", "-t", "moltbot:0.0", "hello world", "Enter"],
      { timeout: 5000, stdio: "ignore" },
    );
  });

  it("returns false when execFileSync throws (tmux not found or pane gone)", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("tmux: session not found: bad");
    });

    const result = tmuxSendKeys("bad:0.0", "test");

    expect(result).toBe(false);
  });

  it("exports a sensible default target", () => {
    expect(DEFAULT_TMUX_TARGET).toBe("moltbot:0.0");
  });
});
