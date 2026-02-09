import crypto from "node:crypto";
/**
 * Converts memory/failures.jsonl into memory/failures-digest.md
 * so the existing memory indexer (which only indexes .md files) can search it.
 */
import fs from "node:fs";

export type FailureEntry = {
  timestamp: string;
  tool: string;
  error: string;
  input: Record<string, unknown>;
};

export type FailureCluster = {
  tool: string;
  pattern: string;
  count: number;
  recent: string[];
  firstSeen: string;
  lastSeen: string;
  distinctDays: number;
};

/**
 * Parse pretty-printed or compact JSON objects from failures.jsonl.
 * The file contains back-to-back JSON objects (not strict JSONL).
 */
export function parseFailuresJsonl(filePath: string): FailureEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) return [];

  const entries: FailureEntry[] = [];
  // Split on lines starting with '{' at column 0 to find object boundaries
  let buffer = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("{") && buffer.trim()) {
      // Previous buffer is a complete object
      try {
        entries.push(JSON.parse(buffer));
      } catch {
        // skip malformed entries
      }
      buffer = line;
    } else {
      buffer += (buffer ? "\n" : "") + line;
    }
  }
  // Don't forget the last buffered object
  if (buffer.trim()) {
    try {
      entries.push(JSON.parse(buffer));
    } catch {
      // skip malformed
    }
  }
  return entries;
}

/**
 * Normalize error strings for clustering:
 * - Strip absolute paths → <path>/filename
 * - Strip hex IDs (0x...), UUIDs
 * - Strip ANSI escape codes
 * - Strip line/column numbers like :123:45
 * - Collapse whitespace
 * - Truncate to 120 chars
 */
export function normalizeError(error: string): string {
  let s = error;
  // Strip ANSI codes
  s = s.replace(/\x1b\[[0-9;]*m/g, "");
  // Collapse absolute paths to <path>/basename
  s = s.replace(/\/[\w./ -]+\/([\w.-]+)/g, "<path>/$1");
  // Strip hex IDs
  s = s.replace(/0x[a-f0-9]+/gi, "<hex>");
  // Strip UUIDs
  s = s.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, "<uuid>");
  // Strip line:col patterns like :123:45 or :123)
  s = s.replace(/:\d+(?::\d+)?(?=[)\s,])/g, "");
  // Take first line only (before collapsing whitespace)
  const firstLine = s.split("\n")[0] ?? s;
  // Collapse whitespace
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, 120);
}

/**
 * Group failures by tool + normalized error pattern.
 */
export function clusterFailures(entries: FailureEntry[]): FailureCluster[] {
  const map = new Map<string, { entries: FailureEntry[]; pattern: string }>();

  for (const entry of entries) {
    const pattern = normalizeError(entry.error);
    const key = `${entry.tool}::${pattern}`;
    const existing = map.get(key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      map.set(key, { entries: [entry], pattern });
    }
  }

  const clusters: FailureCluster[] = [];
  for (const [, { entries: clusterEntries, pattern }] of map) {
    const sorted = clusterEntries.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const days = new Set(sorted.map((e) => e.timestamp.slice(0, 10)));
    clusters.push({
      tool: sorted[0]!.tool,
      pattern,
      count: sorted.length,
      recent: sorted
        .slice(-3)
        .map((e) => e.error.slice(0, 200))
        .reverse(),
      firstSeen: sorted[0]!.timestamp,
      lastSeen: sorted[sorted.length - 1]!.timestamp,
      distinctDays: days.size,
    });
  }

  // Sort by count descending
  return clusters.sort((a, b) => b.count - a.count);
}

/**
 * Generate a markdown digest from failure clusters.
 */
export function generateDigest(clusters: FailureCluster[], totalEntries: number): string {
  const now = new Date().toISOString();
  const lines: string[] = [
    "# Failure Patterns (auto-generated)",
    "",
    `Generated: ${now} | Source: memory/failures.jsonl (${totalEntries} entries)`,
    "",
  ];

  // Group clusters by tool
  const byTool = new Map<string, FailureCluster[]>();
  for (const c of clusters) {
    const existing = byTool.get(c.tool) ?? [];
    existing.push(c);
    byTool.set(c.tool, existing);
  }

  // Sort tools by total failure count
  const toolTotals = [...byTool.entries()]
    .map(([tool, cs]) => ({ tool, total: cs.reduce((sum, c) => sum + c.count, 0), clusters: cs }))
    .sort((a, b) => b.total - a.total);

  for (const { tool, total, clusters: toolClusters } of toolTotals) {
    lines.push(`## ${tool} (${total} failures)`);
    lines.push("");
    for (const c of toolClusters) {
      const lastDate = c.lastSeen.slice(0, 10);
      lines.push(`- **${c.pattern}** (${c.count}x, last: ${lastDate}, ${c.distinctDays} days)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Write digest to disk only if content has changed (avoids triggering unnecessary reindex).
 * Returns true if file was written.
 */
export function writeDigestIfChanged(digestPath: string, content: string): boolean {
  const newHash = crypto.createHash("sha256").update(content).digest("hex");
  if (fs.existsSync(digestPath)) {
    const existing = fs.readFileSync(digestPath, "utf-8");
    const oldHash = crypto.createHash("sha256").update(existing).digest("hex");
    if (newHash === oldHash) return false;
  }
  fs.writeFileSync(digestPath, content, "utf-8");
  return true;
}

/**
 * Main: parse failures.jsonl, cluster, write digest.
 */
export function refreshFailuresDigest(
  jsonlPath: string,
  digestPath: string,
): { written: boolean; clusters: number; entries: number } {
  const entries = parseFailuresJsonl(jsonlPath);
  const clusters = clusterFailures(entries);
  const digest = generateDigest(clusters, entries.length);
  const written = writeDigestIfChanged(digestPath, digest);
  return { written, clusters: clusters.length, entries: entries.length };
}
