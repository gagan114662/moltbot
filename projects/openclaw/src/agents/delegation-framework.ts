import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type DelegationDimensionScores = {
  capabilityMatch: number;
  contextTransferability: number;
  authorityBoundaries: number;
  riskContainment: number;
  effortEconomics: number;
  observability: number;
};

export type DelegationDecision = "delegate" | "delegate_guarded" | "do_not_delegate";

export type DelegationAssessment = {
  score: number;
  decision: DelegationDecision;
  dimensionScores: DelegationDimensionScores;
  blockers: string[];
  strengths: string[];
  rationale: string[];
};

export type DelegationGovernancePolicy = {
  checkpointEveryMinutes: number;
  escalationTriggers: string[];
  rollbackStrategy: string;
  visibilityEvents: string[];
};

const WEIGHTS: DelegationDimensionScores = {
  capabilityMatch: 0.22,
  contextTransferability: 0.16,
  authorityBoundaries: 0.16,
  riskContainment: 0.18,
  effortEconomics: 0.14,
  observability: 0.14,
};

const DEFAULT_AUDIT_PATH = path.join(resolveStateDir(), "logs", "delegation-framework.jsonl");

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function clampRoundedScore(value: number): number {
  return Math.round(clampScore(value) * 1000) / 1000;
}

function normalizeTask(task: string): string {
  return task.trim().toLowerCase();
}

function hasAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function inferTaskComplexity(task: string): "low" | "medium" | "high" {
  const normalized = normalizeTask(task);
  const words = normalized.split(/\s+/).filter(Boolean).length;
  const complexTerms = [
    "deep research",
    "cross-check",
    "compare",
    "multi-step",
    "audit",
    "investigate",
    "long duration",
    "pipeline",
    "benchmark",
  ];
  const complexityHits = complexTerms.filter((term) => normalized.includes(term)).length;
  if (words >= 60 || complexityHits >= 3) {
    return "high";
  }
  if (words >= 28 || complexityHits >= 1) {
    return "medium";
  }
  return "low";
}

/**
 * Domains/patterns that are pre-authorized for autonomous payment operations.
 * Tasks targeting these domains bypass the payment-action risk escalation.
 */
const AUTHORIZED_PAYMENT_DOMAINS = [
  "api.stripe.com",
  "stripe.com",
  "checkout.stripe.com",
  "dashboard.stripe.com",
  "connect.stripe.com",
  "hooks.stripe.com",
  "billing.stripe.com",
];

const AUTHORIZED_PAYMENT_KEYWORDS = [
  "stripe webhook",
  "stripe api",
  "stripe checkout",
  "stripe payment link",
  "stripe connect",
  "revenue tracking",
  "revenue.jsonl",
  "payment webhook",
  "bot subscription",
  "telegram payment",
  "discord premium",
];

export function isAuthorizedPaymentAction(task: string, seedUrls?: string[]): boolean {
  const normalized = normalizeTask(task);

  // Check if the task matches authorized payment keywords
  if (AUTHORIZED_PAYMENT_KEYWORDS.some((kw) => normalized.includes(kw))) {
    return true;
  }

  // Check if seed URLs are all within authorized payment domains
  if (seedUrls && seedUrls.length > 0) {
    const allAuthorized = seedUrls.every((url) => {
      try {
        const hostname = new URL(url).hostname;
        return AUTHORIZED_PAYMENT_DOMAINS.some(
          (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
        );
      } catch {
        return false;
      }
    });
    if (allAuthorized) {
      return true;
    }
  }

  // Check environment flag for full autonomous mode
  if (process.env.OPENCLAW_AUTONOMOUS_MODE === "1") {
    return true;
  }

  return false;
}

function inferSensitiveActionRisk(task: string, seedUrls?: string[]): number {
  const normalized = normalizeTask(task);
  if (
    hasAny(normalized, [
      "delete",
      "remove",
      "payment",
      "purchase",
      "transfer",
      "bank",
      "wire",
      "send money",
      "reset password",
      "account settings",
      "two-factor",
    ])
  ) {
    // Allow authorized payment operations through at medium risk instead of blocking
    if (isAuthorizedPaymentAction(task, seedUrls)) {
      return 0.55;
    }
    return 0.25;
  }
  if (hasAny(normalized, ["publish", "post", "submit", "upload", "apply"])) {
    return 0.45;
  }
  return 0.7;
}

export function inferAuthRequired(task: string, seedUrls: string[]): boolean {
  const normalized = normalizeTask(task);
  if (
    hasAny(normalized, [
      "for you",
      "timeline",
      "notifications",
      "dm",
      "inbox",
      "account feed",
      "private dashboard",
      "gmail",
      "linkedin",
      "x.com",
      "twitter",
      "facebook",
      "instagram",
    ])
  ) {
    return true;
  }
  const joined = seedUrls.join(" ").toLowerCase();
  return hasAny(joined, ["x.com", "twitter.com", "linkedin.com", "mail.google.com"]);
}

function mergeDimensionOverrides(
  base: DelegationDimensionScores,
  overrides?: Partial<DelegationDimensionScores>,
): DelegationDimensionScores {
  if (!overrides) {
    return base;
  }
  return {
    capabilityMatch: clampScore(
      overrides.capabilityMatch === undefined ? base.capabilityMatch : overrides.capabilityMatch,
    ),
    contextTransferability: clampScore(
      overrides.contextTransferability === undefined
        ? base.contextTransferability
        : overrides.contextTransferability,
    ),
    authorityBoundaries: clampScore(
      overrides.authorityBoundaries === undefined
        ? base.authorityBoundaries
        : overrides.authorityBoundaries,
    ),
    riskContainment: clampScore(
      overrides.riskContainment === undefined ? base.riskContainment : overrides.riskContainment,
    ),
    effortEconomics: clampScore(
      overrides.effortEconomics === undefined ? base.effortEconomics : overrides.effortEconomics,
    ),
    observability: clampScore(
      overrides.observability === undefined ? base.observability : overrides.observability,
    ),
  };
}

export function buildDelegationAssessment(params: {
  task: string;
  timeoutMinutes: number;
  nestedDelegationAllowed: boolean;
  authRequired: boolean;
  chromeAttached: boolean;
  fallbackReady: boolean;
  dimensionOverrides?: Partial<DelegationDimensionScores>;
  riskTolerance?: "low" | "medium" | "high";
  seedUrls?: string[];
}): DelegationAssessment {
  const complexity = inferTaskComplexity(params.task);
  const destructiveRisk = inferSensitiveActionRisk(params.task, params.seedUrls);
  const riskTolerance = params.riskTolerance ?? "medium";

  const base: DelegationDimensionScores = {
    capabilityMatch: complexity === "high" ? 0.86 : complexity === "medium" ? 0.79 : 0.72,
    contextTransferability: complexity === "high" ? 0.76 : 0.72,
    authorityBoundaries: destructiveRisk,
    riskContainment: destructiveRisk,
    effortEconomics:
      complexity === "high"
        ? 0.88
        : complexity === "medium"
          ? 0.76
          : params.timeoutMinutes >= 20
            ? 0.7
            : 0.56,
    observability:
      params.chromeAttached || params.fallbackReady
        ? params.nestedDelegationAllowed
          ? 0.84
          : 0.76
        : 0.42,
  };

  if (params.authRequired && !params.chromeAttached) {
    base.contextTransferability = Math.min(base.contextTransferability, 0.48);
    base.observability = Math.min(base.observability, 0.46);
    base.riskContainment = Math.min(base.riskContainment, 0.5);
  }

  const scores = mergeDimensionOverrides(base, params.dimensionOverrides);

  const weighted =
    scores.capabilityMatch * WEIGHTS.capabilityMatch +
    scores.contextTransferability * WEIGHTS.contextTransferability +
    scores.authorityBoundaries * WEIGHTS.authorityBoundaries +
    scores.riskContainment * WEIGHTS.riskContainment +
    scores.effortEconomics * WEIGHTS.effortEconomics +
    scores.observability * WEIGHTS.observability;

  let decision: DelegationDecision;
  if (scores.authorityBoundaries < 0.35 || scores.riskContainment < 0.35) {
    decision = "do_not_delegate";
  } else if (weighted >= 0.72) {
    decision = "delegate";
  } else if (weighted >= 0.55) {
    decision = "delegate_guarded";
  } else {
    decision = "do_not_delegate";
  }

  if (riskTolerance === "low" && decision === "delegate") {
    decision = "delegate_guarded";
  }
  if (riskTolerance === "high" && decision === "delegate_guarded" && weighted >= 0.62) {
    decision = "delegate";
  }

  const blockers: string[] = [];
  const strengths: string[] = [];
  const rationale: string[] = [];

  if (params.authRequired && !params.chromeAttached) {
    blockers.push("auth_preflight_missing_personal_session");
    rationale.push(
      "Task appears to require authenticated web context, but no attached Chrome tab was detected.",
    );
  }
  if (!params.fallbackReady) {
    blockers.push("fallback_profile_not_ready");
    rationale.push("Fallback browser profile is not ready, reducing resilience.");
  }
  if (scores.observability >= 0.75) {
    strengths.push("good_observability");
  }
  if (scores.effortEconomics >= 0.75) {
    strengths.push("strong_effort_economics");
  }
  if (scores.capabilityMatch >= 0.8) {
    strengths.push("high_capability_match");
  }

  return {
    score: clampRoundedScore(weighted),
    decision,
    dimensionScores: {
      capabilityMatch: clampRoundedScore(scores.capabilityMatch),
      contextTransferability: clampRoundedScore(scores.contextTransferability),
      authorityBoundaries: clampRoundedScore(scores.authorityBoundaries),
      riskContainment: clampRoundedScore(scores.riskContainment),
      effortEconomics: clampRoundedScore(scores.effortEconomics),
      observability: clampRoundedScore(scores.observability),
    },
    blockers,
    strengths,
    rationale,
  };
}

export function buildDelegationGovernancePolicy(params: {
  decision: DelegationDecision;
  timeoutMinutes: number;
  checkpointMinutes: number;
  nestedDelegationAllowed: boolean;
  authRequired: boolean;
}): DelegationGovernancePolicy {
  const checkpointEveryMinutes =
    params.decision === "delegate"
      ? Math.max(2, Math.min(12, params.checkpointMinutes))
      : Math.max(1, Math.min(8, params.checkpointMinutes));
  const escalationTriggers = [
    "quality_gates_stalled",
    "tool_failure_spike",
    "source_conflict_detected",
    ...(params.authRequired ? ["auth_blocked"] : []),
    ...(params.nestedDelegationAllowed ? [] : ["nested_delegation_disallowed"]),
  ];
  return {
    checkpointEveryMinutes,
    escalationTriggers,
    rollbackStrategy:
      params.decision === "delegate"
        ? "On persistent blocker, stop sub-tasks, preserve evidence, return partial with clear blockers."
        : "Conservative mode: avoid irreversible actions, downgrade scope, and return explicit blockers.",
    visibilityEvents: [
      "mission_started",
      "checkpoint",
      "escalation",
      "quality_gate_result",
      "mission_completed",
    ],
  };
}

export function appendDelegationAudit(payload: Record<string, unknown>) {
  if (process.env.OPENCLAW_DELEGATION_AUDIT === "0") {
    return;
  }
  const filePath = process.env.OPENCLAW_DELEGATION_AUDIT_PATH?.trim() || DEFAULT_AUDIT_PATH;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    void fs.promises.appendFile(
      filePath,
      `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`,
      "utf8",
    );
  } catch {
    // ignore audit logging failures
  }
}
