import { describe, it, expect } from "vitest";
import type { WorkerEvent } from "../../copilot/worker-types.js";
import { formatEventForChat } from "./commands-work.js";

describe("formatEventForChat", () => {
  it("formats iteration-start", () => {
    const event: WorkerEvent = { type: "iteration-start", iteration: 2, maxIterations: 5 };
    expect(formatEventForChat(event)).toBe("Iteration 2/5: Starting...");
  });

  it("formats agent-done with duration", () => {
    const event: WorkerEvent = { type: "agent-done", iteration: 1, durationMs: 18300 };
    expect(formatEventForChat(event)).toBe("Iteration 1: Agent done (18.3s)");
  });

  it("formats stage-done PASS", () => {
    const event: WorkerEvent = {
      type: "stage-done",
      result: { stage: "lint", passed: true, durationMs: 1200 },
    };
    expect(formatEventForChat(event)).toBe("  lint: PASS (1.2s)");
  });

  it("formats stage-done FAIL with error snippet", () => {
    const event: WorkerEvent = {
      type: "stage-done",
      result: {
        stage: "typecheck",
        passed: false,
        durationMs: 5100,
        error:
          "src/foo.ts(10,5): error TS2322: Type 'string' not assignable to 'number'\nmore lines",
      },
    };
    const msg = formatEventForChat(event);
    expect(msg).toContain("typecheck: FAIL");
    expect(msg).toContain("5.1s");
    expect(msg).toContain("TS2322");
    expect(msg).not.toContain("more lines");
  });

  it("formats verify-done allPassed", () => {
    const event: WorkerEvent = {
      type: "verify-done",
      iteration: 3,
      allPassed: true,
      checks: [],
    };
    expect(formatEventForChat(event)).toBe("Iteration 3: All checks passed!");
  });

  it("formats verify-done failed", () => {
    const event: WorkerEvent = {
      type: "verify-done",
      iteration: 2,
      allPassed: false,
      checks: [],
    };
    expect(formatEventForChat(event)).toBe("Iteration 2: Checks failed, retrying...");
  });

  it("formats stall-warning near limit", () => {
    const event: WorkerEvent = { type: "stall-warning", consecutiveStalls: 2, stallLimit: 3 };
    expect(formatEventForChat(event)).toBe("Stall detected (2/3)");
  });

  it("suppresses stall-warning below threshold", () => {
    const event: WorkerEvent = { type: "stall-warning", consecutiveStalls: 1, stallLimit: 3 };
    expect(formatEventForChat(event)).toBeNull();
  });

  it("formats error", () => {
    const event: WorkerEvent = { type: "error", error: "Agent crashed" };
    expect(formatEventForChat(event)).toBe("Error: Agent crashed");
  });

  it("returns null for silent events", () => {
    expect(formatEventForChat({ type: "git-stash", stashed: true })).toBeNull();
    expect(formatEventForChat({ type: "agent-start", iteration: 1 })).toBeNull();
    expect(formatEventForChat({ type: "verify-start", iteration: 1, changedFiles: [] })).toBeNull();
    expect(formatEventForChat({ type: "stage-start", stage: "lint" })).toBeNull();
    expect(formatEventForChat({ type: "video-start" })).toBeNull();
  });

  it("formats sub-second durations in ms", () => {
    const event: WorkerEvent = { type: "agent-done", iteration: 1, durationMs: 500 };
    expect(formatEventForChat(event)).toContain("500ms");
  });
});
