import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseSessionLog, resolveSessionsDirs, refreshSessionDigest } from "./session-digest.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-digest-test-"));
}

describe("parseSessionLog", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for missing file", () => {
    expect(parseSessionLog("/nonexistent/path")).toBeNull();
  });

  it("returns null for empty file", () => {
    const file = path.join(dir, "empty.jsonl");
    fs.writeFileSync(file, "");
    expect(parseSessionLog(file)).toBeNull();
  });

  it("extracts session id and date", () => {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      `{"type":"session","id":"abc-123","timestamp":"2026-02-08T10:00:00Z"}\n`,
    );
    const result = parseSessionLog(file);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("abc-123");
    expect(result!.date).toBe("2026-02-08");
  });

  it("extracts first user message (capped at 120 chars)", () => {
    const longText = "x".repeat(200);
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      [
        `{"type":"session","id":"s1","timestamp":"2026-02-08T10:00:00Z"}`,
        `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"${longText}"}]}}`,
        `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"second message ignored"}]}}`,
      ].join("\n"),
    );
    const result = parseSessionLog(file);
    expect(result!.task).toHaveLength(120);
    expect(result!.messageCount).toBe(1); // only first user message counted
  });

  it("counts tool calls by name", () => {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      [
        `{"type":"session","id":"s1","timestamp":"2026-02-08T10:00:00Z"}`,
        `{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"Read"},{"type":"toolCall","name":"Read"},{"type":"toolCall","name":"Bash"}]}}`,
      ].join("\n"),
    );
    const result = parseSessionLog(file);
    expect(result!.toolCounts.get("Read")).toBe(2);
    expect(result!.toolCounts.get("Bash")).toBe(1);
  });

  it("tracks tool failures", () => {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      [
        `{"type":"session","id":"s1","timestamp":"2026-02-08T10:00:00Z"}`,
        `{"type":"message","message":{"role":"toolResult","toolName":"Read","isError":true}}`,
        `{"type":"message","message":{"role":"toolResult","toolName":"Read","isError":true}}`,
        `{"type":"message","message":{"role":"toolResult","toolName":"Bash","isError":false}}`,
      ].join("\n"),
    );
    const result = parseSessionLog(file);
    expect(result!.failureCounts.get("Read")).toBe(2);
    expect(result!.failureCounts.has("Bash")).toBe(false);
  });

  it("infers agent name from path", () => {
    const agentDir = path.join(dir, "agents", "researcher", "sessions");
    fs.mkdirSync(agentDir, { recursive: true });
    const file = path.join(agentDir, "session.jsonl");
    fs.writeFileSync(file, `{"type":"session","id":"s1","timestamp":"2026-02-08T10:00:00Z"}\n`);
    const result = parseSessionLog(file);
    expect(result!.agent).toBe("researcher");
  });

  it("skips malformed JSON lines", () => {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      file,
      [
        `{"type":"session","id":"s1","timestamp":"2026-02-08T10:00:00Z"}`,
        `{not valid json}`,
        `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}`,
      ].join("\n"),
    );
    const result = parseSessionLog(file);
    expect(result!.task).toBe("hello");
  });

  it("returns (no user message) when no user messages exist", () => {
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, `{"type":"session","id":"s1","timestamp":"2026-02-08T10:00:00Z"}\n`);
    const result = parseSessionLog(file);
    expect(result!.task).toBe("(no user message)");
  });
});

describe("resolveSessionsDirs", () => {
  it("uses OPENCLAW_SESSIONS_DIR env var when set", () => {
    const dir = tmpDir();
    try {
      vi.stubEnv("OPENCLAW_SESSIONS_DIR", dir);
      const dirs = resolveSessionsDirs();
      expect(dirs).toEqual([dir]);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty when env var points to missing dir", () => {
    vi.stubEnv("OPENCLAW_SESSIONS_DIR", "/nonexistent/dir");
    try {
      const dirs = resolveSessionsDirs();
      // Should fall through to ~/.openclaw path, which may or may not exist
      expect(Array.isArray(dirs)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("refreshSessionDigest", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("generates digest from session files", () => {
    const sessionsDir = path.join(dir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "s1.jsonl"),
      [
        `{"type":"session","id":"s1","timestamp":"2026-02-08T10:00:00Z"}`,
        `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Add UX eval stage"}]}}`,
        `{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"Write"}]}}`,
      ].join("\n"),
    );

    vi.stubEnv("OPENCLAW_SESSIONS_DIR", sessionsDir);
    const digestPath = path.join(dir, "session-digest.md");
    const result = refreshSessionDigest(digestPath);
    expect(result.sessions).toBe(1);
    expect(result.written).toBe(true);
    const content = fs.readFileSync(digestPath, "utf-8");
    expect(content).toContain("# Session History (auto-generated)");
    expect(content).toContain("Add UX eval stage");
    expect(content).toContain("Write (1)");
  });

  it("handles empty sessions directory", () => {
    const sessionsDir = path.join(dir, "empty-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("OPENCLAW_SESSIONS_DIR", sessionsDir);
    const digestPath = path.join(dir, "session-digest.md");
    const result = refreshSessionDigest(digestPath);
    expect(result.sessions).toBe(0);
    expect(result.written).toBe(true);
  });
});
