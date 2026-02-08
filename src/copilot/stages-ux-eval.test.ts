import { describe, expect, it } from "vitest";
import { formatUxReport, parseUxEvalOutput } from "./stages-ux-eval.js";

describe("parseUxEvalOutput", () => {
  it("parses structured output with verdict, findings, and summary", () => {
    const output = [
      "VERDICT: fail",
      "FINDING: [critical] - Age 7 hangs on Preparing for >60s",
      "FINDING: [major] - Age 5 questions too advanced (tectonic plates)",
      "FINDING: [minor] - Loading spinner off-center",
      "SUMMARY: 2 of 5 ages tested hang. Backend times out for certain combos.",
    ].join("\n");

    const result = parseUxEvalOutput(output);

    expect(result.verdict).toBe("fail");
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0]).toEqual({
      severity: "critical",
      description: "Age 7 hangs on Preparing for >60s",
    });
    expect(result.findings[1]).toEqual({
      severity: "major",
      description: "Age 5 questions too advanced (tectonic plates)",
    });
    expect(result.findings[2]).toEqual({
      severity: "minor",
      description: "Loading spinner off-center",
    });
    expect(result.summary).toContain("2 of 5 ages");
  });

  it("parses pass verdict with no findings", () => {
    const output = "VERDICT: pass\nSUMMARY: All flows work correctly.";
    const result = parseUxEvalOutput(output);

    expect(result.verdict).toBe("pass");
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toBe("All flows work correctly.");
  });

  it("parses partial verdict", () => {
    const output = [
      "VERDICT: partial",
      "FINDING: [major] - Some ages fail to load",
      "SUMMARY: Most flows work but intermittent issues remain.",
    ].join("\n");

    const result = parseUxEvalOutput(output);
    expect(result.verdict).toBe("partial");
    expect(result.findings).toHaveLength(1);
  });

  it("handles unstructured output by inferring verdict", () => {
    const output = "The app crashed when I clicked the button. Error timeout on page load.";
    const result = parseUxEvalOutput(output);

    expect(result.verdict).toBe("fail");
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain("crashed");
  });

  it("infers partial from ambiguous output", () => {
    const output = "Some pages loaded but intermittent issues with geography.";
    const result = parseUxEvalOutput(output);
    expect(result.verdict).toBe("partial");
  });

  it("handles empty output", () => {
    const result = parseUxEvalOutput("");
    expect(result.verdict).toBe("fail");
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toBe("");
  });

  it("handles case-insensitive parsing", () => {
    const output = "verdict: PASS\nfinding: [CRITICAL] - Big bug\nsummary: All good otherwise.";
    const result = parseUxEvalOutput(output);

    expect(result.verdict).toBe("pass");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("critical");
  });
});

describe("formatUxReport", () => {
  it("formats a fail report with findings and fix list", () => {
    const report = formatUxReport({
      verdict: "fail",
      findings: [
        { severity: "critical", description: "Age 7 hangs on Preparing" },
        { severity: "major", description: "Questions too hard for age 5" },
        { severity: "minor", description: "Spinner alignment" },
      ],
      summary: "Backend timeouts for some age/topic combos.",
    });

    expect(report).toContain("VERDICT: FAIL (3 issues found)");
    expect(report).toContain("CRITICAL: Age 7 hangs on Preparing");
    expect(report).toContain("MAJOR: Questions too hard for age 5");
    expect(report).toContain("MINOR: Spinner alignment");
    expect(report).toContain("What to fix:");
    expect(report).toContain("1. Age 7 hangs on Preparing");
    expect(report).toContain("2. Questions too hard for age 5");
    // Minor findings are NOT in "What to fix"
    expect(report).not.toContain("3. Spinner alignment");
  });

  it("formats a pass report", () => {
    const report = formatUxReport({
      verdict: "pass",
      findings: [],
      summary: "All flows work correctly.",
    });

    expect(report).toContain("VERDICT: PASS");
    expect(report).toContain("SUMMARY: All flows work correctly.");
    expect(report).not.toContain("What to fix:");
  });

  it("formats partial with singular issue count", () => {
    const report = formatUxReport({
      verdict: "partial",
      findings: [{ severity: "major", description: "One page slow" }],
      summary: "Mostly works.",
    });

    expect(report).toContain("PARTIAL (1 issue found)");
  });
});
