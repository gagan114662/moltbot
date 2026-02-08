/**
 * /work command handler — triggers the copilot autonomous worker from chat.
 *
 * Usage:
 *   /work <task>    — Start an autonomous coding task
 *   /work stop      — Stop the running task
 *   /work status    — Check if a task is running
 */

import type { WorkerConfig, WorkerEvent, WorkerResult } from "../../copilot/worker-types.js";
import type { CommandHandler } from "./commands-types.js";
import type { RouteReplyParams } from "./route-reply.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { runWorker } from "../../copilot/worker.js";
import { logVerbose } from "../../globals.js";
import { routeReply } from "./route-reply.js";

type ActiveWorkJob = {
  task: string;
  startedAt: number;
};

let activeWorkJob: ActiveWorkJob | null = null;

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Convert a WorkerEvent into a chat message (null = skip) */
export function formatEventForChat(event: WorkerEvent): string | null {
  switch (event.type) {
    case "iteration-start":
      return `Iteration ${event.iteration}/${event.maxIterations}: Starting...`;
    case "agent-done":
      return `Iteration ${event.iteration}: Agent done (${formatDuration(event.durationMs)})`;
    case "stage-done": {
      const icon = event.result.passed ? "PASS" : "FAIL";
      const errorSnippet =
        !event.result.passed && event.result.error
          ? ` (${event.result.error.split("\n")[0]?.slice(0, 80)})`
          : "";
      return `  ${event.result.stage}: ${icon} (${formatDuration(event.result.durationMs)})${errorSnippet}`;
    }
    case "verify-done":
      return event.allPassed
        ? `Iteration ${event.iteration}: All checks passed!`
        : `Iteration ${event.iteration}: Checks failed, retrying...`;
    case "stall-warning":
      return event.consecutiveStalls >= event.stallLimit - 1
        ? `Stall detected (${event.consecutiveStalls}/${event.stallLimit})`
        : null;
    case "error":
      return `Error: ${event.error}`;
    default:
      return null;
  }
}

/** Format the final WorkerResult for chat */
function formatFinalSummary(result: WorkerResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(`Work complete: all checks passed after ${result.iterations.length} iteration(s)`);
    lines.push(`Duration: ${formatDuration(result.totalDurationMs)}`);
    if (result.changedFiles.length > 0) {
      const shown = result.changedFiles.slice(0, 10);
      lines.push(`Changed files: ${shown.join(", ")}`);
      if (result.changedFiles.length > 10) {
        lines.push(`  ... +${result.changedFiles.length - 10} more`);
      }
    }
  } else {
    lines.push(`Work failed after ${result.iterations.length} iteration(s)`);
    lines.push(`Reason: ${result.stopReason ?? "unknown"}`);
    lines.push(`Duration: ${formatDuration(result.totalDurationMs)}`);
  }
  return lines.join("\n");
}

/** Create a chat-based event emitter that sends messages via routeReply */
function createChatEmitter(
  routeParams: Omit<RouteReplyParams, "payload">,
): (event: WorkerEvent) => void {
  return (event: WorkerEvent) => {
    const message = formatEventForChat(event);
    if (message) {
      void routeReply({ ...routeParams, payload: { text: message }, mirror: false });
    }
  };
}

export const handleWorkCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const { command } = params;
  const normalized = command.commandBodyNormalized;

  // Match /work but not /workout etc.
  if (normalized !== "/work" && !normalized.startsWith("/work ")) {
    return null;
  }

  if (!command.isAuthorizedSender) {
    logVerbose(`Ignoring /work from unauthorized sender: ${command.senderId || "<unknown>"}`);
    return { shouldContinue: false };
  }

  const rest = normalized.slice("/work".length).trim();

  // /work (no args) → usage
  if (!rest) {
    return {
      shouldContinue: false,
      reply: { text: "Usage: /work <task description>\nSubcommands: /work stop, /work status" },
    };
  }

  // /work stop
  if (rest === "stop") {
    if (!activeWorkJob) {
      return { shouldContinue: false, reply: { text: "No active work job." } };
    }
    activeWorkJob = null;
    return { shouldContinue: false, reply: { text: "Work job stopped." } };
  }

  // /work status
  if (rest === "status") {
    if (!activeWorkJob) {
      return { shouldContinue: false, reply: { text: "No active work job." } };
    }
    const elapsed = Math.round((Date.now() - activeWorkJob.startedAt) / 1000);
    return {
      shouldContinue: false,
      reply: { text: `Active: "${activeWorkJob.task}" (${elapsed}s)` },
    };
  }

  // Concurrency guard
  if (activeWorkJob) {
    return {
      shouldContinue: false,
      reply: {
        text: `A work job is already running: "${activeWorkJob.task}"\nUse /work stop first.`,
      },
    };
  }

  // Resolve workspace and agent
  const agentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const cwd = params.workspaceDir;

  // Build route-reply params for progress messages
  // oxlint-disable-next-line typescript/no-explicit-any
  const channel = params.ctx.OriginatingChannel || (params.command.channel as any);
  const to = params.ctx.OriginatingTo || params.command.from || params.command.to;

  if (!channel || !to) {
    return {
      shouldContinue: false,
      reply: { text: "Cannot determine reply channel. Try from a direct message." },
    };
  }

  const routeParams: Omit<RouteReplyParams, "payload"> = {
    channel,
    to,
    sessionKey: params.sessionKey,
    accountId: params.ctx.AccountId,
    threadId: params.ctx.MessageThreadId,
    cfg: params.cfg,
  };

  // Build WorkerConfig
  const config: WorkerConfig = {
    task: rest,
    cwd,
    maxIterations: 5,
    stallLimit: 3,
    noTests: false,
    noVideo: true,
    noBrowser: false,
    noCoverage: false,
    noScreenshotDiff: false,
    noReview: false,
    noSpecTests: false,
    appUrl: undefined,
    agentId,
    thinking: params.resolvedThinkLevel ?? undefined,
    turnTimeoutSeconds: 300,
    local: false,
    json: false,
    emit: createChatEmitter(routeParams),
  };

  // Fire and forget
  activeWorkJob = { task: rest, startedAt: Date.now() };

  runWorker(config)
    .then((result) => {
      activeWorkJob = null;
      void routeReply({ ...routeParams, payload: { text: formatFinalSummary(result) } });
    })
    .catch((err) => {
      activeWorkJob = null;
      void routeReply({
        ...routeParams,
        payload: { text: `Work failed: ${String(err)}` },
      });
    });

  return {
    shouldContinue: false,
    reply: { text: `Starting work: ${rest}` },
  };
};
