import { describe, expect, it } from "vitest";
import { qaIterationToRecord } from "./qa-adapter.js";

describe("qaIterationToRecord", () => {
  it("converts QA iteration data to record shape", () => {
    const result = qaIterationToRecord(
      {
        iteration: 3,
        passed: false,
        nudgeSent: "Fix the WebSocket 1011 crash in sendToolResponse",
        diffFull: "--- a/src/hooks/useScratchpadAI.ts\n+++ b/src/hooks/useScratchpadAI.ts",
        changedFiles: ["src/hooks/useScratchpadAI.ts"],
        diagnoses: [
          {
            id: "ws-1011-after-tool-response",
            rootCause: "sendToolResponse crashes WS",
            severity: "critical",
            suggestedFix: "Use clientContent instead",
          },
        ],
        consoleLogs: ["[AutoScribe] outputTranscript"],
        consoleErrors: ["WebSocket error: 1011"],
        wsEvents: [{ type: "close", closeCode: 1011 }],
        scorecard: { overall: 4 },
      },
      "loop-abc",
    );

    expect(result.domain).toBe("qa-iteration");
    expect(result.scopeKey).toBe("loop-abc");
    expect(result.payload.iteration).toBe(3);
    expect(result.payload.passed).toBe(false);
    expect(result.payload.nudgeSent).toBe("Fix the WebSocket 1011 crash in sendToolResponse");
    expect(result.payload.diffFull).toContain("useScratchpadAI.ts");
    expect(result.payload.diagnoses).toHaveLength(1);
    expect(result.payload.scorecard?.overall).toBe(4);
    expect(result.tags).toContain("diagnosis:ws-1011-after-tool-response");
  });

  it("tags passed iterations", () => {
    const result = qaIterationToRecord(
      {
        iteration: 1,
        passed: true,
        nudgeSent: "",
        diffFull: "",
        changedFiles: [],
        diagnoses: [],
        consoleLogs: [],
        consoleErrors: [],
        wsEvents: [],
        scorecard: { overall: 8 },
      },
      "loop-1",
    );

    expect(result.tags).toContain("passed");
  });

  it("omits diagnosis tags when no ID provided", () => {
    const result = qaIterationToRecord(
      {
        iteration: 1,
        passed: false,
        nudgeSent: "fix",
        diffFull: "",
        changedFiles: [],
        diagnoses: [{ rootCause: "unknown", severity: "minor", suggestedFix: "investigate" }],
        consoleLogs: [],
        consoleErrors: [],
        wsEvents: [],
        scorecard: null,
      },
      "loop-1",
    );

    expect(result.tags.filter((t) => t.startsWith("diagnosis:"))).toHaveLength(0);
  });
});
