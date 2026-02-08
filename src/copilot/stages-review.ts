/**
 * Review-agent stage: adversarial code review by a second AI agent.
 *
 * Advisory-only — never causes the worker loop to retry.
 * Validates that review findings reference real files/lines from the diff.
 */

import { execSync } from "node:child_process";
import type { StageResult } from "./types.js";
import { agentCliCommand } from "../commands/agent-via-gateway.js";
import { defaultRuntime } from "../runtime.js";

const MAX_DIFF_CHARS = 15_000;
const REVIEW_TIMEOUT_S = 120;

export type ReviewIssue = {
  confidence: "high" | "med" | "low";
  file: string;
  line: number;
  description: string;
  text: string;
};

/** Parse structured review output into validated issues. */
export function parseReviewFindings(
  output: string,
  changedFiles: Set<string>,
  changedHunks: Map<string, Set<number>>,
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  // Match: ISSUE: [high|med|low] <file>:<line> - <description>
  // Also supports old format without confidence: ISSUE: <file>:<line> - <description>
  const issueRe = /^ISSUE:\s*(?:\[(high|med|low)]\s*)?([^:]+):(\d+)\s*-\s*(.+)$/gim;
  let match = issueRe.exec(output);
  while (match) {
    const confidence = (match[1]?.toLowerCase() ?? "med") as ReviewIssue["confidence"];
    const file = match[2].trim();
    const line = Number.parseInt(match[3], 10);
    const description = match[4].trim();

    // Validate: file must be in the diff
    if (!changedFiles.has(file)) {
      match = issueRe.exec(output);
      continue;
    }

    // Validate: line must fall within a changed hunk (±5 line tolerance for context)
    const fileHunks = changedHunks.get(file);
    if (fileHunks) {
      let inRange = false;
      for (const hunkLine of fileHunks) {
        if (Math.abs(hunkLine - line) <= 5) {
          inRange = true;
          break;
        }
      }
      if (!inRange) {
        match = issueRe.exec(output);
        continue;
      }
    }

    issues.push({
      confidence,
      file,
      line,
      description,
      text: `[${confidence}] ${file}:${line} - ${description}`,
    });
    match = issueRe.exec(output);
  }
  return issues;
}

/** Get changed line hunks per file from git diff. */
export function getChangedHunks(cwd: string, baselineRef: string): Map<string, Set<number>> {
  const hunks = new Map<string, Set<number>>();
  try {
    const output = execSync(`git diff --unified=0 ${baselineRef}`, {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
    });

    let currentFile = "";
    for (const line of output.split("\n")) {
      if (line.startsWith("+++ b/")) {
        currentFile = line.slice(6);
        if (!hunks.has(currentFile)) {
          hunks.set(currentFile, new Set());
        }
      } else if (line.startsWith("@@") && currentFile) {
        const hunkMatch = line.match(/\+(\d+)(?:,(\d+))?/);
        if (hunkMatch) {
          const start = Number.parseInt(hunkMatch[1], 10);
          const count = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1;
          const fileSet = hunks.get(currentFile)!;
          for (let i = start; i < start + count; i++) {
            fileSet.add(i);
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return hunks;
}

export type ReviewContext = {
  cwd: string;
  baselineRef: string;
  changedFiles: string[];
  signal: AbortSignal;
  agentId?: string;
  local: boolean;
};

export async function runReviewStage(ctx: ReviewContext): Promise<StageResult> {
  const start = Date.now();

  // Get diff for the review
  let diff: string;
  try {
    diff = execSync(`git diff ${ctx.baselineRef}`, {
      cwd: ctx.cwd,
      encoding: "utf-8",
      timeout: 15_000,
    });
  } catch {
    return {
      stage: "review",
      passed: true,
      durationMs: Date.now() - start,
      error: "Could not get git diff for review",
    };
  }

  if (!diff.trim()) {
    return { stage: "review", passed: true, durationMs: Date.now() - start };
  }

  // Truncate diff
  const truncatedDiff =
    diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n... (truncated)" : diff;

  const systemPrompt = [
    "You are a senior code reviewer performing an adversarial review.",
    "Your job is to find bugs, security issues, and logic errors in the diff below.",
    "",
    "Rules:",
    "- Each issue MUST reference a specific file and line from the diff",
    "- Use EXACTLY this format: ISSUE: [high|med|low] <file>:<line> - <description>",
    "- HIGH = definite bug, crash, or security flaw. MED = likely issue. LOW = suggestion.",
    "- Do NOT report style issues, naming preferences, or minor improvements",
    "- Focus on: correctness bugs, race conditions, security flaws, unhandled edge cases",
    "- If no issues found, say: NO ISSUES FOUND",
    "",
    "DIFF:",
    truncatedDiff,
  ].join("\n");

  try {
    const sessionId = `review-${Date.now()}`;
    const response = await agentCliCommand(
      {
        message: "Review the diff above and report any issues.",
        sessionId,
        thinking: "low",
        timeout: String(REVIEW_TIMEOUT_S),
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

    // Parse and validate findings
    const changedFilesSet = new Set(ctx.changedFiles);
    const changedHunks = getChangedHunks(ctx.cwd, ctx.baselineRef);
    const issues = parseReviewFindings(text, changedFilesSet, changedHunks);

    // Block on high-confidence issues; med/low are advisory
    const highConfidence = issues.filter((i) => i.confidence === "high");
    const advisory = issues.filter((i) => i.confidence !== "high");

    const errorParts: string[] = [];
    if (highConfidence.length > 0) {
      errorParts.push(`Blocking issues:\n${highConfidence.map((i) => i.text).join("\n")}`);
    }
    if (advisory.length > 0) {
      errorParts.push(`Advisory:\n${advisory.map((i) => i.text).join("\n")}`);
    }

    return {
      stage: "review",
      passed: highConfidence.length === 0,
      durationMs: Date.now() - start,
      error: errorParts.length > 0 ? errorParts.join("\n\n") : undefined,
    };
  } catch {
    // Review agent crashed/timed out — pass (can't block on nothing)
    return {
      stage: "review",
      passed: true,
      durationMs: Date.now() - start,
    };
  }
}
