import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseLcov, getChangedLineNumbers, runCoverageDiffStage } from "./stages-coverage.js";

describe("parseLcov", () => {
  it("parses a valid LCOV file with multiple records", () => {
    const content = [
      "SF:src/foo.ts",
      "DA:1,1",
      "DA:2,0",
      "DA:5,3",
      "end_of_record",
      "SF:src/bar.ts",
      "DA:10,1",
      "end_of_record",
    ].join("\n");

    const records = parseLcov(content);
    expect(records).toHaveLength(2);
    expect(records[0].file).toBe("src/foo.ts");
    expect(records[0].lines.get(1)).toBe(1);
    expect(records[0].lines.get(2)).toBe(0);
    expect(records[0].lines.get(5)).toBe(3);
    expect(records[1].file).toBe("src/bar.ts");
    expect(records[1].lines.get(10)).toBe(1);
  });

  it("returns empty array for empty content", () => {
    expect(parseLcov("")).toEqual([]);
  });

  it("handles malformed DA lines gracefully", () => {
    const content = [
      "SF:src/foo.ts",
      "DA:notanumber,1",
      "DA:3,abc",
      "DA:5,2",
      "end_of_record",
    ].join("\n");

    const records = parseLcov(content);
    expect(records).toHaveLength(1);
    // Only DA:5,2 should be valid
    expect(records[0].lines.size).toBe(1);
    expect(records[0].lines.get(5)).toBe(2);
  });
});

describe("getChangedLineNumbers", () => {
  const tmpDir = path.join("/tmp", "coverage-diff-test-" + process.pid);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Initialize a git repo
    const run = (cmd: string) => {
      const { execSync } = require("node:child_process");
      execSync(cmd, { cwd: tmpDir, encoding: "utf-8" });
    };
    run("git init");
    run("git config user.email test@test.com");
    run("git config user.name Test");

    // Create initial file and commit
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "line1\nline2\nline3\n");
    run("git add -A && git commit -m initial");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects changed line numbers relative to HEAD", () => {
    // Modify lines 2 and add line 4
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "line1\nmodified2\nline3\nnewline4\n");

    const lines = getChangedLineNumbers(tmpDir, "HEAD", "test.ts");
    expect(lines).toContain(2);
    expect(lines).toContain(4);
    expect(lines).not.toContain(1);
    expect(lines).not.toContain(3);
  });

  it("returns empty for non-existent file", () => {
    const lines = getChangedLineNumbers(tmpDir, "HEAD", "nonexistent.ts");
    expect(lines).toEqual([]);
  });
});

describe("runCoverageDiffStage", () => {
  it("passes when there are no changed source files", async () => {
    const ctx = {
      changedFiles: ["README.md"],
      cwd: "/tmp/nonexistent",
      signal: new AbortController().signal,
      baselineRef: "HEAD",
    };

    // Will fail the vitest run but the stage should handle it gracefully
    const result = await runCoverageDiffStage(ctx);
    // Should pass (graceful failure since vitest won't run)
    expect(result.stage).toBe("coverage-diff");
    expect(result.passed).toBe(true);
  });
});
