import { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", () => ({
  CONFIG_DIR: "/tmp/openclaw-stale-cleanup-test",
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  }),
}));

import {
  trackChromePid,
  untrackChromePid,
  cleanStaleBrowserProcesses,
} from "./chrome.stale-cleanup.js";

const PID_DIR = "/tmp/openclaw-stale-cleanup-test/browser";
const PID_FILE = path.join(PID_DIR, ".chrome-pids");

beforeEach(() => {
  fs.mkdirSync(PID_DIR, { recursive: true });
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
});

afterEach(() => {
  try {
    fs.rmSync("/tmp/openclaw-stale-cleanup-test", { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("trackChromePid / untrackChromePid", () => {
  it("writes and removes PIDs", () => {
    trackChromePid(1234);
    trackChromePid(5678);
    expect(fs.readFileSync(PID_FILE, "utf-8").trim().split("\n").map(Number)).toEqual([1234, 5678]);

    untrackChromePid(1234);
    expect(fs.readFileSync(PID_FILE, "utf-8").trim().split("\n").map(Number)).toEqual([5678]);

    untrackChromePid(5678);
    // File should be removed when empty
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  it("does not duplicate PIDs", () => {
    trackChromePid(42);
    trackChromePid(42);
    expect(fs.readFileSync(PID_FILE, "utf-8").trim().split("\n")).toEqual(["42"]);
  });
});

describe("cleanStaleBrowserProcesses", () => {
  it("kills tracked PIDs that are still alive", async () => {
    // Spawn a sleep process to act as a "stale Chrome"
    const child = require("node:child_process").spawn("sleep", ["60"], {
      stdio: "ignore",
      detached: true,
    }) as ChildProcess;
    const pid = child.pid!;

    trackChromePid(pid);
    expect(fs.existsSync(PID_FILE)).toBe(true);

    const killed = cleanStaleBrowserProcesses();
    expect(killed).toBeGreaterThanOrEqual(1);

    // PID file should be cleared
    expect(fs.existsSync(PID_FILE)).toBe(false);

    // Wait briefly for SIGKILL to take effect, then verify process is dead
    await new Promise((r) => setTimeout(r, 100));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // expected — process is dead
    }
    expect(alive).toBe(false);
  });

  it("handles already-exited PIDs gracefully", () => {
    // Track a PID that doesn't exist
    trackChromePid(999999999);
    const killed = cleanStaleBrowserProcesses();
    // Should not crash, PID file should be cleared
    expect(fs.existsSync(PID_FILE)).toBe(false);
    expect(killed).toBe(0);
  });

  it("returns 0 when PID file is empty", () => {
    const killed = cleanStaleBrowserProcesses();
    expect(killed).toBe(0);
  });
});
