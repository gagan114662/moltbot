/**
 * File system + git commit watcher for the copilot daemon.
 *
 * Uses chokidar v5 with smart debounce. Watches for:
 * 1. File changes (save events) → triggers quick pipeline
 * 2. Git ref changes (commits) → triggers full pipeline
 *
 * IMPORTANT: .moltbot/ is always ignored to prevent infinite loops
 * (copilot writing feedback must NOT retrigger itself).
 */

import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import type { WatcherEvent } from "./types.js";

/** Directory names to ignore (prevents traversal into these dirs) */
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".moltbot",
  "coverage",
  "vendor",
  ".next",
  ".turbo",
  ".cache",
  "build",
]);

/** File names/patterns to ignore */
const IGNORED_FILES = new Set([".DS_Store", "pnpm-lock.yaml", ".bundle.hash"]);

/** Function-based ignore that prevents traversal into heavy dirs */
function isIgnored(filePath: string): boolean {
  const basename = path.basename(filePath);

  // Skip ignored directories entirely (prevents traversal)
  if (IGNORED_DIRS.has(basename)) {
    return true;
  }

  // Skip ignored files
  if (IGNORED_FILES.has(basename)) {
    return true;
  }

  // Skip bun lock/build files
  if (basename.startsWith("bun.lock") || basename.endsWith(".bun-build")) {
    return true;
  }

  return false;
}

/** Extensions we care about for verification */
const WATCH_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|mts|json|sh)$/;

export type CopilotWatcher = {
  /** Start watching. Returns a cleanup function. */
  start(): void;
  /** Stop watching and clean up all resources */
  stop(): Promise<void>;
  /** Number of files currently being watched */
  watchedCount(): number;
};

export type WatcherOptions = {
  cwd: string;
  debounceMs: number;
  onEvent: (event: WatcherEvent) => void;
};

export function createWatcher(opts: WatcherOptions): CopilotWatcher {
  let fileWatcher: FSWatcher | null = null;
  let gitWatcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let gitDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingFiles = new Set<string>();
  let watchedFileCount = 0;

  function flushFileChanges() {
    if (pendingFiles.size === 0) {
      return;
    }
    const files = Array.from(pendingFiles);
    pendingFiles.clear();
    opts.onEvent({ type: "files-changed", files });
  }

  function onFileChange(filePath: string) {
    // Only watch relevant extensions
    if (!WATCH_EXTENSIONS.test(filePath)) {
      return;
    }

    // Make path relative to cwd for cleaner output
    const relative = path.relative(opts.cwd, filePath);

    // Extra safety: skip anything in .moltbot/ (should already be ignored by chokidar)
    if (relative.startsWith(".moltbot")) {
      return;
    }

    pendingFiles.add(relative);

    // Reset debounce timer — wait for saves to settle
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(flushFileChanges, opts.debounceMs);
  }

  function onGitRefChange() {
    // Debounce git events separately (commits write multiple ref files)
    if (gitDebounceTimer) {
      clearTimeout(gitDebounceTimer);
    }
    gitDebounceTimer = setTimeout(() => {
      // Read current HEAD for the ref
      try {
        const { execSync } = require("node:child_process") as typeof import("node:child_process");
        const ref = execSync("git rev-parse --short HEAD", {
          cwd: opts.cwd,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        opts.onEvent({ type: "commit", ref });
      } catch {
        // Git not available or not in a repo — ignore
      }
    }, 3000); // 3s debounce for git events
  }

  return {
    start() {
      // Watch source files
      fileWatcher = watch(opts.cwd, {
        ignored: isIgnored,
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200 },
      });

      fileWatcher.on("change", onFileChange);
      fileWatcher.on("add", onFileChange);
      fileWatcher.on("ready", () => {
        const watched = fileWatcher?.getWatched() ?? {};
        watchedFileCount = Object.values(watched).reduce((sum, files) => sum + files.length, 0);
      });

      // Watch .git/refs/heads/ for commit detection
      const gitRefsDir = path.join(opts.cwd, ".git", "refs", "heads");
      gitWatcher = watch(gitRefsDir, {
        persistent: true,
        ignoreInitial: true,
        depth: 2,
      });

      gitWatcher.on("change", onGitRefChange);
      gitWatcher.on("add", onGitRefChange);
    },

    async stop() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (gitDebounceTimer) {
        clearTimeout(gitDebounceTimer);
        gitDebounceTimer = null;
      }
      if (fileWatcher) {
        await fileWatcher.close();
        fileWatcher = null;
      }
      if (gitWatcher) {
        await gitWatcher.close();
        gitWatcher = null;
      }
      pendingFiles.clear();
    },

    watchedCount() {
      return watchedFileCount;
    },
  };
}
