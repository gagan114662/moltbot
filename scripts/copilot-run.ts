#!/usr/bin/env npx tsx
/**
 * Direct copilot worker runner — bypasses the CLI entry point.
 *
 * Usage: npx tsx scripts/copilot-run.ts "task description" [--agent=ID] [--cwd=PATH] [--headed] [--json]
 *
 * Runs the full autonomous loop:
 *   Agent writes code → Moltbot verifies → Feeds back errors → Agent fixes → Repeat
 */

import type { WorkerConfig } from "../src/copilot/worker-types.js";
import { runWorker } from "../src/copilot/worker.js";

const task = process.argv[2];
if (!task) {
  console.error(
    'Usage: npx tsx scripts/copilot-run.ts "task description" [--agent=ID] [--cwd=PATH] [--headed] [--json]',
  );
  process.exit(1);
}

const headed = process.argv.includes("--headed");
const json = process.argv.includes("--json");
const agentId = process.argv.find((a) => a.startsWith("--agent="))?.split("=")[1] ?? "researcher";
const cwd = process.argv.find((a) => a.startsWith("--cwd="))?.split("=")[1] ?? process.cwd();

console.log("\n\x1b[1m\x1b[35m╔═══════════════════════════════════════════╗\x1b[0m");
console.log("\x1b[1m\x1b[35m║   MOLTBOT COPILOT — Autonomous Worker     ║\x1b[0m");
console.log("\x1b[1m\x1b[35m╚═══════════════════════════════════════════╝\x1b[0m\n");
console.log(`\x1b[1mTask:\x1b[0m  ${task}`);
console.log(`\x1b[1mCwd:\x1b[0m   ${cwd}`);
console.log(`\x1b[1mAgent:\x1b[0m ${agentId}`);
console.log(`\x1b[1mMode:\x1b[0m  local (embedded agent)\n`);

const config: WorkerConfig = {
  task,
  cwd,
  agentId,
  maxIterations: 3,
  stallLimit: 2,
  noTests: false,
  noVideo: true,
  noBrowser: true,
  noCoverage: true,
  noScreenshotDiff: true,
  noReview: true,
  noSpecTests: true,
  noUxEval: true,
  uxEvalSteps: 10,
  uxEvalSample: 5,
  turnTimeoutSeconds: 180,
  local: true,
  json,
  headed,
  noBootstrapHooks: true,
};

try {
  const result = await runWorker(config);
  if (result.ok) {
    console.log(
      `\n\x1b[1m\x1b[32m✅ DONE — ${result.iterations.length} iteration(s), all checks passed.\x1b[0m`,
    );
    console.log(`\x1b[32mChanged files: ${result.changedFiles.join(", ")}\x1b[0m\n`);
  } else {
    console.log(
      `\n\x1b[1m\x1b[31m❌ STOPPED — ${result.stopReason} after ${result.iterations.length} iteration(s).\x1b[0m\n`,
    );
  }
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  console.error("\x1b[31mWorker crashed:\x1b[0m", err);
  process.exit(1);
}
