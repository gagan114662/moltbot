import crypto from "node:crypto";

import type {
  FeedbackLoopConfig,
  FeedbackLoopGatesConfig,
} from "../../../src/config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { callGateway } from "../../../src/gateway/call.js";
import { AGENT_LANE_SUBAGENT } from "../../../src/agents/lanes.js";
import { readLatestAssistantReply } from "../../../src/agents/tools/agent-step.js";
import { runWithModelFallback } from "../../../src/agents/model-fallback.js";
import { parseModelRef } from "../../../src/agents/model-selection.js";

import type { ReviewResult, CheckResult } from "./orchestrator.js";

export type ReviewerContext = {
  task: string;
  coderSummary: string;
  acceptanceCriteria?: string[];
  pastIssues?: string;
  checklist?: string;
  /** Planning context from planning-with-files pattern (PreToolUse). */
  planContext?: string;
  /** Project context from AGENTS.md/CLAUDE.md (auto-detected). */
  projectContext?: string;
  config: FeedbackLoopConfig;
  /** Global config for model fallback support. */
  globalConfig?: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
};

/**
 * Spawn Claude as an actual reviewer agent with browser access.
 * This replaces the shell-command-only review with real AI-powered testing.
 *
 * Supports model fallback: if the primary reviewer model fails, will automatically
 * try fallback models from config.reviewerFallbacks or agents.defaults.model.fallbacks.
 */
export async function spawnReviewer(opts: ReviewerContext): Promise<ReviewResult> {
  const { config, globalConfig } = opts;

  const primaryReviewer = config.reviewer ?? "anthropic/claude-sonnet-4-5";
  const parsed = parseModelRef(primaryReviewer, "anthropic");

  if (!parsed) {
    console.log(`[feedback-loop] Invalid reviewer model: ${primaryReviewer}`);
    return {
      approved: false,
      checks: [],
      feedback: `Invalid reviewer model: ${primaryReviewer}`,
    };
  }

  // Use reviewer-specific fallbacks if configured, otherwise use global fallbacks
  const fallbacksOverride = config.reviewerFallbacks;

  try {
    const { result, provider, model } = await runWithModelFallback({
      cfg: globalConfig,
      provider: parsed.provider,
      model: parsed.model,
      fallbacksOverride,
      run: async (provider, model) => {
        const reviewerModel = `${provider}/${model}`;
        return await spawnReviewerWithModel({ ...opts, reviewerModel });
      },
      onError: (attempt) => {
        console.log(
          `[feedback-loop] Reviewer fallback: ${attempt.provider}/${attempt.model} failed (${attempt.attempt}/${attempt.total})`,
        );
      },
    });

    console.log(`[feedback-loop] Reviewer completed with ${provider}/${model}`);
    return result;
  } catch (err) {
    // All models failed
    const error = err instanceof Error ? err.message : String(err);
    console.log(`[feedback-loop] All reviewer models failed: ${error}`);
    return {
      approved: false,
      checks: [],
      feedback: `All reviewer models failed: ${error}`,
    };
  }
}

/**
 * Internal: spawn reviewer with a specific model.
 * This is the actual spawning logic, separated for use with runWithModelFallback.
 */
async function spawnReviewerWithModel(
  opts: ReviewerContext & { reviewerModel: string },
): Promise<ReviewResult> {
  const {
    task,
    coderSummary,
    acceptanceCriteria,
    pastIssues,
    checklist,
    agentId,
    sessionKey,
    workspaceDir,
    reviewerModel,
  } = opts;

  // Build comprehensive reviewer prompt
  const prompt = buildReviewerPrompt({
    task,
    coderSummary,
    acceptanceCriteria,
    pastIssues,
    checklist,
    planContext: opts.planContext,
    projectContext: opts.projectContext,
    workspaceDir,
  });

  const childSessionKey = `agent:${agentId}:reviewer:${crypto.randomUUID()}`;
  const stepIdem = crypto.randomUUID();

  console.log(`[feedback-loop] Spawning reviewer (${reviewerModel})...`);

  // Step 1: Set model for the reviewer session
  await callGateway({
    method: "sessions.patch",
    params: { key: childSessionKey, model: reviewerModel },
    timeoutMs: 10_000,
  });

  // Step 2: Spawn the reviewer agent
  const spawnResponse = (await callGateway({
    method: "agent",
    params: {
      message: prompt,
      sessionKey: childSessionKey,
      idempotencyKey: stepIdem,
      deliver: false,
      lane: AGENT_LANE_SUBAGENT,
      extraSystemPrompt: REVIEWER_SYSTEM_PROMPT,
      spawnedBy: sessionKey,
      label: "feedback-loop-reviewer",
    },
    timeoutMs: 10_000,
  })) as { runId?: string };

  const runId = spawnResponse?.runId || stepIdem;

  // Step 3: Wait for reviewer to complete (longer timeout - browser testing takes time)
  const waitTimeoutMs = 900_000; // 15 minutes max
  console.log(`[feedback-loop] Waiting for reviewer (runId=${runId.slice(0, 8)}...)...`);

  const waitResponse = (await callGateway({
    method: "agent.wait",
    params: { runId, timeoutMs: waitTimeoutMs },
    timeoutMs: waitTimeoutMs + 5_000,
  })) as { status?: string; error?: string };

  if (waitResponse?.status !== "ok") {
    console.log(`[feedback-loop] Reviewer ${waitResponse?.status ?? "failed"}`);
    // Throw error to trigger fallback instead of returning failure
    throw new Error(
      `Reviewer ${waitResponse?.status ?? "failed"}: ${waitResponse?.error ?? "unknown error"}`,
    );
  }

  // Step 4: Read the reviewer's response from chat history
  const response = await readLatestAssistantReply({ sessionKey: childSessionKey });
  console.log(`[feedback-loop] Reviewer responded (${response?.length ?? 0} chars)`);

  // Step 5: Parse the response into structured ReviewResult
  return parseReviewerResponse(response, config);
}

const REVIEWER_SYSTEM_PROMPT = `You are the REVIEWER in an iterative feedback loop.

## YOUR TOOLS
You have access to:
- **browser tool**: navigate, click, fill forms, screenshot, check console
- **exec tool**: run shell commands (tests, lint, etc.)
- **file tools**: read files to understand the code

## YOUR JOB
VERIFY the coder's work actually works. Don't just read code - TEST IT.

Act like a senior QA engineer:
1. Actually navigate to the app in browser
2. Fill forms, click buttons, test the flow
3. Check different scenarios (not just happy path)
4. Look for obvious UI/UX issues
5. Check console for errors
6. Take screenshots of problems

## CRITICAL
- Test MULTIPLE scenarios, not just one
- Check EDGE CASES (empty inputs, wrong data, extreme values)
- Look for OBVIOUS issues a human would notice immediately
- Provide SPECIFIC feedback with file:line references

## RESPONSE FORMAT
Always respond with STRICT JSON in a code block:

If approved:
\`\`\`json
{
  "approved": true,
  "checks": [
    { "name": "typecheck", "passed": true, "evidence": "pnpm check passed" },
    { "name": "browser", "passed": true, "evidence": "No console/network errors on tested routes" }
  ],
  "issues": [],
  "artifacts": {
    "screenshots": ["/path/to/screenshot1.png", "/path/to/screenshot2.png"],
    "urlsTested": ["http://localhost:3000/app"],
    "commandSummaries": ["pnpm check passed"]
  },
  "summary": "All checks passed. [what you tested]"
}
\`\`\`

**IMPORTANT**: When approving, you MUST take screenshots as proof:
1. Use browser.screenshot() on the main feature page
2. Include the screenshot paths in your response
3. Screenshots are sent to the user as proof of verification

If issues found:
\`\`\`json
{
  "approved": false,
  "checks": [
    { "name": "browser", "passed": false, "evidence": "500 on /api/..." }
  ],
  "issues": [
    {
      "severity": "high",
      "category": "coverage",
      "file": "src/file.ts",
      "line": 45,
      "description": "Only tests math, not other subjects",
      "fix": "Add test cases for science, reading, writing"
    }
  ],
  "artifacts": {
    "screenshots": ["/path/to/failure.png"],
    "urlsTested": ["http://localhost:3000/app"]
  },
  "feedback": "Fix these issues:\\n- Issue 1\\n- Issue 2"
}
\`\`\``;

function buildReviewerPrompt(opts: {
  task: string;
  coderSummary: string;
  acceptanceCriteria?: string[];
  pastIssues?: string;
  checklist?: string;
  planContext?: string;
  projectContext?: string;
  workspaceDir: string;
}): string {
  const { task, coderSummary, acceptanceCriteria, pastIssues, checklist, planContext, projectContext, workspaceDir } = opts;

  let prompt = "";

  // Inject project context (AGENTS.md/CLAUDE.md) first - critical instructions
  if (projectContext) {
    prompt += `## PROJECT INSTRUCTIONS (FROM AGENTS.md/CLAUDE.md)\n${projectContext}\n\n`;
  }

  // Inject plan context (planning-with-files pattern: PreToolUse)
  if (planContext) {
    prompt += `${planContext}\n\n`;
  }

  prompt += `## REVIEW TASK

**Original Request:**
${task}

**What the Coder Did:**
${coderSummary}

**Workspace:** ${workspaceDir}

`;

  // Add past issues if available (from memory)
  if (pastIssues) {
    prompt += `## PAST ISSUES (Don't let these recur!)
${pastIssues}

`;
  }

  // Add project checklist if available
  if (checklist) {
    prompt += `## PROJECT QUALITY STANDARDS
${checklist}

`;
  }

  // Add acceptance criteria
  if (acceptanceCriteria && acceptanceCriteria.length > 0) {
    prompt += `## ACCEPTANCE CRITERIA TO VERIFY
${acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}

`;
  }

  // Auto-detect URLs from task and coder summary
  const urlsToTest = extractUrlsToTest(task, coderSummary, workspaceDir);

  prompt += `## URLS TO TEST (MANDATORY)
${urlsToTest.length > 0 ? urlsToTest.map(u => `- ${u.url}: ${u.expectation}`).join("\n") : "- http://localhost:3000 (main app)"}

**CRITICAL**: You MUST use the browser tool to navigate to these URLs and verify:
1. Page loads (not "Coming Soon" or error page)
2. Expected content/components are visible
3. No console errors
4. API calls succeed (check Network tab)

## YOUR TASK

1. **Start services first** - verify http://localhost:3000 AND http://localhost:8000 are accessible
   - If not running, tell coder to start them (DO NOT APPROVE if services are down)
2. **Use browser tool** to test EACH URL above:
   - Navigate to the URL
   - Check page title/content matches expectation
   - Check browser console for errors
   - Check network for failed requests
   - Take screenshot if there are issues
3. **Test functionality** (not just "page loads"):
   - Fill forms, click buttons
   - Test multiple scenarios (not just happy path)
   - Check edge cases (empty data, errors)
4. **Score** the work on functional, coverage, and UI/UX (1-5 scale)

**DO NOT APPROVE** if:
- Any URL shows "Coming Soon", 404, or error page
- Console has JavaScript errors
- API requests fail (network errors)
- Expected UI components are missing

Respond with structured JSON as specified in your system prompt.`;

  return prompt;
}

/**
 * Auto-detect URLs to test from task and coder summary
 */
function extractUrlsToTest(
  task: string,
  coderSummary: string,
  workspaceDir: string,
): Array<{ url: string; expectation: string }> {
  const urls: Array<{ url: string; expectation: string }> = [];
  const combined = `${task}\n${coderSummary}`;

  // Extract explicit URLs
  const urlMatches = combined.match(/https?:\/\/[^\s<>"']+/gi) || [];
  for (const url of urlMatches) {
    if (!urls.find(u => u.url === url)) {
      urls.push({ url, expectation: "Page loads without errors" });
    }
  }

  // Extract localhost paths
  const pathMatches = combined.match(/localhost:\d+\/[^\s<>"')]+/gi) || [];
  for (const path of pathMatches) {
    const url = `http://${path}`;
    if (!urls.find(u => u.url === url)) {
      urls.push({ url, expectation: "Page loads without errors" });
    }
  }

  // Extract route paths mentioned (e.g., "/test-scratchpad", "/api/health")
  const routeMatches = combined.match(/(?:at |page |route |endpoint |url )[`"']?\/([a-zA-Z0-9_\-/]+)/gi) || [];
  for (const match of routeMatches) {
    const routeMatch = match.match(/\/([a-zA-Z0-9_\-/]+)/);
    if (routeMatch) {
      const route = `/${routeMatch[1]}`;
      const url = `http://localhost:3000${route}`;
      if (!urls.find(u => u.url === url)) {
        urls.push({ url, expectation: `Route ${route} renders correctly` });
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
      if (!urls.find(u => u.url === url)) {
        urls.push({ url, expectation: `${pageName} page renders correctly` });
      }
    }
  }

  // Detect component test paths (e.g., ScratchpadTeacher -> test-scratchpad)
  const componentMatches = combined.match(/([A-Z][a-zA-Z]+)(?:\.tsx|Component|Page)/g) || [];
  for (const match of componentMatches) {
    const componentName = match.replace(/\.tsx|Component|Page/g, "");
    // Convert PascalCase to kebab-case for route
    const route = componentName.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    if (route.length > 3 && !["react", "index", "layout", "error"].includes(route)) {
      const url = `http://localhost:3000/test-${route}`;
      const appUrl = `http://localhost:3000/app`;
      if (!urls.find(u => u.url === url)) {
        urls.push({ url, expectation: `${componentName} test page renders the component` });
      }
      if (!urls.find(u => u.url === appUrl)) {
        urls.push({ url: appUrl, expectation: `Main app integrates ${componentName}` });
      }
    }
  }

  // Always add base URLs if we're in a frontend task
  if (/frontend|react|component|page|ui/i.test(combined)) {
    if (!urls.find(u => u.url.includes("localhost:3000"))) {
      urls.push({ url: "http://localhost:3000", expectation: "Frontend app loads" });
    }
  }

  // Always check API if backend mentioned
  if (/backend|api|endpoint|server/i.test(combined)) {
    urls.push({ url: "http://localhost:8000/health", expectation: "Backend API is healthy" });
  }

  return urls;
}

/**
 * Parse the reviewer's response into a structured ReviewResult
 */
type ReviewerParseGates = Required<
  Pick<
    FeedbackLoopGatesConfig,
    | "requireReviewerJson"
    | "requireAllCommandsPass"
    | "requireNoBrowserErrors"
    | "requireArtifactProof"
    | "blockApprovalOnParseFailure"
  >
>;

function resolveGateConfig(config?: FeedbackLoopConfig): ReviewerParseGates {
  return {
    requireReviewerJson: config?.gates?.requireReviewerJson ?? true,
    requireAllCommandsPass: config?.gates?.requireAllCommandsPass ?? true,
    requireNoBrowserErrors: config?.gates?.requireNoBrowserErrors ?? true,
    requireArtifactProof: config?.gates?.requireArtifactProof ?? true,
    blockApprovalOnParseFailure: config?.gates?.blockApprovalOnParseFailure ?? true,
  };
}

type ParsedIssue = {
  severity?: string;
  category?: string;
  file?: string;
  line?: number;
  description?: string;
  fix?: string;
};

type ParsedCheck = {
  name?: string;
  passed?: boolean;
  evidence?: string;
};

type ParsedArtifacts = {
  screenshots?: string[];
  urlsTested?: string[];
  commandSummaries?: string[];
};

type ParsedReviewerPayload = {
  approved: boolean;
  checks: ParsedCheck[];
  issues: ParsedIssue[];
  artifacts?: ParsedArtifacts;
  summary?: string;
  feedback?: string;
};

function extractReviewerJson(response: string): string | undefined {
  const fenced = response.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    return fenced[1];
  }
  const objectMatch = response.match(/\{[\s\S]*\}/);
  return objectMatch?.[0];
}

function normalizeReviewerPayload(payload: ParsedReviewerPayload): ReviewResult {
  const checks: CheckResult[] = payload.checks.map((check) => ({
    command: check.name ?? "review-check",
    name: check.name ?? "review-check",
    passed: check.passed === true,
    evidence: check.evidence,
    output: check.evidence,
  }));

  for (const issue of payload.issues) {
    checks.push({
      command: issue.category ? `${issue.category}: ${issue.description ?? "issue"}` : "review-issue",
      name: issue.category ?? "issue",
      passed: false,
      evidence: issue.fix,
      output: issue.fix,
      error: `${issue.file ?? "unknown"}:${issue.line ?? "?"} - ${issue.description ?? "issue"}`,
    });
  }

  const artifacts = payload.artifacts
    ? {
        screenshots: payload.artifacts.screenshots ?? [],
        urlsTested: payload.artifacts.urlsTested ?? [],
        commandSummaries: payload.artifacts.commandSummaries ?? [],
      }
    : undefined;

  return {
    approved: payload.approved,
    checks,
    issues: payload.issues,
    artifacts,
    feedback: payload.feedback ?? payload.summary,
    screenshots: artifacts?.screenshots,
    reviewerJsonValid: true,
  };
}

function validateReviewerPayload(value: unknown): ParsedReviewerPayload | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.approved !== "boolean") {
    return undefined;
  }
  if (!Array.isArray(payload.checks) || !Array.isArray(payload.issues)) {
    return undefined;
  }

  const checks: ParsedCheck[] = payload.checks
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const value = item as Record<string, unknown>;
      return {
        name: typeof value.name === "string" ? value.name : undefined,
        passed: typeof value.passed === "boolean" ? value.passed : false,
        evidence: typeof value.evidence === "string" ? value.evidence : undefined,
      };
    });

  const issues: ParsedIssue[] = payload.issues
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const value = item as Record<string, unknown>;
      return {
        severity: typeof value.severity === "string" ? value.severity : undefined,
        category: typeof value.category === "string" ? value.category : undefined,
        file: typeof value.file === "string" ? value.file : undefined,
        line: typeof value.line === "number" ? value.line : undefined,
        description: typeof value.description === "string" ? value.description : undefined,
        fix: typeof value.fix === "string" ? value.fix : undefined,
      };
    });

  const artifactsValue = payload.artifacts;
  let artifacts: ParsedArtifacts | undefined;
  if (artifactsValue && typeof artifactsValue === "object") {
    const value = artifactsValue as Record<string, unknown>;
    artifacts = {
      screenshots: Array.isArray(value.screenshots)
        ? value.screenshots.filter((item): item is string => typeof item === "string")
        : undefined,
      urlsTested: Array.isArray(value.urlsTested)
        ? value.urlsTested.filter((item): item is string => typeof item === "string")
        : undefined,
      commandSummaries: Array.isArray(value.commandSummaries)
        ? value.commandSummaries.filter((item): item is string => typeof item === "string")
        : undefined,
    };
  }

  return {
    approved: payload.approved,
    checks,
    issues,
    artifacts,
    summary: typeof payload.summary === "string" ? payload.summary : undefined,
    feedback: typeof payload.feedback === "string" ? payload.feedback : undefined,
  };
}

export function parseReviewerResponse(
  response: string | undefined,
  config?: FeedbackLoopConfig,
): ReviewResult {
  const gates = resolveGateConfig(config);
  if (!response) {
    return {
      approved: false,
      checks: [],
      feedback: "No response from reviewer",
      reviewerJsonValid: false,
    };
  }

  const raw = extractReviewerJson(response);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const normalized = validateReviewerPayload(parsed);
      if (normalized) {
        return normalizeReviewerPayload(normalized);
      }
      if (gates.requireReviewerJson || gates.blockApprovalOnParseFailure) {
        return {
          approved: false,
          checks: [],
          feedback: "Reviewer response JSON is invalid (missing required fields).",
          reviewerJsonValid: false,
        };
      }
    } catch {
      if (gates.requireReviewerJson || gates.blockApprovalOnParseFailure) {
        return {
          approved: false,
          checks: [],
          feedback: "Reviewer response was not valid JSON.",
          reviewerJsonValid: false,
        };
      }
    }
  } else if (gates.requireReviewerJson || gates.blockApprovalOnParseFailure) {
    return {
      approved: false,
      checks: [],
      feedback: "Reviewer response missing required JSON payload.",
      reviewerJsonValid: false,
    };
  }

  const lower = response.toLowerCase();
  const approved =
    lower.includes("approved") && !lower.includes("not approved") && !lower.includes("issues");

  return {
    approved,
    checks: [],
    feedback: response.slice(0, 2000),
    reviewerJsonValid: false,
  };
}

/**
 * Extended ReviewResult with optional score
 */
export type ExtendedReviewResult = ReviewResult & {
  score?: {
    functional?: number;
    coverage?: number;
    uiux?: number;
    educational?: number;
    codeQuality?: number;
  };
};
