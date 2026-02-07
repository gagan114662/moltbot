import fs from "node:fs/promises";
import path from "node:path";

/**
 * Planning-with-files pattern: 3 persistent markdown files that maintain
 * context across the feedback loop iterations.
 *
 * - task_plan.md: Phases, progress tracking, decisions, errors
 * - findings.md: Research, discoveries, requirements
 * - progress.md: Session log, test results, iteration history
 */

export type PlanningFiles = {
  taskPlanPath: string;
  findingsPath: string;
  progressPath: string;
};

export type TaskPlan = {
  task: string;
  phases: Phase[];
  currentPhase: number;
  decisions: Decision[];
  errors: ErrorEntry[];
  acceptanceCriteria?: string[];
};

export type Phase = {
  id: number;
  name: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  steps: string[];
  completedSteps: string[];
};

export type Decision = {
  timestamp: string;
  context: string;
  decision: string;
  reasoning: string;
};

export type ErrorEntry = {
  timestamp: string;
  action: string;
  error: string;
  attempts: number;
  resolution?: string;
};

export type Findings = {
  research: Finding[];
  requirements: string[];
  discoveries: string[];
  lastUpdated: string;
};

export type Finding = {
  timestamp: string;
  source: string;
  content: string;
  tags: string[];
};

export type Progress = {
  sessionStart: string;
  iterations: IterationLog[];
  testResults: TestResult[];
  lastAction: string;
  totalActions: number;
  actionsSinceLastSave: number;
};

export type IterationLog = {
  iteration: number;
  startTime: string;
  endTime?: string;
  coderSummary?: string;
  reviewerVerdict?: "approved" | "rejected";
  feedback?: string;
  filesChanged?: string[];
};

export type TestResult = {
  timestamp: string;
  command: string;
  passed: boolean;
  output?: string;
};

/**
 * Initialize planning files for a new feedback loop task.
 * Creates the 3 markdown files in the workspace's .feedback-loop directory.
 */
export async function initializePlanningFiles(opts: {
  workspaceDir: string;
  task: string;
  acceptanceCriteria?: string[];
  sessionId: string;
}): Promise<PlanningFiles> {
  const { workspaceDir, task, acceptanceCriteria, sessionId } = opts;

  // Create .feedback-loop directory in workspace
  const planDir = path.join(workspaceDir, ".feedback-loop", sessionId);
  await fs.mkdir(planDir, { recursive: true });

  const paths: PlanningFiles = {
    taskPlanPath: path.join(planDir, "task_plan.md"),
    findingsPath: path.join(planDir, "findings.md"),
    progressPath: path.join(planDir, "progress.md"),
  };

  // Initialize task_plan.md
  const taskPlan: TaskPlan = {
    task,
    phases: [
      {
        id: 1,
        name: "Implementation",
        status: "pending",
        steps: ["Analyze requirements", "Write code", "Test locally"],
        completedSteps: [],
      },
      {
        id: 2,
        name: "Verification",
        status: "pending",
        steps: ["Run tests", "Check browser", "Verify acceptance criteria"],
        completedSteps: [],
      },
      {
        id: 3,
        name: "Refinement",
        status: "pending",
        steps: ["Address feedback", "Fix issues", "Re-verify"],
        completedSteps: [],
      },
    ],
    currentPhase: 1,
    decisions: [],
    errors: [],
    acceptanceCriteria,
  };
  await writeTaskPlan(paths.taskPlanPath, taskPlan);

  // Initialize findings.md
  const findings: Findings = {
    research: [],
    requirements: acceptanceCriteria ?? [],
    discoveries: [],
    lastUpdated: new Date().toISOString(),
  };
  await writeFindings(paths.findingsPath, findings);

  // Initialize progress.md
  const progress: Progress = {
    sessionStart: new Date().toISOString(),
    iterations: [],
    testResults: [],
    lastAction: "Initialized planning files",
    totalActions: 0,
    actionsSinceLastSave: 0,
  };
  await writeProgress(paths.progressPath, progress);

  console.log(`[planning-files] Initialized at ${planDir}`);
  return paths;
}

/**
 * Read task plan before each action (PreToolUse pattern).
 */
export async function readTaskPlan(planPath: string): Promise<TaskPlan | null> {
  try {
    const content = await fs.readFile(planPath, "utf-8");
    return parseTaskPlanMarkdown(content);
  } catch {
    return null;
  }
}

/**
 * Read findings file.
 */
export async function readFindings(findingsPath: string): Promise<Findings | null> {
  try {
    const content = await fs.readFile(findingsPath, "utf-8");
    return parseFindingsMarkdown(content);
  } catch {
    return null;
  }
}

/**
 * Read progress file.
 */
export async function readProgress(progressPath: string): Promise<Progress | null> {
  try {
    const content = await fs.readFile(progressPath, "utf-8");
    return parseProgressMarkdown(content);
  } catch {
    return null;
  }
}

/**
 * Update task plan with new information.
 */
export async function updateTaskPlan(
  planPath: string,
  update: Partial<TaskPlan> & { addDecision?: Decision; addError?: ErrorEntry },
): Promise<void> {
  const current = (await readTaskPlan(planPath)) ?? createEmptyTaskPlan();

  if (update.currentPhase !== undefined) {
    current.currentPhase = update.currentPhase;
  }
  if (update.phases) {
    current.phases = update.phases;
  }
  if (update.addDecision) {
    current.decisions.push(update.addDecision);
  }
  if (update.addError) {
    // 3-Strike tracking: increment attempts for same action
    const existing = current.errors.find(
      (e) => e.action === update.addError!.action && !e.resolution,
    );
    if (existing) {
      existing.attempts++;
      existing.error = update.addError.error;
      existing.timestamp = update.addError.timestamp;
    } else {
      current.errors.push(update.addError);
    }
  }

  await writeTaskPlan(planPath, current);
}

/**
 * Update findings with new discovery.
 */
export async function updateFindings(
  findingsPath: string,
  update: { addFinding?: Finding; addDiscovery?: string; addRequirement?: string },
): Promise<void> {
  const current = (await readFindings(findingsPath)) ?? createEmptyFindings();

  if (update.addFinding) {
    current.research.push(update.addFinding);
  }
  if (update.addDiscovery) {
    current.discoveries.push(update.addDiscovery);
  }
  if (update.addRequirement) {
    current.requirements.push(update.addRequirement);
  }
  current.lastUpdated = new Date().toISOString();

  await writeFindings(findingsPath, current);
}

/**
 * Update progress after each action (PostToolUse pattern).
 */
export async function updateProgress(
  progressPath: string,
  update: {
    lastAction: string;
    incrementActions?: boolean;
    addIteration?: IterationLog;
    updateIteration?: Partial<IterationLog> & { iteration: number };
    addTestResult?: TestResult;
    resetActionsSinceLastSave?: boolean;
  },
): Promise<void> {
  const current = (await readProgress(progressPath)) ?? createEmptyProgress();

  current.lastAction = update.lastAction;

  if (update.incrementActions) {
    current.totalActions++;
    current.actionsSinceLastSave++;
  }

  if (update.addIteration) {
    current.iterations.push(update.addIteration);
  }

  if (update.updateIteration) {
    const iter = current.iterations.find((i) => i.iteration === update.updateIteration!.iteration);
    if (iter) {
      Object.assign(iter, update.updateIteration);
    }
  }

  if (update.addTestResult) {
    current.testResults.push(update.addTestResult);
  }

  if (update.resetActionsSinceLastSave) {
    current.actionsSinceLastSave = 0;
  }

  await writeProgress(progressPath, current);
}

/**
 * Check if we've hit the 3-strike limit for an action.
 */
export function checkThreeStrikes(plan: TaskPlan | null, action: string): boolean {
  if (!plan) {
    return false;
  }
  const error = plan.errors.find((e) => e.action === action && !e.resolution);
  return error !== undefined && error.attempts >= 3;
}

/**
 * Get unresolved errors with 3+ attempts (for escalation).
 */
export function getEscalationNeeded(plan: TaskPlan | null): ErrorEntry[] {
  if (!plan) {
    return [];
  }
  return plan.errors.filter((e) => e.attempts >= 3 && !e.resolution);
}

/**
 * Build context string to inject before coder/reviewer prompt.
 * This is the PreToolUse pattern: read plan before every action.
 */
export async function buildPlanContext(paths: PlanningFiles): Promise<string> {
  const plan = await readTaskPlan(paths.taskPlanPath);
  const progress = await readProgress(paths.progressPath);

  if (!plan || !progress) {
    return "";
  }

  const currentPhase = plan.phases.find((p) => p.id === plan.currentPhase);
  const recentIterations = progress.iterations.slice(-3);

  let context = `## PLANNING CONTEXT

**Task:** ${plan.task}

**Current Phase:** ${currentPhase?.name ?? "Unknown"} (${currentPhase?.status ?? "pending"})
**Iterations Completed:** ${progress.iterations.length}
**Last Action:** ${progress.lastAction}

`;

  // Add acceptance criteria
  if (plan.acceptanceCriteria && plan.acceptanceCriteria.length > 0) {
    context += `**Acceptance Criteria:**
${plan.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}

`;
  }

  // Add recent decisions
  if (plan.decisions.length > 0) {
    const recentDecisions = plan.decisions.slice(-3);
    context += `**Recent Decisions:**
${recentDecisions.map((d) => `- ${d.decision} (${d.reasoning})`).join("\n")}

`;
  }

  // Add unresolved errors (for context)
  const unresolvedErrors = plan.errors.filter((e) => !e.resolution);
  if (unresolvedErrors.length > 0) {
    context += `**Known Issues (${unresolvedErrors.length}):**
${unresolvedErrors.map((e) => `- [${e.attempts} attempts] ${e.action}: ${e.error}`).join("\n")}

`;
  }

  // Add recent iteration feedback
  if (recentIterations.length > 0) {
    const lastIter = recentIterations[recentIterations.length - 1];
    if (lastIter.feedback) {
      context += `**Last Feedback:**
${lastIter.feedback}

`;
    }
  }

  // 3-Strike Warning
  const escalations = getEscalationNeeded(plan);
  if (escalations.length > 0) {
    context += `**⚠️ 3-STRIKE LIMIT REACHED:**
${escalations.map((e) => `- ${e.action}: ${e.error}`).join("\n")}
These issues need different approach or user intervention.

`;
  }

  return context;
}

// === Markdown serialization/parsing ===

async function writeTaskPlan(planPath: string, plan: TaskPlan): Promise<void> {
  const md = `# Task Plan

## Task
${plan.task}

## Current Phase
Phase ${plan.currentPhase}: ${plan.phases.find((p) => p.id === plan.currentPhase)?.name ?? "Unknown"}

## Phases
${plan.phases
  .map(
    (p) => `### Phase ${p.id}: ${p.name}
**Status:** ${p.status}
**Steps:**
${p.steps.map((s) => `- ${p.completedSteps.includes(s) ? "[x]" : "[ ]"} ${s}`).join("\n")}
`,
  )
  .join("\n")}

## Acceptance Criteria
${plan.acceptanceCriteria?.map((c) => `- [ ] ${c}`).join("\n") ?? "None specified"}

## Decisions
${
  plan.decisions.length > 0
    ? plan.decisions
        .map(
          (d) =>
            `- **${d.timestamp}**: ${d.decision}\n  - Context: ${d.context}\n  - Reasoning: ${d.reasoning}`,
        )
        .join("\n")
    : "No decisions recorded yet."
}

## Errors
${
  plan.errors.length > 0
    ? plan.errors
        .map(
          (e) =>
            `- **${e.timestamp}** [${e.attempts} attempts]: ${e.action}
  - Error: ${e.error}
  - Resolution: ${e.resolution ?? "Pending"}`,
        )
        .join("\n")
    : "No errors recorded."
}

---
*Last updated: ${new Date().toISOString()}*
`;

  await fs.writeFile(planPath, md, "utf-8");
}

async function writeFindings(findingsPath: string, findings: Findings): Promise<void> {
  const md = `# Findings

## Requirements
${findings.requirements.map((r) => `- ${r}`).join("\n") || "None specified"}

## Research
${
  findings.research.length > 0
    ? findings.research
        .map(
          (f) => `### ${f.timestamp}
**Source:** ${f.source}
**Tags:** ${f.tags.join(", ")}

${f.content}
`,
        )
        .join("\n")
    : "No research recorded yet."
}

## Discoveries
${findings.discoveries.map((d) => `- ${d}`).join("\n") || "No discoveries yet."}

---
*Last updated: ${findings.lastUpdated}*
`;

  await fs.writeFile(findingsPath, md, "utf-8");
}

async function writeProgress(progressPath: string, progress: Progress): Promise<void> {
  const md = `# Progress Log

**Session Started:** ${progress.sessionStart}
**Total Actions:** ${progress.totalActions}
**Actions Since Last Save:** ${progress.actionsSinceLastSave}
**Last Action:** ${progress.lastAction}

## Iterations
${
  progress.iterations.length > 0
    ? progress.iterations
        .map(
          (i) => `### Iteration ${i.iteration}
**Started:** ${i.startTime}
**Ended:** ${i.endTime ?? "In progress"}
**Verdict:** ${i.reviewerVerdict ?? "Pending"}

**Coder Summary:**
${i.coderSummary ?? "N/A"}

**Feedback:**
${i.feedback ?? "None"}

**Files Changed:** ${i.filesChanged?.join(", ") ?? "Unknown"}
`,
        )
        .join("\n")
    : "No iterations yet."
}

## Test Results
${
  progress.testResults.length > 0
    ? progress.testResults
        .map(
          (t) => `- **${t.timestamp}** \`${t.command}\`: ${t.passed ? "✅ PASSED" : "❌ FAILED"}
  ${t.output ? `Output: ${t.output.slice(0, 200)}` : ""}`,
        )
        .join("\n")
    : "No test results yet."
}

---
*Last updated: ${new Date().toISOString()}*
`;

  await fs.writeFile(progressPath, md, "utf-8");
}

// Simplified parsers (read what we wrote)
function parseTaskPlanMarkdown(content: string): TaskPlan {
  // Extract task from ## Task section
  const taskMatch = content.match(/## Task\s*\n([\s\S]*?)(?=\n##|$)/);
  const task = taskMatch?.[1]?.trim() ?? "";

  // Extract current phase number
  const phaseMatch = content.match(/## Current Phase\s*\nPhase (\d+)/);
  const currentPhase = phaseMatch ? parseInt(phaseMatch[1], 10) : 1;

  // Extract acceptance criteria
  const criteriaMatch = content.match(/## Acceptance Criteria\s*\n([\s\S]*?)(?=\n##|$)/);
  const criteriaSection = criteriaMatch?.[1] ?? "";
  const acceptanceCriteria = criteriaSection
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^- \[.\] /, "").trim())
    .filter(Boolean);

  return {
    task,
    currentPhase,
    phases: [], // Simplified: phases are tracked in markdown only
    decisions: [],
    errors: [],
    acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : undefined,
  };
}

function parseFindingsMarkdown(content: string): Findings {
  const reqMatch = content.match(/## Requirements\s*\n([\s\S]*?)(?=\n##|$)/);
  const reqSection = reqMatch?.[1] ?? "";
  const requirements = reqSection
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);

  const discMatch = content.match(/## Discoveries\s*\n([\s\S]*?)(?=\n---|$)/);
  const discSection = discMatch?.[1] ?? "";
  const discoveries = discSection
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);

  return {
    research: [],
    requirements,
    discoveries,
    lastUpdated: new Date().toISOString(),
  };
}

function parseProgressMarkdown(content: string): Progress {
  const actionsMatch = content.match(/\*\*Total Actions:\*\* (\d+)/);
  const totalActions = actionsMatch ? parseInt(actionsMatch[1], 10) : 0;

  const sinceMatch = content.match(/\*\*Actions Since Last Save:\*\* (\d+)/);
  const actionsSinceLastSave = sinceMatch ? parseInt(sinceMatch[1], 10) : 0;

  const lastMatch = content.match(/\*\*Last Action:\*\* (.+)/);
  const lastAction = lastMatch?.[1] ?? "";

  const startMatch = content.match(/\*\*Session Started:\*\* (.+)/);
  const sessionStart = startMatch?.[1] ?? new Date().toISOString();

  return {
    sessionStart,
    iterations: [],
    testResults: [],
    lastAction,
    totalActions,
    actionsSinceLastSave,
  };
}

function createEmptyTaskPlan(): TaskPlan {
  return {
    task: "",
    phases: [],
    currentPhase: 1,
    decisions: [],
    errors: [],
  };
}

function createEmptyFindings(): Findings {
  return {
    research: [],
    requirements: [],
    discoveries: [],
    lastUpdated: new Date().toISOString(),
  };
}

function createEmptyProgress(): Progress {
  return {
    sessionStart: new Date().toISOString(),
    iterations: [],
    testResults: [],
    lastAction: "",
    totalActions: 0,
    actionsSinceLastSave: 0,
  };
}
