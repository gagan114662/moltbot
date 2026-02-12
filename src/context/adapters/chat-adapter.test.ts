import { describe, expect, it } from "vitest";
import { historyEntryToRecord } from "./chat-adapter.js";

describe("historyEntryToRecord", () => {
  it("converts HistoryEntry to chat record shape", () => {
    const result = historyEntryToRecord(
      { sender: "alice", body: "Hello!", timestamp: 1000, messageId: "msg-1" },
      "conv-123",
      "whatsapp",
      false,
    );

    expect(result.domain).toBe("chat");
    expect(result.scopeKey).toBe("conv-123");
    expect(result.tags).toContain("channel:whatsapp");
    expect(result.payload.sender).toBe("alice");
    expect(result.payload.body).toBe("Hello!");
    expect(result.payload.channel).toBe("whatsapp");
    expect(result.payload.isBot).toBe(false);
    expect(result.payload.messageId).toBe("msg-1");
  });

  it("tags bot messages", () => {
    const result = historyEntryToRecord(
      { sender: "bot", body: "I can help!" },
      "conv-123",
      "telegram",
      true,
    );

    expect(result.payload.isBot).toBe(true);
    expect(result.tags).toContain("bot");
    expect(result.tags).toContain("channel:telegram");
  });

  it("handles missing optional fields", () => {
    const result = historyEntryToRecord({ sender: "user", body: "hi" }, "conv-1", "slack", false);

    expect(result.payload.messageId).toBeUndefined();
  });
});
