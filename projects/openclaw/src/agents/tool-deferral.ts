/**
 * Tool deferral system for reducing prompt token usage.
 *
 * Implements application-layer deferred tool loading: tools that are rarely used
 * have their schemas stripped to minimal stubs, while a `search_tools` meta-tool
 * lets the LLM discover and load full schemas on demand.
 *
 * All tools remain registered (execute functions are preserved) — only the
 * schema/description visible to the LLM is minimized for deferred tools.
 *
 * @see https://www.anthropic.com/engineering/advanced-tool-use
 */

import type { AnyAgentTool } from "./pi-tools.types.js";
import { normalizeToolName } from "./tool-policy.js";
import { createSearchToolsTool } from "./tools/search-tools-tool.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Core tools that are always loaded with full schemas. */
export const DEFAULT_ALWAYS_LOADED = new Set([
  "read",
  "write",
  "edit",
  "exec",
  "process",
  "message",
  "session_status",
  "search_tools",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolIndexEntry = {
  name: string;
  description: string;
  parameters: unknown;
  /** Pre-computed search tokens (name + description + param names). */
  tokens: string[];
};

export type ToolIndex = {
  entries: ToolIndexEntry[];
};

export type ToolSearchResult = {
  name: string;
  description: string;
  parameters: unknown;
  score: number;
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Classify tools into always-loaded and deferred based on the alwaysLoaded set. */
export function classifyTools(
  tools: AnyAgentTool[],
  alwaysLoaded: Set<string> = DEFAULT_ALWAYS_LOADED,
): { loaded: AnyAgentTool[]; deferred: AnyAgentTool[] } {
  const loaded: AnyAgentTool[] = [];
  const deferred: AnyAgentTool[] = [];

  for (const tool of tools) {
    const name = normalizeToolName(tool.name);
    if (alwaysLoaded.has(name)) {
      loaded.push(tool);
    } else {
      deferred.push(tool);
    }
  }

  return { loaded, deferred };
}

// ---------------------------------------------------------------------------
// Deferred proxy
// ---------------------------------------------------------------------------

/**
 * Create a deferred proxy for a tool — preserves `execute` but strips the
 * schema to minimal stub and shortens the description.
 */
export function createDeferredProxy(tool: AnyAgentTool): AnyAgentTool {
  const shortDesc = tool.description
    ? `[Deferred] ${tool.description.slice(0, 80).split("\n")[0]}...`
    : `[Deferred] ${tool.name}`;

  return {
    ...tool,
    description: `${shortDesc} Use search_tools to get full schema.`,
    parameters: {
      type: "object" as const,
      properties: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Search index
// ---------------------------------------------------------------------------

/** Tokenize a string into lowercase words for BM25-style matching. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s_\-./,;:()[\]{}'"]+/)
    .filter((t) => t.length > 1);
}

/** Extract parameter names from a JSON schema. */
function extractParamNames(params: unknown): string[] {
  if (!params || typeof params !== "object") {
    return [];
  }
  const schema = params as Record<string, unknown>;
  if (schema.properties && typeof schema.properties === "object") {
    return Object.keys(schema.properties as Record<string, unknown>);
  }
  return [];
}

/** Build a searchable index from an array of tools. */
export function buildToolIndex(tools: AnyAgentTool[]): ToolIndex {
  const entries: ToolIndexEntry[] = tools.map((tool) => {
    const paramNames = extractParamNames(tool.parameters);
    const tokens = [
      ...tokenize(tool.name),
      ...tokenize(tool.description ?? ""),
      ...paramNames.flatMap((p) => tokenize(p)),
    ];

    return {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters,
      tokens: [...new Set(tokens)],
    };
  });

  return { entries };
}

/**
 * Search the tool index using BM25-style keyword scoring.
 *
 * Scores each tool based on how many query tokens match its indexed tokens.
 * Exact name matches get a large boost.
 */
export function searchToolIndex(index: ToolIndex, query: string, limit = 5): ToolSearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return index.entries.slice(0, limit).map((e) => ({
      name: e.name,
      description: e.description,
      parameters: e.parameters,
      score: 0,
    }));
  }

  const N = index.entries.length;
  // Document frequency for each query token
  const df: Record<string, number> = {};
  for (const qt of queryTokens) {
    df[qt] = 0;
    for (const entry of index.entries) {
      if (entry.tokens.includes(qt)) {
        df[qt]++;
      }
    }
  }

  const scored = index.entries.map((entry) => {
    let score = 0;
    const tokenSet = new Set(entry.tokens);

    for (const qt of queryTokens) {
      if (tokenSet.has(qt)) {
        // IDF-weighted match: rarer tokens score higher
        const idf = Math.log((N + 1) / (1 + (df[qt] ?? 0)));
        score += idf;
      }
    }

    // Exact name match bonus
    const normalizedName = normalizeToolName(entry.name);
    if (queryTokens.some((qt) => normalizedName === qt || normalizedName.includes(qt))) {
      score += 5;
    }

    return {
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
      score,
    };
  });

  return scored
    .filter((r) => r.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/**
 * Apply tool deferral to a list of tools.
 *
 * - Splits tools into always-loaded (full schema) and deferred (stub schema)
 * - Builds a search index from deferred tools
 * - Creates a `search_tools` meta-tool
 * - Returns the combined tool list
 */
export function applyToolDeferral(
  tools: AnyAgentTool[],
  config?: { enabled?: boolean; alwaysLoaded?: string[] },
): AnyAgentTool[] {
  if (config?.enabled === false) {
    return tools;
  }

  const alwaysLoaded = config?.alwaysLoaded
    ? new Set([...DEFAULT_ALWAYS_LOADED, ...config.alwaysLoaded.map(normalizeToolName)])
    : DEFAULT_ALWAYS_LOADED;

  const { loaded, deferred } = classifyTools(tools, alwaysLoaded);

  if (deferred.length === 0) {
    return tools;
  }

  // Build search index from the FULL deferred tools (before proxying)
  const index = buildToolIndex(deferred);

  // Create stub proxies for deferred tools
  const deferredProxies = deferred.map(createDeferredProxy);

  // Create the search_tools meta-tool
  const searchTool = createSearchToolsTool(index);

  return [...loaded, ...deferredProxies, searchTool];
}
