/**
 * Autonomous copilot worker.
 *
 * Runs a tight loop: agent writes code → verification → feedback → agent fixes.
 * Requires a clean git working tree (auto-stashes if dirty).
 * Stops on success, max iterations, or stall detection.
 */

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "./types.js";
import type { WorkerConfig, WorkerResult, IterationResult, WorkerEvent } from "./worker-types.js";
import { agentCliCommand } from "../commands/agent-via-gateway.js";
import { defaultRuntime } from "../runtime.js";
import { runBrowserInspectStage } from "./browser-inspect.js";
import { buildSummary, writeFeedback } from "./feedback.js";
import { runCoverageDiffStage } from "./stages-coverage.js";
import { runReviewStage } from "./stages-review.js";
import { runScreenshotDiffStage } from "./stages-screenshot-diff.js";
import { augmentTaskWithSpecs, runSpecTestStage } from "./stages-spec-tests.js";
import { runUxEvalStage } from "./stages-ux-eval.js";
import { runLintStage, runTypecheckStage, runTestStage } from "./stages.js";
import { runVideoVerification } from "./video-verify.js";
import { createWorkerDashboard } from "./worker-dashboard.js";

/** Check if git working tree is clean, auto-stash if dirty */
export function ensureCleanWorkingTree(cwd: string): { stashed: boolean } {
  const status = execSync("git status --porcelain", {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
  }).trim();

  if (!status) {
    return { stashed: false };
  }

  execSync('git stash push -m "copilot-work-autostash"', {
    cwd,
    encoding: "utf-8",
    timeout: 15_000,
  });
  return { stashed: true };
}

/** Restore auto-stashed changes */
export function restoreStash(cwd: string): void {
  try {
    execSync("git stash pop", { cwd, encoding: "utf-8", timeout: 15_000 });
  } catch {
    // Stash pop can fail on conflicts — log but don't crash
    process.stderr.write(
      "Warning: git stash pop failed. Your stashed changes are still in `git stash list`.\n",
    );
  }
}

/** Get git HEAD short SHA */
function getHeadRef(cwd: string): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Get changed files relative to a baseline commit */
export function getChangedFiles(cwd: string, baselineRef: string): string[] {
  try {
    const output = execSync(`git diff --name-only ${baselineRef}`, {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    if (!output) {
      return [];
    }
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Try to read CLAUDE.md from the workspace for project context */
function readProjectContext(cwd: string): string {
  const candidates = ["CLAUDE.md", ".claude/CLAUDE.md"];
  for (const name of candidates) {
    try {
      const content = fs.readFileSync(path.join(cwd, name), "utf-8");
      if (content.trim()) {
        // Truncate to keep prompt reasonable
        return content.length > 2000 ? content.slice(0, 2000) + "\n... (truncated)" : content;
      }
    } catch {
      // Not found, try next
    }
  }
  return "";
}

/** Build the SR engineer system prompt */
function buildSystemPrompt(cwd: string, task: string): string {
  const projectContext = readProjectContext(cwd);

  const sections: string[] = [
    "You are a senior software engineer working autonomously on a coding task.",
    "You have full access to the codebase via tools: Read, Write, Edit, and exec (bash).",
    "",
    "Your workflow:",
    "1. Read relevant files to understand the codebase context and existing patterns",
    "2. Plan your approach",
    "3. Implement the changes using Write/Edit tools",
    "4. Write tests for all new/modified functionality",
    "5. Run `pnpm test` to verify — fix any failures before handing off",
    "6. Run `pnpm check` (lint + format) and fix issues",
    "",
    "After you finish, an automated verification pipeline will check your work",
    "(lint, typecheck, tests, browser UX evaluation). If issues are found, you",
    "will receive the errors and get another chance to fix them.",
  ];

  // Quality requirements
  sections.push(
    "",
    "## Quality Requirements",
    "- You MUST write tests for all new/modified functionality — no exceptions",
    "- Test framework: vitest (describe, it, expect)",
    "- Test placement: colocated *.test.ts files next to source",
    "- Write clean, typed TypeScript (no `any`)",
    "- Follow existing code patterns and conventions — read before writing",
    "- Keep changes focused on the task",
    "- Do NOT commit or push — the caller handles that",
  );

  // Project context from CLAUDE.md
  if (projectContext) {
    sections.push("", "## Project Context", projectContext);
  }

  sections.push("", `TASK: ${task}`);

  return sections.join("\n");
}

/** Build feedback prompt from failed verification */
export function buildFeedbackPrompt(
  iteration: number,
  maxIterations: number,
  checks: StageResult[],
  changedFiles: string[],
): string {
  const failed = checks.filter((c) => !c.passed);
  const lines: string[] = [
    `VERIFICATION FAILED - Iteration ${iteration}/${maxIterations}`,
    "",
    "The following checks failed after your last changes:",
  ];

  for (const check of failed) {
    lines.push("");
    lines.push(`## ${check.stage.toUpperCase()} FAILED (${(check.durationMs / 1000).toFixed(1)}s)`);
    if (check.error) {
      const errorLines = check.error.split("\n").slice(0, 25);
      lines.push(...errorLines);
      if (check.error.split("\n").length > 25) {
        lines.push(`... (${check.error.split("\n").length - 25} more lines)`);
      }
    }
  }

  if (changedFiles.length > 0) {
    lines.push("", "Files you changed:");
    for (const f of changedFiles.slice(0, 20)) {
      lines.push(`- ${f}`);
    }
  }

  lines.push(
    "",
    `You have ${maxIterations - iteration} iterations remaining. Fix the errors above.`,
  );

  return lines.join("\n");
}

/** Compute a fingerprint of failing checks for stall detection */
export function failureFingerprint(checks: StageResult[]): string {
  return checks
    .filter((c) => !c.passed)
    .map((c) => c.stage)
    .toSorted()
    .join(",");
}

/** Run verification stages on changed files */
async function runVerification(
  changedFiles: string[],
  config: WorkerConfig,
  baselineRef: string,
  signal: AbortSignal,
  emit: (event: WorkerEvent) => void,
): Promise<{ checks: StageResult[]; allPassed: boolean; durationMs: number }> {
  const start = Date.now();
  const checks: StageResult[] = [];
  const ctx = { changedFiles, cwd: config.cwd, signal };

  // Lint + typecheck in parallel
  emit({ type: "stage-start", stage: "lint + typecheck" });
  const [lint, typecheck] = await Promise.all([runLintStage(ctx), runTypecheckStage(ctx)]);
  checks.push(lint, typecheck);
  emit({ type: "stage-done", result: lint });
  emit({ type: "stage-done", result: typecheck });

  // Tests (only if not skipped)
  if (!config.noTests) {
    emit({ type: "stage-start", stage: "test" });
    const test = await runTestStage(ctx);
    checks.push(test);
    emit({ type: "stage-done", result: test });
  }

  // Coverage-diff (only if tests passed and not skipped)
  const testsPassed = checks.every((c) => c.passed);
  if (!config.noCoverage && testsPassed && !config.noTests) {
    emit({ type: "stage-start", stage: "coverage-diff" });
    const coverage = await runCoverageDiffStage({ ...ctx, baselineRef });
    checks.push(coverage);
    emit({ type: "stage-done", result: coverage });
  }

  // Browser inspection (only if code checks pass and not skipped)
  const codeChecksPassed = checks.every((c) => c.passed);
  let screenshotPath: string | undefined;
  if (!config.noBrowser && codeChecksPassed) {
    emit({ type: "stage-start", stage: "browser" });
    const { result: browserResult, inspect } = await runBrowserInspectStage({
      cwd: config.cwd,
      signal,
      appUrl: config.appUrl,
    });
    checks.push(browserResult);
    emit({ type: "stage-done", result: browserResult });
    screenshotPath = inspect?.screenshotPath;
  }

  // Screenshot-diff (only if browser passed and screenshot exists)
  if (!config.noScreenshotDiff && screenshotPath && codeChecksPassed) {
    emit({ type: "stage-start", stage: "screenshot-diff" });
    const screenshotDiff = await runScreenshotDiffStage({
      cwd: config.cwd,
      screenshotPath,
      signal,
    });
    checks.push(screenshotDiff);
    emit({ type: "stage-done", result: screenshotDiff });
  }

  // Deep UX evaluation (after browser pre-gate passes)
  const browserPassed = checks.every((c) => c.passed);
  if (!config.noUxEval && browserPassed && !config.noBrowser) {
    emit({ type: "stage-start", stage: "ux-eval" });
    const uxEval = await runUxEvalStage({
      cwd: config.cwd,
      criteria: config.task,
      appUrl: config.appUrl,
      signal,
      maxSteps: config.uxEvalSteps,
      sample: config.uxEvalSample,
      agentId: config.agentId,
      local: config.local,
    });
    checks.push(uxEval);
    emit({ type: "stage-done", result: uxEval });
  }

  // Review-agent (blocks on high-confidence issues)
  const allAutomatedPassed = checks.every((c) => c.passed);
  if (!config.noReview && allAutomatedPassed) {
    emit({ type: "stage-start", stage: "review" });
    const review = await runReviewStage({
      cwd: config.cwd,
      baselineRef,
      changedFiles,
      signal,
      agentId: config.agentId,
      local: config.local,
    });
    checks.push(review);
    emit({ type: "stage-done", result: review });
  }

  const allPassed = checks.every((c) => c.passed);
  return { checks, allPassed, durationMs: Date.now() - start };
}

/** Run a single agent turn */
async function runAgentTurn(
  message: string,
  config: WorkerConfig,
  sessionId: string,
  isFirstTurn: boolean,
): Promise<{ response: string; durationMs: number }> {
  const start = Date.now();

  const response = await agentCliCommand(
    {
      message,
      agent: config.agentId,
      sessionId,
      thinking: config.thinking,
      timeout: String(config.turnTimeoutSeconds),
      local: config.local,
      json: true,
      extraSystemPrompt: isFirstTurn ? buildSystemPrompt(config.cwd, config.task) : undefined,
    },
    defaultRuntime,
  );

  // Extract text from result payloads
  const result = response as
    | { result?: { payloads?: Array<{ text?: string }> }; summary?: string }
    | undefined;
  const text =
    result?.result?.payloads
      ?.map((p) => p.text)
      .filter(Boolean)
      .join("\n") ??
    result?.summary ??
    "";

  return { response: text, durationMs: Date.now() - start };
}

/** Main worker loop */
export async function runWorker(inputConfig: WorkerConfig): Promise<WorkerResult> {
  let config = inputConfig;
  const startTime = Date.now();
  const emit = config.emit ?? (config.json ? jsonEmitter() : dashboardEmitter(config));
  const iterations: IterationResult[] = [];
  let stashed = false;
  let allChangedFiles: string[] = [];

  try {
    // 1. Ensure clean working tree
    const stashResult = ensureCleanWorkingTree(config.cwd);
    stashed = stashResult.stashed;
    emit({ type: "git-stash", stashed });

    // 2. Record baseline
    const baselineRef = getHeadRef(config.cwd);

    // 3. Generate persistent session ID
    const sessionId = crypto.randomUUID();

    // 3b. Spec-test TDD stage (before coding begins)
    if (!config.noSpecTests) {
      emit({ type: "stage-start", stage: "spec-test" });
      const specResult = await runSpecTestStage({
        cwd: config.cwd,
        task: config.task,
        signal: new AbortController().signal,
        agentId: config.agentId,
        local: config.local,
      });
      emit({
        type: "stage-done",
        result: {
          stage: "spec-test",
          passed: specResult.ok,
          durationMs: specResult.durationMs,
          error: specResult.error,
          files: specResult.testFiles,
        },
      });
      if (specResult.ok && specResult.testFiles.length > 0) {
        config = { ...config, task: augmentTaskWithSpecs(config.task, specResult.testFiles) };
      }
    }

    // 4. Iteration loop
    let lastFingerprint = "";
    let consecutiveStalls = 0;

    for (let i = 1; i <= config.maxIterations; i++) {
      emit({ type: "iteration-start", iteration: i, maxIterations: config.maxIterations });

      // Agent turn
      emit({ type: "agent-start", iteration: i });
      let agentMessage: string;
      if (i === 1) {
        agentMessage = config.task;
      } else {
        const lastIter = iterations[iterations.length - 1];
        if (lastIter) {
          agentMessage = buildFeedbackPrompt(
            i - 1,
            config.maxIterations,
            lastIter.checks,
            lastIter.changedFiles,
          );
        } else {
          agentMessage = config.task;
        }
      }

      let agentResult: { response: string; durationMs: number };
      try {
        agentResult = await runAgentTurn(agentMessage, config, sessionId, i === 1);
      } catch (err) {
        emit({ type: "error", error: `Agent failed: ${String(err)}` });
        agentResult = { response: "", durationMs: 0 };
      }
      emit({
        type: "agent-done",
        iteration: i,
        durationMs: agentResult.durationMs,
        summary: agentResult.response.slice(0, 200),
      });

      // Detect changed files
      const changedFiles = getChangedFiles(config.cwd, baselineRef);
      allChangedFiles = changedFiles;
      emit({ type: "verify-start", iteration: i, changedFiles });

      // Run verification
      const abort = new AbortController();
      const verify = await runVerification(changedFiles, config, baselineRef, abort.signal, emit);
      emit({
        type: "verify-done",
        iteration: i,
        allPassed: verify.allPassed,
        checks: verify.checks,
      });

      iterations.push({
        iteration: i,
        agentDurationMs: agentResult.durationMs,
        verifyDurationMs: verify.durationMs,
        checks: verify.checks,
        allPassed: verify.allPassed,
        changedFiles,
        agentSummary: agentResult.response.slice(0, 500),
      });

      // Success — break out
      if (verify.allPassed) {
        // Video proof
        let video;
        if (!config.noVideo) {
          emit({ type: "video-start" });
          const videoResult = await runVideoVerification({
            cwd: config.cwd,
            signal: abort.signal,
            appUrl: config.appUrl,
          });
          emit({ type: "video-done", result: videoResult.result });
          if (videoResult.video) {
            video = videoResult.video;
          }
        }

        // Write feedback
        await writeFeedback(config.cwd, {
          timestamp: new Date().toISOString(),
          ok: true,
          durationMs: Date.now() - startTime,
          gitRef: getHeadRef(config.cwd),
          triggerFiles: changedFiles,
          checks: verify.checks,
          video,
          summary: buildSummary(verify.checks, Date.now() - startTime),
        });

        const result: WorkerResult = {
          ok: true,
          iterations,
          totalDurationMs: Date.now() - startTime,
          video,
          changedFiles,
          stoppedEarly: false,
          stopReason: "success",
        };
        emit({ type: "done", result });
        return result;
      }

      // Stall detection
      const fp = failureFingerprint(verify.checks);
      if (fp === lastFingerprint && fp !== "") {
        consecutiveStalls++;
      } else {
        consecutiveStalls = 0;
      }
      lastFingerprint = fp;

      emit({
        type: "stall-warning",
        consecutiveStalls,
        stallLimit: config.stallLimit,
      });

      if (consecutiveStalls >= config.stallLimit) {
        // Write failure feedback
        await writeFeedback(config.cwd, {
          timestamp: new Date().toISOString(),
          ok: false,
          durationMs: Date.now() - startTime,
          gitRef: getHeadRef(config.cwd),
          triggerFiles: changedFiles,
          checks: verify.checks,
          summary: buildSummary(verify.checks, Date.now() - startTime),
        });

        const result: WorkerResult = {
          ok: false,
          iterations,
          totalDurationMs: Date.now() - startTime,
          changedFiles,
          stoppedEarly: true,
          stopReason: "stall",
        };
        emit({ type: "done", result });
        return result;
      }
    }

    // Max iterations exhausted
    const lastChecks = iterations[iterations.length - 1]?.checks ?? [];
    await writeFeedback(config.cwd, {
      timestamp: new Date().toISOString(),
      ok: false,
      durationMs: Date.now() - startTime,
      gitRef: getHeadRef(config.cwd),
      triggerFiles: allChangedFiles,
      checks: lastChecks,
      summary: buildSummary(lastChecks, Date.now() - startTime),
    });

    const result: WorkerResult = {
      ok: false,
      iterations,
      totalDurationMs: Date.now() - startTime,
      changedFiles: allChangedFiles,
      stoppedEarly: false,
      stopReason: "max-iterations",
    };
    emit({ type: "done", result });
    return result;
  } finally {
    if (stashed) {
      restoreStash(config.cwd);
    }
  }
}

/** Dashboard-based event emitter (TTY mode) */
function dashboardEmitter(config: WorkerConfig): (event: WorkerEvent) => void {
  const dashboard = createWorkerDashboard(config.task, config.maxIterations, config.stallLimit);
  return (event) => dashboard.handleEvent(event);
}

/** JSON event emitter (--json mode) */
function jsonEmitter(): (event: WorkerEvent) => void {
  return (event) => {
    process.stdout.write(JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + "\n");
  };
}
