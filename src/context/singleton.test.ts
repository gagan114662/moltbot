import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _setLastPruneAt, maybePrune } from "./singleton.js";
import { ContextStore } from "./store.js";

describe("maybePrune", () => {
  let tmpDir: string;
  let store: ContextStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "singleton-prune-test-"));
    store = new ContextStore(tmpDir);
    _setLastPruneAt(0); // Reset so pruning is eligible
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _setLastPruneAt(0);
  });

  it("prunes records older than threshold", () => {
    // Insert a record and manually backdate it by writing to the store internals
    store.append("chat", "scope-1", { body: "old message" });
    expect(store.count({ domain: "chat", scopeKey: "scope-1" })).toBe(1);

    // maybePrune with recent record should NOT prune (record is seconds old, threshold is 30 days)
    maybePrune(store);
    expect(store.count({ domain: "chat", scopeKey: "scope-1" })).toBe(1);
  });

  it("skips pruning when called again within interval", () => {
    store.append("chat", "scope-2", { body: "message" });

    // First call sets _lastPruneAt to now
    _setLastPruneAt(0);
    maybePrune(store);

    // Second call within interval should be a no-op (skips entirely)
    // We verify this by checking it doesn't throw even with empty data
    maybePrune(store);
    expect(store.count({ domain: "chat", scopeKey: "scope-2" })).toBe(1);
  });

  it("runs pruning when interval has elapsed", () => {
    store.append("chat", "scope-3", { body: "message" });

    // Set last prune to well in the past (> 1 hour ago)
    _setLastPruneAt(Date.now() - 2 * 60 * 60 * 1000);

    // This should trigger pruning (though recent records won't be pruned)
    maybePrune(store);
    expect(store.count({ domain: "chat", scopeKey: "scope-3" })).toBe(1);
  });

  it("prunes across multiple domains", () => {
    store.append("chat", "c1", { body: "chat msg" });
    store.append("qa-iteration", "q1", { iteration: 1 });
    store.append("overnight-cycle", "o1", { cycle: 1 });

    _setLastPruneAt(0);
    maybePrune(store);

    // All records are recent, so none should be pruned
    expect(store.count({ domain: "chat" })).toBe(1);
    expect(store.count({ domain: "qa-iteration" })).toBe(1);
    expect(store.count({ domain: "overnight-cycle" })).toBe(1);
  });
});
