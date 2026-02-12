#!/usr/bin/env tsx
/**
 * Voice QA runner — uses the TAO loop (Think-Act-Observe) by default.
 *
 * Usage:
 *   npx tsx scripts/run-voice-qa.ts                    # Multi-turn, Codex agent (default)
 *   npx tsx scripts/run-voice-qa.ts --tmux              # Multi-turn, legacy tmux/Claude
 *   npx tsx scripts/run-voice-qa.ts --script=geometry   # Use geometry test script
 *   npx tsx scripts/run-voice-qa.ts --script=fractions  # Use fractions test script
 *   npx tsx scripts/run-voice-qa.ts --quick             # Single-prompt mode
 *   npx tsx scripts/run-voice-qa.ts --claude-code        # Fresh context per iteration (claude --print)
 *   npx tsx scripts/run-voice-qa.ts --checkpoint        # Enable git checkpoints (rollback on stall)
 *   npx tsx scripts/run-voice-qa.ts --no-loop           # Legacy one-shot (no re-testing)
 */
import { createAgentDriver } from "../src/copilot/agent-driver.js";
import { resolveChromePath } from "../src/copilot/browser-inspect.js";
import { runVoiceQaLoop } from "../src/copilot/voice-qa-loop.js";
import {
  ELEMENTARY_MATH_SCRIPT,
  FRACTIONS_SCRIPT,
  GEOMETRY_SCRIPT,
} from "../src/copilot/voice-qa.js";
import {
  ANTHROPIC_MODEL_ID,
  createAgentAnalyze,
  createAgentDiagnose,
  createDescribeScreenshot,
  getAnthropicKey,
} from "./qa-helpers.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TARGET_DIR = "/Users/gaganarora/Desktop/sctrachpad/frontend";
const TMUX_TARGET = "scratchpad:0.0";

const SOURCE_FILE_PATHS = [
  "src/hooks/useScratchpadAI.ts",
  "src/features/tutor/tutor-service.ts",
  "src/hooks/canvas-renderer.ts",
  "src/components/ScratchpadCanvas.tsx",
  "src/App.tsx",
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Resolve the student script from CLI args. */
function resolveScript(): import("../src/copilot/voice-qa.js").StudentScript | undefined {
  const scriptArg = process.argv.find((a) => a.startsWith("--script="));
  if (!scriptArg) {
    return process.argv.includes("--quick") ? undefined : ELEMENTARY_MATH_SCRIPT;
  }
  const name = scriptArg.split("=")[1];
  switch (name) {
    case "geometry":
      return GEOMETRY_SCRIPT;
    case "fractions":
      return FRACTIONS_SCRIPT;
    case "math":
    case "elementary-math":
      return ELEMENTARY_MATH_SCRIPT;
    default:
      console.error(`Unknown script: ${name}. Available: math, geometry, fractions`);
      process.exit(1);
  }
}

async function main() {
  const isQuick = process.argv.includes("--quick");
  const noLoop = process.argv.includes("--no-loop");
  const useTmux = process.argv.includes("--tmux");
  const useClaudeCode = process.argv.includes("--claude-code");
  const useCodex = !useClaudeCode && (process.argv.includes("--codex") || !useTmux); // Codex is default
  const useCheckpoints = process.argv.includes("--checkpoint");
  const modelArg = process.argv.find((a) => a.startsWith("--model="));
  const agentModel = modelArg ? modelArg.split("=")[1] : undefined;

  const chromePath = resolveChromePath();
  if (!chromePath) {
    console.error("Chrome not found");
    process.exit(1);
  }

  // Resolve Anthropic API key (OAuth token refresh handled automatically)
  const apiKey = await getAnthropicKey();
  const isOAuth = apiKey.includes("sk-ant-oat");
  console.log(`Anthropic auth: ${isOAuth ? "OAuth" : "API key"} (${apiKey.slice(0, 12)}...)`);

  // Create agent driver
  const agentDriver = createAgentDriver(
    useClaudeCode
      ? { claudeCodeTargetCwd: TARGET_DIR, claudeCodeModel: agentModel ?? "sonnet" }
      : useCodex
        ? { codexTargetCwd: TARGET_DIR, codexModel: agentModel }
        : { tmuxTarget: TMUX_TARGET },
  );

  const script = resolveScript();
  const maxIterations = noLoop ? 1 : 3;
  const mode = isQuick ? "single-prompt" : "multi-turn";
  const loopLabel = noLoop ? "one-shot" : `TAO loop (max ${maxIterations} iterations)`;

  console.log(`Chrome: ${chromePath}`);
  console.log(`Model: ${ANTHROPIC_MODEL_ID}`);
  console.log(`Mode: ${mode}, ${loopLabel}`);
  console.log(`Agent: ${agentDriver.name}`);
  console.log(`Target: ${TARGET_DIR}`);
  console.log(`Tmux: ${TMUX_TARGET}`);
  console.log(`Checkpoints: ${useCheckpoints ? "enabled" : "disabled"}`);
  console.log("");

  const result = await runVoiceQaLoop({
    appUrl: "http://localhost:3000/app",
    chromePath,
    cwd: process.cwd(),
    targetCwd: TARGET_DIR,
    tmuxTarget: TMUX_TARGET,
    agentDriver,
    script: isQuick ? undefined : script,
    prompts: isQuick ? ["What is two plus two?"] : undefined,
    sourceFiles: SOURCE_FILE_PATHS,
    agentAnalyze: createAgentAnalyze(apiKey),
    agentDiagnose: createAgentDiagnose(apiKey),
    agentDescribeScreenshot: createDescribeScreenshot(apiKey),
    maxIterations,
    enableCheckpoints: useCheckpoints,
    onProgress: (msg) => console.log(`[voice-qa-loop] ${msg}`),
  });

  console.log("");
  if (result.ok) {
    console.log(`PASSED after ${result.iterations} iteration(s).`);
  } else {
    console.log(`FAILED: ${result.stopReason} after ${result.iterations} iteration(s).`);
    if (result.lastReport) {
      console.log("\n" + result.lastReport);
    }
    // Show scorecard if available
    if (result.lastScorecard) {
      console.log(`\nKhan Academy Score: ${result.lastScorecard.overall}/10`);
      console.log(`  Visual clarity: ${result.lastScorecard.visualClarity}/5`);
      console.log(`  Teaching effectiveness: ${result.lastScorecard.teachingEffectiveness}/5`);
      console.log(`  Scratchpad usage: ${result.lastScorecard.scratchpadUsage}/5`);
      console.log(`  Conversation flow: ${result.lastScorecard.conversationFlow}/5`);
      console.log(`  Age appropriateness: ${result.lastScorecard.ageAppropriateness}/5`);
      if (result.lastScorecard.khanComparison) {
        console.log(`  Khan comparison: ${result.lastScorecard.khanComparison}`);
      }
      if (result.lastScorecard.aestheticNotes.length > 0) {
        console.log(`  Aesthetic notes:`);
        for (const note of result.lastScorecard.aestheticNotes) {
          console.log(`    - ${note}`);
        }
      }
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Voice QA failed:", err);
  process.exit(1);
});
