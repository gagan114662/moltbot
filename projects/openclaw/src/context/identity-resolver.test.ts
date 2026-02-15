import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSenderTags,
  createAlias,
  queryWithAnyTag,
  resolveUnifiedIdentity,
} from "./identity-resolver.js";
import { ContextStore } from "./store.js";

describe("buildSenderTags", () => {
  it("returns empty for empty identity", () => {
    expect(buildSenderTags({})).toEqual([]);
  });

  it("builds E164 tag", () => {
    expect(buildSenderTags({ senderE164: "+1234567890" })).toEqual(["sender:e164:+1234567890"]);
  });

  it("builds senderId tag", () => {
    expect(buildSenderTags({ senderId: "tg-42" })).toEqual(["sender:id:tg-42"]);
  });

  it("builds senderUsername tag", () => {
    expect(buildSenderTags({ senderUsername: "johndoe" })).toEqual(["sender:username:johndoe"]);
  });

  it("builds all tags when all fields present", () => {
    const tags = buildSenderTags({
      senderE164: "+1",
      senderId: "id-1",
      senderUsername: "user-1",
    });
    expect(tags).toHaveLength(3);
    expect(tags).toContain("sender:e164:+1");
    expect(tags).toContain("sender:id:id-1");
    expect(tags).toContain("sender:username:user-1");
  });
});

describe("resolveUnifiedIdentity", () => {
  let tmpDir: string;
  let store: ContextStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-resolver-test-"));
    store = new ContextStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns seed tags when no aliases exist", () => {
    const result = resolveUnifiedIdentity(store, { senderE164: "+123" });
    expect(result.tags).toEqual(["sender:e164:+123"]);
  });

  it("returns empty for empty identity", () => {
    const result = resolveUnifiedIdentity(store, {});
    expect(result.tags).toEqual([]);
  });

  it("follows alias to linked tag", () => {
    createAlias(store, "sender:e164:+123", "sender:id:tg-42", "telegram");

    const result = resolveUnifiedIdentity(store, { senderE164: "+123" });
    expect(result.tags).toContain("sender:e164:+123");
    expect(result.tags).toContain("sender:id:tg-42");
  });

  it("follows reverse alias direction", () => {
    createAlias(store, "sender:e164:+123", "sender:id:tg-42", "telegram");

    const result = resolveUnifiedIdentity(store, { senderId: "tg-42" });
    expect(result.tags).toContain("sender:e164:+123");
    expect(result.tags).toContain("sender:id:tg-42");
  });

  it("follows transitive aliases (A→B, B→C gives A,B,C)", () => {
    createAlias(store, "sender:e164:+123", "sender:id:tg-42");
    createAlias(store, "sender:id:tg-42", "sender:username:johndoe");

    const result = resolveUnifiedIdentity(store, { senderE164: "+123" });
    expect(result.tags).toContain("sender:e164:+123");
    expect(result.tags).toContain("sender:id:tg-42");
    expect(result.tags).toContain("sender:username:johndoe");
  });

  it("does not duplicate tags", () => {
    createAlias(store, "sender:e164:+123", "sender:id:tg-42");
    // Create same alias again
    createAlias(store, "sender:e164:+123", "sender:id:tg-42");

    const result = resolveUnifiedIdentity(store, { senderE164: "+123" });
    const unique = new Set(result.tags);
    expect(result.tags.length).toBe(unique.size);
  });
});

describe("queryWithAnyTag", () => {
  let tmpDir: string;
  let store: ContextStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "query-any-tag-test-"));
    store = new ContextStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty for empty tags", () => {
    expect(queryWithAnyTag(store, "chat", [], 10)).toEqual([]);
  });

  it("queries with single tag", () => {
    store.append(
      "chat",
      "scope-1",
      { sender: "a", body: "hello", channel: "whatsapp", isBot: false },
      ["sender:e164:+1"],
    );

    const results = queryWithAnyTag(store, "chat", ["sender:e164:+1"], 10);
    expect(results).toHaveLength(1);
  });

  it("deduplicates records across multiple tags", () => {
    // Same record has both tags
    store.append(
      "chat",
      "scope-1",
      { sender: "a", body: "hello", channel: "whatsapp", isBot: false },
      ["sender:e164:+1", "sender:id:tg-42"],
    );

    const results = queryWithAnyTag(store, "chat", ["sender:e164:+1", "sender:id:tg-42"], 10);
    expect(results).toHaveLength(1);
  });

  it("merges records from different tags", () => {
    store.append(
      "chat",
      "scope-1",
      { sender: "a", body: "from whatsapp", channel: "whatsapp", isBot: false },
      ["sender:e164:+1"],
    );
    store.append(
      "chat",
      "scope-2",
      { sender: "a", body: "from telegram", channel: "telegram", isBot: false },
      ["sender:id:tg-42"],
    );

    const results = queryWithAnyTag(store, "chat", ["sender:e164:+1", "sender:id:tg-42"], 10);
    expect(results).toHaveLength(2);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.append(
        "chat",
        "scope-1",
        { sender: "a", body: `msg ${i}`, channel: "whatsapp", isBot: false },
        ["sender:e164:+1"],
      );
    }

    const results = queryWithAnyTag(store, "chat", ["sender:e164:+1"], 3);
    expect(results).toHaveLength(3);
  });

  it("sorts newest first", () => {
    store.append(
      "chat",
      "scope-1",
      { sender: "a", body: "old", channel: "whatsapp", isBot: false },
      ["sender:e164:+1"],
    );
    store.append(
      "chat",
      "scope-1",
      { sender: "a", body: "new", channel: "whatsapp", isBot: false },
      ["sender:e164:+1"],
    );

    const results = queryWithAnyTag(store, "chat", ["sender:e164:+1"], 10);
    expect((results[0].payload as { body: string }).body).toBe("new");
  });
});

describe("createAlias", () => {
  let tmpDir: string;
  let store: ContextStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-alias-test-"));
    store = new ContextStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a queryable alias record", () => {
    createAlias(store, "sender:e164:+123", "sender:id:tg-42", "telegram");

    const records = store.query({ domain: "chat", tags: ["user-alias"] });
    expect(records).toHaveLength(1);
    expect(records[0].payload).toEqual({
      type: "user-alias",
      primary: "sender:e164:+123",
      linked: "sender:id:tg-42",
      channel: "telegram",
    });
  });
});
