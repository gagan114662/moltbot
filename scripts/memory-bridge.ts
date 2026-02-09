#!/usr/bin/env bun
// CLI entrypoint for memory system operations, called by hooks.
//
// Usage:
//   bun scripts/memory-bridge.ts refresh-digest
//   bun scripts/memory-bridge.ts search "query text"
//   bun scripts/memory-bridge.ts discover <agent> <text>
//   bun scripts/memory-bridge.ts shared-context
//   bun scripts/memory-bridge.ts insights         (daily insights report)
//   bun scripts/memory-bridge.ts suggest-rules   (Phase B — stubbed)

import fs from "node:fs";
import path from "node:path";
import { refreshFailuresDigest } from "../src/memory/failures-digest.js";
import { writeDigestIfChanged } from "../src/memory/failures-digest.js";
import { generateInsights, formatInsightsMarkdown } from "../src/memory/insights.js";
import { refreshSessionDigest } from "../src/memory/session-digest.js";
import {
  readSharedLearned,
  readDiscoveries,
  appendDiscovery,
} from "../src/memory/shared-context.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const MEMORY_DIR = path.join(PROJECT_ROOT, "memory");
const FAILURES_JSONL = path.join(MEMORY_DIR, "failures.jsonl");
const FAILURES_DIGEST = path.join(MEMORY_DIR, "failures-digest.md");
const SESSION_DIGEST = path.join(MEMORY_DIR, "session-digest.md");
const BRIDGE_LOG = path.join(MEMORY_DIR, "bridge.log");
const BRIDGE_LOG_BACKUP = path.join(MEMORY_DIR, "bridge.log.1");
const MAX_LOG_SIZE = 100 * 1024; // 100KB
const MAX_QUERY_LENGTH = 200;
const MAX_SEARCH_RESULTS = 5;

function logError(msg: string): void {
  try {
    rotateBridgeLog();
    const ts = new Date().toISOString();
    fs.appendFileSync(BRIDGE_LOG, `[${ts}] ${msg}\n`, "utf-8");
  } catch {
    // silently ignore logging failures
  }
}

function rotateBridgeLog(): void {
  try {
    if (!fs.existsSync(BRIDGE_LOG)) {
      return;
    }
    const stat = fs.statSync(BRIDGE_LOG);
    if (stat.size > MAX_LOG_SIZE) {
      // Rotate: current → .1 (overwrite old backup)
      if (fs.existsSync(BRIDGE_LOG_BACKUP)) {
        fs.unlinkSync(BRIDGE_LOG_BACKUP);
      }
      fs.renameSync(BRIDGE_LOG, BRIDGE_LOG_BACKUP);
    }
  } catch {
    // ignore rotation errors
  }
}

// --- Commands ---

function cmdRefreshDigest(): void {
  // Refresh failures digest
  const failuresResult = refreshFailuresDigest(FAILURES_JSONL, FAILURES_DIGEST);
  if (failuresResult.written) {
    logError(
      `refresh-digest: failures-digest.md updated (${failuresResult.entries} entries, ${failuresResult.clusters} clusters)`,
    );
  }

  // Refresh session digest
  const sessionResult = refreshSessionDigest(SESSION_DIGEST);
  if (sessionResult.written) {
    logError(`refresh-digest: session-digest.md updated (${sessionResult.sessions} sessions)`);
  }
}

/**
 * Simple keyword search over .md files in the memory directory.
 * Searches line-by-line, returns top MAX_SEARCH_RESULTS matches
 * in the format: [file:line] snippet
 */
function cmdSearch(query: string): void {
  const truncatedQuery = query.slice(0, MAX_QUERY_LENGTH);
  // Extract keywords (3+ chars, lowercase, unique)
  const keywords = [
    ...new Set(
      truncatedQuery
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3),
    ),
  ];
  if (keywords.length === 0) {
    return;
  }

  const results: Array<{ file: string; line: number; text: string; score: number }> = [];

  // Scan all .md files in memory/
  const mdFiles: string[] = [];
  try {
    for (const name of fs.readdirSync(MEMORY_DIR)) {
      if (name.endsWith(".md")) {
        mdFiles.push(path.join(MEMORY_DIR, name));
      }
    }
    // Also check memory/shared/
    const sharedDir = path.join(MEMORY_DIR, "shared");
    if (fs.existsSync(sharedDir)) {
      for (const name of fs.readdirSync(sharedDir)) {
        if (name.endsWith(".md")) {
          mdFiles.push(path.join(sharedDir, name));
        }
      }
    }
  } catch {
    return;
  }

  for (const filePath of mdFiles) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) {
          continue;
        }
        const lower = line.toLowerCase();
        // Count keyword hits in this line
        let score = 0;
        for (const kw of keywords) {
          if (lower.includes(kw)) {
            score++;
          }
        }
        if (score > 0) {
          const relFile = path.relative(MEMORY_DIR, filePath);
          results.push({
            file: relFile,
            line: i + 1,
            text: line.trim().slice(0, 120),
            score,
          });
        }
      }
    } catch {
      continue;
    }
  }

  // Sort by score desc, take top N
  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, MAX_SEARCH_RESULTS);
  for (const r of top) {
    console.log(`[${r.file}:${r.line}] ${r.text}`);
  }
}

function cmdDiscover(agent: string, text: string): void {
  appendDiscovery(MEMORY_DIR, agent, text);
}

function cmdSharedContext(): void {
  const learned = readSharedLearned(MEMORY_DIR, 50);
  const discoveries = readDiscoveries(MEMORY_DIR, 10);

  if (learned) {
    console.log("## Shared Rules (cross-agent)");
    console.log(learned);
    console.log("");
  }
  if (discoveries) {
    console.log("## Recent Discoveries");
    console.log(discoveries);
    console.log("");
  }
}

const INSIGHTS_PATH = path.join(MEMORY_DIR, "INSIGHTS.md");

function cmdInsights(): void {
  // Refresh digests first so we have latest data
  cmdRefreshDigest();

  const report = generateInsights(FAILURES_JSONL);
  const markdown = formatInsightsMarkdown(report);
  const written = writeDigestIfChanged(INSIGHTS_PATH, markdown);

  // Learn from insights: append DoD gaps as discoveries
  for (const gap of report.dodGaps) {
    appendDiscovery(MEMORY_DIR, "insights-cron", gap);
  }

  if (written) {
    logError(
      `insights: INSIGHTS.md updated (${report.sessionCount} sessions, ${report.failureCount} failures, ${report.dodGaps.length} gaps, ${report.recommendations.length} recs)`,
    );
  }

  // Print to stdout for cron logs
  console.log(markdown);
}

function cmdSuggestRules(): void {
  // Phase B stub — will be implemented once digests are stable
  logError("suggest-rules: Phase B — not yet implemented");
}

// --- Main ---

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "refresh-digest":
      cmdRefreshDigest();
      break;
    case "search":
      cmdSearch(args.join(" "));
      break;
    case "discover":
      if (args.length < 2) {
        console.error("Usage: memory-bridge.ts discover <agent> <text>");
        process.exit(1);
      }
      cmdDiscover(args[0] ?? "", args.slice(1).join(" "));
      break;
    case "shared-context":
      cmdSharedContext();
      break;
    case "insights":
      cmdInsights();
      break;
    case "suggest-rules":
      cmdSuggestRules();
      break;
    default:
      console.error(
        `Unknown command: ${command}\nUsage: memory-bridge.ts <refresh-digest|search|discover|shared-context|insights|suggest-rules>`,
      );
      process.exit(1);
  }
} catch (err) {
  logError(`${command}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
