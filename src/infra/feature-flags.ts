import type { OpenClawConfig } from "../config/config.js";

const FEATURES_ENV = "OPENCLAW_FEATURES";

/** Known feature flags with defaults and descriptions. */
const FEATURE_REGISTRY = {
  "session-memory": {
    default: false,
    description: "Experimental session transcript indexing for memory search",
  },
  "council-mode": {
    default: false,
    description: "Multi-LLM consensus for architectural decisions",
  },
  "feedback-loop": {
    default: false,
    description: "Coder-Reviewer iterative cycle with hard approval gates",
  },
  "video-proof": {
    default: false,
    description: "Capture .webm evidence of UI features working",
  },
} as const;

export type FeatureFlagName = keyof typeof FEATURE_REGISTRY;

export type FeatureFlagInfo = {
  name: FeatureFlagName;
  default: boolean;
  description: string;
  enabled: boolean;
};

function normalizeFlag(value: string): string {
  return value.trim().toLowerCase();
}

function parseEnvFlags(raw?: string): string[] {
  if (!raw) {
    return [];
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const lowered = trimmed.toLowerCase();
  if (["0", "false", "off", "none"].includes(lowered)) {
    return [];
  }
  if (["1", "true", "all", "*"].includes(lowered)) {
    return Object.keys(FEATURE_REGISTRY);
  }
  return trimmed
    .split(/[,\s]+/)
    .map(normalizeFlag)
    .filter(Boolean);
}

/**
 * Resolve enabled feature flags from config + env.
 *
 * Priority: env overrides config; config overrides defaults.
 * Config path: `features.flags: ["session-memory", "council-mode"]`
 * Env: `OPENCLAW_FEATURES="session-memory,council-mode"`
 */
export function resolveFeatureFlags(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configFlags = Array.isArray(
    (cfg as Record<string, unknown> | undefined)?.features &&
      (cfg as Record<string, Record<string, unknown>>).features?.flags,
  )
    ? ((cfg as Record<string, Record<string, unknown[]>>).features.flags as string[])
    : [];
  const envFlags = parseEnvFlags(env[FEATURES_ENV]);
  const combined = new Set([...configFlags, ...envFlags]);
  return [...combined].map(normalizeFlag).filter(Boolean);
}

/**
 * Check if a specific feature flag is enabled.
 *
 * Returns true if the flag is in the resolved set, or falls back to the
 * registry default if not explicitly set.
 */
export function isFeatureEnabled(
  flag: FeatureFlagName,
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const resolved = resolveFeatureFlags(cfg, env);
  if (resolved.length > 0) {
    return resolved.includes(normalizeFlag(flag));
  }
  // No flags configured — use registry defaults
  const entry = FEATURE_REGISTRY[flag];
  return entry?.default ?? false;
}

/** List all known feature flags with their current enabled status. */
export function getAllFeatureFlags(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): FeatureFlagInfo[] {
  const resolved = resolveFeatureFlags(cfg, env);
  return (
    Object.entries(FEATURE_REGISTRY) as [
      FeatureFlagName,
      (typeof FEATURE_REGISTRY)[FeatureFlagName],
    ][]
  ).map(([name, entry]) => ({
    name,
    default: entry.default,
    description: entry.description,
    enabled: resolved.length > 0 ? resolved.includes(name) : entry.default,
  }));
}

/** Get all known feature flag names. */
export function getFeatureFlagNames(): FeatureFlagName[] {
  return Object.keys(FEATURE_REGISTRY) as FeatureFlagName[];
}
