import type { OpenClawPluginApi, AnyAgentTool, FeedbackLoopConfig } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { runFeedbackLoop } from "./orchestrator.js";

const FeedbackLoopToolSchema = Type.Object({
  task: Type.String({
    description: "The coding task to complete via the feedback loop",
  }),
  maxIterations: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 20,
      description: "Maximum iterations before stopping (default: 5)",
    }),
  ),
});

/**
 * Create the feedback_loop tool for manual invocation.
 * This tool starts the Codex↔Claude feedback loop.
 */
export function createFeedbackLoopTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "feedback_loop",
    label: "Feedback Loop",
    description: `Start an iterative feedback loop where Codex writes code and Claude verifies.
The loop continues until Claude approves or max iterations are reached.
User can watch the exchange in terminal and intervene with hotkeys.`,
    parameters: FeedbackLoopToolSchema,
    execute: async (_toolCallId, args, context) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const maxIterationsOverride =
        typeof params.maxIterations === "number" ? params.maxIterations : undefined;

      // Get config
      const config = getFeedbackLoopConfig(api);
      if (!config) {
        return jsonResult({
          status: "error",
          error: "Feedback loop not configured. Add feedbackLoop config to agents.defaults.",
        });
      }

      // Apply override
      const effectiveConfig: FeedbackLoopConfig = {
        ...config,
        maxIterations: maxIterationsOverride ?? config.maxIterations ?? 5,
      };

      // Get context info
      const agentId = context?.agentId ?? "main";
      const sessionKey = context?.sessionKey ?? `agent:${agentId}:main`;
      const workspaceDir = resolveWorkspaceDir({
        contextWorkspace: context?.workspaceDir,
        configuredWorkspace: api.config.agents?.defaults?.workspace,
      });

      console.log(`[feedback-loop] Starting loop for task: ${task.slice(0, 50)}...`);

      try {
        const result = await runFeedbackLoop(api, task, effectiveConfig, {
          agentId,
          sessionKey,
          workspaceDir,
          // User input handling would be set up by the CLI/terminal
          onUserInput: undefined,
        });

        return jsonResult({
          status: result.approved ? "approved" : "stopped",
          iterations: result.iterations,
          approved: result.approved,
          message: result.finalMessage,
          history: result.history.map((h) => ({
            iteration: h.iteration,
            coderSummary: h.coderSummary,
            approved: h.reviewResult.approved,
            target: h.reviewResult.target,
            runtime: h.reviewResult.runtime,
            mediaMetrics: h.reviewResult.mediaMetrics,
            toolCalls: h.reviewResult.toolCalls,
            checks: h.reviewResult.checks.map((c) => ({
              command: c.command,
              passed: c.passed,
              evidence: c.evidence,
            })),
            artifacts: h.reviewResult.artifacts,
          })),
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: "error",
          error,
        });
      }
    },
  };
}

function resolveWorkspaceDir(params: {
  contextWorkspace?: string;
  configuredWorkspace?: string;
}): string {
  const candidates = [params.contextWorkspace, params.configuredWorkspace, process.cwd()]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const gitRoot = findGitRoot(candidate);
    if (gitRoot) {
      return gitRoot;
    }
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  return process.cwd();
}

function findGitRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

/**
 * Get the feedback loop config from the plugin config or agent defaults
 */
function getFeedbackLoopConfig(api: OpenClawPluginApi): FeedbackLoopConfig | undefined {
  // Try plugin config first
  const pluginConfig = api.pluginConfig as FeedbackLoopConfig | undefined;
  if (pluginConfig?.enabled !== false && pluginConfig?.coder && pluginConfig?.reviewer) {
    return pluginConfig;
  }

  // Fall back to agent defaults
  return api.config.agents?.defaults?.feedbackLoop;
}
