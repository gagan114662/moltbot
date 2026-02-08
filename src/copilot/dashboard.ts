/**
 * Terminal dashboard for the copilot daemon.
 *
 * Renders a live status view using ANSI escape codes.
 * Falls back to simple log lines when not running in a TTY.
 * Uses the project's theme colors from src/terminal/theme.ts.
 */

import type { DashboardState, PipelineEvent, StageResult } from "./types.js";
import { theme } from "../terminal/theme.js";

const isTTY = process.stderr.isTTY ?? false;

/** ANSI: move cursor to top-left and clear screen below */
const CLEAR = "\x1b[H\x1b[J";

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s ago`;
}

function formatUptime(startedAt: Date): string {
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

function renderChecksTable(checks: StageResult[]): string {
  if (checks.length === 0) {
    return theme.muted("  No checks run yet");
  }

  const lines: string[] = [];
  for (const check of checks) {
    const status = stageIcon(check);
    const duration = formatDuration(check.durationMs);
    const files = check.files?.length ? theme.muted(`${check.files.length} files`) : "";
    lines.push(`  ${check.stage.padEnd(14)} ${status}   ${duration.padEnd(8)} ${files}`);
  }
  return lines.join("\n");
}

function renderFailedOutput(checks: StageResult[]): string {
  const failed = checks.filter((c) => !c.passed && c.error);
  if (failed.length === 0) {
    return "";
  }

  const lines: string[] = ["", `  ${theme.error("--- Failed Output ---")}`];

  for (const check of failed) {
    if (check.error) {
      // Show first 8 lines of error
      const errorLines = check.error.split("\n").slice(0, 8);
      for (const line of errorLines) {
        lines.push(`  ${theme.muted(line)}`);
      }
      if (check.error.split("\n").length > 8) {
        lines.push(theme.muted(`  ... (${check.error.split("\n").length - 8} more lines)`));
      }
    }
  }

  return lines.join("\n");
}

function renderTriggerFiles(files: string[]): string {
  if (files.length === 0) {
    return "";
  }

  const shown = files.slice(0, 5);
  const lines: string[] = ["", `  ${theme.muted("--- Trigger Files ---")}`];
  for (const file of shown) {
    lines.push(`  ${theme.muted(file)}`);
  }
  if (files.length > 5) {
    lines.push(theme.muted(`  ... +${files.length - 5} more`));
  }
  return lines.join("\n");
}

/** Render the full dashboard to a string */
export function renderDashboard(state: DashboardState): string {
  const lines: string[] = [];

  // Header
  lines.push(
    `  ${theme.heading("Copilot")}  watching ${state.watchedFiles} files  |  uptime ${formatUptime(state.startedAt)}`,
  );
  lines.push("");

  // Status
  let statusText: string;
  if (state.status === "running" && state.currentStage) {
    statusText = theme.warn(`Running: ${state.currentStage}...`);
  } else if (state.status === "cancelled") {
    statusText = theme.muted("Cancelled (new changes detected)");
  } else {
    statusText = theme.success("Idle (watching for changes)");
  }
  lines.push(`  Status   ${statusText}`);

  if (state.lastOkAt) {
    lines.push(
      `  Last OK  ${state.lastOkAt.toLocaleTimeString()} (${formatTimeAgo(state.lastOkAt)})`,
    );
  }
  lines.push("");

  // Checks table
  if (state.lastRun) {
    lines.push(`  ${theme.muted("--- Recent Checks ---")}`);
    lines.push(renderChecksTable(state.lastRun.checks));

    // Show skipped stages
    const ranStages = new Set(state.lastRun.checks.map((c) => c.stage));
    const allStages = ["lint", "typecheck", "test", "build", "video"];
    for (const stage of allStages) {
      if (!ranStages.has(stage)) {
        lines.push(
          `  ${stage.padEnd(14)} ${theme.muted("SKIP")}   ${theme.muted("-")}         ${theme.muted("(commit-only or disabled)")}`,
        );
      }
    }

    // Failed output
    lines.push(renderFailedOutput(state.lastRun.checks));
  }

  // Trigger files
  lines.push(renderTriggerFiles(state.triggerFiles));

  return lines.join("\n");
}

/** Create a dashboard controller that manages rendering */
export function createDashboard(): {
  state: DashboardState;
  render(): void;
  handleEvent(event: PipelineEvent): void;
  setWatchedCount(count: number): void;
  startAutoRefresh(): void;
  stopAutoRefresh(): void;
} {
  const state: DashboardState = {
    watchedFiles: 0,
    startedAt: new Date(),
    status: "idle",
    triggerFiles: [],
  };

  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  function render() {
    if (isTTY) {
      process.stderr.write(CLEAR + renderDashboard(state) + "\n");
    }
  }

  function logLine(message: string) {
    if (!isTTY) {
      const ts = new Date().toLocaleTimeString();
      process.stderr.write(`[${ts}] ${message}\n`);
    }
  }

  return {
    state,

    render,

    setWatchedCount(count: number) {
      state.watchedFiles = count;
    },

    handleEvent(event: PipelineEvent) {
      switch (event.type) {
        case "start":
          state.status = "running";
          state.triggerFiles = event.triggerFiles;
          logLine(
            `Pipeline started (${event.triggerFiles.length} files, commit: ${event.isCommit})`,
          );
          break;
        case "stage-start":
          state.currentStage = event.stage;
          logLine(`Stage: ${event.stage}`);
          break;
        case "stage-done":
          state.currentStage = undefined;
          logLine(
            `  ${event.result.stage}: ${event.result.passed ? "PASS" : "FAIL"} (${formatDuration(event.result.durationMs)})`,
          );
          break;
        case "done":
          state.status = "idle";
          state.lastRun = event.feedback;
          if (event.feedback.ok) {
            state.lastOkAt = new Date();
          }
          logLine(
            `Pipeline done: ${event.feedback.ok ? "ALL PASS" : "FAILED"} (${formatDuration(event.feedback.durationMs)})`,
          );
          break;
        case "cancelled":
          state.status = "idle";
          logLine("Pipeline cancelled (new changes)");
          break;
        case "error":
          state.status = "idle";
          logLine(`Pipeline error: ${event.error}`);
          break;
      }
      render();
    },

    startAutoRefresh() {
      if (isTTY) {
        refreshInterval = setInterval(render, 1000);
      }
    },

    stopAutoRefresh() {
      if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
      }
    },
  };
}
