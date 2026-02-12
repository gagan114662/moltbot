/**
 * RLM Context Store — type definitions.
 *
 * Inspired by the Recursive Language Models paper (arxiv 2512.24601v2):
 * treat long context as external environment, let the model decide what to pull.
 *
 * General-purpose context store serving all of moltbot:
 * - Channel conversations (WhatsApp, Telegram, Slack, Discord)
 * - Voice QA iterations (copilot loop)
 * - Overnight healing cycles
 */

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/** Source domain for context records. Each domain has its own payload shape. */
export type ContextDomain = "chat" | "qa-iteration" | "overnight-cycle";

// ---------------------------------------------------------------------------
// Record metadata & envelope
// ---------------------------------------------------------------------------

/** Universal metadata attached to every context record. */
export type ContextMeta = {
  /** Unique record ID (UUID v4). */
  id: string;
  /** Which domain this record belongs to. */
  domain: ContextDomain;
  /** Monotonic timestamp in ms (Date.now()). */
  timestamp: number;
  /** Free-form tags for filtering (e.g. "channel:whatsapp", "diagnosis:ws-1011"). */
  tags: string[];
  /** The conversation/loop/run key this record belongs to. */
  scopeKey: string;
  /** Approximate token count of the payload (chars / 4). */
  estimatedTokens: number;
  /** Monotonic sequence number for stable ordering within same timestamp. */
  seq: number;
};

/** A single record in the context store. Generic over the payload type T. */
export type ContextRecord<T = unknown> = {
  meta: ContextMeta;
  /** The domain-specific payload. */
  payload: T;
  /** Optional LLM-generated summary (populated lazily during materialization). */
  summary?: string;
};

// ---------------------------------------------------------------------------
// Domain payloads
// ---------------------------------------------------------------------------

/** Chat message payload (channel conversations). */
export type ChatMessagePayload = {
  sender: string;
  body: string;
  channel: string;
  /** Whether this message was sent by the bot. */
  isBot: boolean;
  messageId?: string;
  /** Referenced message ID (for replies/threads). */
  replyTo?: string;
};

/** QA iteration payload (voice QA loop). */
export type QaIterationPayload = {
  iteration: number;
  passed: boolean;
  /** Full nudge text (not truncated). */
  nudgeSent: string;
  /** Full git diff (not truncated). */
  diffFull: string;
  changedFiles: string[];
  diagnoses: Array<{
    rootCause: string;
    severity: string;
    suggestedFix: string;
  }>;
  consoleLogs: string[];
  consoleErrors: string[];
  wsEvents: Array<{
    type: string;
    closeCode?: number;
    payload?: string;
  }>;
  scorecard: { overall: number } | null;
};

/** Overnight cycle payload (multi-cycle healing). */
export type OvernightCyclePayload = {
  cycle: number;
  phase: string;
  strategy: string;
  stopReason: string;
  iterations: number;
  score: number | null;
  diagnoses: string[];
  changedFiles: string[];
  scoreImproved: boolean;
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** Filter criteria for querying the context store. */
export type ContextQuery = {
  /** Filter by domain (single or multiple). */
  domain?: ContextDomain | ContextDomain[];
  /** Filter by scope key (exact match). */
  scopeKey?: string;
  /** Filter by tags (all must match). */
  tags?: string[];
  /** Include records after this timestamp (ms). */
  after?: number;
  /** Include records before this timestamp (ms). */
  before?: number;
  /** Full-text search on JSON-stringified payload. */
  textSearch?: string;
  /** Max results to return. */
  limit?: number;
  /** Sort order: "newest" (default) or "oldest". */
  order?: "newest" | "oldest";
};

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

/** A strategy for selecting which records to materialize. */
export type MaterializeStrategy =
  | { kind: "recency"; count: number }
  | { kind: "relevance"; query: string; maxResults: number }
  | { kind: "tagged"; tags: string[]; limit?: number }
  | { kind: "summary-window"; windowSize: number; summarizeOlder: boolean };

/** Options for materializing context to disk files. */
export type MaterializeOptions = {
  /** Target directory for materialized files. */
  outputDir: string;
  /** Max total estimated tokens across all materialized content. */
  tokenBudget: number;
  /** Selection strategies to apply (in priority order). */
  strategies: MaterializeStrategy[];
  /** Optional LLM summarizer for condensing older records. */
  llmSummarize?: (text: string) => Promise<string>;
};

/** Result of a materialization operation. */
export type MaterializeResult = {
  /** Files written to disk. */
  files: Array<{
    path: string;
    recordCount: number;
    estimatedTokens: number;
  }>;
  /** Total estimated tokens across all files. */
  totalTokens: number;
};
