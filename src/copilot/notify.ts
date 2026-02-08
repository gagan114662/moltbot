/**
 * macOS desktop notifications for the copilot daemon.
 *
 * Only fires on failure transitions (pass → fail) to avoid spam.
 * Silently no-ops on non-macOS platforms.
 */

import { execFile } from "node:child_process";

let lastWasOk = true;

/**
 * Send a notification only if this is a new failure (transition from ok → not ok).
 * Prevents notification spam during extended debugging sessions.
 */
export function notifyIfNewFailure(ok: boolean, summary: string): void {
  if (ok) {
    lastWasOk = true;
    return;
  }

  // Only notify on transition from passing to failing
  if (!lastWasOk) {
    return;
  }

  lastWasOk = false;
  sendNotification({
    title: "Copilot: Verification Failed",
    message: summary.split("\n")[0] ?? "Checks failed",
    sound: "Basso",
  });
}

/** Send a notification unconditionally */
export function sendNotification(opts: {
  title: string;
  message: string;
  subtitle?: string;
  sound?: string;
}): void {
  if (process.platform !== "darwin") {
    return;
  }

  // Escape double quotes in all string fields
  const esc = (s: string) => s.replace(/"/g, '\\"');

  let script = `display notification "${esc(opts.message)}" with title "${esc(opts.title)}"`;
  if (opts.subtitle) {
    script += ` subtitle "${esc(opts.subtitle)}"`;
  }
  if (opts.sound) {
    script += ` sound name "${esc(opts.sound)}"`;
  }

  execFile("osascript", ["-e", script], { timeout: 5000 }, () => {
    // Fire and forget
  });
}
