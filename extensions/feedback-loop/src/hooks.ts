import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import type { FeedbackLoopConfig } from "../../../src/config/types.agent-defaults.js";

import { loadLearnedRules } from "./self-correction.js";
import { checkCodeQuality, formatQualityReport, EditTracker } from "./quality-gate.js";

const CODING_TASK_PATTERNS = [
  /\b(fix|debug|resolve|patch)\b.*\b(bug|error|issue|crash|problem)/i,
  /\b(add|create|implement|build|make|write)\b.*\b(feature|function|component|endpoint|api|page|form|button|modal)/i,
  /\b(update|modify|change|edit|refactor)\b.*\b(code|file|component|function|class|module)/i,
  /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|vue|svelte)\b/i,
  /\b(frontend|backend|server|client|api|database|db)\b/i,
];

const NON_CODING_PATTERNS = [
  /^(what|where|how|why|when|who|which|can you|could you|do you)\b.*\?$/i,
  /\b(explain|describe|tell me|show me|list|find)\b/i,
  /\b(status|check|verify|confirm|look at|review)\b(?!.*\b(fix|update|change)\b)/i,
  /\b(readme|documentation|docs|changelog)\b/i,
];

function isCodingTask(message: string): { isCoding: boolean; confidence: number; reason: string } {
  const trimmed = message.trim();
  if (trimmed.length < 15) {
    return { isCoding: false, confidence: 0.9, reason: "Message too short" };
  }

  for (const pattern of NON_CODING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { isCoding: false, confidence: 0.8, reason: `Matches non-coding pattern: ${pattern.source.slice(0, 30)}` };
    }
  }

  let matchCount = 0;
  for (const pattern of CODING_TASK_PATTERNS) {
    if (pattern.test(trimmed)) {
      matchCount += 1;
    }
  }

  if (matchCount >= 2) {
    return { isCoding: true, confidence: 0.9, reason: `Matches ${matchCount} coding patterns` };
  }
  if (matchCount === 1 && trimmed.length > 30) {
    return { isCoding: true, confidence: 0.7, reason: "Single coding pattern with sufficient context" };
  }
  return { isCoding: false, confidence: 0.5, reason: "No coding patterns detected" };
}

export function registerFeedbackLoopHooks(api: OpenClawPluginApi) {
  console.log("[feedback-loop] Registering hooks...");
  const editTracker = new EditTracker();

  api.on(
    "before_agent_start",
    async (event, ctx) => {
      const config = getFeedbackLoopConfig(api) as FeedbackLoopHookConfig | undefined;
      if (!config?.enabled) {
        return;
      }

      const sessionKey = ctx.sessionKey ?? "";
      if (sessionKey.includes(":coder:")) {
        return {
          prependContext: `[FEEDBACK LOOP - CODER MODE]
You are the CODER in an iterative feedback loop.
- Write code to complete the task.
- The REVIEWER will verify your work.
- Focus on correct implementation.
- Do NOT run tests yourself.`,
        };
      }
      if (sessionKey.includes(":reviewer:")) {
        return {
          prependContext: `[FEEDBACK LOOP - REVIEWER MODE]
You are the REVIEWER in an iterative feedback loop.
- Verify with deterministic checks.
- Provide actionable feedback with concrete evidence.
- Approve only when all required checks pass.`,
        };
      }
      if (sessionKey.includes(":feedback-loop:") || sessionKey.includes(":subagent:")) {
        return;
      }

      const autoTrigger = config.autoTrigger ?? { enabled: false };
      const latestUserMessage = Array.isArray(event.messages)
        ? [...event.messages]
            .toReversed()
            .find((message) => {
              if (!message || typeof message !== "object") {
                return false;
              }
              const role = (message as { role?: unknown }).role;
              return role === "user";
            })
        : undefined;
      const userMessage =
        latestUserMessage && typeof latestUserMessage === "object"
          ? readMessageText(latestUserMessage as Record<string, unknown>)
          : "";
      if (autoTrigger.enabled && userMessage) {
        const detection = isCodingTask(userMessage);
        const threshold = autoTrigger.confidenceThreshold ?? 0.7;
        console.log(
          `[feedback-loop] Task detection: coding=${detection.isCoding}, confidence=${detection.confidence}, reason="${detection.reason}"`,
        );
        if (detection.isCoding && detection.confidence >= threshold) {
          return {
            prependContext: `[AUTO-TRIGGER: CODING TASK DETECTED]
This looks like a coding task.
Prefer the feedback_loop tool first for deterministic coding + review gates:

feedback_loop({ task: ${JSON.stringify(userMessage)} })

If the request is not actually a coding change, explain briefly and continue normally.`,
          };
        }
      }

      return {
        prependContext: `[FEEDBACK LOOP AVAILABLE]
Use the feedback_loop tool for multi-step coding tasks that require autonomous implementation + verification.
For non-coding or quick informational requests, respond normally without invoking the loop.`,
      };
    },
    { priority: 100 },
  );

  api.on(
    "agent_end",
    async (_event, ctx) => {
      const config = getFeedbackLoopConfig(api) as FeedbackLoopHookConfig | undefined;
      if (!config?.enabled) {
        return;
      }
      const sessionKey = ctx.sessionKey ?? "";
      if (sessionKey.includes(":feedback-loop:")) {
        return;
      }
      console.log(`[feedback-loop] agent_end hook triggered for ${sessionKey}`);
    },
    { priority: 50 },
  );

  api.on(
    "before_tool_call",
    async (event) => {
      const config = getFeedbackLoopConfig(api);
      if (!config?.enabled) {
        return;
      }
      if (["edit", "write", "apply_patch"].includes(event.toolName.toLowerCase())) {
        editTracker.recordEdit();
        if (editTracker.shouldRemind()) {
          console.log(`[feedback-loop] ${editTracker.getReminderMessage()}`);
        }
      }
    },
    { priority: 40 },
  );

  api.on(
    "after_tool_call",
    async (event) => {
      const config = getFeedbackLoopConfig(api);
      if (!config?.enabled) {
        return;
      }
      const tool = event.toolName.toLowerCase();
      if (!["edit", "write"].includes(tool)) {
        return;
      }
      const filePath = typeof event.params.file_path === "string" ? event.params.file_path : "";
      if (!filePath || !/\.(ts|tsx|js|jsx|py)$/.test(filePath)) {
        return;
      }
      const content = typeof event.result === "string" ? event.result : "";
      const quality = checkCodeQuality(content, filePath);
      if (quality.issues.length > 0) {
        console.log(`[feedback-loop] Quality check:\n${formatQualityReport([quality])}`);
      }
    },
    { priority: 40 },
  );

  api.on(
    "session_start",
    async () => {
      const config = getFeedbackLoopConfig(api);
      if (!config?.enabled) {
        return;
      }
      const workspaceDir = api.config.agents?.defaults?.workspace ?? process.cwd();
      const learnedPath = `${workspaceDir}/memory/LEARNED.md`;
      try {
        const rules = await loadLearnedRules(learnedPath);
        if (rules.length > 0) {
          console.log(`[feedback-loop] Loaded ${rules.length} learned rules from previous sessions`);
        }
      } catch {
        // No learned rules yet.
      }
    },
    { priority: 30 },
  );

  console.log("[feedback-loop] Hooks registered");
}

function getFeedbackLoopConfig(api: OpenClawPluginApi): FeedbackLoopConfig | undefined {
  const pluginConfig = api.pluginConfig as FeedbackLoopConfig | undefined;
  if (pluginConfig) {
    return pluginConfig;
  }
  return api.config.agents?.defaults?.feedbackLoop;
}

export type FeedbackLoopAutoTriggerConfig = {
  enabled?: boolean;
  confidenceThreshold?: number;
  additionalPatterns?: string[];
  excludePatterns?: string[];
  channels?: string[];
  minLength?: number;
};

export type FeedbackLoopHookConfig = FeedbackLoopConfig & {
  skipSubagents?: boolean;
  autoTrigger?: FeedbackLoopAutoTriggerConfig;
};

function readMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n")
    .trim();
}
