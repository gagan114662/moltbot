import { describe, expect, it } from "vitest";
import { parseReviewerResponse } from "./spawn-reviewer.js";

describe("parseReviewerResponse", () => {
  it("rejects malformed reviewer output when strict JSON gate is enabled", () => {
    const result = parseReviewerResponse("looks good approved", {
      gates: {
        requireReviewerJson: true,
        blockApprovalOnParseFailure: true,
      },
    });

    expect(result.approved).toBe(false);
    expect(result.reviewerJsonValid).toBe(false);
    expect(result.feedback).toContain("missing required JSON payload");
  });

  it("accepts valid strict JSON payload and normalizes checks/artifacts", () => {
    const result = parseReviewerResponse(
      `\`\`\`json
{
  "approved": true,
  "checks": [
    { "name": "typecheck", "passed": true, "evidence": "pnpm check passed" }
  ],
  "issues": [],
  "artifacts": {
    "screenshots": ["/tmp/screen.png"],
    "urlsTested": ["http://localhost:3000/app"],
    "commandSummaries": ["pnpm check passed"]
  },
  "summary": "Everything passed"
}
\`\`\``,
    );

    expect(result.approved).toBe(true);
    expect(result.reviewerJsonValid).toBe(true);
    expect(result.checks[0].name).toBe("typecheck");
    expect(result.artifacts?.screenshots).toEqual(["/tmp/screen.png"]);
    expect(result.feedback).toContain("Everything passed");
  });

  it("rejects JSON payload missing required fields when strict gate is on", () => {
    const result = parseReviewerResponse(
      `\`\`\`json
{"approved": true, "summary": "missing checks and issues"}
\`\`\``,
      { gates: { requireReviewerJson: true, blockApprovalOnParseFailure: true } },
    );

    expect(result.approved).toBe(false);
    expect(result.reviewerJsonValid).toBe(false);
    expect(result.feedback).toContain("invalid");
  });

  it("falls back to keyword parsing only when strict JSON gate is disabled", () => {
    const result = parseReviewerResponse("APPROVED. ship it.", {
      gates: {
        requireReviewerJson: false,
        blockApprovalOnParseFailure: false,
      },
    });

    expect(result.reviewerJsonValid).toBe(false);
    expect(result.approved).toBe(true);
  });

  it("blocks approval when reviewer rubric includes a low score", () => {
    const result = parseReviewerResponse(
      `\`\`\`json
{
  "approved": true,
  "checks": [{ "name": "browser", "passed": true, "evidence": "ok" }],
  "issues": [],
  "rubric": [
    { "dimension": "correctness", "score": 4, "evidence": "works" },
    { "dimension": "reliability", "score": 2, "evidence": "flaky retries" }
  ]
}
\`\`\``,
    );

    expect(result.reviewerJsonValid).toBe(true);
    expect(result.approved).toBe(false);
    expect(result.feedback).toContain("rubric");
  });

  it("blocks approval when rubric average is below default threshold", () => {
    const result = parseReviewerResponse(
      `\`\`\`json
{
  "approved": true,
  "checks": [{ "name": "browser", "passed": true, "evidence": "ok" }],
  "issues": [],
  "rubric": [
    { "dimension": "correctness", "score": 3, "evidence": "partial" },
    { "dimension": "reliability", "score": 4, "evidence": "good" }
  ]
}
\`\`\``,
    );

    expect(result.reviewerJsonValid).toBe(true);
    expect(result.approved).toBe(false);
    expect(result.feedback).toContain("average below threshold");
  });

  it("honors custom rubric average threshold from config", () => {
    const result = parseReviewerResponse(
      `\`\`\`json
{
  "approved": true,
  "checks": [{ "name": "browser", "passed": true, "evidence": "ok" }],
  "issues": [],
  "rubric": [
    { "dimension": "correctness", "score": 3, "evidence": "partial" },
    { "dimension": "reliability", "score": 4, "evidence": "good" }
  ]
}
\`\`\``,
      { review: { minimumAverageRubricScore: 3.5 } },
    );

    expect(result.reviewerJsonValid).toBe(true);
    expect(result.approved).toBe(true);
  });
});
