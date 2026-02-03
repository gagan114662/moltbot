import { spawn } from "node:child_process";

import type { FeedbackLoopCommand } from "../../../src/config/types.agent-defaults.js";
import type { CheckResult } from "./orchestrator.js";
import type { TerminalStreamer } from "./terminal-stream.js";

/**
 * Run verification commands (npm test, lint, etc.) and collect results
 */
export async function runVerificationCommands(
  commands: FeedbackLoopCommand[],
  workspaceDir: string,
  terminal: TerminalStreamer,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const cmd of commands) {
    terminal.reviewerCommand(cmd.command);

    const result = await runCommand(cmd.command, {
      cwd: workspaceDir,
      timeoutSeconds: cmd.timeoutSeconds ?? 120,
    });

    terminal.reviewerResult(cmd.command, result.passed, result.output);

    results.push({
      command: cmd.command,
      passed: result.passed,
      output: result.output,
      error: result.error,
    });

    // If a required command fails, we can still continue to collect all results
    // The orchestrator will decide what to do based on all results
  }

  return results;
}

type CommandResult = {
  passed: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
};

async function runCommand(
  command: string,
  opts: { cwd: string; timeoutSeconds: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const { cwd, timeoutSeconds } = opts;
    const timeout = timeoutSeconds * 1000;

    // Parse command into parts
    const parts = command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    let stdout = "";
    let stderr = "";
    let killed = false;

    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 5000);
    }, timeout);

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        passed: false,
        error: `Command error: ${err.message}`,
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);

      if (killed) {
        resolve({
          passed: false,
          error: `Command timed out after ${timeoutSeconds}s`,
          output: stdout + stderr,
        });
        return;
      }

      const passed = code === 0;
      const output = (stdout + stderr).trim();

      if (passed) {
        resolve({
          passed: true,
          output: output.slice(-500), // Last 500 chars for success
          exitCode: code ?? undefined,
        });
      } else {
        // For failures, try to extract the most useful error info
        const errorOutput = extractErrorSummary(output);
        resolve({
          passed: false,
          output: errorOutput,
          error: errorOutput.slice(0, 200),
          exitCode: code ?? undefined,
        });
      }
    });
  });
}

/**
 * Extract the most useful error information from command output
 */
function extractErrorSummary(output: string): string {
  const lines = output.split("\n");
  const errorLines: string[] = [];
  let inErrorBlock = false;

  for (const line of lines) {
    const lower = line.toLowerCase();

    // Start capturing on error indicators
    if (
      lower.includes("error") ||
      lower.includes("fail") ||
      lower.includes("exception") ||
      lower.includes("not found") ||
      lower.includes("cannot") ||
      line.includes("✖") ||
      line.includes("✗")
    ) {
      inErrorBlock = true;
    }

    if (inErrorBlock) {
      errorLines.push(line);
      // Capture context (up to 20 lines)
      if (errorLines.length >= 20) {
        break;
      }
    }
  }

  if (errorLines.length > 0) {
    return errorLines.join("\n");
  }

  // Fallback: return last 500 chars
  return output.slice(-500);
}
