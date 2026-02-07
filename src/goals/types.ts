/**
 * Autonomous Goal-Driven Agent System - Type Definitions
 *
 * This module defines types for the goal-driven autonomous agent system
 * that works toward objectives during heartbeat intervals.
 */

// ============================================
// GOAL TYPES
// ============================================

/** Goal priority levels */
export type GoalPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** Goal execution status */
export type GoalStatus = "pending" | "in_progress" | "blocked" | "completed";

/** A single success criterion for a goal */
export type SuccessCriterion = {
  text: string;
  completed: boolean;
};

/** A subtask within a goal */
export type Subtask = {
  text: string;
  completed: boolean;
};

/** A goal that the agent should work toward */
export type Goal = {
  /** Unique identifier for this goal */
  id: string;
  /** Human-readable title */
  title: string;
  /** Priority level (HIGH, MEDIUM, LOW) */
  priority: GoalPriority;
  /** Current status */
  status: GoalStatus;
  /** Progress percentage (0-100) */
  progress: number;
  /** Optional deadline (ISO date string) */
  deadline?: string;
  /** Context and description of the goal */
  context: string;
  /** Success criteria that must be met */
  successCriteria: SuccessCriterion[];
  /** Subtasks to complete */
  subtasks: Subtask[];
  /** IDs of goals/tasks that block this one */
  blockedBy?: string[];
  /** Reasons why this goal is blocked */
  blockers?: string[];
  /** ISO timestamp of last work session */
  lastWorked?: string;
  /** Tags for categorization */
  tags?: string[];
};

/** A completed goal with completion metadata */
export type CompletedGoal = Goal & {
  status: "completed";
  /** ISO timestamp when completed */
  completedAt: string;
  /** Summary of what was accomplished */
  completionSummary?: string;
};

// ============================================
// CONFIGURATION TYPES
// ============================================

/** Quiet hours configuration */
export type QuietHoursConfig = {
  /** Start time (24h format, HH:MM) */
  start: string;
  /** End time (24h format, HH:MM) */
  end: string;
  /** Timezone ("user", "local", or IANA TZ id) */
  timezone?: string;
};

/** Notification configuration */
export type GoalNotificationConfig = {
  /** Notify immediately when a goal is completed */
  onComplete?: boolean;
  /** Notify immediately when a goal is blocked */
  onBlocked?: boolean;
  /** Batch non-urgent progress updates */
  batchNonUrgent?: boolean;
  /** Interval for batched notifications (minutes) */
  batchIntervalMinutes?: number;
};

/** Configuration for autonomous goal work */
export type GoalWorkConfig = {
  /** Enable autonomous goal-driven work */
  enabled?: boolean;
  /** How often to work on goals (duration string, default: 30m) */
  workInterval?: string;
  /** Max time per goal work session (duration string, default: 10m) */
  maxWorkDuration?: string;
  /** Model for goal work (defaults to heartbeat model) */
  model?: string;
  /** Quiet hours for goal work */
  quietHours?: QuietHoursConfig;
  /** Notification settings */
  notifications?: GoalNotificationConfig;
};

/** In-file configuration embedded in GOALS.md */
export type GoalsFileConfig = {
  autonomous: {
    enabled: boolean;
    workInterval: string;
    maxWorkDuration: string;
    quietHours?: {
      start: string;
      end: string;
      timezone?: string;
    };
    notifications?: {
      onComplete?: boolean;
      onBlocked?: boolean;
      batchNonUrgent?: boolean;
      batchIntervalMinutes?: number;
    };
  };
};

// ============================================
// FILE TYPES
// ============================================

/** Parsed GOALS.md file */
export type GoalsFile = {
  /** Active goals being worked on */
  activeGoals: Goal[];
  /** Completed goals (for history) */
  completedGoals: CompletedGoal[];
  /** Embedded configuration (optional) */
  config?: GoalsFileConfig;
  /** Raw markdown content for sections we don't parse */
  rawSections?: Record<string, string>;
};

// ============================================
// WORK RESULT TYPES
// ============================================

/** Result of a goal work session */
export type GoalWorkResult = {
  /** Goal that was worked on */
  goalId: string;
  /** Result status */
  status: "worked" | "blocked" | "completed" | "skipped" | "error";
  /** Progress change (e.g., +10 means 10% progress added) */
  progressDelta: number;
  /** New progress value (0-100) */
  newProgress: number;
  /** Summary of what was done */
  summary: string;
  /** Blockers encountered (if status is "blocked") */
  blockers?: string[];
  /** Suggested next steps */
  nextSteps?: string[];
  /** Duration of work session in milliseconds */
  durationMs: number;
  /** Error message (if status is "error") */
  error?: string;
  /** Files that were changed */
  filesChanged?: string[];
  /** Subtasks that were completed */
  subtasksCompleted?: string[];
};

// ============================================
// PROGRESS TYPES
// ============================================

/** A single progress entry in PROGRESS.md */
export type ProgressEntry = {
  /** ISO timestamp */
  timestamp: string;
  /** Goal ID that was worked on */
  goalId: string;
  /** Action taken (worked, blocked, completed) */
  action: string;
  /** Summary of what was done */
  summary: string;
  /** Files that were changed */
  filesChanged?: string[];
  /** Progress percentage after this entry */
  progressAfter?: number;
  /** Video proof path (if captured) */
  videoProof?: string;
  /** Screenshot paths (if captured) */
  screenshots?: string[];
};

/** Parsed PROGRESS.md file */
export type ProgressFile = {
  /** Session start timestamp */
  sessionStart: string;
  /** All progress entries */
  entries: ProgressEntry[];
  /** Total number of work sessions */
  totalWorkSessions: number;
  /** Last work session timestamp */
  lastWorkSession?: string;
};

// ============================================
// NOTIFICATION TYPES
// ============================================

/** Notification event types */
export type NotificationEventType =
  | "goal_completed"
  | "goal_blocked"
  | "progress_update"
  | "batch_summary"
  | "error";

/** Priority levels for notifications */
export type NotificationPriority = "high" | "normal" | "low";

/** A notification event to be sent to the user */
export type NotificationEvent = {
  /** Type of notification */
  type: NotificationEventType;
  /** Associated goal ID (if applicable) */
  goalId?: string;
  /** Goal title (for display) */
  goalTitle?: string;
  /** Notification message */
  message: string;
  /** Priority level */
  priority: NotificationPriority;
  /** Timestamp when event occurred */
  timestamp: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
};

// ============================================
// RUNNER CONTEXT TYPES
// ============================================

/** Context for goal runner execution */
export type GoalRunnerContext = {
  /** Agent ID */
  agentId: string;
  /** Session key for the goal work session */
  sessionKey: string;
  /** Workspace directory */
  workspaceDir: string;
  /** Max work duration in milliseconds */
  maxWorkDurationMs: number;
  /** Model to use for goal work */
  model?: string;
  /** Delivery target for notifications */
  deliveryTarget?: string;
};

/** Options for selecting the next goal to work on */
export type GoalSelectionOptions = {
  /** Prefer goals with upcoming deadlines */
  prioritizeDeadlines?: boolean;
  /** Skip goals blocked by other goals */
  skipBlocked?: boolean;
  /** Only select goals with these tags */
  filterTags?: string[];
  /** Exclude goals with these tags */
  excludeTags?: string[];
};
