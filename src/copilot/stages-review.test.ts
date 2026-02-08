import { describe, expect, it } from "vitest";
import { parseReviewFindings, getChangedHunks } from "./stages-review.js";

describe("parseReviewFindings", () => {
  const changedFiles = new Set(["src/foo.ts", "src/bar.ts"]);

  it("parses ISSUE lines with confidence levels", () => {
    const output = [
      "Some preamble text",
      "ISSUE: [high] src/foo.ts:10 - Missing null check before access",
      "ISSUE: [med] src/bar.ts:25 - Possible race condition in async handler",
      "ISSUE: [low] src/foo.ts:11 - Consider adding a comment",
      "This is not an issue line",
    ].join("\n");

    const hunks = new Map<string, Set<number>>();
    hunks.set("src/foo.ts", new Set([8, 9, 10, 11, 12]));
    hunks.set("src/bar.ts", new Set([23, 24, 25, 26, 27]));

    const issues = parseReviewFindings(output, changedFiles, hunks);
    expect(issues).toHaveLength(3);
    expect(issues[0].confidence).toBe("high");
    expect(issues[0].file).toBe("src/foo.ts");
    expect(issues[0].line).toBe(10);
    expect(issues[1].confidence).toBe("med");
    expect(issues[2].confidence).toBe("low");
  });

  it("defaults to med confidence for old format without brackets", () => {
    const output = "ISSUE: src/foo.ts:10 - Missing null check\n";
    const hunks = new Map<string, Set<number>>();
    hunks.set("src/foo.ts", new Set([8, 9, 10, 11, 12]));

    const issues = parseReviewFindings(output, changedFiles, hunks);
    expect(issues).toHaveLength(1);
    expect(issues[0].confidence).toBe("med");
  });

  it("filters out issues referencing files not in diff", () => {
    const output = "ISSUE: [high] src/unknown.ts:5 - Some issue\n";
    const hunks = new Map<string, Set<number>>();

    const issues = parseReviewFindings(output, changedFiles, hunks);
    expect(issues).toHaveLength(0);
  });

  it("filters out issues with lines outside changed hunks", () => {
    const output = "ISSUE: [high] src/foo.ts:100 - Issue at line 100\n";
    const hunks = new Map<string, Set<number>>();
    hunks.set("src/foo.ts", new Set([5, 6, 7]));

    const issues = parseReviewFindings(output, changedFiles, hunks);
    expect(issues).toHaveLength(0);
  });

  it("allows issues within ±5 lines of a changed hunk", () => {
    const output = "ISSUE: [high] src/foo.ts:12 - Off by one error\n";
    const hunks = new Map<string, Set<number>>();
    hunks.set("src/foo.ts", new Set([10]));

    const issues = parseReviewFindings(output, changedFiles, hunks);
    expect(issues).toHaveLength(1);
  });

  it("returns empty for no valid issues", () => {
    const output = "NO ISSUES FOUND\n";
    const hunks = new Map<string, Set<number>>();
    const issues = parseReviewFindings(output, changedFiles, hunks);
    expect(issues).toHaveLength(0);
  });

  it("includes text field in parsed issues", () => {
    const output = "ISSUE: [high] src/foo.ts:10 - Bug here\n";
    const hunks = new Map<string, Set<number>>();
    hunks.set("src/foo.ts", new Set([10]));

    const issues = parseReviewFindings(output, changedFiles, hunks);
    expect(issues[0].text).toBe("[high] src/foo.ts:10 - Bug here");
  });
});

describe("getChangedHunks", () => {
  it("returns empty map for invalid path", () => {
    const hunks = getChangedHunks("/nonexistent-path-12345", "HEAD");
    expect(hunks.size).toBe(0);
  });
});
