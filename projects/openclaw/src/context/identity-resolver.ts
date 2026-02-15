/**
 * Unified identity resolution across channels.
 *
 * The same person on WhatsApp (+1234567890) and Telegram (user ID 42) are
 * normally treated as separate senders. This module links their identities
 * via alias records in the context store, so cross-conversation context
 * merges both channels.
 *
 * Alias records are stored in the "chat" domain with a `user-alias` tag.
 * Each record links two identity tags (e.g. sender:e164:+123 → sender:id:tg-42).
 *
 * Resolution follows transitive chains: if A→B and B→C, querying A returns {A, B, C}.
 */

import type { SenderIdentity } from "./build-user-context.js";
import type { ContextStore } from "./store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UnifiedIdentity = {
  /** All known identity tags for this person. */
  tags: string[];
  /** Primary display name (from the first alias record found, or empty). */
  displayName: string;
};

/** Shape of an alias record payload. */
export type AliasPayload = {
  type: "user-alias";
  primary: string;
  linked: string;
  channel?: string;
};

// ---------------------------------------------------------------------------
// Tag building (shared with build-user-context.ts)
// ---------------------------------------------------------------------------

/** Build sender tags from identity fields. */
export function buildSenderTags(identity: SenderIdentity): string[] {
  const tags: string[] = [];
  if (identity.senderE164) {
    tags.push(`sender:e164:${identity.senderE164}`);
  }
  if (identity.senderId) {
    tags.push(`sender:id:${identity.senderId}`);
  }
  if (identity.senderUsername) {
    tags.push(`sender:username:${identity.senderUsername}`);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Alias creation
// ---------------------------------------------------------------------------

/**
 * Create or refresh an alias record linking two identity tags.
 * Idempotent — safe to call on every message.
 */
export function createAlias(
  store: ContextStore,
  primaryTag: string,
  linkedTag: string,
  channel?: string,
): void {
  const aliasKey = `alias:${primaryTag}:${linkedTag}`;
  const payload: AliasPayload = {
    type: "user-alias",
    primary: primaryTag,
    linked: linkedTag,
    channel,
  };
  store.append("chat", aliasKey, payload, ["user-alias"]);
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

/**
 * Resolve all identity tags for a sender by checking alias records.
 * Returns the input tags plus any linked aliases (transitive).
 */
export function resolveUnifiedIdentity(
  store: ContextStore,
  senderIdentity: SenderIdentity,
): UnifiedIdentity {
  const seedTags = buildSenderTags(senderIdentity);
  if (seedTags.length === 0) {
    return { tags: [], displayName: "" };
  }

  // BFS over alias records to find all linked tags
  const known = new Set(seedTags);
  const queue = [...seedTags];
  let displayName = "";

  while (queue.length > 0) {
    const tag = queue.shift()!;

    // Query alias records that mention this tag
    const aliasRecords = store.query({
      domain: "chat",
      tags: ["user-alias"],
      textSearch: tag,
      limit: 20,
    });

    for (const record of aliasRecords) {
      const payload = record.payload as AliasPayload;
      if (payload.type !== "user-alias") {
        continue;
      }

      // Check if this alias involves our tag
      const otherTag =
        payload.primary === tag ? payload.linked : payload.linked === tag ? payload.primary : null;

      if (otherTag && !known.has(otherTag)) {
        known.add(otherTag);
        queue.push(otherTag);
      }
    }
  }

  return { tags: [...known], displayName };
}

// ---------------------------------------------------------------------------
// Multi-tag query helper
// ---------------------------------------------------------------------------

/**
 * Query the context store with ANY of the given tags (OR logic).
 * The store's native `tags` filter uses AND logic, so we run one query
 * per tag and deduplicate by record ID.
 */
export function queryWithAnyTag(
  store: ContextStore,
  domain: "chat" | "user-facts",
  tags: string[],
  limit: number,
): ReturnType<ContextStore["query"]> {
  if (tags.length === 0) {
    return [];
  }

  // Single tag — no dedup needed
  if (tags.length === 1) {
    return store.query({ domain, tags: [tags[0]], order: "newest", limit });
  }

  const seen = new Set<string>();
  const results: ReturnType<ContextStore["query"]> = [];

  for (const tag of tags) {
    const records = store.query({ domain, tags: [tag], order: "newest", limit });
    for (const record of records) {
      if (!seen.has(record.meta.id)) {
        seen.add(record.meta.id);
        results.push(record);
      }
    }
  }

  // Sort by timestamp descending (newest first) and apply limit
  results.sort((a, b) => b.meta.timestamp - a.meta.timestamp || b.meta.seq - a.meta.seq);
  return results.slice(0, limit);
}
