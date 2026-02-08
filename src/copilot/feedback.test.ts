import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CopilotFeedback, StageResult } from "./types.js";
import {
  buildSummary,
  feedbackPath,
  isPidAlive,
  pidPath,
  readFeedback,
  readPid,
  removeFeedback,
  removePid,
  truncateError,
  writeFeedback,
  writePid,
} from "./feedback.js";

describe("feedback", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "copilot-test-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  const makeFeedback = (overrides?: Partial<CopilotFeedback>): CopilotFeedback => ({
    timestamp: new Date().toISOString(),
    ok: true,
    durationMs: 1234,
    gitRef: "abc1234",
    triggerFiles: ["src/foo.ts"],
    checks: [],
    summary: "All 0 checks passed (1s)",
    ...overrides,
  });

  describe("writeFeedback / readFeedback", () => {
    it("writes and reads feedback atomically", async () => {
      const feedback = makeFeedback();
      await writeFeedback(tmpDir, feedback);

      const read = await readFeedback(tmpDir);
      expect(read).toEqual(feedback);
    });

    it("creates .moltbot directory if it does not exist", async () => {
      await writeFeedback(tmpDir, makeFeedback());
      expect(fs.existsSync(path.join(tmpDir, ".moltbot"))).toBe(true);
    });

    it("returns null when feedback file does not exist", async () => {
      const read = await readFeedback(tmpDir);
      expect(read).toBeNull();
    });
  });

  describe("removeFeedback", () => {
    it("removes the feedback file", async () => {
      await writeFeedback(tmpDir, makeFeedback());
      expect(fs.existsSync(feedbackPath(tmpDir))).toBe(true);

      await removeFeedback(tmpDir);
      expect(fs.existsSync(feedbackPath(tmpDir))).toBe(false);
    });

    it("does not throw when file does not exist", async () => {
      await expect(removeFeedback(tmpDir)).resolves.toBeUndefined();
    });
  });

  describe("PID file", () => {
    it("writes and reads PID", () => {
      writePid(tmpDir);
      const pid = readPid(tmpDir);
      expect(pid).toBe(process.pid);
    });

    it("returns null when no PID file", () => {
      expect(readPid(tmpDir)).toBeNull();
    });

    it("removes PID file", () => {
      writePid(tmpDir);
      removePid(tmpDir);
      expect(fs.existsSync(pidPath(tmpDir))).toBe(false);
    });
  });

  describe("isPidAlive", () => {
    it("returns true for current process", () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it("returns false for non-existent PID", () => {
      // Use a very high PID that's unlikely to exist
      expect(isPidAlive(999999)).toBe(false);
    });
  });

  describe("truncateError", () => {
    it("returns short errors unchanged", () => {
      expect(truncateError("short error")).toBe("short error");
    });

    it("truncates long errors", () => {
      const long = "x".repeat(3000);
      const result = truncateError(long);
      expect(result.length).toBeLessThan(long.length);
      expect(result).toContain("(truncated)");
    });
  });

  describe("buildSummary", () => {
    it("reports all passing", () => {
      const checks: StageResult[] = [
        { stage: "lint", passed: true, durationMs: 100 },
        { stage: "typecheck", passed: true, durationMs: 200 },
      ];
      const summary = buildSummary(checks, 300);
      expect(summary).toContain("All 2 checks passed");
    });

    it("reports failures with stage names", () => {
      const checks: StageResult[] = [
        { stage: "lint", passed: true, durationMs: 100 },
        { stage: "typecheck", passed: false, durationMs: 200, error: "TS2345: Type error" },
      ];
      const summary = buildSummary(checks, 300);
      expect(summary).toContain("1/2 checks failed");
      expect(summary).toContain("typecheck FAILED");
      expect(summary).toContain("TS2345");
    });
  });
});
