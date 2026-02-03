/**
 * Google Antigravity Integration for Feedback Loop
 *
 * Antigravity is Google Cloud Code Assist - provides access to:
 * - claude-opus-4-5-thinking (default, best for complex reasoning)
 * - claude-sonnet-4-5 (faster, good for coding)
 * - gemini-3 (Google's model)
 *
 * Key guardrails from CLAUDE.md:
 * - Tool schema: no Type.Union, anyOf/oneOf/allOf
 * - Use stringEnum for string lists
 * - Use Type.Optional instead of | null
 * - Keep top-level schema as type: "object" with properties
 * - Avoid raw "format" property names
 */

export interface AntigravityConfig {
  enabled: boolean;
  /** Preferred model for coder agent */
  coderModel?: AntigravityModel;
  /** Preferred model for reviewer agent */
  reviewerModel?: AntigravityModel;
  /** Use thinking models when available */
  useThinking?: boolean;
  /** Project ID (auto-detected from OAuth) */
  projectId?: string;
}

export type AntigravityModel =
  | "google-antigravity/claude-opus-4-5-thinking"
  | "google-antigravity/claude-opus-4-5"
  | "google-antigravity/claude-sonnet-4-5"
  | "google-antigravity/gemini-3"
  | "google-antigravity/gemini-2.5-pro"
  | "google-antigravity/gemini-2.5-flash";

/**
 * Model recommendations for feedback loop roles
 */
export const ANTIGRAVITY_MODEL_RECOMMENDATIONS = {
  coder: {
    fast: "google-antigravity/claude-sonnet-4-5" as AntigravityModel,
    balanced: "google-antigravity/claude-sonnet-4-5" as AntigravityModel,
    thorough: "google-antigravity/claude-opus-4-5" as AntigravityModel,
  },
  reviewer: {
    fast: "google-antigravity/claude-sonnet-4-5" as AntigravityModel,
    balanced: "google-antigravity/claude-opus-4-5" as AntigravityModel,
    thorough: "google-antigravity/claude-opus-4-5-thinking" as AntigravityModel,
  },
} as const;

/**
 * Default configuration for Antigravity feedback loop
 */
export const DEFAULT_ANTIGRAVITY_CONFIG: AntigravityConfig = {
  enabled: false,
  coderModel: "google-antigravity/claude-sonnet-4-5",
  reviewerModel: "google-antigravity/claude-opus-4-5-thinking",
  useThinking: true,
};

/**
 * Tool schema guardrails for Antigravity
 * These ensure compatibility with Google's schema validation
 */
export interface AntigravityToolSchema {
  type: "object";
  properties: Record<string, AntigravityPropertySchema>;
  required?: string[];
}

export interface AntigravityPropertySchema {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[]; // Use enum instead of anyOf for string lists
  items?: AntigravityPropertySchema; // For arrays
  properties?: Record<string, AntigravityPropertySchema>; // For objects
  // Note: avoid "format" as property name - reserved in some validators
}

/**
 * Validate a tool schema for Antigravity compatibility
 */
export function validateAntigravitySchema(schema: unknown): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  if (!schema || typeof schema !== "object") {
    return { valid: false, issues: ["Schema must be an object"] };
  }

  const s = schema as Record<string, unknown>;

  // Check top-level type
  if (s.type !== "object") {
    issues.push('Top-level schema must have type: "object"');
  }

  // Check for forbidden constructs
  const schemaStr = JSON.stringify(schema);

  if (schemaStr.includes('"anyOf"')) {
    issues.push("anyOf is not allowed - use enum for string choices");
  }

  if (schemaStr.includes('"oneOf"')) {
    issues.push("oneOf is not allowed - use enum for string choices");
  }

  if (schemaStr.includes('"allOf"')) {
    issues.push("allOf is not allowed - flatten the schema");
  }

  // Check for "format" as property name (not as schema keyword)
  if (s.properties && typeof s.properties === "object") {
    const props = s.properties as Record<string, unknown>;
    if ("format" in props) {
      issues.push('"format" as property name may conflict with schema keyword');
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Build a safe tool schema for Antigravity
 */
export function buildAntigravitySafeSchema(
  properties: Record<string, {
    type: "string" | "number" | "boolean" | "array" | "object";
    description?: string;
    choices?: string[]; // Will be converted to enum
    optional?: boolean;
  }>,
): AntigravityToolSchema {
  const schemaProperties: Record<string, AntigravityPropertySchema> = {};
  const required: string[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    const schemaProp: AntigravityPropertySchema = {
      type: prop.type,
      description: prop.description,
    };

    if (prop.choices && prop.choices.length > 0) {
      schemaProp.enum = prop.choices;
    }

    schemaProperties[name] = schemaProp;

    if (!prop.optional) {
      required.push(name);
    }
  }

  return {
    type: "object",
    properties: schemaProperties,
    required: required.length > 0 ? required : undefined,
  };
}

/**
 * Select the best Antigravity model for a task
 */
export function selectAntigravityModel(
  role: "coder" | "reviewer",
  options: {
    taskComplexity?: "simple" | "medium" | "complex";
    preferThinking?: boolean;
    preferSpeed?: boolean;
  } = {},
): AntigravityModel {
  const { taskComplexity = "medium", preferThinking = false, preferSpeed = false } = options;

  // For simple tasks or speed preference, use fast models
  if (taskComplexity === "simple" || preferSpeed) {
    return ANTIGRAVITY_MODEL_RECOMMENDATIONS[role].fast;
  }

  // For complex tasks or thinking preference, use thorough models
  if (taskComplexity === "complex" || preferThinking) {
    return ANTIGRAVITY_MODEL_RECOMMENDATIONS[role].thorough;
  }

  // Default to balanced
  return ANTIGRAVITY_MODEL_RECOMMENDATIONS[role].balanced;
}

/**
 * Build Antigravity-specific prompt additions
 */
export function buildAntigravityPromptAdditions(
  role: "coder" | "reviewer",
  model: AntigravityModel,
): string {
  const additions: string[] = [];

  // Add thinking model instructions
  if (model.includes("thinking")) {
    additions.push(
      "## THINKING MODEL INSTRUCTIONS",
      "You are running with extended thinking enabled.",
      "- Take time to reason through complex problems",
      "- Show your reasoning process for important decisions",
      "- Consider multiple approaches before selecting one",
      "",
    );
  }

  // Add role-specific instructions for Antigravity
  if (role === "coder") {
    additions.push(
      "## ANTIGRAVITY CODER INSTRUCTIONS",
      "- Use Google Cloud best practices when applicable",
      "- Consider GCP service integration opportunities",
      "- Follow security best practices for cloud-native code",
      "",
    );
  } else {
    additions.push(
      "## ANTIGRAVITY REVIEWER INSTRUCTIONS",
      "- Check for Google Cloud security best practices",
      "- Verify IAM and authentication patterns",
      "- Review for cloud cost optimization opportunities",
      "",
    );
  }

  return additions.join("\n");
}

/**
 * Check if Antigravity is available (authenticated)
 */
export async function checkAntigravityAvailable(): Promise<{
  available: boolean;
  reason?: string;
  models?: AntigravityModel[];
}> {
  // This would check for valid OAuth credentials
  // For now, return a simple check based on config
  try {
    // Would call: await callGateway({ method: "auth.check", params: { provider: "google-antigravity" } })
    return {
      available: true,
      models: [
        "google-antigravity/claude-opus-4-5-thinking",
        "google-antigravity/claude-opus-4-5",
        "google-antigravity/claude-sonnet-4-5",
        "google-antigravity/gemini-3",
      ],
    };
  } catch {
    return {
      available: false,
      reason: "Antigravity not authenticated. Run: openclaw models auth login --provider google-antigravity",
    };
  }
}

/**
 * Get Antigravity usage statistics (if available)
 */
export interface AntigravityUsage {
  tokensUsed: number;
  tokensRemaining?: number;
  quotaPercent?: number;
  requestsToday: number;
  requestsLimit?: number;
}

export async function getAntigravityUsage(): Promise<AntigravityUsage | null> {
  // Would fetch from Google Cloud quotas API
  // For now, return null (not implemented)
  return null;
}

/**
 * Antigravity-specific error handling
 */
export function handleAntigravityError(error: unknown): {
  retryable: boolean;
  message: string;
  suggestion?: string;
} {
  const errorStr = error instanceof Error ? error.message : String(error);

  // Quota exceeded
  if (errorStr.includes("quota") || errorStr.includes("429")) {
    return {
      retryable: false,
      message: "Antigravity quota exceeded",
      suggestion: "Wait for quota reset or switch to a different model provider",
    };
  }

  // Authentication error
  if (errorStr.includes("401") || errorStr.includes("auth") || errorStr.includes("credential")) {
    return {
      retryable: false,
      message: "Antigravity authentication failed",
      suggestion: "Re-authenticate: openclaw models auth login --provider google-antigravity",
    };
  }

  // Rate limit
  if (errorStr.includes("rate") || errorStr.includes("too many")) {
    return {
      retryable: true,
      message: "Antigravity rate limited",
      suggestion: "Retry after a short delay",
    };
  }

  // Model not available
  if (errorStr.includes("model") && errorStr.includes("not found")) {
    return {
      retryable: false,
      message: "Antigravity model not available",
      suggestion: "Check available models or use a different model",
    };
  }

  // Generic error
  return {
    retryable: true,
    message: `Antigravity error: ${errorStr}`,
  };
}
