/**
 * Voice QA feedback loop — run voice QA, nudge Claude, wait, retest.
 *
 * Keeps iterating until all prompts pass or max iterations / stall limit hit.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CopilotFeedback } from "./types.js";
import type { VoiceQaResult } from "./voice-qa.js";
import { writeFeedbackToTarget } from "./feedback.js";
import { pollForTmuxIdle, tmuxSendKeys } from "./tmux-send.js";
import { formatVoiceReport, runVoiceQa } from "./voice-qa.js";

export type VoiceQaLoopParams = {
  appUrl: string;
  prompts: string[];
  chromePath: string;
  /** Moltbot working directory */
  cwd: string;
  /** Target workspace (scratchpad) for feedback files */
  targetCwd: string;
  /** Tmux pane to nudge (e.g. "scratchpad:0.0") */
  tmuxTarget: string;
  /** Max retry iterations (default 5) */
  maxIterations?: number;
  /** Consecutive identical-failure limit before early exit (default 2) */
  stallLimit?: number;
  /** Per-prompt voice QA timeout in ms */
  voiceTimeoutMs?: number;
  /** Max time to wait for Claude to finish per iteration in ms (default 8 min) */
  claudeTimeoutMs?: number;
  /** Called on each iteration with a progress message */
  onProgress?: (msg: string) => void;
  /** JWT token to inject into localStorage before navigating (bypasses login). */
  authToken?: string;
};

export type VoiceQaLoopResult = {
  ok: boolean;
  iterations: number;
  stopReason: "success" | "max-iterations" | "stuck" | "claude-timeout";
  lastResults: VoiceQaResult[];
  lastReport: string;
};

/** Fingerprint a set of voice QA results for stall detection. */
function failureFingerprint(results: VoiceQaResult[]): string {
  return results
    .filter((r) => !r.passed)
    .map((r) => {
      const parts = [r.error ?? ""];
      parts.push(...r.consoleErrors.toSorted());
      return parts.join("|");
    })
    .join(";;");
}

/** Build a detailed error string from a VoiceQaResult so Claude knows exactly what broke. */
function buildCheckError(r: VoiceQaResult): string | undefined {
  if (r.passed) {
    return undefined;
  }
  const parts: string[] = [];
  if (r.error) {
    parts.push(`Error: ${r.error}`);
  }
  if (!r.tutorResponse) {
    parts.push("Tutor did not respond (no audio reply detected).");
  }
  if (r.transcript) {
    parts.push(`User speech recognized: "${r.transcript}"`);
  }
  if (r.tutorResponse) {
    parts.push(`Tutor said: "${r.tutorResponse}"`);
  }
  if (r.consoleErrors.length > 0) {
    parts.push(
      `Console errors:\n${r.consoleErrors
        .slice(0, 5)
        .map((e) => `  - ${e}`)
        .join("\n")}`,
    );
  }
  if (r.consoleLogs.length > 0) {
    parts.push(
      `Console logs (last 10):\n${r.consoleLogs
        .slice(-10)
        .map((l) => `  ${l}`)
        .join("\n")}`,
    );
  }
  if (r.screenshotPath) {
    parts.push(`Screenshot: ${r.screenshotPath}`);
  }
  return parts.join("\n") || "Unknown failure";
}

/** Build a short but actionable nudge for the tmux pane. */
function buildNudge(iteration: number, max: number, results: VoiceQaResult[]): string {
  const failed = results.filter((r) => !r.passed);
  const reasons: string[] = [];
  for (const r of failed) {
    if (r.error) {
      reasons.push(r.error.split("\n")[0]);
    } else if (!r.tutorResponse) {
      reasons.push("tutor did not respond");
    }
    if (r.consoleErrors.length > 0) {
      reasons.push(r.consoleErrors[0]);
    }
  }
  const detail = reasons.length > 0 ? reasons.slice(0, 2).join("; ") : "see QA-FEEDBACK.md";
  return `Voice QA ${iteration}/${max} FAILED: ${detail}. Read QA-FEEDBACK.md, fix all issues, then say done.`;
}

export async function runVoiceQaLoop(params: VoiceQaLoopParams): Promise<VoiceQaLoopResult> {
  const maxIterations = params.maxIterations ?? 5;
  const stallLimit = params.stallLimit ?? 2;
  const claudeTimeoutMs = params.claudeTimeoutMs ?? 8 * 60_000;

  let lastFingerprint = "";
  let consecutiveStalls = 0;
  let lastResults: VoiceQaResult[] = [];
  let lastReport = "";

  for (let i = 1; i <= maxIterations; i++) {
    const evidenceDir = path.join(os.tmpdir(), `voice-qa-evidence-${Date.now()}`);
    fs.mkdirSync(evidenceDir, { recursive: true });

    // Run voice QA
    lastResults = await runVoiceQa({
      appUrl: params.appUrl,
      prompts: params.prompts,
      chromePath: params.chromePath,
      evidenceDir,
      timeoutMs: params.voiceTimeoutMs,
      authToken: params.authToken,
    });

    lastReport = formatVoiceReport(lastResults);
    const allPassed = lastResults.every((r) => r.passed);

    // Build feedback with full detail per check so Claude knows exactly what broke
    const feedback: CopilotFeedback = {
      timestamp: new Date().toISOString(),
      ok: allPassed,
      durationMs: 0,
      gitRef: "voice-qa",
      triggerFiles: [],
      checks: lastResults.map((r) => ({
        stage: "voice-qa" as const,
        passed: r.passed,
        durationMs: 0,
        error: buildCheckError(r),
      })),
      summary: lastReport,
    };
    await writeFeedbackToTarget(params.cwd, params.targetCwd, feedback);

    if (allPassed) {
      params.onProgress?.(`Voice QA iteration ${i}/${maxIterations}: PASSED`);
      tmuxSendKeys(params.tmuxTarget, "Voice QA PASSED — all prompts answered correctly.");
      return { ok: true, iterations: i, stopReason: "success", lastResults, lastReport };
    }

    // Stall detection — same failure fingerprint as last time?
    const fp = failureFingerprint(lastResults);
    if (fp === lastFingerprint && fp !== "") {
      consecutiveStalls++;
    } else {
      consecutiveStalls = 0;
    }
    lastFingerprint = fp;

    if (consecutiveStalls >= stallLimit) {
      params.onProgress?.(`Voice QA stuck after ${i} iterations — same error repeating. Stopping.`);
      tmuxSendKeys(
        params.tmuxTarget,
        "Voice QA stuck — same error after multiple fix attempts. Manual intervention needed.",
      );
      return { ok: false, iterations: i, stopReason: "stuck", lastResults, lastReport };
    }

    // Nudge Claude to fix with specific failure details
    params.onProgress?.(
      `Voice QA iteration ${i}/${maxIterations}: FAILED — nudging Claude to fix...`,
    );
    tmuxSendKeys(params.tmuxTarget, buildNudge(i, maxIterations, lastResults));

    // Wait for Claude to finish
    const idle = await pollForTmuxIdle(params.tmuxTarget, { timeoutMs: claudeTimeoutMs });
    if (!idle) {
      params.onProgress?.(`Claude didn't finish within timeout. Stopping.`);
      return { ok: false, iterations: i, stopReason: "claude-timeout", lastResults, lastReport };
    }

    // Grace period — let file writes settle before re-running QA
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  // Max iterations exhausted
  params.onProgress?.(`Voice QA: max iterations (${maxIterations}) reached without passing.`);
  return {
    ok: false,
    iterations: maxIterations,
    stopReason: "max-iterations",
    lastResults,
    lastReport,
  };
}
