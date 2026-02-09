/**
 * CLI registration for the copilot daemon.
 *
 * Commands:
 *   openclaw copilot start [options]  — Start the copilot (foreground)
 *   openclaw copilot stop             — Stop a running copilot
 *   openclaw copilot status           — Check if copilot is running
 *   openclaw copilot work <task>      — Run autonomous coding task
 */

import type { Command } from "commander";
import path from "node:path";
import type { CopilotConfig } from "../copilot/types.js";
import type { WorkerConfig } from "../copilot/worker-types.js";
import { getCopilotStatus, startCopilot, stopCopilot } from "../copilot/copilot.js";
import { readFeedback } from "../copilot/feedback.js";
import { bootstrapQaHooks } from "../copilot/qa-bootstrap.js";
import { runWorker } from "../copilot/worker.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";

export function registerCopilotCli(program: Command): void {
  const copilot = program
    .command("copilot")
    .description(
      "Code verification copilot — watches changes, runs checks, feeds back to Claude Code",
    );

  copilot
    .command("start")
    .description("Start the copilot daemon (foreground)")
    .option("--debounce <ms>", "Debounce settle time in ms", "1500")
    .option("--no-notify", "Disable macOS desktop notifications")
    .option("--no-tests", "Skip test stage")
    .option("--no-video", "Skip video verification")
    .option("--app-url <url>", "URL to verify (default: auto-detect)")
    .option("--full", "Run build + video on every change", false)
    .action(async (opts) => {
      const cwd = process.cwd();

      const config: CopilotConfig = {
        debounceMs: Number.parseInt(opts.debounce, 10) || 1500,
        noNotify: !opts.notify,
        noTests: !opts.tests,
        noVideo: !opts.video,
        full: opts.full,
        appUrl: opts.appUrl,
        cwd,
      };

      try {
        await startCopilot(config);
      } catch (err) {
        defaultRuntime.error(
          `${theme.error("Error:")} ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });

  copilot
    .command("stop")
    .description("Stop the running copilot")
    .action(() => {
      const cwd = process.cwd();
      const stopped = stopCopilot(cwd);

      if (stopped) {
        defaultRuntime.log(theme.success("Copilot stopped."));
      } else {
        defaultRuntime.log(theme.muted("No copilot running."));
      }
    });

  copilot
    .command("status")
    .description("Check copilot status")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      const cwd = process.cwd();
      const status = getCopilotStatus(cwd);
      const feedback = await readFeedback(cwd);

      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ ...status, lastFeedback: feedback }, null, 2));
        return;
      }

      if (status.running) {
        defaultRuntime.log(`${theme.success("Copilot is running")} (PID ${status.pid})`);
      } else {
        defaultRuntime.log(theme.muted("Copilot is not running"));
      }

      if (feedback) {
        const age = Math.round((Date.now() - new Date(feedback.timestamp).getTime()) / 1000);
        const stale = age > 300 ? theme.warn(" (stale)") : "";
        const statusIcon = feedback.ok ? theme.success("PASS") : theme.error("FAIL");
        defaultRuntime.log(`\n  Last check: ${statusIcon} (${age}s ago${stale})`);
        defaultRuntime.log(`  ${feedback.summary}`);
      }
    });

  copilot
    .command("work")
    .description("Run an autonomous coding task with verification loop")
    .argument("<task>", "Description of the task to complete")
    .option("--max-iterations <n>", "Maximum fix iterations", "5")
    .option("--stall-limit <n>", "Consecutive stalls before aborting", "3")
    .option("--agent <id>", "Agent ID to use")
    .option("--thinking <level>", "Thinking level (low|medium|high)")
    .option("--timeout <seconds>", "Timeout per agent turn", "300")
    .option("--local", "Force embedded agent (skip gateway)", false)
    .option("--no-tests", "Skip test stage")
    .option("--no-video", "Skip video verification on success")
    .option("--no-browser", "Skip browser QA inspection")
    .option("--no-coverage", "Skip coverage-diff stage")
    .option("--no-screenshot-diff", "Skip screenshot-diff stage")
    .option("--no-review", "Skip review-agent stage")
    .option("--no-spec-tests", "Skip spec-test TDD stage")
    .option("--no-ux-eval", "Skip deep UX evaluation stage")
    .option("--ux-eval-steps <n>", "Max interaction steps for UX eval", "10")
    .option("--ux-eval-sample <n>", "Sample size for matrix testing", "5")
    .option("--app-url <url>", "URL for video/browser verification")
    .option("--target <path>", "Target project workspace for cross-project feedback")
    .option("--no-hooks", "Skip installing QA hooks in target project")
    .option("--headed", "Run browser checks visibly (non-headless)", false)
    .option("--json", "Output JSONL events instead of dashboard", false)
    .action(async (task, opts) => {
      const cwd = process.cwd();

      const targetWorkspace = opts.target ? path.resolve(opts.target) : undefined;
      const noBootstrapHooks = !opts.hooks;

      // Bootstrap QA hooks in target workspace (idempotent)
      if (targetWorkspace && !noBootstrapHooks) {
        await bootstrapQaHooks(targetWorkspace);
      }

      const config: WorkerConfig = {
        task,
        cwd,
        maxIterations: Number.parseInt(opts.maxIterations, 10) || 5,
        stallLimit: Number.parseInt(opts.stallLimit, 10) || 3,
        noTests: !opts.tests,
        noVideo: !opts.video,
        noBrowser: !opts.browser,
        noCoverage: !opts.coverage,
        noScreenshotDiff: !opts.screenshotDiff,
        noReview: !opts.review,
        noSpecTests: !opts.specTests,
        noUxEval: !opts.uxEval,
        uxEvalSteps: Number.parseInt(opts.uxEvalSteps, 10) || 10,
        uxEvalSample: Number.parseInt(opts.uxEvalSample, 10) || 5,
        appUrl: opts.appUrl,
        agentId: opts.agent,
        thinking: opts.thinking,
        turnTimeoutSeconds: Number.parseInt(opts.timeout, 10) || 300,
        local: opts.local,
        json: opts.json,
        targetWorkspace,
        noBootstrapHooks,
        headed: opts.headed,
      };

      try {
        const result = await runWorker(config);

        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } else if (result.ok) {
          defaultRuntime.log(
            theme.success(
              `\nDone: all checks passed after ${result.iterations.length} iteration(s)`,
            ),
          );
        } else {
          defaultRuntime.log(
            theme.error(
              `\nFailed after ${result.iterations.length} iteration(s): ${result.stopReason}`,
            ),
          );
        }

        process.exit(result.ok ? 0 : 1);
      } catch (err) {
        defaultRuntime.error(
          `${theme.error("Error:")} ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });

  // Default action (no subcommand) shows status
  copilot.action(async () => {
    const cwd = process.cwd();
    const status = getCopilotStatus(cwd);

    if (status.running) {
      defaultRuntime.log(`${theme.success("Copilot is running")} (PID ${status.pid})`);
    } else {
      defaultRuntime.log(theme.muted("Copilot is not running."));
      defaultRuntime.log(`Run ${theme.command("openclaw copilot start")} to start.`);
    }
  });
}
