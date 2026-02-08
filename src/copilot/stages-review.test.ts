import { describe, expect, it } from "vitest";
import { parseReviewFindings, getChangedHunks } from "./stages-review.js";

describe("parseReviewFindings", () => {
  const changedFiles = new Set(["src/foo.ts", "src/bar.ts"]);

  it("parses valid ISSUE lines", () => {
    const output = [
      "Some preamble text",
      "ISSUE: src/foo.ts:10 - Missing null check before access",
      "ISSUE: src/bar.ts:25 - Race condition in async handler",
      "This is not an issue line",
    ].join("\n");

    const hunks = new Map<string, Set<number>>();
    hunks.set("src/foo.ts", new Set([8, 9, 10, 11, 12]));
    hunks.set("src/bar.ts", new Set([23, 24, 25, 26, 27]));

    const issues = parseReviewFindings(output, changedFiles, hunks);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("src/foo.ts:10");
    expect(issues[1]).toContain("src/bar.ts:25");
  });

  it("filters out issues referencing files not in diff", () => {
    const output = "ISSUE: src/unknown.ts:5 - Some issue\n";
    const hunks = new Map<string, Set<number>>();

    const issues = parseReviewFindings(output, changedFiles, hunks);
    expect(issues).toHaveLength(0);
  });

  it("filters out issues with lines outside changed hunks", () => {
    const output = "ISSUE: src/foo.ts:100 - Issue at line 100\n";
    const hunks = new Map<string, Set<number>>();
    hunks.set("src/foo.ts", new Set([5, 6, 7])); // Changed lines are 5-7, not 100

    const issues = parseReviewFindings(output, changedFiles, hunks);
    expect(issues).toHaveLength(0);
  });

  it("allows issues within ±5 lines of a changed hunk", () => {
    const output = "ISSUE: src/foo.ts:12 - Off by one error\n";
    const hunks = new Map<string, Set<number>>();
    hunks.set("src/foo.ts", new Set([10])); // Line 12 is within ±5 of line 10

    const issues = parseReviewFindings(output, changedFiles, hunks);
    expect(issues).toHaveLength(1);
  });

  it("returns empty for no valid issues", () => {
    const output = "NO ISSUES FOUND\n";
    const hunks = new Map<string, Set<number>>();
    const issues = parseReviewFindings(output, changedFiles, hunks);
    expect(issues).toHaveLength(0);
  });
});

describe("getChangedHunks", () => {
  it("returns empty map for invalid path", () => {
    const hunks = getChangedHunks("/nonexistent-path-12345", "HEAD");
    expect(hunks.size).toBe(0);
  });
});
