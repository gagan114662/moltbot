import crypto from "node:crypto";

import type { FeedbackLoopConfig } from "openclaw/plugin-sdk";
import { callGateway, AGENT_LANE_SUBAGENT, readLatestAssistantReply } from "openclaw/plugin-sdk";

export type AcceptanceCriteriaContext = {
  task: string;
  config: FeedbackLoopConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
  checklist?: string;
};

/**
 * Generate acceptance criteria BEFORE the coder starts.
 * This ensures we have concrete, testable criteria for the reviewer.
 */
export async function generateAcceptanceCriteria(
  opts: AcceptanceCriteriaContext,
): Promise<string[]> {
  const { task, config, agentId, sessionKey, workspaceDir, checklist } = opts;

  // If acceptance criteria are already in config, use those
  if (config.acceptanceCriteria && config.acceptanceCriteria.length > 0) {
    console.log(`[feedback-loop] Using ${config.acceptanceCriteria.length} pre-configured acceptance criteria`);
    return config.acceptanceCriteria;
  }

  // If generation is disabled, return empty
  if (config.generateAcceptanceCriteria === false) {
    console.log(`[feedback-loop] Acceptance criteria generation disabled`);
    return [];
  }

  console.log(`[feedback-loop] Generating acceptance criteria for task...`);

  const prompt = buildCriteriaPrompt(task, workspaceDir, checklist);
  const reviewerModel = config.reviewer ?? "anthropic/claude-sonnet-4-5";
  const childSessionKey = `agent:${agentId}:criteria:${crypto.randomUUID()}`;
  const stepIdem = crypto.randomUUID();

  try {
    // Set model
    await callGateway({
      method: "sessions.patch",
      params: { key: childSessionKey, model: reviewerModel },
      timeoutMs: 10_000,
    });

    // Spawn criteria generator
    const spawnResponse = await callGateway({
      method: "agent",
      params: {
        message: prompt,
        sessionKey: childSessionKey,
        idempotencyKey: stepIdem,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: CRITERIA_SYSTEM_PROMPT,
        spawnedBy: sessionKey,
        label: "feedback-loop-criteria",
      },
      timeoutMs: 10_000,
    }) as { runId?: string };

    const runId = spawnResponse?.runId || stepIdem;

    // Wait for response (shorter timeout - this is just analysis)
    const waitTimeoutMs = 120_000; // 2 minutes max
    const waitResponse = await callGateway({
      method: "agent.wait",
      params: { runId, timeoutMs: waitTimeoutMs },
      timeoutMs: waitTimeoutMs + 5_000,
    }) as { status?: string; error?: string };

    if (waitResponse?.status !== "ok") {
      console.log(`[feedback-loop] Criteria generation failed, using defaults`);
      return generateDefaultCriteria(task);
    }

    // Read response
    const response = await readLatestAssistantReply({ sessionKey: childSessionKey });

    // Parse criteria from response
    const criteria = parseCriteriaResponse(response);
    console.log(`[feedback-loop] Generated ${criteria.length} acceptance criteria`);

    return criteria.length > 0 ? criteria : generateDefaultCriteria(task);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`[feedback-loop] Criteria generation error: ${error}`);
    return generateDefaultCriteria(task);
  }
}

const CRITERIA_SYSTEM_PROMPT = `You are a senior QA engineer defining acceptance criteria.

Your job is to analyze a task and generate SPECIFIC, TESTABLE acceptance criteria.

## RULES
1. Each criterion must be TESTABLE (can verify pass/fail)
2. Include EDGE CASES (empty inputs, wrong data, extreme values)
3. Include UI/UX criteria if applicable
4. Include performance criteria if applicable
5. Be SPECIFIC - not "works correctly" but "returns 200 with {status: 'ok'}"

## OUTPUT FORMAT
Return a JSON array of criteria strings:

\`\`\`json
[
  "User can start assessment without authentication (DEV_MODE)",
  "Assessment supports 5+ subjects: math, science, reading, writing, history",
  "Assessment supports 3+ age ranges: 6-8, 8-10, 10-12",
  "Wrong answer displays helpful feedback explaining the correct answer",
  "Questions pre-generate (2-3 ahead of current question)",
  "No JavaScript console errors during assessment flow",
  "Page loads in under 2 seconds",
  "UI has consistent spacing (16px standard padding)",
  "All interactive elements have hover states"
]
\`\`\``;

function buildCriteriaPrompt(task: string, workspaceDir: string, checklist?: string): string {
  let prompt = `## TASK TO ANALYZE

${task}

**Workspace:** ${workspaceDir}

`;

  if (checklist) {
    prompt += `## PROJECT QUALITY STANDARDS (for reference)
${checklist}

`;
  }

  prompt += `## YOUR TASK

Generate acceptance criteria for this task. Think about:
1. What must work for the feature to be "done"?
2. What edge cases should be tested?
3. What could go wrong that a tester should check?
4. What UI/UX qualities should be verified?
5. What performance expectations exist?

Return your criteria as a JSON array of strings in a code block.`;

  return prompt;
}

/**
 * Parse criteria from the agent's response
 */
function parseCriteriaResponse(response: string | undefined): string[] {
  if (!response) {
    return [];
  }

  // Try to extract JSON array from response
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) {
        return parsed.filter((c): c is string => typeof c === "string");
      }
    } catch {
      // Fall through to line parsing
    }
  }

  // Fallback: parse lines starting with - or * or numbers
  const lines = response.split("\n");
  const criteria: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Match: - criterion, * criterion, 1. criterion, [ ] criterion
    const match = trimmed.match(/^(?:[-*]|\d+\.|\[[ x]\])\s*(.+)$/i);
    if (match && match[1]) {
      criteria.push(match[1].trim());
    }
  }

  return criteria;
}

/**
 * Generate default criteria based on the task description
 */
function generateDefaultCriteria(task: string): string[] {
  const criteria: string[] = [
    "Feature works end-to-end without errors",
    "No JavaScript console errors",
    "No failed network requests",
    "UI is functional and usable",
  ];

  // Add task-specific defaults based on keywords
  const lower = task.toLowerCase();

  if (lower.includes("assessment") || lower.includes("quiz") || lower.includes("test")) {
    criteria.push(
      "Questions display correctly",
      "Answers can be submitted",
      "Score is calculated correctly",
      "Multiple question types work",
    );
  }

  if (lower.includes("auth") || lower.includes("login") || lower.includes("user")) {
    criteria.push(
      "Authentication flow completes",
      "Error messages are helpful",
      "Session persists correctly",
    );
  }

  if (lower.includes("api") || lower.includes("endpoint")) {
    criteria.push(
      "API returns correct status codes",
      "Response format matches spec",
      "Error handling works",
    );
  }

  if (lower.includes("ui") || lower.includes("design") || lower.includes("frontend")) {
    criteria.push(
      "Spacing is consistent",
      "Colors match design system",
      "Interactive elements have hover states",
      "Mobile responsive (if applicable)",
    );
  }

  return criteria;
}
