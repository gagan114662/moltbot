#!/usr/bin/env tsx
/**
 * Overnight self-healing loop for the Scratchpad AI tutor.
 *
 * Wraps the inner TAO loop (voice-qa-loop.ts) with:
 * - Cross-cycle memory (what was tried, what worked)
 * - Strategy escalation (standard → contextual → architectural → fallback)
 * - Progress logging and morning reports
 * - Safety rails (max cycles, regression rollback, API backoff)
 *
 * Usage:
 *   npx tsx scripts/run-overnight.ts                    # Default: 20 cycles, Codex agent
 *   npx tsx scripts/run-overnight.ts --max-cycles=10    # Limit cycles
 *   npx tsx scripts/run-overnight.ts --dry-run           # Single cycle for testing
 *   npx tsx scripts/run-overnight.ts --resume            # Resume from persisted state
 *   npx tsx scripts/run-overnight.ts --model=o3          # Override Codex model
 *   npx tsx scripts/run-overnight.ts --stall-threshold=4 # Escalate after N stalled cycles
 *   npx tsx scripts/run-overnight.ts --claude-code       # Use ClaudeCodeDriver (fresh context per iteration)
 *
 * Monitor progress:
 *   tail -f ~/.openclaw/workspace/evidence/overnight-progress.log
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CycleRecord,
  OvernightConfig,
  OvernightState,
} from "../src/copilot/overnight-types.js";
import type { VoiceQaLoopResult } from "../src/copilot/voice-qa-loop.js";
import { overnightCycleToRecord } from "../src/context/adapters/overnight-adapter.js";
import { ContextStore } from "../src/context/store.js";
import { createAgentDriver } from "../src/copilot/agent-driver.js";
import { resolveChromePath } from "../src/copilot/browser-inspect.js";
import {
  createCheckpoint,
  getCurrentHead,
  rollbackToCheckpoint,
  squashCheckpoints,
} from "../src/copilot/checkpoint.js";
import { generateMorningReport } from "../src/copilot/overnight-report.js";
import { detectPhase, resolveStrategy } from "../src/copilot/overnight-strategy.js";
import { runVoiceQaLoop } from "../src/copilot/voice-qa-loop.js";
import { ELEMENTARY_MATH_SCRIPT } from "../src/copilot/voice-qa.js";
import {
  createAgentAnalyze,
  createAgentDiagnose,
  createDescribeScreenshot,
  getAnthropicKey,
} from "./qa-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_DIR = "/Users/gaganarora/Desktop/sctrachpad/frontend";
const MOLTBOT_DIR = "/Users/gaganarora/Desktop/my projects/moltbot";
const TMUX_TARGET = "scratchpad:0.0";
const EVIDENCE_DIR = path.join(os.homedir(), ".openclaw/workspace/evidence");
const MAX_TRIED_APPROACHES = 20;

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(): OvernightConfig {
  const args = process.argv.slice(2);
  const getFlag = (name: string, def: string): string => {
    const arg = args.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.split("=")[1] : def;
  };

  return {
    maxCycles: parseInt(getFlag("max-cycles", "20"), 10),
    stallThreshold: parseInt(getFlag("stall-threshold", "3"), 10),
    targetDir: TARGET_DIR,
    moltbotDir: MOLTBOT_DIR,
    progressFile: path.join(EVIDENCE_DIR, "overnight-progress.log"),
    scoreGoal: parseInt(getFlag("score-goal", "7"), 10),
    maxWallTimeMs: parseInt(getFlag("max-hours", "6"), 10) * 3600000,
    codexModel: args.find((a) => a.startsWith("--model="))?.split("=")[1],
    dryRun: args.includes("--dry-run"),
    useClaudeCode: args.includes("--claude-code"),
  };
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function stateDir(): string {
  return EVIDENCE_DIR;
}

function stateFilePath(runId: string): string {
  return path.join(stateDir(), `overnight-state-${runId}.json`);
}

function latestStateFile(): string | null {
  if (!fs.existsSync(stateDir())) {
    return null;
  }
  const files = fs
    .readdirSync(stateDir())
    .filter((f) => f.startsWith("overnight-state-") && f.endsWith(".json"))
    .toSorted()
    .toReversed();
  return files.length > 0 ? path.join(stateDir(), files[0]) : null;
}

function loadState(config: OvernightConfig): OvernightState | null {
  if (!process.argv.includes("--resume")) {
    return null;
  }
  const file = latestStateFile();
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    log(config, `Resumed from ${file} (cycle ${data.completedCycles})`);
    return data as OvernightState;
  } catch {
    return null;
  }
}

function initState(config: OvernightConfig): OvernightState {
  const baseHead = getCurrentHead(config.targetDir) ?? "unknown";
  return {
    runId: crypto.randomUUID().slice(0, 8),
    startedAt: new Date().toISOString(),
    baseHead,
    completedCycles: 0,
    cycles: [],
    triedApproaches: [],
    bestScore: 0,
    bestScoreCycle: 0,
    currentPhase: "phase-1-connect",
    consecutiveStalls: 0,
    consecutiveApiErrors: 0,
  };
}

function persistState(state: OvernightState, config: OvernightConfig): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(stateFilePath(state.runId), JSON.stringify(state, null, 2));
  log(config, `State persisted: ${stateFilePath(state.runId)}`);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(config: OvernightConfig, msg: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${msg}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(config.progressFile), { recursive: true });
    fs.appendFileSync(config.progressFile, line + "\n");
  } catch {
    // Non-fatal: progress file write failure shouldn't stop the loop
  }
}

// ---------------------------------------------------------------------------
// Cycle outcome recording
// ---------------------------------------------------------------------------

function recordCycleOutcome(
  state: OvernightState,
  cycle: number,
  result: VoiceQaLoopResult,
  startTimeMs: number,
): CycleRecord {
  const currentScore = result.lastScorecard?.overall ?? null;
  const previousScore = state.cycles.at(-1)?.score ?? null;
  const scoreImproved =
    currentScore !== null && previousScore !== null && currentScore > previousScore;
  const scoreRegressed =
    currentScore !== null && previousScore !== null && currentScore < previousScore - 0.5;

  // Extract diagnoses from iteration history
  const diagnoses = (result.iterationHistory ?? [])
    .flatMap((h) => h.diagnoses)
    .map((d) => d.rootCause);
  const uniqueDiagnoses = [...new Set(diagnoses)];

  // Extract changed files from last iteration's observation
  const lastObs = result.iterationHistory?.at(-1)?.observation;
  const changedFiles = lastObs?.changedFiles ?? [];
  const diffLines = lastObs?.diffStat?.split("\n") ?? [];
  const diffSummary = diffLines.at(-1)?.trim() ?? "no changes";

  // Update tried approaches (capped)
  for (const d of uniqueDiagnoses) {
    if (!state.triedApproaches.includes(d)) {
      state.triedApproaches.push(d);
    }
  }
  if (state.triedApproaches.length > MAX_TRIED_APPROACHES) {
    state.triedApproaches = state.triedApproaches.slice(-MAX_TRIED_APPROACHES);
  }

  const record: CycleRecord = {
    cycle,
    startedAt: new Date(startTimeMs).toISOString(),
    durationMs: Date.now() - startTimeMs,
    stopReason: result.stopReason,
    iterations: result.iterations,
    score: currentScore,
    phase: state.currentPhase,
    strategy: resolveStrategy(state).level,
    diagnoses: uniqueDiagnoses,
    changedFiles,
    diffSummary,
    scoreImproved,
    scoreRegressed,
  };

  state.cycles.push(record);
  state.completedCycles = cycle;

  // Update stall tracking
  if (currentScore !== null && !scoreImproved) {
    state.consecutiveStalls++;
  } else if (scoreImproved) {
    state.consecutiveStalls = 0;
  }

  // Update best score
  if (currentScore !== null && currentScore > state.bestScore) {
    state.bestScore = currentScore;
    state.bestScoreCycle = cycle;
  }

  // Update phase
  state.currentPhase = detectPhase(state);

  return record;
}

// ---------------------------------------------------------------------------
// Preamble wrapper for agentDiagnose
// ---------------------------------------------------------------------------

function wrapDiagnoseWithPreamble(
  baseDiagnose: (prompt: string) => Promise<string>,
  preamble: string,
): (prompt: string) => Promise<string> {
  if (!preamble) {
    return baseDiagnose;
  }
  return (prompt: string) => baseDiagnose(`${preamble}\n\n---\n\n${prompt}`);
}

// ---------------------------------------------------------------------------
// Sleep utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Dev server health check
// ---------------------------------------------------------------------------

async function isDevServerAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok || res.status === 304;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function runOvernightLoop(config: OvernightConfig): Promise<void> {
  const state = loadState(config) ?? initState(config);
  const contextStore = new ContextStore();
  const loopStartTime = Date.now();
  const maxCycles = config.dryRun ? 1 : config.maxCycles;

  log(config, `=== Overnight Self-Healing Loop ===`);
  log(config, `Run ID: ${state.runId}`);
  log(config, `Target: ${config.targetDir}`);
  log(config, `Max cycles: ${maxCycles}`);
  log(config, `Score goal: ${config.scoreGoal}/10`);
  log(config, `Stall threshold: ${config.stallThreshold}`);
  log(config, `Base HEAD: ${state.baseHead}`);
  log(config, `Progress: tail -f ${config.progressFile}`);
  log(config, "");

  // Resolve Chrome
  const chromePath = resolveChromePath();
  if (!chromePath) {
    log(config, "ERROR: Chrome not found. Exiting.");
    return;
  }

  // Resolve API key
  let apiKey: string;
  try {
    apiKey = await getAnthropicKey();
    log(config, `Anthropic auth: ${apiKey.slice(0, 12)}...`);
  } catch (err) {
    log(config, `ERROR: Failed to get Anthropic API key: ${String(err)}`);
    log(config, "Re-run `claude /login` and restart.");
    return;
  }

  for (let cycle = state.completedCycles + 1; cycle <= maxCycles; cycle++) {
    if (shuttingDown) {
      log(config, "Graceful shutdown: stopping before next cycle.");
      break;
    }

    // Wall time check
    if (Date.now() - loopStartTime > config.maxWallTimeMs) {
      log(config, `Wall time limit reached (${config.maxWallTimeMs / 3600000}h). Stopping.`);
      break;
    }

    // Check dev server
    const appUrl = "http://localhost:3000/app";
    const alive = await isDevServerAlive("http://localhost:3000");
    if (!alive) {
      log(config, "WARNING: Dev server at localhost:3000 not responding. Waiting 30s...");
      await sleep(30000);
      const retryAlive = await isDevServerAlive("http://localhost:3000");
      if (!retryAlive) {
        log(config, "ERROR: Dev server still down. Stopping loop.");
        log(config, "Start the dev server: cd sctrachpad/frontend && npm run dev");
        break;
      }
    }

    // Resolve strategy
    const strategy = resolveStrategy(state);
    log(
      config,
      `\n=== Cycle ${cycle}/${maxCycles} | Phase: ${strategy.phase} | Strategy: ${strategy.level} ===`,
    );

    // Git checkpoint before cycle
    const checkpointSha = createCheckpoint(config.targetDir, `pre-cycle-${cycle}`);
    if (checkpointSha) {
      log(config, `Checkpoint: ${checkpointSha.slice(0, 8)} (pre-cycle-${cycle})`);
    }

    // Refresh API key each cycle (tokens may expire overnight)
    try {
      apiKey = await getAnthropicKey();
    } catch (err) {
      log(config, `ERROR: API key refresh failed: ${String(err)}`);
      state.consecutiveApiErrors++;
      const backoffMs = Math.min(60_000 * Math.pow(2, state.consecutiveApiErrors), 600_000);
      log(config, `Backing off ${backoffMs / 1000}s...`);
      await sleep(backoffMs);
      continue;
    }
    state.consecutiveApiErrors = 0;

    // Create agent driver with strategy-aware model
    const codexModel = strategy.codexModel ?? config.codexModel;
    const agentDriver = config.useClaudeCode
      ? createAgentDriver({
          claudeCodeTargetCwd: config.targetDir,
          claudeCodeModel: codexModel ?? "sonnet",
        })
      : createAgentDriver({
          codexTargetCwd: config.targetDir,
          codexModel,
        });

    // Build diagnose callback with strategic preamble
    const baseDiagnose = createAgentDiagnose(apiKey);
    const diagnoseWithPreamble = wrapDiagnoseWithPreamble(baseDiagnose, strategy.strategicPreamble);

    // Run inner TAO loop
    const cycleStartMs = Date.now();
    let result: VoiceQaLoopResult;
    try {
      result = await runVoiceQaLoop({
        appUrl,
        chromePath,
        cwd: config.moltbotDir,
        targetCwd: config.targetDir,
        tmuxTarget: TMUX_TARGET,
        agentDriver,
        script: ELEMENTARY_MATH_SCRIPT,
        sourceFiles: strategy.extraSourceFiles,
        agentAnalyze: createAgentAnalyze(apiKey),
        agentDiagnose: diagnoseWithPreamble,
        agentDescribeScreenshot: createDescribeScreenshot(apiKey),
        maxIterations: strategy.innerMaxIterations,
        enableCheckpoints: true,
        overnightState: state,
        onProgress: (msg) => log(config, `  [inner] ${msg}`),
      });
    } catch (err) {
      log(config, `ERROR: Inner loop crashed: ${String(err)}`);
      // Record a failed cycle
      const crashRecord: CycleRecord = {
        cycle,
        startedAt: new Date(cycleStartMs).toISOString(),
        durationMs: Date.now() - cycleStartMs,
        stopReason: `crash: ${String(err)}`,
        iterations: 0,
        score: null,
        phase: state.currentPhase,
        strategy: strategy.level,
        diagnoses: [],
        changedFiles: [],
        diffSummary: "inner loop crashed",
        scoreImproved: false,
        scoreRegressed: false,
      };
      state.cycles.push(crashRecord);
      state.completedCycles = cycle;
      state.consecutiveStalls++;
      // RLM context store: persist crash cycle
      try {
        const adapted = overnightCycleToRecord(crashRecord, state.runId);
        contextStore.append(adapted.domain, adapted.scopeKey, adapted.payload, adapted.tags);
      } catch {
        /* context store failures must never break the overnight loop */
      }
      persistState(state, config);
      await sleep(15000);
      continue;
    }

    // Record outcome
    const cycleRecord = recordCycleOutcome(state, cycle, result, cycleStartMs);
    // RLM context store: persist rich cycle data for cross-run learning
    try {
      const adapted = overnightCycleToRecord(cycleRecord, state.runId);
      contextStore.append(adapted.domain, adapted.scopeKey, adapted.payload, adapted.tags);
    } catch {
      /* context store failures must never break the overnight loop */
    }
    const scoreStr = cycleRecord.score !== null ? `${cycleRecord.score}/10` : "N/A";
    log(
      config,
      `Cycle ${cycle} complete: score ${scoreStr}, ` +
        `stopReason=${result.stopReason}, iterations=${result.iterations}`,
    );
    if (cycleRecord.diagnoses.length > 0) {
      log(config, `  Diagnoses: ${cycleRecord.diagnoses.slice(0, 3).join(", ")}`);
    }
    if (cycleRecord.changedFiles.length > 0) {
      log(config, `  Changed: ${cycleRecord.changedFiles.join(", ")}`);
    }

    // Auto-stop on success
    if (result.ok) {
      log(config, `PASSED on cycle ${cycle}! Score: ${scoreStr}`);
      squashCheckpoints(config.targetDir, state.baseHead);
      break;
    }

    // Auto-stop on score goal
    if (cycleRecord.score !== null && cycleRecord.score >= config.scoreGoal) {
      log(config, `Score goal reached (${cycleRecord.score}/${config.scoreGoal}). Stopping.`);
      squashCheckpoints(config.targetDir, state.baseHead);
      break;
    }

    // Regression rollback
    if (cycleRecord.scoreRegressed && checkpointSha) {
      log(
        config,
        `Score REGRESSED (${state.cycles.at(-2)?.score ?? "?"} -> ${cycleRecord.score}). Rolling back.`,
      );
      rollbackToCheckpoint(config.targetDir, checkpointSha);
    }

    // Persist state between cycles
    persistState(state, config);

    // Cooldown
    if (!config.dryRun) {
      log(config, "Cooldown 15s before next cycle...");
      await sleep(15000);
    }
  }

  // Generate morning report
  const report = generateMorningReport(state);
  const reportDate = new Date().toISOString().slice(0, 10);
  const reportFile = path.join(EVIDENCE_DIR, `overnight-report-${reportDate}.md`);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, report);
  log(config, `\nMorning report: ${reportFile}`);

  // Final state persistence
  persistState(state, config);

  // Print summary
  log(config, "\n=== Overnight Loop Complete ===");
  log(config, `Cycles: ${state.completedCycles}`);
  log(config, `Best score: ${state.bestScore}/10 (cycle ${state.bestScoreCycle})`);
  log(config, `Final phase: ${state.currentPhase}`);
  const scored = state.cycles.filter((c) => c.score !== null);
  if (scored.length > 0) {
    log(config, `Trajectory: ${scored.map((c) => `${c.score}/10`).join(" -> ")}`);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown handlers
// ---------------------------------------------------------------------------

process.on("SIGINT", () => {
  if (shuttingDown) {
    // eslint-disable-next-line no-console
    console.log("\nForce exit.");
    process.exit(1);
  }
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log("\nSIGINT received. Finishing current cycle, then generating report...");
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log("\nSIGTERM received. Will stop after current cycle.");
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const config = parseArgs();
runOvernightLoop(config).catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Overnight loop failed:", err);
  process.exit(1);
});
