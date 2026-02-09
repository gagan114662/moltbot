import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FailureCluster } from "./failures-digest.js";
import {
  synthesizeRule,
  findRuleCandidates,
  clusterKey,
  isRuleDuplicate,
  loadAutoLearnedState,
  saveAutoLearnedState,
  suggestRules,
} from "./auto-learned.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "auto-learned-test-"));
}

function makeCluster(overrides: Partial<FailureCluster> = {}): FailureCluster {
  return {
    tool: "Read",
    pattern: "EISDIR: illegal operation on a directory, read",
    count: 10,
    recent: ["EISDIR error 1", "EISDIR error 2"],
    firstSeen: "2026-02-01T10:00:00Z",
    lastSeen: "2026-02-08T14:00:00Z",
    distinctDays: 4,
    ...overrides,
  };
}

function makeFailuresJsonl(entries: Array<{ tool: string; error: string; date: string }>): string {
  return entries
    .map((e) =>
      JSON.stringify({
        timestamp: `${e.date}T10:00:00Z`,
        tool: e.tool,
        error: e.error,
        input: {},
      }),
    )
    .join("\n");
}

// --- synthesizeRule ---

describe("synthesizeRule", () => {
  it("matches Read EISDIR to Navigation rule", () => {
    const result = synthesizeRule(makeCluster());
    expect(result).not.toBeNull();
    expect(result?.section).toBe("Navigation");
    expect(result?.rule).toContain("file (not directory)");
  });

  it("matches Read ENOENT to Navigation rule", () => {
    const result = synthesizeRule(makeCluster({ pattern: "ENOENT: no such file or directory" }));
    expect(result?.section).toBe("Navigation");
    expect(result?.rule).toContain("exists before reading");
  });

  it("matches Read token limit to Navigation rule", () => {
    const result = synthesizeRule(makeCluster({ pattern: "File exceeds token limit, use offset" }));
    expect(result?.section).toBe("Navigation");
    expect(result?.rule).toContain("offset/limit");
  });

  it("matches Edit unique to Editing rule", () => {
    const result = synthesizeRule(
      makeCluster({ tool: "Edit", pattern: "old_string is not unique in the file" }),
    );
    expect(result?.section).toBe("Editing");
    expect(result?.rule).toContain("surrounding context");
  });

  it("matches WebFetch 403 to Context rule", () => {
    const result = synthesizeRule(
      makeCluster({ tool: "WebFetch", pattern: "403 Forbidden access denied" }),
    );
    expect(result?.section).toBe("Context");
    expect(result?.rule).toContain("auth-protected");
  });

  it("returns generic rule for unknown but specific pattern", () => {
    const result = synthesizeRule(
      makeCluster({
        tool: "Bash",
        pattern: "npm ERR! peer dependency conflict resolution failed",
      }),
    );
    expect(result?.section).toBe("Auto-Generated");
    expect(result?.rule).toContain("When using Bash");
    expect(result?.rule).toContain("npm ERR!");
  });

  it("returns null for too-generic pattern (fewer than 3 distinct words)", () => {
    const result = synthesizeRule(makeCluster({ tool: "Bash", pattern: "Exit code 1" }));
    expect(result).toBeNull();
  });

  it("returns null for very short pattern", () => {
    const result = synthesizeRule(makeCluster({ tool: "Bash", pattern: "error" }));
    expect(result).toBeNull();
  });
});

// --- findRuleCandidates ---

describe("findRuleCandidates", () => {
  it("includes clusters meeting threshold", () => {
    const clusters = [makeCluster({ count: 10, distinctDays: 3 })];
    const candidates = findRuleCandidates(clusters);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].suggestedRule).toContain("file (not directory)");
  });

  it("excludes clusters below count threshold", () => {
    const clusters = [makeCluster({ count: 3 })];
    const candidates = findRuleCandidates(clusters);
    expect(candidates).toHaveLength(0);
  });

  it("excludes clusters below days threshold", () => {
    const clusters = [makeCluster({ distinctDays: 1 })];
    const candidates = findRuleCandidates(clusters);
    expect(candidates).toHaveLength(0);
  });

  it("excludes clusters with too-generic patterns", () => {
    const clusters = [
      makeCluster({ tool: "Bash", pattern: "Exit code 1", count: 20, distinctDays: 5 }),
    ];
    const candidates = findRuleCandidates(clusters);
    expect(candidates).toHaveLength(0);
  });

  it("respects custom thresholds", () => {
    const clusters = [makeCluster({ count: 3, distinctDays: 1 })];
    const candidates = findRuleCandidates(clusters, { minCount: 2, minDays: 1 });
    expect(candidates).toHaveLength(1);
  });

  it("sorts by count descending", () => {
    const clusters = [
      makeCluster({
        count: 5,
        distinctDays: 2,
        pattern: "EISDIR: illegal operation on a directory, read",
      }),
      makeCluster({
        tool: "Edit",
        count: 15,
        distinctDays: 3,
        pattern: "old_string is not unique in the file",
      }),
    ];
    const candidates = findRuleCandidates(clusters);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].tool).toBe("Edit");
    expect(candidates[1].tool).toBe("Read");
  });
});

// --- clusterKey ---

describe("clusterKey", () => {
  it("uses normalized pattern as key", () => {
    const key = clusterKey({ tool: "Read", pattern: "EISDIR: illegal operation" });
    expect(key).toBe("Read::EISDIR: illegal operation");
  });

  it("different tools produce different keys", () => {
    const k1 = clusterKey({ tool: "Read", pattern: "error" });
    const k2 = clusterKey({ tool: "Bash", pattern: "error" });
    expect(k1).not.toBe(k2);
  });
});

// --- isRuleDuplicate ---

describe("isRuleDuplicate", () => {
  it("detects similar rules (Jaccard > 0.7)", () => {
    const existing = ["- [2026-02-09] Verify path is a file before reading (source: manual)"];
    const dup = isRuleDuplicate("Verify path is a file (not directory) before reading", existing);
    expect(dup).toBe(true);
  });

  it("allows sufficiently different rules", () => {
    const existing = ["- [2026-02-09] Verify path is a file before reading (source: manual)"];
    const dup = isRuleDuplicate("Run tests after every code change to catch regressions", existing);
    expect(dup).toBe(false);
  });

  it("handles empty existing rules", () => {
    expect(isRuleDuplicate("Some new rule", [])).toBe(false);
  });

  it("handles empty rule text", () => {
    expect(isRuleDuplicate("", ["- existing rule"])).toBe(false);
  });
});

// --- State management ---

describe("loadAutoLearnedState / saveAutoLearnedState", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty object when file missing", () => {
    const state = loadAutoLearnedState(path.join(dir, "missing.json"));
    expect(state).toEqual({});
  });

  it("returns empty object when file is malformed", () => {
    const p = path.join(dir, "bad.json");
    fs.writeFileSync(p, "not json");
    expect(loadAutoLearnedState(p)).toEqual({});
  });

  it("round-trips state", () => {
    const p = path.join(dir, "state.json");
    const state = { "Read::EISDIR": { ruleAdded: "2026-02-08", count: 10 } };
    saveAutoLearnedState(p, state);
    expect(loadAutoLearnedState(p)).toEqual(state);
  });
});

// --- suggestRules integration ---

describe("suggestRules", () => {
  let dir: string;
  let failuresPath: string;
  let learnedPath: string;
  let statePath: string;

  beforeEach(() => {
    dir = tmpDir();
    failuresPath = path.join(dir, "failures.jsonl");
    learnedPath = path.join(dir, "LEARNED.md");
    statePath = path.join(dir, "auto-learned-state.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("adds rule when cluster meets threshold", () => {
    // 6 EISDIR failures across 3 days
    const entries = [
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-06" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-06" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-07" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-07" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-08" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-08" },
    ];
    fs.writeFileSync(failuresPath, makeFailuresJsonl(entries));
    fs.writeFileSync(
      learnedPath,
      "# LEARNED\n\n## Testing\n- [2026-02-09] Run tests (source: manual)\n",
    );

    const result = suggestRules(failuresPath, learnedPath, statePath);

    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toContain("file (not directory)");

    // Verify LEARNED.md was updated
    const content = fs.readFileSync(learnedPath, "utf-8");
    expect(content).toContain("## Navigation");
    expect(content).toContain("source: auto");
    expect(content).toContain("tool: Read");
  });

  it("adds nothing when below threshold", () => {
    const entries = [
      { tool: "Read", error: "EISDIR: illegal operation on a directory", date: "2026-02-08" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory", date: "2026-02-08" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory", date: "2026-02-08" },
    ];
    fs.writeFileSync(failuresPath, makeFailuresJsonl(entries));
    fs.writeFileSync(learnedPath, "# LEARNED\n");

    const result = suggestRules(failuresPath, learnedPath, statePath);

    expect(result.added).toHaveLength(0);
  });

  it("skips duplicate of existing rule", () => {
    const entries = [
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-06" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-06" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-07" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-07" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-08" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-08" },
    ];
    fs.writeFileSync(failuresPath, makeFailuresJsonl(entries));
    // Pre-populate with a rule that closely matches the auto-generated one
    // Auto-rule: "Verify path is a file (not directory) before reading — use ls or glob to check"
    fs.writeFileSync(
      learnedPath,
      "# LEARNED\n\n## Navigation\n- [2026-02-09] Verify path is a file not directory before reading use glob to check (source: manual)\n",
    );

    const result = suggestRules(failuresPath, learnedPath, statePath);

    expect(result.added).toHaveLength(0);
    expect(result.skippedDuplicate).toBe(1);
  });

  it("skips already-promoted cluster", () => {
    const entries = [
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-06" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-06" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-07" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-07" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-08" },
      { tool: "Read", error: "EISDIR: illegal operation on a directory, read", date: "2026-02-08" },
    ];
    fs.writeFileSync(failuresPath, makeFailuresJsonl(entries));
    fs.writeFileSync(learnedPath, "# LEARNED\n");
    // Pre-populate state with this cluster already promoted
    saveAutoLearnedState(statePath, {
      "Read::EISDIR: illegal operation on a directory, read": {
        ruleAdded: "2026-02-07",
        count: 4,
      },
    });

    const result = suggestRules(failuresPath, learnedPath, statePath);

    expect(result.added).toHaveLength(0);
    expect(result.skippedAlreadyPromoted).toBe(1);
  });

  it("caps at maxRules", () => {
    // Create two distinct failure types, both meeting threshold
    const entries = [
      ...Array.from({ length: 3 }, () => ({
        tool: "Read",
        error: "EISDIR: illegal operation on a directory, read",
        date: "2026-02-06",
      })),
      ...Array.from({ length: 3 }, () => ({
        tool: "Read",
        error: "EISDIR: illegal operation on a directory, read",
        date: "2026-02-07",
      })),
      ...Array.from({ length: 3 }, () => ({
        tool: "Edit",
        error: "old_string is not unique in the file",
        date: "2026-02-06",
      })),
      ...Array.from({ length: 3 }, () => ({
        tool: "Edit",
        error: "old_string is not unique in the file",
        date: "2026-02-07",
      })),
    ];
    fs.writeFileSync(failuresPath, makeFailuresJsonl(entries));
    fs.writeFileSync(learnedPath, "# LEARNED\n");

    const result = suggestRules(failuresPath, learnedPath, statePath, {
      maxRules: 1,
      minCount: 5,
      minDays: 2,
    });

    expect(result.added).toHaveLength(1);
  });

  it("places rules under correct section headers", () => {
    const entries = [
      ...Array.from({ length: 3 }, () => ({
        tool: "Edit",
        error: "old_string is not unique in the file",
        date: "2026-02-06",
      })),
      ...Array.from({ length: 3 }, () => ({
        tool: "Edit",
        error: "old_string is not unique in the file",
        date: "2026-02-07",
      })),
    ];
    fs.writeFileSync(failuresPath, makeFailuresJsonl(entries));
    fs.writeFileSync(
      learnedPath,
      "# LEARNED\n\n## Navigation\n- [2026-02-09] Nav rule (source: manual)\n\n## Testing\n- [2026-02-09] Test rule (source: manual)\n",
    );

    suggestRules(failuresPath, learnedPath, statePath, { minCount: 5, minDays: 2 });

    const content = fs.readFileSync(learnedPath, "utf-8");
    // Editing section should be created between Navigation and Testing
    const navIdx = content.indexOf("## Navigation");
    const editIdx = content.indexOf("## Editing");
    const testIdx = content.indexOf("## Testing");
    expect(editIdx).toBeGreaterThan(navIdx);
    expect(editIdx).toBeLessThan(testIdx);
  });

  it("creates LEARNED.md if it doesn't exist", () => {
    const entries = [
      ...Array.from({ length: 3 }, () => ({
        tool: "Read",
        error: "EISDIR: illegal operation on a directory, read",
        date: "2026-02-06",
      })),
      ...Array.from({ length: 3 }, () => ({
        tool: "Read",
        error: "EISDIR: illegal operation on a directory, read",
        date: "2026-02-07",
      })),
    ];
    fs.writeFileSync(failuresPath, makeFailuresJsonl(entries));
    // No LEARNED.md exists

    const result = suggestRules(failuresPath, learnedPath, statePath, {
      minCount: 5,
      minDays: 2,
    });

    expect(result.added).toHaveLength(1);
    expect(fs.existsSync(learnedPath)).toBe(true);
    const content = fs.readFileSync(learnedPath, "utf-8");
    expect(content).toContain("# LEARNED");
    expect(content).toContain("## Navigation");
  });

  it("persists state after adding rules", () => {
    const entries = [
      ...Array.from({ length: 3 }, () => ({
        tool: "Read",
        error: "EISDIR: illegal operation on a directory, read",
        date: "2026-02-06",
      })),
      ...Array.from({ length: 3 }, () => ({
        tool: "Read",
        error: "EISDIR: illegal operation on a directory, read",
        date: "2026-02-07",
      })),
    ];
    fs.writeFileSync(failuresPath, makeFailuresJsonl(entries));
    fs.writeFileSync(learnedPath, "# LEARNED\n");

    suggestRules(failuresPath, learnedPath, statePath, { minCount: 5, minDays: 2 });

    const state = loadAutoLearnedState(statePath);
    const keys = Object.keys(state);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("Read::EISDIR");
    expect(state[keys[0]].count).toBe(6);
  });

  it("returns empty result for empty failures file", () => {
    fs.writeFileSync(failuresPath, "");
    const result = suggestRules(failuresPath, learnedPath, statePath);
    expect(result.added).toHaveLength(0);
    expect(result.skippedDuplicate).toBe(0);
    expect(result.skippedAlreadyPromoted).toBe(0);
  });
});
