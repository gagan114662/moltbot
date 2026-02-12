/**
 * Chat context bridge — connects the in-memory history sliding window
 * to the persistent RLM context store.
 *
 * Usage:
 *   import { ContextStore } from "./store.js";
 *   import { enableChatContextBridge } from "./chat-bridge.js";
 *
 *   const store = new ContextStore();
 *   const dispose = enableChatContextBridge(store);
 *   // ... later, to disconnect:
 *   dispose();
 *
 * When enabled, every appendHistoryEntry() call also writes the message
 * to the context store.  The context store retains the full message body
 * without the 50-message cap, enabling richer context materialization
 * for long-running conversations.
 */

import type { HistoryEntry, HistoryEntryMeta } from "../auto-reply/reply/history.js";
import type { ContextStore } from "./store.js";
import type { ChatMessagePayload } from "./types.js";
import { setHistoryAppendHook } from "../auto-reply/reply/history.js";

/**
 * Enable dual-write from the chat history system to the context store.
 *
 * @param store       — the ContextStore instance to write to
 * @param defaultChannel — channel tag when not derivable (default "unknown")
 * @returns a dispose function that removes the hook
 */
export function enableChatContextBridge(
  store: ContextStore,
  defaultChannel = "unknown",
): () => void {
  setHistoryAppendHook((entry: HistoryEntry, historyKey: string, meta?: HistoryEntryMeta) => {
    const channel = meta?.channel ?? defaultChannel;
    const isBot = meta?.isBot ?? false;
    const payload: ChatMessagePayload = {
      sender: entry.sender,
      body: entry.body,
      channel,
      isBot,
      messageId: entry.messageId,
    };
    const tags = [`channel:${channel}`];
    if (isBot) {
      tags.push("bot");
    }
    store.append("chat", historyKey, payload, tags);
  });

  return () => setHistoryAppendHook(undefined);
}
