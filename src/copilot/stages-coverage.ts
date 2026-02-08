/**
 * Coverage-diff stage: after tests pass, verify that changed lines are covered.
 *
 * Runs vitest with V8 coverage, parses LCOV output, then checks that lines
 * touched since baseline are actually exercised by tests.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "./types.js";
import { truncateError } from "./feedback.js";
import { runCommand, type StageContext } from "./stages.js";

// --- LCOV parser ---

export type LcovRecord = {
  file: string;
  /** Map of line number → execution count */
  lines: Map<number, number>;
};

/** Parse LCOV-formatted coverage data into per-file records. */
export function parseLcov(content: string): LcovRecord[] {
  const records: LcovRecord[] = [];
  let current: LcovRecord | null = null;

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = { file: line.slice(3), lines: new Map() };
    } else if (line.startsWith("DA:") && current) {
      const parts = line.slice(3).split(",");
      const lineNum = Number.parseInt(parts[0], 10);
      const count = Number.parseInt(parts[1], 10);
      if (!Number.isNaN(lineNum) && !Number.isNaN(count)) {
        current.lines.set(lineNum, count);
      }
    } else if (line === "end_of_record" && current) {
      records.push(current);
      current = null;
    }
  }
  return records;
}

// --- Git diff line detection ---

/**
 * Get line numbers that were added/modified in a file relative to a baseline ref.
 * Uses `git diff --unified=0` to identify exact changed lines.
 */
export function getChangedLineNumbers(cwd: string, baselineRef: string, file: string): number[] {
  try {
    const output = execSync(`git diff --unified=0 ${baselineRef} -- "${file}"`, {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
    });

    const lines: number[] = [];
    // Match @@ -old,count +new,count @@ hunks
    const hunkRe = /^@@\s.*\+(\d+)(?:,(\d+))?\s@@/gm;
    let match = hunkRe.exec(output);
    while (match) {
      const start = Number.parseInt(match[1], 10);
      const count = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
      for (let i = start; i < start + count; i++) {
        lines.push(i);
      }
      match = hunkRe.exec(output);
    }
    return lines;
  } catch {
    return [];
  }
}

/**
 * Check if a file is entirely new (100% added lines = all lines are "changed").
 * New files get a relaxed coverage threshold.
 */
function isEntirelyNewFile(cwd: string, baselineRef: string, file: string): boolean {
  try {
    const output = execSync(`git diff --name-status ${baselineRef} -- "${file}"`, {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return output.startsWith("A\t") || output.startsWith("A ");
  } catch {
    return false;
  }
}

// --- Skip filters ---

const SKIP_PATTERNS = [/\.d\.ts$/, /\.config\.(ts|js|mjs)$/, /\.json$/, /\.md$/];

function shouldSkipFile(file: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(file));
}

// --- Stage runner ---

export type CoverageContext = StageContext & {
  baselineRef: string;
};

/** Minimum changed lines before coverage check applies to a file. */
const MIN_CHANGED_LINES = 5;
/** Coverage threshold for modified files. */
const MODIFIED_FILE_THRESHOLD = 0.5;
/** Relaxed threshold for entirely new files. */
const NEW_FILE_THRESHOLD = 0.3;

export async function runCoverageDiffStage(ctx: CoverageContext): Promise<StageResult> {
  const start = Date.now();

  // Run vitest with coverage
  const coverageDir = path.join(ctx.cwd, ".moltbot", "coverage-tmp");
  try {
    fs.mkdirSync(coverageDir, { recursive: true });
  } catch {
    // ignore
  }

  try {
    await runCommand(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--coverage",
        "--coverage.provider=v8",
        "--coverage.reporter=lcov",
        `--coverage.reportsDirectory=${coverageDir}`,
      ],
      { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: 180_000 },
    );
  } catch (err) {
    // Coverage run failed — non-blocking, pass with warning
    return {
      stage: "coverage-diff",
      passed: true,
      durationMs: Date.now() - start,
      error: `Coverage run failed (non-blocking): ${String(err).slice(0, 200)}`,
    };
  }

  // Read LCOV output
  const lcovPath = path.join(coverageDir, "lcov.info");
  let lcovContent: string;
  try {
    lcovContent = fs.readFileSync(lcovPath, "utf-8");
  } catch {
    return {
      stage: "coverage-diff",
      passed: true,
      durationMs: Date.now() - start,
      error: "No lcov.info found (coverage may not have generated)",
    };
  }

  const records = parseLcov(lcovContent);
  const recordsByFile = new Map<string, LcovRecord>();
  for (const r of records) {
    // Normalize to relative path
    const rel = path.isAbsolute(r.file) ? path.relative(ctx.cwd, r.file) : r.file;
    recordsByFile.set(rel, r);
  }

  // Check coverage for changed files
  const uncoveredFiles: string[] = [];
  const tsFiles = ctx.changedFiles.filter(
    (f) => /\.(ts|tsx|js|jsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f) && !shouldSkipFile(f),
  );

  for (const file of tsFiles) {
    const changedLines = getChangedLineNumbers(ctx.cwd, ctx.baselineRef, file);
    if (changedLines.length < MIN_CHANGED_LINES) {
      continue;
    }

    const record = recordsByFile.get(file);
    if (!record) {
      // No coverage data for this file — skip (might not be in test scope)
      continue;
    }

    // Count covered vs uncovered among changed lines
    let covered = 0;
    let total = 0;
    for (const line of changedLines) {
      if (record.lines.has(line)) {
        total++;
        if ((record.lines.get(line) ?? 0) > 0) {
          covered++;
        }
      }
    }

    if (total === 0) {
      continue;
    }

    const ratio = covered / total;
    const isNew = isEntirelyNewFile(ctx.cwd, ctx.baselineRef, file);
    const threshold = isNew ? NEW_FILE_THRESHOLD : MODIFIED_FILE_THRESHOLD;

    if (ratio < threshold) {
      uncoveredFiles.push(
        `${file}: ${Math.round(ratio * 100)}% of changed lines covered (need ${Math.round(threshold * 100)}%)`,
      );
    }
  }

  // Clean up
  try {
    fs.rmSync(coverageDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  if (uncoveredFiles.length > 0) {
    return {
      stage: "coverage-diff",
      passed: false,
      durationMs: Date.now() - start,
      error: truncateError(
        `Insufficient test coverage for changed lines:\n${uncoveredFiles.join("\n")}`,
      ),
      files: tsFiles,
    };
  }

  return {
    stage: "coverage-diff",
    passed: true,
    durationMs: Date.now() - start,
    files: tsFiles,
  };
}
