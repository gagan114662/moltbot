/**
 * Showboat proof-of-work document generation.
 *
 * Wraps the `showboat` CLI (github.com/simonw/showboat) to build
 * executable Markdown proof documents after successful verification.
 * Falls back gracefully when showboat is not installed.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "./types.js";
import type { WorkerResult } from "./worker-types.js";
import { detectTool } from "./tool-detect.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShowboatProofOptions = {
  /** Working directory for git commands */
  cwd: string;
  /** Task description */
  task: string;
  /** Full WorkerResult */
  workerResult: WorkerResult;
  /** Git baseline ref (short SHA before changes) */
  baselineRef: string;
  /** Changed files list */
  changedFiles: string[];
  /** Output path (default: .moltbot/evidence/proof-of-work.md) */
  outputPath?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a showboat CLI command. Returns stdout. */
function showboat(args: string[], cwd: string): string {
  return execSync(["showboat", ...args].join(" "), {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
  }).trim();
}

/** Safely quote a string for shell use (single-quote wrapping). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Find screenshot PNGs in the evidence directory. */
function findScreenshots(evidenceDir: string): string[] {
  try {
    return fs
      .readdirSync(evidenceDir)
      .filter((f) => f.endsWith(".png"))
      .toSorted()
      .map((f) => path.join(evidenceDir, f));
  } catch {
    return [];
  }
}

/** Build a Markdown timing summary from the worker result. */
export function buildTimingSummary(result: WorkerResult): string {
  const lines = [
    "## Verification Summary",
    "",
    `- **Result:** ${result.ok ? "PASS" : "FAIL"}`,
    `- **Iterations:** ${result.iterations.length}`,
    `- **Total time:** ${(result.totalDurationMs / 1000).toFixed(1)}s`,
    `- **Changed files:** ${result.changedFiles.length}`,
    "",
  ];

  const lastIter = result.iterations.at(-1);
  if (lastIter) {
    lines.push("### Stage Results", "");
    lines.push("| Stage | Result | Duration |");
    lines.push("|-------|--------|----------|");
    for (const check of lastIter.checks) {
      const icon = check.passed ? "PASS" : "FAIL";
      const dur = `${(check.durationMs / 1000).toFixed(1)}s`;
      lines.push(`| ${check.stage} | ${icon} | ${dur} |`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main proof builder
// ---------------------------------------------------------------------------

/**
 * Build a Showboat proof-of-work document.
 *
 * The document contains executable code blocks that can be re-run
 * via `showboat verify` to confirm the work is reproducible.
 *
 * Non-fatal: failure here does not block the worker from succeeding.
 */
export async function buildShowboatProof(
  opts: ShowboatProofOptions,
): Promise<StageResult & { proofPath?: string }> {
  const start = Date.now();

  const tool = detectTool("showboat");
  if (!tool.available) {
    return {
      stage: "showboat-proof",
      passed: true,
      durationMs: Date.now() - start,
      error: "showboat not installed (skipped)",
    };
  }

  const evidenceDir = path.join(opts.cwd, ".moltbot", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const docPath = opts.outputPath ?? path.join(evidenceDir, "proof-of-work.md");

  try {
    // 1. Initialize the proof document
    const title = `Proof: ${opts.task.slice(0, 60)}`;
    showboat(["init", shellQuote(docPath), shellQuote(title)], opts.cwd);

    // 2. Task description
    showboat(["note", shellQuote(docPath), shellQuote(opts.task)], opts.cwd);

    // 3. Show what changed (executable — re-runnable)
    showboat(
      ["exec", shellQuote(docPath), "bash", shellQuote(`git diff --stat ${opts.baselineRef}`)],
      opts.cwd,
    );

    // 4. List changed files
    if (opts.changedFiles.length > 0) {
      const fileList = opts.changedFiles.slice(0, 20).join("\n");
      showboat(
        [
          "note",
          shellQuote(docPath),
          shellQuote(`### Changed Files\n\n\`\`\`\n${fileList}\n\`\`\``),
        ],
        opts.cwd,
      );
    }

    // 5. Run tests on changed files (executable — proves they pass)
    const lastIter = opts.workerResult.iterations.at(-1);
    const testCheck = lastIter?.checks.find((c) => c.stage === "test");
    if (testCheck?.passed) {
      const testFiles = testCheck.files?.slice(0, 5) ?? [];
      if (testFiles.length > 0) {
        const testCmd = `pnpm exec vitest run ${testFiles.join(" ")} 2>&1 | tail -5`;
        showboat(["exec", shellQuote(docPath), "bash", shellQuote(testCmd)], opts.cwd);
      }
    }

    // 6. Embed screenshots from evidence dir
    const screenshots = findScreenshots(evidenceDir).filter((s) => !s.endsWith("proof-of-work.md"));
    for (const ss of screenshots.slice(0, 3)) {
      try {
        // showboat image expects a script that produces an image
        // Since we already have the screenshots, use cp to "produce" them
        const ssName = path.basename(ss);
        showboat(
          ["image", shellQuote(docPath), shellQuote(`cp ${shellQuote(ss)} ${shellQuote(ssName)}`)],
          opts.cwd,
        );
      } catch {
        // Non-fatal — image capture may fail
      }
    }

    // 7. Timing summary note
    const summary = buildTimingSummary(opts.workerResult);
    showboat(["note", shellQuote(docPath), shellQuote(summary)], opts.cwd);

    return {
      stage: "showboat-proof",
      passed: true,
      durationMs: Date.now() - start,
      proofPath: docPath,
    };
  } catch (err) {
    return {
      stage: "showboat-proof",
      passed: false,
      durationMs: Date.now() - start,
      error: `Showboat proof generation failed: ${String(err)}`.slice(0, 2000),
    };
  }
}
