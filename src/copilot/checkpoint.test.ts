import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countCheckpointsSince,
  createCheckpoint,
  getCurrentHead,
  isGitRepo,
  rollbackToCheckpoint,
  squashCheckpoints,
} from "./checkpoint.js";

/** Create a temp git repo for testing. */
function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-test-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  // Initial commit
  fs.writeFileSync(path.join(dir, "file.txt"), "initial");
  execSync("git add -A && git commit -m 'initial'", { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("checkpoint", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeTempRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("isGitRepo returns true for a git repo", () => {
    expect(isGitRepo(repo)).toBe(true);
  });

  it("isGitRepo returns false for a non-repo dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
    expect(isGitRepo(tmp)).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("getCurrentHead returns a SHA", () => {
    const sha = getCurrentHead(repo);
    expect(sha).toBeTruthy();
    expect(sha!.length).toBeGreaterThanOrEqual(7);
  });

  it("createCheckpoint commits changes and returns SHA", () => {
    const baseSha = getCurrentHead(repo)!;
    // Make a change
    fs.writeFileSync(path.join(repo, "file.txt"), "changed");
    const checkpointSha = createCheckpoint(repo, "test-1");
    expect(checkpointSha).toBeTruthy();
    expect(checkpointSha).not.toBe(baseSha);
  });

  it("createCheckpoint returns current HEAD when nothing to commit", () => {
    const headSha = getCurrentHead(repo)!;
    const checkpointSha = createCheckpoint(repo, "no-changes");
    expect(checkpointSha).toBe(headSha);
  });

  it("rollbackToCheckpoint restores prior state", () => {
    const baseSha = getCurrentHead(repo)!;
    // Make a change and checkpoint
    fs.writeFileSync(path.join(repo, "file.txt"), "bad change");
    createCheckpoint(repo, "bad");
    // Verify it changed
    expect(fs.readFileSync(path.join(repo, "file.txt"), "utf-8")).toBe("bad change");
    // Rollback
    const ok = rollbackToCheckpoint(repo, baseSha);
    expect(ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, "file.txt"), "utf-8")).toBe("initial");
  });

  it("countCheckpointsSince counts checkpoint commits", () => {
    const baseSha = getCurrentHead(repo)!;
    // Create 2 checkpoints
    fs.writeFileSync(path.join(repo, "file.txt"), "v2");
    createCheckpoint(repo, "iter-1");
    fs.writeFileSync(path.join(repo, "file.txt"), "v3");
    createCheckpoint(repo, "iter-2");
    expect(countCheckpointsSince(repo, baseSha)).toBe(2);
  });

  it("squashCheckpoints collapses checkpoint history", () => {
    const baseSha = getCurrentHead(repo)!;
    // Create 3 checkpoints
    fs.writeFileSync(path.join(repo, "file.txt"), "v2");
    createCheckpoint(repo, "iter-1");
    fs.writeFileSync(path.join(repo, "a.txt"), "new");
    createCheckpoint(repo, "iter-2");
    fs.writeFileSync(path.join(repo, "file.txt"), "v3");
    createCheckpoint(repo, "iter-3");

    // Squash back to base
    const ok = squashCheckpoints(repo, baseSha);
    expect(ok).toBe(true);

    // Final state should be preserved
    expect(fs.readFileSync(path.join(repo, "file.txt"), "utf-8")).toBe("v3");
    expect(fs.existsSync(path.join(repo, "a.txt"))).toBe(true);

    // Should be only 1 commit after base (the squashed one)
    const log = execSync(`git log --oneline ${baseSha}..HEAD`, {
      cwd: repo,
      encoding: "utf-8",
    }).trim();
    const commits = log.split("\n").filter(Boolean);
    expect(commits.length).toBe(1);
    expect(commits[0]).toContain("voice-qa: apply fixes");
  });
});
