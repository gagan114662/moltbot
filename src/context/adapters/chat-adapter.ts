/**
 * Chat adapter — converts HistoryEntry to ContextRecord<ChatMessagePayload>.
 */

import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import type { ChatMessagePayload, ContextRecord } from "../types.js";

/**
 * Convert a HistoryEntry from the auto-reply history system into a
 * ContextRecord suitable for the context store.
 */
export function historyEntryToRecord(
  entry: HistoryEntry,
  scopeKey: string,
  channel: string,
  isBot: boolean,
): Omit<ContextRecord<ChatMessagePayload>, "meta"> & {
  domain: "chat";
  scopeKey: string;
  tags: string[];
} {
  const payload: ChatMessagePayload = {
    sender: entry.sender,
    body: entry.body,
    channel,
    isBot,
    messageId: entry.messageId,
  };

  return {
    domain: "chat",
    scopeKey,
    tags: [`channel:${channel}`, ...(isBot ? ["bot"] : [])],
    payload,
  };
}
