/**
 * Context Materialization Engine
 *
 * Applies strategies to select context records and write them as
 * markdown/JSON files that LLM subprocesses can read on demand.
 *
 * Strategies (applied in priority order, respecting token budget):
 * - recency: Always include last N records
 * - relevance: Text-match records related to a query
 * - tagged: Filter by tags
 * - summary-window: Summarize older records via LLM
 */

import fs from "node:fs";
import path from "node:path";
import type { ContextStore } from "./store.js";
import type {
  ContextRecord,
  MaterializeOptions,
  MaterializeResult,
  MaterializeStrategy,
} from "./types.js";
import { estimateTokens } from "./store.js";

// ---------------------------------------------------------------------------
// Record formatting
// ---------------------------------------------------------------------------

/** Format a single record as a markdown section. */
function formatRecord(record: ContextRecord): string {
  const meta = record.meta;
  const ts = new Date(meta.timestamp).toISOString();
  const tags = meta.tags.length > 0 ? ` [${meta.tags.join(", ")}]` : "";

  const lines: string[] = [];
  lines.push(`### ${meta.domain} — ${ts}${tags}`);

  if (record.summary) {
    lines.push(record.summary);
  } else {
    // Format payload based on domain
    const payload = record.payload as Record<string, unknown>;
    for (const [key, value] of Object.entries(payload)) {
      if (value === null || value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) {
          continue;
        }
        if (value.length <= 3) {
          lines.push(`**${key}**: ${value.join(", ")}`);
        } else {
          lines.push(`**${key}** (${value.length} items):`);
          for (const item of value.slice(0, 10)) {
            const itemStr = typeof item === "object" ? JSON.stringify(item) : String(item);
            lines.push(`- ${itemStr.slice(0, 200)}`);
          }
          if (value.length > 10) {
            lines.push(`- ... and ${value.length - 10} more`);
          }
        }
      } else if (typeof value === "string" && value.length > 300) {
        lines.push(`**${key}**:`);
        lines.push("```");
        lines.push(value.slice(0, 2000));
        if (value.length > 2000) {
          lines.push(`... (${value.length - 2000} chars truncated)`);
        }
        lines.push("```");
      } else if (typeof value === "object" || typeof value === "undefined") {
        lines.push(`**${key}**: ${JSON.stringify(value)}`);
      } else {
        // Primitives: number, boolean, short string
        lines.push(`**${key}**: ${value as string | number | boolean}`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

/** Format an array of records as markdown. */
export function formatRecordsAsMarkdown(records: ContextRecord[]): string {
  if (records.length === 0) {
    return "*No records.*\n";
  }
  return records.map(formatRecord).join("\n---\n\n");
}

// ---------------------------------------------------------------------------
// Strategy execution
// ---------------------------------------------------------------------------

type SelectedRecords = {
  strategyKind: string;
  records: ContextRecord[];
};

function executeRecencyStrategy(
  store: ContextStore,
  scopeKey: string,
  strategy: Extract<MaterializeStrategy, { kind: "recency" }>,
): SelectedRecords {
  const records = store.query({
    scopeKey,
    order: "newest",
    limit: strategy.count,
  });
  // Reverse so oldest is first in output (chronological reading order)
  return { strategyKind: "recency", records: records.toReversed() };
}

function executeRelevanceStrategy(
  store: ContextStore,
  scopeKey: string,
  strategy: Extract<MaterializeStrategy, { kind: "relevance" }>,
): SelectedRecords {
  const records = store.query({
    scopeKey,
    textSearch: strategy.query,
    limit: strategy.maxResults,
    order: "newest",
  });
  return { strategyKind: "relevance", records };
}

function executeTaggedStrategy(
  store: ContextStore,
  scopeKey: string,
  strategy: Extract<MaterializeStrategy, { kind: "tagged" }>,
): SelectedRecords {
  const records = store.query({
    scopeKey,
    tags: strategy.tags,
    limit: strategy.limit,
    order: "newest",
  });
  return { strategyKind: "tagged", records };
}

function executeSummaryWindowStrategy(
  store: ContextStore,
  scopeKey: string,
  strategy: Extract<MaterializeStrategy, { kind: "summary-window" }>,
): SelectedRecords {
  // Get records OLDER than the window (for summarization)
  const allRecords = store.query({
    scopeKey,
    order: "oldest",
  });

  if (allRecords.length <= strategy.windowSize) {
    // Not enough records to warrant summarization
    return { strategyKind: "summary-window", records: [] };
  }

  // Records outside the recency window (older ones)
  const olderRecords = allRecords.slice(0, allRecords.length - strategy.windowSize);
  return { strategyKind: "summary-window", records: olderRecords };
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

/**
 * Materialize selected context records to disk files.
 *
 * Applies strategies in priority order, respecting the token budget.
 * Each strategy's results are written to a separate file.
 */
export async function materializeContext(
  store: ContextStore,
  scopeKey: string,
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  const { outputDir, tokenBudget, strategies, llmSummarize } = options;

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const files: MaterializeResult["files"] = [];
  let totalTokens = 0;
  const seenIds = new Set<string>();

  for (const strategy of strategies) {
    if (totalTokens >= tokenBudget) {
      break;
    }

    let selected: SelectedRecords;
    switch (strategy.kind) {
      case "recency":
        selected = executeRecencyStrategy(store, scopeKey, strategy);
        break;
      case "relevance":
        selected = executeRelevanceStrategy(store, scopeKey, strategy);
        break;
      case "tagged":
        selected = executeTaggedStrategy(store, scopeKey, strategy);
        break;
      case "summary-window":
        selected = executeSummaryWindowStrategy(store, scopeKey, strategy);
        break;
    }

    // Deduplicate across strategies
    const uniqueRecords = selected.records.filter((r) => {
      if (seenIds.has(r.meta.id)) {
        return false;
      }
      seenIds.add(r.meta.id);
      return true;
    });

    if (uniqueRecords.length === 0) {
      continue;
    }

    // For summary-window: use LLM summarization if available
    let content: string;
    if (strategy.kind === "summary-window" && llmSummarize) {
      const rawMarkdown = formatRecordsAsMarkdown(uniqueRecords);
      const prompt = `Summarize the following context history into a concise narrative (max 500 words). Focus on: what was tried, what worked, what failed, key patterns.\n\n${rawMarkdown.slice(0, 20_000)}`;
      try {
        content = await llmSummarize(prompt);
      } catch {
        // Fallback to raw markdown if LLM fails
        content = formatRecordsAsMarkdown(uniqueRecords);
      }
    } else {
      content = formatRecordsAsMarkdown(uniqueRecords);
    }

    // Trim to token budget
    const contentTokens = estimateTokens(content);
    const remainingBudget = tokenBudget - totalTokens;
    if (contentTokens > remainingBudget) {
      // Truncate content to fit budget
      const maxChars = remainingBudget * 4;
      content = content.slice(0, maxChars) + "\n\n... (truncated to fit token budget)\n";
    }

    const actualTokens = estimateTokens(content);
    const fileName = `context-${selected.strategyKind}.md`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, content);

    files.push({
      path: filePath,
      recordCount: uniqueRecords.length,
      estimatedTokens: actualTokens,
    });
    totalTokens += actualTokens;
  }

  // Write manifest
  const manifest = {
    materializedAt: new Date().toISOString(),
    scopeKey,
    files: files.map((f) => ({
      path: path.basename(f.path),
      recordCount: f.recordCount,
      estimatedTokens: f.estimatedTokens,
    })),
    totalTokens,
    tokenBudget,
  };
  const manifestPath = path.join(outputDir, "context-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { files, totalTokens };
}
