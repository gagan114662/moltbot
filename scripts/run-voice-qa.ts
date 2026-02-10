#!/usr/bin/env tsx
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveChromePath } from "../src/copilot/browser-inspect.js";
import { runVoiceQa, formatVoiceReport } from "../src/copilot/voice-qa.js";

async function main() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    console.error("Chrome not found");
    process.exit(1);
  }
  console.log("Chrome:", chromePath);

  const evidenceDir = path.join(os.tmpdir(), `voice-qa-evidence-${Date.now()}`);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const results = await runVoiceQa({
    appUrl: "http://localhost:3000/app",
    prompts: ["What is two plus two?"],
    chromePath,
    evidenceDir,
    timeoutMs: 30_000,
  });

  const report = formatVoiceReport(results);
  console.log("\n" + report);

  const targetDir = "/Users/gaganarora/Desktop/sctrachpad/frontend";
  const feedbackDir = path.join(targetDir, ".moltbot");
  fs.mkdirSync(feedbackDir, { recursive: true });

  const passed = results.every((r) => r.passed);
  const summary = passed
    ? "Voice QA passed - tutor responded correctly"
    : `Voice QA found issues: ${results
        .filter((r) => !r.passed)
        .map((r) => r.error || "no tutor response")
        .join(", ")}`;

  fs.writeFileSync(
    path.join(feedbackDir, "copilot-feedback.json"),
    JSON.stringify(
      {
        ok: passed,
        summary,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(targetDir, "QA-FEEDBACK.md"),
    [
      "# Voice QA Results",
      "",
      `**Status:** ${passed ? "PASSED" : "FAILED"}`,
      `**Time:** ${new Date().toISOString()}`,
      "",
      report,
      "",
      "## Action Required",
      passed
        ? "No issues found. Continue with current work."
        : "Fix the issues above. The voice tutor session should start and respond when spoken to.",
    ].join("\n"),
  );

  console.log("\nFeedback written to scratchpad.");

  try {
    execSync(
      'tmux send-keys -t scratchpad:0.0 "Voice QA results are in QA-FEEDBACK.md -- please read and act on them" Enter',
      { timeout: 5_000 },
    );
    console.log("Tmux nudge sent to scratchpad:0.0");
  } catch (e: unknown) {
    console.error("Tmux nudge failed:", (e as Error).message);
  }
}

main().catch((err) => {
  console.error("Voice QA failed:", err);
  process.exit(1);
});
