/**
 * Goal Runner
 *
 * Executes autonomous goal-driven work during heartbeat intervals.
 * Selects the next goal, runs a work session, and updates progress.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { GoalWorkConfig } from "../config/types.agent-defaults.ts";
import type { Goal, GoalWorkResult, GoalsFile, GoalRunnerContext, ProgressEntry } from "./types.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { resolveUserTimezone } from "../agents/date-time.js";
import { runWithModelFallback } from "../agents/model-fallback.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  parseGoalsFile,
  selectNextGoal,
  serializeGoalsFile,
  updateGoalProgress,
  markSubtasksCompleted,
} from "./parser.js";

// Video proof capture types (from feedback-loop extension)
type VideoProofCaptureFn = (opts: {
  workspaceDir: string;
  mode?: "fast" | "full";
  appUrl?: string;
}) => Promise<{ ok: boolean; videoPath?: string; screenshots?: string[]; error?: string }>;

let captureVideoProof: VideoProofCaptureFn | null = null;

// Lazy load video proof to avoid compile-time rootDir issues
async function loadVideoProofCapture(): Promise<VideoProofCaptureFn | null> {
  if (captureVideoProof) {
    return captureVideoProof;
  }
  try {
    // Dynamic import at runtime - path resolved relative to dist/
    const modPath = new URL("../../extensions/feedback-loop/src/video-proof.js", import.meta.url)
      .pathname;
    const mod = await import(modPath);
    captureVideoProof = mod.captureVideoProof;
    return captureVideoProof;
  } catch {
    return null;
  }
}

const log = createSubsystemLogger("goals/runner");

const DEFAULT_GOALS_FILENAME = "GOALS.md";
const DEFAULT_PROGRESS_FILENAME = "PROGRESS.md";
const DEFAULT_WORK_INTERVAL = "30m";
const DEFAULT_MAX_WORK_DURATION = "10m";
const DEFAULT_MAX_WORK_DURATION_MS = 10 * 60 * 1000;

// ============================================
// CONFIGURATION
// ============================================

/**
 * Resolve goal work configuration for an agent
 */
export function resolveGoalWorkConfig(
  cfg: OpenClawConfig,
  _agentId?: string,
): GoalWorkConfig | undefined {
  return cfg.agents?.defaults?.goals;
}

/**
 * Check if goal work is enabled for an agent
 */
export function isGoalWorkEnabled(cfg: OpenClawConfig, agentId?: string): boolean {
  const goalsCfg = resolveGoalWorkConfig(cfg, agentId);
  return goalsCfg?.enabled === true;
}

/**
 * Resolve goal work interval in milliseconds
 */
export function resolveGoalWorkIntervalMs(
  cfg: OpenClawConfig,
  goalsCfg?: GoalWorkConfig,
): number | null {
  const raw =
    goalsCfg?.workInterval ?? cfg.agents?.defaults?.goals?.workInterval ?? DEFAULT_WORK_INTERVAL;
  if (!raw) {
    return null;
  }
  try {
    const ms = parseDurationMs(raw.trim(), { defaultUnit: "m" });
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Resolve max work duration in milliseconds
 */
export function resolveMaxWorkDurationMs(cfg: OpenClawConfig, goalsCfg?: GoalWorkConfig): number {
  const raw =
    goalsCfg?.maxWorkDuration ??
    cfg.agents?.defaults?.goals?.maxWorkDuration ??
    DEFAULT_MAX_WORK_DURATION;
  if (!raw) {
    return DEFAULT_MAX_WORK_DURATION_MS;
  }
  try {
    const ms = parseDurationMs(raw.trim(), { defaultUnit: "m" });
    return ms > 0 ? ms : DEFAULT_MAX_WORK_DURATION_MS;
  } catch {
    return DEFAULT_MAX_WORK_DURATION_MS;
  }
}

// ============================================
// QUIET HOURS
// ============================================

const TIME_PATTERN = /^([01]\d|2[0-3]|24):([0-5]\d)$/;

function parseTimeToMinutes(raw?: string, allow24 = false): number | null {
  if (!raw || !TIME_PATTERN.test(raw)) {
    return null;
  }
  const [hourStr, minuteStr] = raw.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  if (hour === 24) {
    if (!allow24 || minute !== 0) {
      return null;
    }
    return 24 * 60;
  }
  return hour * 60 + minute;
}

function resolveQuietHoursTimezone(cfg: OpenClawConfig, raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "user") {
    return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  }
  if (trimmed === "local") {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return host?.trim() || "UTC";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  }
}

function resolveMinutesInTimeZone(nowMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    const hour = Number(map.hour);
    const minute = Number(map.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * Check if currently within quiet hours (when goal work should not run)
 */
export function isWithinQuietHours(
  cfg: OpenClawConfig,
  goalsCfg?: GoalWorkConfig,
  nowMs?: number,
): boolean {
  const quietHours = goalsCfg?.quietHours;
  if (!quietHours) {
    return false;
  }

  const startMin = parseTimeToMinutes(quietHours.start, false);
  const endMin = parseTimeToMinutes(quietHours.end, true);
  if (startMin === null || endMin === null) {
    return false;
  }
  if (startMin === endMin) {
    return false;
  }

  const timeZone = resolveQuietHoursTimezone(cfg, quietHours.timezone);
  const currentMin = resolveMinutesInTimeZone(nowMs ?? Date.now(), timeZone);
  if (currentMin === null) {
    return false;
  }

  // Handle overnight ranges (e.g., 22:00 to 08:00)
  if (endMin < startMin) {
    return currentMin >= startMin || currentMin < endMin;
  }
  return currentMin >= startMin && currentMin < endMin;
}

// ============================================
// GOALS FILE I/O
// ============================================

/**
 * Resolve the path to GOALS.md for an agent
 */
export function resolveGoalsFilePath(cfg: OpenClawConfig, agentId?: string): string {
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolvedAgentId);
  return path.join(workspaceDir, DEFAULT_GOALS_FILENAME);
}

/**
 * Resolve the path to PROGRESS.md for an agent
 */
export function resolveProgressFilePath(cfg: OpenClawConfig, agentId?: string): string {
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolvedAgentId);
  return path.join(workspaceDir, DEFAULT_PROGRESS_FILENAME);
}

/**
 * Load and parse GOALS.md
 */
export async function loadGoalsFile(
  cfg: OpenClawConfig,
  agentId?: string,
): Promise<GoalsFile | null> {
  const filePath = resolveGoalsFilePath(cfg, agentId);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return parseGoalsFile(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Save GOALS.md
 */
export async function saveGoalsFile(
  cfg: OpenClawConfig,
  goalsFile: GoalsFile,
  agentId?: string,
): Promise<void> {
  const filePath = resolveGoalsFilePath(cfg, agentId);
  const content = serializeGoalsFile(goalsFile);
  await fs.writeFile(filePath, content, "utf-8");
}

// ============================================
// PROGRESS TRACKING
// ============================================

/**
 * Append a progress entry to PROGRESS.md
 */
export async function appendProgressEntry(
  cfg: OpenClawConfig,
  entry: ProgressEntry,
  agentId?: string,
): Promise<void> {
  const filePath = resolveProgressFilePath(cfg, agentId);

  let content = "";
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // Create new file with header
    content = `# PROGRESS\n\nGoal work session history.\n\n---\n\n`;
  }

  const entryText = formatProgressEntry(entry);
  content += entryText;

  await fs.writeFile(filePath, content, "utf-8");
}

function formatProgressEntry(entry: ProgressEntry): string {
  const lines: string[] = [];
  lines.push(`## ${entry.timestamp}`);
  lines.push(`- **Goal:** ${entry.goalId}`);
  lines.push(`- **Action:** ${entry.action}`);
  lines.push(`- **Summary:** ${entry.summary}`);
  if (entry.progressAfter !== undefined) {
    lines.push(`- **Progress:** ${entry.progressAfter}%`);
  }
  if (entry.filesChanged && entry.filesChanged.length > 0) {
    lines.push(`- **Files Changed:** ${entry.filesChanged.join(", ")}`);
  }
  if (entry.videoProof) {
    lines.push(`- **Video Proof:** ${entry.videoProof}`);
  }
  if (entry.screenshots && entry.screenshots.length > 0) {
    lines.push(`- **Screenshots:** ${entry.screenshots.join(", ")}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

// ============================================
// GOAL WORK EXECUTION
// ============================================

/**
 * Build the prompt for working on a goal
 */
function buildGoalWorkPrompt(goal: Goal, _goalsFile: GoalsFile): string {
  const lines: string[] = [];

  lines.push(`You are working autonomously on a goal. Work toward completing this goal.`);
  lines.push("");
  lines.push(`## Current Goal`);
  lines.push(`**${goal.title}** [${goal.priority}]`);
  lines.push("");
  lines.push(`**Context:** ${goal.context}`);
  lines.push(`**Progress:** ${goal.progress}%`);
  lines.push(`**Status:** ${goal.status}`);

  if (goal.deadline) {
    lines.push(`**Deadline:** ${goal.deadline}`);
  }

  if (goal.successCriteria.length > 0) {
    lines.push("");
    lines.push(`### Success Criteria`);
    for (const criterion of goal.successCriteria) {
      const mark = criterion.completed ? "x" : " ";
      lines.push(`- [${mark}] ${criterion.text}`);
    }
  }

  if (goal.subtasks.length > 0) {
    lines.push("");
    lines.push(`### Subtasks`);
    for (const subtask of goal.subtasks) {
      const mark = subtask.completed ? "x" : " ";
      lines.push(`- [${mark}] ${subtask.text}`);
    }

    const nextSubtask = goal.subtasks.find((s) => !s.completed);
    if (nextSubtask) {
      lines.push("");
      lines.push(`**Next subtask to work on:** ${nextSubtask.text}`);
    }
  }

  lines.push("");
  lines.push(`## Instructions`);
  lines.push(`1. Work on the next incomplete subtask or success criterion`);
  lines.push(`2. Make concrete progress - write code, run tests, fix issues`);
  lines.push(`3. When done, respond with a JSON summary of your work:`);
  lines.push("");
  lines.push("```json");
  lines.push(`{`);
  lines.push(`  "status": "worked" | "blocked" | "completed",`);
  lines.push(`  "summary": "Brief description of what you did",`);
  lines.push(`  "subtasksCompleted": ["subtask text if completed"],`);
  lines.push(`  "filesChanged": ["path/to/file.ts"],`);
  lines.push(`  "blockers": ["reason if blocked"],`);
  lines.push(`  "nextSteps": ["suggested next actions"]`);
  lines.push(`}`);
  lines.push("```");
  lines.push("");
  lines.push(`Focus on making incremental progress. If blocked, report the blocker and move on.`);

  return lines.join("\n");
}

/**
 * Parse the work result from the agent's response
 */
function parseWorkResult(response: string, goal: Goal, startMs: number): GoalWorkResult {
  const durationMs = Date.now() - startMs;

  // Try to extract JSON from the response
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!jsonMatch) {
    // No JSON found - treat as worked with the response as summary
    return {
      goalId: goal.id,
      status: "worked",
      progressDelta: 5,
      newProgress: Math.min(100, goal.progress + 5),
      summary: response.slice(0, 500),
      durationMs,
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    const status = parsed.status ?? "worked";
    const summary = parsed.summary ?? "Work completed";
    const subtasksCompleted = parsed.subtasksCompleted ?? [];
    const filesChanged = parsed.filesChanged ?? [];
    const blockers = parsed.blockers ?? [];
    const nextSteps = parsed.nextSteps ?? [];

    // Calculate progress delta based on subtasks completed
    let progressDelta = 0;
    if (status === "completed") {
      progressDelta = 100 - goal.progress;
    } else if (subtasksCompleted.length > 0 && goal.subtasks.length > 0) {
      const perSubtask = 100 / goal.subtasks.length;
      progressDelta = Math.round(perSubtask * subtasksCompleted.length);
    } else if (status === "worked") {
      progressDelta = 5; // Default small progress
    }

    return {
      goalId: goal.id,
      status: status as GoalWorkResult["status"],
      progressDelta,
      newProgress: Math.min(100, goal.progress + progressDelta),
      summary,
      subtasksCompleted,
      filesChanged,
      blockers: blockers.length > 0 ? blockers : undefined,
      nextSteps: nextSteps.length > 0 ? nextSteps : undefined,
      durationMs,
    };
  } catch {
    // JSON parse failed - treat as worked
    return {
      goalId: goal.id,
      status: "worked",
      progressDelta: 5,
      newProgress: Math.min(100, goal.progress + 5),
      summary: response.slice(0, 500),
      durationMs,
    };
  }
}

/**
 * Run a work session on a goal
 */
async function runGoalWorkSession(
  cfg: OpenClawConfig,
  goal: Goal,
  goalsFile: GoalsFile,
  context: GoalRunnerContext,
): Promise<GoalWorkResult> {
  const startMs = Date.now();
  const prompt = buildGoalWorkPrompt(goal, goalsFile);

  const ctx = {
    Body: prompt,
    From: "goal-runner",
    To: "goal-runner",
    Provider: "goal-work",
    SessionKey: context.sessionKey,
  };

  try {
    // Resolve primary model so we can use the fallback chain on 429s
    const primaryRef = resolveConfiguredModelRef({
      cfg,
      defaultProvider: "google-antigravity",
      defaultModel: "claude-opus-4-5-thinking",
    });
    const agentId = normalizeAgentId(
      context.sessionKey.split(":")[0] || resolveDefaultAgentId(cfg),
    );

    const { result: replyResult } = await runWithModelFallback({
      cfg,
      provider: primaryRef?.provider ?? "google-antigravity",
      model: primaryRef?.model ?? "claude-opus-4-5-thinking",
      agentDir: resolveAgentDir(cfg, agentId),
      run: async () => {
        return getReplyFromConfig(ctx, { isHeartbeat: false }, cfg);
      },
      onError: async ({ provider, model, attempt, total }) => {
        log.info(
          `Goal work model fallback: ${provider}/${model} failed (attempt ${attempt}/${total})`,
          { goalId: goal.id },
        );
      },
    });

    const response = Array.isArray(replyResult)
      ? replyResult.map((r) => r.text).join("\n")
      : (replyResult?.text ?? "");

    return parseWorkResult(response, goal, startMs);
  } catch (err) {
    log.error("Goal work session failed", { error: String(err), goalId: goal.id });
    return {
      goalId: goal.id,
      status: "error",
      progressDelta: 0,
      newProgress: goal.progress,
      summary: "Work session failed",
      error: String(err),
      durationMs: Date.now() - startMs,
    };
  }
}

// ============================================
// MAIN RUNNER
// ============================================

export type GoalRunResult = {
  status: "ran" | "skipped" | "error";
  reason?: string;
  goalId?: string;
  workResult?: GoalWorkResult;
  durationMs?: number;
};

/**
 * Run goal work once for an agent
 */
export async function runGoalWorkOnce(opts: {
  cfg?: OpenClawConfig;
  agentId?: string;
  nowMs?: number;
}): Promise<GoalRunResult> {
  const cfg = opts.cfg ?? loadConfig();
  const agentId = normalizeAgentId(opts.agentId ?? resolveDefaultAgentId(cfg));
  const goalsCfg = resolveGoalWorkConfig(cfg, agentId);

  // Check if goals are enabled
  if (!isGoalWorkEnabled(cfg, agentId)) {
    return { status: "skipped", reason: "disabled" };
  }

  // Check quiet hours
  if (isWithinQuietHours(cfg, goalsCfg, opts.nowMs)) {
    return { status: "skipped", reason: "quiet-hours" };
  }

  // Load goals file
  const goalsFile = await loadGoalsFile(cfg, agentId);
  if (!goalsFile) {
    return { status: "skipped", reason: "no-goals-file" };
  }

  // Check for in-file config override
  const fileConfig = goalsFile.config?.autonomous;
  if (fileConfig?.enabled === false) {
    return { status: "skipped", reason: "disabled-in-file" };
  }

  // Select next goal to work on
  const nextGoal = selectNextGoal(goalsFile.activeGoals);
  if (!nextGoal) {
    return { status: "skipped", reason: "no-workable-goals" };
  }

  log.info("Starting goal work session", { goalId: nextGoal.id, title: nextGoal.title });

  // Build runner context
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const maxWorkDurationMs = resolveMaxWorkDurationMs(cfg, goalsCfg);
  const context: GoalRunnerContext = {
    agentId,
    sessionKey: `goal-work-${agentId}`,
    workspaceDir,
    maxWorkDurationMs,
    model: goalsCfg?.model,
  };

  // Run work session
  const workResult = await runGoalWorkSession(cfg, nextGoal, goalsFile, context);

  // Update goal progress
  let updatedGoalsFile = goalsFile;
  if (workResult.subtasksCompleted && workResult.subtasksCompleted.length > 0) {
    const updatedGoal = markSubtasksCompleted(nextGoal, workResult.subtasksCompleted);
    updatedGoalsFile = updateGoalProgress(goalsFile, nextGoal.id, {
      progress: updatedGoal.progress,
      subtasks: updatedGoal.subtasks,
      status:
        workResult.status === "completed"
          ? "completed"
          : workResult.status === "blocked"
            ? "blocked"
            : "in_progress",
    });
  } else {
    updatedGoalsFile = updateGoalProgress(goalsFile, nextGoal.id, {
      progress: workResult.newProgress,
      status:
        workResult.status === "completed"
          ? "completed"
          : workResult.status === "blocked"
            ? "blocked"
            : "in_progress",
    });
  }

  // Save updated goals
  await saveGoalsFile(cfg, updatedGoalsFile, agentId);

  // Capture video proof if enabled
  let videoProofPath: string | undefined;
  let screenshotPaths: string[] | undefined;
  const videoProofCfg = goalsCfg?.videoProof;
  if (videoProofCfg?.enabled && workResult.status !== "error") {
    log.info("Capturing video proof...", { goalId: nextGoal.id });
    const capture = await loadVideoProofCapture();
    if (capture) {
      const proofResult = await capture({
        workspaceDir,
        mode: videoProofCfg.mode ?? "fast",
        appUrl: videoProofCfg.appUrl,
      });
      if (proofResult.ok) {
        videoProofPath = proofResult.videoPath;
        screenshotPaths = proofResult.screenshots;
        log.info("Video proof captured", { videoPath: videoProofPath });
      } else {
        log.warn("Video proof capture failed", { error: proofResult.error });
      }
    } else {
      log.warn("Video proof module not available");
    }
  }

  // Append progress entry
  const progressEntry: ProgressEntry = {
    timestamp: new Date().toISOString(),
    goalId: nextGoal.id,
    action: workResult.status,
    summary: workResult.summary,
    filesChanged: workResult.filesChanged,
    progressAfter: workResult.newProgress,
    videoProof: videoProofPath,
    screenshots: screenshotPaths,
  };
  await appendProgressEntry(cfg, progressEntry, agentId);

  log.info("Goal work session completed", {
    goalId: nextGoal.id,
    status: workResult.status,
    progressDelta: workResult.progressDelta,
    durationMs: workResult.durationMs,
    hasVideoProof: Boolean(videoProofPath),
  });

  return {
    status: "ran",
    goalId: nextGoal.id,
    workResult,
    durationMs: workResult.durationMs,
  };
}

/**
 * Check if goal work should run based on interval
 */
export function shouldRunGoalWork(
  cfg: OpenClawConfig,
  lastRunMs: number | undefined,
  nowMs?: number,
): boolean {
  const goalsCfg = resolveGoalWorkConfig(cfg);
  if (!isGoalWorkEnabled(cfg)) {
    return false;
  }

  const intervalMs = resolveGoalWorkIntervalMs(cfg, goalsCfg);
  if (!intervalMs) {
    return false;
  }

  if (lastRunMs === undefined) {
    return true;
  }

  const now = nowMs ?? Date.now();
  return now - lastRunMs >= intervalMs;
}
