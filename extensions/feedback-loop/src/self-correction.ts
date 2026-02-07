/**
 * Self-Correction Module (inspired by pro-workflow)
 *
 * Implements the self-correcting memory pattern:
 * - Extracts lessons from corrections
 * - Adds to LEARNED section automatically
 * - Tracks patterns across sessions
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface LearnedRule {
  category: string;
  rule: string;
  source: "correction" | "review" | "manual";
  timestamp: string;
  frequency?: number;
}

export interface CorrectionPattern {
  mistake: string;
  correction: string;
  category: string;
  rule?: string;
}

// Categories for learned rules
export const LEARNED_CATEGORIES = [
  "Navigation", // File paths, finding code
  "Editing", // Code changes, patterns
  "Testing", // Test approaches
  "Git", // Commits, branches
  "Quality", // Lint, types, style
  "Context", // When to clarify
  "Integration", // Component integration
  "Architecture", // Design decisions
] as const;

/**
 * Extract lessons from reviewer feedback
 */
export function extractLessons(feedback: string): CorrectionPattern[] {
  const patterns: CorrectionPattern[] = [];

  // Pattern 1: Explicit correction markers
  const explicitMatches = feedback.matchAll(/\[LEARN\]\s*(\w+):\s*(.+?)(?:\n|$)/gi);
  for (const match of explicitMatches) {
    patterns.push({
      mistake: "From review feedback",
      correction: match[2].trim(),
      category: match[1],
      rule: match[2].trim(),
    });
  }

  // Pattern 2: Common issue keywords
  const issuePatterns = [
    {
      regex: /not integrated|demo page|not used/i,
      category: "Integration",
      rule: "Integrate into existing pages, not demo files",
    },
    {
      regex: /wrong (file|path|directory)/i,
      category: "Navigation",
      rule: "Verify full path before editing",
    },
    {
      regex: /type error|typescript|type mismatch/i,
      category: "Quality",
      rule: "Run type check before completing",
    },
    {
      regex: /test fail|tests? (fail|broken)/i,
      category: "Testing",
      rule: "Run tests before marking complete",
    },
    {
      regex: /missing import|import error/i,
      category: "Editing",
      rule: "Verify imports after adding dependencies",
    },
    {
      regex: /console\.log|debugger|TODO/i,
      category: "Quality",
      rule: "Remove debug statements before commit",
    },
    {
      regex: /didn't ask|should have asked|clarify/i,
      category: "Context",
      rule: "Ask for clarification when requirements unclear",
    },
  ];

  for (const pattern of issuePatterns) {
    if (pattern.regex.test(feedback)) {
      patterns.push({
        mistake: `Detected pattern: ${pattern.regex.source}`,
        correction: pattern.rule,
        category: pattern.category,
        rule: pattern.rule,
      });
    }
  }

  return patterns;
}

/**
 * Format a rule for the LEARNED section
 */
export function formatLearnedRule(pattern: CorrectionPattern): string {
  return `- **${pattern.category}**: ${pattern.rule || pattern.correction}`;
}

/**
 * Load existing LEARNED rules from a file
 */
export async function loadLearnedRules(filePath: string): Promise<LearnedRule[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const rules: LearnedRule[] = [];

    // Parse markdown format: ## LEARNED\n- **Category**: Rule
    const learnedSection = content.match(/## LEARNED[\s\S]*?(?=\n##|$)/i);
    if (!learnedSection) {
      return rules;
    }

    const ruleMatches = learnedSection[0].matchAll(/- \*\*(\w+)\*\*:\s*(.+?)(?:\n|$)/g);

    for (const match of ruleMatches) {
      rules.push({
        category: match[1],
        rule: match[2].trim(),
        source: "manual",
        timestamp: new Date().toISOString(),
      });
    }

    return rules;
  } catch {
    return [];
  }
}

/**
 * Save learned rules to LEARNED.md
 */
export async function saveLearnedRules(filePath: string, rules: LearnedRule[]): Promise<void> {
  // Group by category
  const byCategory = new Map<string, LearnedRule[]>();
  for (const rule of rules) {
    const existing = byCategory.get(rule.category) ?? [];
    existing.push(rule);
    byCategory.set(rule.category, existing);
  }

  // Build content
  const lines = ["# LEARNED", "", "Auto-captured lessons from feedback loop sessions.", ""];

  for (const category of LEARNED_CATEGORIES) {
    const categoryRules = byCategory.get(category);
    if (categoryRules && categoryRules.length > 0) {
      lines.push(`## ${category}`);
      for (const rule of categoryRules) {
        lines.push(`- ${rule.rule}`);
      }
      lines.push("");
    }
  }

  // Also include any custom categories
  for (const [category, categoryRules] of byCategory) {
    if (!LEARNED_CATEGORIES.includes(category as (typeof LEARNED_CATEGORIES)[number])) {
      lines.push(`## ${category}`);
      for (const rule of categoryRules) {
        lines.push(`- ${rule.rule}`);
      }
      lines.push("");
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.join("\n"));
}

/**
 * Append new rules to an existing LEARNED file
 */
export async function appendLearnedRules(
  filePath: string,
  newPatterns: CorrectionPattern[],
): Promise<number> {
  if (newPatterns.length === 0) {
    return 0;
  }

  // Load existing rules
  const existing = await loadLearnedRules(filePath);
  const existingRules = new Set(existing.map((r) => r.rule.toLowerCase()));

  // Filter out duplicates
  const uniquePatterns = newPatterns.filter(
    (p) => p.rule && !existingRules.has(p.rule.toLowerCase()),
  );

  if (uniquePatterns.length === 0) {
    return 0;
  }

  // Convert to LearnedRule format
  const newRules: LearnedRule[] = uniquePatterns.map((p) => ({
    category: p.category,
    rule: p.rule ?? p.correction,
    source: "correction" as const,
    timestamp: new Date().toISOString(),
  }));

  // Merge and save
  const allRules = [...existing, ...newRules];
  await saveLearnedRules(filePath, allRules);

  return newRules.length;
}

/**
 * Build context string from learned rules for injection into prompts
 */
export function buildLearnedContext(rules: LearnedRule[]): string {
  if (rules.length === 0) {
    return "";
  }

  const lines = ["## LEARNED PATTERNS (from past sessions)", ""];

  // Group by category and take most recent/frequent
  const byCategory = new Map<string, string[]>();
  for (const rule of rules) {
    const existing = byCategory.get(rule.category) ?? [];
    if (!existing.includes(rule.rule)) {
      existing.push(rule.rule);
    }
    byCategory.set(rule.category, existing);
  }

  for (const [category, categoryRules] of byCategory) {
    lines.push(`**${category}:**`);
    for (const rule of categoryRules.slice(0, 5)) {
      // Limit to 5 per category
      lines.push(`- ${rule}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Analyze iteration history to identify recurring issues
 */
export function analyzeRecurringIssues(
  history: Array<{ reviewResult: { feedback?: string } }>,
): CorrectionPattern[] {
  const allPatterns: CorrectionPattern[] = [];

  for (const iteration of history) {
    if (iteration.reviewResult.feedback) {
      const patterns = extractLessons(iteration.reviewResult.feedback);
      allPatterns.push(...patterns);
    }
  }

  // Count frequency
  const frequency = new Map<string, number>();
  for (const pattern of allPatterns) {
    const key = pattern.rule ?? pattern.correction;
    frequency.set(key, (frequency.get(key) ?? 0) + 1);
  }

  // Return patterns that occurred more than once
  return allPatterns.filter((p) => {
    const key = p.rule ?? p.correction;
    return (frequency.get(key) ?? 0) > 1;
  });
}
