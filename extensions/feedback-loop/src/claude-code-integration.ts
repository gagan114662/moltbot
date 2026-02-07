/**
 * Claude Code Native Integration
 *
 * This module integrates the feedback loop with Claude Code's native features:
 * - Subagent patterns (Explore, Plan, general-purpose)
 * - Parallel execution
 * - Background tasks
 * - Subagent resume
 * - Task tracking (TaskCreate, TaskUpdate, TaskList)
 * - Skills system
 * - MCP readiness
 */

import type { FeedbackLoopConfig } from "openclaw/plugin-sdk";
import crypto from "node:crypto";

// ============================================
// SUBAGENT TYPES (matching Claude Code's Task tool)
// ============================================

/**
 * Claude Code subagent types available for spawning
 */
export type SubagentType =
  | "Bash" // Command execution specialist
  | "general-purpose" // General-purpose agent for multi-step tasks
  | "Explore" // Fast codebase exploration
  | "Plan" // Software architect for implementation plans
  | "claude-code-guide"; // Claude Code documentation expert

/**
 * Subagent spawn options matching Claude Code's Task tool parameters
 */
export interface SubagentSpawnOptions {
  /** Short description (3-5 words) of what the agent will do */
  description: string;
  /** The task for the agent to perform */
  prompt: string;
  /** Type of specialized agent to use */
  subagentType: SubagentType;
  /** Optional model override (sonnet, opus, haiku) */
  model?: "sonnet" | "opus" | "haiku";
  /** Maximum number of agentic turns before stopping */
  maxTurns?: number;
  /** Run in background (returns output_file path) */
  runInBackground?: boolean;
  /** Agent ID to resume from (continues with previous context) */
  resume?: string;
}

/**
 * Result from a subagent execution
 */
export interface SubagentResult {
  success: boolean;
  output: string;
  agentId: string;
  duration: number;
  /** Output file path if run in background */
  outputFile?: string;
}

// ============================================
// PARALLEL SUBAGENT EXECUTION
// ============================================

/**
 * Run multiple subagents in parallel
 * This matches Claude Code's ability to spawn multiple Task tools in one message
 */
export async function runParallelSubagents<T extends Record<string, SubagentSpawnOptions>>(
  agents: T,
  executor: (opts: SubagentSpawnOptions) => Promise<SubagentResult>,
): Promise<Record<keyof T, SubagentResult>> {
  const entries = Object.entries(agents);
  const startTime = Date.now();

  console.log(`[claude-code] Running ${entries.length} subagents in parallel...`);

  const results = await Promise.all(
    entries.map(async ([key, opts]) => {
      console.log(`[claude-code] Spawning ${opts.subagentType}: ${opts.description}`);
      const result = await executor(opts);
      return [key, result] as const;
    }),
  );

  console.log(
    `[claude-code] All ${entries.length} subagents completed in ${Date.now() - startTime}ms`,
  );

  return Object.fromEntries(results) as Record<keyof T, SubagentResult>;
}

// ============================================
// EXPLORE-PLAN PARALLEL PATTERN
// ============================================

/**
 * Run Explore phase with parallel subagents for faster context gathering
 * - One agent explores the codebase structure
 * - One agent searches for relevant patterns
 * - One agent checks for existing tests
 */
export interface ParallelExploreOptions {
  task: string;
  workspaceDir: string;
  targetFiles?: string[];
  projectContext?: string;
}

export interface ParallelExploreResult {
  structure: SubagentResult;
  patterns: SubagentResult;
  tests: SubagentResult;
  combined: {
    relevantFiles: string[];
    codebaseContext: string;
    existingPatterns: string;
    testCoverage: string;
  };
}

export function buildParallelExploreAgents(
  opts: ParallelExploreOptions,
): Record<string, SubagentSpawnOptions> {
  return {
    structure: {
      description: "Explore codebase structure",
      prompt: `Explore the codebase at ${opts.workspaceDir} to understand its structure.
Task context: ${opts.task}
${opts.targetFiles?.length ? `Focus on: ${opts.targetFiles.join(", ")}` : ""}

Find:
1. Directory structure
2. Key entry points
3. Configuration files
4. Build/test scripts

Return a concise summary.`,
      subagentType: "Explore",
      model: "haiku", // Fast exploration
    },
    patterns: {
      description: "Find coding patterns",
      prompt: `Search for coding patterns in ${opts.workspaceDir} relevant to: ${opts.task}

Find:
1. Similar implementations
2. Naming conventions
3. Error handling patterns
4. State management patterns

Return examples with file paths.`,
      subagentType: "Explore",
      model: "haiku",
    },
    tests: {
      description: "Check test coverage",
      prompt: `Find existing tests in ${opts.workspaceDir} related to: ${opts.task}

Find:
1. Test file locations
2. Testing patterns used
3. Test utilities/mocks
4. Coverage gaps

Return a summary with file paths.`,
      subagentType: "Explore",
      model: "haiku",
    },
  };
}

// ============================================
// BACKGROUND TASK SUPPORT
// ============================================

/**
 * Run a long-running task in background
 * Returns immediately with an output file path that can be polled
 */
export interface BackgroundTaskHandle {
  taskId: string;
  outputFile: string;
  status: "running" | "completed" | "failed";
  startTime: number;
}

const backgroundTasks = new Map<string, BackgroundTaskHandle>();

export function createBackgroundTask(description: string): BackgroundTaskHandle {
  const taskId = crypto.randomUUID().slice(0, 8);
  const outputFile = `/tmp/feedback-loop-${taskId}.log`;

  const handle: BackgroundTaskHandle = {
    taskId,
    outputFile,
    status: "running",
    startTime: Date.now(),
  };

  backgroundTasks.set(taskId, handle);
  console.log(`[claude-code] Background task started: ${taskId} (${description})`);

  return handle;
}

export function getBackgroundTask(taskId: string): BackgroundTaskHandle | undefined {
  return backgroundTasks.get(taskId);
}

export function updateBackgroundTask(
  taskId: string,
  update: Partial<Pick<BackgroundTaskHandle, "status">>,
): void {
  const handle = backgroundTasks.get(taskId);
  if (handle) {
    Object.assign(handle, update);
  }
}

// ============================================
// SUBAGENT RESUME SUPPORT
// ============================================

/**
 * Session state for subagent resume capability
 */
export interface SubagentSession {
  agentId: string;
  subagentType: SubagentType;
  description: string;
  contextSnapshot: string;
  lastOutput: string;
  createdAt: number;
  lastAccessedAt: number;
}

const subagentSessions = new Map<string, SubagentSession>();

export function saveSubagentSession(
  agentId: string,
  session: Omit<SubagentSession, "agentId" | "createdAt" | "lastAccessedAt">,
): void {
  const now = Date.now();
  subagentSessions.set(agentId, {
    ...session,
    agentId,
    createdAt: now,
    lastAccessedAt: now,
  });
  console.log(`[claude-code] Saved session for subagent: ${agentId}`);
}

export function getSubagentSession(agentId: string): SubagentSession | undefined {
  const session = subagentSessions.get(agentId);
  if (session) {
    session.lastAccessedAt = Date.now();
  }
  return session;
}

export function buildResumePrompt(session: SubagentSession): string {
  return `## RESUMING PREVIOUS SESSION

**Agent ID:** ${session.agentId}
**Type:** ${session.subagentType}
**Task:** ${session.description}

## PREVIOUS CONTEXT
${session.contextSnapshot}

## LAST OUTPUT
${session.lastOutput}

## INSTRUCTIONS
Continue from where you left off. You have full access to the previous context.
`;
}

// ============================================
// TASK TRACKING INTEGRATION
// ============================================

/**
 * Task structure matching Claude Code's TaskCreate tool
 */
export interface FeedbackLoopTask {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner?: string;
  blockedBy?: string[];
  blocks?: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

const taskList = new Map<string, FeedbackLoopTask>();
let taskCounter = 0;

/**
 * Create a task for tracking workflow progress
 * Mirrors Claude Code's TaskCreate tool
 */
export function createTask(opts: {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}): FeedbackLoopTask {
  const id = String(++taskCounter);
  const now = Date.now();

  const task: FeedbackLoopTask = {
    id,
    subject: opts.subject,
    description: opts.description,
    activeForm: opts.activeForm || opts.subject.replace(/^(\w)/, (m) => m.toLowerCase() + "ing"),
    status: "pending",
    metadata: opts.metadata,
    createdAt: now,
    updatedAt: now,
  };

  taskList.set(id, task);
  console.log(`[claude-code] Task created: #${id} - ${opts.subject}`);

  return task;
}

/**
 * Update a task's status or properties
 * Mirrors Claude Code's TaskUpdate tool
 */
export function updateTask(
  taskId: string,
  update: Partial<
    Pick<
      FeedbackLoopTask,
      "status" | "subject" | "description" | "activeForm" | "owner" | "metadata"
    >
  > & {
    addBlockedBy?: string[];
    addBlocks?: string[];
  },
): FeedbackLoopTask | undefined {
  const task = taskList.get(taskId);
  if (!task) {
    return undefined;
  }

  if (update.status) {
    task.status = update.status;
  }
  if (update.subject) {
    task.subject = update.subject;
  }
  if (update.description) {
    task.description = update.description;
  }
  if (update.activeForm) {
    task.activeForm = update.activeForm;
  }
  if (update.owner) {
    task.owner = update.owner;
  }
  if (update.metadata) {
    task.metadata = { ...task.metadata, ...update.metadata };
  }
  if (update.addBlockedBy) {
    task.blockedBy = [...(task.blockedBy || []), ...update.addBlockedBy];
  }
  if (update.addBlocks) {
    task.blocks = [...(task.blocks || []), ...update.addBlocks];
  }

  task.updatedAt = Date.now();

  console.log(`[claude-code] Task updated: #${taskId} → ${task.status}`);

  return task;
}

/**
 * List all tasks
 * Mirrors Claude Code's TaskList tool
 */
export function listTasks(): FeedbackLoopTask[] {
  return Array.from(taskList.values()).filter((t) => t.status !== "deleted");
}

/**
 * Get a specific task
 * Mirrors Claude Code's TaskGet tool
 */
export function getTask(taskId: string): FeedbackLoopTask | undefined {
  return taskList.get(taskId);
}

/**
 * Create tasks for the feedback loop workflow phases
 */
export function createWorkflowTasks(task: string): FeedbackLoopTask[] {
  const exploreTask = createTask({
    subject: "Explore codebase for task context",
    description: `Read files and understand existing patterns for: ${task}`,
    activeForm: "Exploring codebase",
  });

  const planTask = createTask({
    subject: "Create implementation plan",
    description: `Design step-by-step plan for: ${task}`,
    activeForm: "Creating implementation plan",
  });
  updateTask(planTask.id, { addBlockedBy: [exploreTask.id] });

  const implementTask = createTask({
    subject: "Implement changes",
    description: `Write code following the plan for: ${task}`,
    activeForm: "Implementing changes",
  });
  updateTask(implementTask.id, { addBlockedBy: [planTask.id] });

  const commitTask = createTask({
    subject: "Commit and verify",
    description: `Commit changes and create PR if configured`,
    activeForm: "Committing changes",
  });
  updateTask(commitTask.id, { addBlockedBy: [implementTask.id] });

  return [exploreTask, planTask, implementTask, commitTask];
}

// ============================================
// SKILLS INTEGRATION
// ============================================

/**
 * Skill definition for the feedback loop
 * This allows /feedback-loop to be invoked as a skill
 */
export interface FeedbackLoopSkill {
  name: string;
  description: string;
  invoke: (args: string) => Promise<string>;
}

export function createFeedbackLoopSkill(
  runLoop: (
    task: string,
    config: FeedbackLoopConfig,
  ) => Promise<{ approved: boolean; iterations: number }>,
  config: FeedbackLoopConfig,
): FeedbackLoopSkill {
  return {
    name: "feedback-loop",
    description: `Use when the user wants to implement a coding task with verification.
Triggers the Explore → Plan → Implement → Commit workflow with:
- Codex as primary coder
- Antigravity as fallback
- Claude as reviewer
Examples: "implement user auth", "fix the login bug", "add a new API endpoint"`,
    invoke: async (args: string) => {
      const task = args.trim() || "No task specified";
      console.log(`[skill:feedback-loop] Invoked with: ${task}`);

      const result = await runLoop(task, config);

      return result.approved
        ? `Completed in ${result.iterations} iteration(s). All checks passed.`
        : `Stopped after ${result.iterations} iteration(s). Manual intervention needed.`;
    },
  };
}

// ============================================
// MCP READINESS
// ============================================

/**
 * MCP server configuration for external service integration
 * Ready for future MCP integration
 */
export interface MCPServerConfig {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  tools?: string[];
}

/**
 * Common MCP server configurations for feedback loop
 */
export const RECOMMENDED_MCP_SERVERS: MCPServerConfig[] = [
  {
    name: "browser",
    type: "stdio",
    command: "npx",
    args: ["@anthropic-ai/mcp-server-puppeteer"],
    tools: ["screenshot", "navigate", "click", "type"],
  },
  {
    name: "filesystem",
    type: "stdio",
    command: "npx",
    args: ["@anthropic-ai/mcp-server-filesystem", "--root", "."],
    tools: ["read_file", "write_file", "list_directory"],
  },
  {
    name: "git",
    type: "stdio",
    command: "npx",
    args: ["@anthropic-ai/mcp-server-git"],
    tools: ["git_status", "git_diff", "git_commit", "git_log"],
  },
];

/**
 * Check if MCP servers are configured and available
 */
export function checkMCPAvailability(): {
  available: boolean;
  servers: string[];
  missing: string[];
} {
  // This would check actual MCP configuration
  // For now, return a placeholder
  return {
    available: false,
    servers: [],
    missing: RECOMMENDED_MCP_SERVERS.map((s) => s.name),
  };
}

// ============================================
// PERMISSION MODES
// ============================================

/**
 * Permission modes for subagents
 * Matches Claude Code's permission system
 */
export type PermissionMode = "default" | "acceptEdits" | "dontAsk" | "bypassPermissions";

/**
 * Get recommended permission mode for a subagent type
 */
export function getSubagentPermissions(subagentType: SubagentType): PermissionMode {
  switch (subagentType) {
    case "Explore":
      return "default"; // Read-only, no special permissions needed
    case "Plan":
      return "default"; // Read-only, no special permissions needed
    case "Bash":
      return "dontAsk"; // Coder needs to run commands freely
    case "general-purpose":
      return "acceptEdits"; // Coder needs to edit files freely
    default:
      return "default";
  }
}

/**
 * Build permission prompt addition for a subagent
 */
export function buildPermissionPrompt(mode: PermissionMode): string {
  switch (mode) {
    case "acceptEdits":
      return "You have permission to edit files without asking for confirmation.";
    case "dontAsk":
      return "You have permission to run commands and edit files without asking for confirmation.";
    case "bypassPermissions":
      return "You have full permissions to make any changes without restrictions.";
    default:
      return "";
  }
}

// ============================================
// HOOK EVENTS
// ============================================

/**
 * Subagent lifecycle events for hooks
 */
export interface SubagentLifecycleEvent {
  type: "SubagentStart" | "SubagentStop";
  agentId: string;
  subagentType: SubagentType;
  description: string;
  parentSessionKey: string;
  timestamp: number;
}

type SubagentEventListener = (event: SubagentLifecycleEvent) => void | Promise<void>;

const subagentEventListeners: SubagentEventListener[] = [];

export function onSubagentLifecycle(listener: SubagentEventListener): () => void {
  subagentEventListeners.push(listener);
  return () => {
    const idx = subagentEventListeners.indexOf(listener);
    if (idx >= 0) {
      subagentEventListeners.splice(idx, 1);
    }
  };
}

export async function emitSubagentEvent(event: SubagentLifecycleEvent): Promise<void> {
  console.log(`[claude-code] ${event.type}: ${event.subagentType} (${event.agentId})`);
  for (const listener of subagentEventListeners) {
    await listener(event);
  }
}

// ============================================
// CONTEXT HEALTH MONITORING
// ============================================

/**
 * Track context usage across the workflow
 */
export interface ContextHealthMetrics {
  tokensUsed: number;
  tokensLimit: number;
  filesRead: number;
  toolCalls: number;
  subagentsSpawned: number;
  phase: string;
}

let contextMetrics: ContextHealthMetrics = {
  tokensUsed: 0,
  tokensLimit: 200000, // Claude's context window
  filesRead: 0,
  toolCalls: 0,
  subagentsSpawned: 0,
  phase: "init",
};

export function updateContextMetrics(update: Partial<ContextHealthMetrics>): void {
  Object.assign(contextMetrics, update);
}

export function getContextMetrics(): ContextHealthMetrics {
  return { ...contextMetrics };
}

export function getContextHealthStatus(): {
  status: "healthy" | "warning" | "critical";
  usagePercent: number;
  recommendations: string[];
} {
  const usagePercent = (contextMetrics.tokensUsed / contextMetrics.tokensLimit) * 100;
  const recommendations: string[] = [];

  if (usagePercent > 80) {
    recommendations.push("Consider compacting context or starting a new session");
    recommendations.push("Use subagents for isolated exploration tasks");
  } else if (usagePercent > 60) {
    recommendations.push("Monitor context usage closely");
    recommendations.push("Prioritize essential file reads");
  }

  if (contextMetrics.filesRead > 50) {
    recommendations.push("Many files read - consider focused subagent exploration");
  }

  return {
    status: usagePercent > 80 ? "critical" : usagePercent > 60 ? "warning" : "healthy",
    usagePercent,
    recommendations,
  };
}

export function resetContextMetrics(): void {
  contextMetrics = {
    tokensUsed: 0,
    tokensLimit: 200000,
    filesRead: 0,
    toolCalls: 0,
    subagentsSpawned: 0,
    phase: "init",
  };
}
