import { describe, expect, it } from "vitest";
import type { IterationRecordLike } from "./iteration-briefing.js";
import type { OvernightState } from "./overnight-types.js";
import { buildIterationBriefing, serializeBriefingAsSystemPrompt } from "./iteration-briefing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<IterationRecordLike> = {}): IterationRecordLike {
  return {
    iteration: 1,
    diagnoses: [
      {
        rootCause: "WebSocket 1011 after tool response",
        suggestedFix: "Use sendClientContent instead of sendToolResponse",
      },
    ],
    nudgeSent: "Adam talked about pizza but never drew anything on the scratchpad.",
    observation: {
      changedFiles: ["src/hooks/useScratchpadAI.ts"],
      diffMatchResult: "partial" as const,
    },
    passed: false,
    scorecard: { overall: 3 },
    ...overrides,
  };
}

function makeOvernightState(overrides: Partial<OvernightState> = {}): OvernightState {
  return {
    runId: "test-run",
    startedAt: "2026-02-12T00:00:00Z",
    baseHead: "abc1234",
    completedCycles: 2,
    cycles: [],
    triedApproaches: ["sendToolResponse workaround", "NON_BLOCKING removal"],
    bestScore: 4,
    bestScoreCycle: 1,
    currentPhase: "phase-2-talk",
    consecutiveStalls: 0,
    consecutiveApiErrors: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildIterationBriefing
// ---------------------------------------------------------------------------

describe("buildIterationBriefing", () => {
  it("builds compact summary from iteration history", () => {
    const history = [
      makeRecord({ iteration: 1, passed: false, scorecard: { overall: 2 } }),
      makeRecord({ iteration: 2, passed: false, scorecard: { overall: 3 } }),
      makeRecord({ iteration: 3, passed: false, scorecard: { overall: 3 } }),
    ];

    const briefing = buildIterationBriefing(history, {
      currentIteration: 4,
      maxIterations: 5,
      focusFiles: ["src/hooks/useScratchpadAI.ts"],
    });

    expect(briefing.iteration).toBe(4);
    expect(briefing.maxIterations).toBe(5);
    expect(briefing.previousAttempts).toHaveLength(3);
    expect(briefing.focusFiles).toContain("src/hooks/useScratchpadAI.ts");
  });

  it("caps previous attempts at 5", () => {
    const history = Array.from({ length: 8 }, (_, i) => makeRecord({ iteration: i + 1 }));

    const briefing = buildIterationBriefing(history, {
      currentIteration: 9,
      maxIterations: 10,
      focusFiles: [],
    });

    expect(briefing.previousAttempts).toHaveLength(5);
    // Should include the last 5 (iterations 4-8)
    expect(briefing.previousAttempts[0].iteration).toBe(4);
    expect(briefing.previousAttempts[4].iteration).toBe(8);
  });

  it("truncates nudge summaries to 200 chars", () => {
    const longNudge = "A".repeat(500);
    const history = [makeRecord({ nudgeSent: longNudge })];

    const briefing = buildIterationBriefing(history, {
      currentIteration: 2,
      maxIterations: 5,
      focusFiles: [],
    });

    expect(briefing.previousAttempts[0].nudgeSummary.length).toBeLessThanOrEqual(200);
  });

  it("includes score trajectory", () => {
    const history = [
      makeRecord({ iteration: 1, scorecard: { overall: 2 } }),
      makeRecord({ iteration: 2, scorecard: { overall: 3 } }),
      makeRecord({ iteration: 3, scorecard: null }),
    ];

    const briefing = buildIterationBriefing(history, {
      currentIteration: 4,
      maxIterations: 5,
      focusFiles: [],
    });

    expect(briefing.scoreTrajectory).toEqual([2, 3, null]);
  });

  it("includes overnight triedApproaches when provided", () => {
    const state = makeOvernightState({
      triedApproaches: ["sendToolResponse workaround", "NON_BLOCKING removal"],
    });

    const briefing = buildIterationBriefing([], {
      currentIteration: 1,
      maxIterations: 5,
      focusFiles: [],
      overnightState: state,
    });

    expect(briefing.projectWarnings.some((w) => w.includes("sendToolResponse"))).toBe(true);
    expect(briefing.projectWarnings.some((w) => w.includes("NON_BLOCKING"))).toBe(true);
  });

  it("determines outcomes correctly", () => {
    const history = [
      makeRecord({ iteration: 1, scorecard: { overall: 2 }, passed: false }),
      makeRecord({ iteration: 2, scorecard: { overall: 4 }, passed: false }),
      makeRecord({ iteration: 3, scorecard: { overall: 3 }, passed: false }),
      makeRecord({ iteration: 4, passed: true }),
    ];

    const briefing = buildIterationBriefing(history, {
      currentIteration: 5,
      maxIterations: 5,
      focusFiles: [],
    });

    // iteration 1: no previous, score 2 — unknown (first iteration)
    expect(briefing.previousAttempts[0].outcome).toBe("unknown");
    // iteration 2: score 2→4 — improved
    expect(briefing.previousAttempts[1].outcome).toBe("improved");
    // iteration 3: score 4→3 — regressed
    expect(briefing.previousAttempts[2].outcome).toBe("regressed");
    // iteration 4: passed — improved
    expect(briefing.previousAttempts[3].outcome).toBe("improved");
  });

  it("includes validation failures when provided", () => {
    const briefing = buildIterationBriefing([], {
      currentIteration: 2,
      maxIterations: 5,
      focusFiles: [],
      lastValidationFailures: ["Unit tests failed for useScratchpadAI.test.ts"],
    });

    expect(briefing.lastValidationFailures).toHaveLength(1);
    expect(briefing.lastValidationFailures![0]).toContain("Unit tests failed");
  });
});

// ---------------------------------------------------------------------------
// serializeBriefingAsSystemPrompt
// ---------------------------------------------------------------------------

describe("serializeBriefingAsSystemPrompt", () => {
  it("renders markdown with all sections", () => {
    const history = [
      makeRecord({ iteration: 1, scorecard: { overall: 2 } }),
      makeRecord({ iteration: 2, scorecard: { overall: 3 } }),
    ];

    const briefing = buildIterationBriefing(history, {
      currentIteration: 3,
      maxIterations: 5,
      focusFiles: ["src/hooks/useScratchpadAI.ts"],
      projectWarnings: ["sendToolResponse crashes on native audio"],
    });

    const md = serializeBriefingAsSystemPrompt(briefing);

    expect(md).toContain("# Voice QA Iteration Context");
    expect(md).toContain("iteration 3/5");
    expect(md).toContain("## What Was Already Tried");
    expect(md).toContain("## Focus Files");
    expect(md).toContain("useScratchpadAI.ts");
    expect(md).toContain("## Score Trajectory");
    expect(md).toContain("## Project Anti-Patterns");
    expect(md).toContain("sendToolResponse");
  });

  it("stays under 3KB when serialized", () => {
    const history = Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        iteration: i + 1,
        nudgeSent:
          "Fix the WebSocket reconnection logic and ensure tool responses are sent via clientContent. ".repeat(
            3,
          ),
      }),
    );

    const briefing = buildIterationBriefing(history, {
      currentIteration: 6,
      maxIterations: 10,
      focusFiles: [
        "src/hooks/useScratchpadAI.ts",
        "src/features/tutor/tutor-service.ts",
        "src/hooks/canvas-renderer.ts",
      ],
      projectWarnings: [
        "sendToolResponse crashes on native audio models — use sendClientContent instead",
        "NON_BLOCKING scheduling causes hallucinations — remove it",
        "AudioTranscriptionConfig must be empty object {}",
      ],
      overnightState: makeOvernightState(),
    });

    const md = serializeBriefingAsSystemPrompt(briefing);
    const byteLength = Buffer.byteLength(md, "utf-8");
    expect(byteLength).toBeLessThan(3072);
  });

  it("includes strategic preamble from overnight state", () => {
    const briefing = buildIterationBriefing([], {
      currentIteration: 1,
      maxIterations: 5,
      focusFiles: [],
      overnightState: makeOvernightState({
        currentPhase: "phase-3-draw",
        bestScore: 6,
        bestScoreCycle: 2,
      }),
    });

    const md = serializeBriefingAsSystemPrompt(briefing);
    expect(md).toContain("## Strategic Goal");
    expect(md).toContain("phase-3-draw");
    expect(md).toContain("Best score so far: 6/10");
  });

  it("includes validation failures section", () => {
    const briefing = buildIterationBriefing([], {
      currentIteration: 3,
      maxIterations: 5,
      focusFiles: [],
      lastValidationFailures: [
        "Compile failed: TS2322 in useScratchpadAI.ts",
        "Unit tests failed for tutor-service.test.ts",
      ],
    });

    const md = serializeBriefingAsSystemPrompt(briefing);
    expect(md).toContain("## Previous Iteration Validation Failures");
    expect(md).toContain("TS2322");
    expect(md).toContain("tutor-service.test.ts");
  });

  it("omits empty sections", () => {
    const briefing = buildIterationBriefing([], {
      currentIteration: 1,
      maxIterations: 5,
      focusFiles: [],
    });

    const md = serializeBriefingAsSystemPrompt(briefing);
    expect(md).not.toContain("## What Was Already Tried");
    expect(md).not.toContain("## Score Trajectory");
    expect(md).not.toContain("## Strategic Goal");
    expect(md).not.toContain("## Previous Iteration Validation Failures");
  });
});
