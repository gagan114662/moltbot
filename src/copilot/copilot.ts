/**
 * Main copilot daemon entry point.
 *
 * Wires together: watcher → pipeline → dashboard → feedback → notify.
 * Handles lifecycle (PID file, signal handling, graceful shutdown).
 */

import type { CopilotConfig } from "./types.js";
import { createDashboard } from "./dashboard.js";
import { isPidAlive, readPid, removeFeedback, removePid, writePid } from "./feedback.js";
import { notifyIfNewFailure } from "./notify.js";
import { createPipeline } from "./pipeline.js";
import { createWatcher } from "./watcher.js";

export type CopilotStatus = {
  running: boolean;
  pid?: number;
};

/** Check if a copilot is already running */
export function getCopilotStatus(cwd: string): CopilotStatus {
  const pid = readPid(cwd);
  if (pid === null) {
    return { running: false };
  }
  if (isPidAlive(pid)) {
    return { running: true, pid };
  }
  // Stale PID file — clean up
  removePid(cwd);
  return { running: false };
}

/** Stop a running copilot by sending SIGTERM to its PID */
export function stopCopilot(cwd: string): boolean {
  const pid = readPid(cwd);
  if (pid === null) {
    return false;
  }
  if (!isPidAlive(pid)) {
    removePid(cwd);
    void removeFeedback(cwd);
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** Start the copilot daemon (foreground, blocks until stopped) */
export async function startCopilot(config: CopilotConfig): Promise<void> {
  // Check for existing instance
  const status = getCopilotStatus(config.cwd);
  if (status.running) {
    throw new Error(
      `Copilot already running (PID ${status.pid}). Run 'openclaw copilot stop' first.`,
    );
  }

  // Write PID file
  writePid(config.cwd);

  // Set up dashboard
  const dashboard = createDashboard();

  // Set up pipeline
  const pipeline = createPipeline({
    config,
    onEvent(event) {
      dashboard.handleEvent(event);

      // Send notifications on failure transitions
      if (!config.noNotify && event.type === "done") {
        notifyIfNewFailure(event.feedback.ok, event.feedback.summary);
      }
    },
  });

  // Set up watcher
  const watcher = createWatcher({
    cwd: config.cwd,
    debounceMs: config.debounceMs,
    onEvent(event) {
      pipeline.handleEvent(event);
    },
  });

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    dashboard.stopAutoRefresh();
    pipeline.stop();
    await watcher.stop();
    removePid(config.cwd);
    await removeFeedback(config.cwd);

    process.stderr.write("\nCopilot stopped.\n");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Start everything
  watcher.start();
  dashboard.startAutoRefresh();

  // Update watched count after watcher initializes
  setTimeout(() => {
    dashboard.setWatchedCount(watcher.watchedCount());
    dashboard.render();
  }, 2000);

  // Keep process alive
  await new Promise(() => {
    // Intentionally never resolves — copilot runs until killed
  });
}
