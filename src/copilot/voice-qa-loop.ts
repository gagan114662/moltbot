/**
 * Voice QA feedback loop — run voice QA, nudge Claude, wait, retest.
 *
 * Supports two modes:
 *   1. Single-prompt (legacy) — one prompt per browser session
 *   2. Multi-turn — persistent browser session with student script (~2 min)
 *
 * Keeps iterating until all prompts pass or max iterations / stall limit hit.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CopilotFeedback } from "./types.js";
import type { EnrichedVoiceQaResult, SourceFile } from "./voice-qa-diagnosis.js";
import type { MultiTurnResult, StudentScript, VoiceQaResult, VisualQaConfig } from "./voice-qa.js";
import { writeFeedbackToTarget } from "./feedback.js";
import { pollForTmuxIdle, tmuxSendKeys } from "./tmux-send.js";
import {
  buildDiagnosisNudge,
  buildLlmDiagnosisPrompt,
  diagnose,
  enrichWsEventsFromConsole,
  formatDiagnosisReport,
  mergeDiagnoses,
  parseLlmDiagnosis,
} from "./voice-qa-diagnosis.js";
import {
  ELEMENTARY_MATH_SCRIPT,
  formatMultiTurnReport,
  formatVoiceReport,
  runMultiTurnVoiceQa,
  runVoiceQa,
} from "./voice-qa.js";

export type VoiceQaLoopParams = {
  appUrl: string;
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
  /** Per-prompt voice QA timeout in ms (single-prompt mode only) */
  voiceTimeoutMs?: number;
  /** Max time to wait for Claude to finish per iteration in ms (default 8 min) */
  claudeTimeoutMs?: number;
  /** Called on each iteration with a progress message */
  onProgress?: (msg: string) => void;
  /** JWT token to inject into localStorage before navigating (bypasses login). */
  authToken?: string;
  /** LLM-powered diagnosis callback. Receives a rich prompt with all QA signals,
   *  returns raw LLM text (JSON array of diagnoses). Uses Codex. */
  agentDiagnose?: (prompt: string) => Promise<string>;
  /** Source files to include in LLM diagnosis prompt (relative to targetCwd).
   *  Codex reads these to give specific file:line fixes. */
  sourceFiles?: string[];
  /** Multi-turn student script. When provided, uses multi-turn mode. */
  script?: StudentScript;
  /** Visual QA config for screenshot analysis (multi-turn only). */
  visualQa?: VisualQaConfig;
  /** Prompts for single-prompt mode. Ignored when script is provided. */
  prompts?: string[];
};

export type VoiceQaLoopResult = {
  ok: boolean;
  iterations: number;
  stopReason: "success" | "max-iterations" | "stuck" | "claude-timeout";
  lastReport: string;
  /** Single-prompt mode results (undefined in multi-turn mode) */
  lastResults?: VoiceQaResult[];
  /** Multi-turn mode results (undefined in single-prompt mode) */
  lastMultiTurnResult?: MultiTurnResult;
};

/** Fingerprint a set of enriched results for stall detection. */
function failureFingerprint(results: EnrichedVoiceQaResult[], topDiagnosis?: string): string {
  const base = results
    .filter((r) => !r.passed)
    .map((r) => {
      const parts = [r.error ?? ""];
      parts.push(...r.consoleErrors.toSorted());
      return parts.join("|");
    })
    .join(";;");
  return topDiagnosis ? `${base}##${topDiagnosis}` : base;
}

/** Build a short but actionable nudge for the tmux pane. */
function buildNudge(iteration: number, max: number, enriched: EnrichedVoiceQaResult[]): string {
  const failed = enriched.filter((r) => !r.passed);
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

/** Convert MultiTurnResult to EnrichedVoiceQaResult[] for diagnosis. */
function multiTurnToEnriched(result: MultiTurnResult): EnrichedVoiceQaResult[] {
  return result.turns.map((t) => ({
    prompt: t.prompt,
    passed: t.passed,
    error: t.failReasons.join("; ") || undefined,
    tutorResponse: t.tutorResponse ?? undefined,
    consoleErrors: t.consoleErrors,
    consoleLogs: t.consoleLogs,
    screenshotPath: t.screenshotPath,
    wsEvents: enrichWsEventsFromConsole(result.wsEvents, result.overallConsoleLogs),
    toolCalls: t.toolCalls,
    visualAssessment: t.visualAssessment,
  }));
}

/** Build check results for CopilotFeedback from enriched results. */
function buildChecks(enriched: EnrichedVoiceQaResult[]) {
  return enriched.map((r) => ({
    stage: "voice-qa" as const,
    passed: r.passed,
    durationMs: 0,
    error: r.passed ? undefined : (r.error ?? "Unknown failure"),
  }));
}

/** Run diagnosis (static + LLM) on enriched results. */
async function runDiagnosis(
  enriched: EnrichedVoiceQaResult[],
  params: VoiceQaLoopParams,
  iteration: number,
) {
  const staticDiagnoses = diagnose(enriched);
  let diagnoses = staticDiagnoses;

  if (params.agentDiagnose) {
    try {
      params.onProgress?.(`Running LLM diagnosis (iteration ${iteration})...`);

      const codeFiles: SourceFile[] = [];
      if (params.sourceFiles && params.targetCwd) {
        for (const relPath of params.sourceFiles) {
          try {
            const absPath = path.join(params.targetCwd, relPath);
            const content = fs.readFileSync(absPath, "utf-8");
            const numbered = content
              .split("\n")
              .map((line, idx) => `${idx + 1}: ${line}`)
              .join("\n");
            codeFiles.push({ path: relPath, content: numbered });
          } catch {
            // File not found — skip silently
          }
        }
      }

      const prompt = buildLlmDiagnosisPrompt(enriched, staticDiagnoses, codeFiles);
      const llmResponse = await params.agentDiagnose(prompt);
      const llmDiagnoses = parseLlmDiagnosis(llmResponse);
      if (llmDiagnoses.length > 0) {
        diagnoses = mergeDiagnoses(staticDiagnoses, llmDiagnoses);
        params.onProgress?.(
          `LLM found ${llmDiagnoses.length} additional insight(s) beyond static rules`,
        );
      }
    } catch (err: unknown) {
      params.onProgress?.(`LLM diagnosis failed (non-fatal): ${String(err)}`);
    }
  }

  return diagnoses;
}

export async function runVoiceQaLoop(params: VoiceQaLoopParams): Promise<VoiceQaLoopResult> {
  const maxIterations = params.maxIterations ?? 5;
  const stallLimit = params.stallLimit ?? 2;
  const claudeTimeoutMs = params.claudeTimeoutMs ?? 8 * 60_000;
  const isMultiTurn = !!params.script;
  const prompts = params.prompts ?? ["What is two plus two?"];

  let lastFingerprint = "";
  let consecutiveStalls = 0;
  let lastReport = "";
  let lastResults: VoiceQaResult[] | undefined;
  let lastMultiTurnResult: MultiTurnResult | undefined;

  for (let i = 1; i <= maxIterations; i++) {
    const evidenceDir = path.join(os.tmpdir(), `voice-qa-evidence-${Date.now()}`);
    fs.mkdirSync(evidenceDir, { recursive: true });

    let allPassed: boolean;
    let enriched: EnrichedVoiceQaResult[];

    if (isMultiTurn) {
      // Multi-turn session mode
      const script = params.script ?? ELEMENTARY_MATH_SCRIPT;
      params.onProgress?.(`Iteration ${i}: running ${script.turns.length}-turn session...`);

      const result = await runMultiTurnVoiceQa({
        appUrl: params.appUrl,
        script,
        chromePath: params.chromePath,
        evidenceDir,
        authToken: params.authToken,
        sessionTimeoutMs: params.voiceTimeoutMs ?? 180_000,
        visualQa: params.visualQa,
      });

      lastMultiTurnResult = result;
      lastResults = undefined;
      lastReport = formatMultiTurnReport(result);
      allPassed = result.allPassed;
      enriched = multiTurnToEnriched(result);
    } else {
      // Single-prompt mode (legacy)
      params.onProgress?.(`Iteration ${i}: running ${prompts.length} prompt(s)...`);

      const results = await runVoiceQa({
        appUrl: params.appUrl,
        prompts,
        chromePath: params.chromePath,
        evidenceDir,
        timeoutMs: params.voiceTimeoutMs,
        authToken: params.authToken,
      });

      lastResults = results;
      lastMultiTurnResult = undefined;
      lastReport = formatVoiceReport(results);
      allPassed = results.every((r) => r.passed);
      enriched = results.map((r) => ({
        ...r,
        wsEvents: enrichWsEventsFromConsole(r.wsEvents ?? [], r.consoleLogs),
      }));
    }

    // Run diagnosis (static + LLM)
    const diagnoses = allPassed ? [] : await runDiagnosis(enriched, params, i);

    // Build feedback
    const diagnosisSection =
      !allPassed && diagnoses.length > 0
        ? `\n\n---\n\n# Diagnosis\n\n${formatDiagnosisReport(diagnoses)}`
        : "";
    const feedback: CopilotFeedback = {
      timestamp: new Date().toISOString(),
      ok: allPassed,
      durationMs: 0,
      gitRef: "voice-qa",
      triggerFiles: [],
      checks: buildChecks(enriched),
      summary: lastReport + diagnosisSection,
    };
    await writeFeedbackToTarget(params.cwd, params.targetCwd, feedback);

    if (allPassed) {
      params.onProgress?.(`Voice QA iteration ${i}/${maxIterations}: PASSED`);
      tmuxSendKeys(params.tmuxTarget, "Voice QA PASSED — all prompts answered correctly.");
      return {
        ok: true,
        iterations: i,
        stopReason: "success",
        lastReport,
        lastResults,
        lastMultiTurnResult,
      };
    }

    // Stall detection
    const topDiag = diagnoses.length > 0 ? diagnoses[0].rootCause : undefined;
    const fp = failureFingerprint(enriched, topDiag);
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
      return {
        ok: false,
        iterations: i,
        stopReason: "stuck",
        lastReport,
        lastResults,
        lastMultiTurnResult,
      };
    }

    // Nudge Claude to fix
    params.onProgress?.(
      `Voice QA iteration ${i}/${maxIterations}: FAILED — nudging Claude to fix...`,
    );
    const nudge =
      diagnoses.length > 0
        ? buildDiagnosisNudge(i, maxIterations, diagnoses)
        : buildNudge(i, maxIterations, enriched);
    tmuxSendKeys(params.tmuxTarget, nudge);

    // Wait for Claude to finish
    const idle = await pollForTmuxIdle(params.tmuxTarget, { timeoutMs: claudeTimeoutMs });
    if (!idle) {
      params.onProgress?.(`Claude didn't finish within timeout. Stopping.`);
      return {
        ok: false,
        iterations: i,
        stopReason: "claude-timeout",
        lastReport,
        lastResults,
        lastMultiTurnResult,
      };
    }

    // Grace period — let file writes settle
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  // Max iterations exhausted
  params.onProgress?.(`Voice QA: max iterations (${maxIterations}) reached without passing.`);
  return {
    ok: false,
    iterations: maxIterations,
    stopReason: "max-iterations",
    lastReport,
    lastResults,
    lastMultiTurnResult,
  };
}
