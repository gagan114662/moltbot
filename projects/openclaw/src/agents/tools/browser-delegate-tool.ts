import type { AnyAgentTool } from "./common.js";
import { browserExtensionAttachActive, browserStatus } from "../../browser/client.js";
import { loadConfig } from "../../config/config.js";
import {
  appendDelegationAudit,
  buildDelegationAssessment,
  buildDelegationGovernancePolicy,
  inferAuthRequired,
  type DelegationAssessment,
  type DelegationDimensionScores,
  type DelegationGovernancePolicy,
} from "../delegation-framework.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam } from "./common.js";

type BrowserDelegationAuthority = "read_only" | "safe_actions" | "full_browser";
type BrowserProfile = "chrome" | "openclaw";
type BrowserCleanupPolicy = "delete" | "keep";

type BrowserDelegationContract = {
  task: string;
  authority: {
    level: BrowserDelegationAuthority;
    browserProfile: BrowserProfile;
    fallbackProfile: BrowserProfile;
  };
  context: {
    seedUrls: string[];
    notes: string[];
  };
  successCriteria: string[];
  constraints: string[];
  visibility: {
    deliverable: string;
    checkpointMinutes: number;
  };
  escalation: {
    allowNestedDelegation: boolean;
    maxRecursionDepth: number;
    parallelBranches: number;
    onBlocked: string;
  };
  quality: {
    minSources: number;
    minIndependentDomains: number;
    requireCrossVerification: boolean;
    mustReportUncertainty: boolean;
  };
  governance: DelegationGovernancePolicy;
  assessment: DelegationAssessment;
  auth: {
    required: boolean;
    chromeAttached: boolean;
    fallbackReady: boolean;
  };
  timeoutMinutes: number;
};

const BrowserDelegateToolSchema = {
  type: "object" as const,
  properties: {
    task: { type: "string" },
    label: { type: "string" },
    model: { type: "string" },
    profile: { type: "string", enum: ["chrome", "openclaw"] },
    fallbackProfile: { type: "string", enum: ["chrome", "openclaw"] },
    authority: { type: "string", enum: ["read_only", "safe_actions", "full_browser"] },
    riskTolerance: { type: "string", enum: ["low", "medium", "high"] },
    authRequired: { type: "boolean" },
    deliverable: { type: "string" },
    seedUrls: { type: "array", items: { type: "string" } },
    contextNotes: { type: "array", items: { type: "string" } },
    successCriteria: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    maxMinutes: { type: "number", minimum: 1 },
    checkpointMinutes: { type: "number", minimum: 1 },
    maxRecursionDepth: { type: "number", minimum: 0 },
    parallelBranches: { type: "number", minimum: 1 },
    minSources: { type: "number", minimum: 1 },
    minIndependentDomains: { type: "number", minimum: 1 },
    requireCrossVerification: { type: "boolean" },
    mustReportUncertainty: { type: "boolean" },
    dimensionOverrides: {
      type: "object",
      properties: {
        capabilityMatch: { type: "number", minimum: 0, maximum: 1 },
        contextTransferability: { type: "number", minimum: 0, maximum: 1 },
        authorityBoundaries: { type: "number", minimum: 0, maximum: 1 },
        riskContainment: { type: "number", minimum: 0, maximum: 1 },
        effortEconomics: { type: "number", minimum: 0, maximum: 1 },
        observability: { type: "number", minimum: 0, maximum: 1 },
      },
      additionalProperties: false,
    },
    cleanup: { type: "string", enum: ["delete", "keep"] },
  },
  required: ["task"],
};

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  const integer = Math.floor(value);
  return Math.max(min, Math.min(max, integer));
}

function readEnumParam<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  const match = allowed.find((candidate) => candidate === normalized);
  if (match) {
    return match;
  }
  throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
}

function normalizeStringList(values: string[] | undefined, limit = 12): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function formatListForPrompt(lines: string[]) {
  if (lines.length === 0) {
    return "- (none)";
  }
  return lines.map((line) => `- ${line}`).join("\n");
}

function readDimensionOverrides(value: unknown): Partial<DelegationDimensionScores> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const out: Partial<DelegationDimensionScores> = {};
  for (const key of [
    "capabilityMatch",
    "contextTransferability",
    "authorityBoundaries",
    "riskContainment",
    "effortEconomics",
    "observability",
  ] as const) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildDelegationPrompt(contract: BrowserDelegationContract): string {
  return [
    "You are a delegated browser mission sub-agent.",
    "",
    "Delegation contract:",
    `- Task: ${contract.task}`,
    `- Authority: ${contract.authority.level}`,
    `- Browser profile: ${contract.authority.browserProfile}`,
    `- Fallback profile: ${contract.authority.fallbackProfile}`,
    `- Timeout: ${contract.timeoutMinutes} minutes`,
    `- Checkpoint cadence: every ${contract.visibility.checkpointMinutes} minutes`,
    `- Nested delegation allowed: ${contract.escalation.allowNestedDelegation ? "yes" : "no"}`,
    `- Max recursion depth: ${contract.escalation.maxRecursionDepth}`,
    `- Parallel branch limit: ${contract.escalation.parallelBranches}`,
    `- Minimum sources: ${contract.quality.minSources}`,
    `- Minimum independent domains: ${contract.quality.minIndependentDomains}`,
    `- Cross-verification required: ${contract.quality.requireCrossVerification ? "yes" : "no"}`,
    `- Must report uncertainty: ${contract.quality.mustReportUncertainty ? "yes" : "no"}`,
    `- Delegation score: ${contract.assessment.score}`,
    `- Delegation decision: ${contract.assessment.decision}`,
    "",
    "Six-dimension assessment:",
    `- Capability match: ${contract.assessment.dimensionScores.capabilityMatch}`,
    `- Context transferability: ${contract.assessment.dimensionScores.contextTransferability}`,
    `- Authority boundaries: ${contract.assessment.dimensionScores.authorityBoundaries}`,
    `- Risk containment: ${contract.assessment.dimensionScores.riskContainment}`,
    `- Effort economics: ${contract.assessment.dimensionScores.effortEconomics}`,
    `- Observability: ${contract.assessment.dimensionScores.observability}`,
    "",
    "Seed URLs:",
    formatListForPrompt(contract.context.seedUrls),
    "",
    "Context notes:",
    formatListForPrompt(contract.context.notes),
    "",
    "Success criteria:",
    formatListForPrompt(contract.successCriteria),
    "",
    "Constraints:",
    formatListForPrompt(contract.constraints),
    "",
    "Quality gates:",
    `- Collect at least ${contract.quality.minSources} relevant sources before finalizing.`,
    `- Use at least ${contract.quality.minIndependentDomains} independent domains.`,
    contract.quality.requireCrossVerification
      ? "- Cross-check key claims across multiple sources and flag disagreements explicitly."
      : "- Cross-check key claims where possible.",
    contract.quality.mustReportUncertainty
      ? "- If evidence is weak or conflicting, state uncertainty clearly and do not over-claim."
      : "- Report confidence per finding.",
    "- Do not offload verification to the user. Perform verification during this run.",
    "- Do not output placeholders like UNVERIFIED quotes as the final user answer.",
    "- If exact quote verification is unavailable, remove the quote and provide a verified paraphrase with source links.",
    "- Any direct quote must be explicitly verified in this run against the cited source.",
    "- If quality gates are not met before timeout, return INSUFFICIENT_EVIDENCE with partial findings and exact missing gates.",
    "",
    "Governance policy:",
    `- Emit CHECKPOINT updates every ${contract.governance.checkpointEveryMinutes} minutes with completed/blocked/next fields.`,
    `- Escalation triggers: ${contract.governance.escalationTriggers.join(", ")}`,
    `- Rollback strategy: ${contract.governance.rollbackStrategy}`,
    `- Visibility events: ${contract.governance.visibilityEvents.join(", ")}`,
    "",
    "Execution policy:",
    "- Use the browser tool as your primary execution path.",
    "- Do not stop because of manual attach prompts; let browser auto-attach/retry/fallback handle this.",
    "- If Chrome is attached but on the wrong page, navigate that tab to the requested site (or open a new tab) and continue; do not ask the user to attach a different tab.",
    "- Authenticated-site default: for any website, if account/feed section is not specified, use the currently logged-in account and the default home/primary feed view, then proceed without asking a clarification question.",
    "- Verify important claims and include source URLs in the final output.",
    "- If blocked, follow escalation policy before giving up.",
    "- If useful and allowed, split independent sub-problems into sub-agents and merge results.",
    "- For recursive decomposition, pass sub-tasks to sub-agents with explicit acceptance criteria; merge only verified sub-results.",
    "- Do not give a final polished answer until all reachable quality gates are satisfied or timeout occurs.",
    "- Do not ask the user for permission to do basic verification; just do it unless blocked by environment limits.",
    "- End your final response with a strict machine-readable contract:",
    "  FINAL_VAR_BEGIN",
    '  {"status":"ok|insufficient_evidence|auth_required|blocked","answer":"...","findings":["..."],"uncertainty":["..."],"evidence":[{"claim":"...","source":"...","confidence":"high|medium|low"}],"recursion":{"depth":1,"subagentsLaunched":2,"branches":2}}',
    "  FINAL_VAR_END",
    contract.auth.required && !contract.auth.chromeAttached
      ? "- This task likely needs authenticated context. Check login state early. If both profiles are logged out, return AUTH_REQUIRED with exact one-step remediation."
      : "",
    "",
    `Escalation policy: ${contract.escalation.onBlocked}`,
    "",
    "Final answer format:",
    `1. Deliverable: ${contract.visibility.deliverable}`,
    "2. Evidence table (claim | source URL | confidence | support/conflict notes).",
    "3. Actions taken and automation path used.",
    "4. Quality gate status (PASS/FAIL per gate).",
    "5. Governance report (checkpoints, escalations, rollback actions).",
    "6. Open risks, uncertainty, and next step recommendations.",
  ]
    .filter(Boolean)
    .join("\n");
}

function extractResultDetails(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    const details = (value as { details?: unknown }).details;
    if (details && typeof details === "object") {
      return details as Record<string, unknown>;
    }
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const textPart = content.find((item) => {
        if (!item || typeof item !== "object") {
          return false;
        }
        const type = (item as { type?: unknown }).type;
        const text = (item as { text?: unknown }).text;
        return type === "text" && typeof text === "string";
      }) as { text?: string } | undefined;
      const raw = textPart?.text;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // Ignore malformed text payloads and fall back to empty details.
        }
      }
    }
  }
  return {};
}

export function createBrowserDelegateTool(options: {
  sessionsSpawnTool: AnyAgentTool;
}): AnyAgentTool {
  return {
    label: "Browser Delegate",
    name: "browser_delegate",
    description: [
      "Run complex, long-duration browser missions through a delegated sub-agent.",
      "Implements a full delegation framework: six-dimension scoring, governance policy, escalation/rollback, and auditable execution.",
      "Use this for deep research, multi-step browsing workflows, and tasks that may exceed a single turn.",
    ].join(" "),
    parameters: BrowserDelegateToolSchema,
    execute: async (toolCallId, args) => {
      if (typeof options.sessionsSpawnTool.execute !== "function") {
        throw new Error("sessions_spawn tool is unavailable for browser delegation");
      }

      const params = (args ?? {}) as Record<string, unknown>;
      const cfg = loadConfig();
      const nestedDelegationAllowed =
        process.env.OPENCLAW_ALLOW_NESTED_SPAWN === "1" ||
        cfg.tools?.subagents?.allowNestedSpawn === true;

      let task: string;
      let authorityLevel: BrowserDelegationAuthority;
      let browserProfile: BrowserProfile;
      let fallbackProfile: BrowserProfile;
      let maxMinutes: number;
      let checkpointMinutes: number;
      let maxRecursionDepth: number;
      let parallelBranches: number;
      let minSources: number;
      let minIndependentDomains: number;
      let requireCrossVerification: boolean;
      let mustReportUncertainty: boolean;
      let deliverable: string;
      let seedUrls: string[];
      let contextNotes: string[];
      let successCriteriaInput: string[];
      let constraintsInput: string[];
      let label: string;
      let model: string | undefined;
      let cleanup: BrowserCleanupPolicy;
      let riskTolerance: "low" | "medium" | "high";
      let authRequiredHint: boolean | undefined;
      let dimensionOverrides: Partial<DelegationDimensionScores> | undefined;
      try {
        task = readStringParam(params, "task", { required: true });
        const authority = readEnumParam(
          readStringParam(params, "authority"),
          ["read_only", "safe_actions", "full_browser"] as const,
          "authority",
        );
        authorityLevel = authority ?? "safe_actions";
        const isAutonomous =
          process.env.OPENCLAW_AUTONOMOUS_MODE === "1" || process.env.PLAYWRIGHT_HEADLESS === "1";
        browserProfile =
          readEnumParam(
            readStringParam(params, "profile"),
            ["chrome", "openclaw"] as const,
            "profile",
          ) ?? (isAutonomous ? "openclaw" : "chrome");
        const requestedFallback = readEnumParam(
          readStringParam(params, "fallbackProfile"),
          ["chrome", "openclaw"] as const,
          "fallbackProfile",
        );
        fallbackProfile =
          requestedFallback ?? (browserProfile === "chrome" ? "openclaw" : "chrome");
        maxMinutes = clampInteger(readNumberParam(params, "maxMinutes") ?? 25, 1, 240);
        checkpointMinutes = clampInteger(
          readNumberParam(params, "checkpointMinutes") ?? 5,
          1,
          Math.min(60, maxMinutes),
        );
        maxRecursionDepth = clampInteger(readNumberParam(params, "maxRecursionDepth") ?? 2, 0, 4);
        parallelBranches = clampInteger(readNumberParam(params, "parallelBranches") ?? 2, 1, 6);
        minSources = clampInteger(readNumberParam(params, "minSources") ?? 4, 1, 25);
        minIndependentDomains = clampInteger(
          readNumberParam(params, "minIndependentDomains") ?? 2,
          1,
          minSources,
        );
        requireCrossVerification =
          typeof params.requireCrossVerification === "boolean"
            ? params.requireCrossVerification
            : true;
        mustReportUncertainty =
          typeof params.mustReportUncertainty === "boolean" ? params.mustReportUncertainty : true;
        riskTolerance =
          readEnumParam(
            readStringParam(params, "riskTolerance"),
            ["low", "medium", "high"] as const,
            "riskTolerance",
          ) ?? "medium";
        authRequiredHint =
          typeof params.authRequired === "boolean" ? params.authRequired : undefined;
        dimensionOverrides = readDimensionOverrides(params.dimensionOverrides);
        deliverable =
          readStringParam(params, "deliverable") ??
          "A direct answer to the task with evidence and explicit uncertainty.";
        seedUrls = normalizeStringList(readStringArrayParam(params, "seedUrls"), 15);
        contextNotes = normalizeStringList(readStringArrayParam(params, "contextNotes"), 20);
        successCriteriaInput = normalizeStringList(
          readStringArrayParam(params, "successCriteria"),
          12,
        );
        constraintsInput = normalizeStringList(readStringArrayParam(params, "constraints"), 12);
        label =
          readStringParam(params, "label") ??
          `browser-mission: ${task.slice(0, 72)}${task.length > 72 ? "..." : ""}`;
        model = readStringParam(params, "model");
        cleanup =
          readEnumParam(
            readStringParam(params, "cleanup"),
            ["delete", "keep"] as const,
            "cleanup",
          ) ?? "keep";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: "error",
          delegated: false,
          error: message,
          code: "invalid_parameters",
        });
      }

      const isChromeAttached = (
        status: Awaited<ReturnType<typeof browserStatus>> | null,
      ): boolean => {
        return status?.extensionConnected === true && (status?.attachedTabCount ?? 0) > 0;
      };

      let chromeAttachAttempted = false;
      let chromePreflight = await browserStatus(undefined, { profile: "chrome" }).catch(() => null);
      if (!isChromeAttached(chromePreflight)) {
        chromeAttachAttempted = true;
        await browserExtensionAttachActive(undefined, { profile: "chrome" }).catch(() => {});
        chromePreflight = await browserStatus(undefined, { profile: "chrome" }).catch(
          () => chromePreflight,
        );
      }
      const fallbackPreflight = await browserStatus(undefined, { profile: fallbackProfile }).catch(
        () => null,
      );
      const chromeAttached = isChromeAttached(chromePreflight);
      const fallbackReady =
        fallbackProfile === "chrome"
          ? chromeAttached
          : fallbackPreflight?.running === true || fallbackPreflight?.cdpReady === true;

      const authRequired = authRequiredHint ?? inferAuthRequired(task, seedUrls);

      const assessment = buildDelegationAssessment({
        task,
        timeoutMinutes: maxMinutes,
        nestedDelegationAllowed,
        authRequired,
        chromeAttached,
        fallbackReady: Boolean(fallbackReady),
        dimensionOverrides,
        riskTolerance,
      });
      const governance = buildDelegationGovernancePolicy({
        decision: assessment.decision,
        timeoutMinutes: maxMinutes,
        checkpointMinutes,
        nestedDelegationAllowed,
        authRequired,
      });

      appendDelegationAudit({
        tool: "browser_delegate",
        task,
        riskTolerance,
        authRequired,
        chromeAttachAttempted,
        chromeAttached,
        fallbackReady: Boolean(fallbackReady),
        decision: assessment.decision,
        score: assessment.score,
        dimensionScores: assessment.dimensionScores,
      });

      if (assessment.decision === "do_not_delegate") {
        return jsonResult({
          status: "rejected",
          delegated: false,
          reason: "governor_rejected",
          assessment,
          governance,
          remediation:
            authRequired && !chromeAttached
              ? [
                  "Attach an authenticated Chrome tab (OpenClaw Browser Relay badge ON), then retry.",
                  `Or log into ${fallbackProfile} profile and retry delegation.`,
                ]
              : ["Adjust task scope or authority, then retry delegation."],
        });
      }

      const runTimeoutSeconds = maxMinutes * 60;

      const authorityConstraints =
        authorityLevel === "read_only"
          ? ["Do not submit forms, post content, or trigger irreversible actions."]
          : authorityLevel === "safe_actions"
            ? ["Allow reversible actions only. Avoid destructive or irreversible operations."]
            : [
                "Use best judgment, but avoid destructive actions unless explicitly required by task.",
              ];

      const successCriteria =
        successCriteriaInput.length > 0
          ? successCriteriaInput
          : [
              "Resolve the task directly and include sources for key claims.",
              `Use at least ${minSources} sources from at least ${minIndependentDomains} independent domains.`,
              "Flag conflicts or uncertainty explicitly.",
              "Include governance summary: checkpoints, escalations, and rollback actions.",
            ];
      const constraints = [
        ...authorityConstraints,
        ...constraintsInput,
        `Hard timeout budget: ${maxMinutes} minutes.`,
        `Minimum source count: ${minSources}.`,
        `Minimum independent domains: ${minIndependentDomains}.`,
      ];

      const contract: BrowserDelegationContract = {
        task,
        authority: {
          level: authorityLevel,
          browserProfile,
          fallbackProfile,
        },
        context: {
          seedUrls,
          notes: contextNotes,
        },
        successCriteria,
        constraints,
        visibility: {
          deliverable,
          checkpointMinutes: governance.checkpointEveryMinutes,
        },
        escalation: {
          allowNestedDelegation: nestedDelegationAllowed,
          maxRecursionDepth,
          parallelBranches,
          onBlocked:
            "Retry browser path, then fallback profile, then report blocker with evidence and partial progress.",
        },
        quality: {
          minSources,
          minIndependentDomains,
          requireCrossVerification,
          mustReportUncertainty,
        },
        governance,
        assessment,
        auth: {
          required: authRequired,
          chromeAttached,
          fallbackReady: Boolean(fallbackReady),
        },
        timeoutMinutes: maxMinutes,
      };

      const delegatedTask = buildDelegationPrompt(contract);

      let spawnDetails: Record<string, unknown>;
      try {
        const spawnResult = await options.sessionsSpawnTool.execute(`${toolCallId}:spawn`, {
          task: delegatedTask,
          label,
          model,
          cleanup,
          runTimeoutSeconds,
        });
        spawnDetails = extractResultDetails(spawnResult);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendDelegationAudit({
          tool: "browser_delegate",
          task,
          decision: assessment.decision,
          spawnStatus: "error",
          error: message,
        });
        return jsonResult({
          status: "error",
          delegated: false,
          error: message,
          contract,
          assessment,
          governance,
          nestedDelegationAllowed,
        });
      }

      const spawnStatus = typeof spawnDetails.status === "string" ? spawnDetails.status : "unknown";
      appendDelegationAudit({
        tool: "browser_delegate",
        task,
        decision: assessment.decision,
        spawnStatus,
        runId: typeof spawnDetails.runId === "string" ? spawnDetails.runId : null,
      });

      return jsonResult({
        status: spawnStatus === "accepted" ? "accepted" : "error",
        delegated: spawnStatus === "accepted",
        ...(spawnStatus !== "accepted"
          ? {
              error:
                typeof spawnDetails.error === "string"
                  ? spawnDetails.error
                  : "delegated run was not accepted",
            }
          : {}),
        childSessionKey:
          typeof spawnDetails.childSessionKey === "string" ? spawnDetails.childSessionKey : null,
        runId: typeof spawnDetails.runId === "string" ? spawnDetails.runId : null,
        warning: typeof spawnDetails.warning === "string" ? spawnDetails.warning : undefined,
        modelApplied:
          typeof spawnDetails.modelApplied === "boolean" ? spawnDetails.modelApplied : undefined,
        contract,
        assessment,
        governance,
        preflight: {
          authRequired,
          chromeAttachAttempted,
          chromeAttached,
          fallbackReady: Boolean(fallbackReady),
        },
        nestedDelegationAllowed,
      });
    },
  };
}
