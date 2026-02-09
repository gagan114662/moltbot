/**
 * Types for the copilot autonomous worker.
 *
 * The worker runs an agent → verify → feedback → fix loop.
 */

import type { ProjectToolchain } from "./toolchain.js";
import type { StageResult, VideoResult } from "./types.js";

export type WorkerConfig = {
  /** The task description */
  task: string;
  /** Working directory */
  cwd: string;
  /** Max fix iterations (default 5) */
  maxIterations: number;
  /** Skip test stage */
  noTests: boolean;
  /** Skip video verification after success */
  noVideo: boolean;
  /** App URL for video verification */
  appUrl?: string;
  /** Agent ID to use */
  agentId?: string;
  /** Agent thinking level */
  thinking?: string;
  /** Timeout per agent turn in seconds */
  turnTimeoutSeconds: number;
  /** Force embedded agent (skip gateway) */
  local: boolean;
  /** Skip browser inspection */
  noBrowser: boolean;
  /** Skip coverage-diff stage */
  noCoverage: boolean;
  /** Skip screenshot-diff stage */
  noScreenshotDiff: boolean;
  /** Skip review-agent stage */
  noReview: boolean;
  /** Skip spec-test TDD stage */
  noSpecTests: boolean;
  /** Skip deep UX evaluation stage */
  noUxEval: boolean;
  /** Max interaction steps for UX eval (default 10) */
  uxEvalSteps: number;
  /** Sample size for matrix testing in UX eval (default 5) */
  uxEvalSample: number;
  /** Output JSONL events instead of dashboard */
  json: boolean;
  /** Consecutive stall limit before aborting (default 3) */
  stallLimit: number;
  /** Target project workspace for cross-project feedback delivery */
  targetWorkspace?: string;
  /** Skip installing hooks in target project */
  noBootstrapHooks: boolean;
  /** Run browser in headed mode (visible window) */
  headed: boolean;
  /** Explicit toolchain override (auto-detected from cwd if not set) */
  toolchain?: ProjectToolchain;
  /** Custom event emitter (overrides dashboard/json emitters) */
  emit?: (event: WorkerEvent) => void;
};

export type IterationResult = {
  iteration: number;
  agentDurationMs: number;
  verifyDurationMs: number;
  checks: StageResult[];
  allPassed: boolean;
  changedFiles: string[];
  agentSummary?: string;
};

export type WorkerResult = {
  ok: boolean;
  iterations: IterationResult[];
  totalDurationMs: number;
  video?: VideoResult;
  changedFiles: string[];
  stoppedEarly: boolean;
  stopReason?: "success" | "max-iterations" | "stall" | "error";
};

export type WorkerEvent =
  | { type: "git-stash"; stashed: boolean }
  | { type: "iteration-start"; iteration: number; maxIterations: number }
  | { type: "agent-start"; iteration: number }
  | { type: "agent-done"; iteration: number; durationMs: number; summary?: string }
  | { type: "verify-start"; iteration: number; changedFiles: string[] }
  | { type: "stage-start"; stage: string }
  | { type: "stage-done"; result: StageResult }
  | { type: "verify-done"; iteration: number; allPassed: boolean; checks: StageResult[] }
  | { type: "stall-warning"; consecutiveStalls: number; stallLimit: number }
  | { type: "video-start" }
  | { type: "video-done"; result: StageResult }
  | { type: "done"; result: WorkerResult }
  | { type: "error"; error: string };
