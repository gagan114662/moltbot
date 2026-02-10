import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Must import AFTER the mock so the module gets the mocked execFileSync
const { tmuxSendKeys, tmuxCapture, pollForTmuxIdle, DEFAULT_TMUX_TARGET, DEFAULT_IDLE_PROMPT_RE } =
  await import("./tmux-send.js");

describe("tmuxSendKeys", () => {
  it("sends text literally then Enter separately, returns true on success", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));

    const result = tmuxSendKeys("moltbot:0.0", "hello world");

    expect(result).toBe(true);
    // First call: literal text (-l flag)
    expect(execFileSync).toHaveBeenCalledWith(
      "tmux",
      ["send-keys", "-t", "moltbot:0.0", "-l", "hello world"],
      { timeout: 5000, stdio: "ignore" },
    );
    // Second call: Enter keypress
    expect(execFileSync).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "moltbot:0.0", "Enter"], {
      timeout: 5000,
      stdio: "ignore",
    });
  });

  it("returns false when execFileSync throws (tmux not found or pane gone)", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("tmux: session not found: bad");
    });

    const result = tmuxSendKeys("bad:0.0", "test");

    expect(result).toBe(false);
  });

  it("exports a sensible default target", () => {
    expect(DEFAULT_TMUX_TARGET).toBe("scratchpad:0.0");
  });
});

describe("tmuxCapture", () => {
  it("returns pane content on success", () => {
    vi.mocked(execFileSync).mockReturnValue("line1\nline2\n❯ \n");

    expect(tmuxCapture("s:0.0")).toBe("line1\nline2\n❯ \n");
    expect(execFileSync).toHaveBeenCalledWith("tmux", ["capture-pane", "-t", "s:0.0", "-p"], {
      encoding: "utf-8",
      timeout: 5000,
    });
  });

  it("returns null on error", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("no session");
    });

    expect(tmuxCapture("bad:0.0")).toBeNull();
  });
});

describe("DEFAULT_IDLE_PROMPT_RE", () => {
  it("matches Claude Code prompt ❯", () => {
    expect(DEFAULT_IDLE_PROMPT_RE.test("❯ ")).toBe(true);
    expect(DEFAULT_IDLE_PROMPT_RE.test("  ❯")).toBe(true);
  });

  it("matches shell prompts $ and >", () => {
    expect(DEFAULT_IDLE_PROMPT_RE.test("user@host$ ")).toBe(true);
    expect(DEFAULT_IDLE_PROMPT_RE.test("> ")).toBe(true);
    expect(DEFAULT_IDLE_PROMPT_RE.test("›")).toBe(true);
  });

  it("matches Claude Code prompt with invisible TUI padding", () => {
    // Claude Code pads lines with box-drawing chars after the prompt
    expect(DEFAULT_IDLE_PROMPT_RE.test("❯ \u2500\u2500\u2500\u2500")).toBe(true);
    expect(DEFAULT_IDLE_PROMPT_RE.test("\u2500❯ \u2500")).toBe(true);
  });

  it("does not match mid-line content", () => {
    expect(DEFAULT_IDLE_PROMPT_RE.test("Computing… (3m 12s)")).toBe(false);
    expect(DEFAULT_IDLE_PROMPT_RE.test("Worked for 5m 0s")).toBe(false);
  });
});

describe("pollForTmuxIdle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when idle prompt is detected after grace period", async () => {
    let callCount = 0;
    vi.mocked(execFileSync).mockImplementation((_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "capture-pane") {
        callCount++;
        // First call: still working. Second call: idle.
        return callCount <= 1 ? "Computing… (1m 2s)\n" : "Done.\n❯ \n";
      }
      return Buffer.from("");
    });

    const promise = pollForTmuxIdle("s:0.0", {
      graceMs: 100,
      intervalMs: 100,
      timeoutMs: 5000,
    });

    // Advance past grace period
    await vi.advanceTimersByTimeAsync(100);
    // First poll — still working
    await vi.advanceTimersByTimeAsync(100);
    // Second poll — idle
    await vi.advanceTimersByTimeAsync(100);

    expect(await promise).toBe(true);
  });

  it("returns false on timeout", async () => {
    vi.mocked(execFileSync).mockImplementation((_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "capture-pane") {
        return "Still working...\n";
      }
      return Buffer.from("");
    });

    const promise = pollForTmuxIdle("s:0.0", {
      graceMs: 50,
      intervalMs: 50,
      timeoutMs: 200,
    });

    // Advance past grace + timeout
    await vi.advanceTimersByTimeAsync(300);

    expect(await promise).toBe(false);
  });
});
