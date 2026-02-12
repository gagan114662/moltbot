import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendHistoryEntry, setHistoryAppendHook } from "../auto-reply/reply/history.js";
import { enableChatContextBridge } from "./chat-bridge.js";
import { ContextStore } from "./store.js";

describe("enableChatContextBridge", () => {
  let tmpDir: string;
  let store: ContextStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-bridge-test-"));
    store = new ContextStore(tmpDir);
  });

  afterEach(() => {
    // Always clean up the hook so other tests are not affected
    setHistoryAppendHook(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes to context store on appendHistoryEntry", () => {
    const dispose = enableChatContextBridge(store, "whatsapp");
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    appendHistoryEntry({
      historyMap,
      historyKey: "conv-123",
      entry: { sender: "alice", body: "Hello!" },
      limit: 50,
    });

    const records = store.query({ domain: "chat", scopeKey: "conv-123" });
    expect(records).toHaveLength(1);
    expect(records[0].payload).toEqual({
      sender: "alice",
      body: "Hello!",
      channel: "whatsapp",
      isBot: false,
      messageId: undefined,
    });
    expect(records[0].meta.tags).toContain("channel:whatsapp");

    dispose();
  });

  it("persists multiple messages in order", () => {
    const dispose = enableChatContextBridge(store, "telegram");
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    appendHistoryEntry({
      historyMap,
      historyKey: "conv-456",
      entry: { sender: "alice", body: "one" },
      limit: 50,
    });
    appendHistoryEntry({
      historyMap,
      historyKey: "conv-456",
      entry: { sender: "bob", body: "two" },
      limit: 50,
    });
    appendHistoryEntry({
      historyMap,
      historyKey: "conv-456",
      entry: { sender: "alice", body: "three" },
      limit: 50,
    });

    const records = store.query({
      domain: "chat",
      scopeKey: "conv-456",
      order: "oldest",
    });
    expect(records).toHaveLength(3);
    expect(records.map((r) => (r.payload as { body: string }).body)).toEqual([
      "one",
      "two",
      "three",
    ]);

    dispose();
  });

  it("dispose removes the hook", () => {
    const dispose = enableChatContextBridge(store, "slack");
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    appendHistoryEntry({
      historyMap,
      historyKey: "conv-1",
      entry: { sender: "a", body: "before" },
      limit: 50,
    });

    dispose();

    appendHistoryEntry({
      historyMap,
      historyKey: "conv-1",
      entry: { sender: "b", body: "after" },
      limit: 50,
    });

    const records = store.query({ domain: "chat", scopeKey: "conv-1" });
    expect(records).toHaveLength(1);
    expect((records[0].payload as { body: string }).body).toBe("before");
  });

  it("does not break history when store throws", () => {
    // Simulate a broken store by making baseDir unwritable
    const badStore = new ContextStore("/nonexistent/path/that/will/fail");
    const dispose = enableChatContextBridge(badStore);
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    // appendHistoryEntry should still work — hook error is swallowed
    const result = appendHistoryEntry({
      historyMap,
      historyKey: "conv-err",
      entry: { sender: "a", body: "works" },
      limit: 50,
    });

    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("works");

    dispose();
  });

  it("uses default channel when not specified", () => {
    const dispose = enableChatContextBridge(store);
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    appendHistoryEntry({
      historyMap,
      historyKey: "conv-default",
      entry: { sender: "user", body: "hi" },
      limit: 50,
    });

    const records = store.query({ domain: "chat", scopeKey: "conv-default" });
    expect(records).toHaveLength(1);
    expect((records[0].payload as { channel: string }).channel).toBe("unknown");
    expect(records[0].meta.tags).toContain("channel:unknown");

    dispose();
  });

  it("uses channel from meta when provided", () => {
    const dispose = enableChatContextBridge(store);
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    appendHistoryEntry({
      historyMap,
      historyKey: "conv-meta",
      entry: { sender: "user", body: "hello from signal" },
      limit: 50,
      meta: { channel: "signal" },
    });

    const records = store.query({ domain: "chat", scopeKey: "conv-meta" });
    expect(records).toHaveLength(1);
    expect((records[0].payload as { channel: string }).channel).toBe("signal");
    expect(records[0].meta.tags).toContain("channel:signal");

    dispose();
  });

  it("meta channel overrides defaultChannel", () => {
    const dispose = enableChatContextBridge(store, "whatsapp");
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    appendHistoryEntry({
      historyMap,
      historyKey: "conv-override",
      entry: { sender: "user", body: "hello from telegram" },
      limit: 50,
      meta: { channel: "telegram" },
    });

    const records = store.query({ domain: "chat", scopeKey: "conv-override" });
    expect(records).toHaveLength(1);
    expect((records[0].payload as { channel: string }).channel).toBe("telegram");

    dispose();
  });

  it("records isBot from meta and adds bot tag", () => {
    const dispose = enableChatContextBridge(store);
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    appendHistoryEntry({
      historyMap,
      historyKey: "conv-bot",
      entry: { sender: "moltbot", body: "I am a bot" },
      limit: 50,
      meta: { channel: "slack", isBot: true },
    });

    const records = store.query({ domain: "chat", scopeKey: "conv-bot" });
    expect(records).toHaveLength(1);
    expect((records[0].payload as { isBot: boolean }).isBot).toBe(true);
    expect(records[0].meta.tags).toContain("channel:slack");
    expect(records[0].meta.tags).toContain("bot");

    dispose();
  });
});
