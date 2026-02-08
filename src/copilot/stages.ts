/**
 * Individual verification stage runners for the copilot pipeline.
 *
 * Each stage spawns child processes and captures output.
 * Stages are designed to be composable and cancellable via AbortSignal.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "./types.js";
import { truncateError } from "./feedback.js";

export type StageContext = {
  /** Files that triggered this run (relative paths) */
  changedFiles: string[];
  /** Working directory */
  cwd: string;
  /** Signal to cancel the stage */
  signal: AbortSignal;
};

/** Run a shell command and capture output. Returns exit code and combined output. */
export async function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string; signal: AbortSignal; timeoutMs: number },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });

    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    const onAbort = () => {
      child.kill("SIGTERM");
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      opts.signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, output });
    });
  });
}

/** Stage 1: Lint changed files with oxlint */
export async function runLintStage(ctx: StageContext): Promise<StageResult> {
  const start = Date.now();
  const tsFiles = ctx.changedFiles.filter((f) => /\.(ts|tsx|js|jsx|mjs|mts)$/.test(f));

  if (tsFiles.length === 0) {
    return { stage: "lint", passed: true, durationMs: Date.now() - start, files: [] };
  }

  try {
    const { code, output } = await runCommand("pnpm", ["exec", "oxlint", ...tsFiles], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: 30_000,
    });

    return {
      stage: "lint",
      passed: code === 0,
      durationMs: Date.now() - start,
      error: code !== 0 ? truncateError(output) : undefined,
      files: tsFiles,
    };
  } catch (err) {
    if (ctx.signal.aborted) {
      return { stage: "lint", passed: false, durationMs: Date.now() - start, error: "Cancelled" };
    }
    return {
      stage: "lint",
      passed: false,
      durationMs: Date.now() - start,
      error: truncateError(String(err)),
    };
  }
}

/** Stage 2: TypeScript type checking */
export async function runTypecheckStage(ctx: StageContext): Promise<StageResult> {
  const start = Date.now();
  try {
    const { code, output } = await runCommand("pnpm", ["tsgo"], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: 60_000,
    });

    return {
      stage: "typecheck",
      passed: code === 0,
      durationMs: Date.now() - start,
      error: code !== 0 ? truncateError(output) : undefined,
    };
  } catch (err) {
    if (ctx.signal.aborted) {
      return {
        stage: "typecheck",
        passed: false,
        durationMs: Date.now() - start,
        error: "Cancelled",
      };
    }
    return {
      stage: "typecheck",
      passed: false,
      durationMs: Date.now() - start,
      error: truncateError(String(err)),
    };
  }
}

/** Stage 3: Run tests for changed files (smart discovery) */
export async function runTestStage(ctx: StageContext): Promise<StageResult> {
  const start = Date.now();
  const testFiles = discoverTestFiles(ctx.changedFiles, ctx.cwd);

  if (testFiles.length === 0) {
    return { stage: "test", passed: true, durationMs: Date.now() - start, files: [] };
  }

  try {
    const { code, output } = await runCommand("pnpm", ["exec", "vitest", "run", ...testFiles], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: 120_000,
    });

    return {
      stage: "test",
      passed: code === 0,
      durationMs: Date.now() - start,
      error: code !== 0 ? truncateError(output) : undefined,
      files: testFiles,
    };
  } catch (err) {
    if (ctx.signal.aborted) {
      return { stage: "test", passed: false, durationMs: Date.now() - start, error: "Cancelled" };
    }
    return {
      stage: "test",
      passed: false,
      durationMs: Date.now() - start,
      error: truncateError(String(err)),
    };
  }
}

/** Stage 4: Build (pnpm build) */
export async function runBuildStage(ctx: StageContext): Promise<StageResult> {
  const start = Date.now();
  try {
    const { code, output } = await runCommand("pnpm", ["build"], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: 180_000,
    });

    return {
      stage: "build",
      passed: code === 0,
      durationMs: Date.now() - start,
      error: code !== 0 ? truncateError(output) : undefined,
    };
  } catch (err) {
    if (ctx.signal.aborted) {
      return { stage: "build", passed: false, durationMs: Date.now() - start, error: "Cancelled" };
    }
    return {
      stage: "build",
      passed: false,
      durationMs: Date.now() - start,
      error: truncateError(String(err)),
    };
  }
}

/**
 * Discover colocated test files for changed source files.
 * Mirrors the logic from scripts/verify-autonomous.sh.
 */
export function discoverTestFiles(changedFiles: string[], cwd: string): string[] {
  const testFiles = new Set<string>();

  for (const file of changedFiles) {
    // Skip non-TS files and test files themselves
    if (!/\.tsx?$/.test(file) || /\.(test|e2e\.test)\.ts$/.test(file)) {
      continue;
    }

    // Look for colocated test file
    const base = file.replace(/\.tsx?$/, "");
    const candidates = [`${base}.test.ts`, `${base}.test.tsx`];

    for (const candidate of candidates) {
      const fullPath = path.join(cwd, candidate);
      if (fs.existsSync(fullPath)) {
        testFiles.add(candidate);
      }
    }
  }

  // Also include test files that were directly changed
  for (const file of changedFiles) {
    if (/\.test\.tsx?$/.test(file) && !/\.e2e\.test\.tsx?$/.test(file)) {
      const fullPath = path.join(cwd, file);
      if (fs.existsSync(fullPath)) {
        testFiles.add(file);
      }
    }
  }

  return Array.from(testFiles);
}
