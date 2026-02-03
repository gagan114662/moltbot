/**
 * Task Enhancer - Automatically structures vague tasks for better verification
 *
 * Takes: "Fix the login button"
 * Returns: Structured task with:
 *   - Specific verification criteria
 *   - Test commands to run
 *   - URLs to check
 *   - Expected outcomes
 *   - Edge cases to consider
 */

import crypto from "node:crypto";

import type { FeedbackLoopConfig } from "../../../src/config/types.agent-defaults.js";
import { callGateway } from "../../../src/gateway/call.js";
import { AGENT_LANE_SUBAGENT } from "../../../src/agents/lanes.js";
import { readLatestAssistantReply } from "../../../src/agents/tools/agent-step.js";

export interface EnhancedTask {
  /** Original task */
  original: string;
  /** Structured version of the task */
  structured: string;
  /** Verification criteria */
  verification: {
    /** Commands to run (tests, build, lint) */
    commands: Array<{ command: string; description: string; required: boolean }>;
    /** URLs to check in browser */
    browserUrls: Array<{ url: string; checkFor: string }>;
    /** Expected outputs/behaviors */
    expectedOutcomes: string[];
    /** Edge cases to test */
    edgeCases: string[];
    /** Success criteria (how to know it's done) */
    successCriteria: string[];
  };
  /** Suggested files to check/modify */
  targetFiles: string[];
  /** Complexity assessment */
  complexity: "simple" | "medium" | "complex";
  /** Whether enhancement was AI-generated or rule-based */
  method: "ai" | "rules" | "passthrough";
}

/**
 * Enhance a vague task with structured verification criteria
 */
export async function enhanceTask(
  task: string,
  opts: {
    config: FeedbackLoopConfig;
    agentId: string;
    sessionKey: string;
    workspaceDir: string;
    projectContext?: string;
  },
): Promise<EnhancedTask> {
  const { config, agentId, sessionKey, workspaceDir, projectContext } = opts;

  // Step 1: Quick rule-based enhancement (always runs, fast)
  const ruleEnhanced = applyRuleBasedEnhancement(task, workspaceDir);

  // Step 2: If task is already well-structured, skip AI enhancement
  if (isWellStructured(task)) {
    console.log(`[task-enhancer] Task is well-structured, using rule-based enhancement`);
    return ruleEnhanced;
  }

  // Step 3: Use AI to enhance vague tasks
  console.log(`[task-enhancer] Enhancing vague task with AI...`);

  try {
    const aiEnhanced = await aiEnhanceTask(task, {
      config,
      agentId,
      sessionKey,
      workspaceDir,
      projectContext,
      ruleEnhanced,
    });
    return aiEnhanced;
  } catch (err) {
    console.log(`[task-enhancer] AI enhancement failed, using rule-based: ${err}`);
    return ruleEnhanced;
  }
}

/**
 * Check if task is already well-structured (has specific criteria)
 */
function isWellStructured(task: string): boolean {
  const indicators = [
    // Has test commands
    /(?:run|execute)\s+(?:the\s+)?(?:test|spec)/i,
    // Has expected output
    /(?:should|must|expect)\s+(?:return|output|display)/i,
    // Has URL to check
    /https?:\/\/|localhost:\d+/i,
    // Has edge case mention
    /edge\s*case|error\s*case|invalid\s*input/i,
    // Has success criteria
    /success(?:ful)?\s*(?:when|if)|done\s*when/i,
    // Has specific file paths
    /\.(ts|tsx|js|jsx|py|go|vue|svelte)\b.*\b(in|at|file)/i,
  ];

  // Well-structured if 2+ indicators present
  const matchCount = indicators.filter((p) => p.test(task)).length;
  return matchCount >= 2;
}

/**
 * Rule-based enhancement (fast, always works)
 */
function applyRuleBasedEnhancement(task: string, workspaceDir: string): EnhancedTask {
  const lower = task.toLowerCase();
  const verification: EnhancedTask["verification"] = {
    commands: [],
    browserUrls: [],
    expectedOutcomes: [],
    edgeCases: [],
    successCriteria: [],
  };
  const targetFiles: string[] = [];

  // Detect project type from workspace
  const isReact = /react|next|vite/i.test(workspaceDir);
  const isNode = /node|express|api/i.test(workspaceDir);
  const isPython = /python|django|flask/i.test(workspaceDir);

  // Always add basic commands
  if (isReact || isNode) {
    verification.commands.push(
      { command: "pnpm build", description: "Build must succeed", required: true },
      { command: "pnpm lint", description: "No lint errors", required: false },
    );
  } else if (isPython) {
    verification.commands.push(
      { command: "pytest", description: "Tests must pass", required: true },
      { command: "ruff check .", description: "No lint errors", required: false },
    );
  }

  // Detect component/feature type and add specific checks
  const featurePatterns: Array<{
    pattern: RegExp;
    outcomes: string[];
    edgeCases: string[];
    urls?: string[];
    commands?: Array<{ command: string; description: string; required: boolean }>;
  }> = [
    {
      pattern: /\b(login|auth|sign.?in)\b/i,
      outcomes: [
        "Login form submits successfully with valid credentials",
        "Error message shown for invalid credentials",
        "Session persists after login",
      ],
      edgeCases: [
        "Empty email/password",
        "Invalid email format",
        "Wrong password",
        "Network timeout",
      ],
      urls: ["/login", "/auth"],
      commands: [
        { command: "pnpm test -- --grep -i auth", description: "Auth tests pass", required: true },
      ],
    },
    {
      pattern: /\b(button|click|onclick)\b/i,
      outcomes: [
        "Button click triggers expected action",
        "Button has visible hover/focus states",
        "Button is accessible (keyboard navigable)",
      ],
      edgeCases: [
        "Double-click handling",
        "Click during loading state",
        "Keyboard activation (Enter/Space)",
      ],
    },
    {
      pattern: /\b(form|input|submit)\b/i,
      outcomes: [
        "Form submits with valid data",
        "Validation errors display correctly",
        "Submit button disabled during submission",
      ],
      edgeCases: [
        "Empty required fields",
        "Invalid input formats",
        "Server validation errors",
        "Double-submit prevention",
      ],
    },
    {
      pattern: /\b(api|endpoint|route)\b/i,
      outcomes: [
        "Endpoint returns correct status code",
        "Response body matches expected schema",
        "Error responses include helpful messages",
      ],
      edgeCases: [
        "Missing required parameters",
        "Invalid parameter types",
        "Authentication failures",
        "Rate limiting",
      ],
      commands: [
        { command: "pnpm test -- --grep -i api", description: "API tests pass", required: true },
      ],
    },
    {
      pattern: /\b(component|widget|ui)\b/i,
      outcomes: [
        "Component renders without errors",
        "Props are handled correctly",
        "Component is responsive",
      ],
      edgeCases: [
        "Missing/undefined props",
        "Empty data state",
        "Loading state",
        "Error state",
      ],
    },
    {
      pattern: /\b(list|table|grid)\b/i,
      outcomes: [
        "Items display correctly",
        "Pagination/scrolling works",
        "Empty state handled",
      ],
      edgeCases: [
        "Zero items",
        "Large number of items (100+)",
        "Items with long text",
        "Rapid scrolling",
      ],
    },
    {
      pattern: /\b(modal|dialog|popup)\b/i,
      outcomes: [
        "Modal opens and closes correctly",
        "Background scroll is locked",
        "Focus is trapped inside modal",
        "Escape key closes modal",
      ],
      edgeCases: [
        "Clicking outside modal",
        "Multiple modals stacking",
        "Form inside modal",
      ],
    },
    {
      pattern: /\b(fix|bug|error|issue)\b/i,
      outcomes: [
        "The reported issue no longer occurs",
        "No regression in related functionality",
        "Error handling is appropriate",
      ],
      edgeCases: [
        "Original reproduction steps",
        "Similar edge cases",
        "Related features still work",
      ],
    },
  ];

  // Apply matching patterns
  for (const { pattern, outcomes, edgeCases, urls, commands } of featurePatterns) {
    if (pattern.test(lower)) {
      verification.expectedOutcomes.push(...outcomes);
      verification.edgeCases.push(...edgeCases);
      if (urls) {
        verification.browserUrls.push(
          ...urls.map((u) => ({ url: `http://localhost:3000${u}`, checkFor: "No console errors" })),
        );
      }
      if (commands) {
        verification.commands.push(...commands);
      }
    }
  }

  // Extract file paths from task
  const filePaths = task.match(/[a-zA-Z0-9_\-./]+\.(ts|tsx|js|jsx|py|go|vue|svelte)/g);
  if (filePaths) {
    targetFiles.push(...filePaths);
  }

  // Add default success criteria
  verification.successCriteria = [
    "All tests pass",
    "No console errors in browser",
    "Build succeeds without warnings",
    "Feature works as described",
  ];

  // Assess complexity
  const complexity = assessComplexity(task);

  return {
    original: task,
    structured: buildStructuredTask(task, verification),
    verification,
    targetFiles,
    complexity,
    method: "rules",
  };
}

/**
 * AI-powered task enhancement for vague tasks
 */
async function aiEnhanceTask(
  task: string,
  opts: {
    config: FeedbackLoopConfig;
    agentId: string;
    sessionKey: string;
    workspaceDir: string;
    projectContext?: string;
    ruleEnhanced: EnhancedTask;
  },
): Promise<EnhancedTask> {
  const { config, agentId, sessionKey, workspaceDir, projectContext, ruleEnhanced } = opts;

  const prompt = buildEnhancerPrompt(task, workspaceDir, projectContext, ruleEnhanced);
  const model = config.reviewer ?? "anthropic/claude-sonnet-4-5";
  const childSessionKey = `agent:${agentId}:enhancer:${crypto.randomUUID()}`;
  const stepIdem = crypto.randomUUID();

  // Set model
  await callGateway({
    method: "sessions.patch",
    params: { key: childSessionKey, model },
    timeoutMs: 10_000,
  });

  // Spawn enhancer
  const spawnResponse = await callGateway({
    method: "agent",
    params: {
      message: prompt,
      sessionKey: childSessionKey,
      idempotencyKey: stepIdem,
      deliver: false,
      lane: AGENT_LANE_SUBAGENT,
      extraSystemPrompt: ENHANCER_SYSTEM_PROMPT,
      spawnedBy: sessionKey,
      label: "feedback-loop-enhancer",
    },
    timeoutMs: 10_000,
  }) as { runId?: string };

  const runId = spawnResponse?.runId || stepIdem;

  // Wait for response (short timeout)
  const waitTimeoutMs = 60_000; // 1 minute max
  const waitResponse = await callGateway({
    method: "agent.wait",
    params: { runId, timeoutMs: waitTimeoutMs },
    timeoutMs: waitTimeoutMs + 5_000,
  }) as { status?: string; error?: string };

  if (waitResponse?.status !== "ok") {
    throw new Error(`Enhancer failed: ${waitResponse?.error ?? "timeout"}`);
  }

  // Read and parse response
  const response = await readLatestAssistantReply({ sessionKey: childSessionKey });
  return parseEnhancerResponse(response, task, ruleEnhanced);
}

const ENHANCER_SYSTEM_PROMPT = `You are a task structuring assistant. Your job is to take vague coding tasks and make them SPECIFIC and TESTABLE.

## YOUR TASK

Given a vague task like "Fix the login button", you must return a JSON object with:

1. **structured**: A rewritten version of the task that is specific and actionable
2. **commands**: Test/build commands to run (with descriptions)
3. **browserUrls**: URLs to check in the browser
4. **expectedOutcomes**: What "success" looks like
5. **edgeCases**: Edge cases that should be tested
6. **successCriteria**: Clear criteria for "done"
7. **targetFiles**: Files likely to be modified

## EXAMPLE

Input: "Fix the login button"

Output:
\`\`\`json
{
  "structured": "Fix the login button on /login page. The button should: 1) Submit the form when clicked, 2) Show loading state during submission, 3) Display error messages from API, 4) Redirect to /dashboard on success.",
  "commands": [
    {"command": "pnpm test -- --grep -i login", "description": "Login tests pass", "required": true},
    {"command": "pnpm build", "description": "Build succeeds", "required": true}
  ],
  "browserUrls": [
    {"url": "http://localhost:3000/login", "checkFor": "No console errors, button is clickable"}
  ],
  "expectedOutcomes": [
    "Button click submits the login form",
    "Loading spinner shows during API call",
    "Error message displays on invalid credentials",
    "Successful login redirects to dashboard"
  ],
  "edgeCases": [
    "Empty email/password fields",
    "Invalid email format",
    "Network timeout during submission",
    "Double-clicking the button"
  ],
  "successCriteria": [
    "Login flow completes successfully with valid credentials",
    "Error states are handled gracefully",
    "No JavaScript console errors",
    "Existing tests still pass"
  ],
  "targetFiles": [
    "src/components/LoginForm.tsx",
    "src/pages/login.tsx"
  ]
}
\`\`\`

Return ONLY the JSON object, no other text.`;

function buildEnhancerPrompt(
  task: string,
  workspaceDir: string,
  projectContext?: string,
  ruleEnhanced?: EnhancedTask,
): string {
  let prompt = `## TASK TO ENHANCE

"${task}"

**Workspace:** ${workspaceDir}

`;

  if (projectContext) {
    prompt += `## PROJECT CONTEXT
${projectContext.slice(0, 2000)}

`;
  }

  if (ruleEnhanced && ruleEnhanced.verification.expectedOutcomes.length > 0) {
    prompt += `## RULE-BASED SUGGESTIONS (use as starting point)
- Outcomes: ${ruleEnhanced.verification.expectedOutcomes.slice(0, 3).join(", ")}
- Edge cases: ${ruleEnhanced.verification.edgeCases.slice(0, 3).join(", ")}

`;
  }

  prompt += `## YOUR TASK

Enhance this task to make it SPECIFIC and TESTABLE. Return a JSON object.`;

  return prompt;
}

function parseEnhancerResponse(response: string | undefined, originalTask: string, fallback: EnhancedTask): EnhancedTask {
  if (!response) {
    return fallback;
  }

  try {
    // Extract JSON from response
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return fallback;
    }

    const json = JSON.parse(jsonMatch[1] || jsonMatch[0]);

    return {
      original: originalTask,
      structured: json.structured || fallback.structured,
      verification: {
        commands: json.commands || fallback.verification.commands,
        browserUrls: json.browserUrls || fallback.verification.browserUrls,
        expectedOutcomes: json.expectedOutcomes || fallback.verification.expectedOutcomes,
        edgeCases: json.edgeCases || fallback.verification.edgeCases,
        successCriteria: json.successCriteria || fallback.verification.successCriteria,
      },
      targetFiles: json.targetFiles || fallback.targetFiles,
      complexity: json.complexity || fallback.complexity,
      method: "ai",
    };
  } catch {
    return fallback;
  }
}

function buildStructuredTask(task: string, verification: EnhancedTask["verification"]): string {
  const parts = [task];

  if (verification.expectedOutcomes.length > 0) {
    parts.push("\n\n**Expected outcomes:**");
    for (const outcome of verification.expectedOutcomes.slice(0, 5)) {
      parts.push(`- ${outcome}`);
    }
  }

  if (verification.commands.length > 0) {
    parts.push("\n\n**Verification commands:**");
    for (const cmd of verification.commands) {
      parts.push(`- \`${cmd.command}\` - ${cmd.description}`);
    }
  }

  if (verification.edgeCases.length > 0) {
    parts.push("\n\n**Edge cases to test:**");
    for (const edge of verification.edgeCases.slice(0, 4)) {
      parts.push(`- ${edge}`);
    }
  }

  return parts.join("\n");
}

function assessComplexity(task: string): "simple" | "medium" | "complex" {
  const lower = task.toLowerCase();

  // Complex indicators
  const complexIndicators = [
    /multiple|several|various/i,
    /refactor|rewrite|redesign/i,
    /integrate|migration/i,
    /auth|security|encryption/i,
    /database|schema|migration/i,
    /performance|optimization/i,
  ];

  // Simple indicators
  const simpleIndicators = [
    /typo|spelling|text/i,
    /color|style|css/i,
    /add.*button/i,
    /change.*text/i,
    /remove.*unused/i,
  ];

  const complexCount = complexIndicators.filter((p) => p.test(lower)).length;
  const simpleCount = simpleIndicators.filter((p) => p.test(lower)).length;

  if (complexCount >= 2 || task.length > 500) return "complex";
  if (simpleCount >= 2 && task.length < 100) return "simple";
  return "medium";
}

/**
 * Build a prompt section with enhanced task details
 */
export function buildEnhancedTaskPrompt(enhanced: EnhancedTask): string {
  const lines = [
    "## ENHANCED TASK",
    "",
    enhanced.structured,
    "",
  ];

  if (enhanced.verification.successCriteria.length > 0) {
    lines.push("## SUCCESS CRITERIA (verify ALL before marking done)");
    for (const criteria of enhanced.verification.successCriteria) {
      lines.push(`- [ ] ${criteria}`);
    }
    lines.push("");
  }

  if (enhanced.verification.commands.length > 0) {
    lines.push("## VERIFICATION COMMANDS (run these to verify)");
    for (const cmd of enhanced.verification.commands) {
      const marker = cmd.required ? "[REQUIRED]" : "[optional]";
      lines.push(`- ${marker} \`${cmd.command}\` - ${cmd.description}`);
    }
    lines.push("");
  }

  if (enhanced.verification.browserUrls.length > 0) {
    lines.push("## BROWSER VERIFICATION");
    for (const url of enhanced.verification.browserUrls) {
      lines.push(`- Check ${url.url}: ${url.checkFor}`);
    }
    lines.push("");
  }

  if (enhanced.verification.edgeCases.length > 0) {
    lines.push("## EDGE CASES TO TEST");
    for (const edge of enhanced.verification.edgeCases) {
      lines.push(`- ${edge}`);
    }
    lines.push("");
  }

  if (enhanced.targetFiles.length > 0) {
    lines.push("## LIKELY FILES TO MODIFY");
    for (const file of enhanced.targetFiles) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }

  lines.push(`**Complexity:** ${enhanced.complexity}`);
  lines.push(`**Enhancement method:** ${enhanced.method}`);

  return lines.join("\n");
}
