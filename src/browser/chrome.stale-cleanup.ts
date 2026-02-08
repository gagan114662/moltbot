/**
 * Track Chrome PIDs we launch and clean up stale headless Chrome processes on startup.
 *
 * Problem: if the gateway crashes or is force-killed, Chrome child processes become
 * orphans. On macOS these prevent normal Chrome.app from opening because
 * LaunchServices sees Chrome is "already running" and tries to activate the
 * headless instance (which has no GUI).
 *
 * Solution: write PIDs to a file when we launch Chrome, remove them on clean stop,
 * and kill any stale tracked PIDs on startup.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";

const log = createSubsystemLogger("browser").child("cleanup");
const PID_FILE = path.join(CONFIG_DIR, "browser", ".chrome-pids");

function readTrackedPids(): number[] {
  try {
    return fs
      .readFileSync(PID_FILE, "utf-8")
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => !Number.isNaN(n) && n > 0);
  } catch {
    return [];
  }
}

function writeTrackedPids(pids: number[]): void {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  if (pids.length === 0) {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
    return;
  }
  fs.writeFileSync(PID_FILE, pids.join("\n") + "\n", "utf-8");
}

/** Record a Chrome PID we launched. */
export function trackChromePid(pid: number): void {
  const existing = readTrackedPids();
  if (!existing.includes(pid)) {
    existing.push(pid);
    writeTrackedPids(existing);
  }
}

/** Remove a Chrome PID after clean shutdown. */
export function untrackChromePid(pid: number): void {
  const existing = readTrackedPids().filter((p) => p !== pid);
  writeTrackedPids(existing);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill tracked Chrome PIDs that are still running (orphans from crashed runs).
 * Also scan for orphaned puppeteer headless Chrome processes that moltbot's
 * MCP server may have left behind.
 */
export function cleanStaleBrowserProcesses(): number {
  let killed = 0;

  // 1. Kill tracked PIDs from our own launchOpenClawChrome() calls.
  const tracked = readTrackedPids();
  for (const pid of tracked) {
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
        killed++;
        log.info(`Killed stale tracked Chrome process (PID ${pid})`);
      } catch {
        // ignore
      }
    }
  }
  // Clear the PID file since we're starting fresh.
  writeTrackedPids([]);

  // 2. Scan for orphaned headless Chrome with puppeteer temp profiles.
  //    These come from @anthropic-ai/mcp-server-puppeteer and are never tracked
  //    in our PID file.
  if (process.platform === "darwin" || process.platform === "linux") {
    try {
      const psOutput = execSync("ps -eo pid,args 2>/dev/null || true", {
        encoding: "utf-8",
        timeout: 5000,
      });
      for (const line of psOutput.split("\n")) {
        if (!line.includes("--headless") || !line.includes("puppeteer_dev_chrome_profile")) {
          continue;
        }
        // Only match the main Chrome process line (not helpers/renderers
        // — killing the main process cascades to children).
        const match = line.trim().match(/^(\d+)\s/);
        if (!match) {
          continue;
        }
        const pid = Number.parseInt(match[1], 10);
        if (Number.isNaN(pid) || pid <= 0) {
          continue;
        }
        // Skip if this is the main Chrome entry (has about:blank arg)
        // or a helper — we only need to kill the parent process.
        if (line.includes("--type=")) {
          continue;
        }
        try {
          process.kill(pid, "SIGKILL");
          killed++;
          log.info(`Killed orphaned puppeteer Chrome process (PID ${pid})`);
        } catch {
          // ignore (race: already exited)
        }
      }
    } catch {
      // ps failed — not critical
    }
  }

  if (killed > 0) {
    log.info(`Cleaned up ${killed} stale Chrome process(es) from previous run`);
  }
  return killed;
}
