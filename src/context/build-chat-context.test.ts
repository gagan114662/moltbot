import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExtendedChatContext, buildExtendedChatContextAsync } from "./build-chat-context.js";
import { ContextStore } from "./store.js";

describe("buildExtendedChatContext", () => {
  let tmpDir: string;
  let store: ContextStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-chat-ctx-test-"));
    store = new ContextStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty string when no extra records", () => {
    // Store has 3 records, in-memory has 3 — no extra
    for (let i = 0; i < 3; i++) {
      store.append("chat", "scope-1", { sender: "a", body: `msg ${i}` });
    }
    const result = buildExtendedChatContext(store, "scope-1", 3);
    expect(result).toBe("");
  });

  it("returns empty string when extra is below threshold", () => {
    // Store has 7 records, in-memory has 4 — only 3 extra (below MIN_EXTRA_RECORDS=5)
    for (let i = 0; i < 7; i++) {
      store.append("chat", "scope-2", { sender: "a", body: `msg ${i}` });
    }
    const result = buildExtendedChatContext(store, "scope-2", 4);
    expect(result).toBe("");
  });

  it("returns formatted history when enough extra records", () => {
    // Store has 15 records, in-memory has 5 — 10 extra (above threshold)
    for (let i = 0; i < 15; i++) {
      store.append("chat", "scope-3", {
        sender: i % 2 === 0 ? "alice" : "bob",
        body: `message ${i}`,
        channel: "test",
        isBot: false,
      });
    }

    const result = buildExtendedChatContext(store, "scope-3", 5);
    expect(result).toContain("[Earlier conversation history");
    expect(result).toContain("alice: message 0");
    expect(result).toContain("bob: message 1");
  });

  it("respects token budget for large histories", () => {
    // Create many records with long bodies
    for (let i = 0; i < 100; i++) {
      store.append("chat", "scope-4", {
        sender: "user",
        body: "x".repeat(200), // each ~50 tokens
        channel: "test",
        isBot: false,
      });
    }

    const result = buildExtendedChatContext(store, "scope-4", 10);
    expect(result).toContain("[Earlier conversation history");
    expect(result).toContain("... (");
    expect(result).toContain("earlier messages omitted)");
    // Should be under ~8000 chars (2000 tokens * 4 chars/token)
    expect(result.length).toBeLessThan(10000);
  });

  it("returns empty for unknown scope", () => {
    const result = buildExtendedChatContext(store, "no-such-scope", 0);
    expect(result).toBe("");
  });

  it("includes relevant older messages when currentMessage is provided", () => {
    // Create enough records to trigger extended context (need > 5 extra)
    const topics = [
      "let's talk about pizza toppings",
      "I prefer mushrooms on pizza",
      "the weather is nice today",
      "sunny and warm outside",
      "back to pizza, what about pepperoni",
      "I love a good margherita pizza",
      "did you see the football game",
      "the score was 3-1",
      "pizza delivery was late yesterday",
      "traffic was terrible",
    ];
    for (const body of topics) {
      store.append("chat", "scope-rel", {
        sender: "user",
        body,
        channel: "test",
        isBot: false,
      });
    }

    const result = buildExtendedChatContext(store, "scope-rel", 0, "pizza");
    expect(result).toContain("[Related earlier messages]");
    expect(result).toContain("pizza");
    expect(result).toContain("[Earlier conversation history");
  });

  it("skips relevance section for very short currentMessage", () => {
    for (let i = 0; i < 10; i++) {
      store.append("chat", "scope-short", {
        sender: "user",
        body: `message ${i} about various things`,
        channel: "test",
        isBot: false,
      });
    }

    // currentMessage too short (<=3 chars) — no relevance matching
    const result = buildExtendedChatContext(store, "scope-short", 0, "hi");
    expect(result).not.toContain("[Related earlier messages]");
    expect(result).toContain("[Earlier conversation history");
  });

  it("works without currentMessage (backward compatible)", () => {
    for (let i = 0; i < 10; i++) {
      store.append("chat", "scope-compat", {
        sender: "user",
        body: `message ${i}`,
        channel: "test",
        isBot: false,
      });
    }

    const result = buildExtendedChatContext(store, "scope-compat", 0);
    expect(result).not.toContain("[Related earlier messages]");
    expect(result).toContain("[Earlier conversation history");
  });
});

// ---------------------------------------------------------------------------
// buildExtendedChatContextAsync
// ---------------------------------------------------------------------------

describe("buildExtendedChatContextAsync", () => {
  let tmpDir: string;
  let store: ContextStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-chat-async-test-"));
    store = new ContextStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to sync version when below summarize threshold", async () => {
    for (let i = 0; i < 20; i++) {
      store.append("chat", "scope-sync", {
        sender: "user",
        body: `message ${i}`,
        channel: "test",
        isBot: false,
      });
    }

    const mockSummarize = vi.fn();
    const result = await buildExtendedChatContextAsync(store, "scope-sync", 0, {
      llmSummarize: mockSummarize,
    });

    // Under 100 extra records — should use sync version, not call LLM
    expect(mockSummarize).not.toHaveBeenCalled();
    expect(result).toContain("[Earlier conversation history");
  });

  it("calls llmSummarize when above threshold", async () => {
    for (let i = 0; i < 120; i++) {
      store.append("chat", "scope-long", {
        sender: i % 2 === 0 ? "alice" : "bob",
        body: `message ${i} about topic`,
        channel: "test",
        isBot: false,
      });
    }

    const mockSummarize = vi.fn().mockResolvedValue("Alice and Bob discussed 120 topics.");
    const result = await buildExtendedChatContextAsync(store, "scope-long", 0, {
      llmSummarize: mockSummarize,
    });

    expect(mockSummarize).toHaveBeenCalledOnce();
    expect(result).toContain("Conversation summary");
    expect(result).toContain("Alice and Bob discussed 120 topics.");
    expect(result).toContain("[Recent context");
  });

  it("handles LLM failure gracefully", async () => {
    for (let i = 0; i < 120; i++) {
      store.append("chat", "scope-fail", {
        sender: "user",
        body: `message ${i}`,
        channel: "test",
        isBot: false,
      });
    }

    const mockSummarize = vi.fn().mockRejectedValue(new Error("LLM unavailable"));
    const result = await buildExtendedChatContextAsync(store, "scope-fail", 0, {
      llmSummarize: mockSummarize,
    });

    expect(result).toContain("summary unavailable");
    expect(result).toContain("[Recent context");
  });

  it("returns empty for unknown scope", async () => {
    const result = await buildExtendedChatContextAsync(store, "no-such-scope", 0);
    expect(result).toBe("");
  });

  it("works without llmSummarize (uses sync fallback)", async () => {
    for (let i = 0; i < 120; i++) {
      store.append("chat", "scope-no-llm", {
        sender: "user",
        body: `message ${i}`,
        channel: "test",
        isBot: false,
      });
    }

    const result = await buildExtendedChatContextAsync(store, "scope-no-llm", 0);
    // No llmSummarize → falls back to sync version
    expect(result).toContain("[Earlier conversation history");
  });
});
