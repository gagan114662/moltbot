import { describe, it, expect } from "vitest";
import type { StageResult } from "./types.js";
import { buildFeedbackPrompt, failureFingerprint, getChangedFiles } from "./worker.js";

describe("buildFeedbackPrompt", () => {
  it("includes failed check details", () => {
    const checks: StageResult[] = [
      { stage: "lint", passed: true, durationMs: 500 },
      {
        stage: "typecheck",
        passed: false,
        durationMs: 3000,
        error: "src/foo.ts(10,5): error TS2322: Type 'string' not assignable to 'number'",
      },
    ];

    const prompt = buildFeedbackPrompt(1, 5, checks, ["src/foo.ts"]);

    expect(prompt).toContain("VERIFICATION FAILED - Iteration 1/5");
    expect(prompt).toContain("TYPECHECK FAILED");
    expect(prompt).toContain("TS2322");
    expect(prompt).toContain("src/foo.ts");
    expect(prompt).toContain("4 iterations remaining");
    // Should NOT include passing checks
    expect(prompt).not.toContain("LINT FAILED");
  });

  it("lists changed files", () => {
    const checks: StageResult[] = [
      { stage: "lint", passed: false, durationMs: 100, error: "unused var" },
    ];

    const prompt = buildFeedbackPrompt(2, 3, checks, ["src/a.ts", "src/b.ts"]);

    expect(prompt).toContain("Files you changed:");
    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("- src/b.ts");
    expect(prompt).toContain("1 iterations remaining");
  });

  it("truncates long error output at 25 lines", () => {
    const longError = Array.from({ length: 50 }, (_, i) => `error line ${i}`).join("\n");
    const checks: StageResult[] = [
      { stage: "test", passed: false, durationMs: 5000, error: longError },
    ];

    const prompt = buildFeedbackPrompt(1, 5, checks, []);

    expect(prompt).toContain("error line 0");
    expect(prompt).toContain("error line 24");
    expect(prompt).not.toContain("error line 25");
    expect(prompt).toContain("25 more lines");
  });

  it("handles multiple failed checks", () => {
    const checks: StageResult[] = [
      { stage: "lint", passed: false, durationMs: 200, error: "unused import" },
      { stage: "typecheck", passed: false, durationMs: 4000, error: "TS2345" },
      { stage: "test", passed: true, durationMs: 1000 },
    ];

    const prompt = buildFeedbackPrompt(3, 5, checks, []);

    expect(prompt).toContain("LINT FAILED");
    expect(prompt).toContain("TYPECHECK FAILED");
    expect(prompt).not.toContain("TEST FAILED");
  });
});

describe("failureFingerprint", () => {
  it("returns sorted comma-separated failing stage names", () => {
    const checks: StageResult[] = [
      { stage: "typecheck", passed: false, durationMs: 100 },
      { stage: "lint", passed: true, durationMs: 50 },
      { stage: "test", passed: false, durationMs: 200 },
    ];

    expect(failureFingerprint(checks)).toBe("test,typecheck");
  });

  it("returns empty string when all pass", () => {
    const checks: StageResult[] = [
      { stage: "lint", passed: true, durationMs: 50 },
      { stage: "typecheck", passed: true, durationMs: 100 },
    ];

    expect(failureFingerprint(checks)).toBe("");
  });

  it("detects same fingerprint across iterations", () => {
    const checks1: StageResult[] = [
      { stage: "typecheck", passed: false, durationMs: 100, error: "TS2322 in foo.ts" },
      { stage: "lint", passed: true, durationMs: 50 },
    ];
    const checks2: StageResult[] = [
      { stage: "typecheck", passed: false, durationMs: 120, error: "TS2322 in foo.ts still" },
      { stage: "lint", passed: true, durationMs: 60 },
    ];

    expect(failureFingerprint(checks1)).toBe(failureFingerprint(checks2));
  });

  it("detects different fingerprint when failures change", () => {
    const checks1: StageResult[] = [
      { stage: "typecheck", passed: false, durationMs: 100 },
      { stage: "lint", passed: true, durationMs: 50 },
    ];
    const checks2: StageResult[] = [
      { stage: "typecheck", passed: true, durationMs: 100 },
      { stage: "test", passed: false, durationMs: 200 },
    ];

    expect(failureFingerprint(checks1)).not.toBe(failureFingerprint(checks2));
  });
});

describe("getChangedFiles", () => {
  it("returns empty array for non-existent baseline", () => {
    const files = getChangedFiles("/tmp/nonexistent-repo", "abc123");
    expect(files).toEqual([]);
  });
});
