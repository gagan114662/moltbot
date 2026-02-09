// Converts session logs (~/.openclaw/agents/<name>/sessions/<file>.jsonl)
// into memory/session-digest.md so the existing memory indexer can search
// session history.
//
// Privacy: only includes user message text (first 120 chars) and
// tool name + pass/fail. Never includes raw tool inputs or full outputs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeDigestIfChanged } from "./failures-digest.js";

type SessionEvent = {
  type: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string; name?: string }>;
    toolName?: string;
    isError?: boolean;
  };
};

type SessionSummary = {
  id: string;
  agent: string;
  date: string;
  task: string;
  toolCounts: Map<string, number>;
  failureCounts: Map<string, number>;
  messageCount: number;
};

/**
 * Resolve the sessions directory. Checks OPENCLAW_SESSIONS_DIR env first,
 * then falls back to ~/.openclaw/agents/{name}/sessions/.
 */
export function resolveSessionsDirs(): string[] {
  const envDir = process.env.OPENCLAW_SESSIONS_DIR;
  if (envDir && fs.existsSync(envDir)) {
    return [envDir];
  }
  const baseDir = path.join(os.homedir(), ".openclaw", "agents");
  if (!fs.existsSync(baseDir)) return [];
  const dirs: string[] = [];
  try {
    for (const agent of fs.readdirSync(baseDir)) {
      const sessionsDir = path.join(baseDir, agent, "sessions");
      if (fs.existsSync(sessionsDir) && fs.statSync(sessionsDir).isDirectory()) {
        dirs.push(sessionsDir);
      }
    }
  } catch {
    // ignore permission errors
  }
  return dirs;
}

/**
 * Parse a session log file. Reads line-by-line to avoid loading entire
 * file into memory. Extracts only what we need for the digest.
 */
export function parseSessionLog(filePath: string): SessionSummary | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  let id = "";
  let date = "";
  let agent = "";
  let firstUserMessage = "";
  const toolCounts = new Map<string, number>();
  const failureCounts = new Map<string, number>();
  let messageCount = 0;

  // Infer agent name from file path: .../agents/{name}/sessions/...
  const pathParts = filePath.split(path.sep);
  const agentsIdx = pathParts.indexOf("agents");
  if (agentsIdx >= 0 && agentsIdx + 1 < pathParts.length) {
    agent = pathParts[agentsIdx + 1]!;
  }

  for (const line of lines) {
    let event: SessionEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "session") {
      id = (event as unknown as Record<string, string>).id ?? "";
      date = event.timestamp?.slice(0, 10) ?? "";
    }

    if (event.type === "message" && event.message) {
      const msg = event.message;
      // User messages: extract first 120 chars of text content (privacy-safe)
      if (msg.role === "user" && !firstUserMessage) {
        const textPart = msg.content?.find((c) => c.type === "text");
        if (textPart?.text) {
          firstUserMessage = textPart.text.slice(0, 120).replace(/\n/g, " ").trim();
        }
        messageCount++;
      }
      // Tool calls: just track name
      if (msg.role === "assistant" && msg.content) {
        for (const part of msg.content) {
          if (part.type === "toolCall" && part.name) {
            toolCounts.set(part.name, (toolCounts.get(part.name) ?? 0) + 1);
          }
        }
      }
      // Tool results: track errors (name + isError only, no content)
      if (msg.role === "toolResult") {
        if (msg.isError && msg.toolName) {
          failureCounts.set(msg.toolName, (failureCounts.get(msg.toolName) ?? 0) + 1);
        }
      }
    }
  }

  if (!id && !date) return null;

  return {
    id,
    agent,
    date,
    task: firstUserMessage || "(no user message)",
    toolCounts,
    failureCounts,
    messageCount,
  };
}

/**
 * Format a session summary as markdown lines.
 */
function formatSessionSummary(s: SessionSummary): string {
  const lines: string[] = [];
  lines.push(`## Session ${s.date} (${s.agent})`);
  lines.push(`- Task: "${s.task}"`);

  if (s.toolCounts.size > 0) {
    const sorted = [...s.toolCounts.entries()].sort((a, b) => b[1] - a[1]);
    const tools = sorted.map(([name, count]) => `${name} (${count})`).join(", ");
    lines.push(`- Tools used: ${tools}`);
  }

  if (s.failureCounts.size > 0) {
    const failures = [...s.failureCounts.entries()]
      .map(([name, count]) => `${name} (${count}x)`)
      .join(", ");
    lines.push(`- Failures: ${failures}`);
  }

  return lines.join("\n");
}

/**
 * Collect recent session log files, sorted by modification time (newest first).
 */
function collectSessionFiles(sessionsDirs: string[], limit: number): string[] {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const dir of sessionsDirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const fullPath = path.join(dir, name);
        const stat = fs.statSync(fullPath);
        files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // skip unreadable dirs
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, limit).map((f) => f.path);
}

/**
 * Generate session digest markdown and write to disk.
 */
export function refreshSessionDigest(
  digestPath: string,
  limit = 20,
): { written: boolean; sessions: number } {
  const dirs = resolveSessionsDirs();
  const files = collectSessionFiles(dirs, limit);
  const summaries: SessionSummary[] = [];

  for (const file of files) {
    const summary = parseSessionLog(file);
    if (summary) summaries.push(summary);
  }

  const now = new Date().toISOString();
  const lines: string[] = [
    "# Session History (auto-generated)",
    "",
    `Generated: ${now} | Sessions: ${summaries.length}`,
    "",
  ];

  for (const s of summaries) {
    lines.push(formatSessionSummary(s));
    lines.push("");
  }

  const written = writeDigestIfChanged(digestPath, lines.join("\n"));
  return { written, sessions: summaries.length };
}
