#!/usr/bin/env npx tsx
/**
 * Moltbot QA Review — checks Claude's work and gives it feedback.
 *
 * Usage: npx tsx scripts/qa-review.ts [project-path]
 *
 * 1. Detects project toolchain
 * 2. Runs verification stages (lint, typecheck, test)
 * 3. Writes QA-FEEDBACK.md that Claude Code reads on next prompt
 * 4. Bootstraps hooks so Claude auto-sees the feedback
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "../src/copilot/types.js";
import { bootstrapQaHooks } from "../src/copilot/qa-bootstrap.js";
import {
  discoverTestFiles,
  needsTests,
  expectedTestPath,
  runLintStage,
  runTypecheckStage,
  runTestStage,
} from "../src/copilot/stages.js";
import { detectToolchain } from "../src/copilot/toolchain.js";

const targetCwd = path.resolve(process.argv[2] || process.cwd());

// ── Header ───────────────────────────────────────────────────
console.log("\n\x1b[1m\x1b[35m╔══════════════════════════════════════╗\x1b[0m");
console.log("\x1b[1m\x1b[35m║   MOLTBOT QA — Reviewing Your Code   ║\x1b[0m");
console.log("\x1b[1m\x1b[35m╚══════════════════════════════════════╝\x1b[0m\n");

// ── Detect toolchain ─────────────────────────────────────────
const toolchain = detectToolchain(targetCwd);
console.log(`\x1b[1mProject:\x1b[0m  ${targetCwd}`);
console.log(`\x1b[1mToolchain:\x1b[0m ${toolchain.name}\n`);

// ── Bootstrap hooks (so Claude reads our feedback) ───────────
console.log("\x1b[90mInstalling QA hooks in project...\x1b[0m");
try {
  await bootstrapQaHooks(targetCwd);
  console.log("\x1b[32m  Hooks installed — Claude will auto-read QA-FEEDBACK.md\x1b[0m\n");
} catch (err) {
  console.log(`\x1b[33m  Hook install skipped: ${String(err)}\x1b[0m\n`);
}

// ── Get changed files ────────────────────────────────────────
let changedFiles: string[];
try {
  const output = execSync("git diff --name-only HEAD", {
    cwd: targetCwd,
    encoding: "utf-8",
  }).trim();
  changedFiles = output ? output.split("\n").filter(Boolean) : [];
} catch {
  changedFiles = [];
}

if (changedFiles.length === 0) {
  console.log("\x1b[33mNo changed files found. Nothing to review.\x1b[0m\n");
  process.exit(0);
}

console.log(`\x1b[1mReviewing ${changedFiles.length} changed files:\x1b[0m`);
for (const f of changedFiles) {
  console.log(`  \x1b[90m${f}\x1b[0m`);
}
console.log();

// ── Run stages ───────────────────────────────────────────────
const signal = new AbortController().signal;
const ctx = { changedFiles, cwd: targetCwd, signal };
const checks: StageResult[] = [];

const stages = [
  { name: "Lint", run: () => runLintStage(ctx, toolchain) },
  { name: "Typecheck", run: () => runTypecheckStage(ctx, toolchain) },
  { name: "Tests", run: () => runTestStage(ctx, toolchain) },
];

for (const stage of stages) {
  process.stdout.write(`\x1b[33m  ⏳ ${stage.name}...\x1b[0m`);
  const result = await stage.run();
  checks.push(result);
  process.stdout.write("\r\x1b[K");
  if (result.passed) {
    console.log(`  \x1b[32m✅ ${stage.name}\x1b[0m (${(result.durationMs / 1000).toFixed(1)}s)`);
  } else {
    console.log(
      `  \x1b[31m❌ ${stage.name} FAILED\x1b[0m (${(result.durationMs / 1000).toFixed(1)}s)`,
    );
  }
}

// ── Check for missing tests ──────────────────────────────────
const filesNeedingTests = changedFiles.filter((f) => needsTests(f, targetCwd, toolchain));
const testFiles = discoverTestFiles(changedFiles, targetCwd, toolchain.testDiscovery);
const untestedFiles = filesNeedingTests.filter((f) => {
  const expected = expectedTestPath(f, toolchain.testDiscovery);
  return !testFiles.includes(expected) && !fs.existsSync(path.join(targetCwd, expected));
});

// ── Build feedback ───────────────────────────────────────────
const allPassed = checks.every((c) => c.passed);
const failed = checks.filter((c) => !c.passed);

const feedbackLines: string[] = [];
feedbackLines.push(`# QA Review — ${new Date().toLocaleString()}`);
feedbackLines.push("");

if (allPassed && untestedFiles.length === 0) {
  feedbackLines.push("## VERDICT: PASSED ✅");
  feedbackLines.push("");
  feedbackLines.push("All checks passed. Good work. Ship it.");
} else {
  feedbackLines.push("## VERDICT: NEEDS FIXES ❌");
  feedbackLines.push("");
  feedbackLines.push("I found issues with your changes. Fix these before continuing:");
  feedbackLines.push("");

  for (const check of failed) {
    feedbackLines.push(`### ${check.stage.toUpperCase()} FAILED`);
    feedbackLines.push("");
    if (check.error) {
      feedbackLines.push("```");
      // Keep error output concise — first 30 lines
      const errorLines = check.error.split("\n").slice(0, 30);
      feedbackLines.push(...errorLines);
      if (check.error.split("\n").length > 30) {
        feedbackLines.push(`... (${check.error.split("\n").length - 30} more lines)`);
      }
      feedbackLines.push("```");
      feedbackLines.push("");
    }
  }

  if (untestedFiles.length > 0) {
    feedbackLines.push("### MISSING TESTS");
    feedbackLines.push("");
    feedbackLines.push("These files need tests:");
    for (const f of untestedFiles) {
      feedbackLines.push(`- \`${f}\` → create \`${expectedTestPath(f, toolchain.testDiscovery)}\``);
    }
    feedbackLines.push("");
  }
}

// Always add context about what was checked
feedbackLines.push("---");
feedbackLines.push("");
feedbackLines.push(`**Toolchain:** ${toolchain.name}`);
feedbackLines.push(`**Files reviewed:** ${changedFiles.length}`);
feedbackLines.push(
  `**Checks:** ${checks.map((c) => `${c.stage} ${c.passed ? "✅" : "❌"}`).join(", ")}`,
);

if (untestedFiles.length > 0) {
  feedbackLines.push(`**Missing tests:** ${untestedFiles.length} files`);
}

feedbackLines.push("");
feedbackLines.push("*— Moltbot QA (automated review)*");

const feedbackMd = feedbackLines.join("\n");

// ── Write QA-FEEDBACK.md ─────────────────────────────────────
const feedbackPath = path.join(targetCwd, "QA-FEEDBACK.md");
fs.writeFileSync(feedbackPath, feedbackMd);

// ── Also write machine-readable JSON ─────────────────────────
const moltbotDir = path.join(targetCwd, ".moltbot");
fs.mkdirSync(moltbotDir, { recursive: true });
fs.writeFileSync(
  path.join(moltbotDir, "copilot-feedback.json"),
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      ok: allPassed && untestedFiles.length === 0,
      durationMs: checks.reduce((sum, c) => sum + c.durationMs, 0),
      gitRef: "HEAD",
      triggerFiles: changedFiles,
      checks,
      summary: allPassed ? "All checks passed" : `Failed: ${failed.map((c) => c.stage).join(", ")}`,
    },
    null,
    2,
  ),
);

// ── Print the feedback ───────────────────────────────────────
console.log("\n\x1b[1m\x1b[35m── QA Feedback (also written to QA-FEEDBACK.md) ──\x1b[0m\n");
console.log(feedbackMd);

if (!allPassed || untestedFiles.length > 0) {
  console.log("\x1b[33m→ Claude will see this feedback on the next prompt via the QA hook.\x1b[0m");
  console.log("\x1b[33m→ Delete QA-FEEDBACK.md after fixing to clear the review.\x1b[0m\n");
} else {
  // Clean up feedback file on success
  try {
    fs.unlinkSync(feedbackPath);
  } catch {
    // ignore
  }
  console.log("\x1b[32m→ No issues found. QA-FEEDBACK.md cleared.\x1b[0m\n");
}
