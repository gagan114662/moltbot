/**
 * Spec-test stage: TDD agent writes acceptance tests BEFORE the coding agent.
 *
 * Runs before iteration 1. Spawns an agent that reads the task and writes
 * acceptance .test.ts files. The task is then augmented to say
 * "Make these tests pass."
 *
 * Non-blocking: if the spec agent fails, the worker continues without TDD.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { agentCliCommand } from "../commands/agent-via-gateway.js";
import { defaultRuntime } from "../runtime.js";

const SPEC_TIMEOUT_S = 180;
/** Max test files the spec agent may produce */
const MAX_TEST_FILES = 3;
/** Max total lines across all spec test files */
const MAX_TOTAL_LINES = 300;

export type SpecTestContext = {
  cwd: string;
  task: string;
  signal: AbortSignal;
  agentId?: string;
  local: boolean;
};

export type SpecTestResult = {
  ok: boolean;
  testFiles: string[];
  durationMs: number;
  error?: string;
};

/** Discover test files created by the spec agent via git status. */
function discoverNewTestFiles(cwd: string): string[] {
  try {
    const output = execSync("git status --porcelain", {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
    });

    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter((f) => /\.test\.(ts|tsx)$/.test(f));
  } catch {
    return [];
  }
}

/** Count total lines across files. */
function countTotalLines(cwd: string, files: string[]): number {
  let total = 0;
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(cwd, file), "utf-8");
      total += content.split("\n").length;
    } catch {
      // ignore
    }
  }
  return total;
}

/** Prune excess test files if the spec agent went overboard. */
function pruneExcessFiles(cwd: string, files: string[]): string[] {
  if (files.length <= MAX_TEST_FILES) {
    const totalLines = countTotalLines(cwd, files);
    if (totalLines <= MAX_TOTAL_LINES) {
      return files;
    }
  }

  // Sort by file size (keep smallest files — less likely to be over-specified)
  const sized = files.map((f) => {
    try {
      const content = fs.readFileSync(path.join(cwd, f), "utf-8");
      return { file: f, lines: content.split("\n").length };
    } catch {
      return { file: f, lines: 0 };
    }
  });
  sized.sort((a, b) => a.lines - b.lines);

  const kept: string[] = [];
  let lineCount = 0;
  for (const { file, lines } of sized) {
    if (kept.length >= MAX_TEST_FILES) {
      break;
    }
    if (lineCount + lines > MAX_TOTAL_LINES && kept.length > 0) {
      break;
    }
    kept.push(file);
    lineCount += lines;
  }

  // Remove pruned files
  const keptSet = new Set(kept);
  for (const f of files) {
    if (!keptSet.has(f)) {
      try {
        fs.unlinkSync(path.join(cwd, f));
        // Unstage if needed
        execSync(`git checkout -- "${f}" 2>/dev/null || true`, {
          cwd,
          encoding: "utf-8",
          timeout: 5000,
        });
      } catch {
        // ignore
      }
    }
  }

  return kept;
}

export async function runSpecTestStage(ctx: SpecTestContext): Promise<SpecTestResult> {
  const start = Date.now();

  const systemPrompt = [
    "You are a TDD engineer. Your ONLY job is to write acceptance tests.",
    "",
    "Rules:",
    "1. Read the task description and the relevant source files",
    "2. Write .test.ts files that test the EXPECTED behavior described in the task",
    "3. Test OBSERVABLE BEHAVIOR, NOT implementation details",
    "4. Do NOT assert on CSS classes, DOM structure, or internal state",
    "5. Assert on user-visible outcomes and public API contracts",
    "6. Do NOT implement any production code — tests ONLY",
    "7. Place tests colocated with the likely implementation file (*.test.ts convention)",
    "8. Keep tests simple and focused — one behavior per test",
    "9. Use vitest (describe, it, expect) — it's already configured",
    "",
    `TASK: ${ctx.task}`,
  ].join("\n");

  try {
    const sessionId = `spec-test-${Date.now()}`;
    await agentCliCommand(
      {
        message: `Write acceptance tests for this task. Do NOT write any implementation code.\n\nTASK: ${ctx.task}`,
        sessionId,
        thinking: "low",
        timeout: String(SPEC_TIMEOUT_S),
        local: ctx.local,
        json: true,
        extraSystemPrompt: systemPrompt,
      },
      defaultRuntime,
    );

    // Discover what test files were created
    let testFiles = discoverNewTestFiles(ctx.cwd);
    if (testFiles.length === 0) {
      return {
        ok: false,
        testFiles: [],
        durationMs: Date.now() - start,
        error: "Spec agent did not create any test files",
      };
    }

    // Prune if too many/large
    testFiles = pruneExcessFiles(ctx.cwd, testFiles);

    return {
      ok: true,
      testFiles,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      testFiles: [],
      durationMs: Date.now() - start,
      error: `Spec-test agent failed: ${String(err).slice(0, 200)}`,
    };
  }
}

/** Augment the task description with spec test file paths. */
export function augmentTaskWithSpecs(task: string, testFiles: string[]): string {
  if (testFiles.length === 0) {
    return task;
  }
  return [
    task,
    "",
    "ACCEPTANCE TESTS (written before your implementation — make them pass):",
    ...testFiles.map((f) => `- ${f}`),
    "",
    "Your implementation MUST make these acceptance tests pass.",
  ].join("\n");
}
