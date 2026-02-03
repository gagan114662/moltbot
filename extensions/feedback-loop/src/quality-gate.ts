/**
 * Quality Gate Module (inspired by pro-workflow)
 *
 * Pre/Post tool use checks for code quality:
 * - Detect console.log, debugger, TODO markers
 * - Check for secrets/credentials
 * - Verify imports
 * - Count edits for quality gate reminders
 */

import fs from "node:fs/promises";

export interface QualityIssue {
  type: "warning" | "error";
  category: string;
  message: string;
  file?: string;
  line?: number;
}

export interface QualityCheckResult {
  passed: boolean;
  issues: QualityIssue[];
  suggestions: string[];
}

// Patterns to detect in code
const CODE_PATTERNS = {
  debugStatements: [
    { pattern: /console\.log\(/g, message: "console.log statement found" },
    { pattern: /console\.debug\(/g, message: "console.debug statement found" },
    { pattern: /debugger;/g, message: "debugger statement found" },
    { pattern: /print\s*\(/g, message: "print statement found (Python)" },
  ],
  todos: [
    { pattern: /\/\/\s*TODO:/gi, message: "TODO comment found" },
    { pattern: /\/\/\s*FIXME:/gi, message: "FIXME comment found" },
    { pattern: /\/\/\s*HACK:/gi, message: "HACK comment found" },
    { pattern: /#\s*TODO:/gi, message: "TODO comment found (Python)" },
  ],
  secrets: [
    { pattern: /['"]sk-[a-zA-Z0-9]{20,}['"]/g, message: "Possible API key detected" },
    { pattern: /password\s*=\s*['"][^'"]+['"]/gi, message: "Hardcoded password detected" },
    { pattern: /api[_-]?key\s*=\s*['"][^'"]+['"]/gi, message: "Hardcoded API key detected" },
    { pattern: /secret\s*=\s*['"][^'"]+['"]/gi, message: "Hardcoded secret detected" },
    { pattern: /token\s*=\s*['"][a-zA-Z0-9_-]{20,}['"]/gi, message: "Possible token detected" },
  ],
  codeSmells: [
    { pattern: /any\s*[,)>]/g, message: "TypeScript 'any' type usage" },
    { pattern: /@ts-ignore/g, message: "@ts-ignore directive found" },
    { pattern: /@ts-nocheck/g, message: "@ts-nocheck directive found" },
    { pattern: /eslint-disable/g, message: "eslint-disable comment found" },
  ],
};

/**
 * Check code content for quality issues
 */
export function checkCodeQuality(
  content: string,
  filePath?: string,
): QualityCheckResult {
  const issues: QualityIssue[] = [];
  const suggestions: string[] = [];

  // Check debug statements
  for (const check of CODE_PATTERNS.debugStatements) {
    const matches = content.match(check.pattern);
    if (matches) {
      issues.push({
        type: "warning",
        category: "debug",
        message: `${check.message} (${matches.length} occurrence${matches.length > 1 ? "s" : ""})`,
        file: filePath,
      });
    }
  }

  // Check TODOs
  for (const check of CODE_PATTERNS.todos) {
    const matches = content.match(check.pattern);
    if (matches) {
      issues.push({
        type: "warning",
        category: "todo",
        message: `${check.message} (${matches.length} occurrence${matches.length > 1 ? "s" : ""})`,
        file: filePath,
      });
    }
  }

  // Check secrets (more serious)
  for (const check of CODE_PATTERNS.secrets) {
    const matches = content.match(check.pattern);
    if (matches) {
      issues.push({
        type: "error",
        category: "security",
        message: check.message,
        file: filePath,
      });
    }
  }

  // Check code smells
  for (const check of CODE_PATTERNS.codeSmells) {
    const matches = content.match(check.pattern);
    if (matches) {
      issues.push({
        type: "warning",
        category: "smell",
        message: `${check.message} (${matches.length} occurrence${matches.length > 1 ? "s" : ""})`,
        file: filePath,
      });
    }
  }

  // Generate suggestions
  if (issues.some((i) => i.category === "debug")) {
    suggestions.push("Remove debug statements before committing");
  }
  if (issues.some((i) => i.category === "todo")) {
    suggestions.push("Address TODOs or create tracking issues");
  }
  if (issues.some((i) => i.category === "security")) {
    suggestions.push("CRITICAL: Remove hardcoded secrets immediately");
  }
  if (issues.some((i) => i.category === "smell")) {
    suggestions.push("Consider addressing code smells for maintainability");
  }

  return {
    passed: !issues.some((i) => i.type === "error"),
    issues,
    suggestions,
  };
}

/**
 * Check a file for quality issues
 */
export async function checkFileQuality(filePath: string): Promise<QualityCheckResult> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return checkCodeQuality(content, filePath);
  } catch {
    return {
      passed: true,
      issues: [],
      suggestions: [],
    };
  }
}

/**
 * Format quality check results for display
 */
export function formatQualityReport(results: QualityCheckResult[]): string {
  const allIssues = results.flatMap((r) => r.issues);
  const allSuggestions = [...new Set(results.flatMap((r) => r.suggestions))];

  if (allIssues.length === 0) {
    return "✅ No quality issues detected";
  }

  const lines: string[] = [];

  // Group by category
  const byCategory = new Map<string, QualityIssue[]>();
  for (const issue of allIssues) {
    const existing = byCategory.get(issue.category) ?? [];
    existing.push(issue);
    byCategory.set(issue.category, existing);
  }

  const errorCount = allIssues.filter((i) => i.type === "error").length;
  const warningCount = allIssues.filter((i) => i.type === "warning").length;

  lines.push(`⚠️ Quality Check: ${errorCount} errors, ${warningCount} warnings`);
  lines.push("");

  for (const [category, issues] of byCategory) {
    const emoji = issues[0].type === "error" ? "🚨" : "⚠️";
    lines.push(`${emoji} **${category.toUpperCase()}**`);
    for (const issue of issues) {
      const location = issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ""})` : "";
      lines.push(`  - ${issue.message}${location}`);
    }
  }

  if (allSuggestions.length > 0) {
    lines.push("");
    lines.push("**Suggestions:**");
    for (const suggestion of allSuggestions) {
      lines.push(`- ${suggestion}`);
    }
  }

  return lines.join("\n");
}

/**
 * Pre-commit quality gate check
 */
export async function runPreCommitGate(
  changedFiles: string[],
): Promise<{ canCommit: boolean; report: string }> {
  const codeFiles = changedFiles.filter((f) =>
    /\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift)$/.test(f),
  );

  const results: QualityCheckResult[] = [];
  for (const file of codeFiles) {
    const result = await checkFileQuality(file);
    results.push(result);
  }

  const hasErrors = results.some((r) => !r.passed);
  const report = formatQualityReport(results);

  return {
    canCommit: !hasErrors,
    report,
  };
}

/**
 * Track edit count for quality gate reminders
 */
export class EditTracker {
  private editCount = 0;
  private lastReminderAt = 0;
  private readonly reminderThreshold = 5; // Remind every N edits

  recordEdit(): void {
    this.editCount++;
  }

  shouldRemind(): boolean {
    if (this.editCount - this.lastReminderAt >= this.reminderThreshold) {
      this.lastReminderAt = this.editCount;
      return true;
    }
    return false;
  }

  getReminderMessage(): string {
    return `[Quality Gate] ${this.editCount} edits made. Consider running: lint, typecheck, test`;
  }

  reset(): void {
    this.editCount = 0;
    this.lastReminderAt = 0;
  }
}
