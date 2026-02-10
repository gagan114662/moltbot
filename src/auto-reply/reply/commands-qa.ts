/**
 * /qa command handler — standalone QA evaluation from chat.
 *
 * Usage:
 *   /qa <criteria>                    — Test the app against criteria
 *   /qa --steps 5 <criteria>         — Limit to 5 interaction steps
 *   /qa --sample 3 <criteria>        — Sample 3 combos for matrix tests
 *   /qa --url http://... <criteria>  — Explicit app URL
 *   /qa --tmux <target> <criteria>   — Send nudge to tmux pane (default: moltbot:0.0)
 *   /qa --voice <criteria>           — Voice QA (macOS, headed Chrome)
 *   /qa agent=v4 <criteria>          — Use specific agent
 */

import type { CopilotFeedback } from "../../copilot/types.js";
import type { CommandHandler } from "./commands-types.js";
import type { RouteReplyParams } from "./route-reply.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveChromePath } from "../../copilot/browser-inspect.js";
import { writeFeedbackToTarget } from "../../copilot/feedback.js";
import { bootstrapQaHooks } from "../../copilot/qa-bootstrap.js";
import { formatUxReport, runUxEvalStage } from "../../copilot/stages-ux-eval.js";
import { DEFAULT_TMUX_TARGET, tmuxSendKeys } from "../../copilot/tmux-send.js";
import { runVoiceQaLoop } from "../../copilot/voice-qa-loop.js";
import { logVerbose } from "../../globals.js";
import { routeReply } from "./route-reply.js";

export function parseQaFlags(input: string): {
  steps: number;
  sample: number;
  url?: string;
  agentId?: string;
  tmuxTarget: string;
  voice: boolean;
  criteria: string;
} {
  let steps = 10;
  let sample = 5;
  let url: string | undefined;
  let agentId: string | undefined;
  let tmuxTarget = DEFAULT_TMUX_TARGET;
  let voice = false;

  // Extract --voice
  const voiceMatch = input.match(/--voice\b/);
  if (voiceMatch) {
    voice = true;
    input = input.replace(voiceMatch[0], "").trim();
  }

  // Extract --steps N
  const stepsMatch = input.match(/--steps\s+(\d+)/);
  if (stepsMatch) {
    steps = Number.parseInt(stepsMatch[1], 10);
    input = input.replace(stepsMatch[0], "").trim();
  }

  // Extract --sample N
  const sampleMatch = input.match(/--sample\s+(\d+)/);
  if (sampleMatch) {
    sample = Number.parseInt(sampleMatch[1], 10);
    input = input.replace(sampleMatch[0], "").trim();
  }

  // Extract --url <url>
  const urlMatch = input.match(/--url\s+(\S+)/);
  if (urlMatch) {
    url = urlMatch[1];
    input = input.replace(urlMatch[0], "").trim();
  }

  // Extract --tmux <target>
  const tmuxMatch = input.match(/--tmux\s+(\S+)/);
  if (tmuxMatch) {
    tmuxTarget = tmuxMatch[1];
    input = input.replace(tmuxMatch[0], "").trim();
  }

  // Extract agent=<id>
  const agentMatch = input.match(/agent=(\S+)/);
  if (agentMatch) {
    agentId = agentMatch[1];
    input = input.replace(agentMatch[0], "").trim();
  }

  return { steps, sample, url, agentId, tmuxTarget, voice, criteria: input.trim() };
}

export const handleQaCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const { command } = params;
  const normalized = command.commandBodyNormalized;

  // Match /qa but not /qaXyz
  if (normalized !== "/qa" && !normalized.startsWith("/qa ")) {
    return null;
  }

  if (!command.isAuthorizedSender) {
    logVerbose(`Ignoring /qa from unauthorized sender: ${command.senderId || "<unknown>"}`);
    return { shouldContinue: false };
  }

  const rest = normalized.slice("/qa".length).trim();

  if (!rest) {
    return {
      shouldContinue: false,
      reply: {
        text: [
          "Usage: /qa <acceptance criteria>",
          "",
          "Options:",
          "  --steps N          Max interaction steps (default: 10)",
          "  --sample N         Sample size for matrix testing (default: 5)",
          "  --url <url>        Explicit app URL",
          "  --tmux <target>    Tmux pane for nudge (default: moltbot:0.0)",
          "  --voice            Voice QA (macOS, headed Chrome, fake mic)",
          "  agent=<id>         Use specific agent",
          "",
          "Example: /qa agent=v4 test the tutor board renders and drawing tools work",
        ].join("\n"),
      },
    };
  }

  const flags = parseQaFlags(rest);
  const agentId =
    flags.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  const cwd = params.workspaceDir;

  // Resolve target workspace: if agent was explicitly overridden, use its workspace
  const targetCwd = flags.agentId ? (resolveAgentWorkspaceDir(params.cfg, agentId) ?? cwd) : cwd;

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

  // Bootstrap QA hooks in TARGET workspace (idempotent)
  bootstrapQaHooks(targetCwd).catch((err) => {
    logVerbose(`bootstrapQaHooks failed: ${String(err)}`);
  });

  // Fire and forget — send progress, then result
  void routeReply({
    ...routeParams,
    payload: {
      text: `${flags.voice ? "Voice " : ""}QA started: ${flags.criteria.slice(0, 100)}...`,
    },
    mirror: false,
  });

  // Voice QA path — feedback loop: test → nudge Claude → wait → retest
  if (flags.voice) {
    const chromePath = resolveChromePath();
    if (!chromePath) {
      void routeReply({
        ...routeParams,
        payload: { text: "Voice QA failed: Chrome not found. Install Google Chrome." },
      });
      return { shouldContinue: false };
    }

    // Bypass token from scratchpad AuthContext (test user — skips login + onboarding)
    const SCRATCHPAD_BYPASS_TOKEN =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJtb25nb2RiX3Rlc3RfdXNlciIsImVtYWlsIjoidGVzdEBleGFtcGxlLmNvbSIsIm5hbWUiOiJUZXN0IFVzZXIiLCJpYXQiOjE3NzA1Nzg4NzcsImV4cCI6MTgwMjExNDg3N30.v98BjQxjtXe0iwGOqTq6BcwJJ-IH8mUvvMw_8Rx9QjA";

    runVoiceQaLoop({
      appUrl: flags.url ?? "http://localhost:3000/app",
      prompts: [flags.criteria],
      chromePath,
      cwd,
      targetCwd,
      tmuxTarget: flags.tmuxTarget,
      authToken: SCRATCHPAD_BYPASS_TOKEN,
      onProgress: (msg) => {
        void routeReply({ ...routeParams, payload: { text: msg }, mirror: false });
      },
    })
      .then((loopResult) => {
        const status = loopResult.ok ? "PASSED" : `FAILED (${loopResult.stopReason})`;
        const report = [
          `Voice QA ${status} after ${loopResult.iterations} iteration(s)`,
          "",
          loopResult.lastReport,
        ].join("\n");
        void routeReply({ ...routeParams, payload: { text: report } });
      })
      .catch((err) => {
        void routeReply({
          ...routeParams,
          payload: { text: `Voice QA loop failed: ${String(err)}` },
        });
      });

    return { shouldContinue: false };
  }

  runUxEvalStage({
    cwd: targetCwd,
    criteria: flags.criteria,
    appUrl: flags.url,
    signal: new AbortController().signal,
    maxSteps: flags.steps,
    sample: flags.sample,
    agentId,
    local: false,
  })
    .then(async (result) => {
      const report = result.uxResult
        ? `QA Report\n\n${formatUxReport(result.uxResult)}`
        : result.error
          ? `QA Report\n\nFailed: ${result.error}`
          : "QA Report\n\nNo results (dev server not found?)";

      // Write feedback to target workspace
      const feedback: CopilotFeedback = {
        timestamp: new Date().toISOString(),
        ok: result.passed,
        durationMs: result.durationMs,
        gitRef: "qa-eval",
        triggerFiles: [],
        checks: [
          {
            stage: result.stage,
            passed: result.passed,
            durationMs: result.durationMs,
            error: result.error,
          },
        ],
        summary: result.uxResult ? formatUxReport(result.uxResult) : (result.error ?? "No results"),
      };
      await writeFeedbackToTarget(cwd, targetCwd, feedback);

      // Send nudge into tmux pane so Claude Code acts on it immediately
      const nudge = feedback.ok
        ? "QA passed — all checks green."
        : `QA failed: ${feedback.summary.split("\n")[0]}. Read QA-FEEDBACK.md for details and fix all issues.`;
      tmuxSendKeys(flags.tmuxTarget, nudge);

      void routeReply({ ...routeParams, payload: { text: report } });
    })
    .catch((err) => {
      void routeReply({
        ...routeParams,
        payload: { text: `QA failed: ${String(err)}` },
      });
    });

  return { shouldContinue: false };
};
