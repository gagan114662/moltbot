import { describe, expect, it } from "vitest";
import { overnightCycleToRecord } from "./overnight-adapter.js";

describe("overnightCycleToRecord", () => {
  it("converts CycleRecord-like data to record shape", () => {
    const result = overnightCycleToRecord(
      {
        cycle: 5,
        phase: "phase-3-draw",
        strategy: "contextual",
        stopReason: "max-iterations",
        iterations: 4,
        score: 6,
        diagnoses: ["Canvas not rendering", "Auto-scribe timeout"],
        changedFiles: ["src/hooks/useScratchpadAI.ts"],
        scoreImproved: true,
      },
      "run-xyz",
    );

    expect(result.domain).toBe("overnight-cycle");
    expect(result.scopeKey).toBe("run-xyz");
    expect(result.payload.cycle).toBe(5);
    expect(result.payload.phase).toBe("phase-3-draw");
    expect(result.payload.score).toBe(6);
    expect(result.payload.scoreImproved).toBe(true);
    expect(result.tags).toContain("phase:phase-3-draw");
    expect(result.tags).toContain("strategy:contextual");
    expect(result.tags).toContain("improved");
  });

  it("omits improved tag when score did not improve", () => {
    const result = overnightCycleToRecord(
      {
        cycle: 1,
        phase: "phase-1-connect",
        strategy: "standard",
        stopReason: "stall",
        iterations: 3,
        score: null,
        diagnoses: [],
        changedFiles: [],
        scoreImproved: false,
      },
      "run-1",
    );

    expect(result.tags).not.toContain("improved");
  });

  it("maps all fields correctly", () => {
    const input = {
      cycle: 10,
      phase: "phase-4-teach",
      strategy: "fallback",
      stopReason: "passed",
      iterations: 2,
      score: 8,
      diagnoses: ["Minor style issue"],
      changedFiles: ["file1.ts", "file2.ts"],
      scoreImproved: true,
    };
    const result = overnightCycleToRecord(input, "run-2");

    expect(result.payload.stopReason).toBe("passed");
    expect(result.payload.iterations).toBe(2);
    expect(result.payload.diagnoses).toEqual(["Minor style issue"]);
    expect(result.payload.changedFiles).toEqual(["file1.ts", "file2.ts"]);
  });
});
