import { describe, expect, it } from "vitest";
import { extractRlmFinalVar, formatRlmFinalVarForMainAgent } from "./rlm-final-var.js";

describe("rlm-final-var", () => {
  it("parses FINAL_VAR_BEGIN/END JSON blocks", () => {
    const text = [
      "Work complete.",
      "FINAL_VAR_BEGIN",
      JSON.stringify({
        status: "ok",
        answer: "Top 3 posts summarized",
        findings: ["Post A", "Post B"],
        recursion: { depth: 2, subagentsLaunched: 3 },
      }),
      "FINAL_VAR_END",
    ].join("\n");

    const result = extractRlmFinalVar(text);
    expect(result.found).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.value?.status).toBe("ok");
    expect(result.value?.answer).toBe("Top 3 posts summarized");
    expect(result.value?.findings).toEqual(["Post A", "Post B"]);
    expect(result.value?.recursion?.depth).toBe(2);
  });

  it("parses inline FINAL_VAR payloads", () => {
    const result = extractRlmFinalVar(
      'done FINAL_VAR: {"status":"insufficient_evidence","summary":"not enough sources"}',
    );
    expect(result.found).toBe(true);
    expect(result.value?.status).toBe("insufficient_evidence");
    expect(result.value?.summary).toBe("not enough sources");
  });

  it("returns clear error when FINAL_VAR status is missing", () => {
    const result = extractRlmFinalVar('FINAL_VAR_BEGIN {"answer":"x"} FINAL_VAR_END');
    expect(result.found).toBe(true);
    expect(result.value).toBeUndefined();
    expect(result.error).toContain("missing required field `status`");
  });

  it("returns found=false when marker is absent", () => {
    const result = extractRlmFinalVar("normal reply without contract");
    expect(result.found).toBe(false);
    expect(result.value).toBeUndefined();
  });

  it("formats parsed payload for main-agent handoff", () => {
    const formatted = formatRlmFinalVarForMainAgent({
      status: "ok",
      answer: "Completed",
      findings: ["A"],
      evidence: [{ claim: "A", source: "https://example.com", confidence: "high" }],
      recursion: { depth: 1, subagentsLaunched: 2, branches: 2 },
    });
    expect(formatted).toContain("status: ok");
    expect(formatted).toContain("answer: Completed");
    expect(formatted).toContain("source=https://example.com");
    expect(formatted).toContain("recursion: depth=1, subagents=2, branches=2");
  });
});
