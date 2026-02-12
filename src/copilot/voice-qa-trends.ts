/**
 * Voice QA Score Trending — track scorecard results over time.
 *
 * Persists results to JSONL file for trend analysis and regression detection.
 * Used by the TAO loop to surface score improvements/regressions.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExperienceScorecard } from "./voice-qa-diagnosis.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScoreEntry = {
  timestamp: string;
  script: string;
  overall: number;
  visualClarity: number;
  teachingEffectiveness: number;
  scratchpadUsage: number;
  conversationFlow: number;
  ageAppropriateness: number;
  iterations: number;
  passed: boolean;
  agent: string;
  /** Aesthetic notes from the scorecard (if any). */
  aestheticNotes?: string[];
};

export type ScoreTrend = {
  entries: ScoreEntry[];
  averageOverall: number;
  trend: "improving" | "declining" | "stable" | "insufficient-data";
  delta: number;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SCORES_DIR = path.join(os.homedir(), ".openclaw", "workspace", "metrics");
const SCORES_FILE = path.join(SCORES_DIR, "voice-qa-scores.jsonl");

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Append a score result to the JSONL file. */
export function appendScoreResult(
  scorecard: ExperienceScorecard,
  metadata: {
    script: string;
    iterations: number;
    passed: boolean;
    agent: string;
  },
): void {
  const entry: ScoreEntry = {
    timestamp: new Date().toISOString(),
    script: metadata.script,
    overall: scorecard.overall,
    visualClarity: scorecard.visualClarity,
    teachingEffectiveness: scorecard.teachingEffectiveness,
    scratchpadUsage: scorecard.scratchpadUsage,
    conversationFlow: scorecard.conversationFlow,
    ageAppropriateness: scorecard.ageAppropriateness,
    iterations: metadata.iterations,
    passed: metadata.passed,
    agent: metadata.agent,
    aestheticNotes: scorecard.aestheticNotes.length > 0 ? scorecard.aestheticNotes : undefined,
  };

  fs.mkdirSync(SCORES_DIR, { recursive: true });
  fs.appendFileSync(SCORES_FILE, JSON.stringify(entry) + "\n");
}

/** Read all score entries, optionally filtered by script name. */
export function readScoreEntries(scriptName?: string): ScoreEntry[] {
  if (!fs.existsSync(SCORES_FILE)) {
    return [];
  }

  const lines = fs.readFileSync(SCORES_FILE, "utf-8").trim().split("\n").filter(Boolean);
  const entries: ScoreEntry[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ScoreEntry;
      if (!scriptName || entry.script === scriptName) {
        entries.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Trend analysis
// ---------------------------------------------------------------------------

/** Get score trend for a script (last N entries). */
export function getScoreTrend(scriptName: string, last = 10): ScoreTrend {
  const allEntries = readScoreEntries(scriptName);
  const entries = allEntries.slice(-last);

  if (entries.length === 0) {
    return { entries: [], averageOverall: 0, trend: "insufficient-data", delta: 0 };
  }

  if (entries.length === 1) {
    return {
      entries,
      averageOverall: entries[0].overall,
      trend: "insufficient-data",
      delta: 0,
    };
  }

  const averageOverall = entries.reduce((sum, e) => sum + e.overall, 0) / entries.length;

  // Compare first half average to second half average
  const mid = Math.floor(entries.length / 2);
  const firstHalf = entries.slice(0, mid);
  const secondHalf = entries.slice(mid);

  const firstAvg = firstHalf.reduce((sum, e) => sum + e.overall, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((sum, e) => sum + e.overall, 0) / secondHalf.length;

  const delta = secondAvg - firstAvg;

  let trend: ScoreTrend["trend"];
  if (delta >= 1) {
    trend = "improving";
  } else if (delta <= -1) {
    trend = "declining";
  } else {
    trend = "stable";
  }

  return {
    entries,
    averageOverall: Math.round(averageOverall * 10) / 10,
    trend,
    delta: Math.round(delta * 10) / 10,
  };
}

/** Format a human-readable trend report. */
export function formatTrendReport(scriptName: string, last = 10): string {
  const trend = getScoreTrend(scriptName, last);

  if (trend.trend === "insufficient-data") {
    if (trend.entries.length === 1) {
      return `First run: ${trend.entries[0].overall}/10`;
    }
    return "No score history yet";
  }

  const scores = trend.entries.map((e) => `${e.overall}/10`).join(" → ");
  const arrow =
    trend.trend === "improving" ? "UP" : trend.trend === "declining" ? "DOWN" : "STABLE";

  const parts: string[] = [];
  parts.push(`Score trending ${arrow}: ${scores}`);
  parts.push(
    `Average: ${trend.averageOverall}/10 (delta: ${trend.delta > 0 ? "+" : ""}${trend.delta})`,
  );

  const lastEntry = trend.entries.at(-1);
  if (lastEntry?.passed) {
    parts.push("Last run: PASSED");
  } else if (lastEntry) {
    parts.push(`Last run: FAILED (${lastEntry.iterations} iterations)`);
  }

  return parts.join(" | ");
}
