#!/usr/bin/env tsx
/**
 * Voice QA runner — uses the TAO loop (Think-Act-Observe) by default.
 *
 * Usage:
 *   npx tsx scripts/run-voice-qa.ts            # Multi-turn, TAO loop (3 iterations)
 *   npx tsx scripts/run-voice-qa.ts --quick     # Single-prompt, TAO loop (3 iterations)
 *   npx tsx scripts/run-voice-qa.ts --no-loop   # Legacy one-shot (no re-testing)
 */
import { resolveChromePath } from "../src/copilot/browser-inspect.js";
import { runVoiceQaLoop } from "../src/copilot/voice-qa-loop.js";
import { ELEMENTARY_MATH_SCRIPT } from "../src/copilot/voice-qa.js";

// ---------------------------------------------------------------------------
// LLM diagnosis via OpenRouter
// ---------------------------------------------------------------------------

function createAgentDiagnose(): ((prompt: string) => Promise<string>) | undefined {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("OPENROUTER_API_KEY not set — LLM diagnosis will be skipped");
    return undefined;
  }

  return async (prompt: string): Promise<string> => {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "moonshotai/kimi-k2.5",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenRouter failed: ${resp.status} ${body.slice(0, 200)}`);
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  };
}

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

async function main() {
  const isQuick = process.argv.includes("--quick");
  const noLoop = process.argv.includes("--no-loop");

  const chromePath = resolveChromePath();
  if (!chromePath) {
    console.error("Chrome not found");
    process.exit(1);
  }

  const maxIterations = noLoop ? 1 : 3;
  const mode = isQuick ? "single-prompt" : "multi-turn";
  const loopLabel = noLoop ? "one-shot" : `TAO loop (max ${maxIterations} iterations)`;

  console.log(`Chrome: ${chromePath}`);
  console.log(`Mode: ${mode}, ${loopLabel}`);
  console.log(`Target: ${TARGET_DIR}`);
  console.log(`Tmux: ${TMUX_TARGET}`);
  console.log("");

  const result = await runVoiceQaLoop({
    appUrl: "http://localhost:3000/app",
    chromePath,
    cwd: process.cwd(),
    targetCwd: TARGET_DIR,
    tmuxTarget: TMUX_TARGET,
    script: isQuick ? undefined : ELEMENTARY_MATH_SCRIPT,
    prompts: isQuick ? ["What is two plus two?"] : undefined,
    sourceFiles: SOURCE_FILE_PATHS,
    agentDiagnose: createAgentDiagnose(),
    maxIterations,
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
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Voice QA failed:", err);
  process.exit(1);
});
