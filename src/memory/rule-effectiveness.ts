/**
 * Phase C: Rule effectiveness tracking.
 *
 * After Phase B promotes a failure cluster into a LEARNED.md rule,
 * this module measures whether the rule actually reduces failures.
 * It compares pre-promotion and post-promotion failure rates,
 * assigns a verdict, and optionally retires ineffective rules.
 */
import fs from "node:fs";
import { loadAutoLearnedState, saveAutoLearnedState } from "./auto-learned.js";
import { type FailureEntry, normalizeError, parseFailuresJsonl } from "./failures-digest.js";

// --- Types ---

export type Verdict = "effective" | "ineffective" | "inconclusive";

export type EffectivenessResult = {
  key: string;
  ruleId: string;
  rule: string;
  verdict: Verdict;
  preRate: number;
  postRate: number;
  preCount: number;
  postCount: number;
  daysSincePromotion: number;
  observationDays: number;
};

// --- Constants ---

const DEFAULT_MIN_OBSERVATION_DAYS = 7;
const DEFAULT_MIN_POST_FAILURES = 3;
const PRE_LOOKBACK_DAYS = 30; // fixed window for pre-rate (feedback #1)
const EFFECTIVENESS_THRESHOLD = 0.5; // post-rate must be < 50% of pre-rate

// --- Core functions ---

/**
 * Count failures matching a cluster key that occurred after a given date.
 */
export function countPostPromotionFailures(
  entries: FailureEntry[],
  key: string,
  afterDate: string,
): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.timestamp <= afterDate) {
      continue;
    }
    const entryKey = `${entry.tool}::${normalizeError(entry.error)}`;
    if (entryKey === key) {
      count++;
    }
  }
  return count;
}

/**
 * Count failures matching a cluster key within a date range [startDate, endDate].
 */
export function countFailuresInWindow(
  entries: FailureEntry[],
  key: string,
  startDate: string,
  endDate: string,
): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.timestamp < startDate || entry.timestamp > endDate) {
      continue;
    }
    const entryKey = `${entry.tool}::${normalizeError(entry.error)}`;
    if (entryKey === key) {
      count++;
    }
  }
  return count;
}

/**
 * Compute failures per day. Returns 0 if window is 0 days.
 */
export function computeRate(count: number, startDate: string, endDate: string): number {
  const days = daysBetween(startDate, endDate);
  return days > 0 ? count / days : count;
}

/**
 * Days between two ISO date strings (date portion only).
 */
function daysBetween(a: string, b: string): number {
  const msA = new Date(a.slice(0, 10)).getTime();
  const msB = new Date(b.slice(0, 10)).getTime();
  return Math.max(Math.round(Math.abs(msB - msA) / (1000 * 60 * 60 * 24)), 0);
}

/**
 * Compute the start of the pre-promotion lookback window.
 * Uses a fixed 30-day window before ruleAdded (feedback #1).
 */
function preLookbackStart(ruleAddedDate: string): string {
  const d = new Date(ruleAddedDate.slice(0, 10));
  d.setDate(d.getDate() - PRE_LOOKBACK_DAYS);
  return d.toISOString().slice(0, 10);
}

/**
 * Assess whether a promoted rule is effective.
 * Returns "inconclusive" if observation window or data thresholds aren't met.
 */
export function assessRule(params: {
  preRate: number;
  postRate: number;
  daysSincePromotion: number;
  postCount: number;
  minObservationDays?: number;
  minPostFailures?: number;
}): Verdict {
  const minDays = params.minObservationDays ?? DEFAULT_MIN_OBSERVATION_DAYS;
  const minFailures = params.minPostFailures ?? DEFAULT_MIN_POST_FAILURES;

  // Not enough data yet
  if (params.daysSincePromotion < minDays || params.postCount < minFailures) {
    return "inconclusive";
  }

  // If pre-rate is 0, any post failures = ineffective
  if (params.preRate === 0) {
    return params.postRate > 0 ? "ineffective" : "effective";
  }

  // Post-rate < 50% of pre-rate → effective
  if (params.postRate < params.preRate * EFFECTIVENESS_THRESHOLD) {
    return "effective";
  }

  return "ineffective";
}

/**
 * Retire an auto-generated rule in LEARNED.md by appending "(retired: YYYY-MM-DD)".
 * Only touches lines with "source: auto". Skips already-retired lines.
 * Returns true if the file was modified.
 */
export function retireRuleInLearned(learnedMdPath: string, ruleText: string): boolean {
  if (!fs.existsSync(learnedMdPath)) {
    return false;
  }

  const content = fs.readFileSync(learnedMdPath, "utf-8");
  const lines = content.split("\n");
  const today = new Date().toISOString().slice(0, 10);
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Must be a rule line with source: auto and contain the rule text
    if (
      !line.startsWith("- ") ||
      !line.includes("source: auto") ||
      !line.includes(ruleText) ||
      line.includes("retired:")
    ) {
      continue;
    }
    lines[i] = `${line} (retired: ${today})`;
    modified = true;
    break; // only retire first match
  }

  if (modified) {
    fs.writeFileSync(learnedMdPath, lines.join("\n"), "utf-8");
  }
  return modified;
}

// --- Main entrypoint ---

/**
 * Check effectiveness of all promoted rules.
 * Skips already-retired rules (feedback #2).
 * Never retires on inconclusive (feedback #3).
 */
export function checkEffectiveness(params: {
  failuresJsonlPath: string;
  learnedMdPath: string;
  statePath: string;
  retire?: boolean;
}): EffectivenessResult[] {
  const entries = parseFailuresJsonl(params.failuresJsonlPath);
  const state = loadAutoLearnedState(params.statePath);
  const today = new Date().toISOString().slice(0, 10);
  const results: EffectivenessResult[] = [];
  let stateChanged = false;

  for (const [key, entry] of Object.entries(state)) {
    // Skip entries without ruleAdded (shouldn't happen but be safe)
    if (!entry.ruleAdded) {
      continue;
    }

    // Skip already-retired rules (feedback #2)
    if (entry.retiredAt) {
      continue;
    }

    const ruleAddedDate = entry.ruleAdded;
    const daysSincePromotion = daysBetween(ruleAddedDate, today);

    // Compute pre-promotion rate using fixed 30-day lookback (feedback #1)
    const lookbackStart = preLookbackStart(ruleAddedDate);
    const preCount =
      entry.countAtPromotion ?? countFailuresInWindow(entries, key, lookbackStart, ruleAddedDate);
    const preRate = computeRate(preCount, lookbackStart, ruleAddedDate);

    // Compute post-promotion count and rate
    const postCount = countPostPromotionFailures(entries, key, ruleAddedDate);
    const postRate = computeRate(postCount, ruleAddedDate, today);

    // Assess verdict
    const verdict = assessRule({
      preRate,
      postRate,
      daysSincePromotion,
      postCount,
    });

    const result: EffectivenessResult = {
      key,
      ruleId: entry.ruleId ?? key,
      rule: entry.ruleText ?? key,
      verdict,
      preRate,
      postRate,
      preCount,
      postCount,
      daysSincePromotion,
      observationDays: daysSincePromotion,
    };
    results.push(result);

    // Update state
    entry.postPromotionCount = postCount;
    entry.lastChecked = today;
    entry.verdict = verdict;
    stateChanged = true;

    // Retire only if verdict is definitively "ineffective" (feedback #3: never on inconclusive)
    if (params.retire && verdict === "ineffective" && entry.ruleText) {
      const retired = retireRuleInLearned(params.learnedMdPath, entry.ruleText);
      if (retired) {
        entry.retiredAt = today; // feedback #2: track in state
      }
    }
  }

  if (stateChanged) {
    saveAutoLearnedState(params.statePath, state);
  }

  return results;
}
