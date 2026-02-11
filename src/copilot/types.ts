/**
 * Shared types for the Copilot verification daemon.
 */

export type CopilotConfig = {
  /** Debounce settle time in ms (default 1500) */
  debounceMs: number;
  /** Disable macOS desktop notifications */
  noNotify: boolean;
  /** Skip test stage */
  noTests: boolean;
  /** Skip video verification */
  noVideo: boolean;
  /** Run build + video on every change (not just commits) */
  full: boolean;
  /** App URL for video verification (auto-detect if not set) */
  appUrl?: string;
  /** Working directory */
  cwd: string;
};

export type StageResult = {
  /** Stage name: "lint", "typecheck", "test", "build", "video" */
  stage: string;
  /** Whether this check passed */
  passed: boolean;
  /** Duration in ms */
  durationMs: number;
  /** Error output (truncated to 2000 chars) if failed */
  error?: string;
  /** Files involved in this check */
  files?: string[];
};

export type VideoResult = {
  /** Path to .webm video file */
  path: string;
  /** Paths to PNG screenshots */
  screenshots: string[];
  /** Path to proof-report.json */
  reportPath: string;
};

export type CopilotFeedback = {
  /** ISO 8601 timestamp of when this feedback was generated */
  timestamp: string;
  /** Whether all checks passed */
  ok: boolean;
  /** Total pipeline duration in ms */
  durationMs: number;
  /** Git ref (short SHA) at time of check */
  gitRef: string;
  /** Files that triggered this run */
  triggerFiles: string[];
  /** Individual check results */
  checks: StageResult[];
  /** Video proof data (only on commit-triggered runs) */
  video?: VideoResult;
  /** Human-readable summary for prompt injection */
  summary: string;
};

// ---------------------------------------------------------------------------
// Voice QA feedback types
// ---------------------------------------------------------------------------

export type PageHealthReport = {
  hasErrorToast: boolean;
  toastMessages: string[];
  audioBlocked: boolean;
  sessionConnected: boolean;
  mediaStatus: "LIVE" | "OFF" | "loading" | "unknown";
  hasAlertRole: boolean;
  alertMessages: string[];
  chatMessages: string[];
  canvasCount: number;
};

export type BehavioralObservation = {
  category: "tool-gap" | "conversation-flow" | "teaching-quality" | "audio-gap" | "frontend-error";
  observation: string;
  severity: "critical" | "major" | "minor" | "info";
  evidence: string[];
};

export type ProjectWarning = {
  id: string;
  warning: string;
  trigger: string;
};

export type PipelineEvent =
  | { type: "start"; triggerFiles: string[]; isCommit: boolean }
  | { type: "stage-start"; stage: string }
  | { type: "stage-done"; result: StageResult }
  | { type: "done"; feedback: CopilotFeedback }
  | { type: "cancelled" }
  | { type: "error"; error: string };

export type WatcherEvent =
  | { type: "files-changed"; files: string[] }
  | { type: "commit"; ref: string };

export type DashboardState = {
  /** Number of files being watched */
  watchedFiles: number;
  /** Process uptime start */
  startedAt: Date;
  /** Current pipeline status */
  status: "idle" | "running" | "cancelled";
  /** Current stage being run (if running) */
  currentStage?: string;
  /** Current stage index (1-based) */
  currentStageIndex?: number;
  /** Total stages in pipeline */
  totalStages?: number;
  /** Last completed run results */
  lastRun?: CopilotFeedback;
  /** Last time all checks passed */
  lastOkAt?: Date;
  /** Files that triggered the current/last run */
  triggerFiles: string[];
};
