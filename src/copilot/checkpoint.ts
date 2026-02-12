/**
 * Git-based checkpoints for the TAO loop.
 *
 * Snapshots the target repo before each Codex iteration so we can
 * roll back bad changes. Compatible with Entire's manual-commit strategy.
 *
 * Flow:
 *   1. createCheckpoint() — commits all changes (staged + unstaged + untracked)
 *   2. rollbackToCheckpoint() — hard-resets to a prior checkpoint SHA
 *   3. cleanupCheckpoints() — squashes checkpoint commits into one on success
 */

import { execSync } from "node:child_process";

const CHECKPOINT_PREFIX = "[voice-qa-checkpoint]";

/** Run a git command in the target directory. Returns stdout or empty string on error. */
function git(cwd: string, args: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

/** Check if the target directory is a git repo. */
export function isGitRepo(cwd: string): boolean {
  return git(cwd, "rev-parse --is-inside-work-tree") === "true";
}

/**
 * Create a checkpoint commit capturing all current state.
 * Returns the commit SHA, or null if nothing to commit.
 */
export function createCheckpoint(cwd: string, label: string): string | null {
  if (!isGitRepo(cwd)) {
    return null;
  }

  // Stage everything (including untracked)
  git(cwd, "add -A");

  // Check if there's anything to commit
  const status = git(cwd, "status --porcelain");
  if (!status) {
    // Nothing to commit — return current HEAD as the checkpoint
    return git(cwd, "rev-parse HEAD") || null;
  }

  // Commit with checkpoint prefix (skip hooks — this is internal bookkeeping)
  git(cwd, `commit --no-verify -m "${CHECKPOINT_PREFIX} ${label}"`);

  return git(cwd, "rev-parse HEAD") || null;
}

/**
 * Roll back to a prior checkpoint. Discards all changes after that SHA.
 * Returns true if rollback succeeded.
 */
export function rollbackToCheckpoint(cwd: string, sha: string): boolean {
  if (!isGitRepo(cwd) || !sha) {
    return false;
  }

  const result = git(cwd, `reset --hard ${sha}`);
  return result !== "";
}

/**
 * Get the current HEAD SHA (for recording before any checkpoint is made).
 */
export function getCurrentHead(cwd: string): string | null {
  const sha = git(cwd, "rev-parse HEAD");
  return sha || null;
}

/**
 * Clean up checkpoint commits by soft-resetting to a base SHA.
 * Leaves the working tree intact but squashes the checkpoint history.
 * Call this on success — the final state is good, we just want clean git history.
 */
export function squashCheckpoints(cwd: string, baseSha: string): boolean {
  if (!isGitRepo(cwd) || !baseSha) {
    return false;
  }

  // Soft reset to base (keeps changes staged)
  const result = git(cwd, `reset --soft ${baseSha}`);
  if (result === "" && git(cwd, "rev-parse HEAD") !== baseSha) {
    return false;
  }

  // Re-commit as a single clean commit
  const status = git(cwd, "status --porcelain");
  if (status) {
    git(cwd, `commit --no-verify -m "voice-qa: apply fixes"`);
  }

  return true;
}

/**
 * Count how many checkpoint commits exist since a base SHA.
 */
export function countCheckpointsSince(cwd: string, baseSha: string): number {
  if (!isGitRepo(cwd) || !baseSha) {
    return 0;
  }

  const log = git(cwd, `log --oneline ${baseSha}..HEAD`);
  if (!log) {
    return 0;
  }

  return log.split("\n").filter((line) => line.includes(CHECKPOINT_PREFIX)).length;
}
