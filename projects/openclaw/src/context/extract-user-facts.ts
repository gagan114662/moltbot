/**
 * LLM-based extraction of semantic user facts from conversations.
 *
 * After each bot reply, recent messages are sent to a cheap LLM (Haiku)
 * to extract durable facts about the user — preferences, traits, location,
 * interests, etc. Facts are stored in the context store under the
 * "user-facts" domain with sender identity tags for cross-session recall.
 *
 * This is always fire-and-forget: extraction failures never block replies.
 */

import type { SenderIdentity } from "./build-user-context.js";
import type { ContextStore } from "./store.js";
import type { ChatMessagePayload, UserFactPayload } from "./types.js";

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

function buildExtractionPrompt(
  messages: Array<{ sender: string; body: string; isBot: boolean }>,
  existingFacts: string[],
): string {
  const existingBlock =
    existingFacts.length > 0
      ? `Existing facts about this user:\n${existingFacts.map((f) => `- ${f}`).join("\n")}`
      : "No existing facts about this user.";

  const messageBlock = messages
    .map((m) => `${m.isBot ? "[bot]" : "[user]"} ${m.sender}: ${m.body}`)
    .join("\n");

  return `You are extracting facts about a user from a conversation.
Return ONLY new facts not already in the existing facts list.

${existingBlock}

Recent conversation:
${messageBlock}

Extract facts as a JSON array. Each fact object must have:
- "fact": a concise statement (e.g. "lives in Toronto", "prefers dark mode")
- "category": one of "preference", "trait", "location", "relationship", "interest", "work"
- "confidence": "high" (explicitly stated), "medium" (strongly implied), or "low" (inferred)
- "senderName": the user's display name from the conversation

Rules:
- Only extract facts about the HUMAN user (not the bot)
- Skip trivial or transient facts ("I'm hungry right now", "thanks")
- Skip facts that duplicate or rephrase existing facts
- Return [] if no new facts found
- Return ONLY valid JSON — no markdown fences, no explanation`;
}

// ---------------------------------------------------------------------------
// Core extraction (pure — takes an LLM callback)
// ---------------------------------------------------------------------------

/**
 * Extract new user facts from recent messages.
 *
 * @param recentMessages — last N messages from the conversation
 * @param existingFacts  — already-known facts (to avoid duplicates)
 * @param llmCall        — callback that sends a prompt to an LLM and returns text
 * @returns array of new UserFactPayload objects (may be empty)
 */
export async function extractUserFacts(
  recentMessages: Array<{ sender: string; body: string; isBot: boolean }>,
  existingFacts: string[],
  llmCall: (prompt: string) => Promise<string>,
): Promise<UserFactPayload[]> {
  if (recentMessages.length === 0) {
    return [];
  }

  // Only include messages with substantive content
  const substantive = recentMessages.filter((m) => !m.isBot && m.body.trim().length > 10);
  if (substantive.length === 0) {
    return [];
  }

  const prompt = buildExtractionPrompt(recentMessages, existingFacts);
  const raw = await llmCall(prompt);

  return parseFactsResponse(raw);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set([
  "preference",
  "trait",
  "location",
  "relationship",
  "interest",
  "work",
]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

/** Parse the LLM JSON response into validated UserFactPayload[]. */
export function parseFactsResponse(raw: string): UserFactPayload[] {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const results: UserFactPayload[] = [];
  for (const item of parsed) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof item.fact === "string" &&
      item.fact.trim().length > 0 &&
      typeof item.category === "string" &&
      VALID_CATEGORIES.has(item.category) &&
      typeof item.confidence === "string" &&
      VALID_CONFIDENCE.has(item.confidence) &&
      typeof item.senderName === "string"
    ) {
      results.push({
        fact: item.fact.trim(),
        category: item.category as UserFactPayload["category"],
        confidence: item.confidence as UserFactPayload["confidence"],
        senderName: item.senderName.trim(),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Store integration
// ---------------------------------------------------------------------------

/** Build sender tags from identity (same logic as build-user-context.ts). */
function buildSenderTags(identity: SenderIdentity): string[] {
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

/**
 * Extract facts from a conversation and store them.
 *
 * Intended to be called fire-and-forget after generating a reply.
 *
 * @param store           — the global context store
 * @param senderIdentity  — who said it
 * @param scopeKey        — current session key
 * @param llmCall         — LLM callback for extraction
 */
export async function extractAndStoreFacts(
  store: ContextStore,
  senderIdentity: SenderIdentity,
  scopeKey: string,
  llmCall: (prompt: string) => Promise<string>,
): Promise<void> {
  const senderTags = buildSenderTags(senderIdentity);
  if (senderTags.length === 0) {
    return;
  }

  // Get recent messages from this session
  const recentRecords = store.query({
    domain: "chat",
    scopeKey,
    order: "newest",
    limit: 10,
  });

  if (recentRecords.length === 0) {
    return;
  }

  const recentMessages = recentRecords
    .toReversed() // oldest first for natural reading order
    .map((r) => {
      const p = r.payload as ChatMessagePayload;
      return { sender: p.sender, body: p.body, isBot: p.isBot };
    });

  // Get existing facts to avoid duplicates
  const existingFactRecords = store.query({
    domain: "user-facts",
    tags: [senderTags[0]],
    order: "newest",
    limit: 30,
  });

  const existingFacts = existingFactRecords.map((r) => (r.payload as UserFactPayload).fact);

  // Extract new facts
  const newFacts = await extractUserFacts(recentMessages, existingFacts, llmCall);

  // Store each new fact
  for (const fact of newFacts) {
    store.append("user-facts", `facts:${senderTags[0]}`, fact, [
      ...senderTags,
      `category:${fact.category}`,
    ]);
  }
}
