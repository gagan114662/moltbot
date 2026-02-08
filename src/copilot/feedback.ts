/**
 * Atomic read/write for copilot feedback file.
 *
 * Uses temp-file + rename for POSIX-atomic writes so the
 * enrich-prompt.sh hook never reads a partially-written file.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CopilotFeedback, StageResult } from "./types.js";

const FEEDBACK_DIR = ".moltbot";
const FEEDBACK_FILE = "copilot-feedback.json";
const PID_FILE = "copilot.pid";
const MAX_ERROR_LENGTH = 2000;

function feedbackDir(cwd: string): string {
  return path.join(cwd, FEEDBACK_DIR);
}

export function feedbackPath(cwd: string): string {
  return path.join(cwd, FEEDBACK_DIR, FEEDBACK_FILE);
}

export function pidPath(cwd: string): string {
  return path.join(cwd, FEEDBACK_DIR, PID_FILE);
}

function ensureDir(cwd: string): void {
  const dir = feedbackDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Atomic write: write to .tmp, then rename */
export async function writeFeedback(cwd: string, feedback: CopilotFeedback): Promise<void> {
  ensureDir(cwd);
  const target = feedbackPath(cwd);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(feedback, null, 2), "utf-8");
  await fsp.rename(tmp, target);
}

/** Read the current feedback file, or null if absent/corrupt */
export async function readFeedback(cwd: string): Promise<CopilotFeedback | null> {
  const target = feedbackPath(cwd);
  try {
    const raw = await fsp.readFile(target, "utf-8");
    return JSON.parse(raw) as CopilotFeedback;
  } catch {
    return null;
  }
}

/** Remove feedback file (called on copilot stop to prevent stale data) */
export async function removeFeedback(cwd: string): Promise<void> {
  try {
    await fsp.unlink(feedbackPath(cwd));
  } catch {
    // Already removed or never existed
  }
}

/** Write PID file for copilot stop/status */
export function writePid(cwd: string): void {
  ensureDir(cwd);
  fs.writeFileSync(pidPath(cwd), String(process.pid), "utf-8");
}

/** Read PID from file, or null if absent */
export function readPid(cwd: string): number | null {
  try {
    const raw = fs.readFileSync(pidPath(cwd), "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Remove PID file */
export function removePid(cwd: string): void {
  try {
    fs.unlinkSync(pidPath(cwd));
  } catch {
    // Already removed
  }
}

/** Check if a PID is still running */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Truncate error output to MAX_ERROR_LENGTH */
export function truncateError(error: string): string {
  if (error.length <= MAX_ERROR_LENGTH) {
    return error;
  }
  return `${error.slice(0, MAX_ERROR_LENGTH)}... (truncated)`;
}

/** Build human-readable summary from check results */
export function buildSummary(checks: StageResult[], durationMs: number): string {
  const failed = checks.filter((c) => !c.passed);
  if (failed.length === 0) {
    return `All ${checks.length} checks passed (${Math.round(durationMs / 1000)}s)`;
  }

  const lines = [
    `${failed.length}/${checks.length} checks failed (${Math.round(durationMs / 1000)}s):`,
  ];
  for (const check of failed) {
    const errorSnippet = check.error ? `: ${check.error.split("\n")[0]}` : "";
    lines.push(`- ${check.stage} FAILED (${Math.round(check.durationMs / 1000)}s)${errorSnippet}`);
  }
  return lines.join("\n");
}
