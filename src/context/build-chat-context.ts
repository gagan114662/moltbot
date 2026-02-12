/**
 * Build extended chat context from the context store.
 *
 * Queries the context store for messages in a scope that are older than
 * what the in-memory 50-message history window retains, and formats them
 * as a compact text block for prepending to the LLM prompt.
 *
 * Returns an empty string when there's nothing extra to include.
 */

import type { ContextStore } from "./store.js";
import type { ChatMessagePayload } from "./types.js";

/** Minimum records beyond in-memory history before we bother adding extended context. */
const MIN_EXTRA_RECORDS = 5;

/** Maximum tokens of extended context to inject. */
const MAX_EXTENDED_TOKENS = 2000;

/**
 * Build a compact extended history block from older messages in the context store.
 *
 * @param store      — the ContextStore to query
 * @param scopeKey   — the conversation/session key
 * @param inMemoryCount — how many messages are currently in the in-memory history
 * @param currentMessage — optional current message for relevance matching
 * @returns formatted text block, or empty string if not enough extra context
 */
export function buildExtendedChatContext(
  store: ContextStore,
  scopeKey: string,
  inMemoryCount: number,
  currentMessage?: string,
): string {
  const totalCount = store.count({ domain: "chat", scopeKey });
  const extraCount = totalCount - inMemoryCount;
  if (extraCount < MIN_EXTRA_RECORDS) {
    return "";
  }

  // Budget allocation: if we have a current message, split tokens between
  // relevant matches and chronological older records.
  const relevantBudget = currentMessage ? Math.floor(MAX_EXTENDED_TOKENS * 0.4) : 0;
  const chronoBudget = MAX_EXTENDED_TOKENS - relevantBudget;

  const sections: string[] = [];

  // --- Relevant older messages (keyword match) ---
  if (currentMessage && currentMessage.length > 3) {
    const relevantRecords = store.query({
      domain: "chat",
      scopeKey,
      textSearch: currentMessage,
      order: "newest",
      limit: 10,
    });

    if (relevantRecords.length > 0) {
      const relevantLines: string[] = ["[Related earlier messages]"];
      let relevantTokens = 0;

      for (const record of relevantRecords) {
        const payload = record.payload as ChatMessagePayload;
        const line = `${payload.sender}: ${payload.body}`;
        const lineTokens = Math.ceil(line.length / 4);

        if (relevantTokens + lineTokens > relevantBudget) {
          break;
        }

        relevantLines.push(line);
        relevantTokens += lineTokens;
      }

      if (relevantLines.length > 1) {
        sections.push(relevantLines.join("\n"));
      }
    }
  }

  // --- Chronological older messages ---
  const olderRecords = store.query({
    domain: "chat",
    scopeKey,
    order: "oldest",
    limit: extraCount,
  });

  if (olderRecords.length > 0) {
    const chronoLines: string[] = [
      `[Earlier conversation history — ${olderRecords.length} messages]`,
    ];
    let chronoTokens = 0;

    for (const record of olderRecords) {
      const payload = record.payload as ChatMessagePayload;
      const line = `${payload.sender}: ${payload.body}`;
      const lineTokens = Math.ceil(line.length / 4);

      if (chronoTokens + lineTokens > chronoBudget) {
        chronoLines.push(
          `... (${olderRecords.length - chronoLines.length + 1} earlier messages omitted)`,
        );
        break;
      }

      chronoLines.push(line);
      chronoTokens += lineTokens;
    }

    sections.push(chronoLines.join("\n"));
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Async variant with LLM summarization for very long conversations
// ---------------------------------------------------------------------------

/** Threshold for extra records before LLM summarization kicks in. */
const SUMMARIZE_THRESHOLD = 100;

/**
 * Async version of buildExtendedChatContext that can optionally summarize
 * very long conversation histories via an LLM.
 *
 * When the conversation has > SUMMARIZE_THRESHOLD extra records and an
 * llmSummarize callback is provided, the oldest messages are summarized
 * into a compact narrative instead of being listed verbatim.
 */
export async function buildExtendedChatContextAsync(
  store: ContextStore,
  scopeKey: string,
  inMemoryCount: number,
  opts?: {
    currentMessage?: string;
    llmSummarize?: (text: string) => Promise<string>;
  },
): Promise<string> {
  const totalCount = store.count({ domain: "chat", scopeKey });
  const extraCount = totalCount - inMemoryCount;
  if (extraCount < MIN_EXTRA_RECORDS) {
    return "";
  }

  // If below summarize threshold or no LLM callback, use sync version
  if (extraCount < SUMMARIZE_THRESHOLD || !opts?.llmSummarize) {
    return buildExtendedChatContext(store, scopeKey, inMemoryCount, opts?.currentMessage);
  }

  // Split into: summarizable older chunk + recent chronological chunk
  const recentChunkSize = Math.min(30, Math.floor(extraCount * 0.3));
  const olderChunkSize = extraCount - recentChunkSize;

  const allOlder = store.query({
    domain: "chat",
    scopeKey,
    order: "oldest",
    limit: extraCount,
  });

  const sections: string[] = [];

  // --- Summarize the oldest chunk ---
  const olderChunk = allOlder.slice(0, olderChunkSize);
  if (olderChunk.length > 0) {
    const rawLines = olderChunk.map((r) => {
      const p = r.payload as ChatMessagePayload;
      return `${p.sender}: ${p.body}`;
    });
    const rawText = rawLines.join("\n").slice(0, 20_000);
    const prompt = `Summarize this conversation history into a concise narrative (max 300 words). Focus on: key topics discussed, decisions made, unresolved questions, and who said what.\n\n${rawText}`;

    try {
      const summary = await opts.llmSummarize(prompt);
      sections.push(`[Conversation summary — ${olderChunk.length} messages]\n${summary}`);
    } catch {
      // Fallback: just show count
      sections.push(`[${olderChunk.length} earlier messages — summary unavailable]`);
    }
  }

  // --- Recent chronological chunk ---
  const recentChunk = allOlder.slice(olderChunkSize);
  if (recentChunk.length > 0) {
    const recentLines: string[] = [`[Recent context — ${recentChunk.length} messages]`];
    let tokenCount = 0;
    const budget = Math.floor(MAX_EXTENDED_TOKENS * 0.6);

    for (const record of recentChunk) {
      const payload = record.payload as ChatMessagePayload;
      const line = `${payload.sender}: ${payload.body}`;
      const lineTokens = Math.ceil(line.length / 4);

      if (tokenCount + lineTokens > budget) {
        recentLines.push(`... (${recentChunk.length - recentLines.length + 1} messages omitted)`);
        break;
      }

      recentLines.push(line);
      tokenCount += lineTokens;
    }

    sections.push(recentLines.join("\n"));
  }

  // --- Relevance section ---
  if (opts?.currentMessage && opts.currentMessage.length > 3) {
    const relevantRecords = store.query({
      domain: "chat",
      scopeKey,
      textSearch: opts.currentMessage,
      order: "newest",
      limit: 5,
    });

    if (relevantRecords.length > 0) {
      const relevantLines: string[] = ["[Related earlier messages]"];
      for (const record of relevantRecords) {
        const payload = record.payload as ChatMessagePayload;
        relevantLines.push(`${payload.sender}: ${payload.body}`);
      }
      sections.push(relevantLines.join("\n"));
    }
  }

  return sections.join("\n\n");
}
