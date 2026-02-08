/**
 * Deep UX evaluation stage for the copilot pipeline.
 *
 * Spawns an AI agent with browser tools that navigates the running app,
 * tests user flows against acceptance criteria, and produces a structured
 * report with verdict + findings + summary.
 *
 * Used by both `/work` (autonomous fix loop) and `/qa` (standalone QA).
 */

import type { StageResult } from "./types.js";
import { agentCliCommand } from "../commands/agent-via-gateway.js";
import { defaultRuntime } from "../runtime.js";
import { truncateError } from "./feedback.js";
import { detectDevServer } from "./video-verify.js";

const DEFAULT_STEPS = 10;
const DEFAULT_SAMPLE = 5;
const UX_EVAL_TIMEOUT_S = 180;
const PER_FLOW_TIMEOUT_NOTE = "60s per step";

export type UxEvalContext = {
  /** Working directory */
  cwd: string;
  /** The task / acceptance criteria to evaluate against */
  criteria: string;
  /** App URL (auto-detected if omitted) */
  appUrl?: string;
  /** Abort signal */
  signal: AbortSignal;
  /** Max interaction steps (clicks, navigations, form fills) */
  maxSteps?: number;
  /** Sample size for matrix testing */
  sample?: number;
  /** Agent ID */
  agentId?: string;
  /** Run locally (not via gateway) */
  local: boolean;
};

export type UxFinding = {
  severity: "critical" | "major" | "minor";
  description: string;
};

export type UxEvalResult = {
  verdict: "pass" | "fail" | "partial";
  findings: UxFinding[];
  summary: string;
};

/** Parse the structured output from the UX eval agent */
export function parseUxEvalOutput(output: string): UxEvalResult {
  let verdict: UxEvalResult["verdict"] = "fail";
  const findings: UxFinding[] = [];
  let summary = "";

  // Parse VERDICT line
  const verdictMatch = output.match(/^VERDICT:\s*(pass|fail|partial)/im);
  if (verdictMatch) {
    verdict = verdictMatch[1].toLowerCase() as UxEvalResult["verdict"];
  }

  // Parse FINDING lines
  const findingRe = /^FINDING:\s*\[(critical|major|minor)]\s*-\s*(.+)$/gim;
  let match = findingRe.exec(output);
  while (match) {
    findings.push({
      severity: match[1].toLowerCase() as UxFinding["severity"],
      description: match[2].trim(),
    });
    match = findingRe.exec(output);
  }

  // Parse SUMMARY (everything after "SUMMARY:" until end or next section)
  const summaryMatch = output.match(/^SUMMARY:\s*(.+(?:\n(?!VERDICT:|FINDING:).+)*)/im);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  // If no structured output, use the raw text as summary
  if (!summary && !verdictMatch && findings.length === 0) {
    summary = output.slice(0, 1000).trim();
    // Try to infer verdict from raw text
    if (/\b(fail|broken|error|crash|hang|stuck|timeout)\b/i.test(output)) {
      verdict = "fail";
    } else if (/\b(partial|some|intermittent)\b/i.test(output)) {
      verdict = "partial";
    }
  }

  return { verdict, findings, summary };
}

/** Format UX eval result as a human-readable report */
export function formatUxReport(result: UxEvalResult): string {
  const lines: string[] = [];

  const verdictLabel =
    result.verdict === "pass"
      ? "PASS"
      : result.verdict === "partial"
        ? `PARTIAL (${result.findings.length} issue${result.findings.length !== 1 ? "s" : ""} found)`
        : `FAIL (${result.findings.length} issue${result.findings.length !== 1 ? "s" : ""} found)`;
  lines.push(`VERDICT: ${verdictLabel}`);

  if (result.findings.length > 0) {
    lines.push("");
    for (const f of result.findings) {
      lines.push(`${f.severity.toUpperCase()}: ${f.description}`);
    }
  }

  if (result.summary) {
    lines.push("", `SUMMARY: ${result.summary}`);
  }

  // Add "What to fix" section for critical/major findings
  const actionable = result.findings.filter((f) => f.severity !== "minor");
  if (actionable.length > 0) {
    lines.push("", "What to fix:");
    for (let i = 0; i < actionable.length; i++) {
      lines.push(`${i + 1}. ${actionable[i].description}`);
    }
  }

  return lines.join("\n");
}

function buildUxEvalSystemPrompt(
  criteria: string,
  appUrl: string,
  maxSteps: number,
  sample: number,
): string {
  return [
    "You are a QA engineer testing a web app on localhost.",
    "Your job is to evaluate the ACTUAL USER EXPERIENCE against these acceptance criteria.",
    "",
    "ACCEPTANCE CRITERIA:",
    criteria,
    "",
    "APP URL: " + appUrl,
    "",
    "Instructions:",
    `1. Navigate to ${appUrl} using the browser tool`,
    "2. Test the primary user flows described in the criteria",
    "3. Evaluate content quality, interaction patterns, and UX",
    "4. Take screenshots at key points for evidence",
    "5. Be HONEST — if it doesn't match the criteria, say so specifically",
    "6. For each issue, describe: what you expected vs what you saw",
    "",
    "Constraints:",
    `- Maximum ${maxSteps} interaction steps (each click/navigate/fill = 1 step)`,
    `- If testing a matrix (multiple ages/topics/etc), sample ${sample} diverse combos`,
    `- Each step has a ${PER_FLOW_TIMEOUT_NOTE} limit — if a page hangs, report it and move on`,
    "- Inject CSS to disable animations: * { animation: none !important; transition: none !important; }",
    "",
    "Report format (use EXACTLY this structure):",
    "VERDICT: pass|fail|partial",
    "FINDING: [critical|major|minor] - <description>",
    "FINDING: [critical|major|minor] - <description>",
    "SUMMARY: <plain-English honest assessment of the user experience>",
    "",
    "Use CRITICAL for: crashes, hangs, broken flows, missing core functionality",
    "Use MAJOR for: wrong content, poor UX, accessibility failures, slow loads (>10s)",
    "Use MINOR for: visual glitches, alignment, non-blocking cosmetic issues",
  ].join("\n");
}

/** Run deep UX evaluation stage */
export async function runUxEvalStage(
  ctx: UxEvalContext,
): Promise<StageResult & { uxResult?: UxEvalResult }> {
  const start = Date.now();
  const maxSteps = ctx.maxSteps ?? DEFAULT_STEPS;
  const sample = ctx.sample ?? DEFAULT_SAMPLE;

  // Detect app URL
  const appUrl = ctx.appUrl ?? (await detectDevServer());
  if (!appUrl) {
    return {
      stage: "ux-eval",
      passed: true,
      durationMs: Date.now() - start,
      error: "No dev server detected (skipped)",
    };
  }

  const systemPrompt = buildUxEvalSystemPrompt(ctx.criteria, appUrl, maxSteps, sample);

  try {
    const sessionId = `ux-eval-${Date.now()}`;
    const response = await agentCliCommand(
      {
        message: `Test the app at ${appUrl} against the acceptance criteria. Navigate, interact, and evaluate the actual user experience.`,
        agent: ctx.agentId,
        sessionId,
        thinking: "low",
        timeout: String(UX_EVAL_TIMEOUT_S),
        local: ctx.local,
        json: true,
        extraSystemPrompt: systemPrompt,
      },
      defaultRuntime,
    );

    const result = response as
      | { result?: { payloads?: Array<{ text?: string }> }; summary?: string }
      | undefined;
    const text =
      result?.result?.payloads
        ?.map((p) => p.text)
        .filter(Boolean)
        .join("\n") ??
      result?.summary ??
      "";

    const uxResult = parseUxEvalOutput(text);
    const passed = uxResult.verdict === "pass";

    return {
      stage: "ux-eval",
      passed,
      durationMs: Date.now() - start,
      error: !passed ? formatUxReport(uxResult) : undefined,
      uxResult,
    };
  } catch (err) {
    if (ctx.signal.aborted) {
      return {
        stage: "ux-eval",
        passed: false,
        durationMs: Date.now() - start,
        error: "Cancelled",
      };
    }
    return {
      stage: "ux-eval",
      passed: false,
      durationMs: Date.now() - start,
      error: truncateError(`UX eval agent failed: ${String(err)}`),
    };
  }
}
