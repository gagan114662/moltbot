import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkerResult } from "./worker-types.js";

vi.mock("./tool-detect.js", () => ({
  detectTool: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

describe("showboat", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("buildShowboatProof", () => {
    it("skips gracefully when showboat is not installed", async () => {
      const { detectTool } = await import("./tool-detect.js");
      vi.mocked(detectTool).mockReturnValue({ available: false });

      const { buildShowboatProof } = await import("./showboat.js");
      const result = await buildShowboatProof({
        cwd: "/tmp/test",
        task: "Fix the login page",
        workerResult: makeWorkerResult(),
        baselineRef: "abc123",
        changedFiles: ["src/login.ts"],
      });

      expect(result.stage).toBe("showboat-proof");
      expect(result.passed).toBe(true);
      expect(result.error).toContain("not installed");
      expect(result.proofPath).toBeUndefined();
    });
  });

  describe("buildTimingSummary", () => {
    it("formats a passing result correctly", async () => {
      const { buildTimingSummary } = await import("./showboat.js");

      const result = makeWorkerResult();
      const summary = buildTimingSummary(result);

      expect(summary).toContain("PASS");
      expect(summary).toContain("Iterations:** 1");
      expect(summary).toContain("lint");
      expect(summary).toContain("test");
    });

    it("handles empty iterations", async () => {
      const { buildTimingSummary } = await import("./showboat.js");

      const result: WorkerResult = {
        ok: false,
        iterations: [],
        totalDurationMs: 0,
        changedFiles: [],
        stoppedEarly: true,
        stopReason: "error",
      };
      const summary = buildTimingSummary(result);
      expect(summary).toContain("FAIL");
      expect(summary).toContain("Iterations:** 0");
    });
  });
});

function makeWorkerResult(): WorkerResult {
  return {
    ok: true,
    iterations: [
      {
        iteration: 1,
        agentDurationMs: 5000,
        verifyDurationMs: 12000,
        checks: [
          { stage: "lint", passed: true, durationMs: 800 },
          { stage: "typecheck", passed: true, durationMs: 3200 },
          { stage: "test", passed: true, durationMs: 8000, files: ["src/login.test.ts"] },
        ],
        allPassed: true,
        changedFiles: ["src/login.ts"],
      },
    ],
    totalDurationMs: 17000,
    changedFiles: ["src/login.ts"],
    stoppedEarly: false,
    stopReason: "success",
  };
}
