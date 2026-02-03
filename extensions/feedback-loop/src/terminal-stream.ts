/**
 * Terminal streaming for the feedback loop.
 * Shows the Codex↔Claude exchange in a formatted, readable way.
 */

const BOX_TOP = "┌─";
const BOX_SIDE = "│";
const BOX_BOTTOM = "└";
const LINE = "─".repeat(60);
const DOUBLE_LINE = "═".repeat(65);

export class TerminalStreamer {
  private verbose: boolean;
  private buffer: string[] = [];
  private buffering: boolean = false;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  private write(text: string) {
    if (this.buffering) {
      this.buffer.push(text);
    } else {
      process.stderr.write(text + "\n");
    }
  }

  private flush() {
    if (this.buffer.length > 0) {
      // Print a clear separator, then all buffered lines
      process.stderr.write("\n" + DOUBLE_LINE + "\n");
      for (const line of this.buffer) {
        process.stderr.write(line + "\n");
      }
      process.stderr.write(DOUBLE_LINE + "\n\n");
      this.buffer = [];
    }
    this.buffering = false;
  }

  private status(text: string) {
    // Overwrite current line with status
    process.stderr.write(`\r\x1b[K⏳ ${text}`);
  }

  header(task: string) {
    this.write("");
    this.write(DOUBLE_LINE);
    this.write(`  FEEDBACK LOOP: ${task}`);
  }

  hotkeys() {
    this.write(`  [p]ause [m]essage [s]kip [a]pprove [r]eject`);
    this.write(DOUBLE_LINE);
    this.write("");
  }

  iteration(n: number) {
    this.write("");
    this.write(`━━━ ITERATION ${n} ━━━`);
  }

  coderStart(mode: string) {
    // Show status while waiting, buffer the actual output
    this.status(`CODEX ${mode}...`);
    this.buffering = true;
    this.buffer = [];
    this.buffer.push(`${BOX_TOP} CODEX (${mode}) ${LINE.slice(0, 45)}`);
  }

  coderEnd(summary: string) {
    const lines = summary.split("\n");
    for (const line of lines) {
      this.buffer.push(`${BOX_SIDE} ${line}`);
    }
    this.buffer.push(`${BOX_BOTTOM}${LINE}`);
    // Clear status line and flush buffer
    process.stderr.write("\r\x1b[K");
    this.flush();
  }

  reviewerStart() {
    this.status("CLAUDE reviewing...");
    this.buffering = true;
    this.buffer = [];
    this.buffer.push(`${BOX_TOP} CLAUDE (reviewing) ${LINE.slice(0, 40)}`);
  }

  reviewerCommand(command: string) {
    // Update status line while running
    this.status(`Running: ${command.slice(0, 40)}...`);
    this.buffer.push(`${BOX_SIDE} Running: ${command}`);
  }

  reviewerResult(command: string, passed: boolean, output?: string) {
    if (passed) {
      this.buffer.push(`${BOX_SIDE} ✓ PASS`);
    } else {
      this.buffer.push(`${BOX_SIDE} ✗ FAIL`);
      if (output && this.verbose) {
        const lines = output.split("\n").slice(0, 10);
        for (const line of lines) {
          this.buffer.push(`${BOX_SIDE}   ${line}`);
        }
      }
    }
  }

  browserCheck(url: string, status: "ok" | "error", message?: string) {
    if (status === "ok") {
      this.buffer.push(`${BOX_SIDE} Browser: ${url} ✓`);
    } else {
      this.buffer.push(`${BOX_SIDE} Browser: ${url} ✗ ERROR`);
      if (message) {
        this.buffer.push(`${BOX_SIDE}   ${message}`);
      }
    }
  }

  approved() {
    this.buffer.push(`${BOX_SIDE}`);
    this.buffer.push(`${BOX_SIDE} ✓ APPROVED - All checks passing`);
    this.buffer.push(`${BOX_BOTTOM}${LINE}`);
    // Clear status and flush
    process.stderr.write("\r\x1b[K");
    this.flush();
  }

  feedback(feedback: string) {
    this.buffer.push(`${BOX_SIDE}`);
    this.buffer.push(`${BOX_SIDE} ✗ FEEDBACK TO CODEX:`);
    const lines = feedback.split("\n");
    for (const line of lines) {
      this.buffer.push(`${BOX_SIDE} ${line}`);
    }
    this.buffer.push(`${BOX_BOTTOM}${LINE}`);
    // Clear status and flush
    process.stderr.write("\r\x1b[K");
    this.flush();
  }

  userMessage(message: string) {
    this.write("");
    this.write(`>>> YOU: ${message} <<<`);
    this.write("Injecting into next iteration...");
    this.write("");
  }

  pause(iteration: number, reason?: string) {
    this.write("");
    this.write(DOUBLE_LINE);
    this.write(`  PAUSED after iteration ${iteration}${reason ? ` (${reason})` : ""}`);
    this.write(DOUBLE_LINE);
    this.write("");
    this.write("What would you like to do?");
    this.write("  [c] Continue - resume the loop");
    this.write("  [m] Message  - inject guidance for next iteration");
    this.write("  [e] Edit     - open the files for manual edit");
    this.write("  [a] Approve  - force approve and end");
    this.write("  [r] Reject   - force reject and end");
    this.write("");
  }

  maxIterations(max: number) {
    this.write("");
    this.write(`⚠ MAX ITERATIONS (${max}) reached`);
    this.write("Manual intervention needed");
    this.write("");
  }

  complete(iterations: number, approved: boolean) {
    this.write(DOUBLE_LINE);
    if (approved) {
      this.write(`  COMPLETE: ${iterations} iteration(s), all checks passing`);
    } else {
      this.write(`  STOPPED: ${iterations} iteration(s), needs manual intervention`);
    }
    this.write(DOUBLE_LINE);
    this.write("");
  }

  log(message: string) {
    this.write(`[feedback-loop] ${message}`);
  }
}

/**
 * Stream a simple message to terminal
 */
export function streamToTerminal(message: string) {
  process.stderr.write(message + "\n");
}
