/**
 * Best Practices Module (from Claude Code docs)
 *
 * Implements key patterns for effective agentic coding:
 * 1. Verification criteria - tests, screenshots, expected outputs
 * 2. Explore → Plan → Implement → Commit workflow
 * 3. Specific context in prompts
 * 4. Subagent delegation for investigation
 * 5. Context management
 * 6. Course-correction patterns
 */

export interface VerificationCriteria {
  /** Test commands to run */
  tests?: string[];
  /** URLs to check in browser */
  browserUrls?: string[];
  /** Expected outputs to validate */
  expectedOutputs?: Array<{
    description: string;
    command?: string;
    pattern?: RegExp;
  }>;
  /** Screenshot comparisons */
  screenshots?: Array<{
    url: string;
    selector?: string;
    compareWith?: string;
  }>;
  /** Build commands that must succeed */
  buildCommands?: string[];
  /** Lint/type check commands */
  qualityCommands?: string[];
}

export interface TaskContext {
  /** Specific files to focus on */
  targetFiles?: string[];
  /** Reference patterns in codebase */
  examplePatterns?: Array<{
    file: string;
    description: string;
  }>;
  /** Relevant documentation URLs */
  docs?: string[];
  /** Constraints or requirements */
  constraints?: string[];
  /** Edge cases to handle */
  edgeCases?: string[];
}

export interface WorkflowPhase {
  name: "explore" | "plan" | "implement" | "commit";
  completed: boolean;
  output?: string;
  duration?: number;
}

/**
 * Build verification criteria prompt section
 */
export function buildVerificationPrompt(criteria: VerificationCriteria): string {
  const lines: string[] = ["## VERIFICATION CRITERIA", ""];

  if (criteria.tests?.length) {
    lines.push("**Tests to run:**");
    for (const test of criteria.tests) {
      lines.push(`- \`${test}\``);
    }
    lines.push("");
  }

  if (criteria.buildCommands?.length) {
    lines.push("**Build commands (must succeed):**");
    for (const cmd of criteria.buildCommands) {
      lines.push(`- \`${cmd}\``);
    }
    lines.push("");
  }

  if (criteria.qualityCommands?.length) {
    lines.push("**Quality checks:**");
    for (const cmd of criteria.qualityCommands) {
      lines.push(`- \`${cmd}\``);
    }
    lines.push("");
  }

  if (criteria.browserUrls?.length) {
    lines.push("**Browser verification:**");
    for (const url of criteria.browserUrls) {
      lines.push(`- Check ${url} for errors`);
    }
    lines.push("");
  }

  if (criteria.expectedOutputs?.length) {
    lines.push("**Expected outputs:**");
    for (const output of criteria.expectedOutputs) {
      lines.push(`- ${output.description}`);
      if (output.command) {
        lines.push(`  Command: \`${output.command}\``);
      }
    }
    lines.push("");
  }

  if (criteria.screenshots?.length) {
    lines.push("**Screenshot verification:**");
    for (const ss of criteria.screenshots) {
      lines.push(`- Capture ${ss.url}${ss.selector ? ` (${ss.selector})` : ""}`);
      if (ss.compareWith) {
        lines.push(`  Compare with: ${ss.compareWith}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Build task context prompt section
 */
export function buildContextPrompt(context: TaskContext): string {
  const lines: string[] = ["## TASK CONTEXT", ""];

  if (context.targetFiles?.length) {
    lines.push("**Target files:**");
    for (const file of context.targetFiles) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }

  if (context.examplePatterns?.length) {
    lines.push("**Reference patterns (follow these):**");
    for (const pattern of context.examplePatterns) {
      lines.push(`- ${pattern.file}: ${pattern.description}`);
    }
    lines.push("");
  }

  if (context.docs?.length) {
    lines.push("**Documentation:**");
    for (const doc of context.docs) {
      lines.push(`- ${doc}`);
    }
    lines.push("");
  }

  if (context.constraints?.length) {
    lines.push("**Constraints:**");
    for (const constraint of context.constraints) {
      lines.push(`- ${constraint}`);
    }
    lines.push("");
  }

  if (context.edgeCases?.length) {
    lines.push("**Edge cases to handle:**");
    for (const edgeCase of context.edgeCases) {
      lines.push(`- ${edgeCase}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Extract verification criteria from task description
 */
export function extractVerificationCriteria(task: string): VerificationCriteria {
  const criteria: VerificationCriteria = {};

  // Look for test mentions
  const testPatterns = [
    /run (?:the )?tests?/i,
    /test suite/i,
    /verify (?:with )?tests?/i,
    /jest|vitest|pytest|mocha/i,
  ];

  if (testPatterns.some((p) => p.test(task))) {
    // Detect test framework from task
    if (/vitest/i.test(task)) {
      criteria.tests = ["pnpm test"];
    } else if (/jest/i.test(task)) {
      criteria.tests = ["npm test"];
    } else if (/pytest/i.test(task)) {
      criteria.tests = ["pytest"];
    } else {
      criteria.tests = ["pnpm test"];
    }
  }

  // Look for build mentions
  if (/build|compile|tsc/i.test(task)) {
    criteria.buildCommands = ["pnpm build"];
  }

  // Look for lint/type check mentions
  if (/lint|eslint|type.?check/i.test(task)) {
    criteria.qualityCommands = ["pnpm lint", "pnpm build --noEmit"];
  }

  // Look for URL mentions (browser verification)
  const urlMatches = task.match(/https?:\/\/[^\s,)]+/g);
  if (urlMatches) {
    criteria.browserUrls = urlMatches;
  }

  // Look for localhost mentions
  const localhostMatch = task.match(/localhost:\d+/g);
  if (localhostMatch) {
    criteria.browserUrls = [
      ...(criteria.browserUrls ?? []),
      ...localhostMatch.map((l) => `http://${l}`),
    ];
  }

  return criteria;
}

/**
 * Extract task context from description
 */
export function extractTaskContext(task: string, _projectContext?: string): TaskContext {
  const context: TaskContext = {};

  // Extract file paths mentioned
  const fileMatches = task.match(
    /(?:in |at |file |path )?([a-zA-Z0-9_\-./]+\.(ts|tsx|js|jsx|py|go|rs|vue|svelte))/g,
  );
  if (fileMatches) {
    context.targetFiles = fileMatches.map((m) => m.replace(/^(?:in |at |file |path )/, ""));
  }

  // Extract component/function names that might indicate patterns
  const componentMatches = task.match(
    /(?:like |similar to |following |pattern of )([A-Z][a-zA-Z]+(?:Component|Widget|Module|Service)?)/g,
  );
  if (componentMatches) {
    context.examplePatterns = componentMatches.map((m) => ({
      file: m.replace(/^(?:like |similar to |following |pattern of )/, ""),
      description: "Reference implementation",
    }));
  }

  // Extract constraints
  const constraintPatterns = [
    {
      pattern: /without (?:using )?(?:any )?(?:external )?(?:libraries|dependencies)/i,
      constraint: "No external dependencies",
    },
    { pattern: /avoid (?:using )?mocks?/i, constraint: "Avoid mocks in tests" },
    { pattern: /no (?:breaking )?changes/i, constraint: "No breaking changes" },
    { pattern: /backward.?compatible/i, constraint: "Maintain backward compatibility" },
    { pattern: /type.?safe/i, constraint: "Ensure type safety" },
  ];

  for (const { pattern, constraint } of constraintPatterns) {
    if (pattern.test(task)) {
      context.constraints = [...(context.constraints ?? []), constraint];
    }
  }

  // Extract edge cases mentioned
  const edgeCasePatterns = [
    { pattern: /edge case|corner case/i, extract: true },
    { pattern: /handle (?:the case )?(?:when|where|if)/i, extract: true },
    { pattern: /(?:empty|null|undefined|invalid|error)/i, extract: true },
  ];

  for (const { pattern } of edgeCasePatterns) {
    const match = task.match(new RegExp(`${pattern.source}[^.]*`, "i"));
    if (match) {
      context.edgeCases = [...(context.edgeCases ?? []), match[0].trim()];
    }
  }

  return context;
}

/**
 * Build enhanced coder prompt with best practices
 */
export function buildEnhancedCoderPrompt(
  task: string,
  options: {
    verification?: VerificationCriteria;
    context?: TaskContext;
    projectInstructions?: string;
    learnedRules?: string;
    previousFeedback?: string;
  },
): string {
  const sections: string[] = [];

  // Main task
  sections.push(`## TASK\n${task}`);

  // Project instructions (AGENTS.md/CLAUDE.md content)
  if (options.projectInstructions) {
    sections.push(`## PROJECT INSTRUCTIONS\n${options.projectInstructions}`);
  }

  // Learned rules from previous sessions
  if (options.learnedRules) {
    sections.push(`## LEARNED PATTERNS\n${options.learnedRules}`);
  }

  // Task context
  if (options.context) {
    const contextPrompt = buildContextPrompt(options.context);
    if (contextPrompt.split("\n").length > 3) {
      sections.push(contextPrompt);
    }
  }

  // Verification criteria
  if (options.verification) {
    const verificationPrompt = buildVerificationPrompt(options.verification);
    if (verificationPrompt.split("\n").length > 3) {
      sections.push(verificationPrompt);
    }
  }

  // Previous feedback
  if (options.previousFeedback) {
    sections.push(`## PREVIOUS FEEDBACK (address these issues)\n${options.previousFeedback}`);
  }

  // Best practices reminder
  sections.push(`## BEST PRACTICES
- Explore relevant code before making changes
- Follow existing patterns in the codebase
- Write tests or verification for your changes
- Address root causes, not symptoms
- Keep changes minimal and focused`);

  return sections.join("\n\n");
}

/**
 * Build enhanced reviewer prompt with best practices
 */
export function buildEnhancedReviewerPrompt(
  task: string,
  options: {
    verification?: VerificationCriteria;
    context?: TaskContext;
    projectInstructions?: string;
    changedFiles?: string[];
  },
): string {
  const sections: string[] = [];

  // Main task
  sections.push(`## TASK TO VERIFY\n${task}`);

  // Project instructions
  if (options.projectInstructions) {
    sections.push(`## PROJECT INSTRUCTIONS\n${options.projectInstructions}`);
  }

  // Changed files
  if (options.changedFiles?.length) {
    sections.push(`## CHANGED FILES\n${options.changedFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  // Verification criteria
  if (options.verification) {
    sections.push(buildVerificationPrompt(options.verification));
  }

  // Review checklist
  sections.push(`## REVIEW CHECKLIST
1. **Correctness**: Does the code solve the stated task?
2. **Tests**: Do tests pass? Are edge cases covered?
3. **Quality**: No debug statements, TODOs, or hardcoded secrets?
4. **Patterns**: Does it follow existing codebase patterns?
5. **Integration**: Is it properly integrated (not just a demo)?
6. **Browser**: If UI changes, check the browser for errors

## RESPONSE FORMAT
If APPROVED: Respond with "APPROVED" and a brief summary
If NEEDS WORK: List specific issues with actionable fixes`);

  return sections.join("\n\n");
}

/**
 * Subagent delegation patterns
 */
export interface SubagentTask {
  type: "investigate" | "review" | "test" | "refactor";
  scope: string;
  files?: string[];
  question?: string;
}

/**
 * Build subagent prompt for investigation
 */
export function buildSubagentPrompt(task: SubagentTask): string {
  switch (task.type) {
    case "investigate":
      return `Investigate: ${task.scope}

Search the codebase for relevant patterns and report back with:
1. Key files and their purposes
2. Existing patterns to follow
3. Potential concerns or gotchas
${task.files ? `\nFocus on: ${task.files.join(", ")}` : ""}
${task.question ? `\nSpecific question: ${task.question}` : ""}`;

    case "review":
      return `Review the following code for issues:
${task.scope}

Check for:
- Edge cases and error handling
- Security vulnerabilities
- Performance issues
- Code style consistency
${task.files ? `\nFiles to review: ${task.files.join(", ")}` : ""}`;

    case "test":
      return `Generate tests for: ${task.scope}

Requirements:
- Cover happy path and edge cases
- Test error conditions
- Follow existing test patterns
${task.files ? `\nTarget files: ${task.files.join(", ")}` : ""}`;

    case "refactor":
      return `Refactor suggestion for: ${task.scope}

Analyze and suggest improvements for:
- Code organization
- Naming clarity
- Reducing duplication
- Improving maintainability
${task.files ? `\nFiles to analyze: ${task.files.join(", ")}` : ""}`;

    default:
      return task.scope;
  }
}

/**
 * Detect common failure patterns in a session
 */
export interface FailurePattern {
  type:
    | "kitchen-sink"
    | "over-correction"
    | "trust-gap"
    | "infinite-exploration"
    | "bloated-context";
  description: string;
  suggestion: string;
}

export function detectFailurePatterns(
  iterationCount: number,
  consecutiveErrors: number,
  contextUsage: number,
  feedbackHistory: string[],
): FailurePattern[] {
  const patterns: FailurePattern[] = [];

  // Over-correction pattern
  if (consecutiveErrors >= 2) {
    patterns.push({
      type: "over-correction",
      description: `${consecutiveErrors} consecutive corrections without resolution`,
      suggestion: "Consider clearing context and starting with a more specific prompt",
    });
  }

  // Bloated context
  if (contextUsage > 0.7) {
    patterns.push({
      type: "bloated-context",
      description: `Context is ${Math.round(contextUsage * 100)}% full`,
      suggestion: "Clear irrelevant context or use subagents for investigation",
    });
  }

  // Trust gap - same issues recurring
  if (feedbackHistory.length >= 3) {
    const recentFeedback = feedbackHistory.slice(-3);
    const patterns_seen = new Set<string>();
    for (const feedback of recentFeedback) {
      if (/test.*fail/i.test(feedback)) {
        patterns_seen.add("test-failure");
      }
      if (/type.*error/i.test(feedback)) {
        patterns_seen.add("type-error");
      }
      if (/not.*integrat/i.test(feedback)) {
        patterns_seen.add("integration");
      }
    }
    if (patterns_seen.size < recentFeedback.length) {
      patterns.push({
        type: "trust-gap",
        description: "Same issues recurring across iterations",
        suggestion: "Add explicit verification criteria (tests, type checks) to catch issues early",
      });
    }
  }

  return patterns;
}

/**
 * Suggest workflow phase based on task and state
 */
export function suggestWorkflowPhase(
  task: string,
  options: {
    hasExplored?: boolean;
    hasPlan?: boolean;
    hasImplemented?: boolean;
    isSimpleTask?: boolean;
  },
): WorkflowPhase["name"] {
  // Simple tasks can skip planning
  if (options.isSimpleTask) {
    return options.hasImplemented ? "commit" : "implement";
  }

  // Full workflow
  if (!options.hasExplored) {
    return "explore";
  }
  if (!options.hasPlan) {
    return "plan";
  }
  if (!options.hasImplemented) {
    return "implement";
  }
  return "commit";
}

/**
 * Detect if a task is simple enough to skip planning
 */
export function isSimpleTask(task: string): boolean {
  const simplePatterns = [
    /fix (?:a )?typo/i,
    /rename (?:a )?(?:variable|function|class)/i,
    /add (?:a )?(?:log|comment|console)/i,
    /remove (?:unused|dead) code/i,
    /update (?:a )?(?:version|dependency)/i,
    /single.?line (?:fix|change)/i,
  ];

  return simplePatterns.some((p) => p.test(task));
}

// ============================================
// ADDITIONAL BEST PRACTICES (100% coverage)
// ============================================

/**
 * Interview questions to gather requirements before coding
 * Best Practice: "Let Claude interview you"
 */
export interface InterviewQuestion {
  category: "technical" | "ui-ux" | "edge-cases" | "tradeoffs" | "constraints";
  question: string;
  priority: "high" | "medium" | "low";
}

export function generateInterviewQuestions(task: string): InterviewQuestion[] {
  const questions: InterviewQuestion[] = [];

  // Technical implementation questions
  if (/api|endpoint|backend/i.test(task)) {
    questions.push({
      category: "technical",
      question: "What authentication method should the API use?",
      priority: "high",
    });
    questions.push({
      category: "technical",
      question: "What response format is expected (JSON, XML, etc)?",
      priority: "medium",
    });
  }

  if (/database|store|persist/i.test(task)) {
    questions.push({
      category: "technical",
      question: "What database/storage should be used?",
      priority: "high",
    });
  }

  // UI/UX questions
  if (/ui|page|component|form|button/i.test(task)) {
    questions.push({
      category: "ui-ux",
      question: "Is there a design mockup or existing pattern to follow?",
      priority: "high",
    });
    questions.push({
      category: "ui-ux",
      question: "What should happen after the user completes this action?",
      priority: "medium",
    });
  }

  // Edge cases
  questions.push({
    category: "edge-cases",
    question: "What should happen if the operation fails?",
    priority: "high",
  });
  questions.push({
    category: "edge-cases",
    question: "Are there any rate limits or quotas to consider?",
    priority: "low",
  });

  // Tradeoffs
  if (/performance|fast|slow|optimize/i.test(task)) {
    questions.push({
      category: "tradeoffs",
      question: "What's the acceptable latency for this operation?",
      priority: "high",
    });
  }

  // Constraints
  if (/without|avoid|don't|no /i.test(task)) {
    questions.push({
      category: "constraints",
      question: "Are there any other constraints not mentioned?",
      priority: "medium",
    });
  }

  return questions;
}

/**
 * Build interview prompt for requirements gathering
 */
export function buildInterviewPrompt(task: string): string {
  const questions = generateInterviewQuestions(task);

  if (questions.length === 0) {
    return "";
  }

  const lines = [
    "## REQUIREMENTS INTERVIEW",
    "",
    "Before implementing, I need to clarify a few things:",
    "",
  ];

  const highPriority = questions.filter((q) => q.priority === "high");
  const mediumPriority = questions.filter((q) => q.priority === "medium");

  if (highPriority.length > 0) {
    lines.push("**Critical questions:**");
    for (const q of highPriority) {
      lines.push(`- [${q.category}] ${q.question}`);
    }
    lines.push("");
  }

  if (mediumPriority.length > 0) {
    lines.push("**Additional considerations:**");
    for (const q of mediumPriority) {
      lines.push(`- [${q.category}] ${q.question}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Auto-commit configuration after approval
 * Best Practice: "Explore → Plan → Implement → Commit"
 */
export interface CommitConfig {
  enabled: boolean;
  messageStyle: "conventional" | "descriptive" | "brief";
  includeCoAuthor: boolean;
  autoPush: boolean;
  createPR: boolean;
}

export function buildCommitMessage(
  task: string,
  changedFiles: string[],
  style: CommitConfig["messageStyle"] = "conventional",
): string {
  // Detect commit type from task
  let type = "feat";
  if (/fix|bug|issue|error/i.test(task)) {
    type = "fix";
  }
  if (/refactor|clean|reorganize/i.test(task)) {
    type = "refactor";
  }
  if (/test|spec/i.test(task)) {
    type = "test";
  }
  if (/doc|readme|comment/i.test(task)) {
    type = "docs";
  }
  if (/style|format|lint/i.test(task)) {
    type = "style";
  }
  if (/perf|optim|fast/i.test(task)) {
    type = "perf";
  }

  // Extract scope from files
  const scopes = new Set<string>();
  for (const file of changedFiles) {
    const match = file.match(/(?:src|lib|app)\/([^/]+)/);
    if (match) {
      scopes.add(match[1]);
    }
  }
  const scope = scopes.size === 1 ? `(${[...scopes][0]})` : "";

  // Build message based on style
  switch (style) {
    case "conventional":
      return `${type}${scope}: ${task.slice(0, 50)}`;
    case "descriptive":
      return `${task}\n\nChanged files:\n${changedFiles.map((f) => `- ${f}`).join("\n")}`;
    case "brief":
      return task.slice(0, 72);
    default:
      return task.slice(0, 72);
  }
}

/**
 * Context management - detect when to clear/compact
 * Best Practice: "Manage context aggressively"
 */
export interface ContextHealth {
  status: "healthy" | "warning" | "critical";
  usagePercent: number;
  suggestions: string[];
  shouldCompact: boolean;
  shouldClear: boolean;
}

export function assessContextHealth(
  iterationCount: number,
  filesRead: number,
  totalTokensEstimate: number,
  maxTokens: number = 200000,
): ContextHealth {
  const usagePercent = (totalTokensEstimate / maxTokens) * 100;
  const suggestions: string[] = [];

  let status: ContextHealth["status"] = "healthy";
  let shouldCompact = false;
  let _shouldClear = false;

  if (usagePercent > 80) {
    status = "critical";
    shouldCompact = true;
    suggestions.push("Context nearly full - compact immediately");
    suggestions.push("Consider starting fresh session for new tasks");
  } else if (usagePercent > 60) {
    status = "warning";
    shouldCompact = true;
    suggestions.push("Context getting full - consider compacting");
  }

  if (iterationCount > 5 && usagePercent > 50) {
    suggestions.push("Many iterations with moderate context - review if on track");
  }

  if (filesRead > 20) {
    suggestions.push("Many files read - consider using subagents for exploration");
  }

  if (iterationCount > 3 && status === "healthy") {
    suggestions.push("Multiple iterations - ensure not correcting the same issue repeatedly");
  }

  return {
    status,
    usagePercent,
    suggestions,
    shouldCompact,
    shouldClear: usagePercent > 90,
  };
}

/**
 * Subagent investigation prompts
 * Best Practice: "Use subagents for investigation"
 */
export function buildExplorationSubagentPrompt(task: string, codebaseHints?: string[]): string {
  const lines = [
    "## CODEBASE EXPLORATION",
    "",
    `Investigate the codebase to understand how to implement: "${task}"`,
    "",
    "Find and report:",
    "1. **Relevant files** - What files will need to be modified?",
    "2. **Existing patterns** - How are similar features implemented?",
    "3. **Dependencies** - What modules/packages are involved?",
    "4. **Potential risks** - Any gotchas or breaking change risks?",
    "5. **Test patterns** - How are similar features tested?",
    "",
  ];

  if (codebaseHints?.length) {
    lines.push("**Hints to start:**");
    for (const hint of codebaseHints) {
      lines.push(`- ${hint}`);
    }
    lines.push("");
  }

  lines.push("Report back with a structured summary, not code.");

  return lines.join("\n");
}

/**
 * Session tracking for resume capability
 * Best Practice: "Resume conversations"
 */
export interface SessionCheckpoint {
  id: string;
  timestamp: string;
  task: string;
  phase: "explore" | "plan" | "implement" | "review" | "commit";
  iteration: number;
  approved: boolean;
  changedFiles: string[];
  lastFeedback?: string;
  contextSummary?: string;
}

export function createSessionCheckpoint(
  state: {
    task: string;
    iteration: number;
    approved: boolean;
    previousFeedback?: string;
  },
  changedFiles: string[],
  phase: SessionCheckpoint["phase"],
): SessionCheckpoint {
  return {
    id: `checkpoint-${Date.now()}`,
    timestamp: new Date().toISOString(),
    task: state.task,
    phase,
    iteration: state.iteration,
    approved: state.approved,
    changedFiles,
    lastFeedback: state.previousFeedback,
  };
}

export function buildResumePrompt(checkpoint: SessionCheckpoint): string {
  const lines = [
    "## RESUMING PREVIOUS SESSION",
    "",
    `**Task:** ${checkpoint.task}`,
    `**Phase:** ${checkpoint.phase}`,
    `**Iteration:** ${checkpoint.iteration}`,
    `**Status:** ${checkpoint.approved ? "Approved" : "In Progress"}`,
    "",
  ];

  if (checkpoint.changedFiles.length > 0) {
    lines.push("**Files changed so far:**");
    for (const file of checkpoint.changedFiles) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }

  if (checkpoint.lastFeedback) {
    lines.push("**Last feedback:**");
    lines.push(checkpoint.lastFeedback);
    lines.push("");
  }

  lines.push("Continue from where we left off.");

  return lines.join("\n");
}

/**
 * Screenshot comparison for UI verification
 * Best Practice: "Verify UI changes visually"
 */
export interface ScreenshotComparison {
  beforePath?: string;
  afterPath?: string;
  diffPath?: string;
  matchPercent?: number;
  differences: string[];
}

export function buildScreenshotVerificationPrompt(url: string, designMockupPath?: string): string {
  const lines = [
    "## VISUAL VERIFICATION",
    "",
    `Navigate to: ${url}`,
    "",
    "Capture a screenshot and verify:",
    "1. Layout matches expected design",
    "2. All interactive elements are visible",
    "3. Text is readable and properly formatted",
    "4. No visual glitches or overflow issues",
    "5. Responsive behavior (if applicable)",
    "",
  ];

  if (designMockupPath) {
    lines.push(`Compare against design mockup: ${designMockupPath}`);
    lines.push("List any differences between implementation and design.");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Course correction helpers
 * Best Practice: "Course-correct early and often"
 */
export interface CourseCorrection {
  type: "rewind" | "clear" | "refocus" | "escalate";
  reason: string;
  action: string;
}

export function suggestCourseCorrection(
  iterationCount: number,
  consecutiveErrors: number,
  sameIssueCount: number,
  contextUsage: number,
): CourseCorrection | null {
  // Same issue recurring
  if (sameIssueCount >= 2) {
    return {
      type: "clear",
      reason: `Same issue occurring ${sameIssueCount} times`,
      action: "Clear context and restart with more specific prompt incorporating lessons learned",
    };
  }

  // Too many consecutive errors
  if (consecutiveErrors >= 3) {
    return {
      type: "escalate",
      reason: `${consecutiveErrors} consecutive failures`,
      action: "Pause for human intervention - the approach may be fundamentally wrong",
    };
  }

  // Context bloat
  if (contextUsage > 0.8) {
    return {
      type: "clear",
      reason: "Context nearly full",
      action: "Clear context to prevent performance degradation",
    };
  }

  // Many iterations without progress
  if (iterationCount >= 5 && consecutiveErrors >= 2) {
    return {
      type: "refocus",
      reason: "Multiple iterations without approval",
      action: "Re-examine the task requirements and verification criteria",
    };
  }

  return null;
}

/**
 * Rich content handling
 * Best Practice: "Provide rich content"
 */
export interface RichContent {
  type: "file" | "image" | "url" | "data";
  path?: string;
  url?: string;
  description: string;
}

export function extractRichContent(task: string): RichContent[] {
  const content: RichContent[] = [];

  // Extract file references (@file syntax)
  const fileRefs = task.matchAll(/@([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)/g);
  for (const match of fileRefs) {
    content.push({
      type: "file",
      path: match[1],
      description: `Reference to ${match[1]}`,
    });
  }

  // Extract URLs
  const urls = task.matchAll(/(https?:\/\/[^\s]+)/g);
  for (const match of urls) {
    content.push({
      type: "url",
      url: match[1],
      description: `Documentation/reference at ${match[1]}`,
    });
  }

  // Extract image paths
  const imagePaths = task.matchAll(
    /(?:screenshot|image|mockup|design)[:\s]+([a-zA-Z0-9_\-./]+\.(?:png|jpg|jpeg|gif|svg))/gi,
  );
  for (const match of imagePaths) {
    content.push({
      type: "image",
      path: match[1],
      description: `Image reference: ${match[1]}`,
    });
  }

  return content;
}

/**
 * Headless/parallel mode configuration
 * Best Practice: "Run headless mode" and "Fan out across files"
 */
export interface ParallelTaskConfig {
  enabled: boolean;
  maxConcurrent: number;
  tasks: Array<{
    id: string;
    task: string;
    files?: string[];
    dependencies?: string[];
  }>;
}

export function buildParallelTaskPrompt(
  mainTask: string,
  files: string[],
  maxConcurrent: number = 3,
): ParallelTaskConfig {
  const tasks: ParallelTaskConfig["tasks"] = [];

  // Group files by directory or type
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const dir = file.split("/").slice(0, -1).join("/") || ".";
    const existing = byDir.get(dir) ?? [];
    existing.push(file);
    byDir.set(dir, existing);
  }

  let taskId = 0;
  for (const [dir, dirFiles] of byDir) {
    tasks.push({
      id: `task-${taskId++}`,
      task: `${mainTask} in ${dir}`,
      files: dirFiles,
    });
  }

  return {
    enabled: tasks.length > 1,
    maxConcurrent: Math.min(maxConcurrent, tasks.length),
    tasks,
  };
}

/**
 * Safe autonomous mode configuration
 * Best Practice: "Safe Autonomous Mode"
 */
export interface AutonomousConfig {
  enabled: boolean;
  allowedTools: string[];
  blockedTools: string[];
  maxFileEdits: number;
  requireConfirmation: string[];
  sandboxed: boolean;
}

export const DEFAULT_AUTONOMOUS_CONFIG: AutonomousConfig = {
  enabled: false,
  allowedTools: [
    "Read",
    "Glob",
    "Grep",
    "Bash(git status)",
    "Bash(git diff)",
    "Bash(pnpm test)",
    "Bash(pnpm lint)",
    "Bash(pnpm build)",
  ],
  blockedTools: [
    "Bash(rm -rf)",
    "Bash(git push --force)",
    "Bash(git reset --hard)",
    "Write(/etc/*)",
    "Write(~/.ssh/*)",
  ],
  maxFileEdits: 10,
  requireConfirmation: ["git commit", "git push", "npm publish", "destructive operations"],
  sandboxed: true,
};

export function isOperationAllowed(
  operation: string,
  config: AutonomousConfig = DEFAULT_AUTONOMOUS_CONFIG,
): { allowed: boolean; reason?: string } {
  // Check blocked list first
  for (const blocked of config.blockedTools) {
    if (operation.includes(blocked.replace("Bash(", "").replace(")", ""))) {
      return { allowed: false, reason: `Operation matches blocked pattern: ${blocked}` };
    }
  }

  // Check if requires confirmation
  for (const confirm of config.requireConfirmation) {
    if (operation.toLowerCase().includes(confirm.toLowerCase())) {
      return { allowed: false, reason: `Operation requires confirmation: ${confirm}` };
    }
  }

  // Check allowed list
  for (const allowed of config.allowedTools) {
    if (operation.startsWith(allowed.split("(")[0])) {
      return { allowed: true };
    }
  }

  return {
    allowed: !config.sandboxed,
    reason: config.sandboxed ? "Operation not in allowlist" : undefined,
  };
}
