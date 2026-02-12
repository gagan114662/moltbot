/**
 * Agent Driver — pluggable interface for sending feedback to coding agents.
 *
 * Replaces hardcoded tmux/Claude coupling in the voice QA loop.
 * Supports: TmuxClaudeDriver (legacy), CodexDriver, and ClaudeCodeDriver (fresh context).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectClaudeState,
  pollForClaudeState,
  tmuxCaptureScrollback,
  tmuxSendKeys,
} from "./tmux-send.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentWaitResult = {
  timedOut: boolean;
  state: "idle" | "plan-mode" | "working";
  planContent?: string;
};

export interface AgentDriver {
  /** Human-readable name (e.g. "codex", "claude-tmux") */
  readonly name: string;

  /**
   * Send feedback/nudge to the agent.
   * @param nudge — conversational feedback text
   * @param feedbackFilePath — optional path to QA-FEEDBACK.md for context
   */
  sendFeedback(nudge: string, feedbackFilePath?: string): Promise<void>;

  /**
   * Wait for the agent to finish working (go idle or time out).
   * @param timeoutMs — max wait time before giving up
   */
  waitForCompletion(timeoutMs: number): Promise<AgentWaitResult>;

  /** Capture the agent's last output/scrollback (for observation). */
  captureOutput(): string | null;

  /**
   * Set system prompt context for the next sendFeedback call.
   * Used for iteration briefings, materialized context, etc.
   * Optional — drivers that don't support it simply ignore this call.
   */
  setSystemPromptContext?(briefing: string): void;
}

// ---------------------------------------------------------------------------
// TmuxClaudeDriver — legacy path (sends keystrokes to Claude Code in tmux)
// ---------------------------------------------------------------------------

export class TmuxClaudeDriver implements AgentDriver {
  readonly name = "claude-tmux";
  private target: string;

  constructor(tmuxTarget: string) {
    this.target = tmuxTarget;
  }

  async sendFeedback(nudge: string): Promise<void> {
    const sent = tmuxSendKeys(this.target, nudge);
    if (!sent) {
      throw new Error(`Failed to send to tmux target: ${this.target}`);
    }
  }

  async waitForCompletion(timeoutMs: number): Promise<AgentWaitResult> {
    const result = await pollForClaudeState(this.target, {
      timeoutMs,
    });
    return {
      timedOut: result.timedOut ?? false,
      state: result.state,
      planContent: result.state === "plan-mode" ? result.planContent : undefined,
    };
  }

  captureOutput(): string | null {
    return tmuxCaptureScrollback(this.target);
  }

  /** Detect Claude's current state without waiting. */
  detectState(): ReturnType<typeof detectClaudeState> {
    return detectClaudeState(this.target);
  }
}

// ---------------------------------------------------------------------------
// CodexDriver — spawns OpenAI Codex CLI to fix code
// ---------------------------------------------------------------------------

export type CodexDriverOptions = {
  /** Working directory for Codex (the project to fix). */
  targetCwd: string;
  /** Codex model to use (default: from ~/.codex/config.toml). */
  model?: string;
  /** Sandbox level: "read-only" | "workspace-write" | "danger-full-access". Default: full-auto. */
  sandbox?: string;
};

export class CodexDriver implements AgentDriver {
  readonly name = "codex";
  private targetCwd: string;
  private model?: string;
  private sandbox?: string;
  private lastOutput: string | null = null;
  private outputFile: string;
  private appendSystemPrompt: string | null = null;

  constructor(opts: CodexDriverOptions) {
    this.targetCwd = opts.targetCwd;
    this.model = opts.model;
    this.sandbox = opts.sandbox;
    this.outputFile = path.join(os.tmpdir(), `codex-qa-${Date.now()}.txt`);
  }

  setSystemPromptContext(briefing: string): void {
    this.appendSystemPrompt = briefing;
  }

  async sendFeedback(nudge: string, feedbackFilePath?: string): Promise<void> {
    // Build prompt: briefing + nudge text + optional reference to QA-FEEDBACK.md
    let prompt = this.appendSystemPrompt ? `${this.appendSystemPrompt}\n\n---\n\n${nudge}` : nudge;
    if (feedbackFilePath && fs.existsSync(feedbackFilePath)) {
      prompt += `\n\nDetailed findings are in ${feedbackFilePath} — read it for full context.`;
    }
    prompt += "\n\nFix all issues listed above. When done, ensure the code compiles and works.";

    // Build args
    const args = ["exec", "--full-auto"];
    if (this.model) {
      args.push("-m", this.model);
    }
    args.push("-C", this.targetCwd);
    args.push("-o", this.outputFile);
    args.push(prompt);

    // Spawn Codex and wait
    return new Promise<void>((resolve, reject) => {
      const proc = spawn("codex", args, {
        cwd: this.targetCwd,
        stdio: ["pipe", "inherit", "inherit"],
        env: { ...process.env },
      });

      proc.on("close", (code) => {
        // Read output if it exists
        try {
          if (fs.existsSync(this.outputFile)) {
            this.lastOutput = fs.readFileSync(this.outputFile, "utf-8");
          }
        } catch {
          // Ignore read errors
        }

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Codex exited with code ${code}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn codex: ${err.message}`));
      });
    });
  }

  async waitForCompletion(_timeoutMs: number): Promise<AgentWaitResult> {
    // Codex exec blocks until done — sendFeedback already waits.
    // This is a no-op for Codex since sendFeedback is synchronous.
    // But we respect the timeout by wrapping in a race.
    //
    // In practice, sendFeedback already completed by the time this is called.
    // Return idle immediately.
    return { timedOut: false, state: "idle" };
  }

  captureOutput(): string | null {
    return this.lastOutput;
  }

  /** Clean up temp files. */
  cleanup(): void {
    try {
      if (fs.existsSync(this.outputFile)) {
        fs.unlinkSync(this.outputFile);
      }
    } catch {
      // Ignore
    }
  }
}

// ---------------------------------------------------------------------------
// ClaudeCodeDriver — fresh context per iteration (spawns claude --print)
// ---------------------------------------------------------------------------

export type ClaudeCodeDriverOptions = {
  /** Working directory for Claude Code (the project to fix). */
  targetCwd: string;
  /** Claude model to use (default: "sonnet"). */
  model?: string;
  /** Max budget in USD per invocation (default: 2.00). */
  maxBudgetUsd?: number;
};

export class ClaudeCodeDriver implements AgentDriver {
  readonly name = "claude-code";
  private targetCwd: string;
  private model: string;
  private maxBudgetUsd: number;
  private lastOutput: string | null = null;
  private appendSystemPrompt: string | null = null;

  constructor(opts: ClaudeCodeDriverOptions) {
    this.targetCwd = opts.targetCwd;
    this.model = opts.model ?? "sonnet";
    this.maxBudgetUsd = opts.maxBudgetUsd ?? 2.0;
  }

  /**
   * Set the system prompt context for the next sendFeedback call.
   * This is the iteration briefing — called by the loop before each iteration.
   */
  setSystemPromptContext(briefing: string): void {
    this.appendSystemPrompt = briefing;
  }

  async sendFeedback(nudge: string, feedbackFilePath?: string): Promise<void> {
    // Build prompt from nudge + feedbackFile reference
    let prompt = nudge;
    if (feedbackFilePath && fs.existsSync(feedbackFilePath)) {
      prompt += `\n\nDetailed findings are in ${feedbackFilePath} — read it for full context.`;
    }
    prompt += "\n\nFix all issues listed above. When done, ensure the code compiles and works.";

    // Build args for claude --print (one-shot, non-interactive)
    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "--model",
      this.model,
      "--max-turns",
      "30",
    ];

    if (this.appendSystemPrompt) {
      args.push("--append-system-prompt", this.appendSystemPrompt);
    }

    args.push(prompt);

    // Spawn claude CLI as subprocess — blocks until completion
    return new Promise<void>((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      const proc = spawn("claude", args, {
        cwd: this.targetCwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        this.lastOutput = stdout || stderr || null;

        if (code === 0) {
          resolve();
        } else {
          // Non-zero exit is not necessarily fatal — Claude may have
          // hit budget limit or max turns. Resolve anyway so the loop
          // can observe what changes were made.
          resolve();
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });
    });
  }

  async waitForCompletion(_timeoutMs: number): Promise<AgentWaitResult> {
    // sendFeedback blocks until claude exits — no-op like CodexDriver.
    return { timedOut: false, state: "idle" };
  }

  captureOutput(): string | null {
    return this.lastOutput;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an AgentDriver from params.
 * - If `claudeCodeTargetCwd` is provided → ClaudeCodeDriver (fresh context)
 * - If `codexTargetCwd` is provided → CodexDriver
 * - If `tmuxTarget` is provided → TmuxClaudeDriver
 * - Otherwise → TmuxClaudeDriver with default target
 */
export function createAgentDriver(opts: {
  claudeCodeTargetCwd?: string;
  claudeCodeModel?: string;
  claudeCodeMaxBudget?: number;
  codexTargetCwd?: string;
  codexModel?: string;
  tmuxTarget?: string;
}): AgentDriver {
  if (opts.claudeCodeTargetCwd) {
    return new ClaudeCodeDriver({
      targetCwd: opts.claudeCodeTargetCwd,
      model: opts.claudeCodeModel,
      maxBudgetUsd: opts.claudeCodeMaxBudget,
    });
  }
  if (opts.codexTargetCwd) {
    return new CodexDriver({ targetCwd: opts.codexTargetCwd, model: opts.codexModel });
  }
  return new TmuxClaudeDriver(opts.tmuxTarget ?? "scratchpad:0.0");
}
