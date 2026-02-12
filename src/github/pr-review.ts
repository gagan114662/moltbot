/**
 * PR review engine — fetch diff, analyze with LLM, post inline comments.
 *
 * Uses GitHub's pull request review API to post findings as inline comments
 * at the correct diff position (not file line number).
 */

import { authHeaders } from "./auth.js";
import { loadStandards } from "./standards.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PrContext = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  author: string;
};

export type ReviewFinding = {
  path: string;
  /**
   * Position in the diff hunk (NOT the file line number).
   * Computed by walking the unified diff: 1-based index counting from the
   * first line after the hunk header `@@`. GitHub requires this for inline
   * comment placement.
   */
  position: number;
  body: string;
  severity: "critical" | "major" | "minor" | "suggestion";
};

export type ReviewResult = {
  findings: ReviewFinding[];
  summary: string;
};

export type DiffFile = {
  filename: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
};

// ---------------------------------------------------------------------------
// Diff position mapping
// ---------------------------------------------------------------------------

/**
 * Build a map from file line number (right side) to diff position.
 *
 * GitHub's inline comment API requires a `position` — the 1-based line index
 * within the diff hunk, NOT the file's absolute line number. This function
 * parses a unified diff patch and builds the mapping.
 *
 * Position counting:
 * - Starts at 1 for the first `@@` hunk header
 * - Increments for every line in the diff (context, added, removed)
 * - We map the right-side (new file) line numbers to positions
 */
export function buildPositionMap(patch: string): Map<number, number> {
  const map = new Map<number, number>();
  const lines = patch.split("\n");
  let position = 0;
  let rightLine = 0;

  for (const line of lines) {
    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      position++;
      rightLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (position === 0) {
      // Before any hunk header (shouldn't happen in valid patches)
      continue;
    }

    position++;

    if (line.startsWith("+")) {
      // Added line — maps to right-side line number
      map.set(rightLine, position);
      rightLine++;
    } else if (line.startsWith("-")) {
      // Removed line — no right-side line number
      // Position increments but rightLine doesn't
    } else {
      // Context line — exists on both sides
      map.set(rightLine, position);
      rightLine++;
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

/** Fetch PR diff files from GitHub API. */
export async function fetchPrFiles(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<DiffFile[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`;
  const resp = await fetch(url, { headers: authHeaders(token) });

  if (!resp.ok) {
    throw new Error(`GitHub API error fetching PR files: ${resp.status} ${await resp.text()}`);
  }

  return resp.json() as Promise<DiffFile[]>;
}

/** Post a PR review with inline comments. */
export async function postReview(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  review: {
    body: string;
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
    comments: ReviewComment[];
  },
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(review),
  });

  if (!resp.ok) {
    throw new Error(`GitHub API error posting review: ${resp.status} ${await resp.text()}`);
  }
}

type ReviewComment = {
  path: string;
  position: number;
  body: string;
};

// ---------------------------------------------------------------------------
// Review prompt builder
// ---------------------------------------------------------------------------

/** Build the system prompt for reviewing a single file's diff. */
export function buildReviewPrompt(
  file: DiffFile,
  prContext: PrContext,
  standards: { title: string; description: string }[],
): string {
  const parts: string[] = [];

  parts.push(
    "You are a code reviewer. Analyze this PR diff and find bugs, security issues, and antipatterns.",
  );
  parts.push(`\nPR: "${prContext.title}" by ${prContext.author}`);
  if (prContext.body) {
    parts.push(`Description: ${prContext.body.slice(0, 500)}`);
  }

  if (standards.length > 0) {
    parts.push("\n## Team Coding Standards");
    for (const s of standards) {
      parts.push(`- **${s.title}**: ${s.description}`);
    }
  }

  parts.push(`\n## File: ${file.filename} (+${file.additions}/-${file.deletions})`);
  parts.push("```diff");
  parts.push(file.patch ?? "(no patch)");
  parts.push("```");

  parts.push("\nRespond with a JSON array of findings. Each finding:");
  parts.push(
    '  { "line": <new-file-line-number>, "severity": "critical"|"major"|"minor"|"suggestion", "message": "..." }',
  );
  parts.push("If no issues found, return an empty array: []");
  parts.push(
    "Only report real issues. Do not flag style preferences unless they violate the coding standards above.",
  );

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main review function
// ---------------------------------------------------------------------------

/**
 * Review a PR: fetch diff, analyze each file, post inline comments.
 *
 * This is the core entry point called by the webhook handler.
 * For now it uses a simple fetch-based LLM call. In the future this
 * will route through the agent pipeline for full moltbot intelligence.
 */
export async function reviewPr(
  pr: PrContext,
  token: string,
  options?: { agentReview?: (prompt: string) => Promise<string> },
): Promise<ReviewResult> {
  const files = await fetchPrFiles(pr.owner, pr.repo, pr.number, token);

  // Load coding standards (graceful fallback if missing)
  const standards = await loadStandards(pr.owner, pr.repo, token);

  const allFindings: ReviewFinding[] = [];
  const reviewComments: ReviewComment[] = [];

  for (const file of files) {
    if (!file.patch) {
      continue;
    }

    const positionMap = buildPositionMap(file.patch);
    const prompt = buildReviewPrompt(file, pr, standards);

    // Get review from agent (or skip if no agent available)
    let response: string;
    if (options?.agentReview) {
      response = await options.agentReview(prompt);
    } else {
      // No agent configured — skip review
      continue;
    }

    // Parse findings from LLM response
    const findings = parseLlmFindings(response, file.filename, positionMap);
    allFindings.push(...findings);

    for (const f of findings) {
      reviewComments.push({
        path: f.path,
        position: f.position,
        body: formatFindingComment(f),
      });
    }
  }

  // Build summary
  const criticalCount = allFindings.filter((f) => f.severity === "critical").length;
  const majorCount = allFindings.filter((f) => f.severity === "major").length;
  const summary = buildReviewSummary(pr, allFindings, files.length);

  // Post review if we have findings
  if (reviewComments.length > 0) {
    const event = criticalCount > 0 ? "REQUEST_CHANGES" : majorCount > 0 ? "COMMENT" : "COMMENT";
    await postReview(pr.owner, pr.repo, pr.number, token, {
      body: summary,
      event,
      comments: reviewComments,
    });
  } else {
    // Post summary-only review (no inline comments)
    await postReview(pr.owner, pr.repo, pr.number, token, {
      body: summary,
      event: "COMMENT",
      comments: [],
    });
  }

  return { findings: allFindings, summary };
}

// ---------------------------------------------------------------------------
// Parsing + formatting helpers
// ---------------------------------------------------------------------------

type RawFinding = {
  line: number;
  severity: string;
  message: string;
};

/** Parse LLM response into structured findings with correct diff positions. */
export function parseLlmFindings(
  response: string,
  filename: string,
  positionMap: Map<number, number>,
): ReviewFinding[] {
  // Extract JSON array from response (may be wrapped in markdown code blocks)
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return [];
  }

  let rawFindings: RawFinding[];
  try {
    rawFindings = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(rawFindings)) {
    return [];
  }

  const findings: ReviewFinding[] = [];
  for (const raw of rawFindings) {
    if (!raw.line || !raw.message) {
      continue;
    }

    const position = positionMap.get(raw.line);
    if (!position) {
      // Line not in diff — skip (can't place inline comment)
      continue;
    }

    const severity = normalizeSeverity(raw.severity);
    findings.push({
      path: filename,
      position,
      body: raw.message,
      severity,
    });
  }

  return findings;
}

function normalizeSeverity(s: string): ReviewFinding["severity"] {
  const lower = (s ?? "").toLowerCase();
  if (lower === "critical") {
    return "critical";
  }
  if (lower === "major") {
    return "major";
  }
  if (lower === "minor") {
    return "minor";
  }
  return "suggestion";
}

function formatFindingComment(f: ReviewFinding): string {
  const badge =
    f.severity === "critical"
      ? "**[CRITICAL]**"
      : f.severity === "major"
        ? "**[MAJOR]**"
        : f.severity === "minor"
          ? "[MINOR]"
          : "[SUGGESTION]";
  return `${badge} ${f.body}`;
}

function buildReviewSummary(pr: PrContext, findings: ReviewFinding[], fileCount: number): string {
  const lines: string[] = [];
  lines.push(`## moltbot review: ${pr.title}\n`);

  const critical = findings.filter((f) => f.severity === "critical").length;
  const major = findings.filter((f) => f.severity === "major").length;
  const minor = findings.filter((f) => f.severity === "minor").length;
  const suggestions = findings.filter((f) => f.severity === "suggestion").length;

  if (findings.length === 0) {
    lines.push(`Reviewed ${fileCount} files — no issues found. Looks good!`);
  } else {
    lines.push(`Reviewed ${fileCount} files — found ${findings.length} issue(s):\n`);
    if (critical > 0) {
      lines.push(`- **${critical} critical** (must fix)`);
    }
    if (major > 0) {
      lines.push(`- **${major} major** (should fix)`);
    }
    if (minor > 0) {
      lines.push(`- ${minor} minor`);
    }
    if (suggestions > 0) {
      lines.push(`- ${suggestions} suggestion(s)`);
    }
  }

  lines.push("\n---");
  lines.push("_Reviewed by moltbot_ | _Reaction learning coming in Phase 2_");

  return lines.join("\n");
}
