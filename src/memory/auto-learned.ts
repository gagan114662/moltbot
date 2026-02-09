/**
 * Phase B: Auto-rule generation from recurring failure patterns.
 *
 * Analyses failure clusters (from failures-digest.ts) and promotes
 * recurring patterns into LEARNED.md rules with deduplication,
 * state tracking, and section routing.
 */
import fs from "node:fs";
import { type FailureCluster, clusterFailures, parseFailuresJsonl } from "./failures-digest.js";

// --- Types ---

export type RuleCandidate = {
  tool: string;
  pattern: string;
  count: number;
  distinctDays: number;
  lastSeen: string;
  suggestedRule: string;
  section: string;
};

export type AutoLearnedState = Record<string, { ruleAdded: string; count: number }>;

export type SuggestResult = {
  added: string[];
  skippedDuplicate: number;
  skippedAlreadyPromoted: number;
};

// --- Constants ---

const DEFAULT_MIN_COUNT = 5;
const DEFAULT_MIN_DAYS = 2;
const DEFAULT_MAX_RULES = 5;
const MIN_PATTERN_WORDS = 3; // patterns with fewer distinct words are too generic

/** Canonical section order for LEARNED.md (keeps file tidy). */
const SECTION_ORDER = [
  "Navigation",
  "Editing",
  "Testing",
  "Git",
  "Quality",
  "Context",
  "Integration",
  "Architecture",
  "Auto-Generated",
];

// --- Template rules ---

type RuleTemplate = {
  tool: string;
  keywords: string[];
  section: string;
  rule: string;
};

/**
 * Each template matches when the tool matches AND at least one keyword appears
 * in the normalized error pattern. Keywords are checked with `some` (OR logic).
 */
const RULE_TEMPLATES: RuleTemplate[] = [
  {
    tool: "Read",
    keywords: ["eisdir", "illegal operation on a directory"],
    section: "Navigation",
    rule: "Verify path is a file (not directory) before reading — use ls or glob to check",
  },
  {
    tool: "Read",
    keywords: ["enoent", "no such file"],
    section: "Navigation",
    rule: "Verify file exists before reading — use glob to confirm path",
  },
  {
    tool: "Read",
    keywords: ["token", "too large", "exceeds"],
    section: "Navigation",
    rule: "Use offset/limit for large files — avoid reading entire file at once",
  },
  {
    tool: "Edit",
    keywords: ["not unique", "unique"],
    section: "Editing",
    rule: "Provide enough surrounding context in edit old_string to ensure uniqueness",
  },
  {
    tool: "Edit",
    keywords: ["not found", "old_string"],
    section: "Editing",
    rule: "Read the file before editing — verify the exact text you want to replace exists",
  },
  {
    tool: "WebFetch",
    keywords: ["403", "forbidden"],
    section: "Context",
    rule: "Check URL accessibility before fetching — 403 errors indicate auth-protected resources",
  },
  {
    tool: "WebFetch",
    keywords: ["404", "not found"],
    section: "Context",
    rule: "Validate URLs before fetching — check that the resource path is correct",
  },
  {
    tool: "WebFetch",
    keywords: ["timeout", "timed out"],
    section: "Context",
    rule: "Add timeout handling for web fetches — retry or fall back on timeout",
  },
  {
    tool: "Bash",
    keywords: ["permission denied"],
    section: "Quality",
    rule: "Check file permissions before running commands that need write access",
  },
  {
    tool: "Bash",
    keywords: ["command not found"],
    section: "Quality",
    rule: "Verify command availability before running — check PATH or install missing tools",
  },
  {
    tool: "Glob",
    keywords: ["no files", "no matches"],
    section: "Navigation",
    rule: "Broaden glob patterns when initial search returns no results — try parent directories",
  },
];

// --- Core functions ---

/**
 * Synthesize an actionable rule from a failure cluster using template matching.
 * Returns null if the pattern is too generic to produce a useful rule.
 */
export function synthesizeRule(cluster: FailureCluster): { rule: string; section: string } | null {
  const patternLower = cluster.pattern.toLowerCase();

  // Try template matching: find first template where tool matches and any keyword appears
  for (const tmpl of RULE_TEMPLATES) {
    if (cluster.tool !== tmpl.tool) {
      continue;
    }
    const anyMatch = tmpl.keywords.some((kw) => patternLower.includes(kw));
    if (anyMatch) {
      return { rule: tmpl.rule, section: tmpl.section };
    }
  }

  // Actionable check (user feedback #2): skip if pattern has too few distinct words
  const patternWords = new Set(
    patternLower
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
  if (patternWords.size < MIN_PATTERN_WORDS) {
    return null; // too generic (e.g., "Exit code 1")
  }

  // Default template for unknown but specific-enough patterns
  return {
    rule: `When using ${cluster.tool}, watch for: ${cluster.pattern}`,
    section: "Auto-Generated",
  };
}

/**
 * Find clusters that meet the promotion threshold and synthesize rules.
 */
export function findRuleCandidates(
  clusters: FailureCluster[],
  threshold?: { minCount?: number; minDays?: number },
): RuleCandidate[] {
  const minCount = threshold?.minCount ?? DEFAULT_MIN_COUNT;
  const minDays = threshold?.minDays ?? DEFAULT_MIN_DAYS;

  const candidates: RuleCandidate[] = [];

  for (const cluster of clusters) {
    if (cluster.count < minCount || cluster.distinctDays < minDays) {
      continue;
    }

    const synthesis = synthesizeRule(cluster);
    if (!synthesis) {
      continue; // too generic
    }

    candidates.push({
      tool: cluster.tool,
      pattern: cluster.pattern,
      count: cluster.count,
      distinctDays: cluster.distinctDays,
      lastSeen: cluster.lastSeen,
      suggestedRule: synthesis.rule,
      section: synthesis.section,
    });
  }

  // Sort by count descending (most frequent first)
  return candidates.toSorted((a, b) => b.count - a.count);
}

/**
 * Stable key for a cluster — uses the normalized pattern (user feedback #4).
 */
export function clusterKey(cluster: Pick<FailureCluster, "tool" | "pattern">): string {
  return `${cluster.tool}::${cluster.pattern}`;
}

/**
 * Check if a rule is a duplicate of any existing rule using Jaccard word similarity.
 * Reuses the same algorithm as shared-context.ts appendSharedRule but standalone.
 */
export function isRuleDuplicate(rule: string, existingRules: string[]): boolean {
  const ruleWords = extractWords(rule);
  if (ruleWords.size === 0) {
    return false;
  }

  for (const existing of existingRules) {
    const existingWords = extractWords(existing);
    if (existingWords.size === 0) {
      continue;
    }
    const intersection = [...ruleWords].filter((w) => existingWords.has(w)).length;
    const jaccard = intersection / Math.max(ruleWords.size, 1);
    if (jaccard > 0.7) {
      return true;
    }
  }
  return false;
}

function extractWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[[\]()]/g, "")
      .split(/\s+/)
      .filter(Boolean),
  );
}

// --- State management ---

export function loadAutoLearnedState(statePath: string): AutoLearnedState {
  if (!fs.existsSync(statePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8")) as AutoLearnedState;
  } catch {
    return {};
  }
}

export function saveAutoLearnedState(statePath: string, state: AutoLearnedState): void {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// --- LEARNED.md manipulation ---

/**
 * Extract existing rule lines from LEARNED.md (lines starting with "- ").
 */
function extractExistingRules(content: string): string[] {
  return content.split("\n").filter((l) => l.startsWith("- "));
}

/**
 * Append a rule under the correct section in LEARNED.md.
 * Creates the section header if it doesn't exist (user feedback #3),
 * placing it in the canonical SECTION_ORDER.
 */
function appendRuleToSection(content: string, section: string, ruleLine: string): string {
  const lines = content.split("\n");

  // Find the target section
  const sectionHeader = `## ${section}`;
  const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader);

  if (sectionIdx >= 0) {
    // Section exists — find the end of this section (next ## or EOF)
    let insertIdx = sectionIdx + 1;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) {
        break;
      }
      insertIdx = i + 1;
    }
    // Insert before the blank line preceding next section, or at end
    lines.splice(insertIdx, 0, ruleLine);
  } else {
    // Section doesn't exist — create it in canonical order
    const targetOrder = SECTION_ORDER.indexOf(section);
    let insertBeforeIdx = lines.length;

    // Find the first existing section that comes after our target in SECTION_ORDER
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith("## ")) {
        continue;
      }
      const existingSection = line.slice(3).trim();
      const existingOrder = SECTION_ORDER.indexOf(existingSection);
      if (existingOrder > targetOrder && targetOrder >= 0) {
        insertBeforeIdx = i;
        break;
      }
    }

    // Insert new section with blank line before it
    const newSection = [``, sectionHeader, ruleLine];
    lines.splice(insertBeforeIdx, 0, ...newSection);
  }

  return lines.join("\n");
}

// --- Main entrypoint ---

/**
 * Analyse failure clusters and promote recurring patterns to LEARNED.md rules.
 *
 * Does NOT call refresh-digest (user feedback #1) — caller is responsible
 * for ensuring digests are current (log-failure.sh already triggers refresh).
 */
export function suggestRules(
  failuresJsonlPath: string,
  learnedMdPath: string,
  statePath: string,
  opts?: { maxRules?: number; minCount?: number; minDays?: number },
): SuggestResult {
  const maxRules = opts?.maxRules ?? DEFAULT_MAX_RULES;
  const result: SuggestResult = { added: [], skippedDuplicate: 0, skippedAlreadyPromoted: 0 };

  // 1. Parse and cluster failures
  const entries = parseFailuresJsonl(failuresJsonlPath);
  if (entries.length === 0) {
    return result;
  }
  const clusters = clusterFailures(entries);

  // 2. Find candidates meeting threshold
  const candidates = findRuleCandidates(clusters, {
    minCount: opts?.minCount,
    minDays: opts?.minDays,
  });
  if (candidates.length === 0) {
    return result;
  }

  // 3. Load state and existing rules
  const state = loadAutoLearnedState(statePath);
  let learnedContent = "";
  if (fs.existsSync(learnedMdPath)) {
    learnedContent = fs.readFileSync(learnedMdPath, "utf-8");
  } else {
    learnedContent = "# LEARNED\n\nAuto-captured lessons from feedback loop sessions.\n";
  }
  const existingRules = extractExistingRules(learnedContent);

  // 4. Filter and promote
  const today = new Date().toISOString().slice(0, 10);

  for (const candidate of candidates) {
    if (result.added.length >= maxRules) {
      break;
    }

    const key = clusterKey(candidate);

    // Skip already-promoted clusters
    if (state[key]) {
      result.skippedAlreadyPromoted++;
      continue;
    }

    // Skip duplicates of existing rules
    if (isRuleDuplicate(candidate.suggestedRule, existingRules)) {
      result.skippedDuplicate++;
      continue;
    }

    // Format and append
    const ruleLine = `- [${today}] ${candidate.suggestedRule} (source: auto, tool: ${candidate.tool}, count: ${candidate.count})`;
    learnedContent = appendRuleToSection(learnedContent, candidate.section, ruleLine);
    existingRules.push(ruleLine); // track for dedup within same batch

    // Update state
    state[key] = { ruleAdded: today, count: candidate.count };
    result.added.push(candidate.suggestedRule);
  }

  // 5. Write changes
  if (result.added.length > 0) {
    fs.writeFileSync(learnedMdPath, learnedContent, "utf-8");
    saveAutoLearnedState(statePath, state);
  }

  return result;
}
