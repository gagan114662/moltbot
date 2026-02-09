#!/usr/bin/env npx tsx
/**
 * Demo: runs the copilot verification pipeline on the current repo changes.
 * Shows the dashboard + toolchain detection in action.
 */

import { execSync } from "node:child_process";
import {
  runLintStage,
  runTypecheckStage,
  runTestStage,
  discoverTestFiles,
} from "../src/copilot/stages.js";
import { detectToolchain } from "../src/copilot/toolchain.js";

const cwd = process.cwd();

// ── Toolchain detection ──────────────────────────────────────
console.log("\n\x1b[1m\x1b[36m═══ MOLTBOT PIPELINE DEMO ═══\x1b[0m\n");

const toolchain = detectToolchain(cwd);
console.log(`\x1b[1m🔍 Detected toolchain:\x1b[0m ${toolchain.name}`);
console.log(
  `   Lint:      ${toolchain.lint ? `${toolchain.lint.command} ${toolchain.lint.args.join(" ")}` : "none"}`,
);
console.log(
  `   Typecheck: ${toolchain.typecheck ? `${toolchain.typecheck.command} ${toolchain.typecheck.args.join(" ")}` : "none"}`,
);
console.log(
  `   Test:      ${toolchain.test ? `${toolchain.test.command} ${toolchain.test.args.join(" ")}` : "none"}`,
);
console.log(
  `   Build:     ${toolchain.build ? `${toolchain.build.command} ${toolchain.build.args.join(" ")}` : "none"}`,
);
console.log(`   Prompt:    "${toolchain.promptHints.testFramework}"`);
console.log();

// ── Get changed files ────────────────────────────────────────
let changedFiles: string[];
try {
  const output = execSync("git diff --name-only HEAD", { cwd, encoding: "utf-8" }).trim();
  changedFiles = output ? output.split("\n").filter(Boolean) : [];
} catch {
  changedFiles = [];
}

console.log(`\x1b[1m📁 Changed files:\x1b[0m ${changedFiles.length}`);
for (const f of changedFiles.slice(0, 10)) {
  console.log(`   ${f}`);
}
if (changedFiles.length > 10) {
  console.log(`   ... and ${changedFiles.length - 10} more`);
}
console.log();

// ── Test discovery ───────────────────────────────────────────
const testFiles = discoverTestFiles(changedFiles, cwd, toolchain.testDiscovery);
console.log(`\x1b[1m🧪 Discovered test files:\x1b[0m ${testFiles.length}`);
for (const f of testFiles) {
  console.log(`   ${f}`);
}
console.log();

// ── Run stages ───────────────────────────────────────────────
const signal = new AbortController().signal;
const ctx = { changedFiles, cwd, signal };

const stages: Array<{
  name: string;
  run: () => Promise<{ passed: boolean; durationMs: number; error?: string }>;
}> = [
  { name: "LINT", run: () => runLintStage(ctx, toolchain) },
  { name: "TYPECHECK", run: () => runTypecheckStage(ctx, toolchain) },
  { name: "TEST", run: () => runTestStage(ctx, toolchain) },
];

console.log("\x1b[1m\x1b[33m── Running verification stages ──\x1b[0m\n");

let allPassed = true;
for (const stage of stages) {
  const spinner = `\x1b[33m⏳ ${stage.name}...\x1b[0m`;
  process.stdout.write(spinner);

  const start = Date.now();
  const result = await stage.run();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // Clear line and write result
  process.stdout.write("\r\x1b[K");
  if (result.passed) {
    console.log(`\x1b[32m✅ ${stage.name}\x1b[0m — passed (${elapsed}s)`);
  } else {
    allPassed = false;
    console.log(`\x1b[31m❌ ${stage.name}\x1b[0m — FAILED (${elapsed}s)`);
    if (result.error) {
      const lines = result.error.split("\n").slice(0, 8);
      for (const line of lines) {
        console.log(`   \x1b[90m${line}\x1b[0m`);
      }
    }
  }
}

// ── Verdict ──────────────────────────────────────────────────
console.log();
if (allPassed) {
  console.log("\x1b[1m\x1b[32m═══ ALL CHECKS PASSED ═══\x1b[0m");
  console.log("\x1b[32mThe pipeline verified all changes. Ship it.\x1b[0m");
} else {
  console.log("\x1b[1m\x1b[31m═══ CHECKS FAILED ═══\x1b[0m");
  console.log("\x1b[31mFix the errors above, then run again.\x1b[0m");
}
console.log();

// ── Cross-project detection demo ─────────────────────────────
console.log("\x1b[1m\x1b[36m── Cross-project detection demo ──\x1b[0m\n");

const testDirs: Array<{ label: string; path: string }> = [
  { label: "This repo (moltbot)", path: cwd },
];

// Check for scratchpad
const scratchpadPath = `${process.env.HOME}/Desktop/sctrachpad/frontend`;
try {
  execSync(`test -d "${scratchpadPath}"`, { timeout: 1000 });
  testDirs.push({ label: "Scratchpad frontend", path: scratchpadPath });
} catch {
  /* not found */
}

// Check for common project dirs
for (const dir of ["/tmp", `${process.env.HOME}/Desktop`]) {
  try {
    execSync(`test -d "${dir}"`, { timeout: 1000 });
  } catch {
    continue;
  }
}

for (const { label, path } of testDirs) {
  const tc = detectToolchain(path);
  console.log(`\x1b[1m${label}:\x1b[0m ${tc.name}`);
}

console.log("\n\x1b[90mDone. The pipeline adapts to any project type automatically.\x1b[0m\n");
