/**
 * Cross-agent shared context: shared LEARNED rules and discoveries.
 * Files live in memory/shared/ and are injected by hooks into all agents.
 */
import fs from "node:fs";
import path from "node:path";

const SHARED_DIR_NAME = "shared";
const SHARED_LEARNED_FILE = "SHARED-LEARNED.md";
const DISCOVERIES_FILE = "discoveries.md";
const DISCOVERIES_ARCHIVE = "discoveries.archive.md";
const MAX_DISCOVERIES_LINES = 200;

/**
 * Resolve the shared memory directory, creating it if needed.
 */
export function resolveSharedDir(memoryDir: string): string {
  const dir = path.join(memoryDir, SHARED_DIR_NAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Read shared LEARNED rules, optionally capped to last N lines.
 */
export function readSharedLearned(memoryDir: string, limit?: number): string {
  const filePath = path.join(memoryDir, SHARED_DIR_NAME, SHARED_LEARNED_FILE);
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const content = fs.readFileSync(filePath, "utf-8");
  if (!limit) {
    return content;
  }
  const lines = content.split("\n");
  if (lines.length <= limit) {
    return content;
  }
  return lines.slice(-limit).join("\n");
}

/**
 * Read recent discoveries, capped to last N entries.
 */
export function readDiscoveries(memoryDir: string, limit = 10): string {
  const filePath = path.join(memoryDir, SHARED_DIR_NAME, DISCOVERIES_FILE);
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.startsWith("- ["));
  if (lines.length <= limit) {
    return lines.join("\n");
  }
  return lines.slice(-limit).join("\n");
}

/**
 * Append a discovery entry with timestamp and agent name.
 */
export function appendDiscovery(memoryDir: string, agent: string, text: string): void {
  const dir = resolveSharedDir(memoryDir);
  const filePath = path.join(dir, DISCOVERIES_FILE);
  const now = new Date();
  const ts = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
  const entry = `- [${ts}] (${agent}) ${text.replace(/\n/g, " ").trim()}\n`;

  // Create file with header if it doesn't exist
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# Discoveries\n${entry}`, "utf-8");
  } else {
    fs.appendFileSync(filePath, entry, "utf-8");
  }

  rotateDiscoveriesIfNeeded(memoryDir);
}

/**
 * Append a rule to shared LEARNED, with deduplication.
 */
export function appendSharedRule(memoryDir: string, rule: string): boolean {
  const dir = resolveSharedDir(memoryDir);
  const filePath = path.join(dir, SHARED_LEARNED_FILE);

  // Create file with header if it doesn't exist
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# Shared Rules\n\n${rule}\n`, "utf-8");
    return true;
  }

  const existing = fs.readFileSync(filePath, "utf-8");
  // Simple dedup: check if any existing line contains 80%+ of the rule's words
  const ruleWords = new Set(
    rule
      .toLowerCase()
      .replace(/[[\]()]/g, "")
      .split(/\s+/)
      .filter(Boolean),
  );
  const existingLines = existing.split("\n").filter((l) => l.startsWith("- "));

  for (const line of existingLines) {
    const lineWords = new Set(
      line
        .toLowerCase()
        .replace(/[[\]()]/g, "")
        .split(/\s+/)
        .filter(Boolean),
    );
    const intersection = [...ruleWords].filter((w) => lineWords.has(w)).length;
    const jaccard = intersection / Math.max(ruleWords.size, 1);
    if (jaccard > 0.7) {
      return false;
    } // duplicate
  }

  fs.appendFileSync(filePath, `${rule}\n`, "utf-8");
  return true;
}

/**
 * Rotate discoveries.md when it exceeds MAX_DISCOVERIES_LINES.
 * Moves older entries to discoveries.archive.md.
 */
export function rotateDiscoveriesIfNeeded(memoryDir: string): boolean {
  const filePath = path.join(memoryDir, SHARED_DIR_NAME, DISCOVERIES_FILE);
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const allLines = content.split("\n");
  const entryLines = allLines.filter((l) => l.startsWith("- ["));

  if (entryLines.length <= MAX_DISCOVERIES_LINES) {
    return false;
  }

  // Keep the last MAX_DISCOVERIES_LINES/2 entries, archive the rest
  const keepCount = Math.floor(MAX_DISCOVERIES_LINES / 2);
  const toArchive = entryLines.slice(0, -keepCount);
  const toKeep = entryLines.slice(-keepCount);

  // Append to archive
  const archivePath = path.join(memoryDir, SHARED_DIR_NAME, DISCOVERIES_ARCHIVE);
  fs.appendFileSync(archivePath, toArchive.join("\n") + "\n", "utf-8");

  // Rewrite main file
  fs.writeFileSync(filePath, `# Discoveries\n${toKeep.join("\n")}\n`, "utf-8");
  return true;
}
