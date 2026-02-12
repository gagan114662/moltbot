/**
 * Custom coding standards loader.
 *
 * Loads `.moltbot/standards.md` from a repo's default branch.
 * Graceful fallback — if the file doesn't exist, returns empty array
 * and the review proceeds with base agent knowledge only.
 */

import { authHeaders } from "./auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CodingStandard = {
  title: string;
  description: string;
  /** Optional file glob pattern to scope the rule, e.g. "src/**\/*.ts" */
  scope?: string;
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const standardsCache = new Map<string, { standards: CodingStandard[]; fetchedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load coding standards from `.moltbot/standards.md` in the repo.
 *
 * Returns empty array if the file doesn't exist (404) or is empty.
 * Never throws — a missing standards file should not block the review.
 */
export async function loadStandards(
  owner: string,
  repo: string,
  token: string,
): Promise<CodingStandard[]> {
  const cacheKey = `${owner}/${repo}`;
  const cached = standardsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.standards;
  }

  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/.moltbot/standards.md`;
    const resp = await fetch(url, { headers: authHeaders(token) });

    if (resp.status === 404) {
      // No standards file — graceful fallback
      standardsCache.set(cacheKey, { standards: [], fetchedAt: Date.now() });
      return [];
    }

    if (!resp.ok) {
      // Other API error — proceed without standards
      return [];
    }

    const data = (await resp.json()) as { content?: string; encoding?: string };
    if (!data.content) {
      return [];
    }

    const content = Buffer.from(
      data.content,
      (data.encoding as BufferEncoding) ?? "base64",
    ).toString("utf-8");
    const standards = parseStandards(content);

    standardsCache.set(cacheKey, { standards, fetchedAt: Date.now() });
    return standards;
  } catch {
    // Network error or parse failure — proceed without standards
    return [];
  }
}

/**
 * Parse a markdown standards file into structured rules.
 *
 * Each `## Heading` starts a new rule. The heading text becomes the title.
 * Everything until the next heading becomes the description.
 * An optional `Scope: <glob>` line sets the file scope.
 */
export function parseStandards(markdown: string): CodingStandard[] {
  const standards: CodingStandard[] = [];
  const lines = markdown.split("\n");

  let current: { title: string; descLines: string[]; scope?: string } | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      // Flush previous
      if (current) {
        standards.push({
          title: current.title,
          description: current.descLines.join("\n").trim(),
          scope: current.scope,
        });
      }
      current = { title: headingMatch[1].trim(), descLines: [] };
      continue;
    }

    if (!current) {
      continue;
    }

    // Check for scope directive
    const scopeMatch = line.match(/^Scope:\s*(.+)/i);
    if (scopeMatch) {
      current.scope = scopeMatch[1].trim();
      continue;
    }

    current.descLines.push(line);
  }

  // Flush last
  if (current) {
    standards.push({
      title: current.title,
      description: current.descLines.join("\n").trim(),
      scope: current.scope,
    });
  }

  return standards;
}

/** Clear the standards cache (for testing). */
export function clearStandardsCache(): void {
  standardsCache.clear();
}
