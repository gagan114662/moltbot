#!/usr/bin/env tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CopilotFeedback } from "../src/copilot/types.js";
import type { EnrichedVoiceQaResult } from "../src/copilot/voice-qa-diagnosis.js";
import type { MultiTurnResult } from "../src/copilot/voice-qa.js";
import { resolveChromePath } from "../src/copilot/browser-inspect.js";
import { writeFeedbackToTarget } from "../src/copilot/feedback.js";
import {
  buildLlmDiagnosisPrompt,
  diagnose,
  enrichWsEventsFromConsole,
  formatDiagnosisReport,
  mergeDiagnoses,
  parseLlmDiagnosis,
} from "../src/copilot/voice-qa-diagnosis.js";
import {
  ELEMENTARY_MATH_SCRIPT,
  formatMultiTurnReport,
  formatVoiceReport,
  runMultiTurnVoiceQa,
  runVoiceQa,
} from "../src/copilot/voice-qa.js";

/**
 * Create an LLM diagnosis function using OpenRouter REST API.
 * Uses kimi-k2.5 for code-aware diagnosis.
 * Set OPENROUTER_API_KEY env var before running.
 */
function createAgentDiagnose(): ((prompt: string) => Promise<string>) | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("OPENROUTER_API_KEY not set — LLM diagnosis will be skipped");
    return null;
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

// Key source files that the LLM should review for specific fixes
const TARGET_DIR = "/Users/gaganarora/Desktop/sctrachpad/frontend";
const SOURCE_FILE_PATHS = [
  "src/hooks/useScratchpadAI.ts",
  "src/features/tutor/tutor-service.ts",
  "src/hooks/canvas-renderer.ts",
  "src/components/ScratchpadCanvas.tsx",
  "src/App.tsx",
];

/** Read numbered source files for LLM to reference specific lines. */
function readSourceFiles(): Array<{ path: string; content: string }> {
  const sourceFiles: Array<{ path: string; content: string }> = [];
  for (const relPath of SOURCE_FILE_PATHS) {
    try {
      const content = fs.readFileSync(path.join(TARGET_DIR, relPath), "utf-8");
      const numbered = content
        .split("\n")
        .map((line, idx) => `${idx + 1}: ${line}`)
        .join("\n");
      sourceFiles.push({ path: relPath, content: numbered });
    } catch {
      // File not found — skip
    }
  }
  return sourceFiles;
}

/** Run LLM diagnosis on failures. Returns merged diagnoses. */
async function runDiagnosis(
  enriched: EnrichedVoiceQaResult[],
  sourceFiles: Array<{ path: string; content: string }>,
) {
  const staticDiagnoses = diagnose(enriched);
  let diagnoses = staticDiagnoses;

  console.log("\nRunning LLM-powered diagnosis via OpenRouter...");
  try {
    const agentDiagnose = createAgentDiagnose();
    if (agentDiagnose) {
      console.log(`Including ${sourceFiles.length} source files for code-aware diagnosis`);
      const prompt = buildLlmDiagnosisPrompt(enriched, staticDiagnoses, sourceFiles);
      const llmResponse = await agentDiagnose(prompt);
      const llmDiagnoses = parseLlmDiagnosis(llmResponse);
      if (llmDiagnoses.length > 0) {
        diagnoses = mergeDiagnoses(staticDiagnoses, llmDiagnoses);
        console.log(`LLM found ${llmDiagnoses.length} additional insight(s)`);
      } else {
        console.log("LLM confirmed static diagnoses (no additional insights)");
      }
    } else {
      console.log("Skipping LLM diagnosis (no OPENROUTER_API_KEY)");
    }
  } catch (err: unknown) {
    console.warn(`LLM diagnosis failed (non-fatal): ${String(err)}`);
  }

  return diagnoses;
}

/** Convert MultiTurnResult turns to EnrichedVoiceQaResult[] for diagnosis engine. */
function multiTurnToEnriched(result: MultiTurnResult): EnrichedVoiceQaResult[] {
  return result.turns.map((t) => ({
    prompt: t.prompt,
    passed: t.passed,
    error: t.failReasons.join("; ") || undefined,
    tutorResponse: t.tutorResponse ?? undefined,
    consoleErrors: t.consoleErrors,
    consoleLogs: t.consoleLogs,
    screenshotPath: t.screenshotPath,
    wsEvents: enrichWsEventsFromConsole(result.wsEvents, result.overallConsoleLogs),
    toolCalls: t.toolCalls,
    visualAssessment: t.visualAssessment,
  }));
}

/** Build enriched results + checks from single-prompt or multi-turn mode. */
function buildChecks(enriched: EnrichedVoiceQaResult[]) {
  return enriched.map((r) => ({
    stage: "voice-qa" as const,
    passed: r.passed,
    durationMs: 0,
    error: r.passed ? undefined : (r.error ?? "Unknown failure"),
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const isQuick = process.argv.includes("--quick");
  const mode = isQuick ? "quick (single-prompt)" : "multi-turn session";

  const chromePath = resolveChromePath();
  if (!chromePath) {
    console.error("Chrome not found");
    process.exit(1);
  }
  console.log(`Chrome: ${chromePath}`);
  console.log(`Mode: ${mode}`);

  const evidenceDir = path.join(os.tmpdir(), `voice-qa-evidence-${Date.now()}`);
  fs.mkdirSync(evidenceDir, { recursive: true });

  let passed: boolean;
  let report: string;
  let enriched: EnrichedVoiceQaResult[];

  if (isQuick) {
    // Single-prompt smoke test (legacy mode)
    const results = await runVoiceQa({
      appUrl: "http://localhost:3000/app",
      prompts: ["What is two plus two?"],
      chromePath,
      evidenceDir,
      timeoutMs: 30_000,
    });

    report = formatVoiceReport(results);
    passed = results.every((r) => r.passed);
    enriched = results.map((r) => ({
      ...r,
      wsEvents: enrichWsEventsFromConsole(r.wsEvents ?? [], r.consoleLogs),
    }));
  } else {
    // Multi-turn session (default — 4 turns, ~2 min)
    console.log(`\nRunning ${ELEMENTARY_MATH_SCRIPT.turns.length}-turn student session...`);
    console.log(`Script: ${ELEMENTARY_MATH_SCRIPT.description}`);
    for (const [i, turn] of ELEMENTARY_MATH_SCRIPT.turns.entries()) {
      console.log(`  Turn ${i + 1}: "${turn.prompt}" (wait ${turn.waitSec}s)`);
    }

    const result = await runMultiTurnVoiceQa({
      appUrl: "http://localhost:3000/app",
      script: ELEMENTARY_MATH_SCRIPT,
      chromePath,
      evidenceDir,
      sessionTimeoutMs: 180_000, // 3 min max
    });

    report = formatMultiTurnReport(result);
    passed = result.allPassed;
    enriched = multiTurnToEnriched(result);
  }

  console.log("\n" + report);

  // Run diagnosis on failures
  let diagnosisReport = "";
  if (!passed) {
    const sourceFiles = readSourceFiles();
    const diagnoses = await runDiagnosis(enriched, sourceFiles);
    diagnosisReport = diagnoses.length > 0 ? formatDiagnosisReport(diagnoses) : "";
  }

  // Build CopilotFeedback and use writeFeedbackToTarget (atomic, cross-workspace)
  const diagnosisSection =
    !passed && diagnosisReport ? `\n\n---\n\n# Diagnosis\n\n${diagnosisReport}` : "";
  const feedback: CopilotFeedback = {
    timestamp: new Date().toISOString(),
    ok: passed,
    durationMs: 0,
    gitRef: "voice-qa",
    triggerFiles: [],
    checks: buildChecks(enriched),
    summary: report + diagnosisSection,
  };

  const moltbotCwd = process.cwd();
  await writeFeedbackToTarget(moltbotCwd, TARGET_DIR, feedback, "scratchpad:0.0");
  console.log("\nFeedback written to scratchpad via writeFeedbackToTarget.");

  if (!passed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Voice QA failed:", err);
  process.exit(1);
});
