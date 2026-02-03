import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type {
  FeedbackLoopConfig,
  FeedbackLoopGatesConfig,
} from "../../../src/config/types.agent-defaults.js";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { callGateway } from "../../../src/gateway/call.js";
import { AGENT_LANE_SUBAGENT } from "../../../src/agents/lanes.js";
import { readLatestAssistantReply } from "../../../src/agents/tools/agent-step.js";

import { streamToTerminal, TerminalStreamer } from "./terminal-stream.js";
import { runVerificationCommands } from "./reviewer.js";
import { runBrowserChecks } from "./browser-check.js";

// New comprehensive review modules
import { spawnReviewer as spawnClaudeReviewer } from "./spawn-reviewer.js";
import { generateAcceptanceCriteria } from "./acceptance-criteria.js";
import { loadPastIssues, loadChecklist, saveFeedbackToMemory } from "./memory-integration.js";

// Planning-with-files pattern
import {
  initializePlanningFiles,
  buildPlanContext,
  updateProgress,
  updateTaskPlan,
  checkThreeStrikes,
  getEscalationNeeded,
  readTaskPlan,
  type PlanningFiles,
  type TaskPlan,
} from "./planning-files.js";

// Project detection for multi-project workspaces
import { detectProjectRoot, loadProjectContext } from "./project-detection.js";

// Self-correction pattern (pro-workflow inspired)
import { extractLessons, appendLearnedRules } from "./self-correction.js";

// Task enhancement - auto-structures vague tasks with verification criteria
import { enhanceTask, buildEnhancedTaskPrompt, type EnhancedTask } from "./task-enhancer.js";

// Context loader - extracts and loads rich context from task (files, patterns, constraints)
import { loadAndBuildContext, getContextSummary, type LoadedContext } from "./context-loader.js";

// Workflow phases - Explore → Plan → Implement → Commit (DEFAULT workflow)
import {
  runExplorePhase,
  runPlanPhase,
  runCommitPhase,
  buildImplementPrompt,
  runFullWorkflow,
  type WorkflowPhase,
  type ExploreResult,
  type PlanResult,
  type ImplementResult,
  type WorkflowContext,
  type WorkflowResult,
} from "./workflow-phases.js";

// Antigravity integration (Google Cloud Code Assist)
import {
  selectAntigravityModel,
  buildAntigravityPromptAdditions,
  handleAntigravityError,
  type AntigravityModel,
} from "./antigravity-integration.js";

// Claude Code native integration
import {
  createWorkflowTasks,
  updateTask,
  listTasks,
  emitSubagentEvent,
  updateContextMetrics,
  getContextHealthStatus,
  resetContextMetrics,
  buildParallelExploreAgents,
  runParallelSubagents,
  type SubagentResult,
} from "./claude-code-integration.js";

// Best practices (from Claude Code docs) - 100% coverage
import {
  extractVerificationCriteria,
  extractTaskContext,
  buildEnhancedCoderPrompt,
  buildEnhancedReviewerPrompt,
  detectFailurePatterns,
  isSimpleTask,
  suggestWorkflowPhase,
  // New best practices
  generateInterviewQuestions,
  buildInterviewPrompt,
  buildCommitMessage,
  assessContextHealth,
  buildExplorationSubagentPrompt,
  createSessionCheckpoint,
  buildResumePrompt,
  suggestCourseCorrection,
  extractRichContent,
  type VerificationCriteria,
  type TaskContext,
  type SessionCheckpoint,
} from "./best-practices.js";

// Helper to read task plan for 3-strike check
async function readTaskPlanForCheck(planningFiles?: PlanningFiles): Promise<TaskPlan | null> {
  if (!planningFiles) return null;
  return readTaskPlan(planningFiles.taskPlanPath);
}

export type IterationResult = {
  iteration: number;
  coderSummary: string;
  reviewResult: ReviewResult;
  userMessage?: string;
};

export type ReviewResult = {
  approved: boolean;
  checks: CheckResult[];
  feedback?: string;
  browserErrors?: string[];
  issues?: Array<{
    severity?: string;
    category?: string;
    file?: string;
    line?: number;
    description?: string;
    fix?: string;
  }>;
  artifacts?: {
    screenshots?: string[];
    urlsTested?: string[];
    commandSummaries?: string[];
    runtimeLogs?: string[];
  };
  target?: {
    repo: string;
    path: string;
    branch?: string;
    commit?: string;
  };
  runtime?: {
    websocket?: boolean;
    sessionStart?: boolean;
    sessionEnd?: boolean;
    geminiConnect?: boolean;
    geminiCloseReason?: string;
    pingPongOk?: boolean;
    authFailures?: number;
    consoleErrors?: number;
  };
  mediaMetrics?: {
    reconnects?: number;
    frameGapMsP95?: number;
    audioChunkMsP95?: number;
    pingPongOk?: boolean;
    minMessagesPerMinute?: number;
  };
  toolCalls?: {
    duplicatesDetected: boolean;
    duplicateSamples?: string[];
  };
  /** Screenshot paths captured during review (proof of verification) */
  screenshots?: string[];
  reviewerJsonValid?: boolean;
};

export type CheckResult = {
  command: string;
  name?: string;
  passed: boolean;
  evidence?: string;
  output?: string;
  error?: string;
};

type ResolvedFeedbackLoopGates = Required<FeedbackLoopGatesConfig>;

function resolveFeedbackLoopGates(config: FeedbackLoopConfig): ResolvedFeedbackLoopGates {
  return {
    requireReviewerJson: config.gates?.requireReviewerJson ?? true,
    requireAllCommandsPass: config.gates?.requireAllCommandsPass ?? true,
    requireNoBrowserErrors: config.gates?.requireNoBrowserErrors ?? true,
    requireArtifactProof: config.gates?.requireArtifactProof ?? true,
    blockApprovalOnParseFailure: config.gates?.blockApprovalOnParseFailure ?? true,
    requireRuntimeSessionHealthy: config.gates?.requireRuntimeSessionHealthy ?? true,
    requireGeminiLiveHealthy: config.gates?.requireGeminiLiveHealthy ?? true,
    requireNoToolCallDuplication: config.gates?.requireNoToolCallDuplication ?? true,
    requireConsoleBudget: config.gates?.requireConsoleBudget ?? true,
  };
}

function formatFailedChecks(checks: CheckResult[]) {
  return checks
    .filter((check) => !check.passed)
    .map((check) => `- ${check.command}: ${check.error ?? check.evidence ?? "FAILED"}`)
    .join("\n");
}

export function applyHardApprovalGates(params: {
  reviewResult: ReviewResult;
  config: FeedbackLoopConfig;
  gates: ResolvedFeedbackLoopGates;
}): ReviewResult {
  const { reviewResult, config, gates } = params;
  const next: ReviewResult = { ...reviewResult };
  const gateFailures: string[] = [];

  if (gates.requireReviewerJson && next.reviewerJsonValid !== true) {
    gateFailures.push("Reviewer JSON payload was invalid or missing.");
  }

  if (gates.requireAllCommandsPass && config.commands?.length) {
    const configuredCommands = new Set(config.commands.map((entry) => entry.command));
    const failedCommandChecks = next.checks.filter(
      (check) => configuredCommands.has(check.command) && !check.passed,
    );
    if (failedCommandChecks.length > 0) {
      gateFailures.push(`Required command checks failed:\n${formatFailedChecks(failedCommandChecks)}`);
    }
  }

  if (gates.requireNoBrowserErrors && (next.browserErrors?.length ?? 0) > 0) {
    gateFailures.push(
      `Browser verification reported errors:\n${(next.browserErrors ?? []).map((error) => `- ${error}`).join("\n")}`,
    );
  }

  if (gates.requireArtifactProof && next.approved) {
    const hasScreenshots = (next.artifacts?.screenshots?.length ?? 0) > 0;
    const hasCommandProof = (next.artifacts?.commandSummaries?.length ?? 0) > 0;
    const hasRuntimeLogs = (next.artifacts?.runtimeLogs?.length ?? 0) > 0;
    if (!hasScreenshots && !hasCommandProof && !hasRuntimeLogs) {
      gateFailures.push("Approval blocked: no proof artifacts (screenshots or command summaries).");
    }
    if (!next.target?.path || !next.target?.repo) {
      gateFailures.push("Approval blocked: target evidence is missing.");
    }
    if (!next.runtime) {
      gateFailures.push("Approval blocked: runtime evidence is missing.");
    }
    if (!next.toolCalls) {
      gateFailures.push("Approval blocked: tool call evidence is missing.");
    }
  }

  if (gates.requireRuntimeSessionHealthy) {
    const runtime = next.runtime;
    const runtimeHealthy =
      runtime?.sessionStart === true &&
      runtime?.websocket === true &&
      runtime?.sessionEnd === true &&
      runtime?.pingPongOk !== false;
    if (!runtimeHealthy) {
      gateFailures.push("Runtime session health check failed (session/websocket/ping lifecycle incomplete).");
    }
  }

  if (gates.requireGeminiLiveHealthy) {
    const runtime = next.runtime;
    const closeReason = runtime?.geminiCloseReason?.toLowerCase() ?? "";
    const unhealthyClose = closeReason.includes("deadline") || closeReason.includes("timeout");
    if (runtime?.geminiConnect !== true || unhealthyClose) {
      gateFailures.push(
        `Gemini live session unhealthy${runtime?.geminiCloseReason ? `: ${runtime.geminiCloseReason}` : ""}.`,
      );
    }
  }

  if (gates.requireNoToolCallDuplication && next.toolCalls?.duplicatesDetected) {
    gateFailures.push(
      `Duplicate tool calls detected${next.toolCalls.duplicateSamples?.length ? `: ${next.toolCalls.duplicateSamples.join("; ")}` : "."}`,
    );
  }

  if (gates.requireConsoleBudget) {
    const consoleFailures = next.checks.filter((check) => {
      const key = `${check.command} ${check.name ?? ""}`.toLowerCase();
      return key.includes("console") && !check.passed;
    });
    const consoleErrorCount = next.runtime?.consoleErrors ?? 0;
    if (consoleFailures.length > 0 || consoleErrorCount > 0) {
      gateFailures.push("Console budget failed: runtime reported console errors/warnings above threshold.");
    }
  }

  if (gateFailures.length > 0) {
    next.approved = false;
    next.feedback = [next.feedback, "Hard gates blocked approval:", ...gateFailures]
      .filter(Boolean)
      .join("\n\n");
  }

  return next;
}

function resolveGitRef(workspaceDir: string, args: string[]): string | undefined {
  const res = spawnSync("git", ["-C", workspaceDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    return undefined;
  }
  const value = res.stdout.trim();
  return value.length > 0 ? value : undefined;
}

type ResolvedTarget = {
  name: string;
  path: string;
  expectedBranch?: string;
  branchPattern?: string;
  branch?: string;
  commit?: string;
};

export function resolveBoundTarget(task: string, config: FeedbackLoopConfig, baseWorkspace: string): ResolvedTarget | undefined {
  const routing = config.routing;
  if (!routing?.requireRepoBinding) {
    return undefined;
  }
  const allowedTargets = routing.allowedTargets ?? [];
  if (allowedTargets.length === 0) {
    throw new Error(
      "feedbackLoop.routing.requireRepoBinding=true but no routing.allowedTargets configured.",
    );
  }

  const taskLower = task.toLowerCase();
  const branchFromTask =
    task.match(/@([A-Za-z0-9._/-]+)/)?.[1] ??
    task.match(/\bbranch\s+([A-Za-z0-9._/-]+)/i)?.[1];
  const explicitMentions = allowedTargets.filter((target) => {
    const alias = target.name.toLowerCase();
    const base = path.basename(target.path).toLowerCase();
    return taskLower.includes(alias) || taskLower.includes(base);
  });
  const matches = explicitMentions.length > 0 ? explicitMentions : [];
  if (matches.length === 0 && routing.defaultTarget) {
    const defaultTarget = allowedTargets.find((target) => target.name === routing.defaultTarget);
    if (defaultTarget) {
      matches.push(defaultTarget);
    }
  }

  if (matches.length === 0) {
    const names = allowedTargets.map((target) => target.name).join(", ");
    throw new Error(
      `Repo binding required. Specify target repo in task and branch (example: "in aitutor-homework @v1"). Allowed targets: ${names}`,
    );
  }
  if (matches.length > 1 && (routing.onAmbiguousTarget ?? "fail_closed") === "fail_closed") {
    throw new Error(
      `Ambiguous target binding. Matched multiple repos: ${matches.map((m) => m.name).join(", ")}. Please specify one.`,
    );
  }

  const selected = matches[0];
  const targetPath = path.resolve(selected.path);
  const branch = resolveGitRef(targetPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = resolveGitRef(targetPath, ["rev-parse", "HEAD"]);

  if (routing.requireBranchMatch) {
    if (!branchFromTask) {
      throw new Error(
        `Branch binding required for ${selected.name}. Include "@branch" or "branch <name>" in the task.`,
      );
    }
    if (branch && branchFromTask !== branch) {
      throw new Error(
        `Branch mismatch for ${selected.name}: task requested "${branchFromTask}" but workspace is on "${branch}".`,
      );
    }
    if (selected.branchPattern) {
      const re = new RegExp(selected.branchPattern);
      if (!re.test(branchFromTask)) {
        throw new Error(
          `Branch "${branchFromTask}" does not satisfy routing pattern ${selected.branchPattern} for ${selected.name}.`,
        );
      }
    }
  }

  return {
    name: selected.name,
    path: targetPath,
    expectedBranch: branchFromTask,
    branchPattern: selected.branchPattern,
    branch,
    commit,
  };
}

type StructuredEvidence = {
  target?: ReviewResult["target"];
  runtime?: ReviewResult["runtime"];
  mediaMetrics?: ReviewResult["mediaMetrics"];
  toolCalls?: ReviewResult["toolCalls"];
  runtimeLogs?: string[];
};

function parseStructuredEvidence(raw?: string): StructuredEvidence | undefined {
  if (!raw) return undefined;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const target = parsed.target as Record<string, unknown> | undefined;
    const runtime = parsed.runtime as Record<string, unknown> | undefined;
    const mediaMetrics = parsed.mediaMetrics as Record<string, unknown> | undefined;
    const toolCalls = parsed.toolCalls as Record<string, unknown> | undefined;
    const artifacts = parsed.artifacts as Record<string, unknown> | undefined;
    const runtimeLogs = Array.isArray(artifacts?.runtimeLogs)
      ? artifacts?.runtimeLogs.filter((item): item is string => typeof item === "string")
      : undefined;
    return {
      target:
        target && typeof target.path === "string" && typeof target.repo === "string"
          ? {
              repo: target.repo,
              path: target.path,
              branch: typeof target.branch === "string" ? target.branch : undefined,
              commit: typeof target.commit === "string" ? target.commit : undefined,
            }
          : undefined,
      runtime: runtime
        ? {
            websocket: runtime.websocket === true,
            sessionStart: runtime.sessionStart === true,
            sessionEnd: runtime.sessionEnd === true,
            geminiConnect: runtime.geminiConnect === true,
            geminiCloseReason:
              typeof runtime.geminiCloseReason === "string" ? runtime.geminiCloseReason : undefined,
            pingPongOk: runtime.pingPongOk === true,
            authFailures: typeof runtime.authFailures === "number" ? runtime.authFailures : undefined,
            consoleErrors: typeof runtime.consoleErrors === "number" ? runtime.consoleErrors : undefined,
          }
        : undefined,
      mediaMetrics: mediaMetrics
        ? {
            reconnects: typeof mediaMetrics.reconnects === "number" ? mediaMetrics.reconnects : undefined,
            frameGapMsP95:
              typeof mediaMetrics.frameGapMsP95 === "number" ? mediaMetrics.frameGapMsP95 : undefined,
            audioChunkMsP95:
              typeof mediaMetrics.audioChunkMsP95 === "number" ? mediaMetrics.audioChunkMsP95 : undefined,
            pingPongOk: mediaMetrics.pingPongOk === true,
            minMessagesPerMinute:
              typeof mediaMetrics.minMessagesPerMinute === "number"
                ? mediaMetrics.minMessagesPerMinute
                : undefined,
          }
        : undefined,
      toolCalls: toolCalls
        ? {
            duplicatesDetected: toolCalls.duplicatesDetected === true,
            duplicateSamples: Array.isArray(toolCalls.duplicateSamples)
              ? toolCalls.duplicateSamples.filter((item): item is string => typeof item === "string")
              : undefined,
          }
        : undefined,
      runtimeLogs,
    };
  } catch {
    return undefined;
  }
}

export type LoopState = {
  task: string;
  iteration: number;
  approved: boolean;
  paused: boolean;
  userMessage?: string;
  previousFeedback?: string;
  history: IterationResult[];
  // New: acceptance criteria and memory context
  acceptanceCriteria?: string[];
  pastIssues?: string;
  checklist?: string;
  // Planning-with-files pattern
  planningFiles?: PlanningFiles;
  consecutiveErrors: number;
  lastErrorAction?: string;
};

export type LoopResult = {
  approved: boolean;
  iterations: number;
  history: IterationResult[];
  finalMessage?: string;
  /** Screenshot paths as proof of completion (sent with WhatsApp reply) */
  screenshots?: string[];
  /** Changed files list */
  changedFiles?: string[];
  /** Commit info if auto-committed */
  commit?: { committed: boolean; sha?: string; prUrl?: string };
};

/**
 * Run the feedback loop with the DEFAULT workflow:
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  EXPLORE → PLAN → IMPLEMENT → COMMIT                           │
 * │                                                                 │
 * │  1. EXPLORE: Read files, understand codebase                   │
 * │  2. PLAN: Create detailed implementation plan                  │
 * │  3. IMPLEMENT: Coder writes code, Reviewer verifies (loop)     │
 * │  4. COMMIT: Auto-commit with descriptive message               │
 * └─────────────────────────────────────────────────────────────────┘
 */
export async function runFeedbackLoop(
  api: OpenClawPluginApi,
  task: string,
  config: FeedbackLoopConfig,
  opts: {
    agentId: string;
    sessionKey: string;
    workspaceDir: string;
    onUserInput?: () => Promise<{ action: "continue" | "message" | "approve" | "reject"; message?: string }>;
  },
): Promise<LoopResult> {
  const maxIterations = config.maxIterations ?? 5;
  const gates = resolveFeedbackLoopGates(config);
  const terminal = new TerminalStreamer(config.terminal?.verbose ?? false);
  const sessionId = crypto.randomUUID().slice(0, 8);
  const state: LoopState = {
    task,
    iteration: 0,
    approved: false,
    paused: false,
    history: [],
    consecutiveErrors: 0,
  };

  // ============================================
  // DISPLAY: Workflow Banner
  // ============================================
  terminal.header(`FEEDBACK LOOP: ${task.slice(0, 50)}${task.length > 50 ? "..." : ""}`);
  terminal.log("");
  terminal.log("┌─────────────────────────────────────────────────────┐");
  terminal.log("│  WORKFLOW: Explore → Plan → Implement → Commit     │");
  terminal.log("└─────────────────────────────────────────────────────┘");
  terminal.log("");
  terminal.hotkeys();

  // ============================================
  // CLAUDE CODE INTEGRATION: Initialize task tracking
  // ============================================
  resetContextMetrics();
  const workflowTasks = createWorkflowTasks(task);
  console.log(`[feedback-loop] Created ${workflowTasks.length} workflow tasks for tracking`);
  terminal.log(`Task tracking: ${workflowTasks.length} phases`);

  // ============================================
  // LOG WORKFLOW CONFIGURATION
  // ============================================
  const coderModel = config.coder ?? "openai-codex/gpt-5.2";
  const reviewerModel = config.reviewer ?? "anthropic/claude-sonnet-4-5";
  const antigravityEnabled = config.antigravity?.enabled !== false;
  const antigravityFallbackModel = config.antigravity?.coderModel ?? "google-antigravity/claude-sonnet-4-5";

  console.log(`[feedback-loop] DEFAULT WORKFLOW: Explore → Plan → Implement → Commit`);
  console.log(`[feedback-loop] Coder: ${coderModel} → Fallback: ${antigravityFallbackModel} → Reviewer: ${reviewerModel}`);
  terminal.log(`Coder: ${coderModel.split("/").pop()}`);
  if (antigravityEnabled) {
    terminal.log(`Fallback: ${antigravityFallbackModel.split("/").pop()} (Antigravity)`);
  }
  terminal.log(`Reviewer: ${reviewerModel.split("/").pop()}`);

  // ============================================
  // PHASE -2: Resolve target binding and detect project root
  // ============================================
  const boundTarget = resolveBoundTarget(task, config, opts.workspaceDir);
  const targetWorkspace = boundTarget?.path ?? opts.workspaceDir;
  if (boundTarget) {
    console.log(
      `[feedback-loop] Target binding locked: ${boundTarget.name} (${boundTarget.path})` +
        `${boundTarget.expectedBranch ? ` @${boundTarget.expectedBranch}` : ""}`,
    );
    terminal.log(
      `Target locked: ${boundTarget.name}${boundTarget.expectedBranch ? ` @${boundTarget.expectedBranch}` : ""}`,
    );
  }

  console.log(`[feedback-loop] Detecting project root from task...`);
  const projectDetection = await detectProjectRoot(task, targetWorkspace);
  const effectiveWorkspace = projectDetection.projectRoot;
  const projectContext = await loadProjectContext(projectDetection);

  if (projectDetection.detected) {
    const relativePath = effectiveWorkspace.replace(opts.workspaceDir, "").replace(/^\//, "") || ".";
    console.log(`[feedback-loop] Project detected: ${effectiveWorkspace} (${projectDetection.method})`);
    terminal.log(`Project detected: ${relativePath}`);
  } else {
    console.log(`[feedback-loop] Using base workspace: ${effectiveWorkspace}`);
  }

  if (projectContext) {
    console.log(`[feedback-loop] Loaded project context (AGENTS.md/CLAUDE.md)`);
  }

  const targetEvidence: NonNullable<ReviewResult["target"]> = {
    repo: boundTarget?.name ?? path.basename(effectiveWorkspace),
    path: effectiveWorkspace,
    branch: boundTarget?.branch ?? resolveGitRef(effectiveWorkspace, ["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: boundTarget?.commit ?? resolveGitRef(effectiveWorkspace, ["rev-parse", "HEAD"]),
  };

  // ============================================
  // PHASE -1: Initialize planning files (planning-with-files pattern)
  // ============================================
  console.log(`[feedback-loop] Initializing planning files...`);
  try {
    state.planningFiles = await initializePlanningFiles({
      workspaceDir: effectiveWorkspace,
      task,
      sessionId,
      acceptanceCriteria: config.acceptanceCriteria,
    });
    terminal.log(`Planning files initialized at .feedback-loop/${sessionId}`);
  } catch (err) {
    console.log(`[feedback-loop] Planning files init failed: ${err}`);
  }

  // ============================================
  // PHASE -0.5: TASK ENHANCEMENT - Auto-structure vague tasks
  // ============================================
  console.log(`[feedback-loop] Enhancing task with verification criteria...`);
  let enhancedTask: EnhancedTask | undefined;

  try {
    enhancedTask = await enhanceTask(task, {
      config,
      agentId: opts.agentId,
      sessionKey: opts.sessionKey,
      workspaceDir: effectiveWorkspace,
      projectContext,
    });

    terminal.log(`Task enhanced (${enhancedTask.method}): ${enhancedTask.complexity} complexity`);

    if (enhancedTask.verification.commands.length > 0) {
      const requiredCmds = enhancedTask.verification.commands.filter(c => c.required);
      terminal.log(`Verification: ${requiredCmds.length} required commands, ${enhancedTask.verification.browserUrls.length} URLs`);
    }
    if (enhancedTask.verification.expectedOutcomes.length > 0) {
      terminal.log(`Expected outcomes: ${enhancedTask.verification.expectedOutcomes.length}`);
    }
    if (enhancedTask.verification.edgeCases.length > 0) {
      terminal.log(`Edge cases to test: ${enhancedTask.verification.edgeCases.length}`);
    }
    if (enhancedTask.targetFiles.length > 0) {
      terminal.log(`Target files: ${enhancedTask.targetFiles.join(", ")}`);
    }

    console.log(`[feedback-loop] Enhanced task:\n${enhancedTask.structured.slice(0, 500)}...`);
  } catch (err) {
    console.log(`[feedback-loop] Task enhancement failed, using original: ${err}`);
  }

  // Also extract basic verification (fallback if enhancement failed)
  const verificationCriteria = extractVerificationCriteria(task);
  const taskContext = extractTaskContext(task, projectContext);
  const simpleTask = enhancedTask?.complexity === "simple" || isSimpleTask(task);

  // ============================================
  // CONTEXT LOADING - Extract and READ referenced files, patterns, constraints
  // ============================================
  console.log(`[feedback-loop] Loading rich context from task...`);
  let loadedContext: LoadedContext | undefined;

  try {
    loadedContext = await loadAndBuildContext(task, effectiveWorkspace);
    const summary = getContextSummary(loadedContext.extracted);
    console.log(`[feedback-loop] Loaded context: ${summary}`);

    if (loadedContext.fileContents.size > 0) {
      terminal.log(`Pre-loaded ${loadedContext.fileContents.size} files (~${loadedContext.estimatedTokens} tokens)`);
    }
    if (loadedContext.extracted.constraints.length > 0) {
      terminal.log(`Constraints: ${loadedContext.extracted.constraints.map(c => c.description).join("; ")}`);
    }
    if (loadedContext.extracted.examplePatterns.length > 0) {
      terminal.log(`Patterns to follow: ${loadedContext.extracted.examplePatterns.map(p => p.file).join(", ")}`);
    }
    if (loadedContext.extracted.symptom) {
      terminal.log(`Symptom: ${loadedContext.extracted.symptom.symptom.slice(0, 50)}...`);
    }
  } catch (err) {
    console.log(`[feedback-loop] Context loading failed: ${err}`);
  }

  // Store in state for use in coder/reviewer
  const bestPracticesContext = {
    verification: verificationCriteria,
    taskContext,
    isSimple: simpleTask,
    enhanced: enhancedTask, // Include enhanced task
    loadedContext, // Include loaded file contents and constraints
  };

  // Extract rich content (legacy - for backwards compatibility)
  const richContent = extractRichContent(task);
  if (richContent.length > 0 && !loadedContext) {
    terminal.log(`Rich content: ${richContent.map(c => c.type).join(", ")}`);
  }

  // Generate interview questions for complex tasks (optional)
  if (!simpleTask && config.interview?.enabled) {
    const interviewQuestions = generateInterviewQuestions(task);
    if (interviewQuestions.length > 0) {
      const highPriority = interviewQuestions.filter(q => q.priority === "high");
      if (highPriority.length > 0) {
        terminal.log(`[Interview] ${highPriority.length} questions to clarify before coding`);
        // In interactive mode, these would be asked before proceeding
        console.log(`[feedback-loop] Interview questions:`);
        for (const q of highPriority) {
          console.log(`  - [${q.category}] ${q.question}`);
        }
      }
    }
  }

  // Initialize session checkpoint for resume capability
  let sessionCheckpoints: SessionCheckpoint[] = [];

  // ============================================
  // PHASE 0: Generate acceptance criteria BEFORE coding
  // ============================================
  if (config.generateAcceptanceCriteria !== false) {
    console.log(`[feedback-loop] Phase 0: Generating acceptance criteria...`);
    try {
      state.acceptanceCriteria = await generateAcceptanceCriteria({
        task,
        config,
        agentId: opts.agentId,
        sessionKey: opts.sessionKey,
        workspaceDir: effectiveWorkspace,
        checklist: state.checklist,
      });
      if (state.acceptanceCriteria.length > 0) {
        terminal.log(`Generated ${state.acceptanceCriteria.length} acceptance criteria`);
      }
    } catch (err) {
      console.log(`[feedback-loop] Criteria generation failed: ${err}`);
    }
  }

  // ============================================
  // PHASE 1: Load memory (past issues, standards)
  // ============================================
  console.log(`[feedback-loop] Phase 1: Loading memory context...`);
  try {
    const memoryCtx = { config, workspaceDir: effectiveWorkspace };
    state.pastIssues = await loadPastIssues(memoryCtx);
    state.checklist = await loadChecklist(memoryCtx);

    if (state.pastIssues) {
      terminal.log(`Loaded past issues from memory`);
    }
    if (state.checklist) {
      terminal.log(`Loaded project checklist`);
    }
  } catch (err) {
    console.log(`[feedback-loop] Memory loading failed: ${err}`);
  }

  // ============================================
  // WORKFLOW PHASE 1: EXPLORE - Understand the codebase
  // ============================================
  terminal.log("");
  terminal.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  terminal.log("  PHASE 1: EXPLORE - Reading files and understanding codebase");
  terminal.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[feedback-loop] Starting EXPLORE phase...`);

  // Update task tracking
  const exploreTaskId = workflowTasks.find(t => t.subject.includes("Explore"))?.id;
  if (exploreTaskId) updateTask(exploreTaskId, { status: "in_progress" });

  // Emit SubagentStart event
  await emitSubagentEvent({
    type: "SubagentStart",
    agentId: `explore-${sessionId}`,
    subagentType: "Explore",
    description: "Exploring codebase for task context",
    parentSessionKey: opts.sessionKey,
    timestamp: Date.now(),
  });

  const workflowContext: WorkflowContext = {
    task,
    enhancedTask,
    config,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    workspaceDir: effectiveWorkspace,
    projectContext,
  };

  let exploreResult: ExploreResult | undefined;
  let planResult: PlanResult | undefined;

  try {
    exploreResult = await runExplorePhase(workflowContext);

    // Emit SubagentStop event
    await emitSubagentEvent({
      type: "SubagentStop",
      agentId: `explore-${sessionId}`,
      subagentType: "Explore",
      description: exploreResult.success ? "Exploration complete" : "Exploration failed",
      parentSessionKey: opts.sessionKey,
      timestamp: Date.now(),
    });

    // Update task tracking
    if (exploreTaskId) {
      updateTask(exploreTaskId, { status: exploreResult.success ? "completed" : "pending" });
    }

    // Update context metrics
    if (exploreResult.artifacts.relevantFiles) {
      const fileCount = exploreResult.artifacts.relevantFiles.split("\n").filter(Boolean).length;
      updateContextMetrics({ filesRead: fileCount, phase: "explore" });
    }

    if (exploreResult.success) {
      terminal.log(`✓ Explore complete (${Math.round(exploreResult.duration / 1000)}s)`);
      if (exploreResult.artifacts.relevantFiles) {
        terminal.log(`  Found ${exploreResult.artifacts.relevantFiles.split("\n").filter(Boolean).length} relevant files`);
      }
    } else {
      terminal.log(`⚠ Explore phase had issues, continuing...`);
    }
  } catch (err) {
    console.log(`[feedback-loop] EXPLORE failed: ${err}`);
    terminal.log(`⚠ Explore skipped due to error`);

    // Emit error event
    await emitSubagentEvent({
      type: "SubagentStop",
      agentId: `explore-${sessionId}`,
      subagentType: "Explore",
      description: `Error: ${err}`,
      parentSessionKey: opts.sessionKey,
      timestamp: Date.now(),
    });
  }

  // ============================================
  // WORKFLOW PHASE 2: PLAN - Create implementation plan
  // ============================================
  terminal.log("");
  terminal.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  terminal.log("  PHASE 2: PLAN - Creating detailed implementation plan");
  terminal.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[feedback-loop] Starting PLAN phase...`);

  // Update task tracking
  const planTaskId = workflowTasks.find(t => t.subject.includes("plan"))?.id;
  if (planTaskId) updateTask(planTaskId, { status: "in_progress" });

  if (exploreResult) {
    // Emit SubagentStart event
    await emitSubagentEvent({
      type: "SubagentStart",
      agentId: `plan-${sessionId}`,
      subagentType: "Plan",
      description: "Creating implementation plan",
      parentSessionKey: opts.sessionKey,
      timestamp: Date.now(),
    });

    try {
      planResult = await runPlanPhase(workflowContext, exploreResult);

      // Emit SubagentStop event
      await emitSubagentEvent({
        type: "SubagentStop",
        agentId: `plan-${sessionId}`,
        subagentType: "Plan",
        description: planResult.success ? "Plan created" : "Planning failed",
        parentSessionKey: opts.sessionKey,
        timestamp: Date.now(),
      });

      // Update task tracking
      if (planTaskId) {
        updateTask(planTaskId, { status: planResult.success ? "completed" : "pending" });
      }

      // Update context metrics
      updateContextMetrics({ phase: "plan" });

      if (planResult.success) {
        terminal.log(`✓ Plan created (${Math.round(planResult.duration / 1000)}s)`);
        if (planResult.artifacts.filesToModify) {
          terminal.log(`  Files to modify: ${planResult.artifacts.filesToModify.split("\n").filter(Boolean).length}`);
        }
        if (planResult.artifacts.risks) {
          const riskCount = planResult.artifacts.risks.split("\n").filter(Boolean).length;
          if (riskCount > 0) {
            terminal.log(`  Risks identified: ${riskCount}`);
          }
        }
        // Show plan summary
        if (planResult.artifacts.implementationPlan) {
          terminal.log("");
          terminal.log("  PLAN SUMMARY:");
          const planLines = planResult.artifacts.implementationPlan.split("\n").slice(0, 5);
          for (const line of planLines) {
            terminal.log(`    ${line}`);
          }
          if (planResult.artifacts.implementationPlan.split("\n").length > 5) {
            terminal.log(`    ... (${planResult.artifacts.implementationPlan.split("\n").length - 5} more steps)`);
          }
        }
      } else {
        terminal.log(`⚠ Plan phase had issues, continuing with direct implementation...`);
      }
    } catch (err) {
      console.log(`[feedback-loop] PLAN failed: ${err}`);
      terminal.log(`⚠ Plan skipped due to error`);

      // Emit error event
      await emitSubagentEvent({
        type: "SubagentStop",
        agentId: `plan-${sessionId}`,
        subagentType: "Plan",
        description: `Error: ${err}`,
        parentSessionKey: opts.sessionKey,
        timestamp: Date.now(),
      });
    }
  }

  // ============================================
  // WORKFLOW PHASE 3: IMPLEMENT - Coder → Reviewer loop
  // ============================================
  terminal.log("");
  terminal.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  terminal.log("  PHASE 3: IMPLEMENT - Coding with verification");
  terminal.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[feedback-loop] Starting IMPLEMENT phase (coder → reviewer loop)...`);

  // Update task tracking
  const implementTaskId = workflowTasks.find(t => t.subject.includes("Implement"))?.id;
  if (implementTaskId) updateTask(implementTaskId, { status: "in_progress" });

  // Update context metrics
  updateContextMetrics({ phase: "implement" });

  // Build implementation prompt with plan context
  let implementationPrompt = "";
  if (planResult?.success) {
    implementationPrompt = buildImplementPrompt(workflowContext, planResult);
  }

  while (!state.approved && state.iteration < maxIterations) {
    state.iteration++;
    terminal.iteration(state.iteration);

    // ============================================
    // CONTEXT HEALTH CHECK (Best Practice: "Manage context aggressively")
    // ============================================
    const filesReadEstimate = state.history.length * 5; // Rough estimate
    const tokensEstimate = state.history.length * 10000; // Rough estimate per iteration
    const contextHealth = assessContextHealth(state.iteration, filesReadEstimate, tokensEstimate);

    if (contextHealth.status === "critical") {
      terminal.log(`⚠️ Context health: CRITICAL (${Math.round(contextHealth.usagePercent)}%)`);
      for (const suggestion of contextHealth.suggestions) {
        terminal.log(`   → ${suggestion}`);
      }
    } else if (contextHealth.status === "warning" && state.iteration > 2) {
      terminal.log(`⚠️ Context health: ${Math.round(contextHealth.usagePercent)}% used`);
    }

    // ============================================
    // COURSE CORRECTION CHECK (Best Practice: "Course-correct early and often")
    // ============================================
    const feedbackHistory = state.history
      .filter((h) => h.reviewResult?.feedback)
      .map((h) => h.reviewResult.feedback ?? "");

    // Count recurring issues
    const issuePatterns = new Map<string, number>();
    for (const fb of feedbackHistory) {
      if (/test.*fail/i.test(fb)) issuePatterns.set("test-failure", (issuePatterns.get("test-failure") ?? 0) + 1);
      if (/type.*error/i.test(fb)) issuePatterns.set("type-error", (issuePatterns.get("type-error") ?? 0) + 1);
      if (/not.*integrat/i.test(fb)) issuePatterns.set("integration", (issuePatterns.get("integration") ?? 0) + 1);
    }
    const maxRecurrence = Math.max(0, ...issuePatterns.values());

    const courseCorrection = suggestCourseCorrection(
      state.iteration,
      state.consecutiveErrors,
      maxRecurrence,
      contextHealth.usagePercent / 100,
    );

    if (courseCorrection) {
      terminal.log(`🔄 [${courseCorrection.type.toUpperCase()}] ${courseCorrection.reason}`);
      terminal.log(`   → ${courseCorrection.action}`);

      if (courseCorrection.type === "escalate") {
        // Force pause for human intervention
        state.paused = true;
        terminal.pause(state.iteration, "Escalation required");
        if (opts.onUserInput) {
          const input = await opts.onUserInput();
          if (input.action === "approve") {
            state.approved = true;
            break;
          } else if (input.action === "reject") {
            break;
          } else if (input.action === "message") {
            state.userMessage = input.message;
            // Reset error count for fresh approach
            state.consecutiveErrors = 0;
          }
        }
        state.paused = false;
      }
    }

    // Check for auto-pause
    if (config.intervention?.pauseAfterIterations && state.iteration > 1) {
      if (state.iteration % config.intervention.pauseAfterIterations === 0) {
        state.paused = true;
        terminal.pause(state.iteration);
        if (opts.onUserInput) {
          const input = await opts.onUserInput();
          if (input.action === "approve") {
            state.approved = true;
            terminal.log("User forced approval");
            break;
          } else if (input.action === "reject") {
            terminal.log("User rejected - ending loop");
            break;
          } else if (input.action === "message") {
            state.userMessage = input.message;
          }
        }
        state.paused = false;
      }
    }

    // ============================================
    // PRE-ACTION: Read plan context (planning-with-files pattern)
    // ============================================
    let planContext = "";
    if (state.planningFiles) {
      planContext = await buildPlanContext(state.planningFiles);
      console.log(`[feedback-loop] Plan context loaded (${planContext.length} chars)`);

      // Update progress: starting iteration
      await updateProgress(state.planningFiles.progressPath, {
        lastAction: `Starting iteration ${state.iteration}`,
        incrementActions: true,
        addIteration: {
          iteration: state.iteration,
          startTime: new Date().toISOString(),
        },
      });
    }

    // 3-Strike Check: if same action failed 3 times, pause for user
    if (state.lastErrorAction && checkThreeStrikes(await readTaskPlanForCheck(state.planningFiles), state.lastErrorAction)) {
      terminal.log(`⚠️ 3-Strike limit reached for: ${state.lastErrorAction}`);
      state.paused = true;
      if (opts.onUserInput) {
        terminal.pause(state.iteration, "3-strike limit reached - need different approach");
        const input = await opts.onUserInput();
        if (input.action === "approve") {
          state.approved = true;
          break;
        } else if (input.action === "reject") {
          break;
        } else if (input.action === "message") {
          state.userMessage = input.message;
          // Reset error tracking for new approach
          state.consecutiveErrors = 0;
          state.lastErrorAction = undefined;
        }
      }
      state.paused = false;
    }

    // Step 1: Codex codes (with plan from EXPLORE → PLAN phases)
    const coderLabel = state.previousFeedback ? "fixing" : "coding";
    terminal.coderStart(coderLabel);

    const coderResult = await spawnCoder(api, {
      task: state.task,
      enhancedTask: bestPracticesContext.enhanced, // Pass enhanced task with verification criteria
      implementationPrompt, // From PLAN phase - detailed implementation plan
      exploreContext: exploreResult?.artifacts, // From EXPLORE phase - codebase understanding
      previousFeedback: state.previousFeedback,
      userMessage: state.userMessage,
      planContext, // Inject plan context (planning-with-files)
      projectContext, // Inject AGENTS.md/CLAUDE.md
      loadedContext: bestPracticesContext.loadedContext, // Pre-loaded files, patterns, constraints
      verificationCriteria: bestPracticesContext.verification,
      taskContext: bestPracticesContext.taskContext,
      config,
      agentId: opts.agentId,
      sessionKey: opts.sessionKey,
      workspaceDir: effectiveWorkspace,
    });

    terminal.coderEnd(coderResult.summary);

    // Clear one-time user message
    state.userMessage = undefined;

    // ============================================
    // PHASE 3: Claude reviews (or shell commands as fallback)
    // ============================================
    console.log(`[feedback-loop] Coder done, starting reviewer...`);
    console.log(`[feedback-loop] Workspace: ${effectiveWorkspace}`);
    console.log(`[feedback-loop] Commands: ${config.commands?.length ?? 0}`);
    console.log(`[feedback-loop] Acceptance criteria: ${state.acceptanceCriteria?.length ?? 0}`);
    console.log(`[feedback-loop] Using Claude reviewer: ${config.review?.useBrowser !== false}`);
    terminal.reviewerStart();

    let reviewResult: ReviewResult;
    const commandSummaries: string[] = [];
    const urlsTested: string[] = [];
    const runtimeLogs: string[] = [];

    // Use Claude reviewer if configured (default: yes)
    if (config.review?.useBrowser !== false && config.reviewer) {
      console.log(`[feedback-loop] Spawning Claude reviewer with browser access...`);
      reviewResult = await spawnClaudeReviewer({
        task: state.task,
        coderSummary: coderResult.summary,
        acceptanceCriteria: state.acceptanceCriteria,
        pastIssues: state.pastIssues,
        checklist: state.checklist,
        planContext, // Pass plan context to reviewer too
        projectContext, // Pass AGENTS.md/CLAUDE.md to reviewer
        config,
        globalConfig: api.config,
        agentId: opts.agentId,
        sessionKey: opts.sessionKey,
        workspaceDir: effectiveWorkspace,
      });

      // ============================================
      // MANDATORY BROWSER VERIFICATION (after Claude reviewer)
      // The reviewer agent may not have browser tools - verify programmatically
      // ============================================
      if (config.browser?.enabled || config.browser?.urls?.length) {
        console.log(`[feedback-loop] Running mandatory browser verification...`);
        terminal.log(`Running browser verification...`);

        const browserResult = await runBrowserChecks(config.browser, terminal);
        urlsTested.push(...browserResult.results.map((result) => result.url));

        if (!browserResult.passed) {
          // Browser checks failed - override approval
          console.log(`[feedback-loop] Browser verification FAILED: ${browserResult.errors.join("; ")}`);
          terminal.log(`⚠ Browser checks failed:`);
          for (const err of browserResult.errors) {
            terminal.log(`  - ${err}`);
          }

          // Override reviewer approval if browser checks fail
          if (reviewResult.approved) {
            console.log(`[feedback-loop] Overriding reviewer approval due to browser failures`);
            reviewResult.approved = false;
            reviewResult.feedback = (reviewResult.feedback || "") +
              `\n\n**Browser verification failed:**\n${browserResult.errors.map(e => `- ${e}`).join("\n")}`;
          }
          reviewResult.browserErrors = browserResult.errors;
          reviewResult.checks.push({
            command: "browser-check",
            name: "browser-check",
            passed: false,
            evidence: browserResult.errors.join("; "),
            error: browserResult.errors.join("; "),
          });
        } else {
          console.log(`[feedback-loop] Browser verification PASSED`);
          terminal.log(`✓ Browser checks passed`);
          reviewResult.checks.push({
            command: "browser-check",
            name: "browser-check",
            passed: true,
            evidence: "Browser verification passed",
          });

          // Collect screenshots from browser results if available
          const screenshotPaths = browserResult.results
            .filter(r => r.screenshotPath)
            .map(r => r.screenshotPath!);
          if (screenshotPaths.length > 0) {
            reviewResult.screenshots = [
              ...(reviewResult.screenshots || []),
              ...screenshotPaths,
            ];
          }
        }
      } else {
        // No browser config - auto-detect URLs from task and verify
        console.log(`[feedback-loop] No browser URLs configured, auto-detecting from task...`);
        const autoUrls = extractUrlsFromTask(state.task, coderResult.summary);

        if (autoUrls.length > 0) {
          console.log(`[feedback-loop] Auto-detected ${autoUrls.length} URLs to verify: ${autoUrls.join(", ")}`);
          terminal.log(`Auto-verifying ${autoUrls.length} URLs...`);

          const autoBrowserConfig = {
            enabled: true,
            urls: autoUrls,
            checkConsole: true,
            checkNetwork: true,
          };

          const browserResult = await runBrowserChecks(autoBrowserConfig, terminal);
          urlsTested.push(...browserResult.results.map((result) => result.url));

          if (!browserResult.passed) {
            console.log(`[feedback-loop] Auto browser verification FAILED`);
            terminal.log(`⚠ Browser checks failed`);

            if (reviewResult.approved) {
              reviewResult.approved = false;
              reviewResult.feedback = (reviewResult.feedback || "") +
                `\n\n**Browser verification failed:**\n${browserResult.errors.map(e => `- ${e}`).join("\n")}`;
            }
            reviewResult.browserErrors = browserResult.errors;
            reviewResult.checks.push({
              command: "browser-check",
              name: "browser-check",
              passed: false,
              evidence: browserResult.errors.join("; "),
              error: browserResult.errors.join("; "),
            });
          } else {
            console.log(`[feedback-loop] Auto browser verification PASSED`);
            terminal.log(`✓ Browser checks passed`);
            reviewResult.checks.push({
              command: "browser-check",
              name: "browser-check",
              passed: true,
              evidence: "Browser verification passed",
            });
          }
        }
      }

      // Run deterministic machine checks in addition to AI reviewer checks.
      if (config.commands?.length) {
        const commandChecks = await runVerificationCommands(config.commands, effectiveWorkspace, terminal);
        for (const check of commandChecks) {
          const normalized: CheckResult = {
            ...check,
            name: check.command,
            evidence: check.output ?? check.error,
          };
          reviewResult.checks.push(normalized);
          const structuredEvidence = parseStructuredEvidence(check.output);
          if (structuredEvidence?.target) {
            reviewResult.target = { ...reviewResult.target, ...structuredEvidence.target };
          }
          if (structuredEvidence?.runtime) {
            reviewResult.runtime = { ...reviewResult.runtime, ...structuredEvidence.runtime };
          }
          if (structuredEvidence?.mediaMetrics) {
            reviewResult.mediaMetrics = { ...reviewResult.mediaMetrics, ...structuredEvidence.mediaMetrics };
          }
          if (structuredEvidence?.toolCalls) {
            reviewResult.toolCalls = { ...reviewResult.toolCalls, ...structuredEvidence.toolCalls };
          }
          if (structuredEvidence?.runtimeLogs?.length) {
            runtimeLogs.push(...structuredEvidence.runtimeLogs);
          }
          if (check.output && /runtime|websocket|gemini|tool/i.test(check.command)) {
            runtimeLogs.push(check.output.slice(-800));
          }
          commandSummaries.push(
            `${check.command}: ${check.passed ? "PASS" : `FAIL (${check.error ?? "failed"})`}`,
          );
        }
      }
    } else {
      // Fallback: shell commands only
      console.log(`[feedback-loop] Using shell command reviewer (Claude disabled)...`);
      reviewResult = await runReview({
        coderResult,
        config,
        workspaceDir: effectiveWorkspace,
        terminal,
      });

      for (const check of reviewResult.checks) {
        if (!check.command) {
          continue;
        }
        commandSummaries.push(
          `${check.command}: ${check.passed ? "PASS" : `FAIL (${check.error ?? "failed"})`}`,
        );
      }
    }

    const unique = <T>(items: T[]) => Array.from(new Set(items));
    reviewResult.target = reviewResult.target ?? targetEvidence;
    reviewResult.runtime = reviewResult.runtime ?? {};
    reviewResult.mediaMetrics = reviewResult.mediaMetrics ?? {};
    reviewResult.toolCalls = reviewResult.toolCalls ?? { duplicatesDetected: false };
    reviewResult.artifacts = {
      screenshots: unique([...(reviewResult.artifacts?.screenshots ?? []), ...(reviewResult.screenshots ?? [])]),
      urlsTested: unique([...(reviewResult.artifacts?.urlsTested ?? []), ...urlsTested]),
      commandSummaries: unique([...(reviewResult.artifacts?.commandSummaries ?? []), ...commandSummaries]),
      runtimeLogs: unique([...(reviewResult.artifacts?.runtimeLogs ?? []), ...runtimeLogs]),
    };

    reviewResult = applyHardApprovalGates({
      reviewResult,
      config,
      gates,
    });

    console.log(`[feedback-loop] Reviewer done, approved=${reviewResult.approved}`);

    // Record iteration
    const iterResult: IterationResult = {
      iteration: state.iteration,
      coderSummary: coderResult.summary,
      reviewResult,
    };
    state.history.push(iterResult);

    // ============================================
    // POST-ACTION: Update progress files (planning-with-files pattern)
    // ============================================
    if (state.planningFiles) {
      // Update iteration in progress file
      await updateProgress(state.planningFiles.progressPath, {
        lastAction: reviewResult.approved ? "Review approved" : "Review rejected - needs fixes",
        incrementActions: true,
        updateIteration: {
          iteration: state.iteration,
          endTime: new Date().toISOString(),
          coderSummary: coderResult.summary,
          reviewerVerdict: reviewResult.approved ? "approved" : "rejected",
          feedback: reviewResult.feedback,
        },
      });

      // Track errors for 3-strike protocol
      if (!reviewResult.approved && reviewResult.feedback) {
        state.consecutiveErrors++;
        state.lastErrorAction = reviewResult.feedback.slice(0, 100); // Track what failed

        // Log error to task plan for 3-strike tracking
        await updateTaskPlan(state.planningFiles.taskPlanPath, {
          addError: {
            timestamp: new Date().toISOString(),
            action: `Iteration ${state.iteration}`,
            error: reviewResult.feedback.slice(0, 500),
            attempts: state.consecutiveErrors,
          },
        });
      } else if (reviewResult.approved) {
        // Reset error tracking on success
        state.consecutiveErrors = 0;
        state.lastErrorAction = undefined;
      }
    }

    // ============================================
    // PHASE 4: Save feedback to memory (for learning)
    // ============================================
    if (config.memory?.saveAfterReview !== false) {
      try {
        await saveFeedbackToMemory(
          { config, workspaceDir: effectiveWorkspace },
          {
            task: state.task,
            iterations: state.iteration,
            approved: reviewResult.approved,
            reviewResult,
          },
        );
      } catch (err) {
        console.log(`[feedback-loop] Memory save failed: ${err}`);
      }
    }

    // ============================================
    // PHASE 4.5: Extract and save learned rules (pro-workflow pattern)
    // ============================================
    if (reviewResult.feedback) {
      try {
        const lessons = extractLessons(reviewResult.feedback);
        if (lessons.length > 0) {
          const learnedPath = `${effectiveWorkspace}/memory/LEARNED.md`;
          const saved = await appendLearnedRules(learnedPath, lessons);
          if (saved > 0) {
            console.log(`[feedback-loop] Saved ${saved} new learned rules`);
          }
        }
      } catch (err) {
        console.log(`[feedback-loop] Learned rules save failed: ${err}`);
      }
    }

    if (reviewResult.approved) {
      state.approved = true;
      terminal.approved();
    } else {
      terminal.feedback(reviewResult.feedback ?? "Issues found, needs fixes");
      state.previousFeedback = reviewResult.feedback;

      // 3-Strike Warning in terminal
      if (state.consecutiveErrors >= 2) {
        terminal.log(`⚠️ ${state.consecutiveErrors} consecutive failures - approaching 3-strike limit`);
      }

      // Detect failure patterns (best practices)
      const feedbackHistory = state.history
        .filter((h) => h.reviewResult?.feedback)
        .map((h) => h.reviewResult.feedback ?? "");
      const failurePatterns = detectFailurePatterns(
        state.iteration,
        state.consecutiveErrors,
        0.5, // TODO: Get actual context usage
        feedbackHistory,
      );
      for (const pattern of failurePatterns) {
        terminal.log(`⚠️ [${pattern.type}] ${pattern.description}`);
        terminal.log(`   → ${pattern.suggestion}`);
      }

      // Check for browser fail pause
      if (config.intervention?.pauseOnBrowserFail && reviewResult.browserErrors?.length) {
        state.paused = true;
        terminal.pause(state.iteration, "Browser errors detected");
        if (opts.onUserInput) {
          const input = await opts.onUserInput();
          if (input.action === "approve") {
            state.approved = true;
            break;
          } else if (input.action === "reject") {
            break;
          } else if (input.action === "message") {
            state.userMessage = input.message;
          }
        }
        state.paused = false;
      }
    }
  }

  if (!state.approved && state.iteration >= maxIterations) {
    terminal.maxIterations(maxIterations);
  }

  // ============================================
  // PHASE 5: Create session checkpoint for resume capability
  // ============================================
  const changedFiles = state.history
    .flatMap((h) => h.coderResult?.filesChanged ?? [])
    .filter((f, i, arr) => arr.indexOf(f) === i);

  const finalCheckpoint = createSessionCheckpoint(
    {
      task: state.task,
      iteration: state.iteration,
      approved: state.approved,
      previousFeedback: state.previousFeedback,
    },
    changedFiles,
    state.approved ? "commit" : "review",
  );
  sessionCheckpoints.push(finalCheckpoint);
  console.log(`[feedback-loop] Session checkpoint: ${finalCheckpoint.id}`);

  // Update implement task on completion
  if (implementTaskId) {
    updateTask(implementTaskId, { status: state.approved ? "completed" : "pending" });
  }

  // ============================================
  // WORKFLOW PHASE 4: COMMIT - Auto-commit if approved
  // ============================================
  terminal.log("");
  terminal.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  terminal.log("  PHASE 4: COMMIT - Committing changes");
  terminal.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Update task tracking
  const commitTaskId = workflowTasks.find(t => t.subject.includes("Commit"))?.id;
  if (commitTaskId && state.approved) updateTask(commitTaskId, { status: "in_progress" });

  // Update context metrics
  updateContextMetrics({ phase: "commit" });

  let commitResult: { committed: boolean; message?: string; sha?: string; prUrl?: string } = { committed: false };

  if (state.approved && config.commit?.enabled && changedFiles.length > 0) {
    console.log(`[feedback-loop] Starting COMMIT phase...`);

    // Build implementation result for commit phase
    const implementResultForCommit: ImplementResult = {
      phase: "implement",
      success: true,
      output: state.history.map(h => h.coderSummary).join("\n"),
      duration: 0,
      artifacts: {
        changedFiles: changedFiles.join("\n"),
        testsRun: state.history.flatMap(h => h.reviewResult?.checks?.filter(c => c.passed).map(c => c.command) ?? []).join("\n"),
        verificationStatus: "All checks passed",
      },
    };

    // Run the full commit phase (creates commit, optionally PR)
    const commitPhaseResult = await runCommitPhase(workflowContext, implementResultForCommit);

    if (commitPhaseResult.success) {
      terminal.log(`✓ Commit complete`);
      commitResult = {
        committed: true,
        message: commitPhaseResult.artifacts.commitMessage,
        sha: commitPhaseResult.artifacts.commitSha,
        prUrl: commitPhaseResult.artifacts.prUrl,
      };

      if (commitPhaseResult.artifacts.commitSha) {
        terminal.log(`  SHA: ${commitPhaseResult.artifacts.commitSha}`);
      }
      if (commitPhaseResult.artifacts.prUrl) {
        terminal.log(`  PR: ${commitPhaseResult.artifacts.prUrl}`);
      }
    } else {
      terminal.log(`⚠ Commit phase had issues: ${commitPhaseResult.output}`);
    }
  } else if (state.approved) {
    terminal.log(`Commit skipped (auto-commit disabled or no changed files)`);
  } else {
    terminal.log(`Commit skipped (not approved)`);
  }

  // Update commit task on completion
  if (commitTaskId) {
    updateTask(commitTaskId, { status: commitResult.committed ? "completed" : "pending" });
  }

  // ============================================
  // WORKFLOW COMPLETE - Summary
  // ============================================
  terminal.log("");
  terminal.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  terminal.log("  WORKFLOW COMPLETE");
  terminal.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  terminal.log(`  Explore: ${exploreResult?.success ? "✓" : "⚠"}`);
  terminal.log(`  Plan: ${planResult?.success ? "✓" : "⚠"}`);
  terminal.log(`  Implement: ${state.approved ? "✓" : "✗"} (${state.iteration} iterations)`);
  terminal.log(`  Commit: ${commitResult.committed ? "✓" : "−"}`);

  // Show context health summary
  const contextHealth = getContextHealthStatus();
  if (contextHealth.status !== "healthy") {
    terminal.log("");
    terminal.log(`  Context Health: ${contextHealth.status.toUpperCase()} (${Math.round(contextHealth.usagePercent)}%)`);
  }

  // Show task tracking summary
  const allTasks = listTasks();
  const completedTasks = allTasks.filter(t => t.status === "completed").length;
  terminal.log(`  Tasks: ${completedTasks}/${allTasks.length} completed`);
  terminal.log("");

  terminal.complete(state.iteration, state.approved);

  // Collect all screenshots from review history as proof of verification
  const allScreenshots = state.history
    .flatMap(h => h.reviewResult?.screenshots ?? [])
    .filter((s, i, arr) => arr.indexOf(s) === i);

  if (allScreenshots.length > 0) {
    terminal.log(`  Screenshots captured: ${allScreenshots.length}`);
  }

  return {
    approved: state.approved,
    iterations: state.iteration,
    history: state.history,
    changedFiles,
    screenshots: allScreenshots.length > 0 ? allScreenshots : undefined,
    checkpoint: finalCheckpoint,
    commit: commitResult,
    finalMessage: state.approved
      ? `Completed in ${state.iteration} iteration(s), all checks passing`
      : `Stopped after ${state.iteration} iteration(s), manual intervention needed`,
  };
}

type CoderResult = {
  summary: string;
  filesChanged?: string[];
  response?: string;
};

async function spawnCoder(
  api: OpenClawPluginApi,
  opts: {
    task: string;
    enhancedTask?: EnhancedTask; // Auto-structured task with verification criteria
    implementationPrompt?: string; // From PLAN phase - detailed implementation plan
    exploreContext?: { relevantFiles: string; codebaseContext: string; existingPatterns: string }; // From EXPLORE phase
    loadedContext?: LoadedContext; // Pre-loaded files, patterns, constraints from task
    previousFeedback?: string;
    userMessage?: string;
    planContext?: string;
    projectContext?: string;
    verificationCriteria?: VerificationCriteria;
    taskContext?: TaskContext;
    config: FeedbackLoopConfig;
    agentId: string;
    sessionKey: string;
    workspaceDir: string;
  },
): Promise<CoderResult> {
  const { task, enhancedTask, implementationPrompt, exploreContext, loadedContext, previousFeedback, userMessage, planContext, projectContext, verificationCriteria, taskContext, config, agentId, sessionKey, workspaceDir } = opts;

  // Build the coder prompt using best practices
  let basePrompt = `WORKSPACE: ${workspaceDir}\n\n`;

  // ============================================
  // LOADED CONTEXT - Files, patterns, constraints from task
  // ============================================
  // This is the rich context extracted from the task description:
  // - Referenced files (@file, "in src/auth/") are pre-loaded
  // - Example patterns ("like Widget.tsx") are included
  // - Constraints ("avoid mocks") are enforced
  if (loadedContext?.promptSection) {
    basePrompt += loadedContext.promptSection;
    basePrompt += "\n\n";
  }

  // If we have an implementation prompt from PLAN phase, use it as primary
  if (implementationPrompt) {
    basePrompt += implementationPrompt;
    basePrompt += "\n\n";

    // Add exploration context if available
    if (exploreContext?.codebaseContext) {
      basePrompt += `## CODEBASE CONTEXT (from exploration)\n${exploreContext.codebaseContext}\n\n`;
    }
    if (exploreContext?.existingPatterns) {
      basePrompt += `## EXISTING PATTERNS (follow these)\n${exploreContext.existingPatterns}\n\n`;
    }
  }
  // Otherwise, use enhanced task if available
  else if (enhancedTask) {
    basePrompt += buildEnhancedTaskPrompt(enhancedTask);
    basePrompt += "\n\n";
  }
  // Fallback to legacy prompt building
  else {
    const enhancedPrompt = buildEnhancedCoderPrompt(task, {
      verification: verificationCriteria,
      context: taskContext,
      projectInstructions: projectContext,
      previousFeedback,
    });
    basePrompt += enhancedPrompt;
  }

  // Add project context if available
  if (projectContext && !implementationPrompt) {
    basePrompt += `## PROJECT INSTRUCTIONS\n${projectContext}\n\n`;
  }

  // Add previous feedback if this is a retry
  if (previousFeedback) {
    basePrompt += `## PREVIOUS FEEDBACK (address these issues)\n${previousFeedback}\n\n`;
  }

  // Inject plan context (planning-with-files pattern: PreToolUse)
  if (planContext) {
    basePrompt += `\n\n${planContext}`;
  }

  if (userMessage) {
    basePrompt += `\n\nUSER SAYS: "${userMessage}"`;
  }

  // ============================================
  // WORKFLOW: Codex first → Antigravity fallback
  // ============================================
  const primaryModel = config.coder ?? "openai-codex/gpt-5.2";
  const isAntigravityPrimary = primaryModel.startsWith("google-antigravity/");
  const antigravityEnabled = config.antigravity?.enabled !== false; // Default: enabled

  // Determine Antigravity fallback model based on:
  // 1. Config override (antigravity.coderModel)
  // 2. Smart selection based on task complexity
  const taskComplexity = previousFeedback ? "complex" : "medium"; // Retries are harder
  const antigravityFallback = config.antigravity?.coderModel
    ? (config.antigravity.coderModel as AntigravityModel)
    : selectAntigravityModel("coder", {
        taskComplexity,
        preferSpeed: !previousFeedback, // Speed on first try, thoroughness on retries
        preferThinking: config.antigravity?.useThinking,
      });

  // Try primary model (Codex) first
  const primaryResult = await runCoderWithModel(
    primaryModel,
    basePrompt,
    isAntigravityPrimary ? buildAntigravityPromptAdditions("coder", primaryModel as AntigravityModel) : undefined,
    { agentId, sessionKey, workspaceDir },
  );

  // If primary succeeded, return it
  if (!primaryResult.error || isAntigravityPrimary) {
    return primaryResult;
  }

  // Check if Antigravity fallback is enabled
  if (!antigravityEnabled) {
    console.log(`[feedback-loop] Codex failed (${primaryResult.error}), Antigravity fallback disabled`);
    return primaryResult;
  }

  // Primary (Codex) failed - try Antigravity fallback
  console.log(`[feedback-loop] Codex failed (${primaryResult.error}), falling back to Antigravity: ${antigravityFallback}`);

  // Handle the Codex error to determine if fallback is appropriate
  const errorHandling = handleAntigravityError(primaryResult.error);
  if (!errorHandling.retryable && primaryResult.error.includes("antigravity")) {
    // Antigravity-specific error, don't retry with Antigravity
    return primaryResult;
  }

  // Add Antigravity-specific prompt additions
  const antigravityPrompt = basePrompt + "\n\n" + buildAntigravityPromptAdditions("coder", antigravityFallback);

  const fallbackResult = await runCoderWithModel(
    antigravityFallback,
    antigravityPrompt,
    undefined, // Already added to prompt
    { agentId, sessionKey, workspaceDir },
  );

  if (fallbackResult.error) {
    // Handle Antigravity-specific errors
    const antigravityError = handleAntigravityError(fallbackResult.error);
    return {
      summary: `Both Codex and Antigravity failed. ${antigravityError.message}${antigravityError.suggestion ? ` (${antigravityError.suggestion})` : ""}`,
      error: fallbackResult.error,
    };
  }

  return {
    ...fallbackResult,
    summary: `[Antigravity] ${fallbackResult.summary}`, // Mark that fallback was used
  };
}

/**
 * Run the coder with a specific model
 */
async function runCoderWithModel(
  model: string,
  prompt: string,
  extraPromptAdditions: string | undefined,
  opts: { agentId: string; sessionKey: string; workspaceDir: string },
): Promise<CoderResult & { error?: string }> {
  const { agentId, sessionKey } = opts;
  const childSessionKey = `agent:${agentId}:coder:${crypto.randomUUID()}`;
  const stepIdem = crypto.randomUUID();

  const fullPrompt = extraPromptAdditions ? `${prompt}\n\n${extraPromptAdditions}` : prompt;

  try {
    // Step 1: Set the model for this session
    await callGateway({
      method: "sessions.patch",
      params: { key: childSessionKey, model },
      timeoutMs: 10_000,
    });

    // Step 2: SPAWN the coder agent (returns immediately with runId)
    const spawnResponse = await callGateway({
      method: "agent",
      params: {
        message: fullPrompt,
        sessionKey: childSessionKey,
        idempotencyKey: stepIdem,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: `You are the CODER in a feedback loop. Your job is to write/fix code.
IMPORTANT: Work in the WORKSPACE directory specified above.
After you make changes, summarize what you did in 1-2 sentences.
Do NOT run tests yourself - the REVIEWER will handle verification.
Focus on implementing the requested changes correctly.`,
        spawnedBy: sessionKey,
        label: "feedback-loop-coder",
      },
      timeoutMs: 10_000, // Just for the spawn, not the full run
    }) as { runId?: string };

    const runId = spawnResponse?.runId || stepIdem;

    // Step 3: WAIT for the coder to complete
    const waitTimeoutMs = 600_000; // 10 minutes max for coding
    const waitResponse = await callGateway({
      method: "agent.wait",
      params: { runId, timeoutMs: waitTimeoutMs },
      timeoutMs: waitTimeoutMs + 5_000, // Gateway timeout slightly longer
    }) as { status?: string; error?: string };

    if (waitResponse?.status !== "ok") {
      return {
        summary: `Coder ${waitResponse?.status ?? "failed"}: ${waitResponse?.error ?? "unknown error"}`,
        error: waitResponse?.error ?? "unknown error",
      };
    }

    // Step 4: READ the actual response from chat history
    const response = await readLatestAssistantReply({ sessionKey: childSessionKey });

    return {
      summary: response?.slice(0, 500) ?? "Completed coding task (no response)",
      response: response,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      summary: `Coder error: ${error}`,
      error,
    };
  }
}

async function runReview(
  opts: {
    coderResult: CoderResult;
    config: FeedbackLoopConfig;
    workspaceDir: string;
    terminal: TerminalStreamer;
  },
): Promise<ReviewResult> {
  const { config, workspaceDir, terminal } = opts;
  const checks: CheckResult[] = [];
  let browserErrors: string[] = [];

  // Run terminal commands
  if (config.commands?.length) {
    const cmdResults = await runVerificationCommands(config.commands, workspaceDir, terminal);
    checks.push(
      ...cmdResults.map((result) => ({
        ...result,
        name: result.command,
        evidence: result.output ?? result.error,
      })),
    );
  }

  // Run browser checks
  if (config.browser?.enabled) {
    const browserResult = await runBrowserChecks(config.browser, terminal);
    if (browserResult.errors.length) {
      browserErrors = browserResult.errors;
      checks.push({
        command: "browser-check",
        name: "browser-check",
        passed: false,
        evidence: browserResult.errors.join("; "),
        error: browserResult.errors.join("; "),
      });
    } else {
      checks.push({
        command: "browser-check",
        name: "browser-check",
        passed: true,
        evidence: "Browser verification passed",
      });
    }
  }

  // Check if all passed
  const allPassed = checks.every((c) => c.passed);

  if (allPassed) {
    return {
      approved: true,
      checks,
    };
  }

  // Build feedback from failed checks
  const failedChecks = checks.filter((c) => !c.passed);
  const feedback = formatFailedChecks(failedChecks);

  return {
    approved: false,
    checks,
    feedback: `Fix these issues:\n${feedback}`,
    browserErrors: browserErrors.length ? browserErrors : undefined,
  };
}

/**
 * Auto-extract URLs to verify from task and coder summary.
 * This ensures browser verification happens even without explicit config.
 */
function extractUrlsFromTask(task: string, coderSummary: string): string[] {
  const urls: string[] = [];
  const combined = `${task}\n${coderSummary}`;

  // Extract explicit URLs (localhost or other)
  const urlMatches = combined.match(/https?:\/\/localhost[^\s<>"')]+/gi) || [];
  for (const url of urlMatches) {
    if (!urls.includes(url)) {
      urls.push(url);
    }
  }

  // Extract localhost paths mentioned
  const pathMatches = combined.match(/localhost:\d+\/[^\s<>"')]+/gi) || [];
  for (const path of pathMatches) {
    const url = `http://${path}`;
    if (!urls.includes(url)) {
      urls.push(url);
    }
  }

  // Detect route paths (e.g., "/test-scratchpad", "/api/health")
  const routeMatches = combined.match(/(?:at |page |route |endpoint )[`"']?\/([a-zA-Z0-9_\-/]+)/gi) || [];
  for (const match of routeMatches) {
    const routeMatch = match.match(/\/([a-zA-Z0-9_\-/]+)/);
    if (routeMatch) {
      const route = `/${routeMatch[1]}`;
      const url = `http://localhost:3000${route}`;
      if (!urls.includes(url)) {
        urls.push(url);
      }
    }
  }

  // Detect test pages from file paths
  const testPageMatches = combined.match(/pages\/([a-zA-Z0-9_\-]+)\.(tsx|jsx|ts|js)/gi) || [];
  for (const match of testPageMatches) {
    const pageMatch = match.match(/pages\/([a-zA-Z0-9_\-]+)/);
    if (pageMatch) {
      const pageName = pageMatch[1];
      const url = `http://localhost:3000/${pageName}`;
      if (!urls.includes(url)) {
        urls.push(url);
      }
    }
  }

  // Detect component test paths (e.g., ScratchpadTeacher -> /test-scratchpad)
  const componentMatches = combined.match(/([A-Z][a-zA-Z]+)(?:\.tsx|Component|Page)/g) || [];
  for (const match of componentMatches) {
    const componentName = match.replace(/\.tsx|Component|Page/g, "");
    // Convert PascalCase to kebab-case
    const route = componentName.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    if (route.length > 3 && !["react", "index", "layout", "error"].includes(route)) {
      const url = `http://localhost:3000/test-${route}`;
      if (!urls.includes(url)) {
        urls.push(url);
      }
    }
  }

  // Always verify frontend if mentioned
  if (/frontend|react|component|page|ui/i.test(combined) && !urls.some(u => u.includes("localhost:3000"))) {
    urls.push("http://localhost:3000");
  }

  // Always verify backend API if mentioned
  if (/backend|api|endpoint|server/i.test(combined)) {
    urls.push("http://localhost:8000/health");
  }

  return urls;
}
