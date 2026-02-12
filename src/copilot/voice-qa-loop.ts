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
import type { AgentDriver } from "./agent-driver.js";
import type { FeedbackContext } from "./feedback.js";
import type { IterationRecordLike } from "./iteration-briefing.js";
import type { OvernightState } from "./overnight-types.js";
import type { CopilotFeedback, StageResult } from "./types.js";
import type { BehavioralObservation, ProjectWarning } from "./types.js";
import type {
  Diagnosis,
  EnrichedVoiceQaResult,
  ExperienceScorecard,
  IterationContext,
  ScreenshotDescription,
  SourceFile,
} from "./voice-qa-diagnosis.js";
import type { MultiTurnResult, StudentScript, VoiceQaResult, VisualQaConfig } from "./voice-qa.js";
import { qaIterationToRecord } from "../context/adapters/qa-adapter.js";
import { materializeContext } from "../context/materialize.js";
import { ContextStore } from "../context/store.js";
import { TmuxClaudeDriver } from "./agent-driver.js";
import { resolveChromePath } from "./browser-inspect.js";
import {
  createCheckpoint,
  countCheckpointsSince,
  getCurrentHead,
  rollbackToCheckpoint,
  squashCheckpoints,
} from "./checkpoint.js";
import { writeFeedbackToTarget } from "./feedback.js";
import { buildIterationBriefing, serializeBriefingAsSystemPrompt } from "./iteration-briefing.js";
import { tmuxCaptureScrollback } from "./tmux-send.js";
import { runValidationPipeline } from "./validation-gates.js";
import {
  buildBehavioralObservations,
  buildCodeReviewPrompt,
  buildContextualNudge,
  buildLlmDiagnosisPrompt,
  buildOneShotAnalysisPrompt,
  buildPlanReviewPrompt,
  buildSeniorNudgeFallback,
  buildSeniorNudgePrompt,
  diagnose,
  enrichWsEventsFromConsole,
  formatDiagnosisReport,
  matchProjectKnowledge,
  mergeDiagnoses,
  parseLlmDiagnosis,
  parseOneShotResponse,
} from "./voice-qa-diagnosis.js";
import { appendScoreResult, formatTrendReport } from "./voice-qa-trends.js";
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
  /** Pluggable agent driver. When provided, replaces tmux for feedback delivery. */
  agentDriver?: AgentDriver;
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
  /** LLM-powered screenshot description callback. Receives a screenshot path
   *  and a prompt, returns a human-readable description of what's on screen.
   *  Used for the nudge prompt and QA-FEEDBACK.md. */
  agentDescribeScreenshot?: (screenshotPath: string, prompt: string) => Promise<string>;
  /** One-shot multimodal analysis callback. Receives a text prompt and optional
   *  images, returns a response containing both nudge and diagnosis.
   *  When provided, replaces the 3-call pipeline (diagnose + describe + nudge)
   *  with a single multimodal call. */
  agentAnalyze?: (
    prompt: string,
    images?: Array<{ path: string; label: string }>,
  ) => Promise<string>;
  /** Multi-turn student script. When provided, uses multi-turn mode. */
  script?: StudentScript;
  /** Visual QA config for screenshot analysis (multi-turn only). */
  visualQa?: VisualQaConfig;
  /** Prompts for single-prompt mode. Ignored when script is provided. */
  prompts?: string[];
  /** Enable git checkpoints before each agent run. Allows rollback of bad changes on stall. */
  enableCheckpoints?: boolean;
  /** Overnight loop state — passed to iteration briefing for cross-cycle context. */
  overnightState?: OvernightState;
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
  /** Last experience scorecard from one-shot analysis. */
  lastScorecard?: ExperienceScorecard;
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
export type IterationRecord = {
  iteration: number;
  diagnoses: Diagnosis[];
  behavioral: BehavioralObservation[];
  projectWarnings: ProjectWarning[];
  nudgeSent: string;
  observation: IterationObservation | null;
  passed: boolean;
  scorecard?: ExperienceScorecard | null;
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
    responseLatencyMs: t.responseLatencyMs,
    screenshots: t.screenshots,
    canvasChange: t.canvasChange,
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

/** Capture git diff from the target repo. Cascading fallback: committed → staged → unstaged.
 *  Handles repos with zero commits (empty HEAD) gracefully. */
function captureTargetDiff(targetCwd: string): {
  diffStat: string;
  diffFull: string;
  changedFiles: string[];
} {
  const run = (args: string): string => {
    try {
      return execSync(`git ${args}`, {
        cwd: targetCwd,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"], // suppress stderr noise
      }).trim();
    } catch {
      return "";
    }
  };

  // Check if HEAD exists (repo may have zero commits)
  const hasHead = run("rev-parse HEAD") !== "";

  if (hasHead) {
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

  // No HEAD — repo has zero commits. Use git status + unstaged diff.
  const porcelain = run("status --porcelain");
  const changedFiles = porcelain
    ? porcelain
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
    : [];
  const diffFull = run("diff");
  const diffStat = run("diff --stat");

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
        diffSnippet: h.observation?.diffFull?.slice(0, 3000) || undefined,
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

  // Resolve agent driver: explicit > tmux fallback
  const driver: AgentDriver = params.agentDriver ?? new TmuxClaudeDriver(params.tmuxTarget);
  const isLegacyTmux = driver.name === "claude-tmux";

  let lastFingerprint = "";
  let consecutiveStalls = 0;
  let lastReport = "";
  let lastResults: VoiceQaResult[] | undefined;
  let lastMultiTurnResult: MultiTurnResult | undefined;
  let lastScorecard: ExperienceScorecard | undefined;
  const iterationHistory: IterationRecord[] = [];

  // RLM context store — persists full iteration data for rich context access
  const contextStore = new ContextStore();
  const loopId = `qa-${Date.now()}`;

  // Checkpoint state
  const useCheckpoints = params.enableCheckpoints ?? false;
  const baseHead = useCheckpoints ? getCurrentHead(params.targetCwd) : null;
  /** SHA to rollback to when stalled — the checkpoint from before the first stalling iteration. */
  let rollbackSha: string | null = null;
  if (useCheckpoints && baseHead) {
    params.onProgress?.(`Checkpoints enabled. Base HEAD: ${baseHead.slice(0, 8)}`);
  }

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

    // Build behavioral observations + project warnings (needed for all paths)
    const behavioral = allPassed ? [] : buildBehavioralObservations(enriched);
    const prevObs = iterationHistory.at(-1)?.observation;
    let projectWarnings: ProjectWarning[];
    if (prevObs?.diffFull) {
      projectWarnings = matchProjectKnowledge(prevObs.diffFull);
    } else if (params.sourceFiles && params.targetCwd) {
      const sourceContent = params.sourceFiles
        .map((f) => {
          try {
            return fs.readFileSync(path.join(params.targetCwd, f), "utf-8");
          } catch {
            return "";
          }
        })
        .join("\n");
      projectWarnings = matchProjectKnowledge(sourceContent);
    } else {
      projectWarnings = [];
    }

    // === ONE-SHOT PATH: single multimodal call when agentAnalyze is available ===
    let diagnoses: Diagnosis[] = [];
    let nudge = "";
    let oneShotScorecard: ExperienceScorecard | undefined;

    if (!allPassed && params.agentAnalyze) {
      params.onProgress?.(`Running one-shot multimodal analysis (iteration ${i})...`);

      // Static diagnoses for context
      const staticDiagnoses = diagnose(enriched);

      // Load source files
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
            // File not found — skip
          }
        }
      }

      // Build iteration context
      const iterationContext: IterationContext[] = iterationHistory.map((h) => ({
        iteration: h.iteration,
        nudgeSent: h.nudgeSent,
        diffStat: h.observation?.diffStat ?? "",
        changedFiles: h.observation?.changedFiles ?? [],
        tmuxScrollbackTail: (h.observation?.tmuxScrollback ?? "").split("\n").slice(-30).join("\n"),
        diffMatchResult: h.observation?.diffMatchResult ?? "unknown",
        previousDiagnoses: h.diagnoses.map((d) => d.rootCause),
        diffSnippet: h.observation?.diffFull?.slice(0, 3000) || undefined,
      }));

      // Build ONE prompt
      const analysisPrompt = buildOneShotAnalysisPrompt(
        enriched,
        behavioral,
        projectWarnings,
        staticDiagnoses,
        codeFiles.length > 0 ? codeFiles : undefined,
        iterationContext.length > 0 ? iterationContext : undefined,
        i,
        maxIterations,
      );

      // Collect screenshot images for multimodal call
      const images: Array<{ path: string; label: string }> = [];
      for (const r of enriched) {
        if (r.screenshots?.before) {
          images.push({
            path: r.screenshots.before,
            label: `Before: ${r.prompt?.slice(0, 30) ?? "turn"}`,
          });
        }
        if (r.screenshots?.after) {
          images.push({
            path: r.screenshots.after,
            label: `After: ${r.prompt?.slice(0, 30) ?? "turn"}`,
          });
        } else if (r.screenshotPath) {
          images.push({
            path: r.screenshotPath,
            label: `Screenshot: ${r.prompt?.slice(0, 30) ?? "turn"}`,
          });
        }
      }

      try {
        const response = await params.agentAnalyze(
          analysisPrompt,
          images.length > 0 ? images : undefined,
        );
        const parsed = parseOneShotResponse(response);

        // Merge LLM diagnoses with static
        if (parsed.diagnoses.length > 0) {
          diagnoses = mergeDiagnoses(staticDiagnoses, parsed.diagnoses);
        } else {
          diagnoses = staticDiagnoses;
        }

        nudge = parsed.nudge.slice(0, 2000);
        oneShotScorecard = parsed.scorecard;
        params.onProgress?.(
          `One-shot analysis: ${parsed.diagnoses.length} LLM diagnosis(es), nudge ${nudge.length} chars` +
            (oneShotScorecard ? `, score ${oneShotScorecard.overall}/10` : ""),
        );
      } catch (err: unknown) {
        params.onProgress?.(`One-shot analysis failed, falling back: ${String(err)}`);
        diagnoses = staticDiagnoses;
        // Fall through to legacy nudge below
      }
    } else if (!allPassed) {
      // === LEGACY PATH: 3-call pipeline (diagnose + describe + nudge) ===
      diagnoses = await runDiagnosis(enriched, params, i, iterationHistory);
    }

    // Build screenshot descriptions (used by feedback + legacy nudge fallback)
    const screenshotDescs: ScreenshotDescription[] = [];
    const screenshotCandidates = enriched.filter((r) => r.screenshotPath);

    if (!params.agentAnalyze && params.agentDescribeScreenshot && screenshotCandidates.length > 0) {
      // Legacy path: LLM vision for screenshot descriptions
      const SCREENSHOT_PROMPT =
        "Describe this web app screenshot in 2-3 sentences as a QA tester would. " +
        "What buttons are visible? Is the session connected (look for 'Start Session' vs 'End Session')? " +
        "Are there error toasts or warnings? Is the scratchpad canvas showing content or blank? " +
        "Is the 'Enable Audio' button visible/pulsing? Name the actors: Adam = tutor, Maya = student.";
      for (const r of screenshotCandidates) {
        try {
          const desc = await params.agentDescribeScreenshot(r.screenshotPath!, SCREENSHOT_PROMPT);
          screenshotDescs.push({
            turn: r.prompt?.slice(0, 40) ?? "unknown",
            description: desc.trim().slice(0, 500),
            path: r.screenshotPath!,
          });
        } catch (err) {
          params.onProgress?.(`Screenshot vision failed for turn: ${String(err)}`);
          screenshotDescs.push({
            turn: r.prompt?.slice(0, 40) ?? "unknown",
            description:
              r.visualAssessment?.canvasDescription ?? "Vision model failed — see screenshot",
            path: r.screenshotPath!,
          });
        }
      }
      params.onProgress?.(`Vision model described ${screenshotDescs.length} screenshot(s)`);
    } else {
      // Fallback — rule-based descriptions
      for (const r of screenshotCandidates) {
        screenshotDescs.push({
          turn: r.prompt?.slice(0, 40) ?? "unknown",
          description:
            r.visualAssessment?.canvasDescription ??
            (r.pageHealth?.sessionConnected === false
              ? "Session disconnected — page shows 'Start Session' button"
              : r.tutorResponse
                ? "Tutor responded but no visual assessment available"
                : "No tutor response — page state unknown (see screenshot)"),
          path: r.screenshotPath!,
        });
      }
    }

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

      // Squash checkpoint commits on success (clean git history)
      if (useCheckpoints && baseHead && i > 1) {
        const checkpointCount = countCheckpointsSince(params.targetCwd, baseHead);
        if (checkpointCount > 0) {
          params.onProgress?.(
            `Squashing ${checkpointCount} checkpoint commit(s) into one clean commit...`,
          );
          squashCheckpoints(params.targetCwd, baseHead);
        }
      }

      try {
        await driver.sendFeedback("Voice QA PASSED — all prompts answered correctly.");
      } catch {
        // Non-fatal if agent driver fails on success message
      }
      return {
        ok: true,
        iterations: i,
        stopReason: "success",
        lastReport,
        lastResults,
        lastMultiTurnResult,
        iterationHistory,
        lastScorecard,
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
      // Rollback to the checkpoint before the stall started
      if (useCheckpoints && rollbackSha) {
        params.onProgress?.(
          `Stall detected — rolling back to checkpoint ${rollbackSha.slice(0, 8)}`,
        );
        const rolled = rollbackToCheckpoint(params.targetCwd, rollbackSha);
        if (rolled) {
          params.onProgress?.(
            `Rollback successful. Bad changes from stalling iterations reverted.`,
          );
        } else {
          params.onProgress?.(`Rollback failed — manual intervention may be needed.`);
        }
      }

      params.onProgress?.(`Voice QA stuck after ${i} iterations — same error repeating. Stopping.`);
      try {
        await driver.sendFeedback(
          "Voice QA stuck — same error after multiple fix attempts. Manual intervention needed." +
            (useCheckpoints && rollbackSha
              ? " Bad changes have been rolled back to the pre-stall checkpoint."
              : ""),
        );
      } catch {
        // Non-fatal
      }
      return {
        ok: false,
        iterations: i,
        stopReason: "stuck",
        lastReport,
        lastResults,
        lastMultiTurnResult,
        iterationHistory,
        lastScorecard,
      };
    }

    // === ACT: Send nudge to Claude ===
    params.onProgress?.(
      `Voice QA iteration ${i}/${maxIterations}: FAILED — nudging Claude to fix...`,
    );

    // One-shot path already produced the nudge — use it if non-empty
    if (!nudge) {
      // Legacy path: compose nudge from behavioral + diagnoses
      if (params.agentDiagnose && (behavioral.length > 0 || diagnoses.length > 0)) {
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
          nudge = llmNudge.trim().slice(0, 2000);
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
        nudge = buildSeniorNudgeFallback(
          behavioral,
          projectWarnings,
          diagnoses,
          i,
          maxIterations,
          screenshotDescs.length > 0 ? screenshotDescs : undefined,
        );
      } else if (diagnoses.length > 0) {
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
    }
    // Surface scorecard in progress
    if (oneShotScorecard) {
      lastScorecard = oneShotScorecard;
      params.onProgress?.(
        `Khan Academy Score: ${oneShotScorecard.overall}/10 — ` +
          (oneShotScorecard.khanComparison || "no comparison available"),
      );
      // Persist score for trending
      try {
        appendScoreResult(oneShotScorecard, {
          script: isMultiTurn ? (params.script?.name ?? "unknown") : "single-prompt",
          iterations: i,
          passed: false,
          agent: driver.name,
        });
      } catch {
        // Non-fatal
      }
      // Show trend if available
      try {
        const trend = formatTrendReport(
          isMultiTurn ? (params.script?.name ?? "unknown") : "single-prompt",
        );
        if (trend && !trend.includes("No score history")) {
          params.onProgress?.(`Trend: ${trend}`);
        }
      } catch {
        // Non-fatal
      }
    }

    params.onProgress?.(`Nudge text:\n${nudge}`);

    // === CHECKPOINT: snapshot before agent modifies code ===
    if (useCheckpoints) {
      const checkpointSha = createCheckpoint(params.targetCwd, `pre-iteration-${i}`);
      if (checkpointSha) {
        params.onProgress?.(`Checkpoint: ${checkpointSha.slice(0, 8)} (pre-iteration ${i})`);
        // Record the rollback target: the checkpoint before the first stalling iteration
        if (consecutiveStalls === 0) {
          rollbackSha = checkpointSha;
        }
      }
    }

    // === RLM CONTEXT: Materialize rich context files for fresh-context drivers ===
    let contextDir: string | undefined;
    if (driver.setSystemPromptContext && iterationHistory.length > 0) {
      try {
        contextDir = path.join(params.targetCwd, ".qa-context");
        const topDiagnosisId = diagnoses[0]?.id;
        const strategies: import("../context/types.js").MaterializeStrategy[] = [
          { kind: "recency", count: 10 },
        ];
        if (topDiagnosisId) {
          strategies.push({ kind: "tagged", tags: [`diagnosis:${topDiagnosisId}`] });
        }
        await materializeContext(contextStore, loopId, {
          outputDir: contextDir,
          tokenBudget: 4000,
          strategies,
          llmSummarize: params.agentDiagnose,
        });
        params.onProgress?.(`RLM: materialized context to ${contextDir}`);
      } catch (err) {
        params.onProgress?.(`RLM materialize failed (non-fatal): ${String(err)}`);
        contextDir = undefined;
      }
    }

    // === BRIEFING: Set iteration context for fresh-context drivers ===
    if (driver.setSystemPromptContext) {
      const briefingHistory: IterationRecordLike[] = iterationHistory.map((r) => ({
        iteration: r.iteration,
        diagnoses: r.diagnoses.map((d) => ({
          rootCause: d.rootCause,
          suggestedFix: d.suggestedFix,
        })),
        nudgeSent: r.nudgeSent,
        observation: r.observation
          ? {
              changedFiles: r.observation.changedFiles,
              diffMatchResult: r.observation.diffMatchResult,
            }
          : null,
        passed: r.passed,
        scorecard: r.scorecard ?? null,
      }));
      const briefing = buildIterationBriefing(briefingHistory, {
        currentIteration: i,
        maxIterations,
        focusFiles: params.sourceFiles ?? [],
        projectWarnings: projectWarnings.map((w) => w.warning),
        overnightState: params.overnightState,
        contextDir,
      });
      driver.setSystemPromptContext(serializeBriefingAsSystemPrompt(briefing));
    }

    // === ACT: Send feedback via agent driver ===
    const feedbackPath = path.join(params.targetCwd, "QA-FEEDBACK.md");
    try {
      await driver.sendFeedback(nudge, feedbackPath);
    } catch (err) {
      params.onProgress?.(`Agent driver sendFeedback failed: ${String(err)}`);
    }

    // === WAIT: Agent works on fix ===
    const agentResult = await driver.waitForCompletion(claudeTimeoutMs);
    if (agentResult.timedOut) {
      params.onProgress?.(`Agent didn't finish within timeout. Stopping.`);
      return {
        ok: false,
        iterations: i,
        stopReason: "claude-timeout",
        lastReport,
        lastResults,
        lastMultiTurnResult,
        iterationHistory,
        lastScorecard,
      };
    }

    // Plan-mode handling (only relevant for tmux-based drivers)
    if (agentResult.state === "plan-mode" && isLegacyTmux) {
      params.onProgress?.(`Agent is in plan mode — reviewing plan...`);
      const planContent = agentResult.planContent ?? "";
      if (params.agentDiagnose) {
        try {
          const planWarnings = matchProjectKnowledge(planContent);
          const allWarnings = [
            ...projectWarnings,
            ...planWarnings.filter((w) => !projectWarnings.some((pw) => pw.id === w.id)),
          ];
          const reviewPrompt = buildPlanReviewPrompt(planContent, behavioral, allWarnings);
          const review = await params.agentDiagnose(reviewPrompt);
          const reviewText = review.trim().slice(0, 500);
          await driver.sendFeedback(`Quick note on your plan: ${reviewText}`);
          params.onProgress?.(`Sent plan review feedback to agent`);
        } catch (err: unknown) {
          params.onProgress?.(`Plan review failed (non-fatal): ${String(err)}`);
          const planWarnings = matchProjectKnowledge(planContent);
          if (planWarnings.length > 0) {
            const warnText = planWarnings.map((w) => w.warning.split(".")[0]).join(". ");
            try {
              await driver.sendFeedback(`Heads up on your plan: ${warnText}. Keep these in mind.`);
            } catch {
              /* Non-fatal */
            }
          }
        }
      } else {
        const planWarnings = matchProjectKnowledge(planContent);
        if (planWarnings.length > 0) {
          const warnText = planWarnings.map((w) => w.warning.split(".")[0]).join(". ");
          try {
            await driver.sendFeedback(`Heads up on your plan: ${warnText}. Keep these in mind.`);
          } catch {
            /* Non-fatal */
          }
        }
      }

      // Continue waiting for implementation
      const implResult = await driver.waitForCompletion(claudeTimeoutMs);
      if (implResult.timedOut) {
        params.onProgress?.(`Agent didn't finish implementation within timeout. Stopping.`);
        return {
          ok: false,
          iterations: i,
          stopReason: "claude-timeout",
          lastReport,
          lastResults,
          lastMultiTurnResult,
          iterationHistory,
          lastScorecard,
        };
      }
    }

    // Grace period — let file writes settle + verify dev server compiled
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    // === OBSERVE: capture what the agent actually did ===
    params.onProgress?.(`Observing agent's changes (iteration ${i})...`);
    const agentOutput = driver.captureOutput();
    const observation = observeIteration(params.targetCwd, params.tmuxTarget, diagnoses);
    if (agentOutput && !observation.tmuxScrollback) {
      observation.tmuxScrollback = agentOutput;
    }

    // === VERIFY: Run validation pipeline (compile + dev server + tests + score) ===
    {
      const prevScore =
        iterationHistory.length > 0
          ? (iterationHistory[iterationHistory.length - 1].scorecard?.overall ?? null)
          : null;
      const pipelineResult = await runValidationPipeline({
        targetCwd: params.targetCwd,
        appUrl: params.appUrl,
        changedFiles: observation.changedFiles,
        diff: observation.diffFull,
        nudge,
        projectWarnings,
        currentScore: oneShotScorecard?.overall ?? null,
        previousScore: prevScore,
        onProgress: params.onProgress,
      });

      if (!pipelineResult.allPassed) {
        params.onProgress?.(
          `WARNING: Validation pipeline failed. Next QA run may test broken code.`,
        );
      }

      // LLM code review (advisory, separate from blocking pipeline)
      if (i >= 2 && observation.diffFull && params.agentDiagnose) {
        try {
          params.onProgress?.(`Running code review on agent's diff...`);
          const reviewPrompt = buildCodeReviewPrompt(observation.diffFull, nudge, projectWarnings);
          const codeReview = await params.agentDiagnose(reviewPrompt);
          const reviewText = codeReview.trim().slice(0, 500);
          params.onProgress?.(`Code review: ${reviewText}`);
          if (reviewText) {
            observation.tmuxScrollback += `\n[Code Review] ${reviewText}`;
          }
        } catch (err) {
          params.onProgress?.(`Code review failed (non-fatal): ${String(err)}`);
        }
      }
    }

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
      scorecard: oneShotScorecard ?? null,
    });

    // RLM: Store full iteration data (no truncation) for rich context queries
    try {
      const adapted = qaIterationToRecord(
        {
          iteration: i,
          passed: false,
          nudgeSent: nudge,
          diffFull: observation?.diffFull ?? "",
          changedFiles: observation?.changedFiles ?? [],
          diagnoses: diagnoses.map((d) => ({
            id: d.id,
            rootCause: d.rootCause,
            severity: d.severity,
            suggestedFix: d.suggestedFix,
          })),
          consoleLogs: enriched.flatMap((r) => r.consoleLogs),
          consoleErrors: enriched.flatMap((r) => r.consoleErrors),
          wsEvents: enriched.flatMap((r) =>
            r.wsEvents.map((e) => ({
              type: e.type,
              closeCode: e.closeCode,
              payload: e.payload,
            })),
          ),
          scorecard: oneShotScorecard ? { overall: oneShotScorecard.overall } : null,
        },
        loopId,
      );
      contextStore.append(adapted.domain, adapted.scopeKey, adapted.payload, adapted.tags);
    } catch {
      // Non-fatal — context store is additive enrichment
    }
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
    lastScorecard,
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
