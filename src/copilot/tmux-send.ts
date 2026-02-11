/**
 * Send text into a tmux pane as keyboard input + poll for idle prompt.
 *
 * Just tries `tmux send-keys` and logs on failure — no pre-check needed.
 * If tmux isn't installed, the session doesn't exist, or the pane is gone,
 * it returns false and logs a verbose warning.
 */

import { execFileSync } from "node:child_process";
import { logVerbose } from "../globals.js";

/** Default tmux target for QA nudges */
export const DEFAULT_TMUX_TARGET = "scratchpad:0.0";

/** Matches Claude Code / shell idle prompts.
 *  Claude Code's TUI pads lines with invisible box-drawing chars so `$` anchors don't work.
 *  Match ❯/› anywhere in the line (Claude Code prompt), or >/$ at end for shells. */
export const DEFAULT_IDLE_PROMPT_RE = /❯|›|[>$]\s*$/;

/**
 * Send text into a tmux pane via `tmux send-keys`.
 * Returns true if sent, false if tmux unavailable or pane doesn't exist.
 */
export function tmuxSendKeys(target: string, text: string): boolean {
  try {
    // Send text literally (-l prevents tmux from interpreting key names in the text)
    execFileSync("tmux", ["send-keys", "-t", target, "-l", text], {
      timeout: 5000,
      stdio: "ignore",
    });
    // Send Enter as a separate keypress so it's always recognized
    execFileSync("tmux", ["send-keys", "-t", target, "Enter"], {
      timeout: 5000,
      stdio: "ignore",
    });
    return true;
  } catch (err) {
    logVerbose(`tmux send-keys failed for ${target}: ${String(err)}`);
    return false;
  }
}

/** Capture the current text content of a tmux pane. Returns null on error. */
export function tmuxCapture(target: string): string | null {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", target, "-p"], {
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch {
    return null;
  }
}

/**
 * Capture extended scrollback from a tmux pane.
 * Uses `-S -N` to get N lines of history (default 200).
 * Returns null on error.
 */
export function tmuxCaptureScrollback(target: string, lines = 200): string | null {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", target, "-p", "-S", `-${lines}`], {
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch {
    return null;
  }
}

/**
 * Poll a tmux pane until the last non-empty line matches an idle prompt.
 * Used to detect when Claude Code finishes working and returns to the input prompt.
 *
 * @returns true if idle detected, false on timeout
 */
export async function pollForTmuxIdle(
  target: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    idlePattern?: RegExp;
    /** Initial delay before polling starts (lets the process begin working) */
    graceMs?: number;
  } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 8 * 60_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const graceMs = opts.graceMs ?? 10_000;
  const pattern = opts.idlePattern ?? DEFAULT_IDLE_PROMPT_RE;

  // Wait for the process to start before polling
  await sleep(graceMs);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = tmuxCapture(target);
    if (output != null) {
      // Check last 15 non-empty lines — Claude Code's TUI has a multi-line status bar below the ❯ prompt
      const lines = output.split("\n").filter((l) => l.trim().length > 0);
      const tail = lines.slice(-15);
      if (tail.some((line) => pattern.test(line))) {
        return true;
      }
    }
    await sleep(intervalMs);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Claude state detection (idle vs plan-mode)
// ---------------------------------------------------------------------------

export type ClaudeState =
  | { state: "idle" }
  | { state: "plan-mode"; planContent: string }
  | { state: "working" };

/**
 * Detect Claude Code's current state from the tmux pane content.
 * - "idle" = at the ❯ prompt, waiting for input
 * - "plan-mode" = wrote a plan, waiting for approval (⏸ plan mode on)
 * - "working" = actively processing (neither idle nor plan-mode)
 */
export function detectClaudeState(
  target: string,
  idlePattern: RegExp = DEFAULT_IDLE_PROMPT_RE,
): ClaudeState {
  const output = tmuxCaptureScrollback(target, 100);
  if (output == null) {
    return { state: "working" };
  }

  const lines = output.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const tail = nonEmpty.slice(-20);

  // Check for plan mode indicator
  const hasPlanMode = tail.some((l) => l.includes("plan mode on") || l.includes("⏸ plan mode"));

  if (hasPlanMode) {
    // Extract plan content from scrollback — everything between plan-related content
    // and the status bar. Look for headers, bullet points, numbered items.
    const planLines: string[] = [];
    let inPlan = false;
    for (const line of nonEmpty) {
      const trimmed = line.trim();
      // Start capturing when we see plan-like content
      if (
        trimmed.startsWith("#") ||
        trimmed.startsWith("1.") ||
        trimmed.startsWith("- ") ||
        trimmed.startsWith("**")
      ) {
        inPlan = true;
      }
      // Stop at status bar
      if (trimmed.includes("plan mode on") || trimmed.includes("⏸")) {
        break;
      }
      if (inPlan) {
        planLines.push(trimmed);
      }
    }
    return { state: "plan-mode", planContent: planLines.join("\n").slice(0, 4000) };
  }

  // Check for idle prompt
  if (tail.some((line) => idlePattern.test(line))) {
    return { state: "idle" };
  }

  return { state: "working" };
}

/**
 * Enhanced idle polling that also detects plan-mode.
 * Returns the final Claude state when idle or plan-mode is detected.
 */
export async function pollForClaudeState(
  target: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    graceMs?: number;
    idlePattern?: RegExp;
  } = {},
): Promise<ClaudeState & { timedOut?: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 8 * 60_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const graceMs = opts.graceMs ?? 10_000;
  const pattern = opts.idlePattern ?? DEFAULT_IDLE_PROMPT_RE;

  await sleep(graceMs);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = detectClaudeState(target, pattern);
    if (state.state === "idle" || state.state === "plan-mode") {
      return state;
    }
    await sleep(intervalMs);
  }

  return { state: "working", timedOut: true };
}
