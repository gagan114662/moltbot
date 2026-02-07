/**
 * Workflow Phases - Explore → Plan → Implement → Commit
 *
 * This is the DEFAULT workflow for all coding tasks.
 * Based on Claude Code best practices for effective agentic coding.
 */

import type { FeedbackLoopConfig } from "openclaw/plugin-sdk";
import crypto from "node:crypto";
import { callGateway, AGENT_LANE_SUBAGENT, readLatestAssistantReply } from "openclaw/plugin-sdk";
import type { EnhancedTask } from "./task-enhancer.js";

// ============================================
// PHASE TYPES
// ============================================

export type WorkflowPhase = "explore" | "plan" | "implement" | "commit";

export interface PhaseResult {
  phase: WorkflowPhase;
  success: boolean;
  output: string;
  duration: number;
  artifacts?: Record<string, string>;
}

export interface ExploreResult extends PhaseResult {
  phase: "explore";
  artifacts: {
    relevantFiles: string;
    codebaseContext: string;
    existingPatterns: string;
  };
}

export interface PlanResult extends PhaseResult {
  phase: "plan";
  artifacts: {
    implementationPlan: string;
    filesToModify: string;
    testStrategy: string;
    risks: string;
  };
}

export interface ImplementResult extends PhaseResult {
  phase: "implement";
  artifacts: {
    changedFiles: string;
    testsRun: string;
    verificationStatus: string;
  };
}

export interface CommitResult extends PhaseResult {
  phase: "commit";
  artifacts: {
    commitMessage: string;
    commitSha?: string;
    prUrl?: string;
  };
}

export interface WorkflowContext {
  task: string;
  enhancedTask?: EnhancedTask;
  config: FeedbackLoopConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
  projectContext?: string;
}

// ============================================
// PHASE 1: EXPLORE
// ============================================

const EXPLORE_SYSTEM_PROMPT = `You are in EXPLORE mode. Your job is to understand the codebase before making any changes.

## RULES
1. READ files to understand existing patterns
2. IDENTIFY relevant files for the task
3. NOTE existing conventions (naming, structure, patterns)
4. DO NOT make any changes yet
5. Return a structured summary

## OUTPUT FORMAT
Return a JSON object:
\`\`\`json
{
  "relevantFiles": ["list of files related to this task"],
  "codebaseContext": "Summary of how this area of the codebase works",
  "existingPatterns": "Patterns to follow (naming, structure, etc.)",
  "dependencies": "Key dependencies and how they're used",
  "potentialIssues": "Things to watch out for"
}
\`\`\``;

export async function runExplorePhase(ctx: WorkflowContext): Promise<ExploreResult> {
  const startTime = Date.now();
  console.log(`[workflow] Starting EXPLORE phase...`);

  const prompt = buildExplorePrompt(ctx);
  const model = ctx.config.reviewer ?? "anthropic/claude-sonnet-4-5"; // Use reviewer model for exploration
  const childSessionKey = `agent:${ctx.agentId}:explore:${crypto.randomUUID()}`;

  try {
    await callGateway({
      method: "sessions.patch",
      params: { key: childSessionKey, model },
      timeoutMs: 10_000,
    });

    const spawnResponse = (await callGateway({
      method: "agent",
      params: {
        message: prompt,
        sessionKey: childSessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: EXPLORE_SYSTEM_PROMPT,
        spawnedBy: ctx.sessionKey,
        label: "workflow-explore",
      },
      timeoutMs: 10_000,
    })) as { runId?: string };

    const runId = spawnResponse?.runId || crypto.randomUUID();

    const waitResponse = (await callGateway({
      method: "agent.wait",
      params: { runId, timeoutMs: 180_000 }, // 3 minutes for exploration
      timeoutMs: 185_000,
    })) as { status?: string; error?: string };

    if (waitResponse?.status !== "ok") {
      throw new Error(`Explore failed: ${waitResponse?.error ?? "timeout"}`);
    }

    const response = await readLatestAssistantReply({ sessionKey: childSessionKey });
    const artifacts = parseExploreResponse(response);

    return {
      phase: "explore",
      success: true,
      output: response ?? "Exploration complete",
      duration: Date.now() - startTime,
      artifacts,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`[workflow] EXPLORE failed: ${error}`);
    return {
      phase: "explore",
      success: false,
      output: `Exploration failed: ${error}`,
      duration: Date.now() - startTime,
      artifacts: {
        relevantFiles: "",
        codebaseContext: "",
        existingPatterns: "",
      },
    };
  }
}

function buildExplorePrompt(ctx: WorkflowContext): string {
  let prompt = `## TASK TO EXPLORE

${ctx.enhancedTask?.structured ?? ctx.task}

**Workspace:** ${ctx.workspaceDir}

## YOUR MISSION

1. Find and read files related to this task
2. Understand existing patterns and conventions
3. Identify what needs to change
4. Note any dependencies or risks

`;

  if (ctx.enhancedTask?.targetFiles.length) {
    prompt += `## SUGGESTED FILES TO CHECK
${ctx.enhancedTask.targetFiles.map((f) => `- ${f}`).join("\n")}

`;
  }

  if (ctx.projectContext) {
    prompt += `## PROJECT CONTEXT
${ctx.projectContext.slice(0, 2000)}

`;
  }

  prompt += `Return your findings as a JSON object.`;

  return prompt;
}

function parseExploreResponse(response: string | undefined): ExploreResult["artifacts"] {
  const defaults = {
    relevantFiles: "",
    codebaseContext: "",
    existingPatterns: "",
  };

  if (!response) {
    return defaults;
  }

  try {
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const json = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      return {
        relevantFiles: Array.isArray(json.relevantFiles)
          ? json.relevantFiles.join("\n")
          : json.relevantFiles || "",
        codebaseContext: json.codebaseContext || json.context || "",
        existingPatterns: json.existingPatterns || json.patterns || "",
      };
    }
  } catch {
    // Fall through
  }

  return { ...defaults, codebaseContext: response.slice(0, 1000) };
}

// ============================================
// PHASE 2: PLAN
// ============================================

const PLAN_SYSTEM_PROMPT = `You are in PLAN mode. Create a detailed implementation plan based on exploration findings.

## RULES
1. Create step-by-step implementation plan
2. List specific files to create/modify
3. Define test strategy
4. Identify risks and mitigations
5. DO NOT implement yet - just plan

## OUTPUT FORMAT
Return a JSON object:
\`\`\`json
{
  "summary": "One-line summary of the approach",
  "steps": [
    {"step": 1, "description": "What to do first", "files": ["file1.ts"]},
    {"step": 2, "description": "What to do next", "files": ["file2.ts"]}
  ],
  "filesToCreate": ["new-file.ts"],
  "filesToModify": ["existing-file.ts"],
  "testStrategy": "How to test this change",
  "risks": ["Risk 1", "Risk 2"],
  "estimatedComplexity": "simple|medium|complex"
}
\`\`\``;

export async function runPlanPhase(
  ctx: WorkflowContext,
  exploreResult: ExploreResult,
): Promise<PlanResult> {
  const startTime = Date.now();
  console.log(`[workflow] Starting PLAN phase...`);

  const prompt = buildPlanPrompt(ctx, exploreResult);
  const model = ctx.config.reviewer ?? "anthropic/claude-sonnet-4-5";
  const childSessionKey = `agent:${ctx.agentId}:plan:${crypto.randomUUID()}`;

  try {
    await callGateway({
      method: "sessions.patch",
      params: { key: childSessionKey, model },
      timeoutMs: 10_000,
    });

    const spawnResponse = (await callGateway({
      method: "agent",
      params: {
        message: prompt,
        sessionKey: childSessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: PLAN_SYSTEM_PROMPT,
        spawnedBy: ctx.sessionKey,
        label: "workflow-plan",
      },
      timeoutMs: 10_000,
    })) as { runId?: string };

    const runId = spawnResponse?.runId || crypto.randomUUID();

    const waitResponse = (await callGateway({
      method: "agent.wait",
      params: { runId, timeoutMs: 180_000 },
      timeoutMs: 185_000,
    })) as { status?: string; error?: string };

    if (waitResponse?.status !== "ok") {
      throw new Error(`Plan failed: ${waitResponse?.error ?? "timeout"}`);
    }

    const response = await readLatestAssistantReply({ sessionKey: childSessionKey });
    const artifacts = parsePlanResponse(response);

    return {
      phase: "plan",
      success: true,
      output: response ?? "Plan created",
      duration: Date.now() - startTime,
      artifacts,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`[workflow] PLAN failed: ${error}`);
    return {
      phase: "plan",
      success: false,
      output: `Planning failed: ${error}`,
      duration: Date.now() - startTime,
      artifacts: {
        implementationPlan: "",
        filesToModify: "",
        testStrategy: "",
        risks: "",
      },
    };
  }
}

function buildPlanPrompt(ctx: WorkflowContext, exploreResult: ExploreResult): string {
  let prompt = `## TASK

${ctx.enhancedTask?.structured ?? ctx.task}

## EXPLORATION FINDINGS

**Relevant Files:**
${exploreResult.artifacts.relevantFiles || "No specific files identified"}

**Codebase Context:**
${exploreResult.artifacts.codebaseContext || "No context gathered"}

**Existing Patterns:**
${exploreResult.artifacts.existingPatterns || "No patterns identified"}

`;

  if (ctx.enhancedTask) {
    prompt += `## VERIFICATION CRITERIA
${ctx.enhancedTask.verification.successCriteria.map((c) => `- ${c}`).join("\n")}

## EDGE CASES TO HANDLE
${ctx.enhancedTask.verification.edgeCases.map((e) => `- ${e}`).join("\n")}

`;
  }

  prompt += `## YOUR MISSION

Create a detailed implementation plan. Think through:
1. What changes are needed?
2. What order should they be made?
3. How will we test this?
4. What could go wrong?

Return your plan as a JSON object.`;

  return prompt;
}

function parsePlanResponse(response: string | undefined): PlanResult["artifacts"] {
  const defaults = {
    implementationPlan: "",
    filesToModify: "",
    testStrategy: "",
    risks: "",
  };

  if (!response) {
    return defaults;
  }

  try {
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const json = JSON.parse(jsonMatch[1] || jsonMatch[0]);

      const steps = json.steps || [];
      const planText = steps
        .map(
          (s: { step: number; description: string; files?: string[] }) =>
            `${s.step}. ${s.description}${s.files ? ` (${s.files.join(", ")})` : ""}`,
        )
        .join("\n");

      return {
        implementationPlan: json.summary ? `${json.summary}\n\n${planText}` : planText,
        filesToModify: [...(json.filesToCreate || []), ...(json.filesToModify || [])].join("\n"),
        testStrategy: json.testStrategy || "",
        risks: Array.isArray(json.risks) ? json.risks.join("\n") : json.risks || "",
      };
    }
  } catch {
    // Fall through
  }

  return { ...defaults, implementationPlan: response.slice(0, 2000) };
}

// ============================================
// PHASE 3: IMPLEMENT (uses existing coder/reviewer loop)
// ============================================

// Implementation is handled by the existing feedback loop (coder → reviewer)
// This function just builds the implementation prompt with plan context

export function buildImplementPrompt(ctx: WorkflowContext, planResult: PlanResult): string {
  let prompt = `## IMPLEMENTATION TASK

${ctx.enhancedTask?.structured ?? ctx.task}

## IMPLEMENTATION PLAN (follow this exactly)

${planResult.artifacts.implementationPlan}

## FILES TO MODIFY

${planResult.artifacts.filesToModify || "Determined by plan"}

## TEST STRATEGY

${planResult.artifacts.testStrategy || "Run existing tests and add new ones as needed"}

## RISKS TO WATCH FOR

${planResult.artifacts.risks || "None identified"}

`;

  if (ctx.enhancedTask) {
    prompt += `## VERIFICATION COMMANDS (run these after implementation)

${ctx.enhancedTask.verification.commands.map((c) => `- \`${c.command}\` - ${c.description}`).join("\n")}

## SUCCESS CRITERIA (all must pass)

${ctx.enhancedTask.verification.successCriteria.map((c) => `- [ ] ${c}`).join("\n")}

`;
  }

  prompt += `## INSTRUCTIONS

1. Follow the implementation plan step by step
2. Run verification commands after each major change
3. Fix any failing tests before moving on
4. Do NOT skip any steps or take shortcuts
5. When done, summarize what you changed`;

  return prompt;
}

// ============================================
// PHASE 4: COMMIT
// ============================================

const COMMIT_SYSTEM_PROMPT = `You are in COMMIT mode. Create a commit and optionally a PR.

## RULES
1. Stage only the files that were changed for this task
2. Write a clear, descriptive commit message
3. Create a PR if configured
4. Do NOT commit unrelated changes

## COMMIT MESSAGE FORMAT
Use conventional commits:
- feat: for new features
- fix: for bug fixes
- refactor: for refactoring
- test: for test changes
- docs: for documentation

Example:
feat(auth): add Google OAuth login flow

- Add OAuth callback handler
- Store session in Redis
- Add tests for token refresh`;

export async function runCommitPhase(
  ctx: WorkflowContext,
  implementResult: ImplementResult,
): Promise<CommitResult> {
  const startTime = Date.now();
  console.log(`[workflow] Starting COMMIT phase...`);

  // Check if auto-commit is enabled
  if (!ctx.config.commit?.enabled) {
    console.log(`[workflow] Auto-commit disabled, skipping commit phase`);
    return {
      phase: "commit",
      success: true,
      output: "Commit skipped (auto-commit disabled)",
      duration: Date.now() - startTime,
      artifacts: {
        commitMessage: "",
      },
    };
  }

  const prompt = buildCommitPrompt(ctx, implementResult);
  const model = ctx.config.reviewer ?? "anthropic/claude-sonnet-4-5";
  const childSessionKey = `agent:${ctx.agentId}:commit:${crypto.randomUUID()}`;

  try {
    await callGateway({
      method: "sessions.patch",
      params: { key: childSessionKey, model },
      timeoutMs: 10_000,
    });

    const spawnResponse = (await callGateway({
      method: "agent",
      params: {
        message: prompt,
        sessionKey: childSessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: COMMIT_SYSTEM_PROMPT,
        spawnedBy: ctx.sessionKey,
        label: "workflow-commit",
      },
      timeoutMs: 10_000,
    })) as { runId?: string };

    const runId = spawnResponse?.runId || crypto.randomUUID();

    const waitResponse = (await callGateway({
      method: "agent.wait",
      params: { runId, timeoutMs: 120_000 },
      timeoutMs: 125_000,
    })) as { status?: string; error?: string };

    if (waitResponse?.status !== "ok") {
      throw new Error(`Commit failed: ${waitResponse?.error ?? "timeout"}`);
    }

    const response = await readLatestAssistantReply({ sessionKey: childSessionKey });
    const artifacts = parseCommitResponse(response);

    return {
      phase: "commit",
      success: true,
      output: response ?? "Committed successfully",
      duration: Date.now() - startTime,
      artifacts,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`[workflow] COMMIT failed: ${error}`);
    return {
      phase: "commit",
      success: false,
      output: `Commit failed: ${error}`,
      duration: Date.now() - startTime,
      artifacts: {
        commitMessage: "",
      },
    };
  }
}

function buildCommitPrompt(ctx: WorkflowContext, implementResult: ImplementResult): string {
  const commitConfig = ctx.config.commit;

  let prompt = `## TASK COMPLETED

${ctx.task}

## CHANGED FILES

${implementResult.artifacts.changedFiles || "Check git status"}

## VERIFICATION STATUS

${implementResult.artifacts.verificationStatus || "All checks passed"}

## YOUR MISSION

1. Run \`git status\` to see changes
2. Run \`git diff\` to review changes
3. Stage the relevant files (not unrelated changes)
4. Create a commit with a descriptive message

`;

  if (commitConfig?.messageStyle === "conventional") {
    prompt += `Use conventional commit format (feat:, fix:, etc.)\n\n`;
  }

  if (commitConfig?.createPR) {
    prompt += `After committing, create a PR with:
- Clear title summarizing the change
- Description of what was done
- Test instructions

`;
  }

  if (commitConfig?.autoPush) {
    prompt += `Push the commit to the remote branch.\n\n`;
  }

  return prompt;
}

function parseCommitResponse(response: string | undefined): CommitResult["artifacts"] {
  const artifacts: CommitResult["artifacts"] = {
    commitMessage: "",
  };

  if (!response) {
    return artifacts;
  }

  // Try to extract commit SHA
  const shaMatch = response.match(/\b([a-f0-9]{7,40})\b/);
  if (shaMatch) {
    artifacts.commitSha = shaMatch[1];
  }

  // Try to extract PR URL
  const prMatch = response.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (prMatch) {
    artifacts.prUrl = prMatch[0];
  }

  // Extract commit message
  const msgMatch = response.match(
    /(?:commit message|committed|git commit -m)[:\s]*["']?([^"'\n]+)/i,
  );
  if (msgMatch) {
    artifacts.commitMessage = msgMatch[1].trim();
  }

  return artifacts;
}

// ============================================
// FULL WORKFLOW RUNNER
// ============================================

export interface WorkflowResult {
  success: boolean;
  phases: {
    explore?: ExploreResult;
    plan?: PlanResult;
    implement?: ImplementResult;
    commit?: CommitResult;
  };
  totalDuration: number;
  summary: string;
}

/**
 * Run the full Explore → Plan → Implement → Commit workflow
 */
export async function runFullWorkflow(
  ctx: WorkflowContext,
  callbacks: {
    onPhaseStart?: (phase: WorkflowPhase) => void;
    onPhaseEnd?: (result: PhaseResult) => void;
    runImplementPhase: (implementPrompt: string) => Promise<ImplementResult>;
  },
): Promise<WorkflowResult> {
  const startTime = Date.now();
  const result: WorkflowResult = {
    success: false,
    phases: {},
    totalDuration: 0,
    summary: "",
  };

  try {
    // Phase 1: Explore
    callbacks.onPhaseStart?.("explore");
    const exploreResult = await runExplorePhase(ctx);
    result.phases.explore = exploreResult;
    callbacks.onPhaseEnd?.(exploreResult);

    if (!exploreResult.success) {
      result.summary = "Failed during exploration phase";
      result.totalDuration = Date.now() - startTime;
      return result;
    }

    // Phase 2: Plan
    callbacks.onPhaseStart?.("plan");
    const planResult = await runPlanPhase(ctx, exploreResult);
    result.phases.plan = planResult;
    callbacks.onPhaseEnd?.(planResult);

    if (!planResult.success) {
      result.summary = "Failed during planning phase";
      result.totalDuration = Date.now() - startTime;
      return result;
    }

    // Phase 3: Implement (via callback - uses existing coder/reviewer loop)
    callbacks.onPhaseStart?.("implement");
    const implementPrompt = buildImplementPrompt(ctx, planResult);
    const implementResult = await callbacks.runImplementPhase(implementPrompt);
    result.phases.implement = implementResult;
    callbacks.onPhaseEnd?.(implementResult);

    if (!implementResult.success) {
      result.summary = "Failed during implementation phase";
      result.totalDuration = Date.now() - startTime;
      return result;
    }

    // Phase 4: Commit
    callbacks.onPhaseStart?.("commit");
    const commitResult = await runCommitPhase(ctx, implementResult);
    result.phases.commit = commitResult;
    callbacks.onPhaseEnd?.(commitResult);

    result.success = commitResult.success;
    result.summary = commitResult.success
      ? `Completed: ${commitResult.artifacts.commitMessage || "Changes committed"}`
      : "Failed during commit phase";
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    result.summary = `Workflow error: ${error}`;
  }

  result.totalDuration = Date.now() - startTime;
  return result;
}
