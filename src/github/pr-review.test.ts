import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { validateWebhookSignature } from "./auth.js";
import { buildPositionMap, parseLlmFindings } from "./pr-review.js";
import { clearStandardsCache, parseStandards } from "./standards.js";

// ---------------------------------------------------------------------------
// buildPositionMap
// ---------------------------------------------------------------------------

describe("buildPositionMap", () => {
  it("maps added lines to correct diff positions", () => {
    // Simple diff: add 2 lines at line 5
    const patch = [
      "@@ -3,4 +3,6 @@ function foo() {",
      "   const a = 1;",
      "   const b = 2;",
      "+  const c = 3;",
      "+  const d = 4;",
      "   return a + b;",
      " }",
    ].join("\n");

    const map = buildPositionMap(patch);

    // Line 3 = context line, position 2 (hunk header is position 1)
    expect(map.get(3)).toBe(2);
    // Line 4 = context line, position 3
    expect(map.get(4)).toBe(3);
    // Line 5 = added line, position 4
    expect(map.get(5)).toBe(4);
    // Line 6 = added line, position 5
    expect(map.get(6)).toBe(5);
    // Line 7 = context line, position 6
    expect(map.get(7)).toBe(6);
  });

  it("handles removed lines (no right-side mapping)", () => {
    const patch = ["@@ -1,4 +1,3 @@", " line1", "-line2", " line3", " line4"].join("\n");

    const map = buildPositionMap(patch);

    // line1 is right-side line 1, position 2
    expect(map.get(1)).toBe(2);
    // line2 removed — position 3 but no right-side mapping
    // line3 is right-side line 2, position 4
    expect(map.get(2)).toBe(4);
    // line4 is right-side line 3, position 5
    expect(map.get(3)).toBe(5);
  });

  it("handles multiple hunks", () => {
    const patch = [
      "@@ -1,3 +1,3 @@",
      " line1",
      "-old",
      "+new",
      " line3",
      "@@ -10,3 +10,4 @@",
      " line10",
      "+inserted",
      " line11",
      " line12",
    ].join("\n");

    const map = buildPositionMap(patch);

    // First hunk: line 1 = pos 2, line 2 (new) = pos 4, line 3 = pos 5
    expect(map.get(1)).toBe(2);
    expect(map.get(2)).toBe(4);
    expect(map.get(3)).toBe(5);

    // Second hunk: hunk header is pos 6
    // line10 = pos 7, inserted (line 11) = pos 8, line11 (now 12) = pos 9
    expect(map.get(10)).toBe(7);
    expect(map.get(11)).toBe(8);
    expect(map.get(12)).toBe(9);
  });

  it("returns empty map for empty patch", () => {
    expect(buildPositionMap("").size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateWebhookSignature
// ---------------------------------------------------------------------------

describe("validateWebhookSignature", () => {
  const secret = "test-secret-123";

  function sign(payload: string): string {
    return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  }

  it("accepts valid signature", () => {
    const payload = '{"action":"opened"}';
    expect(validateWebhookSignature(payload, sign(payload), secret)).toBe(true);
  });

  it("rejects invalid signature", () => {
    const payload = '{"action":"opened"}';
    expect(validateWebhookSignature(payload, "sha256=deadbeef0000", secret)).toBe(false);
  });

  it("rejects missing signature", () => {
    expect(validateWebhookSignature("{}", undefined, secret)).toBe(false);
  });

  it("rejects signature without sha256= prefix", () => {
    const payload = "test";
    const hash = createHmac("sha256", secret).update(payload).digest("hex");
    expect(validateWebhookSignature(payload, hash, secret)).toBe(false);
  });

  it("rejects tampered payload", () => {
    const payload = '{"action":"opened"}';
    const sig = sign(payload);
    expect(validateWebhookSignature('{"action":"closed"}', sig, secret)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseStandards
// ---------------------------------------------------------------------------

describe("parseStandards", () => {
  it("parses ## headings into rules", () => {
    const md = [
      "# Team Standards",
      "",
      "## No console.log in production",
      "Remove all console.log statements before merging.",
      "Use the logger utility instead.",
      "",
      "## Error handling",
      "Scope: src/**/*.ts",
      "Always wrap async operations in try/catch.",
    ].join("\n");

    const standards = parseStandards(md);
    expect(standards).toHaveLength(2);
    expect(standards[0].title).toBe("No console.log in production");
    expect(standards[0].description).toContain("Remove all console.log");
    expect(standards[0].scope).toBeUndefined();
    expect(standards[1].title).toBe("Error handling");
    expect(standards[1].scope).toBe("src/**/*.ts");
    expect(standards[1].description).toContain("try/catch");
  });

  it("returns empty array for empty file", () => {
    expect(parseStandards("")).toHaveLength(0);
  });

  it("returns empty array for file with no ## headings", () => {
    expect(parseStandards("Just some text\nwithout headings")).toHaveLength(0);
  });

  it("handles single rule", () => {
    const standards = parseStandards("## Rule one\nDescription here.");
    expect(standards).toHaveLength(1);
    expect(standards[0].title).toBe("Rule one");
  });

  afterEach(() => {
    clearStandardsCache();
  });
});

// ---------------------------------------------------------------------------
// parseLlmFindings
// ---------------------------------------------------------------------------

describe("parseLlmFindings", () => {
  const positionMap = new Map<number, number>([
    [5, 4],
    [6, 5],
    [10, 8],
  ]);

  it("parses valid JSON array from LLM response", () => {
    const response = `Here are my findings:
\`\`\`json
[
  { "line": 5, "severity": "major", "message": "Missing null check" },
  { "line": 10, "severity": "suggestion", "message": "Consider using const" }
]
\`\`\``;

    const findings = parseLlmFindings(response, "src/foo.ts", positionMap);
    expect(findings).toHaveLength(2);
    expect(findings[0].path).toBe("src/foo.ts");
    expect(findings[0].position).toBe(4);
    expect(findings[0].severity).toBe("major");
    expect(findings[1].position).toBe(8);
    expect(findings[1].severity).toBe("suggestion");
  });

  it("skips findings for lines not in diff", () => {
    const response = '[{ "line": 999, "severity": "critical", "message": "Bug" }]';
    const findings = parseLlmFindings(response, "src/foo.ts", positionMap);
    expect(findings).toHaveLength(0);
  });

  it("returns empty for non-JSON response", () => {
    const findings = parseLlmFindings("No issues found.", "src/foo.ts", positionMap);
    expect(findings).toHaveLength(0);
  });

  it("returns empty for empty JSON array", () => {
    const findings = parseLlmFindings("[]", "src/foo.ts", positionMap);
    expect(findings).toHaveLength(0);
  });

  it("normalizes unknown severity to suggestion", () => {
    const response = '[{ "line": 5, "severity": "info", "message": "FYI" }]';
    const findings = parseLlmFindings(response, "src/foo.ts", positionMap);
    expect(findings[0].severity).toBe("suggestion");
  });
});
