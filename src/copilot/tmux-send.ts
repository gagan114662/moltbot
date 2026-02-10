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
