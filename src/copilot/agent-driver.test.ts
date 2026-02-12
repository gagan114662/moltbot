import { describe, expect, it, vi, beforeEach } from "vitest";
import { ClaudeCodeDriver, createAgentDriver } from "./agent-driver.js";

// ---------------------------------------------------------------------------
// Mock child_process and fs
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => {
  const EventEmitter = require("node:events");

  function createMockProcess() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    return proc;
  }

  return {
    spawn: vi.fn(() => {
      const proc = createMockProcess();
      // Auto-resolve after a tick
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("Changes applied successfully."));
        proc.emit("close", 0);
      }, 10);
      return proc;
    }),
  };
});

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue("mock content"),
    unlinkSync: vi.fn(),
  },
}));

// Mock tmux-send to prevent import failures
vi.mock("./tmux-send.js", () => ({
  detectClaudeState: vi.fn(),
  pollForClaudeState: vi.fn(),
  tmuxCaptureScrollback: vi.fn(),
  tmuxSendKeys: vi.fn(),
}));

import { spawn } from "node:child_process";

const mockSpawn = vi.mocked(spawn);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// ClaudeCodeDriver
// ---------------------------------------------------------------------------

describe("ClaudeCodeDriver", () => {
  it("has name 'claude-code'", () => {
    const driver = new ClaudeCodeDriver({ targetCwd: "/tmp/project" });
    expect(driver.name).toBe("claude-code");
  });

  it("spawns claude with --print and --dangerously-skip-permissions", async () => {
    const driver = new ClaudeCodeDriver({ targetCwd: "/tmp/project" });
    await driver.sendFeedback("Fix the WebSocket issue");

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toContain("--print");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(opts?.cwd).toBe("/tmp/project");
  });

  it("passes model flag", async () => {
    const driver = new ClaudeCodeDriver({
      targetCwd: "/tmp/project",
      model: "opus",
    });
    await driver.sendFeedback("Fix the issue");

    const args = mockSpawn.mock.calls[0][1] as string[];
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("opus");
  });

  it("passes nudge as the last argument", async () => {
    const driver = new ClaudeCodeDriver({ targetCwd: "/tmp/project" });
    await driver.sendFeedback("Fix the WebSocket issue");

    const args = mockSpawn.mock.calls[0][1] as string[];
    const lastArg = args[args.length - 1];
    expect(lastArg).toContain("Fix the WebSocket issue");
  });

  it("appends feedback file reference when provided", async () => {
    const driver = new ClaudeCodeDriver({ targetCwd: "/tmp/project" });
    await driver.sendFeedback("Fix issues", "/tmp/project/QA-FEEDBACK.md");

    const args = mockSpawn.mock.calls[0][1] as string[];
    const lastArg = args[args.length - 1];
    expect(lastArg).toContain("QA-FEEDBACK.md");
    expect(lastArg).toContain("read it for full context");
  });

  it("sets appendSystemPrompt when briefing is provided", async () => {
    const driver = new ClaudeCodeDriver({ targetCwd: "/tmp/project" });
    driver.setSystemPromptContext("# Iteration Context\nIteration 3/5");
    await driver.sendFeedback("Fix the issue");

    const args = mockSpawn.mock.calls[0][1] as string[];
    const sysIdx = args.indexOf("--append-system-prompt");
    expect(sysIdx).toBeGreaterThan(-1);
    expect(args[sysIdx + 1]).toContain("Iteration Context");
  });

  it("does not include --append-system-prompt when no briefing set", async () => {
    const driver = new ClaudeCodeDriver({ targetCwd: "/tmp/project" });
    await driver.sendFeedback("Fix the issue");

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain("--append-system-prompt");
  });

  it("captures output from stdout", async () => {
    const driver = new ClaudeCodeDriver({ targetCwd: "/tmp/project" });
    await driver.sendFeedback("Fix the issue");

    const output = driver.captureOutput();
    expect(output).toBe("Changes applied successfully.");
  });

  it("waitForCompletion returns idle (no-op)", async () => {
    const driver = new ClaudeCodeDriver({ targetCwd: "/tmp/project" });
    const result = await driver.waitForCompletion(60_000);
    expect(result.timedOut).toBe(false);
    expect(result.state).toBe("idle");
  });

  it("resolves even on non-zero exit code", async () => {
    const EventEmitter = require("node:events");
    mockSpawn.mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      setTimeout(() => {
        proc.stderr.emit("data", Buffer.from("Budget exceeded"));
        proc.emit("close", 1);
      }, 10);
      return proc;
    });

    const driver = new ClaudeCodeDriver({ targetCwd: "/tmp/project" });
    // Should not throw — non-zero exit resolves (the loop observes changes)
    await expect(driver.sendFeedback("Fix")).resolves.toBeUndefined();
  });

  it("rejects when spawn fails", async () => {
    const EventEmitter = require("node:events");
    mockSpawn.mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      setTimeout(() => {
        proc.emit("error", new Error("ENOENT: claude not found"));
      }, 10);
      return proc;
    });

    const driver = new ClaudeCodeDriver({ targetCwd: "/tmp/project" });
    await expect(driver.sendFeedback("Fix")).rejects.toThrow("Failed to spawn claude");
  });
});

// ---------------------------------------------------------------------------
// createAgentDriver factory
// ---------------------------------------------------------------------------

describe("createAgentDriver", () => {
  it("creates ClaudeCodeDriver when claudeCodeTargetCwd is provided", () => {
    const driver = createAgentDriver({
      claudeCodeTargetCwd: "/tmp/project",
      claudeCodeModel: "opus",
    });
    expect(driver.name).toBe("claude-code");
  });

  it("creates CodexDriver when codexTargetCwd is provided", () => {
    const driver = createAgentDriver({ codexTargetCwd: "/tmp/project" });
    expect(driver.name).toBe("codex");
  });

  it("creates TmuxClaudeDriver when only tmuxTarget is provided", () => {
    const driver = createAgentDriver({ tmuxTarget: "scratchpad:0.0" });
    expect(driver.name).toBe("claude-tmux");
  });

  it("prefers ClaudeCodeDriver over CodexDriver when both are provided", () => {
    const driver = createAgentDriver({
      claudeCodeTargetCwd: "/tmp/project",
      codexTargetCwd: "/tmp/project",
    });
    expect(driver.name).toBe("claude-code");
  });

  it("defaults to TmuxClaudeDriver with default target", () => {
    const driver = createAgentDriver({});
    expect(driver.name).toBe("claude-tmux");
  });
});
