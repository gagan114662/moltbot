/**
 * Send text into a tmux pane as keyboard input.
 *
 * Just tries `tmux send-keys` and logs on failure — no pre-check needed.
 * If tmux isn't installed, the session doesn't exist, or the pane is gone,
 * it returns false and logs a verbose warning.
 */

import { execFileSync } from "node:child_process";
import { logVerbose } from "../globals.js";

/** Default tmux target for QA nudges */
export const DEFAULT_TMUX_TARGET = "moltbot:0.0";

/**
 * Send text into a tmux pane via `tmux send-keys`.
 * Returns true if sent, false if tmux unavailable or pane doesn't exist.
 */
export function tmuxSendKeys(target: string, text: string): boolean {
  try {
    execFileSync("tmux", ["send-keys", "-t", target, text, "Enter"], {
      timeout: 5000,
      stdio: "ignore",
    });
    return true;
  } catch (err) {
    logVerbose(`tmux send-keys failed for ${target}: ${String(err)}`);
    return false;
  }
}
