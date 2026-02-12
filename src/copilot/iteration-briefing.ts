/**
 * Iteration Briefing — compact state handoff for fresh-context subagents.
 *
 * Instead of accumulating conversation history, each fresh Claude Code
 * subprocess receives a serialized briefing: what iteration we're on,
 * what was already tried, what failed, and what to focus on.
 *
 * Target: <2KB serialized markdown.
 */

import type { OvernightState } from "./overnight-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreviousAttemptSummary = {
  iteration: number;
  /** What we told the agent to fix (truncated to 200 chars). */
  nudgeSummary: string;
  /** Files the agent actually changed. */
  changedFiles: string[];
  /** Whether those changes helped, hurt, or did nothing. */
  outcome: "improved" | "regressed" | "unchanged" | "unknown";
  /** One-line description of the approach. */
  approach: string;
};

export type IterationBriefing = {
  iteration: number;
  maxIterations: number;
  /** Strategic context from overnight loop (phase goal + tried approaches). */
  strategicPreamble?: string;
  /** Compact history of previous iterations (max 5). */
  previousAttempts: PreviousAttemptSummary[];
  /** Files the agent should focus on (relative paths). */
  focusFiles: string[];
  /** Recent score trajectory (last 5 scores). */
  scoreTrajectory: (number | null)[];
  /** Known anti-patterns to avoid. */
  projectWarnings: string[];
  /** Validation gate failures from previous iteration (if any). */
  lastValidationFailures?: string[];
  /** Path to rich context directory (RLM pattern). */
  contextDir?: string;
};

// ---------------------------------------------------------------------------
// Types for the iteration records we consume
// ---------------------------------------------------------------------------

/** Minimal shape of IterationRecord needed for briefing (avoids circular import). */
export type IterationRecordLike = {
  iteration: number;
  diagnoses: Array<{ rootCause: string; suggestedFix: string }>;
  nudgeSent: string;
  observation: {
    changedFiles: string[];
    diffMatchResult: "full" | "partial" | "none" | "unknown";
  } | null;
  passed: boolean;
  scorecard?: { overall: number } | null;
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const MAX_PREVIOUS_ATTEMPTS = 5;
const MAX_NUDGE_LENGTH = 200;

/**
 * Determine the outcome of an iteration by comparing its score to the previous one.
 */
function determineOutcome(
  record: IterationRecordLike,
  prevRecord?: IterationRecordLike,
): PreviousAttemptSummary["outcome"] {
  if (record.passed) {
    return "improved";
  }

  const curr = record.scorecard?.overall ?? null;
  const prev = prevRecord?.scorecard?.overall ?? null;

  if (curr !== null && prev !== null) {
    if (curr > prev) {
      return "improved";
    }
    if (curr < prev) {
      return "regressed";
    }
    return "unchanged";
  }

  // Fall back to diffMatchResult
  if (record.observation) {
    if (record.observation.changedFiles.length === 0) {
      return "unchanged";
    }
    if (record.observation.diffMatchResult === "full") {
      return "improved";
    }
    if (record.observation.diffMatchResult === "none") {
      return "unchanged";
    }
  }

  return "unknown";
}

/**
 * Build a compact iteration briefing from loop history and optional overnight state.
 */
export function buildIterationBriefing(
  history: IterationRecordLike[],
  opts: {
    currentIteration: number;
    maxIterations: number;
    focusFiles: string[];
    projectWarnings?: string[];
    overnightState?: OvernightState;
    lastValidationFailures?: string[];
    contextDir?: string;
  },
): IterationBriefing {
  // Build previous attempt summaries (last N iterations)
  const recentHistory = history.slice(-MAX_PREVIOUS_ATTEMPTS);
  const previousAttempts: PreviousAttemptSummary[] = recentHistory.map((record, idx) => {
    const prevRecord = idx > 0 ? recentHistory[idx - 1] : undefined;
    const topDiagnosis = record.diagnoses[0];
    const approach = topDiagnosis
      ? `${topDiagnosis.rootCause}: ${topDiagnosis.suggestedFix}`.slice(0, 120)
      : "General fixes based on QA feedback";

    return {
      iteration: record.iteration,
      nudgeSummary: record.nudgeSent.slice(0, MAX_NUDGE_LENGTH),
      changedFiles: record.observation?.changedFiles ?? [],
      outcome: determineOutcome(record, prevRecord),
      approach,
    };
  });

  // Score trajectory (last 5)
  const scoreTrajectory: (number | null)[] = history
    .slice(-5)
    .map((r) => r.scorecard?.overall ?? null);

  // Merge overnight triedApproaches into warnings
  const projectWarnings = [...(opts.projectWarnings ?? [])];
  if (opts.overnightState?.triedApproaches) {
    for (const approach of opts.overnightState.triedApproaches.slice(-10)) {
      const warning = `Already tried (do not repeat): ${approach}`;
      if (!projectWarnings.includes(warning)) {
        projectWarnings.push(warning);
      }
    }
  }

  return {
    iteration: opts.currentIteration,
    maxIterations: opts.maxIterations,
    strategicPreamble: opts.overnightState
      ? buildStrategicPreambleFromState(opts.overnightState)
      : undefined,
    previousAttempts,
    focusFiles: opts.focusFiles,
    scoreTrajectory,
    projectWarnings,
    lastValidationFailures: opts.lastValidationFailures,
    contextDir: opts.contextDir,
  };
}

function buildStrategicPreambleFromState(state: OvernightState): string {
  const parts: string[] = [];
  parts.push(`Healing phase: ${state.currentPhase}`);
  if (state.bestScore > 0) {
    parts.push(`Best score so far: ${state.bestScore}/10 (cycle ${state.bestScoreCycle})`);
  }
  if (state.consecutiveStalls > 0) {
    parts.push(`Consecutive stalls: ${state.consecutiveStalls}`);
  }
  return parts.join(". ");
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize the briefing as markdown for --append-system-prompt.
 * Target: <2KB to keep the context budget small.
 */
export function serializeBriefingAsSystemPrompt(briefing: IterationBriefing): string {
  const lines: string[] = [];

  lines.push("# Voice QA Iteration Context");
  lines.push("");
  lines.push(
    `You are fixing issues in a Gemini Live API voice tutor (Scratchpad). ` +
      `This is iteration ${briefing.iteration}/${briefing.maxIterations}.`,
  );

  if (briefing.strategicPreamble) {
    lines.push("");
    lines.push(`## Strategic Goal`);
    lines.push(briefing.strategicPreamble);
  }

  if (briefing.previousAttempts.length > 0) {
    lines.push("");
    lines.push("## What Was Already Tried (DO NOT REPEAT)");
    for (const attempt of briefing.previousAttempts) {
      const filesStr =
        attempt.changedFiles.length > 0
          ? ` (changed: ${attempt.changedFiles.slice(0, 3).join(", ")})`
          : " (no changes made)";
      lines.push(
        `${attempt.iteration}. ${attempt.approach} → ${attempt.outcome.toUpperCase()}${filesStr}`,
      );
    }
  }

  if (briefing.focusFiles.length > 0) {
    lines.push("");
    lines.push("## Focus Files");
    for (const file of briefing.focusFiles) {
      lines.push(`- ${file}`);
    }
  }

  if (briefing.scoreTrajectory.some((s) => s !== null)) {
    lines.push("");
    lines.push("## Score Trajectory");
    lines.push(briefing.scoreTrajectory.map((s) => (s !== null ? String(s) : "?")).join(" → "));
  }

  if (briefing.lastValidationFailures && briefing.lastValidationFailures.length > 0) {
    lines.push("");
    lines.push("## Previous Iteration Validation Failures");
    for (const failure of briefing.lastValidationFailures) {
      lines.push(`- ${failure}`);
    }
  }

  if (briefing.projectWarnings.length > 0) {
    lines.push("");
    lines.push("## Project Anti-Patterns (AVOID THESE)");
    for (const warning of briefing.projectWarnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (briefing.contextDir) {
    lines.push("");
    lines.push("## Rich Context (read files as needed — don't read all)");
    lines.push("Full QA history at `.qa-context/`:");
    lines.push("- `context-recency.md` — last iterations in full");
    lines.push("- `context-tagged.md` — signals matching current diagnosis");
    lines.push("- `context-summary-window.md` — summarized older history");
    lines.push("- `context-manifest.json` — metadata");
    lines.push("Only read what you need. Start with context-recency.md.");
  }

  return lines.join("\n");
}
