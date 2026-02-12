/**
 * Types for the overnight self-healing loop.
 *
 * The overnight loop wraps the inner TAO loop (voice-qa-loop.ts) with:
 * - Cross-cycle memory (what was tried, what worked)
 * - Strategy escalation (standard → contextual → architectural → fallback)
 * - Progress logging and morning reports
 */

// ---------------------------------------------------------------------------
// Strategy & Phase
// ---------------------------------------------------------------------------

/** How aggressively we're diagnosing / nudging Codex. */
export type StrategyLevel =
  | "standard" // Cycles 1-2: normal diagnosis + nudge
  | "contextual" // Cycles 3-4: include source code + anti-patterns
  | "architectural" // Cycles 5-7: big picture, suggest alternatives
  | "fallback-model"; // Cycles 8+: try non-native-audio model or different config

/** Progressive healing phases — connect → talk → draw → teach. */
export type HealingPhase =
  | "phase-1-connect" // Get WebSocket connected (no 1007/1011 crashes)
  | "phase-2-talk" // Tutor responds to audio input
  | "phase-3-draw" // Canvas shows relevant content
  | "phase-4-teach"; // Khan Academy-quality teaching

// ---------------------------------------------------------------------------
// Strategy resolution output
// ---------------------------------------------------------------------------

export type OvernightStrategy = {
  level: StrategyLevel;
  phase: HealingPhase;
  /** Extra source files to include for Codex context (relative to targetCwd). */
  extraSourceFiles: string[];
  /** Text prepended to every diagnosis prompt (phase goal + tried approaches). */
  strategicPreamble: string;
  /** Max iterations for the inner TAO loop this cycle. */
  innerMaxIterations: number;
  /** Override Codex model (e.g. "o3" for fallback). */
  codexModel?: string;
};

// ---------------------------------------------------------------------------
// Cycle tracking
// ---------------------------------------------------------------------------

export type CycleRecord = {
  cycle: number;
  startedAt: string;
  durationMs: number;
  stopReason: string;
  iterations: number;
  score: number | null;
  phase: HealingPhase;
  strategy: StrategyLevel;
  diagnoses: string[];
  changedFiles: string[];
  diffSummary: string;
  scoreImproved: boolean;
  scoreRegressed: boolean;
};

// ---------------------------------------------------------------------------
// Persistent state (survives crashes via JSON file)
// ---------------------------------------------------------------------------

export type OvernightState = {
  runId: string;
  startedAt: string;
  baseHead: string;
  completedCycles: number;
  cycles: CycleRecord[];
  /** Deduped list of root causes + fixes attempted. Capped at 20. */
  triedApproaches: string[];
  bestScore: number;
  bestScoreCycle: number;
  currentPhase: HealingPhase;
  consecutiveStalls: number;
  consecutiveApiErrors: number;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type OvernightConfig = {
  maxCycles: number;
  stallThreshold: number;
  targetDir: string;
  moltbotDir: string;
  progressFile: string;
  scoreGoal: number;
  maxWallTimeMs: number;
  codexModel?: string;
  dryRun: boolean;
  /** Use ClaudeCodeDriver (fresh context per iteration) instead of Codex. */
  useClaudeCode?: boolean;
};
