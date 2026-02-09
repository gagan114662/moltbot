// Generates actionable insights from session logs + failure patterns.
// Called daily via cron or manually via `npx tsx scripts/memory-bridge.ts insights`.
//
// Output: memory/INSIGHTS.md (overwritten each run)

import fs from "node:fs";
import path from "node:path";
import { parseFailuresJsonl, clusterFailures, type FailureCluster } from "./failures-digest.js";
import { resolveSessionsDirs, parseSessionLog } from "./session-digest.js";

type SessionSummary = {
  id: string;
  agent: string;
  date: string;
  task: string;
  toolCounts: Map<string, number>;
  failureCounts: Map<string, number>;
  messageCount: number;
};

type InsightsReport = {
  generated: string;
  sessionCount: number;
  failureCount: number;
  topTasks: Array<{ task: string; agent: string; toolTotal: number; date: string }>;
  timeSinks: Array<{ tool: string; total: number }>;
  mostlyDoneRate: { total: number; withFailures: number; rate: string };
  failureClusters: FailureCluster[];
  dodGaps: string[];
  recommendations: string[];
};

function collectSessions(limit: number): SessionSummary[] {
  const dirs = resolveSessionsDirs();
  const files: Array<{ path: string; mtimeMs: number }> = [];

  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) {
          continue;
        }
        const fullPath = path.join(dir, name);
        const stat = fs.statSync(fullPath);
        files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      }
    } catch {
      continue;
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const summaries: SessionSummary[] = [];
  for (const f of files.slice(0, limit)) {
    const s = parseSessionLog(f.path);
    if (s) {
      summaries.push(s);
    }
  }
  return summaries;
}

function computeTopTasks(sessions: SessionSummary[], limit: number): InsightsReport["topTasks"] {
  return sessions
    .map((s) => ({
      task: s.task.slice(0, 100),
      agent: s.agent,
      toolTotal: [...s.toolCounts.values()].reduce((a, b) => a + b, 0),
      date: s.date,
    }))
    .sort((a, b) => b.toolTotal - a.toolTotal)
    .slice(0, limit);
}

function computeTimeSinks(sessions: SessionSummary[]): InsightsReport["timeSinks"] {
  const totals = new Map<string, number>();
  for (const s of sessions) {
    for (const [tool, count] of s.toolCounts) {
      totals.set(tool, (totals.get(tool) ?? 0) + count);
    }
  }
  return [...totals.entries()]
    .map(([tool, total]) => ({ tool, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
}

function computeMostlyDoneRate(sessions: SessionSummary[]): InsightsReport["mostlyDoneRate"] {
  const total = sessions.length;
  const withFailures = sessions.filter((s) => s.failureCounts.size > 0).length;
  const rate = total > 0 ? `${Math.round((withFailures / total) * 100)}%` : "N/A";
  return { total, withFailures, rate };
}

function computeDodGaps(clusters: FailureCluster[], sessions: SessionSummary[]): string[] {
  const gaps: string[] = [];

  // Check for repeated test failures (suggests missing test coverage)
  const bashExitFailures = clusters.find(
    (c) => c.tool === "Bash" && c.pattern.includes("Exit code 1") && c.count >= 5,
  );
  if (bashExitFailures) {
    gaps.push(
      `Bash exit-code-1 failures (${bashExitFailures.count}x) suggest tests failing repeatedly — add regression tests for common failure paths`,
    );
  }

  // Check for Read EISDIR (trying to read directories)
  const eisdirFailures = clusters.find((c) => c.tool === "Read" && c.pattern.includes("EISDIR"));
  if (eisdirFailures) {
    gaps.push(
      `Read EISDIR errors (${eisdirFailures.count}x) — agents try to read directories as files. Add a LEARNED rule: "verify path is a file before reading"`,
    );
  }

  // Check for token limit failures
  const tokenFailures = clusters.find((c) => c.tool === "Read" && c.pattern.includes("tokens"));
  if (tokenFailures) {
    gaps.push(
      `Read token-limit errors (${tokenFailures.count}x) — use offset/limit for large files. Add a LEARNED rule about chunked reading`,
    );
  }

  // Check for WebFetch 403/404 patterns
  const webFetchFailures = clusters.filter((c) => c.tool === "WebFetch" && c.count >= 3);
  if (webFetchFailures.length > 0) {
    const total = webFetchFailures.reduce((sum, c) => sum + c.count, 0);
    gaps.push(
      `WebFetch failures (${total}x) — consider adding URL validation or fallback strategies`,
    );
  }

  // Check for sessions with zero tool calls (might be stalled)
  const stalledSessions = sessions.filter((s) => s.toolCounts.size === 0 && s.messageCount > 0);
  if (stalledSessions.length > 0) {
    gaps.push(
      `${stalledSessions.length} sessions had user messages but no tool calls — possible context or routing issues`,
    );
  }

  return gaps;
}

function computeRecommendations(clusters: FailureCluster[], sessions: SessionSummary[]): string[] {
  const recs: string[] = [];

  // Recommend new agents based on task patterns
  const agents = new Set(sessions.map((s) => s.agent));
  if (!agents.has("tester") && clusters.length > 5) {
    recs.push(
      "Consider adding a dedicated 'tester' agent — high failure count suggests verification needs its own agent",
    );
  }

  // Recommend workflows based on tool usage
  const totalExec = sessions.reduce(
    (sum, s) => sum + (s.toolCounts.get("exec") ?? s.toolCounts.get("Bash") ?? 0),
    0,
  );
  const totalRead = sessions.reduce(
    (sum, s) => sum + (s.toolCounts.get("read") ?? s.toolCounts.get("Read") ?? 0),
    0,
  );
  if (totalExec > totalRead * 3) {
    recs.push(
      "High exec-to-read ratio — agents may be trial-and-erroring instead of reading code first. Reinforce 'read before edit' rule",
    );
  }

  // Recommend based on failure recurrence
  const recurringFailures = clusters.filter((c) => c.distinctDays >= 3);
  if (recurringFailures.length > 0) {
    recs.push(
      `${recurringFailures.length} failure patterns recur across 3+ days — promote these to LEARNED.md rules (Phase B auto-rule generation)`,
    );
  }

  // Recommend memory search if sessions repeat similar tasks
  const taskPrefixes = sessions.map((s) => s.task.slice(0, 40));
  const prefixCounts = new Map<string, number>();
  for (const p of taskPrefixes) {
    prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
  }
  const repeatedTasks = [...prefixCounts.entries()].filter(([, c]) => c >= 3);
  if (repeatedTasks.length > 0) {
    recs.push(
      `${repeatedTasks.length} task patterns repeat 3+ times — consider creating skills or templates for these`,
    );
  }

  return recs;
}

export function generateInsights(failuresJsonlPath: string, sessionLimit = 50): InsightsReport {
  const sessions = collectSessions(sessionLimit);
  const failures = parseFailuresJsonl(failuresJsonlPath);
  const clusters = clusterFailures(failures);

  return {
    generated: new Date().toISOString(),
    sessionCount: sessions.length,
    failureCount: failures.length,
    topTasks: computeTopTasks(sessions, 5),
    timeSinks: computeTimeSinks(sessions),
    mostlyDoneRate: computeMostlyDoneRate(sessions),
    failureClusters: clusters.slice(0, 10),
    dodGaps: computeDodGaps(clusters, sessions),
    recommendations: computeRecommendations(clusters, sessions),
  };
}

export function formatInsightsMarkdown(report: InsightsReport): string {
  const lines: string[] = [
    "# Insights Report (auto-generated)",
    "",
    `Generated: ${report.generated}`,
    `Sessions analyzed: ${report.sessionCount} | Failures: ${report.failureCount}`,
    "",
  ];

  // Top tasks
  lines.push("## Top Tasks (by tool usage)");
  lines.push("");
  if (report.topTasks.length === 0) {
    lines.push("No sessions found.");
  } else {
    for (const t of report.topTasks) {
      lines.push(`- **${t.agent}** (${t.date}): ${t.task} — ${t.toolTotal} tool calls`);
    }
  }
  lines.push("");

  // Time sinks
  lines.push("## Time Sinks (most-used tools)");
  lines.push("");
  for (const t of report.timeSinks) {
    lines.push(`- ${t.tool}: ${t.total} calls`);
  }
  lines.push("");

  // Mostly-done rate
  lines.push("## Completion Quality");
  lines.push("");
  lines.push(
    `- Sessions with failures: ${report.mostlyDoneRate.withFailures}/${report.mostlyDoneRate.total} (${report.mostlyDoneRate.rate})`,
  );
  lines.push("");

  // Failure clusters
  lines.push("## Top Failure Patterns");
  lines.push("");
  if (report.failureClusters.length === 0) {
    lines.push("No failures recorded.");
  } else {
    for (const c of report.failureClusters) {
      lines.push(
        `- **${c.tool}**: ${c.pattern} (${c.count}x, ${c.distinctDays} days, last: ${c.lastSeen.slice(0, 10)})`,
      );
    }
  }
  lines.push("");

  // DoD gaps
  if (report.dodGaps.length > 0) {
    lines.push("## DoD Gaps (suggested fixes)");
    lines.push("");
    for (const gap of report.dodGaps) {
      lines.push(`- ${gap}`);
    }
    lines.push("");
  }

  // Recommendations
  if (report.recommendations.length > 0) {
    lines.push("## Recommendations");
    lines.push("");
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
