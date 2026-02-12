/**
 * Lazy singleton for the global ContextStore instance.
 *
 * The store is created once on first access and persists for the process
 * lifetime.  The chat context bridge is also enabled on first access.
 *
 * Auto-pruning runs at most once per hour, removing records older than
 * domain-specific thresholds (30 days for chat, 14 days for QA/overnight).
 */

import type { ContextDomain } from "./types.js";
import { enableChatContextBridge } from "./chat-bridge.js";
import { ContextStore } from "./store.js";

let _instance: ContextStore | undefined;
let _bridgeDispose: (() => void) | undefined;

// ---------------------------------------------------------------------------
// Auto-pruning
// ---------------------------------------------------------------------------

const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const PRUNE_THRESHOLDS: Record<ContextDomain, number> = {
  chat: 30 * 24 * 60 * 60 * 1000, // 30 days
  "qa-iteration": 14 * 24 * 60 * 60 * 1000, // 14 days
  "overnight-cycle": 14 * 24 * 60 * 60 * 1000, // 14 days
};

let _lastPruneAt = 0;

/** Exported for testing — get/set the last prune timestamp. */
export function _getLastPruneAt(): number {
  return _lastPruneAt;
}
export function _setLastPruneAt(ts: number): void {
  _lastPruneAt = ts;
}

/**
 * Run pruning if enough time has passed since the last prune.
 * Fire-and-forget — errors are swallowed.
 */
export function maybePrune(store: ContextStore): void {
  const now = Date.now();
  if (now - _lastPruneAt < PRUNE_INTERVAL_MS) {
    return;
  }
  _lastPruneAt = now;

  for (const [domain, threshold] of Object.entries(PRUNE_THRESHOLDS)) {
    for (const scope of store.listScopes(domain as ContextDomain)) {
      store.prune(domain as ContextDomain, scope, threshold);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/**
 * Get (or create) the global ContextStore.
 * On first call, also enables the chat context bridge so that every
 * `appendHistoryEntry()` call dual-writes to the store.
 * On every call, runs auto-pruning if enough time has elapsed.
 */
export function getGlobalContextStore(): ContextStore {
  if (!_instance) {
    _instance = new ContextStore();
    _bridgeDispose = enableChatContextBridge(_instance);
  }
  try {
    maybePrune(_instance);
  } catch {
    /* pruning failures must never break the caller */
  }
  return _instance;
}

/** Reset the singleton (for tests only). */
export function resetGlobalContextStore(): void {
  _bridgeDispose?.();
  _bridgeDispose = undefined;
  _instance = undefined;
  _lastPruneAt = 0;
}
