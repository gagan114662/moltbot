import { z } from "zod";
import {
  HeartbeatSchema,
  MemorySearchSchema,
  SandboxBrowserSchema,
  SandboxDockerSchema,
  SandboxPruneSchema,
} from "./zod-schema.agent-runtime.js";
import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  CliBackendSchema,
  HumanDelaySchema,
} from "./zod-schema.core.js";

export const AgentDefaultsSchema = z
  .object({
    model: z
      .object({
        primary: z.string().optional(),
        fallbacks: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    imageModel: z
      .object({
        primary: z.string().optional(),
        fallbacks: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    models: z
      .record(
        z.string(),
        z
          .object({
            alias: z.string().optional(),
            /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
            params: z.record(z.string(), z.unknown()).optional(),
            /** Enable streaming for this model (default: true, false for Ollama to avoid SDK issue #1205). */
            streaming: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    workspace: z.string().optional(),
    repoRoot: z.string().optional(),
    skipBootstrap: z.boolean().optional(),
    bootstrapMaxChars: z.number().int().positive().optional(),
    userTimezone: z.string().optional(),
    timeFormat: z.union([z.literal("auto"), z.literal("12"), z.literal("24")]).optional(),
    envelopeTimezone: z.string().optional(),
    envelopeTimestamp: z.union([z.literal("on"), z.literal("off")]).optional(),
    envelopeElapsed: z.union([z.literal("on"), z.literal("off")]).optional(),
    contextTokens: z.number().int().positive().optional(),
    cliBackends: z.record(z.string(), CliBackendSchema).optional(),
    memorySearch: MemorySearchSchema,
    contextPruning: z
      .object({
        mode: z.union([z.literal("off"), z.literal("cache-ttl")]).optional(),
        ttl: z.string().optional(),
        keepLastAssistants: z.number().int().nonnegative().optional(),
        softTrimRatio: z.number().min(0).max(1).optional(),
        hardClearRatio: z.number().min(0).max(1).optional(),
        minPrunableToolChars: z.number().int().nonnegative().optional(),
        tools: z
          .object({
            allow: z.array(z.string()).optional(),
            deny: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        softTrim: z
          .object({
            maxChars: z.number().int().nonnegative().optional(),
            headChars: z.number().int().nonnegative().optional(),
            tailChars: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        hardClear: z
          .object({
            enabled: z.boolean().optional(),
            placeholder: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    compaction: z
      .object({
        mode: z.union([z.literal("default"), z.literal("safeguard")]).optional(),
        reserveTokensFloor: z.number().int().nonnegative().optional(),
        maxHistoryShare: z.number().min(0.1).max(0.9).optional(),
        memoryFlush: z
          .object({
            enabled: z.boolean().optional(),
            softThresholdTokens: z.number().int().nonnegative().optional(),
            prompt: z.string().optional(),
            systemPrompt: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    thinkingDefault: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
        z.literal("xhigh"),
      ])
      .optional(),
    verboseDefault: z.union([z.literal("off"), z.literal("on"), z.literal("full")]).optional(),
    elevatedDefault: z
      .union([z.literal("off"), z.literal("on"), z.literal("ask"), z.literal("full")])
      .optional(),
    blockStreamingDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
    blockStreamingBreak: z.union([z.literal("text_end"), z.literal("message_end")]).optional(),
    blockStreamingChunk: BlockStreamingChunkSchema.optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    humanDelay: HumanDelaySchema.optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    mediaMaxMb: z.number().positive().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    typingMode: z
      .union([
        z.literal("never"),
        z.literal("instant"),
        z.literal("thinking"),
        z.literal("message"),
      ])
      .optional(),
    heartbeat: HeartbeatSchema,
    maxConcurrent: z.number().int().positive().optional(),
    subagents: z
      .object({
        maxConcurrent: z.number().int().positive().optional(),
        archiveAfterMinutes: z.number().int().positive().optional(),
        model: z
          .union([
            z.string(),
            z
              .object({
                primary: z.string().optional(),
                fallbacks: z.array(z.string()).optional(),
              })
              .strict(),
          ])
          .optional(),
        thinking: z.string().optional(),
      })
      .strict()
      .optional(),
    sandbox: z
      .object({
        mode: z.union([z.literal("off"), z.literal("non-main"), z.literal("all")]).optional(),
        workspaceAccess: z.union([z.literal("none"), z.literal("ro"), z.literal("rw")]).optional(),
        sessionToolsVisibility: z.union([z.literal("spawned"), z.literal("all")]).optional(),
        scope: z.union([z.literal("session"), z.literal("agent"), z.literal("shared")]).optional(),
        perSession: z.boolean().optional(),
        workspaceRoot: z.string().optional(),
        docker: SandboxDockerSchema,
        browser: SandboxBrowserSchema,
        prune: SandboxPruneSchema,
      })
      .strict()
      .optional(),
    feedbackLoop: z
      .object({
        enabled: z.boolean().optional(),
        coder: z.string().optional(),
        reviewer: z.string().optional(),
        reviewerFallbacks: z.array(z.string()).optional(),
        thinking: z
          .union([z.literal("off"), z.literal("low"), z.literal("medium"), z.literal("high")])
          .optional(),
        maxIterations: z.number().optional(),
        commands: z
          .array(
            z.object({
              command: z.string(),
              timeoutSeconds: z.number().optional(),
              required: z.boolean().optional(),
            }),
          )
          .optional(),
        browser: z
          .object({
            enabled: z.boolean().optional(),
            urls: z.array(z.string()).optional(),
            checkConsole: z.boolean().optional(),
            checkNetwork: z.boolean().optional(),
            screenshotOnError: z.boolean().optional(),
            captureScreenshots: z.boolean().optional(),
            browserUrl: z.string().optional(),
            profile: z.string().optional(),
            customCheck: z.string().optional(),
            media: z
              .object({
                enabled: z.boolean().optional(),
                required: z.boolean().optional(),
                audioSelectors: z.array(z.string()).optional(),
                videoSelectors: z.array(z.string()).optional(),
                minReadyState: z.number().int().min(0).max(4).optional(),
                requirePlayable: z.boolean().optional(),
                minDurationSeconds: z.number().nonnegative().optional(),
                maxAudioChunkMs: z.number().int().positive().optional(),
                maxReconnects: z.number().int().nonnegative().optional(),
                maxFrameGapMs: z.number().int().positive().optional(),
                minMessagesPerMinute: z.number().int().positive().optional(),
                requireBidirectionalPing: z.boolean().optional(),
                maxAuthFailures: z.number().int().nonnegative().optional(),
              })
              .optional(),
          })
          .optional(),
        terminal: z
          .object({
            streamExchange: z.boolean().optional(),
            verbose: z.boolean().optional(),
          })
          .optional(),
        intervention: z
          .object({
            pauseAfterIterations: z.number().optional(),
            pauseOnBrowserFail: z.boolean().optional(),
            requireApprovalAfter: z.number().optional(),
            notifyChannel: z.union([z.literal("terminal"), z.literal("channel")]).optional(),
          })
          .optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        generateAcceptanceCriteria: z.boolean().optional(),
        checklistPath: z.string().optional(),
        memory: z
          .object({
            enabled: z.boolean().optional(),
            feedbackHistoryPath: z.string().optional(),
            searchBeforeReview: z.boolean().optional(),
            saveAfterReview: z.boolean().optional(),
          })
          .optional(),
        review: z
          .object({
            useBrowser: z.boolean().optional(),
            requireStructuredFeedback: z.boolean().optional(),
            minimumUIScore: z.number().optional(),
            minimumCoverageScenarios: z.number().optional(),
          })
          .optional(),
        regression: z
          .object({
            captureBaseline: z.boolean().optional(),
            compareScreenshots: z.boolean().optional(),
            failOnRegression: z.boolean().optional(),
          })
          .optional(),
        interview: z
          .object({
            enabled: z.boolean().optional(),
            minComplexity: z
              .union([z.literal("simple"), z.literal("medium"), z.literal("complex")])
              .optional(),
          })
          .optional(),
        commit: z
          .object({
            enabled: z.boolean().optional(),
            messageStyle: z
              .union([z.literal("conventional"), z.literal("descriptive"), z.literal("brief")])
              .optional(),
            requireConfirmation: z.boolean().optional(),
            autoPush: z.boolean().optional(),
            createPR: z.boolean().optional(),
          })
          .optional(),
        antigravity: z
          .object({
            enabled: z.boolean().optional(),
            coderModel: z.string().optional(),
            reviewerModel: z.string().optional(),
            useThinking: z.boolean().optional(),
            projectId: z.string().optional(),
          })
          .optional(),
        autoTrigger: z
          .object({
            enabled: z.boolean().optional(),
            confidenceThreshold: z.number().min(0).max(1).optional(),
            additionalPatterns: z.array(z.string()).optional(),
            excludePatterns: z.array(z.string()).optional(),
            channels: z.array(z.string()).optional(),
            minLength: z.number().int().positive().optional(),
          })
          .optional(),
        gates: z
          .object({
            requireReviewerJson: z.boolean().optional(),
            requireAllCommandsPass: z.boolean().optional(),
            requireNoBrowserErrors: z.boolean().optional(),
            requireArtifactProof: z.boolean().optional(),
            blockApprovalOnParseFailure: z.boolean().optional(),
            requireRuntimeSessionHealthy: z.boolean().optional(),
            requireGeminiLiveHealthy: z.boolean().optional(),
            requireNoToolCallDuplication: z.boolean().optional(),
            requireConsoleBudget: z.boolean().optional(),
          })
          .strict()
          .optional(),
        routing: z
          .object({
            requireRepoBinding: z.boolean().optional(),
            requireBranchMatch: z.boolean().optional(),
            allowedTargets: z
              .array(
                z
                  .object({
                    name: z.string(),
                    path: z.string(),
                    branchPattern: z.string().optional(),
                  })
                  .strict(),
              )
              .optional(),
            onAmbiguousTarget: z
              .union([z.literal("fail_closed"), z.literal("ask"), z.literal("best_effort")])
              .optional(),
            defaultTarget: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .optional(),
    resilience: z
      .object({
        slo: z
          .object({
            target: z.string().optional(),
          })
          .strict()
          .optional(),
        failover: z
          .object({
            mode: z.union([z.literal("active-active"), z.literal("active-passive")]).optional(),
          })
          .strict()
          .optional(),
        providers: z
          .object({
            allowlist: z.array(z.string()).optional(),
            minHealthyProviders: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        cooldown: z
          .object({
            queueRetry: z
              .object({
                enabled: z.boolean().optional(),
                backoffSec: z.array(z.number().int().positive()).optional(),
                maxAttempts: z.number().int().positive().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        storage: z
          .object({
            sessions: z.number().int().positive().optional(),
            memory: z.number().int().positive().optional(),
            artifacts: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        proof: z
          .object({
            video: z.boolean().optional(),
            artifacts: z.boolean().optional(),
          })
          .strict()
          .optional(),
        breakGlass: z
          .object({
            model: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    alerts: z
      .object({
        paging: z
          .object({
            enabled: z.boolean().optional(),
            escalationMinutes: z.array(z.number().int().positive()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
