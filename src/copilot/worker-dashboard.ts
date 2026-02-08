/**
 * Terminal dashboard for the copilot worker (autonomous mode).
 *
 * Renders live iteration progress using ANSI escape codes.
 * Falls back to simple log lines when not running in a TTY.
 */

import type { StageResult } from "./types.js";
import type { IterationResult, WorkerEvent, WorkerResult } from "./worker-types.js";
import { theme } from "../terminal/theme.js";

const isTTY = process.stderr.isTTY ?? false;
const CLEAR = "\x1b[H\x1b[J";

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatElapsed(startedAt: Date): string {
  const seconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function stageIcon(result: StageResult): string {
  return result.passed ? theme.success("PASS") : theme.error("FAIL");
}

type DashboardState = {
  task: string;
  startedAt: Date;
  maxIterations: number;
  currentIteration: number;
  phase: "agent" | "verify" | "video" | "done" | "failed" | "stalled";
  currentStage?: string;
  completedIterations: IterationResult[];
  currentChecks: StageResult[];
  changedFiles: string[];
  consecutiveStalls: number;
  stallLimit: number;
  stashed: boolean;
  finalResult?: WorkerResult;
};

function renderWorkerDashboard(state: DashboardState): string {
  const lines: string[] = [];

  // Header
  const taskDisplay = state.task.length > 50 ? `${state.task.slice(0, 47)}...` : state.task;
  lines.push(
    `  ${theme.heading("Copilot Work")}  "${taskDisplay}"  |  ${formatElapsed(state.startedAt)}`,
  );
  lines.push("");

  // Status line
  const stallText =
    state.consecutiveStalls > 0
      ? state.consecutiveStalls >= state.stallLimit - 1
        ? theme.error(` Stall: ${state.consecutiveStalls}/${state.stallLimit}`)
        : theme.warn(` Stall: ${state.consecutiveStalls}/${state.stallLimit}`)
      : "";
  lines.push(`  Iteration  ${state.currentIteration}/${state.maxIterations}${stallText}`);

  // Phase
  let phaseText: string;
  switch (state.phase) {
    case "agent":
      phaseText = theme.warn("Agent coding...");
      break;
    case "verify":
      phaseText = state.currentStage
        ? theme.warn(`Verifying: ${state.currentStage}...`)
        : theme.warn("Verifying changes...");
      break;
    case "video":
      phaseText = theme.warn("Capturing video proof...");
      break;
    case "done":
      phaseText = theme.success("Done — all checks passed");
      break;
    case "failed":
      phaseText = theme.error("Failed — checks did not pass");
      break;
    case "stalled":
      phaseText = theme.error("Stopped — agent not making progress");
      break;
  }
  lines.push(`  Phase      ${phaseText}`);

  if (state.stashed) {
    lines.push(`  Git        ${theme.muted("working tree auto-stashed")}`);
  }
  lines.push("");

  // Completed iterations
  for (const iter of state.completedIterations) {
    lines.push(`  ${theme.muted(`--- Iteration ${iter.iteration} ---`)}`);
    lines.push(
      `  Agent      ${formatDuration(iter.agentDurationMs).padEnd(8)} ${theme.muted(`${iter.changedFiles.length} files changed`)}`,
    );
    for (const check of iter.checks) {
      const status = stageIcon(check);
      const dur = formatDuration(check.durationMs);
      const files = check.files?.length ? theme.muted(`${check.files.length} files`) : "";
      const errorSnippet =
        !check.passed && check.error
          ? theme.muted(` ${check.error.split("\n")[0]?.slice(0, 60)}`)
          : "";
      lines.push(
        `  ${check.stage.padEnd(14)} ${status}   ${dur.padEnd(8)} ${files}${errorSnippet}`,
      );
    }
    lines.push("");
  }

  // Current iteration in-progress checks
  if (state.currentChecks.length > 0 && state.phase === "verify") {
    lines.push(`  ${theme.muted(`--- Iteration ${state.currentIteration} ---`)}`);
    for (const check of state.currentChecks) {
      const status = stageIcon(check);
      const dur = formatDuration(check.durationMs);
      lines.push(`  ${check.stage.padEnd(14)} ${status}   ${dur}`);
    }
    if (state.currentStage) {
      lines.push(`  ${state.currentStage.padEnd(14)} ${theme.warn("...")}`);
    }
    lines.push("");
  }

  // Changed files
  if (state.changedFiles.length > 0) {
    lines.push(`  ${theme.muted("--- Changed Files ---")}`);
    const shown = state.changedFiles.slice(0, 8);
    for (const file of shown) {
      lines.push(`  ${theme.muted(file)}`);
    }
    if (state.changedFiles.length > 8) {
      lines.push(theme.muted(`  ... +${state.changedFiles.length - 8} more`));
    }
  }

  return lines.join("\n");
}

export function createWorkerDashboard(
  task: string,
  maxIterations: number,
  stallLimit: number,
): {
  handleEvent(event: WorkerEvent): void;
  render(): void;
} {
  const state: DashboardState = {
    task,
    startedAt: new Date(),
    maxIterations,
    currentIteration: 0,
    phase: "agent",
    completedIterations: [],
    currentChecks: [],
    changedFiles: [],
    consecutiveStalls: 0,
    stallLimit,
    stashed: false,
  };

  function render() {
    if (isTTY) {
      process.stderr.write(CLEAR + renderWorkerDashboard(state) + "\n");
    }
  }

  function logLine(message: string) {
    const ts = new Date().toLocaleTimeString();
    if (!isTTY) {
      process.stderr.write(`[${ts}] ${message}\n`);
    }
  }

  return {
    render,

    handleEvent(event: WorkerEvent) {
      switch (event.type) {
        case "git-stash":
          state.stashed = event.stashed;
          if (event.stashed) {
            logLine("Auto-stashed dirty working tree");
          }
          break;
        case "iteration-start":
          state.currentIteration = event.iteration;
          state.currentChecks = [];
          state.phase = "agent";
          logLine(`--- Iteration ${event.iteration}/${event.maxIterations} ---`);
          break;
        case "agent-start":
          state.phase = "agent";
          logLine("Agent coding...");
          break;
        case "agent-done":
          logLine(`Agent done (${formatDuration(event.durationMs)})`);
          break;
        case "verify-start":
          state.phase = "verify";
          state.changedFiles = event.changedFiles;
          state.currentChecks = [];
          logLine(`Verifying ${event.changedFiles.length} changed files...`);
          break;
        case "stage-start":
          state.currentStage = event.stage;
          break;
        case "stage-done":
          state.currentStage = undefined;
          state.currentChecks.push(event.result);
          logLine(
            `  ${event.result.stage}: ${event.result.passed ? "PASS" : "FAIL"} (${formatDuration(event.result.durationMs)})`,
          );
          break;
        case "verify-done": {
          state.phase = event.allPassed ? "done" : "agent";
          const iter: IterationResult = {
            iteration: event.iteration,
            agentDurationMs: 0,
            verifyDurationMs: 0,
            checks: event.checks,
            allPassed: event.allPassed,
            changedFiles: state.changedFiles,
          };
          state.completedIterations.push(iter);
          state.currentChecks = [];
          logLine(event.allPassed ? "All checks passed!" : "Checks failed — will retry");
          break;
        }
        case "stall-warning":
          state.consecutiveStalls = event.consecutiveStalls;
          if (event.consecutiveStalls >= event.stallLimit) {
            state.phase = "stalled";
          }
          logLine(`Stall detected: ${event.consecutiveStalls}/${event.stallLimit}`);
          break;
        case "video-start":
          state.phase = "video";
          logLine("Capturing video proof...");
          break;
        case "video-done":
          logLine(
            `Video: ${event.result.passed ? "PASS" : "FAIL"} (${formatDuration(event.result.durationMs)})`,
          );
          break;
        case "done":
          state.finalResult = event.result;
          state.phase = event.result.ok ? "done" : "failed";
          logLine(
            event.result.ok
              ? `Done: ALL PASS (${formatDuration(event.result.totalDurationMs)})`
              : `Done: FAILED after ${event.result.iterations.length} iterations (${formatDuration(event.result.totalDurationMs)})`,
          );
          break;
        case "error":
          state.phase = "failed";
          logLine(`Error: ${event.error}`);
          break;
      }
      render();
    },
  };
}
