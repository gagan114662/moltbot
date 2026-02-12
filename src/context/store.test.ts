import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessagePayload } from "./types.js";
import { ContextStore, estimateTokens } from "./store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: ContextStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-store-test-"));
  store = new ContextStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("estimates tokens as chars / 4", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars → ceil(11/4) = 3
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// append + query basics
// ---------------------------------------------------------------------------

describe("ContextStore append + query", () => {
  it("appends and retrieves a record", () => {
    const payload: ChatMessagePayload = {
      sender: "user1",
      body: "hello",
      channel: "whatsapp",
      isBot: false,
    };
    const id = store.append("chat", "conv-1", payload, ["channel:whatsapp"]);
    expect(id).toBeTruthy();

    const results = store.query({ domain: "chat", scopeKey: "conv-1" });
    expect(results).toHaveLength(1);
    expect(results[0].meta.id).toBe(id);
    expect(results[0].meta.domain).toBe("chat");
    expect(results[0].meta.scopeKey).toBe("conv-1");
    expect(results[0].meta.tags).toEqual(["channel:whatsapp"]);
    expect((results[0].payload as ChatMessagePayload).body).toBe("hello");
  });

  it("appends multiple records and queries all", () => {
    store.append("chat", "conv-1", { sender: "a", body: "msg1", channel: "tg", isBot: false });
    store.append("chat", "conv-1", { sender: "b", body: "msg2", channel: "tg", isBot: true });
    store.append("chat", "conv-1", { sender: "a", body: "msg3", channel: "tg", isBot: false });

    const results = store.query({ domain: "chat", scopeKey: "conv-1" });
    expect(results).toHaveLength(3);
  });

  it("separates records by scopeKey", () => {
    store.append("chat", "conv-1", { sender: "a", body: "hi", channel: "tg", isBot: false });
    store.append("chat", "conv-2", { sender: "b", body: "yo", channel: "tg", isBot: false });

    expect(store.query({ domain: "chat", scopeKey: "conv-1" })).toHaveLength(1);
    expect(store.query({ domain: "chat", scopeKey: "conv-2" })).toHaveLength(1);
  });

  it("separates records by domain", () => {
    store.append("chat", "scope-1", { sender: "a", body: "hi", channel: "tg", isBot: false });
    store.append("qa-iteration", "scope-1", { iteration: 1, passed: false });

    expect(store.query({ domain: "chat" })).toHaveLength(1);
    expect(store.query({ domain: "qa-iteration" })).toHaveLength(1);
  });

  it("queries across multiple domains", () => {
    store.append("chat", "s1", { body: "hi" });
    store.append("qa-iteration", "s2", { iteration: 1 });

    const results = store.query({ domain: ["chat", "qa-iteration"] });
    expect(results).toHaveLength(2);
  });

  it("queries all domains when domain is omitted", () => {
    store.append("chat", "s1", { body: "hi" });
    store.append("qa-iteration", "s2", { iteration: 1 });
    store.append("overnight-cycle", "s3", { cycle: 1 });

    const results = store.query({});
    expect(results).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Query filters
// ---------------------------------------------------------------------------

describe("ContextStore query filters", () => {
  it("filters by tags", () => {
    store.append("chat", "c1", { body: "a" }, ["channel:whatsapp", "important"]);
    store.append("chat", "c1", { body: "b" }, ["channel:telegram"]);

    const results = store.query({ domain: "chat", tags: ["channel:whatsapp"] });
    expect(results).toHaveLength(1);
    expect((results[0].payload as { body: string }).body).toBe("a");
  });

  it("filters by multiple tags (AND)", () => {
    store.append("chat", "c1", { body: "a" }, ["channel:whatsapp", "important"]);
    store.append("chat", "c1", { body: "b" }, ["channel:whatsapp"]);

    const results = store.query({ tags: ["channel:whatsapp", "important"] });
    expect(results).toHaveLength(1);
  });

  it("filters by time range (after)", () => {
    const now = Date.now();
    store.append("chat", "c1", { body: "old" });

    // Query for records after now — the record was just appended so it should match
    const results = store.query({ domain: "chat", after: now - 1000 });
    expect(results).toHaveLength(1);

    const futureResults = store.query({ domain: "chat", after: now + 60_000 });
    expect(futureResults).toHaveLength(0);
  });

  it("filters by time range (before)", () => {
    store.append("chat", "c1", { body: "msg" });

    const results = store.query({ domain: "chat", before: Date.now() + 1000 });
    expect(results).toHaveLength(1);

    const pastResults = store.query({ domain: "chat", before: 1000 });
    expect(pastResults).toHaveLength(0);
  });

  it("filters by textSearch", () => {
    store.append("chat", "c1", { body: "the quick brown fox" });
    store.append("chat", "c1", { body: "lazy dog" });

    const results = store.query({ domain: "chat", textSearch: "brown fox" });
    expect(results).toHaveLength(1);
  });

  it("textSearch is case-insensitive", () => {
    store.append("chat", "c1", { body: "Hello World" });

    const results = store.query({ textSearch: "hello world" });
    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Ordering & limit
// ---------------------------------------------------------------------------

describe("ContextStore ordering and limit", () => {
  it("returns newest first by default", () => {
    store.append("chat", "c1", { body: "first" });
    store.append("chat", "c1", { body: "second" });
    store.append("chat", "c1", { body: "third" });

    const results = store.query({ domain: "chat", scopeKey: "c1" });
    expect((results[0].payload as { body: string }).body).toBe("third");
    expect((results[2].payload as { body: string }).body).toBe("first");
  });

  it("supports oldest-first ordering", () => {
    store.append("chat", "c1", { body: "first" });
    store.append("chat", "c1", { body: "second" });

    const results = store.query({ domain: "chat", scopeKey: "c1", order: "oldest" });
    expect((results[0].payload as { body: string }).body).toBe("first");
  });

  it("respects limit", () => {
    store.append("chat", "c1", { body: "a" });
    store.append("chat", "c1", { body: "b" });
    store.append("chat", "c1", { body: "c" });

    const results = store.query({ domain: "chat", scopeKey: "c1", limit: 2 });
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

describe("ContextStore count", () => {
  it("counts matching records", () => {
    store.append("chat", "c1", { body: "a" });
    store.append("chat", "c1", { body: "b" });
    store.append("qa-iteration", "q1", { iteration: 1 });

    expect(store.count({ domain: "chat" })).toBe(2);
    expect(store.count({ domain: "qa-iteration" })).toBe(1);
    expect(store.count({})).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// get by ID
// ---------------------------------------------------------------------------

describe("ContextStore get", () => {
  it("retrieves record by ID", () => {
    const id = store.append("chat", "c1", { body: "found me" });
    const record = store.get(id);
    expect(record).not.toBeNull();
    expect((record!.payload as { body: string }).body).toBe("found me");
  });

  it("returns null for unknown ID", () => {
    expect(store.get("nonexistent-id")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Persistence (round-trip)
// ---------------------------------------------------------------------------

describe("ContextStore persistence", () => {
  it("persists across store instances", () => {
    store.append("chat", "c1", { body: "persistent" });

    // Create new store pointing to same directory
    const store2 = new ContextStore(tmpDir);
    const results = store2.query({ domain: "chat", scopeKey: "c1" });
    expect(results).toHaveLength(1);
    expect((results[0].payload as { body: string }).body).toBe("persistent");
  });

  it("handles corrupt JSONL lines gracefully", () => {
    // Manually write corrupt data
    const dir = path.join(tmpDir, "chat");
    fs.mkdirSync(dir, { recursive: true });

    // First append a valid record to create the file
    store.append("chat", "c1", { body: "valid" });
    store.clearCache();

    // Find the file and append garbage
    const chatDir = path.join(tmpDir, "chat");
    const jsonlFiles = fs.readdirSync(chatDir);
    expect(jsonlFiles.length).toBeGreaterThan(0);
    const filePath = path.join(chatDir, jsonlFiles[0]);
    fs.appendFileSync(filePath, "THIS IS NOT JSON\n");
    fs.appendFileSync(
      filePath,
      '{"meta":{"id":"x","domain":"chat","timestamp":1,"tags":[],"scopeKey":"c1","estimatedTokens":1},"payload":{"body":"also valid"}}\n',
    );

    // New store should skip corrupt lines
    const store2 = new ContextStore(tmpDir);
    const results = store2.query({ domain: "chat", scopeKey: "c1" });
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

describe("ContextStore prune", () => {
  it("removes records older than threshold", () => {
    store.append("chat", "c1", { body: "old" });

    // Prune with a generous threshold so the recently-added record is kept.
    // olderThanMs=10_000 → cutoff = Date.now() - 10_000, well before the record.
    const pruned = store.prune("chat", "c1", 10_000);
    expect(pruned).toBe(0);

    // Prune with huge negative threshold (cutoff is far in the future)
    store.clearCache();
    const pruned2 = store.prune("chat", "c1", -1e15);
    expect(pruned2).toBe(1);

    const results = store.query({ domain: "chat", scopeKey: "c1" });
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listScopes
// ---------------------------------------------------------------------------

describe("ContextStore listScopes", () => {
  it("lists scope keys for a domain", () => {
    store.append("chat", "conv-alice", { body: "hi" });
    store.append("chat", "conv-bob", { body: "yo" });

    const scopes = store.listScopes("chat");
    expect(scopes).toHaveLength(2);
    expect(scopes).toContain("conv-alice");
    expect(scopes).toContain("conv-bob");
  });

  it("returns empty for unknown domain", () => {
    expect(store.listScopes("overnight-cycle")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// estimatedTokens on metadata
// ---------------------------------------------------------------------------

describe("ContextStore metadata", () => {
  it("sets estimatedTokens based on payload size", () => {
    const bigPayload = { body: "x".repeat(400) }; // 400+ chars JSON
    store.append("chat", "c1", bigPayload);

    const record = store.query({ domain: "chat", scopeKey: "c1" })[0];
    expect(record.meta.estimatedTokens).toBeGreaterThan(50);
  });
});
