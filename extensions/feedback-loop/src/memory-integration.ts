import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { FeedbackLoopConfig } from "openclaw/plugin-sdk";
import type { ReviewResult, CheckResult } from "./orchestrator.js";

export type MemoryContext = {
  config: FeedbackLoopConfig;
  workspaceDir: string;
};

export type FeedbackIssue = {
  severity: "high" | "medium" | "low";
  category: string;
  file?: string;
  line?: number;
  description: string;
  fix?: string;
  status?: "open" | "fixed" | "recurring";
};

export type FeedbackSession = {
  date: string;
  task: string;
  iterations: number;
  approved: boolean;
  issues: FeedbackIssue[];
  fixed: string[];
  stillOpen: string[];
};

/**
 * Load past issues from memory before review.
 * This helps the reviewer avoid letting the same issues recur.
 */
export async function loadPastIssues(ctx: MemoryContext): Promise<string | undefined> {
  const { config, workspaceDir } = ctx;

  if (config.memory?.enabled === false || config.memory?.searchBeforeReview === false) {
    return undefined;
  }

  const historyPath = config.memory?.feedbackHistoryPath ?? "memory/FEEDBACK-HISTORY.md";
  const fullPath = path.isAbsolute(historyPath)
    ? historyPath
    : path.join(workspaceDir, historyPath);

  try {
    const content = await fs.readFile(fullPath, "utf-8");
    console.log(`[feedback-loop] Loaded past issues from ${historyPath}`);

    // Extract recent issues and recurring patterns
    const recentIssues = extractRecentIssues(content);
    const recurringPatterns = extractRecurringPatterns(content);

    if (!recentIssues && !recurringPatterns) {
      return undefined;
    }

    let summary = "";
    if (recurringPatterns) {
      summary += `### RECURRING PATTERNS (Most Important!)\n${recurringPatterns}\n\n`;
    }
    if (recentIssues) {
      summary += `### RECENT ISSUES\n${recentIssues}\n`;
    }

    return summary;
  } catch (err) {
    // File doesn't exist yet - that's fine
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`[feedback-loop] No feedback history found (will create on first review)`);
      return undefined;
    }
    console.log(`[feedback-loop] Error loading feedback history: ${err}`);
    return undefined;
  }
}

/**
 * Load the project checklist/standards if configured.
 */
export async function loadChecklist(ctx: MemoryContext): Promise<string | undefined> {
  const { config, workspaceDir } = ctx;

  const checklistPath = config.checklistPath;
  if (!checklistPath) {
    return undefined;
  }

  const fullPath = path.isAbsolute(checklistPath)
    ? checklistPath
    : path.join(workspaceDir, checklistPath);

  try {
    const content = await fs.readFile(fullPath, "utf-8");
    console.log(`[feedback-loop] Loaded checklist from ${checklistPath}`);
    return content;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`[feedback-loop] Checklist not found at ${checklistPath}`);
      return undefined;
    }
    console.log(`[feedback-loop] Error loading checklist: ${err}`);
    return undefined;
  }
}

/**
 * Save feedback issues to memory after review.
 * This enables learning from past feedback cycles.
 */
export async function saveFeedbackToMemory(
  ctx: MemoryContext,
  session: {
    task: string;
    iterations: number;
    approved: boolean;
    reviewResult: ReviewResult;
    previousIssues?: FeedbackIssue[];
  },
): Promise<void> {
  const { config, workspaceDir } = ctx;

  if (config.memory?.enabled === false || config.memory?.saveAfterReview === false) {
    return;
  }

  const historyPath = config.memory?.feedbackHistoryPath ?? "memory/FEEDBACK-HISTORY.md";
  const fullPath = path.isAbsolute(historyPath)
    ? historyPath
    : path.join(workspaceDir, historyPath);

  // Ensure directory exists
  const dir = path.dirname(fullPath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // Ignore if already exists
  }

  const { task, iterations, approved, reviewResult, previousIssues } = session;

  // Convert review result checks to issues
  const issues = extractIssuesFromReview(reviewResult);

  // Detect which previous issues were fixed
  const fixed = detectFixedIssues(previousIssues ?? [], issues);

  // Detect recurring patterns
  const recurring = detectRecurringPatterns(previousIssues ?? [], issues);

  // Build the session entry
  const entry = formatSessionEntry({
    date: new Date().toISOString().split("T")[0],
    task: task.slice(0, 100),
    iterations,
    approved,
    issues,
    fixed,
    recurring,
  });

  try {
    // Read existing content
    let existingContent = "";
    try {
      existingContent = await fs.readFile(fullPath, "utf-8");
    } catch {
      // File doesn't exist yet, start fresh
      existingContent = "# Feedback History\n\n";
    }

    // Append new entry at the top (after header)
    const headerEnd = existingContent.indexOf("\n\n");
    const header = headerEnd > 0 ? existingContent.slice(0, headerEnd + 2) : "# Feedback History\n\n";
    const rest = headerEnd > 0 ? existingContent.slice(headerEnd + 2) : "";

    // Update recurring patterns section
    const updatedContent = header + entry + "\n" + updateRecurringSection(rest, recurring);

    await fs.writeFile(fullPath, updatedContent, "utf-8");
    console.log(`[feedback-loop] Saved feedback to ${historyPath}`);
  } catch (err) {
    console.log(`[feedback-loop] Error saving feedback: ${err}`);
  }
}

/**
 * Extract issues from a ReviewResult
 */
function extractIssuesFromReview(result: ReviewResult): FeedbackIssue[] {
  const issues: FeedbackIssue[] = [];

  for (const check of result.checks) {
    if (!check.passed) {
      issues.push({
        severity: "medium",
        category: extractCategory(check.command),
        description: check.error ?? check.command,
        file: extractFile(check.error),
        line: extractLine(check.error),
        status: "open",
      });
    }
  }

  // Also parse feedback text for additional issues
  if (result.feedback) {
    const feedbackIssues = parseIssuesFromFeedback(result.feedback);
    issues.push(...feedbackIssues);
  }

  return issues;
}

/**
 * Parse issues from feedback text
 */
function parseIssuesFromFeedback(feedback: string): FeedbackIssue[] {
  const issues: FeedbackIssue[] = [];
  const lines = feedback.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Match: - Issue description (file:line)
    const match = trimmed.match(/^[-*]\s*(.+?)(?:\s*\(([^:]+):(\d+)\))?$/);
    if (match && match[1]) {
      issues.push({
        severity: "medium",
        category: "feedback",
        description: match[1],
        file: match[2],
        line: match[3] ? parseInt(match[3], 10) : undefined,
        status: "open",
      });
    }
  }

  return issues;
}

/**
 * Extract category from check command
 */
function extractCategory(command: string): string {
  const lower = command.toLowerCase();
  if (lower.includes("pytest") || lower.includes("test")) return "testing";
  if (lower.includes("lint") || lower.includes("ruff") || lower.includes("eslint")) return "linting";
  if (lower.includes("type") || lower.includes("mypy") || lower.includes("tsc")) return "types";
  if (lower.includes("browser") || lower.includes("ui")) return "ui";
  if (lower.includes("coverage")) return "coverage";
  return "general";
}

/**
 * Extract file path from error message
 */
function extractFile(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const match = error.match(/([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)/);
  return match ? match[1] : undefined;
}

/**
 * Extract line number from error message
 */
function extractLine(error: string | undefined): number | undefined {
  if (!error) return undefined;
  const match = error.match(/:(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Detect which previous issues were fixed
 */
function detectFixedIssues(previous: FeedbackIssue[], current: FeedbackIssue[]): string[] {
  const fixed: string[] = [];

  for (const prev of previous) {
    const stillExists = current.some(
      (curr) =>
        curr.description.includes(prev.description) ||
        (prev.file && curr.file === prev.file && prev.line && curr.line === prev.line),
    );

    if (!stillExists) {
      fixed.push(prev.description);
    }
  }

  return fixed;
}

/**
 * Detect recurring patterns
 */
function detectRecurringPatterns(previous: FeedbackIssue[], current: FeedbackIssue[]): string[] {
  const recurring: string[] = [];

  for (const curr of current) {
    const wasSeenBefore = previous.some(
      (prev) =>
        prev.category === curr.category ||
        prev.description.toLowerCase().includes(curr.description.toLowerCase().slice(0, 20)),
    );

    if (wasSeenBefore) {
      recurring.push(`${curr.category}: ${curr.description}`);
    }
  }

  return recurring;
}

/**
 * Extract recent issues from history file
 */
function extractRecentIssues(content: string): string | undefined {
  // Find the most recent session section
  const sessionMatch = content.match(/## Session \d{4}-\d{2}-\d{2}[\s\S]*?(?=## Session|\n## Recurring|$)/);
  if (sessionMatch) {
    // Extract just the issues
    const issuesMatch = sessionMatch[0].match(/### Issues Found:[\s\S]*?(?=###|$)/);
    if (issuesMatch) {
      return issuesMatch[0].trim();
    }
  }
  return undefined;
}

/**
 * Extract recurring patterns from history file
 */
function extractRecurringPatterns(content: string): string | undefined {
  const match = content.match(/## Recurring Patterns[\s\S]*?(?=## Session|$)/);
  if (match) {
    return match[0].trim();
  }
  return undefined;
}

/**
 * Format a session entry for the history file
 */
function formatSessionEntry(session: {
  date: string;
  task: string;
  iterations: number;
  approved: boolean;
  issues: FeedbackIssue[];
  fixed: string[];
  recurring: string[];
}): string {
  let entry = `## Session ${session.date}\n`;
  entry += `**Task:** ${session.task}\n`;
  entry += `**Iterations:** ${session.iterations} | **Approved:** ${session.approved ? "Yes" : "No"}\n\n`;

  if (session.issues.length > 0) {
    entry += `### Issues Found:\n`;
    for (const issue of session.issues) {
      entry += `- ${issue.category}: ${issue.description}`;
      if (issue.file) {
        entry += ` (${issue.file}${issue.line ? `:${issue.line}` : ""})`;
      }
      entry += "\n";
    }
    entry += "\n";
  }

  if (session.fixed.length > 0) {
    entry += `### Fixed:\n`;
    for (const fix of session.fixed) {
      entry += `- ✓ ${fix}\n`;
    }
    entry += "\n";
  }

  if (session.recurring.length > 0) {
    entry += `### Recurring (needs attention):\n`;
    for (const rec of session.recurring) {
      entry += `- ⚠️ ${rec}\n`;
    }
    entry += "\n";
  }

  return entry;
}

/**
 * Update the recurring patterns section at the bottom of the file
 */
function updateRecurringSection(content: string, newRecurring: string[]): string {
  // Remove existing recurring section
  const withoutRecurring = content.replace(/## Recurring Patterns[\s\S]*$/, "").trim();

  if (newRecurring.length === 0) {
    return withoutRecurring;
  }

  // Build new recurring section (aggregate all recurring patterns)
  const patterns = new Map<string, number>();

  // Parse existing recurring mentions from content
  const recurringMatches = content.matchAll(/⚠️ ([^\n]+)/g);
  for (const match of recurringMatches) {
    const pattern = match[1];
    patterns.set(pattern, (patterns.get(pattern) ?? 0) + 1);
  }

  // Add new recurring
  for (const rec of newRecurring) {
    patterns.set(rec, (patterns.get(rec) ?? 0) + 1);
  }

  // Format recurring section
  let recurringSection = "\n## Recurring Patterns\n\n";
  const sorted = [...patterns.entries()].sort((a, b) => b[1] - a[1]);
  for (const [pattern, count] of sorted) {
    recurringSection += `- ${pattern} (${count} occurrences)\n`;
  }

  return withoutRecurring + "\n" + recurringSection;
}
