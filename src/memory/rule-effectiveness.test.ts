import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AutoLearnedState } from "./auto-learned.js";
import type { FailureEntry } from "./failures-digest.js";
import { makeRuleId } from "./auto-learned.js";
import {
  countPostPromotionFailures,
  countFailuresInWindow,
  computeRate,
  assessRule,
  retireRuleInLearned,
  checkEffectiveness,
} from "./rule-effectiveness.js";

// --- Helpers ---

function makeEntry(tool: string, error: string, date: string): FailureEntry {
  return {
    tool,
    error,
    timestamp: `${date}T12:00:00.000Z`,
    input: {},
  };
}

function makeFailuresJsonl(entries: FailureEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

// --- Tests ---

describe("countPostPromotionFailures", () => {
  const entries: FailureEntry[] = [
    makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-05"),
    makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-10"),
    makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-15"),
    makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-20"),
    makeEntry("Edit", "old_string is not unique", "2026-01-15"),
  ];

  it("counts only failures after the given date", () => {
    // normalizeError will produce a key like "Read::EISDIR: illegal operation on a directory"
    // but we need to use the exact normalized form
    const key = "Read::EISDIR: illegal operation on a directory";
    const count = countPostPromotionFailures(entries, key, "2026-01-10T12:00:00.000Z");
    expect(count).toBe(2); // Jan 15 + Jan 20
  });

  it("returns 0 when no failures match after date", () => {
    const key = "Read::EISDIR: illegal operation on a directory";
    const count = countPostPromotionFailures(entries, key, "2026-01-20T12:00:00.000Z");
    expect(count).toBe(0);
  });

  it("ignores entries for different cluster keys", () => {
    const key = "Edit::old_string is not unique";
    const count = countPostPromotionFailures(entries, key, "2026-01-01T00:00:00.000Z");
    expect(count).toBe(1);
  });
});

describe("countFailuresInWindow", () => {
  const entries: FailureEntry[] = [
    makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-05"),
    makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-10"),
    makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-15"),
  ];

  it("counts failures within the date range", () => {
    const key = "Read::EISDIR: illegal operation on a directory";
    const count = countFailuresInWindow(entries, key, "2026-01-05", "2026-01-10T23:59:59.999Z");
    expect(count).toBe(2);
  });

  it("returns 0 for empty window", () => {
    const key = "Read::EISDIR: illegal operation on a directory";
    const count = countFailuresInWindow(entries, key, "2026-02-01", "2026-02-28");
    expect(count).toBe(0);
  });
});

describe("computeRate", () => {
  it("computes failures per day", () => {
    const rate = computeRate(10, "2026-01-01", "2026-01-11");
    expect(rate).toBe(1); // 10 failures / 10 days
  });

  it("handles same-day window (returns count as rate)", () => {
    const rate = computeRate(5, "2026-01-01", "2026-01-01");
    expect(rate).toBe(5); // 0 days → return count directly
  });

  it("handles single day span", () => {
    const rate = computeRate(3, "2026-01-01", "2026-01-02");
    expect(rate).toBe(3); // 3 failures / 1 day
  });
});

describe("assessRule", () => {
  it('returns "inconclusive" when observation window too short', () => {
    expect(
      assessRule({
        preRate: 1.0,
        postRate: 0.1,
        daysSincePromotion: 3,
        postCount: 10,
      }),
    ).toBe("inconclusive");
  });

  it('returns "inconclusive" when post failures too few', () => {
    expect(
      assessRule({
        preRate: 1.0,
        postRate: 0.1,
        daysSincePromotion: 14,
        postCount: 2,
      }),
    ).toBe("inconclusive");
  });

  it('returns "effective" when post-rate < 50% of pre-rate', () => {
    expect(
      assessRule({
        preRate: 2.0,
        postRate: 0.5,
        daysSincePromotion: 10,
        postCount: 5,
      }),
    ).toBe("effective");
  });

  it('returns "ineffective" when post-rate >= pre-rate', () => {
    expect(
      assessRule({
        preRate: 1.0,
        postRate: 1.2,
        daysSincePromotion: 10,
        postCount: 12,
      }),
    ).toBe("ineffective");
  });

  it('returns "ineffective" when post-rate is between 50% and 100% of pre-rate', () => {
    expect(
      assessRule({
        preRate: 2.0,
        postRate: 1.5,
        daysSincePromotion: 10,
        postCount: 15,
      }),
    ).toBe("ineffective");
  });

  it("respects custom thresholds", () => {
    expect(
      assessRule({
        preRate: 1.0,
        postRate: 0.1,
        daysSincePromotion: 3,
        postCount: 1,
        minObservationDays: 2,
        minPostFailures: 1,
      }),
    ).toBe("effective");
  });
});

describe("retireRuleInLearned", () => {
  let tmpDir: string;
  let learnedPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "effectiveness-test-"));
    learnedPath = path.join(tmpDir, "LEARNED.md");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends retired tag to auto-generated rule", () => {
    fs.writeFileSync(
      learnedPath,
      [
        "# LEARNED",
        "",
        "## Navigation",
        "- [2026-01-10] Verify path is a file (source: auto, tool: Read, count: 8)",
        "",
      ].join("\n"),
    );

    const result = retireRuleInLearned(learnedPath, "Verify path is a file");
    expect(result).toBe(true);

    const content = fs.readFileSync(learnedPath, "utf-8");
    expect(content).toContain("(retired: ");
    expect(content).toContain("Verify path is a file");
  });

  it("skips manual rules", () => {
    fs.writeFileSync(
      learnedPath,
      [
        "# LEARNED",
        "",
        "## Navigation",
        "- [2026-01-10] Verify path is a file (source: manual, migrated)",
        "",
      ].join("\n"),
    );

    const result = retireRuleInLearned(learnedPath, "Verify path is a file");
    expect(result).toBe(false);
  });

  it("skips already-retired rules", () => {
    const original = [
      "# LEARNED",
      "",
      "## Navigation",
      "- [2026-01-10] Verify path is a file (source: auto, tool: Read, count: 8) (retired: 2026-01-20)",
      "",
    ].join("\n");
    fs.writeFileSync(learnedPath, original);

    const result = retireRuleInLearned(learnedPath, "Verify path is a file");
    expect(result).toBe(false);
    expect(fs.readFileSync(learnedPath, "utf-8")).toBe(original);
  });

  it("returns false when file does not exist", () => {
    expect(retireRuleInLearned(path.join(tmpDir, "missing.md"), "anything")).toBe(false);
  });
});

describe("checkEffectiveness integration", () => {
  let tmpDir: string;
  let failuresPath: string;
  let learnedPath: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "effectiveness-integ-"));
    failuresPath = path.join(tmpDir, "failures.jsonl");
    learnedPath = path.join(tmpDir, "LEARNED.md");
    statePath = path.join(tmpDir, "auto-learned-state.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects effective rule when post-rate drops", () => {
    // 10 failures in 10 days before promotion (rate = 1.0/day)
    const preFails = Array.from({ length: 10 }, (_, i) =>
      makeEntry(
        "Read",
        "EISDIR: illegal operation on a directory",
        `2026-01-${String(i + 1).padStart(2, "0")}`,
      ),
    );
    // 2 failures in 14 days after promotion (rate ≈ 0.14/day)
    const postFails = [
      makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-15"),
      makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-20"),
      makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-22"),
    ];
    fs.writeFileSync(failuresPath, makeFailuresJsonl([...preFails, ...postFails]));

    const key = "Read::EISDIR: illegal operation on a directory";
    const state: AutoLearnedState = {
      [key]: {
        ruleAdded: "2026-01-11",
        count: 10,
        countAtPromotion: 10,
        ruleId: makeRuleId(key, "Verify path is a file"),
        ruleText: "Verify path is a file",
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(state));

    fs.writeFileSync(
      learnedPath,
      "# LEARNED\n\n## Navigation\n- [2026-01-11] Verify path is a file (source: auto, tool: Read, count: 10)\n",
    );

    const results = checkEffectiveness({
      failuresJsonlPath: failuresPath,
      learnedMdPath: learnedPath,
      statePath,
    });

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("effective");
    expect(results[0].postCount).toBe(3);
    expect(results[0].daysSincePromotion).toBeGreaterThan(0);
  });

  it("returns inconclusive when too few days since promotion", () => {
    const today = new Date().toISOString().slice(0, 10);
    const entries = [
      makeEntry("Edit", "old_string is not unique", today),
      makeEntry("Edit", "old_string is not unique", today),
      makeEntry("Edit", "old_string is not unique", today),
      makeEntry("Edit", "old_string is not unique", today),
    ];
    fs.writeFileSync(failuresPath, makeFailuresJsonl(entries));

    const key = "Edit::old_string is not unique";
    const state: AutoLearnedState = {
      [key]: {
        ruleAdded: today,
        count: 5,
        countAtPromotion: 5,
        ruleId: makeRuleId(key, "Ensure uniqueness"),
        ruleText: "Ensure uniqueness",
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(state));
    fs.writeFileSync(learnedPath, "# LEARNED\n");

    const results = checkEffectiveness({
      failuresJsonlPath: failuresPath,
      learnedMdPath: learnedPath,
      statePath,
    });

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("inconclusive");
  });

  it("retires ineffective rule and stores retiredAt in state", () => {
    // Pre-promotion: 10 failures over 10 days (rate = 1.0/day)
    const preFails = Array.from({ length: 10 }, (_, i) =>
      makeEntry("Edit", "old_string is not unique", `2026-01-${String(i + 1).padStart(2, "0")}`),
    );
    // Post-promotion: 10 failures over 10 days (rate = 1.0/day) → ineffective
    const postFails = Array.from({ length: 10 }, (_, i) =>
      makeEntry("Edit", "old_string is not unique", `2026-01-${String(i + 12).padStart(2, "0")}`),
    );
    fs.writeFileSync(failuresPath, makeFailuresJsonl([...preFails, ...postFails]));

    const key = "Edit::old_string is not unique";
    const ruleText = "Provide enough surrounding context in edit old_string to ensure uniqueness";
    const state: AutoLearnedState = {
      [key]: {
        ruleAdded: "2026-01-11",
        count: 10,
        countAtPromotion: 10,
        ruleId: makeRuleId(key, ruleText),
        ruleText,
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(state));

    fs.writeFileSync(
      learnedPath,
      `# LEARNED\n\n## Editing\n- [2026-01-11] ${ruleText} (source: auto, tool: Edit, count: 10)\n`,
    );

    const results = checkEffectiveness({
      failuresJsonlPath: failuresPath,
      learnedMdPath: learnedPath,
      statePath,
      retire: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("ineffective");

    // Check LEARNED.md has retired tag
    const learnedContent = fs.readFileSync(learnedPath, "utf-8");
    expect(learnedContent).toContain("(retired:");

    // Check state has retiredAt (feedback #2)
    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf-8")) as AutoLearnedState;
    expect(updatedState[key].retiredAt).toBeTruthy();
    expect(updatedState[key].verdict).toBe("ineffective");
  });

  it("skips already-retired rules in state (feedback #2)", () => {
    const entries = [makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-20")];
    fs.writeFileSync(failuresPath, makeFailuresJsonl(entries));

    const key = "Read::EISDIR: illegal operation on a directory";
    const state: AutoLearnedState = {
      [key]: {
        ruleAdded: "2026-01-01",
        count: 10,
        countAtPromotion: 10,
        ruleId: makeRuleId(key, "Verify path"),
        ruleText: "Verify path",
        retiredAt: "2026-01-15",
        verdict: "ineffective",
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(state));
    fs.writeFileSync(learnedPath, "# LEARNED\n");

    const results = checkEffectiveness({
      failuresJsonlPath: failuresPath,
      learnedMdPath: learnedPath,
      statePath,
    });

    expect(results).toHaveLength(0); // skipped retired
  });

  it("does not retire on inconclusive even with retire=true (feedback #3)", () => {
    const today = new Date().toISOString().slice(0, 10);
    // Only 1 post-promotion failure (below minPostFailures)
    const entries = [makeEntry("Read", "EISDIR: illegal operation on a directory", today)];
    fs.writeFileSync(failuresPath, makeFailuresJsonl(entries));

    const key = "Read::EISDIR: illegal operation on a directory";
    const ruleText = "Verify path is a file before reading";
    const state: AutoLearnedState = {
      [key]: {
        ruleAdded: today,
        count: 5,
        countAtPromotion: 5,
        ruleId: makeRuleId(key, ruleText),
        ruleText,
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(state));

    fs.writeFileSync(
      learnedPath,
      `# LEARNED\n\n## Navigation\n- [${today}] ${ruleText} (source: auto, tool: Read, count: 5)\n`,
    );

    const results = checkEffectiveness({
      failuresJsonlPath: failuresPath,
      learnedMdPath: learnedPath,
      statePath,
      retire: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("inconclusive");

    // Should NOT have retired
    const learnedContent = fs.readFileSync(learnedPath, "utf-8");
    expect(learnedContent).not.toContain("retired:");

    // State should NOT have retiredAt
    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf-8")) as AutoLearnedState;
    expect(updatedState[key].retiredAt).toBeUndefined();
  });

  it("handles multiple rules with different verdicts", () => {
    // Rule 1: effective (low post failures)
    const rule1Pre = Array.from({ length: 10 }, (_, i) =>
      makeEntry(
        "Read",
        "EISDIR: illegal operation on a directory",
        `2026-01-${String(i + 1).padStart(2, "0")}`,
      ),
    );
    const rule1Post = [
      makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-15"),
      makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-18"),
      makeEntry("Read", "EISDIR: illegal operation on a directory", "2026-01-25"),
    ];

    // Rule 2: ineffective (same rate post)
    const rule2Pre = Array.from({ length: 10 }, (_, i) =>
      makeEntry("Edit", "old_string is not unique", `2026-01-${String(i + 1).padStart(2, "0")}`),
    );
    const rule2Post = Array.from({ length: 10 }, (_, i) =>
      makeEntry("Edit", "old_string is not unique", `2026-01-${String(i + 12).padStart(2, "0")}`),
    );

    fs.writeFileSync(
      failuresPath,
      makeFailuresJsonl([...rule1Pre, ...rule1Post, ...rule2Pre, ...rule2Post]),
    );

    const key1 = "Read::EISDIR: illegal operation on a directory";
    const key2 = "Edit::old_string is not unique";
    const state: AutoLearnedState = {
      [key1]: {
        ruleAdded: "2026-01-11",
        count: 10,
        countAtPromotion: 10,
        ruleId: makeRuleId(key1, "Verify path"),
        ruleText: "Verify path",
      },
      [key2]: {
        ruleAdded: "2026-01-11",
        count: 10,
        countAtPromotion: 10,
        ruleId: makeRuleId(key2, "Ensure context"),
        ruleText: "Ensure context",
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(state));
    fs.writeFileSync(learnedPath, "# LEARNED\n");

    const results = checkEffectiveness({
      failuresJsonlPath: failuresPath,
      learnedMdPath: learnedPath,
      statePath,
    });

    expect(results).toHaveLength(2);
    const verdicts = results.map((r) => r.verdict).toSorted();
    expect(verdicts).toEqual(["effective", "ineffective"]);
  });

  it("updates state fields after check", () => {
    const preFails = Array.from({ length: 5 }, (_, i) =>
      makeEntry(
        "Read",
        "EISDIR: illegal operation on a directory",
        `2026-01-${String(i + 1).padStart(2, "0")}`,
      ),
    );
    const postFails = Array.from({ length: 4 }, (_, i) =>
      makeEntry(
        "Read",
        "EISDIR: illegal operation on a directory",
        `2026-01-${String(i + 12).padStart(2, "0")}`,
      ),
    );
    fs.writeFileSync(failuresPath, makeFailuresJsonl([...preFails, ...postFails]));

    const key = "Read::EISDIR: illegal operation on a directory";
    const state: AutoLearnedState = {
      [key]: {
        ruleAdded: "2026-01-11",
        count: 5,
        countAtPromotion: 5,
        ruleId: makeRuleId(key, "Verify path"),
        ruleText: "Verify path",
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(state));
    fs.writeFileSync(learnedPath, "# LEARNED\n");

    checkEffectiveness({
      failuresJsonlPath: failuresPath,
      learnedMdPath: learnedPath,
      statePath,
    });

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf-8")) as AutoLearnedState;
    const entry = updatedState[key];
    expect(entry.postPromotionCount).toBe(4);
    expect(entry.lastChecked).toBeTruthy();
    expect(entry.verdict).toBeTruthy();
  });

  it("handles empty failures file gracefully", () => {
    fs.writeFileSync(failuresPath, "");
    const key = "Read::EISDIR";
    const state: AutoLearnedState = {
      [key]: { ruleAdded: "2026-01-01", count: 5, countAtPromotion: 5 },
    };
    fs.writeFileSync(statePath, JSON.stringify(state));
    fs.writeFileSync(learnedPath, "# LEARNED\n");

    const results = checkEffectiveness({
      failuresJsonlPath: failuresPath,
      learnedMdPath: learnedPath,
      statePath,
    });

    expect(results).toHaveLength(1);
    expect(results[0].postCount).toBe(0);
  });
});

describe("makeRuleId (feedback #4)", () => {
  it("produces a stable ID from cluster key + rule text", () => {
    const id1 = makeRuleId("Read::EISDIR", "Verify path is a file");
    const id2 = makeRuleId("Read::EISDIR", "Verify path is a file");
    expect(id1).toBe(id2);
  });

  it("produces different IDs for different rule texts", () => {
    const id1 = makeRuleId("Read::EISDIR", "Verify path is a file");
    const id2 = makeRuleId("Read::EISDIR", "Check file existence");
    expect(id1).not.toBe(id2);
  });

  it("includes cluster key and hash", () => {
    const id = makeRuleId("Read::EISDIR", "Verify path");
    expect(id).toMatch(/^Read::EISDIR::[a-f0-9]{8}$/);
  });
});
