export { ContextStore, estimateTokens } from "./store.js";
export { materializeContext, formatRecordsAsMarkdown } from "./materialize.js";
export { enableChatContextBridge } from "./chat-bridge.js";
export { getGlobalContextStore, resetGlobalContextStore } from "./singleton.js";
export { buildExtendedChatContext, buildExtendedChatContextAsync } from "./build-chat-context.js";
export { historyEntryToRecord } from "./adapters/chat-adapter.js";
export { qaIterationToRecord } from "./adapters/qa-adapter.js";
export { overnightCycleToRecord } from "./adapters/overnight-adapter.js";
export type {
  ContextDomain,
  ContextMeta,
  ContextRecord,
  ContextQuery,
  ChatMessagePayload,
  QaIterationPayload,
  OvernightCyclePayload,
  MaterializeStrategy,
  MaterializeOptions,
  MaterializeResult,
} from "./types.js";
