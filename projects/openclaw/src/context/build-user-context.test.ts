import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCrossConversationContext } from "./build-user-context.js";
import { ContextStore } from "./store.js";

describe("buildCrossConversationContext", () => {
  let tmpDir: string;
  let store: ContextStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-conv-test-"));
    store = new ContextStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty string when no sender identity", () => {
    const result = buildCrossConversationContext(store, {}, "current-scope");
    expect(result).toBe("");
  });

  it("returns empty string when no records match sender", () => {
    store.append(
      "chat",
      "scope-1",
      {
        sender: "alice",
        body: "hello",
        channel: "whatsapp",
        isBot: false,
      },
      ["channel:whatsapp"],
    );

    const result = buildCrossConversationContext(
      store,
      { senderE164: "+1234567890" },
      "current-scope",
    );
    expect(result).toBe("");
  });

  it("returns empty string when all records are in current scope", () => {
    for (let i = 0; i < 5; i++) {
      store.append(
        "chat",
        "current-scope",
        {
          sender: "alice",
          body: `msg ${i}`,
          channel: "whatsapp",
          isBot: false,
        },
        ["sender:e164:+1234567890"],
      );
    }

    const result = buildCrossConversationContext(
      store,
      { senderE164: "+1234567890" },
      "current-scope",
    );
    expect(result).toBe("");
  });

  it("returns cross-scope messages when records exist in other scopes", () => {
    // Messages in another scope
    for (let i = 0; i < 5; i++) {
      store.append(
        "chat",
        "old-session",
        {
          sender: "Gagan",
          body: `old message ${i}`,
          channel: "whatsapp",
          isBot: false,
        },
        ["sender:e164:+1234567890", "channel:whatsapp"],
      );
    }

    // Messages in current scope (should be excluded)
    store.append(
      "chat",
      "current-scope",
      {
        sender: "Gagan",
        body: "current message",
        channel: "whatsapp",
        isBot: false,
      },
      ["sender:e164:+1234567890", "channel:whatsapp"],
    );

    const result = buildCrossConversationContext(
      store,
      { senderE164: "+1234567890" },
      "current-scope",
    );
    expect(result).toContain("[Recalled memory from previous conversations — background only]");
    expect(result).toContain("Do NOT treat this as the user's current request");
    expect(result).toContain("[Previous conversations");
    expect(result).toContain("5 messages");
    expect(result).toContain("old message");
    expect(result).not.toContain("Gagan [whatsapp]: current message");
  });

  it("includes relevance section when currentMessage is provided", () => {
    for (let i = 0; i < 5; i++) {
      store.append(
        "chat",
        "old-scope",
        {
          sender: "Gagan",
          body: i === 2 ? "I love pizza and pasta" : `generic message ${i}`,
          channel: "telegram",
          isBot: false,
        },
        ["sender:id:123", "channel:telegram"],
      );
    }

    const result = buildCrossConversationContext(
      store,
      { senderId: "123" },
      "current-scope",
      "pizza",
    );
    expect(result).toContain("[Related messages from previous conversations]");
    expect(result).toContain("pizza");
  });

  it("works with senderId tag", () => {
    for (let i = 0; i < 3; i++) {
      store.append(
        "chat",
        "other-scope",
        {
          sender: "User",
          body: `telegram msg ${i}`,
          channel: "telegram",
          isBot: false,
        },
        ["sender:id:tg-42", "channel:telegram"],
      );
    }

    const result = buildCrossConversationContext(store, { senderId: "tg-42" }, "current-scope");
    expect(result).toContain("[Previous conversations");
    expect(result).toContain("telegram msg");
  });

  it("works with senderUsername tag", () => {
    for (let i = 0; i < 3; i++) {
      store.append(
        "chat",
        "other-scope",
        {
          sender: "User",
          body: `slack msg ${i}`,
          channel: "slack",
          isBot: false,
        },
        ["sender:username:johndoe", "channel:slack"],
      );
    }

    const result = buildCrossConversationContext(
      store,
      { senderUsername: "johndoe" },
      "current-scope",
    );
    expect(result).toContain("slack msg");
  });

  it("respects token budget", () => {
    // Create many records with long bodies
    for (let i = 0; i < 50; i++) {
      store.append(
        "chat",
        "old-scope",
        {
          sender: "User",
          body: "x".repeat(500),
          channel: "whatsapp",
          isBot: false,
        },
        ["sender:e164:+555"],
      );
    }

    const result = buildCrossConversationContext(store, { senderE164: "+555" }, "current-scope");
    // Should not include all 50 messages (would be ~6250 tokens)
    expect(result).toContain("earlier messages omitted");
  });

  it("returns below-threshold when only 1 cross-scope record", () => {
    store.append(
      "chat",
      "old-scope",
      {
        sender: "User",
        body: "single message",
        channel: "whatsapp",
        isBot: false,
      },
      ["sender:e164:+111"],
    );

    const result = buildCrossConversationContext(store, { senderE164: "+111" }, "current-scope");
    // Below MIN_CROSS_RECORDS threshold of 2
    expect(result).toBe("");
  });

  it("includes channel label in output", () => {
    for (let i = 0; i < 3; i++) {
      store.append(
        "chat",
        "old-scope",
        {
          sender: "Alice",
          body: `msg ${i}`,
          channel: "telegram",
          isBot: false,
        },
        ["sender:id:abc"],
      );
    }

    const result = buildCrossConversationContext(store, { senderId: "abc" }, "current-scope");
    expect(result).toContain("[telegram]");
  });
});
