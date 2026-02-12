import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextRecord } from "./types.js";
import { formatRecordsAsMarkdown, materializeContext } from "./materialize.js";
import { ContextStore } from "./store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let outputDir: string;
let store: ContextStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-mat-test-"));
  outputDir = path.join(tmpDir, "output");
  store = new ContextStore(path.join(tmpDir, "store"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// formatRecordsAsMarkdown
// ---------------------------------------------------------------------------

describe("formatRecordsAsMarkdown", () => {
  it("returns placeholder for empty array", () => {
    expect(formatRecordsAsMarkdown([])).toContain("No records");
  });

  it("formats records with metadata headers", () => {
    const records: ContextRecord[] = [
      {
        meta: {
          id: "1",
          domain: "chat",
          timestamp: Date.now(),
          tags: ["channel:whatsapp"],
          scopeKey: "c1",
          estimatedTokens: 10,
          seq: 0,
        },
        payload: { sender: "Alice", body: "Hello world" },
      },
    ];
    const md = formatRecordsAsMarkdown(records);
    expect(md).toContain("### chat");
    expect(md).toContain("channel:whatsapp");
    expect(md).toContain("**sender**: Alice");
    expect(md).toContain("**body**: Hello world");
  });

  it("truncates long string values", () => {
    const records: ContextRecord[] = [
      {
        meta: {
          id: "1",
          domain: "qa-iteration",
          timestamp: Date.now(),
          tags: [],
          scopeKey: "q1",
          estimatedTokens: 100,
          seq: 0,
        },
        payload: { diffFull: "x".repeat(3000) },
      },
    ];
    const md = formatRecordsAsMarkdown(records);
    expect(md).toContain("truncated");
    expect(md.length).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// materializeContext — recency strategy
// ---------------------------------------------------------------------------

describe("materializeContext recency", () => {
  it("writes recent records to context-recency.md", async () => {
    store.append("chat", "c1", { body: "msg1" });
    store.append("chat", "c1", { body: "msg2" });
    store.append("chat", "c1", { body: "msg3" });

    const result = await materializeContext(store, "c1", {
      outputDir,
      tokenBudget: 10000,
      strategies: [{ kind: "recency", count: 2 }],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toContain("context-recency.md");
    expect(result.files[0].recordCount).toBe(2);

    const content = fs.readFileSync(result.files[0].path, "utf-8");
    expect(content).toContain("msg2");
    expect(content).toContain("msg3");
  });
});

// ---------------------------------------------------------------------------
// materializeContext — relevance strategy
// ---------------------------------------------------------------------------

describe("materializeContext relevance", () => {
  it("writes matching records to context-relevance.md", async () => {
    store.append("chat", "c1", { body: "the quick brown fox" });
    store.append("chat", "c1", { body: "lazy dog sleeps" });
    store.append("chat", "c1", { body: "another brown fox appears" });

    const result = await materializeContext(store, "c1", {
      outputDir,
      tokenBudget: 10000,
      strategies: [{ kind: "relevance", query: "brown fox", maxResults: 5 }],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].recordCount).toBe(2);

    const content = fs.readFileSync(result.files[0].path, "utf-8");
    expect(content).toContain("brown fox");
    expect(content).not.toContain("lazy dog");
  });
});

// ---------------------------------------------------------------------------
// materializeContext — tagged strategy
// ---------------------------------------------------------------------------

describe("materializeContext tagged", () => {
  it("writes tagged records to context-tagged.md", async () => {
    store.append("qa-iteration", "q1", { iteration: 1 }, ["diagnosis:ws-1011"]);
    store.append("qa-iteration", "q1", { iteration: 2 }, ["diagnosis:no-response"]);
    store.append("qa-iteration", "q1", { iteration: 3 }, ["diagnosis:ws-1011"]);

    const result = await materializeContext(store, "q1", {
      outputDir,
      tokenBudget: 10000,
      strategies: [{ kind: "tagged", tags: ["diagnosis:ws-1011"] }],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].recordCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// materializeContext — summary-window strategy
// ---------------------------------------------------------------------------

describe("materializeContext summary-window", () => {
  it("calls llmSummarize for older records", async () => {
    for (let i = 0; i < 10; i++) {
      store.append("chat", "c1", { body: `message ${i}` });
    }

    const mockSummarize = vi.fn().mockResolvedValue("Summary: 10 messages about various topics.");

    const result = await materializeContext(store, "c1", {
      outputDir,
      tokenBudget: 10000,
      strategies: [{ kind: "summary-window", windowSize: 3, summarizeOlder: true }],
      llmSummarize: mockSummarize,
    });

    expect(mockSummarize).toHaveBeenCalledOnce();
    expect(result.files).toHaveLength(1);

    const content = fs.readFileSync(result.files[0].path, "utf-8");
    expect(content).toContain("Summary: 10 messages");
  });

  it("skips when not enough records for summarization", async () => {
    store.append("chat", "c1", { body: "only one" });

    const result = await materializeContext(store, "c1", {
      outputDir,
      tokenBudget: 10000,
      strategies: [{ kind: "summary-window", windowSize: 5, summarizeOlder: true }],
    });

    expect(result.files).toHaveLength(0);
  });

  it("falls back to raw markdown when llmSummarize is not provided", async () => {
    for (let i = 0; i < 10; i++) {
      store.append("chat", "c1", { body: `message ${i}` });
    }

    const result = await materializeContext(store, "c1", {
      outputDir,
      tokenBudget: 10000,
      strategies: [{ kind: "summary-window", windowSize: 3, summarizeOlder: true }],
    });

    expect(result.files).toHaveLength(1);
    const content = fs.readFileSync(result.files[0].path, "utf-8");
    expect(content).toContain("message 0");
  });
});

// ---------------------------------------------------------------------------
// Token budget enforcement
// ---------------------------------------------------------------------------

describe("materializeContext token budget", () => {
  it("stops when budget is exhausted", async () => {
    // Add a lot of data
    for (let i = 0; i < 50; i++) {
      store.append("chat", "c1", { body: "x".repeat(500) });
    }

    const result = await materializeContext(store, "c1", {
      outputDir,
      tokenBudget: 100, // Very small budget
      strategies: [
        { kind: "recency", count: 50 },
        { kind: "relevance", query: "x", maxResults: 10 },
      ],
    });

    // First strategy should be truncated, second should be skipped
    expect(result.totalTokens).toBeLessThanOrEqual(110); // some overhead from truncation marker
  });

  it("truncates content when it exceeds remaining budget", async () => {
    store.append("chat", "c1", { body: "a".repeat(2000) });

    const result = await materializeContext(store, "c1", {
      outputDir,
      tokenBudget: 50, // ~200 chars
      strategies: [{ kind: "recency", count: 1 }],
    });

    const content = fs.readFileSync(result.files[0].path, "utf-8");
    expect(content).toContain("truncated to fit token budget");
  });
});

// ---------------------------------------------------------------------------
// Deduplication across strategies
// ---------------------------------------------------------------------------

describe("materializeContext deduplication", () => {
  it("does not include same record in multiple files", async () => {
    store.append("chat", "c1", { body: "unique message" }, ["important"]);

    const result = await materializeContext(store, "c1", {
      outputDir,
      tokenBudget: 10000,
      strategies: [
        { kind: "recency", count: 5 },
        { kind: "tagged", tags: ["important"] },
      ],
    });

    // Record should appear in recency file
    expect(result.files[0].recordCount).toBe(1);
    // Tagged strategy should find 0 unique records (already seen)
    expect(result.files).toHaveLength(1); // only one file because tagged found 0 unique
  });
});

// ---------------------------------------------------------------------------
// Empty store handling
// ---------------------------------------------------------------------------

describe("materializeContext edge cases", () => {
  it("handles empty store gracefully", async () => {
    const result = await materializeContext(store, "nonexistent", {
      outputDir,
      tokenBudget: 10000,
      strategies: [{ kind: "recency", count: 10 }],
    });

    expect(result.files).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
    // Manifest should still be written
    expect(fs.existsSync(path.join(outputDir, "context-manifest.json"))).toBe(true);
  });

  it("writes manifest with metadata", async () => {
    store.append("chat", "c1", { body: "test" });

    await materializeContext(store, "c1", {
      outputDir,
      tokenBudget: 10000,
      strategies: [{ kind: "recency", count: 1 }],
    });

    const manifest = JSON.parse(
      fs.readFileSync(path.join(outputDir, "context-manifest.json"), "utf-8"),
    );
    expect(manifest.scopeKey).toBe("c1");
    expect(manifest.tokenBudget).toBe(10000);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.materializedAt).toBeTruthy();
  });

  it("is idempotent (second call overwrites cleanly)", async () => {
    store.append("chat", "c1", { body: "first run" });

    await materializeContext(store, "c1", {
      outputDir,
      tokenBudget: 10000,
      strategies: [{ kind: "recency", count: 1 }],
    });

    store.append("chat", "c1", { body: "second run" });

    await materializeContext(store, "c1", {
      outputDir,
      tokenBudget: 10000,
      strategies: [{ kind: "recency", count: 1 }],
    });

    const content = fs.readFileSync(path.join(outputDir, "context-recency.md"), "utf-8");
    expect(content).toContain("second run");
  });
});
