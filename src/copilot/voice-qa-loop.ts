/**
 * Voice QA feedback loop — run voice QA, nudge Claude, wait, retest.
 *
 * Supports two modes:
 *   1. Single-prompt (legacy) — one prompt per browser session
 *   2. Multi-turn — persistent browser session with student script (~2 min)
 *
 * Keeps iterating until all prompts pass or max iterations / stall limit hit.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FeedbackContext } from "./feedback.js";
import type { CopilotFeedback, StageResult } from "./types.js";
import type { BehavioralObservation, ProjectWarning } from "./types.js";
import type {
  Diagnosis,
  EnrichedVoiceQaResult,
  IterationContext,
  ScreenshotDescription,
  SourceFile,
} from "./voice-qa-diagnosis.js";
import type { MultiTurnResult, StudentScript, VoiceQaResult, VisualQaConfig } from "./voice-qa.js";
import { resolveChromePath } from "./browser-inspect.js";
import { writeFeedbackToTarget } from "./feedback.js";
import { pollForClaudeState, tmuxCaptureScrollback, tmuxSendKeys } from "./tmux-send.js";
import {
  buildBehavioralObservations,
  buildContextualNudge,
  buildLlmDiagnosisPrompt,
  buildPlanReviewPrompt,
  buildSeniorNudgeFallback,
  buildSeniorNudgePrompt,
  diagnose,
  enrichWsEventsFromConsole,
  formatDiagnosisReport,
  matchProjectKnowledge,
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
  /** Full iteration history for debugging / logging. */
  iterationHistory?: IterationRecord[];
};

// ---------------------------------------------------------------------------
// Observation types (Think-Act-Observe loop)
// ---------------------------------------------------------------------------

/** What we observed about Claude's response after an iteration. */
type IterationObservation = {
  diffStat: string;
  diffFull: string;
  changedFiles: string[];
  tmuxScrollback: string;
  diffMatchResult: "full" | "partial" | "none" | "unknown";
};

/** Record of a single iteration for history threading. */
type IterationRecord = {
  iteration: number;
  diagnoses: Diagnosis[];
  behavioral: BehavioralObservation[];
  projectWarnings: ProjectWarning[];
  nudgeSent: string;
  observation: IterationObservation | null;
  passed: boolean;
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
    pageHealth: t.pageHealth,
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

// ---------------------------------------------------------------------------
// Observation helpers (Think-Act-Observe)
// ---------------------------------------------------------------------------

/** Capture git diff from the target repo. Cascading fallback: committed → staged → unstaged. */
function captureTargetDiff(targetCwd: string): {
  diffStat: string;
  diffFull: string;
  changedFiles: string[];
} {
  const run = (args: string): string => {
    try {
      return execSync(`git ${args}`, { cwd: targetCwd, encoding: "utf-8", timeout: 10_000 }).trim();
    } catch {
      return "";
    }
  };

  // Try committed changes first (Claude may have committed)
  let diffStat = run("diff --stat HEAD~1");
  let diffFull = run("diff HEAD~1");
  let nameOnly = run("diff --name-only HEAD~1");

  // If no committed changes, try working tree vs HEAD
  if (!diffFull) {
    diffStat = run("diff --stat HEAD");
    diffFull = run("diff HEAD");
    nameOnly = run("diff --name-only HEAD");
  }

  // Last resort: unstaged only
  if (!diffFull) {
    diffStat = run("diff --stat");
    diffFull = run("diff");
    nameOnly = run("diff --name-only");
  }

  const changedFiles = nameOnly ? nameOnly.split("\n").filter(Boolean) : [];
  return { diffStat, diffFull, changedFiles };
}

/**
 * Check if Claude's actual diff contains the lines we suggested.
 * Extracts `+` lines from suggested unified diffs and checks what % appear in the actual diff.
 */
export function assessDiffMatch(
  actualDiff: string,
  suggestedFixes: string[],
): "full" | "partial" | "none" | "unknown" {
  if (!actualDiff || suggestedFixes.length === 0) {
    return "unknown";
  }

  let matchCount = 0;
  let totalSuggestions = 0;

  for (const fix of suggestedFixes) {
    const suggestedLines = fix
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1).trim())
      .filter(Boolean);

    if (suggestedLines.length === 0) {
      continue;
    }
    totalSuggestions += suggestedLines.length;

    for (const line of suggestedLines) {
      if (actualDiff.includes(line)) {
        matchCount++;
      }
    }
  }

  if (totalSuggestions === 0) {
    return "unknown";
  }
  const ratio = matchCount / totalSuggestions;
  if (ratio >= 0.8) {
    return "full";
  }
  if (ratio >= 0.3) {
    return "partial";
  }
  return "none";
}

/** OBSERVE: Capture what Claude did after going idle. */
function observeIteration(
  targetCwd: string,
  tmuxTarget: string,
  diagnoses: Diagnosis[],
): IterationObservation {
  const { diffStat, diffFull, changedFiles } = captureTargetDiff(targetCwd);
  const tmuxScrollback = tmuxCaptureScrollback(tmuxTarget) ?? "";
  const suggestedFixes = diagnoses.map((d) => d.suggestedFix).filter(Boolean);
  const diffMatchResult = assessDiffMatch(diffFull, suggestedFixes);

  return { diffStat, diffFull, changedFiles, tmuxScrollback, diffMatchResult };
}

/** Run diagnosis (static + LLM) on enriched results. */
async function runDiagnosis(
  enriched: EnrichedVoiceQaResult[],
  params: VoiceQaLoopParams,
  iteration: number,
  history: IterationRecord[] = [],
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

      // Build iteration context for LLM
      const iterationContext: IterationContext[] = history.map((h) => ({
        iteration: h.iteration,
        nudgeSent: h.nudgeSent,
        diffStat: h.observation?.diffStat ?? "",
        changedFiles: h.observation?.changedFiles ?? [],
        tmuxScrollbackTail: (h.observation?.tmuxScrollback ?? "").split("\n").slice(-30).join("\n"),
        diffMatchResult: h.observation?.diffMatchResult ?? "unknown",
        previousDiagnoses: h.diagnoses.map((d) => d.rootCause),
      }));

      const prompt = buildLlmDiagnosisPrompt(
        enriched,
        staticDiagnoses,
        codeFiles,
        iterationContext.length > 0 ? iterationContext : undefined,
      );
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
  const iterationHistory: IterationRecord[] = [];

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
    const diagnoses = allPassed ? [] : await runDiagnosis(enriched, params, i, iterationHistory);

    // Build behavioral observations + project warnings + screenshot descriptions
    const behavioral = allPassed ? [] : buildBehavioralObservations(enriched);
    const prevObs = iterationHistory.at(-1)?.observation;
    const projectWarnings = matchProjectKnowledge(prevObs?.diffFull ?? "");
    const screenshotDescs: ScreenshotDescription[] = enriched
      .filter((r): r is typeof r & { visualAssessment: { canvasDescription: string } } =>
        Boolean(r.visualAssessment?.canvasDescription),
      )
      .map((r) => ({
        turn: r.prompt?.slice(0, 40) ?? "unknown",
        description: r.visualAssessment.canvasDescription,
        path: r.screenshotPath ?? "",
      }));

    // Build enriched feedback context for QA-FEEDBACK.md
    const feedbackContext: FeedbackContext = {
      behavioral: behavioral.length > 0 ? behavioral : undefined,
      projectWarnings: projectWarnings.length > 0 ? projectWarnings : undefined,
      screenshotPaths: enriched
        .filter((r) => r.screenshotPath)
        .map((r) => ({
          turn: r.prompt?.slice(0, 40) ?? "unknown",
          path: r.screenshotPath!,
          description: r.visualAssessment?.canvasDescription,
        })),
    };

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
    await writeFeedbackToTarget(params.cwd, params.targetCwd, feedback, undefined, feedbackContext);

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
        iterationHistory,
      };
    }

    // Stall detection (enhanced with observation)
    const topDiag = diagnoses.length > 0 ? diagnoses[0].rootCause : undefined;
    const fp = failureFingerprint(enriched, topDiag);
    const lastObs = iterationHistory.at(-1)?.observation;

    if (fp === lastFingerprint && fp !== "") {
      consecutiveStalls++;
      if (lastObs && lastObs.changedFiles.length === 0) {
        params.onProgress?.(`Claude made no changes — may not have read QA-FEEDBACK.md`);
      }
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
        iterationHistory,
      };
    }

    // === ACT: Send senior engineer nudge to Claude ===
    params.onProgress?.(
      `Voice QA iteration ${i}/${maxIterations}: FAILED — nudging Claude to fix...`,
    );
    let nudge: string;
    if (params.agentDiagnose && (behavioral.length > 0 || diagnoses.length > 0)) {
      // LLM-composed nudge (senior engineer style)
      try {
        const nudgePrompt = buildSeniorNudgePrompt(
          behavioral,
          projectWarnings,
          diagnoses,
          i,
          maxIterations,
          prevObs?.diffStat,
          screenshotDescs.length > 0 ? screenshotDescs : undefined,
        );
        const llmNudge = await params.agentDiagnose(nudgePrompt);
        nudge = llmNudge.trim().slice(0, 1000);
        params.onProgress?.(`LLM composed senior engineer nudge (${nudge.length} chars)`);
      } catch (err: unknown) {
        params.onProgress?.(`LLM nudge failed (non-fatal): ${String(err)}`);
        nudge = buildSeniorNudgeFallback(
          behavioral,
          projectWarnings,
          diagnoses,
          i,
          maxIterations,
          screenshotDescs.length > 0 ? screenshotDescs : undefined,
        );
      }
    } else if (behavioral.length > 0) {
      // Fallback: template-based senior nudge
      nudge = buildSeniorNudgeFallback(
        behavioral,
        projectWarnings,
        diagnoses,
        i,
        maxIterations,
        screenshotDescs.length > 0 ? screenshotDescs : undefined,
      );
    } else if (diagnoses.length > 0) {
      // Fallback: contextual nudge with diagnosis
      nudge = buildContextualNudge(
        i,
        maxIterations,
        diagnoses,
        prevObs
          ? { changedFiles: prevObs.changedFiles, diffMatchResult: prevObs.diffMatchResult }
          : null,
      );
    } else {
      nudge = buildNudge(i, maxIterations, enriched);
    }
    tmuxSendKeys(params.tmuxTarget, nudge);

    // === WAIT: Claude works on fix (detect idle vs plan-mode) ===
    const claudeState = await pollForClaudeState(params.tmuxTarget, {
      timeoutMs: claudeTimeoutMs,
    });
    if (claudeState.timedOut) {
      params.onProgress?.(`Claude didn't finish within timeout. Stopping.`);
      return {
        ok: false,
        iterations: i,
        stopReason: "claude-timeout",
        lastReport,
        lastResults,
        lastMultiTurnResult,
        iterationHistory,
      };
    }

    // If Claude is in plan-mode, review the plan before waiting for implementation
    if (claudeState.state === "plan-mode") {
      params.onProgress?.(`Claude is in plan mode — reviewing plan...`);
      if (params.agentDiagnose) {
        try {
          const planWarnings = matchProjectKnowledge(claudeState.planContent);
          const allWarnings = [
            ...projectWarnings,
            ...planWarnings.filter((w) => !projectWarnings.some((pw) => pw.id === w.id)),
          ];
          const reviewPrompt = buildPlanReviewPrompt(
            claudeState.planContent,
            behavioral,
            allWarnings,
          );
          const review = await params.agentDiagnose(reviewPrompt);
          const reviewText = review.trim().slice(0, 500);
          tmuxSendKeys(params.tmuxTarget, `Quick note on your plan: ${reviewText}`);
          params.onProgress?.(`Sent plan review feedback to Claude`);
        } catch (err: unknown) {
          params.onProgress?.(`Plan review failed (non-fatal): ${String(err)}`);
          // Fallback: scan plan against project knowledge
          const planWarnings = matchProjectKnowledge(claudeState.planContent);
          if (planWarnings.length > 0) {
            const warnText = planWarnings.map((w) => w.warning.split(".")[0]).join(". ");
            tmuxSendKeys(
              params.tmuxTarget,
              `Heads up on your plan: ${warnText}. Keep these in mind.`,
            );
          }
        }
      } else {
        // No LLM: scan plan against project knowledge as best-effort
        const planWarnings = matchProjectKnowledge(claudeState.planContent);
        if (planWarnings.length > 0) {
          const warnText = planWarnings.map((w) => w.warning.split(".")[0]).join(". ");
          tmuxSendKeys(
            params.tmuxTarget,
            `Heads up on your plan: ${warnText}. Keep these in mind.`,
          );
        }
      }

      // Continue waiting for implementation to complete
      const implState = await pollForClaudeState(params.tmuxTarget, {
        timeoutMs: claudeTimeoutMs,
        graceMs: 5_000,
      });
      if (implState.timedOut) {
        params.onProgress?.(`Claude didn't finish implementation within timeout. Stopping.`);
        return {
          ok: false,
          iterations: i,
          stopReason: "claude-timeout",
          lastReport,
          lastResults,
          lastMultiTurnResult,
          iterationHistory,
        };
      }
    }

    // Grace period — let file writes settle
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    // === OBSERVE: capture what Claude actually did ===
    params.onProgress?.(`Observing Claude's changes (iteration ${i})...`);
    const observation = observeIteration(params.targetCwd, params.tmuxTarget, diagnoses);

    if (observation.changedFiles.length > 0) {
      params.onProgress?.(
        `Claude changed ${observation.changedFiles.length} file(s): ${observation.changedFiles.slice(0, 3).join(", ")}${observation.changedFiles.length > 3 ? "..." : ""}. Diff match: ${observation.diffMatchResult}`,
      );
    } else {
      params.onProgress?.(`Claude made no detectable changes.`);
    }

    iterationHistory.push({
      iteration: i,
      diagnoses,
      behavioral,
      projectWarnings,
      nudgeSent: nudge,
      observation,
      passed: false,
    });
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
    iterationHistory,
  };
}

// ---------------------------------------------------------------------------
// Copilot worker stage wrapper
// ---------------------------------------------------------------------------

/**
 * Voice QA stage for the copilot worker pipeline.
 * Wraps `runVoiceQaLoop` as a `StageResult` for integration with `worker.ts`.
 */
export async function runVoiceQaLoopStage(params: {
  cwd: string;
  appUrl: string;
  targetCwd?: string;
  tmuxTarget?: string;
  script?: StudentScript;
  sourceFiles?: string[];
  agentDiagnose?: (prompt: string) => Promise<string>;
  authToken?: string;
  visualQa?: VisualQaConfig;
  maxIterations?: number;
}): Promise<StageResult> {
  const start = Date.now();
  try {
    const chromePath = resolveChromePath();
    if (!chromePath) {
      return {
        stage: "voice-qa",
        passed: false,
        durationMs: Date.now() - start,
        error: "Chrome not found",
      };
    }

    const result = await runVoiceQaLoop({
      appUrl: params.appUrl,
      chromePath,
      cwd: params.cwd,
      targetCwd: params.targetCwd ?? params.cwd,
      tmuxTarget: params.tmuxTarget ?? "scratchpad:0.0",
      script: params.script ?? ELEMENTARY_MATH_SCRIPT,
      sourceFiles: params.sourceFiles,
      agentDiagnose: params.agentDiagnose,
      authToken: params.authToken,
      visualQa: params.visualQa,
      maxIterations: params.maxIterations,
      onProgress: (msg) => process.stderr.write(`[voice-qa-loop] ${msg}\n`),
    });

    if (result.ok) {
      return { stage: "voice-qa", passed: true, durationMs: Date.now() - start };
    }

    const error = [
      `Voice QA TAO loop: ${result.stopReason} after ${result.iterations} iteration(s)`,
      result.lastReport,
    ].join("\n");

    return { stage: "voice-qa", passed: false, durationMs: Date.now() - start, error };
  } catch (err) {
    return { stage: "voice-qa", passed: false, durationMs: Date.now() - start, error: String(err) };
  }
}
