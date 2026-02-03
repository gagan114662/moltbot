import { describe, expect, it } from "vitest";

import { applyHardApprovalGates, type ReviewResult } from "./orchestrator.js";

const gates = {
  requireReviewerJson: true,
  requireAllCommandsPass: true,
  requireNoBrowserErrors: true,
  requireArtifactProof: true,
  blockApprovalOnParseFailure: true,
  requireRuntimeSessionHealthy: false,
  requireGeminiLiveHealthy: false,
  requireNoToolCallDuplication: false,
  requireConsoleBudget: false,
} as const;

describe("applyHardApprovalGates", () => {
  it("blocks approval when required command checks fail", () => {
    const review: ReviewResult = {
      approved: true,
      reviewerJsonValid: true,
      checks: [{ command: "pnpm check", passed: false, error: "lint failed" }],
      artifacts: { commandSummaries: ["pnpm check: FAIL"] },
    };

    const next = applyHardApprovalGates({
      reviewResult: review,
      config: { commands: [{ command: "pnpm check" }] },
      gates,
    });

    expect(next.approved).toBe(false);
    expect(next.feedback).toContain("Required command checks failed");
  });

  it("blocks approval when browser gate is enabled and browser errors exist", () => {
    const review: ReviewResult = {
      approved: true,
      reviewerJsonValid: true,
      checks: [{ command: "pnpm check", passed: true }],
      browserErrors: ["Console: ReferenceError"],
      artifacts: { commandSummaries: ["pnpm check: PASS"] },
    };

    const next = applyHardApprovalGates({
      reviewResult: review,
      config: { commands: [{ command: "pnpm check" }] },
      gates,
    });

    expect(next.approved).toBe(false);
    expect(next.feedback).toContain("Browser verification reported errors");
  });

  it("blocks approval when strict reviewer JSON is required but missing", () => {
    const review: ReviewResult = {
      approved: true,
      checks: [],
      artifacts: { commandSummaries: ["proof"] },
    };

    const next = applyHardApprovalGates({
      reviewResult: review,
      config: {},
      gates,
    });

    expect(next.approved).toBe(false);
    expect(next.feedback).toContain("Reviewer JSON payload was invalid or missing");
  });

  it("blocks approval when artifact proof is required but missing", () => {
    const review: ReviewResult = {
      approved: true,
      reviewerJsonValid: true,
      checks: [],
      artifacts: { screenshots: [], commandSummaries: [] },
    };

    const next = applyHardApprovalGates({
      reviewResult: review,
      config: {},
      gates,
    });

    expect(next.approved).toBe(false);
    expect(next.feedback).toContain("no proof artifacts");
  });

  it("blocks approval when runtime session health gate fails", () => {
    const review: ReviewResult = {
      approved: true,
      reviewerJsonValid: true,
      checks: [],
      runtime: { sessionStart: true, websocket: false, sessionEnd: true },
      artifacts: { commandSummaries: ["runtime: FAIL"] },
    };

    const next = applyHardApprovalGates({
      reviewResult: review,
      config: {},
      gates: { ...gates, requireRuntimeSessionHealthy: true },
    });

    expect(next.approved).toBe(false);
    expect(next.feedback).toContain("Runtime session health check failed");
  });

  it("blocks approval when gemini closes due to deadline", () => {
    const review: ReviewResult = {
      approved: true,
      reviewerJsonValid: true,
      checks: [],
      runtime: {
        sessionStart: true,
        websocket: true,
        sessionEnd: true,
        geminiConnect: true,
        geminiCloseReason: "Deadline expired before operation could complete.",
      },
      artifacts: { commandSummaries: ["runtime: FAIL"] },
    };

    const next = applyHardApprovalGates({
      reviewResult: review,
      config: {},
      gates: { ...gates, requireGeminiLiveHealthy: true },
    });

    expect(next.approved).toBe(false);
    expect(next.feedback).toContain("Gemini live session unhealthy");
  });
});
