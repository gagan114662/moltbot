/**
 * Pipeline orchestrator for the copilot daemon.
 *
 * Connects watcher events → verification stages → feedback file.
 * Handles cancellation: new file changes cancel the running pipeline
 * and start a fresh one with the merged changeset.
 *
 * Stage execution order:
 *   [lint + typecheck] in parallel → tests → build (commit-only) → video (commit-only)
 */

import { execSync } from "node:child_process";
import type {
  CopilotConfig,
  CopilotFeedback,
  PipelineEvent,
  StageResult,
  WatcherEvent,
} from "./types.js";
import { buildSummary, writeFeedback } from "./feedback.js";
import { runLintStage, runTypecheckStage, runTestStage, runBuildStage } from "./stages.js";
import { runVideoVerification } from "./video-verify.js";

export type PipelineOptions = {
  config: CopilotConfig;
  onEvent: (event: PipelineEvent) => void;
};

export type Pipeline = {
  /** Handle a watcher event (queues or triggers a pipeline run) */
  handleEvent(event: WatcherEvent): void;
  /** Stop the pipeline and cancel any running checks */
  stop(): void;
};

export function createPipeline(opts: PipelineOptions): Pipeline {
  let currentAbort: AbortController | null = null;
  let running = false;
  let pendingFiles = new Set<string>();
  let pendingCommitRef: string | null = null;

  function getGitRef(): string {
    try {
      return execSync("git rev-parse --short HEAD", {
        cwd: opts.config.cwd,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch {
      return "unknown";
    }
  }

  async function runPipeline(triggerFiles: string[], isCommit: boolean) {
    if (running) {
      // Cancel current pipeline — new changes take priority
      currentAbort?.abort();
    }

    running = true;
    const abort = new AbortController();
    currentAbort = abort;
    const startTime = Date.now();

    opts.onEvent({ type: "start", triggerFiles, isCommit });

    const ctx = {
      changedFiles: triggerFiles,
      cwd: opts.config.cwd,
      signal: abort.signal,
    };

    const checks: StageResult[] = [];

    try {
      // Stage 1+2: Lint and typecheck in parallel
      opts.onEvent({ type: "stage-start", stage: "lint + typecheck" });

      const [lintResult, typecheckResult] = await Promise.all([
        runLintStage(ctx),
        runTypecheckStage(ctx),
      ]);

      if (abort.signal.aborted) {
        opts.onEvent({ type: "cancelled" });
        running = false;
        drainPending();
        return;
      }

      checks.push(lintResult, typecheckResult);
      opts.onEvent({ type: "stage-done", result: lintResult });
      opts.onEvent({ type: "stage-done", result: typecheckResult });

      // Stage 3: Tests (only if not skipped)
      if (!opts.config.noTests) {
        opts.onEvent({ type: "stage-start", stage: "test" });
        const testResult = await runTestStage(ctx);

        if (abort.signal.aborted) {
          opts.onEvent({ type: "cancelled" });
          running = false;
          drainPending();
          return;
        }

        checks.push(testResult);
        opts.onEvent({ type: "stage-done", result: testResult });
      }

      // Stage 4: Build (commit-only or --full)
      if (isCommit || opts.config.full) {
        opts.onEvent({ type: "stage-start", stage: "build" });
        const buildResult = await runBuildStage(ctx);

        if (abort.signal.aborted) {
          opts.onEvent({ type: "cancelled" });
          running = false;
          drainPending();
          return;
        }

        checks.push(buildResult);
        opts.onEvent({ type: "stage-done", result: buildResult });
      }

      // Stage 5: Video verification (commit-only or --full, and not disabled)
      let videoData;
      if (!opts.config.noVideo && (isCommit || opts.config.full)) {
        opts.onEvent({ type: "stage-start", stage: "video" });
        const { result: videoResult, video } = await runVideoVerification({
          cwd: opts.config.cwd,
          signal: abort.signal,
          appUrl: opts.config.appUrl,
        });

        if (abort.signal.aborted) {
          opts.onEvent({ type: "cancelled" });
          running = false;
          drainPending();
          return;
        }

        checks.push(videoResult);
        videoData = video;
        opts.onEvent({ type: "stage-done", result: videoResult });
      }

      // Build and write feedback
      const durationMs = Date.now() - startTime;
      const ok = checks.every((c) => c.passed);

      const feedback: CopilotFeedback = {
        timestamp: new Date().toISOString(),
        ok,
        durationMs,
        gitRef: getGitRef(),
        triggerFiles,
        checks,
        video: videoData,
        summary: buildSummary(checks, durationMs),
      };

      await writeFeedback(opts.config.cwd, feedback);
      opts.onEvent({ type: "done", feedback });
    } catch (err) {
      if (abort.signal.aborted) {
        opts.onEvent({ type: "cancelled" });
      } else {
        opts.onEvent({ type: "error", error: String(err) });
      }
    } finally {
      running = false;
      if (currentAbort === abort) {
        currentAbort = null;
      }
      drainPending();
    }
  }

  /** If changes accumulated while a pipeline was running, start a new one */
  function drainPending() {
    if (pendingFiles.size === 0 && !pendingCommitRef) {
      return;
    }

    const files = Array.from(pendingFiles);
    const isCommit = pendingCommitRef !== null;
    pendingFiles = new Set();
    pendingCommitRef = null;

    // Small delay to batch any rapid-fire events
    setTimeout(() => {
      void runPipeline(files, isCommit);
    }, 100);
  }

  return {
    handleEvent(event: WatcherEvent) {
      if (event.type === "files-changed") {
        if (running) {
          // Accumulate files and cancel current pipeline
          for (const f of event.files) {
            pendingFiles.add(f);
          }
          currentAbort?.abort();
        } else {
          void runPipeline(event.files, false);
        }
      } else if (event.type === "commit") {
        if (running) {
          pendingCommitRef = event.ref;
          currentAbort?.abort();
        } else {
          void runPipeline([], true);
        }
      }
    },

    stop() {
      currentAbort?.abort();
      pendingFiles.clear();
      pendingCommitRef = null;
    },
  };
}
