import { describe, expect, it } from "vitest";
import type { OvernightState } from "./overnight-types.js";
import { generateMorningReport } from "./overnight-report.js";

function makeState(overrides: Partial<OvernightState> = {}): OvernightState {
  return {
    runId: "test-run-001",
    startedAt: "2026-02-11T23:00:00.000Z",
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

describe("generateMorningReport", () => {
  it("generates a report with no cycles", () => {
    const report = generateMorningReport(makeState());
    expect(report).toContain("# Overnight Self-Healing Report");
    expect(report).toContain("Run ID: test-run-001");
    expect(report).toContain("**Cycles**: 0");
    expect(report).toContain("No cycles completed.");
  });

  it("shows score trajectory", () => {
    const state = makeState({
      completedCycles: 3,
      bestScore: 5,
      bestScoreCycle: 3,
      currentPhase: "phase-3-draw",
      cycles: [
        {
          cycle: 1,
          startedAt: "",
          durationMs: 300000,
          stopReason: "max-iterations",
          iterations: 5,
          score: 1,
          phase: "phase-1-connect",
          strategy: "standard",
          diagnoses: ["ws-1007"],
          changedFiles: ["tutor-service.ts"],
          diffSummary: "1 file changed, 3 insertions",
          scoreImproved: false,
          scoreRegressed: false,
        },
        {
          cycle: 2,
          startedAt: "",
          durationMs: 300000,
          stopReason: "max-iterations",
          iterations: 5,
          score: 3,
          phase: "phase-2-talk",
          strategy: "contextual",
          diagnoses: ["tutor-silent"],
          changedFiles: ["tutor-service.ts"],
          diffSummary: "1 file changed, 10 insertions",
          scoreImproved: true,
          scoreRegressed: false,
        },
        {
          cycle: 3,
          startedAt: "",
          durationMs: 300000,
          stopReason: "max-iterations",
          iterations: 5,
          score: 5,
          phase: "phase-3-draw",
          strategy: "contextual",
          diagnoses: ["canvas-blank"],
          changedFiles: ["useScratchpadAI.ts"],
          diffSummary: "1 file changed, 20 insertions",
          scoreImproved: true,
          scoreRegressed: false,
        },
      ],
    });

    const report = generateMorningReport(state);
    expect(report).toContain("1/10 -> 3/10 -> 5/10");
    expect(report).toContain("Net change: +4");
    expect(report).toContain("**Best score**: 5/10 (cycle 3)");
  });

  it("shows what was fixed", () => {
    const state = makeState({
      completedCycles: 2,
      bestScore: 3,
      bestScoreCycle: 2,
      currentPhase: "phase-2-talk",
      cycles: [
        {
          cycle: 1,
          startedAt: "",
          durationMs: 300000,
          stopReason: "max-iterations",
          iterations: 5,
          score: 1,
          phase: "phase-1-connect",
          strategy: "standard",
          diagnoses: [],
          changedFiles: [],
          diffSummary: "no changes",
          scoreImproved: false,
          scoreRegressed: false,
        },
        {
          cycle: 2,
          startedAt: "",
          durationMs: 300000,
          stopReason: "max-iterations",
          iterations: 5,
          score: 3,
          phase: "phase-2-talk",
          strategy: "contextual",
          diagnoses: ["fixed ws config"],
          changedFiles: ["tutor-service.ts"],
          diffSummary: "1 file changed",
          scoreImproved: true,
          scoreRegressed: false,
        },
      ],
    });

    const report = generateMorningReport(state);
    expect(report).toContain("**Cycle 2**: fixed ws config");
  });

  it("shows phase-specific next steps", () => {
    const report1 = generateMorningReport(makeState({ currentPhase: "phase-1-connect" }));
    expect(report1).toContain("WebSocket connection is still crashing");

    const report2 = generateMorningReport(makeState({ currentPhase: "phase-2-talk" }));
    expect(report2).toContain("tutor is silent");

    const report3 = generateMorningReport(makeState({ currentPhase: "phase-3-draw" }));
    expect(report3).toContain("canvas is blank");

    const report4 = generateMorningReport(makeState({ currentPhase: "phase-4-teach" }));
    expect(report4).toContain("teaching quality");
  });

  it("includes tried approaches", () => {
    const state = makeState({
      triedApproaches: ["changed transcription config", "switched model"],
    });
    const report = generateMorningReport(state);
    expect(report).toContain("changed transcription config");
    expect(report).toContain("switched model");
  });

  it("calculates wall time correctly", () => {
    const state = makeState({
      completedCycles: 1,
      cycles: [
        {
          cycle: 1,
          startedAt: "",
          durationMs: 5400000, // 1h 30m
          stopReason: "max-iterations",
          iterations: 5,
          score: 2,
          phase: "phase-1-connect",
          strategy: "standard",
          diagnoses: [],
          changedFiles: [],
          diffSummary: "",
          scoreImproved: false,
          scoreRegressed: false,
        },
      ],
    });
    const report = generateMorningReport(state);
    expect(report).toContain("**Wall time**: 1h 30m");
  });
});
