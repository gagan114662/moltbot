/**
 * Validation gates — run between QA iterations to catch syntax AND logic bugs.
 *
 * Gates:
 *   1. Compile check (tsc --noEmit)
 *   2. Dev server health (fetch + Vite error overlay check)
 *   3. Changed-file unit tests (vitest for colocated .test.ts files)
 *   4. LLM code review (semantic diff review)
 *   5. Score regression (rollback if score drops)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ProjectWarning } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GateResult = {
  passed: boolean;
  reason?: string;
  errors?: string[];
  /** LLM feedback to thread into next iteration context. */
  feedback?: string;
};

export type ValidationPipelineResult = {
  allPassed: boolean;
  results: Map<string, GateResult>;
};

export type ValidationPipelineOpts = {
  targetCwd: string;
  appUrl: string;
  changedFiles: string[];
  diff: string;
  nudge: string;
  projectWarnings: ProjectWarning[];
  currentScore: number | null;
  previousScore: number | null;
  agentDiagnose?: (prompt: string) => Promise<string>;
  onProgress?: (msg: string) => void;
};

// ---------------------------------------------------------------------------
// Gate 1: Compile Check
// ---------------------------------------------------------------------------

export function gateCompileCheck(targetCwd: string): GateResult {
  try {
    execSync("npx tsc --noEmit --pretty false 2>&1 | head -20", {
      cwd: targetCwd,
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { passed: true };
  } catch (err: unknown) {
    const stderr =
      err instanceof Error && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
    const stdout =
      err instanceof Error && "stdout" in err ? String((err as { stdout: unknown }).stdout) : "";
    const errors = (stderr || stdout).split("\n").filter(Boolean).slice(0, 5);
    return {
      passed: false,
      reason: "TypeScript compilation failed",
      errors,
    };
  }
}

// ---------------------------------------------------------------------------
// Gate 2: Dev Server Health
// ---------------------------------------------------------------------------

export async function gateDevServerHealth(appUrl: string): Promise<GateResult> {
  try {
    const resp = await fetch(appUrl, { signal: AbortSignal.timeout(10_000) });
    const html = await resp.text();
    if (html.includes("vite-error-overlay") || html.includes("Internal Server Error")) {
      return {
        passed: false,
        reason: "Dev server is showing Vite error overlay — build is broken",
      };
    }
    return { passed: true };
  } catch (err) {
    return {
      passed: false,
      reason: `Dev server unreachable: ${String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Gate 3: Changed-File Unit Tests
// ---------------------------------------------------------------------------

/**
 * Find colocated test files for the given source files.
 * Looks for: foo.test.ts, foo.test.tsx, __tests__/foo.test.ts, __tests__/foo.test.tsx
 */
export function findColocatedTests(targetCwd: string, changedFiles: string[]): string[] {
  const testFiles: string[] = [];
  const seen = new Set<string>();

  for (const file of changedFiles) {
    // Only look at .ts/.tsx files (skip .json, .md, etc.)
    if (!/\.(ts|tsx)$/.test(file)) {
      continue;
    }
    // Skip files that are already test files
    if (/\.test\.(ts|tsx)$/.test(file)) {
      continue;
    }

    const dir = path.dirname(file);
    const ext = path.extname(file);
    const base = path.basename(file, ext);

    const candidates = [
      path.join(dir, `${base}.test.ts`),
      path.join(dir, `${base}.test.tsx`),
      path.join(dir, "__tests__", `${base}.test.ts`),
      path.join(dir, "__tests__", `${base}.test.tsx`),
    ];

    for (const candidate of candidates) {
      const abs = path.resolve(targetCwd, candidate);
      if (!seen.has(abs) && fs.existsSync(abs)) {
        seen.add(abs);
        testFiles.push(candidate);
      }
    }
  }

  return testFiles;
}

export function gateChangedFileTests(targetCwd: string, changedFiles: string[]): GateResult {
  const testFiles = findColocatedTests(targetCwd, changedFiles);

  if (testFiles.length === 0) {
    return { passed: true, reason: "No colocated test files found for changed files" };
  }

  try {
    const fileArgs = testFiles.join(" ");
    execSync(`npx vitest run --reporter=verbose ${fileArgs}`, {
      cwd: targetCwd,
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { passed: true };
  } catch (err: unknown) {
    const stderr =
      err instanceof Error && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
    const stdout =
      err instanceof Error && "stdout" in err ? String((err as { stdout: unknown }).stdout) : "";
    const output = (stderr || stdout).split("\n").filter(Boolean).slice(-10);
    return {
      passed: false,
      reason: `Unit tests failed for: ${testFiles.join(", ")}`,
      errors: output,
    };
  }
}

// ---------------------------------------------------------------------------
// Gate 4: LLM Code Review
// ---------------------------------------------------------------------------

export async function gateLlmCodeReview(
  diff: string,
  nudge: string,
  projectWarnings: ProjectWarning[],
  agentDiagnose: (prompt: string) => Promise<string>,
  buildCodeReviewPrompt: (diff: string, nudge: string, warnings: ProjectWarning[]) => string,
): Promise<GateResult> {
  try {
    const reviewPrompt = buildCodeReviewPrompt(diff, nudge, projectWarnings);
    const codeReview = await agentDiagnose(reviewPrompt);
    const reviewText = codeReview.trim().slice(0, 500);
    return {
      passed: true, // code review is advisory, not blocking
      feedback: reviewText || undefined,
    };
  } catch {
    return { passed: true, reason: "Code review failed (non-fatal)" };
  }
}

// ---------------------------------------------------------------------------
// Gate 5: Score Regression
// ---------------------------------------------------------------------------

export function gateScoreRegression(
  currentScore: number | null,
  previousScore: number | null,
  threshold = 0.5,
): GateResult {
  if (currentScore === null || previousScore === null) {
    return { passed: true, reason: "Insufficient score data to compare" };
  }
  if (currentScore < previousScore - threshold) {
    return {
      passed: false,
      reason: `Score regressed: ${previousScore} → ${currentScore} (threshold: ${threshold})`,
    };
  }
  return { passed: true };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runValidationPipeline(
  opts: ValidationPipelineOpts,
): Promise<ValidationPipelineResult> {
  const results = new Map<string, GateResult>();

  // Gate 1: Compile
  const compileStart = Date.now();
  const compile = gateCompileCheck(opts.targetCwd);
  results.set("compile", compile);
  if (compile.passed) {
    opts.onProgress?.(`Compile check passed (${Date.now() - compileStart}ms)`);
  } else {
    opts.onProgress?.(`Compile check FAILED:\n${compile.errors?.join("\n") ?? compile.reason}`);
  }

  // Gate 2: Dev server (only if compile passed — broken build means dev server is likely down)
  if (compile.passed) {
    const devServer = await gateDevServerHealth(opts.appUrl);
    results.set("dev-server", devServer);
    if (!devServer.passed) {
      opts.onProgress?.(`Dev server check FAILED: ${devServer.reason}`);
    }
  }

  // Gate 3: Changed-file tests (run even if compile failed — tests may catch different issues)
  if (compile.passed && opts.changedFiles.length > 0) {
    const tests = gateChangedFileTests(opts.targetCwd, opts.changedFiles);
    results.set("changed-file-tests", tests);
    if (tests.passed) {
      opts.onProgress?.(tests.reason ? `Tests: ${tests.reason}` : "Changed-file tests passed");
    } else {
      opts.onProgress?.(
        `Changed-file tests FAILED: ${tests.reason}\n${tests.errors?.join("\n") ?? ""}`,
      );
    }
  }

  // Gate 4: LLM code review (advisory — doesn't block)
  // Skipped here — called separately in the loop because it needs buildCodeReviewPrompt from diagnosis module

  // Gate 5: Score regression
  const scoreGate = gateScoreRegression(opts.currentScore, opts.previousScore);
  results.set("score-regression", scoreGate);
  if (!scoreGate.passed) {
    opts.onProgress?.(`Score regression detected: ${scoreGate.reason}`);
  }

  const allPassed = [...results.values()].every((r) => r.passed);
  return { allPassed, results };
}
