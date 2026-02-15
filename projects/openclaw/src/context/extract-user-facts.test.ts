import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserFactPayload } from "./types.js";
import {
  extractUserFacts,
  parseFactsResponse,
  extractAndStoreFacts,
} from "./extract-user-facts.js";
import { ContextStore } from "./store.js";

describe("extractUserFacts", () => {
  it("returns empty array for empty messages", async () => {
    const result = await extractUserFacts([], [], async () => "[]");
    expect(result).toEqual([]);
  });

  it("returns empty array when only bot messages", async () => {
    const result = await extractUserFacts(
      [{ sender: "bot", body: "Hello! How can I help?", isBot: true }],
      [],
      async () => "[]",
    );
    expect(result).toEqual([]);
  });

  it("returns empty array when user messages are too short", async () => {
    const result = await extractUserFacts(
      [{ sender: "user", body: "hi", isBot: false }],
      [],
      async () => "[]",
    );
    expect(result).toEqual([]);
  });

  it("extracts facts from valid LLM response", async () => {
    const mockLlm = async () =>
      JSON.stringify([
        { fact: "lives in Toronto", category: "location", confidence: "high", senderName: "Gagan" },
        {
          fact: "prefers dark mode",
          category: "preference",
          confidence: "high",
          senderName: "Gagan",
        },
      ]);

    const result = await extractUserFacts(
      [
        { sender: "Gagan", body: "I live in Toronto and prefer dark mode", isBot: false },
        { sender: "bot", body: "Got it!", isBot: true },
      ],
      [],
      mockLlm,
    );

    expect(result).toHaveLength(2);
    expect(result[0].fact).toBe("lives in Toronto");
    expect(result[0].category).toBe("location");
    expect(result[1].fact).toBe("prefers dark mode");
  });

  it("passes existing facts to LLM prompt", async () => {
    let capturedPrompt = "";
    const mockLlm = async (prompt: string) => {
      capturedPrompt = prompt;
      return "[]";
    };

    await extractUserFacts(
      [{ sender: "user", body: "I work at Anthropic now", isBot: false }],
      ["lives in Toronto", "prefers dark mode"],
      mockLlm,
    );

    expect(capturedPrompt).toContain("lives in Toronto");
    expect(capturedPrompt).toContain("prefers dark mode");
  });

  it("handles LLM errors gracefully", async () => {
    const mockLlm = async () => {
      throw new Error("API timeout");
    };

    await expect(
      extractUserFacts([{ sender: "user", body: "I live in Toronto", isBot: false }], [], mockLlm),
    ).rejects.toThrow("API timeout");
  });
});

describe("parseFactsResponse", () => {
  it("parses valid JSON array", () => {
    const result = parseFactsResponse(
      JSON.stringify([
        { fact: "lives in Toronto", category: "location", confidence: "high", senderName: "Gagan" },
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].fact).toBe("lives in Toronto");
  });

  it("handles markdown-fenced JSON", () => {
    const result = parseFactsResponse(
      '```json\n[{"fact": "likes pizza", "category": "interest", "confidence": "medium", "senderName": "User"}]\n```',
    );
    expect(result).toHaveLength(1);
    expect(result[0].fact).toBe("likes pizza");
  });

  it("returns empty for invalid JSON", () => {
    expect(parseFactsResponse("not json")).toEqual([]);
  });

  it("returns empty for non-array JSON", () => {
    expect(parseFactsResponse('{"fact": "test"}')).toEqual([]);
  });

  it("filters out items with invalid categories", () => {
    const result = parseFactsResponse(
      JSON.stringify([
        { fact: "test", category: "invalid", confidence: "high", senderName: "User" },
        { fact: "real fact", category: "trait", confidence: "low", senderName: "User" },
      ]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].fact).toBe("real fact");
  });

  it("filters out items with missing fields", () => {
    const result = parseFactsResponse(
      JSON.stringify([{ fact: "no category", confidence: "high", senderName: "User" }]),
    );
    expect(result).toEqual([]);
  });

  it("filters out items with empty fact string", () => {
    const result = parseFactsResponse(
      JSON.stringify([{ fact: "  ", category: "trait", confidence: "high", senderName: "User" }]),
    );
    expect(result).toEqual([]);
  });

  it("trims whitespace from fact and senderName", () => {
    const result = parseFactsResponse(
      JSON.stringify([
        {
          fact: "  lives in Toronto  ",
          category: "location",
          confidence: "high",
          senderName: "  Gagan  ",
        },
      ]),
    );
    expect(result[0].fact).toBe("lives in Toronto");
    expect(result[0].senderName).toBe("Gagan");
  });
});

describe("extractAndStoreFacts", () => {
  let tmpDir: string;
  let store: ContextStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-facts-test-"));
    store = new ContextStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores extracted facts with sender tags", async () => {
    // Seed conversation messages
    for (let i = 0; i < 3; i++) {
      store.append(
        "chat",
        "session-1",
        {
          sender: "Gagan",
          body: i === 1 ? "I live in Toronto and work at a startup" : `general message ${i}`,
          channel: "whatsapp",
          isBot: false,
        },
        ["sender:e164:+1234567890"],
      );
    }

    const mockLlm = async () =>
      JSON.stringify([
        {
          fact: "lives in Toronto",
          category: "location",
          confidence: "high",
          senderName: "Gagan",
        },
        {
          fact: "works at a startup",
          category: "work",
          confidence: "high",
          senderName: "Gagan",
        },
      ]);

    await extractAndStoreFacts(store, { senderE164: "+1234567890" }, "session-1", mockLlm);

    const facts = store.query({ domain: "user-facts", tags: ["sender:e164:+1234567890"] });
    expect(facts).toHaveLength(2);
    const factTexts = facts.map((f) => (f.payload as UserFactPayload).fact);
    expect(factTexts).toContain("lives in Toronto");
    expect(factTexts).toContain("works at a startup");
    // All facts should have sender tag
    for (const f of facts) {
      expect(f.meta.tags).toContain("sender:e164:+1234567890");
    }
  });

  it("skips when no sender tags", async () => {
    await extractAndStoreFacts(store, {}, "session-1", async () => "[]");
    const facts = store.query({ domain: "user-facts" });
    expect(facts).toHaveLength(0);
  });

  it("skips when no messages in scope", async () => {
    await extractAndStoreFacts(store, { senderId: "user-1" }, "empty-session", async () => "[]");
    const facts = store.query({ domain: "user-facts" });
    expect(facts).toHaveLength(0);
  });

  it("passes existing facts to avoid duplicates", async () => {
    // Seed an existing fact
    store.append(
      "user-facts",
      "facts:sender:e164:+555",
      {
        fact: "lives in Toronto",
        category: "location",
        confidence: "high",
        senderName: "User",
      } satisfies UserFactPayload,
      ["sender:e164:+555"],
    );

    // Seed a message
    store.append(
      "chat",
      "session-2",
      { sender: "User", body: "I work at a startup in Toronto", channel: "whatsapp", isBot: false },
      ["sender:e164:+555"],
    );

    let capturedPrompt = "";
    const mockLlm = async (prompt: string) => {
      capturedPrompt = prompt;
      return "[]";
    };

    await extractAndStoreFacts(store, { senderE164: "+555" }, "session-2", mockLlm);

    expect(capturedPrompt).toContain("lives in Toronto");
  });
});
