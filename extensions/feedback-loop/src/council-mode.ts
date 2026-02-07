/**
 * Council Mode - Multi-LLM Swarm with Chair Synthesis
 *
 * Inspired by Andrej Karpathy's LLM Council pattern where multiple frontier LLMs
 * reason about a problem in parallel, and a "chair" LLM synthesizes their
 * perspectives into a more accurate answer.
 *
 * Key benefits:
 * - Diverse perspectives from different model architectures
 * - Peer review catches hallucinations and blind spots
 * - Chair synthesis provides high-confidence answers
 * - Parallel execution minimizes latency
 */

import type { CouncilConfig, CouncilMemberConfig } from "openclaw/plugin-sdk";
import crypto from "node:crypto";
import { callGateway, readLatestAssistantReply, AGENT_LANE_SUBAGENT } from "openclaw/plugin-sdk";

// ============================================
// TYPES
// ============================================

export type CouncilMember = {
  id: string;
  model: string;
  role?: string;
  systemPrompt?: string;
};

export type CouncilMemberResponse = {
  memberId: string;
  model: string;
  role?: string;
  response: string;
  durationMs: number;
  error?: string;
};

export type CouncilResult = {
  ok: boolean;
  synthesis: string;
  confidence: "high" | "medium" | "low";
  memberResponses: CouncilMemberResponse[];
  agreements: string[];
  disagreements: string[];
  minorityViews: string[];
  chairDurationMs: number;
  totalDurationMs: number;
};

// ============================================
// DEFAULT CONFIGURATION
// ============================================

export const DEFAULT_COUNCIL_MEMBERS: CouncilMember[] = [
  {
    id: "claude",
    model: "anthropic/claude-opus-4-5",
    role: "analytical",
    systemPrompt: `You are the analytical voice on a council of AI experts.
Your approach: Break down problems systematically, identify assumptions, evaluate evidence.
Focus on: Logic, structure, edge cases, potential failure modes.
Be thorough but concise.`,
  },
  {
    id: "gpt",
    model: "openai/gpt-5.2",
    role: "creative",
    systemPrompt: `You are the creative voice on a council of AI experts.
Your approach: Think laterally, propose novel solutions, challenge conventional wisdom.
Focus on: Innovation, alternative approaches, unexplored possibilities.
Be imaginative but practical.`,
  },
  {
    id: "gemini",
    model: "google-antigravity/gemini-3-pro",
    role: "systematic",
    systemPrompt: `You are the systematic voice on a council of AI experts.
Your approach: Consider the full system, dependencies, and long-term implications.
Focus on: Architecture, scalability, maintainability, best practices.
Be comprehensive but focused.`,
  },
];

export const DEFAULT_CHAIR_MODEL = "anthropic/claude-opus-4-5";

export const DEFAULT_SYNTHESIS_PROMPT = `You are the chair of a council of AI experts.
You have received responses from multiple frontier LLMs on the same query.

Your task:
1. Identify areas of agreement (high confidence)
2. Identify areas of disagreement (need nuance)
3. Synthesize the best answer, weighing each perspective
4. Note any minority opinions worth considering
5. Provide a confidence level for your synthesis

Format your response EXACTLY as:

## Synthesis
[Your synthesized answer - this is the main response]

## Confidence
[High/Medium/Low] - [Brief reason]

## Council Notes
**Agreements:** [Key points all members agreed on]
**Disagreements:** [Points of contention and how you resolved them]
**Notable minority view:** [Any valuable perspective from one member, or "None"]`;

// ============================================
// CORE COUNCIL EXECUTION
// ============================================

/**
 * Run a council deliberation on a query
 */
export async function runCouncil(
  query: string,
  config: CouncilConfig,
  context?: { workspaceDir?: string; sessionKey?: string },
): Promise<CouncilResult> {
  const startTime = Date.now();
  const sessionId = crypto.randomUUID().slice(0, 8);

  console.log(`[council-mode] Starting council deliberation (session: ${sessionId})`);
  console.log(`[council-mode] Query: ${query.slice(0, 100)}${query.length > 100 ? "..." : ""}`);

  // Resolve members from config or use defaults
  const members = resolveMembers(config.members);
  const chairModel = config.chair ?? DEFAULT_CHAIR_MODEL;
  const timeoutMs = config.memberTimeoutMs ?? 60_000;
  const requireAll = config.requireAllResponses ?? false;

  console.log(`[council-mode] Council members: ${members.map((m) => m.id).join(", ")}`);
  console.log(`[council-mode] Chair: ${chairModel}`);

  // Phase 1: Run all council members in parallel
  console.log(`[council-mode] Phase 1: Gathering perspectives from ${members.length} members...`);
  const memberResponses = await runCouncilMembers(query, members, timeoutMs, sessionId, context);

  // Check if we have enough responses
  const successfulResponses = memberResponses.filter((r) => !r.error);
  if (requireAll && successfulResponses.length < members.length) {
    const failedMembers = memberResponses.filter((r) => r.error).map((r) => r.memberId);
    return {
      ok: false,
      synthesis: `Council deliberation failed: required all members but ${failedMembers.join(", ")} failed.`,
      confidence: "low",
      memberResponses,
      agreements: [],
      disagreements: [],
      minorityViews: [],
      chairDurationMs: 0,
      totalDurationMs: Date.now() - startTime,
    };
  }

  if (successfulResponses.length === 0) {
    return {
      ok: false,
      synthesis: "Council deliberation failed: no members responded successfully.",
      confidence: "low",
      memberResponses,
      agreements: [],
      disagreements: [],
      minorityViews: [],
      chairDurationMs: 0,
      totalDurationMs: Date.now() - startTime,
    };
  }

  // Phase 2: Chair synthesizes the responses
  console.log(
    `[council-mode] Phase 2: Chair synthesizing ${successfulResponses.length} responses...`,
  );
  const chairResult = await runChairSynthesis(
    query,
    successfulResponses,
    chairModel,
    config.synthesisPrompt,
    sessionId,
    context,
  );

  // Parse the chair's response
  const parsed = parseChairResponse(chairResult.synthesis);

  const totalDurationMs = Date.now() - startTime;
  console.log(
    `[council-mode] Council complete in ${totalDurationMs}ms (chair: ${chairResult.durationMs}ms)`,
  );

  return {
    ok: true,
    synthesis: parsed.synthesis,
    confidence: parsed.confidence,
    memberResponses,
    agreements: parsed.agreements,
    disagreements: parsed.disagreements,
    minorityViews: parsed.minorityViews,
    chairDurationMs: chairResult.durationMs,
    totalDurationMs,
  };
}

// ============================================
// MEMBER EXECUTION
// ============================================

/**
 * Run all council members in parallel
 */
async function runCouncilMembers(
  query: string,
  members: CouncilMember[],
  timeoutMs: number,
  sessionId: string,
  context?: { workspaceDir?: string; sessionKey?: string },
): Promise<CouncilMemberResponse[]> {
  const startTime = Date.now();

  const memberPromises = members.map(async (member) => {
    const memberStart = Date.now();
    try {
      const response = await runSingleMember(query, member, timeoutMs, sessionId, context);
      return {
        memberId: member.id,
        model: member.model,
        role: member.role,
        response,
        durationMs: Date.now() - memberStart,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`[council-mode] Member ${member.id} failed: ${error}`);
      return {
        memberId: member.id,
        model: member.model,
        role: member.role,
        response: "",
        durationMs: Date.now() - memberStart,
        error,
      };
    }
  });

  const results = await Promise.all(memberPromises);
  console.log(`[council-mode] All members responded in ${Date.now() - startTime}ms`);

  return results;
}

/**
 * Run a single council member
 */
async function runSingleMember(
  query: string,
  member: CouncilMember,
  timeoutMs: number,
  sessionId: string,
  _context?: { workspaceDir?: string; sessionKey?: string },
): Promise<string> {
  const childSessionKey = `council:${sessionId}:member:${member.id}:${crypto.randomUUID().slice(0, 8)}`;

  // Build the member prompt with role context
  const roleContext = member.role
    ? `You are responding as the "${member.role}" perspective on a council of AI experts.`
    : "";

  const memberPrompt = `${roleContext}

${member.systemPrompt || ""}

## Query
${query}

## Instructions
Provide your perspective on this query. Be thorough but concise.
Your response will be reviewed alongside other AI perspectives.
Focus on your unique angle (${member.role || "general"}) while being practical.`;

  try {
    // Set the model for this session
    await callGateway({
      method: "sessions.patch",
      params: { key: childSessionKey, model: member.model },
      timeoutMs: 10_000,
    });

    // Spawn the member agent
    const spawnResponse = (await callGateway({
      method: "agent",
      params: {
        message: memberPrompt,
        sessionKey: childSessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: member.systemPrompt,
        label: `council-member-${member.id}`,
      },
      timeoutMs: 10_000,
    })) as { runId?: string };

    const runId = spawnResponse?.runId || crypto.randomUUID();

    // Wait for completion
    const waitResponse = (await callGateway({
      method: "agent.wait",
      params: { runId, timeoutMs },
      timeoutMs: timeoutMs + 5_000,
    })) as { status?: string; error?: string };

    if (waitResponse?.status !== "ok") {
      throw new Error(waitResponse?.error || "Member failed to respond");
    }

    // Read the response
    const response = await readLatestAssistantReply({ sessionKey: childSessionKey });
    return response || "No response";
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    throw new Error(`Member ${member.id} (${member.model}): ${error}`, { cause: err });
  }
}

// ============================================
// CHAIR SYNTHESIS
// ============================================

/**
 * Run the chair synthesis
 */
async function runChairSynthesis(
  query: string,
  memberResponses: CouncilMemberResponse[],
  chairModel: string,
  customSynthesisPrompt?: string,
  sessionId?: string,
  _context?: { workspaceDir?: string; sessionKey?: string },
): Promise<{ synthesis: string; durationMs: number }> {
  const startTime = Date.now();
  const childSessionKey = `council:${sessionId || crypto.randomUUID().slice(0, 8)}:chair:${crypto.randomUUID().slice(0, 8)}`;

  // Build the chair prompt with all member responses
  const chairPrompt = buildChairPrompt(query, memberResponses, customSynthesisPrompt);

  try {
    // Set the model for this session
    await callGateway({
      method: "sessions.patch",
      params: { key: childSessionKey, model: chairModel },
      timeoutMs: 10_000,
    });

    // Spawn the chair agent
    const spawnResponse = (await callGateway({
      method: "agent",
      params: {
        message: chairPrompt,
        sessionKey: childSessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        label: "council-chair",
      },
      timeoutMs: 10_000,
    })) as { runId?: string };

    const runId = spawnResponse?.runId || crypto.randomUUID();

    // Wait for completion (chair gets more time for synthesis)
    const chairTimeoutMs = 120_000;
    const waitResponse = (await callGateway({
      method: "agent.wait",
      params: { runId, timeoutMs: chairTimeoutMs },
      timeoutMs: chairTimeoutMs + 5_000,
    })) as { status?: string; error?: string };

    if (waitResponse?.status !== "ok") {
      throw new Error(waitResponse?.error || "Chair failed to synthesize");
    }

    // Read the response
    const response = await readLatestAssistantReply({ sessionKey: childSessionKey });

    return {
      synthesis: response || "Chair synthesis failed",
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      synthesis: `Chair synthesis error: ${error}`,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Build the prompt for the chair
 */
function buildChairPrompt(
  query: string,
  memberResponses: CouncilMemberResponse[],
  customSynthesisPrompt?: string,
): string {
  const synthesisPrompt = customSynthesisPrompt || DEFAULT_SYNTHESIS_PROMPT;

  // Anonymize responses with random IDs (A, B, C, D) for objective evaluation
  const shuffled = [...memberResponses].toSorted(() => Math.random() - 0.5);
  const labels = ["A", "B", "C", "D", "E", "F", "G", "H"];

  const responsesSection = shuffled
    .map((r, i) => {
      const label = labels[i] || `Member ${i + 1}`;
      const roleHint = r.role ? ` (${r.role} perspective)` : "";
      return `### Response ${label}${roleHint}
${r.response}`;
    })
    .join("\n\n");

  // Include a mapping for transparency (after synthesis)
  const mapping = shuffled.map((r, i) => `${labels[i]}: ${r.memberId} (${r.model})`).join(", ");

  return `${synthesisPrompt}

## Original Query
${query}

## Council Responses
${responsesSection}

---
*Response mapping (for reference): ${mapping}*`;
}

// ============================================
// RESPONSE PARSING
// ============================================

/**
 * Parse the chair's structured response
 */
function parseChairResponse(raw: string): {
  synthesis: string;
  confidence: "high" | "medium" | "low";
  agreements: string[];
  disagreements: string[];
  minorityViews: string[];
} {
  // Extract synthesis section
  const synthesisMatch = raw.match(
    /## Synthesis\s*([\s\S]*?)(?=## Confidence|## Council Notes|$)/i,
  );
  const synthesis = synthesisMatch?.[1]?.trim() || raw;

  // Extract confidence
  const confidenceMatch = raw.match(/## Confidence\s*\n?\s*\*?\*?(High|Medium|Low)/i);
  const confidenceRaw = confidenceMatch?.[1]?.toLowerCase() || "medium";
  const confidence = (
    ["high", "medium", "low"].includes(confidenceRaw) ? confidenceRaw : "medium"
  ) as "high" | "medium" | "low";

  // Extract council notes
  const agreementsMatch = raw.match(/\*?\*?Agreements:?\*?\*?\s*([^\n*]+)/i);
  const disagreementsMatch = raw.match(/\*?\*?Disagreements:?\*?\*?\s*([^\n*]+)/i);
  const minorityMatch = raw.match(/\*?\*?(?:Notable )?minority view:?\*?\*?\s*([^\n*]+)/i);

  const agreements = agreementsMatch?.[1]
    ? agreementsMatch[1]
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const disagreements = disagreementsMatch?.[1]
    ? disagreementsMatch[1]
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const minorityViews =
    minorityMatch?.[1] && !minorityMatch[1].toLowerCase().includes("none")
      ? [minorityMatch[1].trim()]
      : [];

  return {
    synthesis,
    confidence,
    agreements,
    disagreements,
    minorityViews,
  };
}

// ============================================
// HELPERS
// ============================================

/**
 * Resolve members from config or use defaults
 */
function resolveMembers(configMembers?: CouncilMemberConfig[]): CouncilMember[] {
  if (!configMembers || configMembers.length === 0) {
    return DEFAULT_COUNCIL_MEMBERS;
  }

  return configMembers.map((m) => ({
    id: m.id,
    model: m.model,
    role: m.role,
    systemPrompt: m.systemPrompt,
  }));
}

// ============================================
// AUTO-TRIGGER DETECTION
// ============================================

/**
 * Estimate query complexity for auto-trigger
 */
export function estimateQueryComplexity(query: string): number {
  let score = 0;

  // Length of query
  if (query.length > 200) {
    score += 0.2;
  }
  if (query.length > 500) {
    score += 0.1;
  }

  // Trade-off/comparison language
  if (/trade.?off|compare|versus|vs\.|debate|pros.+cons/i.test(query)) {
    score += 0.3;
  }

  // Multiple questions
  const questionCount = (query.match(/\?/g) || []).length;
  if (questionCount > 1) {
    score += 0.2;
  }
  if (questionCount > 3) {
    score += 0.1;
  }

  // Opinion/recommendation seeking
  if (/should|best|recommend|advise|opinion|which/i.test(query)) {
    score += 0.2;
  }

  // Architectural/strategic topics
  if (/architecture|design|strategy|approach|pattern|framework/i.test(query)) {
    score += 0.1;
  }

  // Technical depth indicators
  if (/scalab|performance|security|reliab|maintain/i.test(query)) {
    score += 0.1;
  }

  // Philosophical/abstract
  if (/future|long.?term|evolv|transform|paradigm/i.test(query)) {
    score += 0.1;
  }

  return Math.min(1, score);
}

/**
 * Check if council should auto-trigger for this query
 */
export function shouldAutoTriggerCouncil(query: string, config: CouncilConfig): boolean {
  if (!config.autoTrigger) {
    return false;
  }

  const complexity = estimateQueryComplexity(query);
  const threshold = config.complexityThreshold ?? 0.8;

  const shouldTrigger = complexity >= threshold;

  if (shouldTrigger) {
    console.log(
      `[council-mode] Auto-trigger: complexity ${complexity.toFixed(2)} >= threshold ${threshold}`,
    );
  }

  return shouldTrigger;
}

// ============================================
// FORMATTING
// ============================================

/**
 * Format council result for display
 */
export function formatCouncilResult(result: CouncilResult): string {
  const lines: string[] = [];

  lines.push("## Council Synthesis");
  lines.push("");
  lines.push(result.synthesis);
  lines.push("");
  lines.push(`**Confidence:** ${result.confidence.toUpperCase()}`);
  lines.push("");

  if (result.agreements.length > 0) {
    lines.push("### Points of Agreement");
    for (const point of result.agreements) {
      lines.push(`- ${point}`);
    }
    lines.push("");
  }

  if (result.disagreements.length > 0) {
    lines.push("### Points of Disagreement");
    for (const point of result.disagreements) {
      lines.push(`- ${point}`);
    }
    lines.push("");
  }

  if (result.minorityViews.length > 0) {
    lines.push("### Notable Minority Views");
    for (const view of result.minorityViews) {
      lines.push(`- ${view}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    `*Council: ${result.memberResponses.length} members | Total time: ${(result.totalDurationMs / 1000).toFixed(1)}s*`,
  );

  return lines.join("\n");
}
