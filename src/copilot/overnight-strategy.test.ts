import { describe, expect, it } from "vitest";
import type { OvernightState } from "./overnight-types.js";
import { detectPhase, resolveStrategy } from "./overnight-strategy.js";

function makeState(overrides: Partial<OvernightState> = {}): OvernightState {
  return {
    runId: "test-run",
    startedAt: new Date().toISOString(),
    baseHead: "abc123",
    completedCycles: 0,
    cycles: [],
    triedApproaches: [],
    bestScore: 0,
    bestScoreCycle: 0,
    currentPhase: "phase-1-connect",
    consecutiveStalls: 0,
    consecutiveApiErrors: 0,
    ...overrides,
  };
}

describe("detectPhase", () => {
  it("returns phase-1-connect when no cycles exist", () => {
    expect(detectPhase(makeState())).toBe("phase-1-connect");
  });

  it("detects phase-1-connect from WebSocket diagnoses", () => {
    const state = makeState({
      cycles: [
        {
          cycle: 1,
          startedAt: "",
          durationMs: 0,
          stopReason: "max-iterations",
          iterations: 5,
          score: 1,
          phase: "phase-1-connect",
          strategy: "standard",
          diagnoses: ["WebSocket 1007 Invalid JSON payload"],
          changedFiles: [],
          diffSummary: "",
          scoreImproved: false,
          scoreRegressed: false,
        },
      ],
    });
    expect(detectPhase(state)).toBe("phase-1-connect");
  });

  it("detects phase-1-connect from ws-1011 diagnosis", () => {
    const state = makeState({
      cycles: [
        {
          cycle: 1,
          startedAt: "",
          durationMs: 0,
          stopReason: "stuck",
          iterations: 2,
          score: 1,
          phase: "phase-1-connect",
          strategy: "standard",
          diagnoses: ["ws-1011-after-tool-response"],
          changedFiles: [],
          diffSummary: "",
          scoreImproved: false,
          scoreRegressed: false,
        },
      ],
    });
    expect(detectPhase(state)).toBe("phase-1-connect");
  });

  it("detects phase-2-talk from tutor-silent diagnosis", () => {
    const state = makeState({
      cycles: [
        {
          cycle: 2,
          startedAt: "",
          durationMs: 0,
          stopReason: "max-iterations",
          iterations: 5,
          score: 2,
          phase: "phase-2-talk",
          strategy: "standard",
          diagnoses: ["mic-heard-tutor-silent"],
          changedFiles: [],
          diffSummary: "",
          scoreImproved: false,
          scoreRegressed: false,
        },
      ],
    });
    expect(detectPhase(state)).toBe("phase-2-talk");
  });

  it("detects phase-3-draw from canvas-related diagnosis", () => {
    const state = makeState({
      cycles: [
        {
          cycle: 3,
          startedAt: "",
          durationMs: 0,
          stopReason: "max-iterations",
          iterations: 5,
          score: 3,
          phase: "phase-3-draw",
          strategy: "contextual",
          diagnoses: ["canvas-blank-after-draw"],
          changedFiles: [],
          diffSummary: "",
          scoreImproved: false,
          scoreRegressed: false,
        },
      ],
    });
    expect(detectPhase(state)).toBe("phase-3-draw");
  });

  it("detects phase-4-teach when score >= 4 and no specific diagnoses", () => {
    const state = makeState({
      cycles: [
        {
          cycle: 4,
          startedAt: "",
          durationMs: 0,
          stopReason: "max-iterations",
          iterations: 5,
          score: 5,
          phase: "phase-4-teach",
          strategy: "contextual",
          diagnoses: ["teaching quality low"],
          changedFiles: [],
          diffSummary: "",
          scoreImproved: true,
          scoreRegressed: false,
        },
      ],
    });
    expect(detectPhase(state)).toBe("phase-4-teach");
  });

  it("falls back to score-based phase when diagnoses are ambiguous", () => {
    const state = makeState({
      cycles: [
        {
          cycle: 1,
          startedAt: "",
          durationMs: 0,
          stopReason: "max-iterations",
          iterations: 5,
          score: 3,
          phase: "phase-2-talk",
          strategy: "standard",
          diagnoses: ["unknown issue"],
          changedFiles: [],
          diffSummary: "",
          scoreImproved: false,
          scoreRegressed: false,
        },
      ],
    });
    expect(detectPhase(state)).toBe("phase-2-talk");
  });
});

describe("resolveStrategy", () => {
  it("returns standard strategy with 0 stalls", () => {
    const strategy = resolveStrategy(makeState());
    expect(strategy.level).toBe("standard");
    expect(strategy.innerMaxIterations).toBe(5);
    expect(strategy.codexModel).toBeUndefined();
  });

  it("escalates to contextual after 2 stalls", () => {
    const strategy = resolveStrategy(makeState({ consecutiveStalls: 2 }));
    expect(strategy.level).toBe("contextual");
    expect(strategy.innerMaxIterations).toBe(5);
  });

  it("escalates to architectural after 4 stalls", () => {
    const strategy = resolveStrategy(makeState({ consecutiveStalls: 4 }));
    expect(strategy.level).toBe("architectural");
    expect(strategy.innerMaxIterations).toBe(5);
  });

  it("escalates to fallback-model after 6 stalls", () => {
    const strategy = resolveStrategy(makeState({ consecutiveStalls: 6 }));
    expect(strategy.level).toBe("fallback-model");
    expect(strategy.innerMaxIterations).toBe(3);
    expect(strategy.codexModel).toBe("o3");
  });

  it("includes tried approaches in preamble", () => {
    const state = makeState({
      triedApproaches: ["fix transcription config", "change model name"],
    });
    const strategy = resolveStrategy(state);
    expect(strategy.strategicPreamble).toContain("ALREADY TRIED");
    expect(strategy.strategicPreamble).toContain("fix transcription config");
    expect(strategy.strategicPreamble).toContain("change model name");
  });

  it("includes phase goal in preamble", () => {
    const strategy = resolveStrategy(makeState());
    expect(strategy.strategicPreamble).toContain("CURRENT PHASE: phase-1-connect");
    expect(strategy.strategicPreamble).toContain("GOAL:");
  });

  it("includes escalation context for architectural level", () => {
    const strategy = resolveStrategy(makeState({ consecutiveStalls: 4 }));
    expect(strategy.strategicPreamble).toContain("STRATEGY ESCALATION");
    expect(strategy.strategicPreamble).toContain("architectural changes");
  });

  it("includes fallback context for fallback-model level", () => {
    const strategy = resolveStrategy(makeState({ consecutiveStalls: 6 }));
    expect(strategy.strategicPreamble).toContain("FALLBACK MODE");
    expect(strategy.strategicPreamble).toContain("gemini-live-2.5-flash-preview");
  });

  it("provides more source files for contextual+ strategies", () => {
    const standard = resolveStrategy(makeState());
    const contextual = resolveStrategy(makeState({ consecutiveStalls: 2 }));
    expect(contextual.extraSourceFiles.length).toBeGreaterThan(standard.extraSourceFiles.length);
  });
});
