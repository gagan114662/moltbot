import type { ChannelId } from "../channels/plugins/types.js";
import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  HumanDelayConfig,
  TypingMode,
} from "./types.base.js";
import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";
import type { MemorySearchConfig } from "./types.tools.js";

export type AgentModelEntryConfig = {
  alias?: string;
  /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
  params?: Record<string, unknown>;
  /** Enable streaming for this model (default: true, false for Ollama to avoid SDK issue #1205). */
  streaming?: boolean;
};

export type AgentModelListConfig = {
  primary?: string;
  fallbacks?: string[];
};

export type AgentContextPruningConfig = {
  mode?: "off" | "cache-ttl";
  /** TTL to consider cache expired (duration string, default unit: minutes). */
  ttl?: string;
  keepLastAssistants?: number;
  softTrimRatio?: number;
  hardClearRatio?: number;
  minPrunableToolChars?: number;
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  softTrim?: {
    maxChars?: number;
    headChars?: number;
    tailChars?: number;
  };
  hardClear?: {
    enabled?: boolean;
    placeholder?: string;
  };
};

export type CliBackendConfig = {
  /** CLI command to execute (absolute path or on PATH). */
  command: string;
  /** Base args applied to every invocation. */
  args?: string[];
  /** Output parsing mode (default: json). */
  output?: "json" | "text" | "jsonl";
  /** Output parsing mode when resuming a CLI session. */
  resumeOutput?: "json" | "text" | "jsonl";
  /** Prompt input mode (default: arg). */
  input?: "arg" | "stdin";
  /** Max prompt length for arg mode (if exceeded, stdin is used). */
  maxPromptArgChars?: number;
  /** Extra env vars injected for this CLI. */
  env?: Record<string, string>;
  /** Env vars to remove before launching this CLI. */
  clearEnv?: string[];
  /** Flag used to pass model id (e.g. --model). */
  modelArg?: string;
  /** Model aliases mapping (config model id → CLI model id). */
  modelAliases?: Record<string, string>;
  /** Flag used to pass session id (e.g. --session-id). */
  sessionArg?: string;
  /** Extra args used when resuming a session (use {sessionId} placeholder). */
  sessionArgs?: string[];
  /** Alternate args to use when resuming a session (use {sessionId} placeholder). */
  resumeArgs?: string[];
  /** When to pass session ids. */
  sessionMode?: "always" | "existing" | "none";
  /** JSON fields to read session id from (in order). */
  sessionIdFields?: string[];
  /** Flag used to pass system prompt. */
  systemPromptArg?: string;
  /** System prompt behavior (append vs replace). */
  systemPromptMode?: "append" | "replace";
  /** When to send system prompt. */
  systemPromptWhen?: "first" | "always" | "never";
  /** Flag used to pass image paths. */
  imageArg?: string;
  /** How to pass multiple images. */
  imageMode?: "repeat" | "list";
  /** Serialize runs for this CLI. */
  serialize?: boolean;
};

export type AgentDefaultsConfig = {
  /** Primary model and fallbacks (provider/model). */
  model?: AgentModelListConfig;
  /** Optional image-capable model and fallbacks (provider/model). */
  imageModel?: AgentModelListConfig;
  /** Model catalog with optional aliases (full provider/model keys). */
  models?: Record<string, AgentModelEntryConfig>;
  /** Agent working directory (preferred). Used as the default cwd for agent runs. */
  workspace?: string;
  /** Optional repository root for system prompt runtime line (overrides auto-detect). */
  repoRoot?: string;
  /** Skip bootstrap (BOOTSTRAP.md creation, etc.) for pre-configured deployments. */
  skipBootstrap?: boolean;
  /** Max chars for injected bootstrap files before truncation (default: 20000). */
  bootstrapMaxChars?: number;
  /** Optional IANA timezone for the user (used in system prompt; defaults to host timezone). */
  userTimezone?: string;
  /** Time format in system prompt: auto (OS preference), 12-hour, or 24-hour. */
  timeFormat?: "auto" | "12" | "24";
  /**
   * Envelope timestamp timezone: "utc" (default), "local", "user", or an IANA timezone string.
   */
  envelopeTimezone?: string;
  /**
   * Include absolute timestamps in message envelopes ("on" | "off", default: "on").
   */
  envelopeTimestamp?: "on" | "off";
  /**
   * Include elapsed time in message envelopes ("on" | "off", default: "on").
   */
  envelopeElapsed?: "on" | "off";
  /** Optional context window cap (used for runtime estimates + status %). */
  contextTokens?: number;
  /** Optional CLI backends for text-only fallback (claude-cli, etc.). */
  cliBackends?: Record<string, CliBackendConfig>;
  /** Opt-in: prune old tool results from the LLM context to reduce token usage. */
  contextPruning?: AgentContextPruningConfig;
  /** Compaction tuning and pre-compaction memory flush behavior. */
  compaction?: AgentCompactionConfig;
  /** Vector memory search configuration (per-agent overrides supported). */
  memorySearch?: MemorySearchConfig;
  /** Default thinking level when no /think directive is present. */
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Default verbose level when no /verbose directive is present. */
  verboseDefault?: "off" | "on" | "full";
  /** Default elevated level when no /elevated directive is present. */
  elevatedDefault?: "off" | "on" | "ask" | "full";
  /** Default block streaming level when no override is present. */
  blockStreamingDefault?: "off" | "on";
  /**
   * Block streaming boundary:
   * - "text_end": end of each assistant text content block (before tool calls)
   * - "message_end": end of the whole assistant message (may include tool blocks)
   */
  blockStreamingBreak?: "text_end" | "message_end";
  /** Soft block chunking for streamed replies (min/max chars, prefer paragraph/newline). */
  blockStreamingChunk?: BlockStreamingChunkConfig;
  /**
   * Block reply coalescing (merge streamed chunks before send).
   * idleMs: wait time before flushing when idle.
   */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Human-like delay between block replies. */
  humanDelay?: HumanDelayConfig;
  timeoutSeconds?: number;
  /** Max inbound media size in MB for agent-visible attachments (text note or future image attach). */
  mediaMaxMb?: number;
  typingIntervalSeconds?: number;
  /** Typing indicator start mode (never|instant|thinking|message). */
  typingMode?: TypingMode;
  /** Periodic background heartbeat runs. */
  heartbeat?: {
    /** Heartbeat interval (duration string, default unit: minutes; default: 30m). */
    every?: string;
    /** Optional active-hours window (local time); heartbeats run only inside this window. */
    activeHours?: {
      /** Start time (24h, HH:MM). Inclusive. */
      start?: string;
      /** End time (24h, HH:MM). Exclusive. Use "24:00" for end-of-day. */
      end?: string;
      /** Timezone for the window ("user", "local", or IANA TZ id). Default: "user". */
      timezone?: string;
    };
    /** Heartbeat model override (provider/model). */
    model?: string;
    /** Session key for heartbeat runs ("main" or explicit session key). */
    session?: string;
    /** Delivery target ("last", "none", or a channel id). */
    target?: "last" | "none" | ChannelId;
    /** Optional delivery override (E.164 for WhatsApp, chat id for Telegram). */
    to?: string;
    /** Optional account id for multi-account channels. */
    accountId?: string;
    /** Override the heartbeat prompt body (default: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK."). */
    prompt?: string;
    /** Max chars allowed after HEARTBEAT_OK before delivery (default: 30). */
    ackMaxChars?: number;
    /**
     * When enabled, deliver the model's reasoning payload for heartbeat runs (when available)
     * as a separate message prefixed with `Reasoning:` (same as `/reasoning on`).
     *
     * Default: false (only the final heartbeat payload is delivered).
     */
    includeReasoning?: boolean;
  };
  /** Max concurrent agent runs across all conversations. Default: 1 (sequential). */
  maxConcurrent?: number;
  /** Sub-agent defaults (spawned via sessions_spawn). */
  subagents?: {
    /** Max concurrent sub-agent runs (global lane: "subagent"). Default: 1. */
    maxConcurrent?: number;
    /** Auto-archive sub-agent sessions after N minutes (default: 60). */
    archiveAfterMinutes?: number;
    /** Default model selection for spawned sub-agents (string or {primary,fallbacks}). */
    model?: string | { primary?: string; fallbacks?: string[] };
    /** Default thinking level for spawned sub-agents (e.g. "off", "low", "medium", "high"). */
    thinking?: string;
  };
  /** Feedback loop: Coder↔Reviewer iterative workflow (Codex codes, Claude verifies). */
  feedbackLoop?: FeedbackLoopConfig;
  /** Reliability and failover controls for autonomous execution. */
  resilience?: ResilienceConfig;
  /** Paging/escalation policy for reliability incidents. */
  alerts?: AlertsConfig;
  /** Optional sandbox settings for non-main sessions. */
  sandbox?: {
    /** Enable sandboxing for sessions. */
    mode?: "off" | "non-main" | "all";
    /**
     * Agent workspace access inside the sandbox.
     * - "none": do not mount the agent workspace into the container; use a sandbox workspace under workspaceRoot
     * - "ro": mount the agent workspace read-only; disables write/edit tools
     * - "rw": mount the agent workspace read/write; enables write/edit tools
     */
    workspaceAccess?: "none" | "ro" | "rw";
    /**
     * Session tools visibility for sandboxed sessions.
     * - "spawned": only allow session tools to target sessions spawned from this session (default)
     * - "all": allow session tools to target any session
     */
    sessionToolsVisibility?: "spawned" | "all";
    /** Container/workspace scope for sandbox isolation. */
    scope?: "session" | "agent" | "shared";
    /** Legacy alias for scope ("session" when true, "shared" when false). */
    perSession?: boolean;
    /** Root directory for sandbox workspaces. */
    workspaceRoot?: string;
    /** Docker-specific sandbox settings. */
    docker?: SandboxDockerSettings;
    /** Optional sandboxed browser settings. */
    browser?: SandboxBrowserSettings;
    /** Auto-prune sandbox containers. */
    prune?: SandboxPruneSettings;
  };
};

export type AgentCompactionMode = "default" | "safeguard";

export type AgentCompactionConfig = {
  /** Compaction summarization mode. */
  mode?: AgentCompactionMode;
  /** Minimum reserve tokens enforced for Pi compaction (0 disables the floor). */
  reserveTokensFloor?: number;
  /** Max share of context window for history during safeguard pruning (0.1–0.9, default 0.5). */
  maxHistoryShare?: number;
  /** Pre-compaction memory flush (agentic turn). Default: enabled. */
  memoryFlush?: AgentCompactionMemoryFlushConfig;
};

export type AgentCompactionMemoryFlushConfig = {
  /** Enable the pre-compaction memory flush (default: true). */
  enabled?: boolean;
  /** Run the memory flush when context is within this many tokens of the compaction threshold. */
  softThresholdTokens?: number;
  /** User prompt used for the memory flush turn (NO_REPLY is enforced if missing). */
  prompt?: string;
  /** System prompt appended for the memory flush turn. */
  systemPrompt?: string;
};

/** Feedback loop command configuration (test, lint, etc.). */
export type FeedbackLoopCommand = {
  command: string;
  timeoutSeconds?: number;
  required?: boolean;
};

export type FeedbackLoopBrowserConfig = {
  enabled?: boolean;
  urls?: string[];
  checkConsole?: boolean;
  checkNetwork?: boolean;
  screenshotOnError?: boolean;
  /** Capture screenshots as proof of verification (default: true) */
  captureScreenshots?: boolean;
  /** Browser service URL (default: http://127.0.0.1:18789) */
  browserUrl?: string;
  /** Browser profile to use (default: "openclaw") */
  profile?: string;
  /** Custom JS function to evaluate - return false to fail check */
  customCheck?: string;
  /** Audio/video verification settings for media-heavy features. */
  media?: {
    /** Enable media checks (default: false). */
    enabled?: boolean;
    /** Require at least one media element when enabled (default: true). */
    required?: boolean;
    /** Optional selectors for audio elements; falls back to all <audio>. */
    audioSelectors?: string[];
    /** Optional selectors for video elements; falls back to all <video>. */
    videoSelectors?: string[];
    /** Minimum HTMLMediaElement.readyState expected (default: 1). */
    minReadyState?: number;
    /** Require element to be playable (readyState >= 2) (default: true). */
    requirePlayable?: boolean;
    /** Minimum duration in seconds when finite duration is available. */
    minDurationSeconds?: number;
    /** Max allowed audio chunk size in milliseconds for runtime checks. */
    maxAudioChunkMs?: number;
    /** Max allowed reconnect attempts during runtime verification. */
    maxReconnects?: number;
    /** Max allowed gap between video frames in milliseconds (p95). */
    maxFrameGapMs?: number;
    /** Min required media messages per minute during runtime checks. */
    minMessagesPerMinute?: number;
    /** Require ping/pong heartbeat success. */
    requireBidirectionalPing?: boolean;
    /** Max allowed websocket auth failures during runtime checks. */
    maxAuthFailures?: number;
  };
};

export type FeedbackLoopRoutingTarget = {
  /** Human-readable target alias (e.g. "aitutor"). */
  name: string;
  /** Absolute repo/workspace path. */
  path: string;
  /** Optional branch regex pattern (e.g. "^v1$|^feature/"). */
  branchPattern?: string;
};

export type FeedbackLoopRoutingConfig = {
  /** Require explicit repo/branch binding before coding (default: false). */
  requireRepoBinding?: boolean;
  /** Force branch checks for selected target (default: false). */
  requireBranchMatch?: boolean;
  /** Allowed coding targets when binding is required. */
  allowedTargets?: FeedbackLoopRoutingTarget[];
  /** Behavior when routing is ambiguous. */
  onAmbiguousTarget?: "fail_closed" | "ask" | "best_effort";
  /** Optional default target alias. */
  defaultTarget?: string;
};

export type FeedbackLoopInterventionConfig = {
  pauseAfterIterations?: number;
  pauseOnBrowserFail?: boolean;
  requireApprovalAfter?: number;
  notifyChannel?: "terminal" | "channel";
};

export type FeedbackLoopTerminalConfig = {
  streamExchange?: boolean;
  verbose?: boolean;
};

export type FeedbackLoopMemoryConfig = {
  enabled?: boolean;
  feedbackHistoryPath?: string;
  searchBeforeReview?: boolean;
  saveAfterReview?: boolean;
};

export type FeedbackLoopReviewConfig = {
  useBrowser?: boolean;
  requireStructuredFeedback?: boolean;
  minimumUIScore?: number;
  minimumCoverageScenarios?: number;
};

export type FeedbackLoopRegressionConfig = {
  captureBaseline?: boolean;
  compareScreenshots?: boolean;
  failOnRegression?: boolean;
};

export type FeedbackLoopInterviewConfig = {
  /** Enable interview mode for complex tasks */
  enabled?: boolean;
  /** Only interview for tasks above this complexity */
  minComplexity?: "simple" | "medium" | "complex";
};

export type FeedbackLoopCommitConfig = {
  /** Enable auto-commit after approval */
  enabled?: boolean;
  /** Commit message style */
  messageStyle?: "conventional" | "descriptive" | "brief";
  /** Require user confirmation before commit */
  requireConfirmation?: boolean;
  /** Auto-push after commit */
  autoPush?: boolean;
  /** Create PR after push */
  createPR?: boolean;
};

/** Antigravity (Google Cloud Code Assist) fallback config */
export type FeedbackLoopAntigravityConfig = {
  /** Enable Antigravity as fallback when primary coder fails */
  enabled?: boolean;
  /** Preferred coder model (default: claude-sonnet-4-5 for speed) */
  coderModel?: string;
  /** Preferred reviewer model (default: claude-opus-4-5-thinking for thoroughness) */
  reviewerModel?: string;
  /** Use thinking models when available */
  useThinking?: boolean;
  /** Google Cloud project ID (auto-detected from OAuth if not set) */
  projectId?: string;
};

/** Auto-trigger configuration for coding task detection */
export type FeedbackLoopAutoTriggerConfig = {
  /** Enable auto-triggering for detected coding tasks (default: false) */
  enabled?: boolean;
  /** Minimum confidence threshold to auto-trigger (0-1, default: 0.7) */
  confidenceThreshold?: number;
  /** Additional regex patterns to treat as coding tasks */
  additionalPatterns?: string[];
  /** Regex patterns to exclude from auto-triggering */
  excludePatterns?: string[];
  /** Only auto-trigger on these channels (empty = all channels) */
  channels?: string[];
  /** Skip auto-trigger for messages shorter than this (default: 15) */
  minLength?: number;
};

export type FeedbackLoopGatesConfig = {
  /** Require strict reviewer JSON schema before approval (default: true). */
  requireReviewerJson?: boolean;
  /** Require all configured verification commands to pass (default: true). */
  requireAllCommandsPass?: boolean;
  /** Require zero browser verification errors (default: true). */
  requireNoBrowserErrors?: boolean;
  /** Require proof artifacts (screenshots/check summaries) before approval (default: true). */
  requireArtifactProof?: boolean;
  /** Block approval when reviewer payload parsing fails (default: true). */
  blockApprovalOnParseFailure?: boolean;
  /** Require runtime session health evidence (JWT/session/ws lifecycle). */
  requireRuntimeSessionHealthy?: boolean;
  /** Require Gemini live session health evidence. */
  requireGeminiLiveHealthy?: boolean;
  /** Require no duplicate tool call evidence. */
  requireNoToolCallDuplication?: boolean;
  /** Require console warning/error budget checks to pass. */
  requireConsoleBudget?: boolean;
};

export type FeedbackLoopConfig = {
  enabled?: boolean;
  coder?: string;
  reviewer?: string;
  reviewerFallbacks?: string[];
  thinking?: "off" | "low" | "medium" | "high";
  maxIterations?: number;
  commands?: FeedbackLoopCommand[];
  browser?: FeedbackLoopBrowserConfig;
  terminal?: FeedbackLoopTerminalConfig;
  intervention?: FeedbackLoopInterventionConfig;
  acceptanceCriteria?: string[];
  generateAcceptanceCriteria?: boolean;
  checklistPath?: string;
  memory?: FeedbackLoopMemoryConfig;
  review?: FeedbackLoopReviewConfig;
  regression?: FeedbackLoopRegressionConfig;
  /** Interview mode for requirements gathering */
  interview?: FeedbackLoopInterviewConfig;
  /** Auto-commit configuration */
  commit?: FeedbackLoopCommitConfig;
  /** Antigravity (Google Cloud Code Assist) fallback - Codex fails → Antigravity codes */
  antigravity?: FeedbackLoopAntigravityConfig;
  /** Auto-trigger feedback loop for detected coding tasks */
  autoTrigger?: FeedbackLoopAutoTriggerConfig;
  /** Hard approval gates for deterministic autonomous delivery. */
  gates?: FeedbackLoopGatesConfig;
  /** Fail-closed routing policy for multi-repo workspaces. */
  routing?: FeedbackLoopRoutingConfig;
};

export type ResilienceQueueRetryConfig = {
  enabled?: boolean;
  backoffSec?: number[];
  maxAttempts?: number;
};

export type ResilienceConfig = {
  /** Availability target (e.g. "99.99"). */
  slo?: {
    target?: string;
  };
  failover?: {
    mode?: "active-active" | "active-passive";
  };
  providers?: {
    /** Strictly allowed provider/model keys for runtime routing. */
    allowlist?: string[];
    /** Minimum providers that should remain healthy before alerting/failover escalation. */
    minHealthyProviders?: number;
  };
  cooldown?: {
    queueRetry?: ResilienceQueueRetryConfig;
  };
  storage?: {
    sessions?: number;
    memory?: number;
    artifacts?: number;
  };
  proof?: {
    video?: boolean;
    artifacts?: boolean;
  };
  /** Emergency model used when normal model selection is unavailable. */
  breakGlass?: {
    model?: string;
  };
};

export type AlertsConfig = {
  paging?: {
    enabled?: boolean;
    escalationMinutes?: number[];
  };
};
