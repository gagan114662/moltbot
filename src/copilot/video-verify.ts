/**
 * Video verification stage for the copilot pipeline.
 *
 * Wraps the existing scripts/proof-run.sh infrastructure.
 * Only runs on git commits by default (not on every file save).
 * Auto-detects running dev server via port scan.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { StageResult, VideoResult } from "./types.js";
import { truncateError } from "./feedback.js";

/** Common dev server ports to scan */
const DEV_PORTS = [3000, 3001, 5173, 5174, 4200, 8080, 8000];

type ProofReport = {
  ok: boolean;
  videoPath?: string;
  screenshots?: string[];
};

/** Check if a TCP port is listening on localhost */
async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

/** Auto-detect a running dev server by scanning common ports */
export async function detectDevServer(): Promise<string | null> {
  for (const port of DEV_PORTS) {
    if (await isPortOpen(port)) {
      return `http://localhost:${port}`;
    }
  }
  return null;
}

/** Run proof-run.sh and parse its output */
export async function runVideoVerification(opts: {
  cwd: string;
  signal: AbortSignal;
  appUrl?: string;
}): Promise<{ result: StageResult; video?: VideoResult }> {
  const start = Date.now();

  // Detect or use provided app URL
  const appUrl = opts.appUrl ?? (await detectDevServer());
  if (!appUrl) {
    return {
      result: {
        stage: "video",
        passed: true,
        durationMs: Date.now() - start,
        error: "No dev server detected (skipped)",
      },
    };
  }

  const proofScript = path.join(opts.cwd, "scripts", "proof-run.sh");
  if (!fs.existsSync(proofScript)) {
    return {
      result: {
        stage: "video",
        passed: true,
        durationMs: Date.now() - start,
        error: "proof-run.sh not found (skipped)",
      },
    };
  }

  try {
    const { code, output, evidencePath } = await runProofScript(proofScript, {
      cwd: opts.cwd,
      signal: opts.signal,
      appUrl,
    });

    if (code !== 0) {
      return {
        result: {
          stage: "video",
          passed: false,
          durationMs: Date.now() - start,
          error: truncateError(output),
        },
      };
    }

    // Parse evidence file if it exists
    const video = parseEvidence(evidencePath, opts.cwd);

    return {
      result: {
        stage: "video",
        passed: true,
        durationMs: Date.now() - start,
      },
      video,
    };
  } catch (err) {
    if (opts.signal.aborted) {
      return {
        result: {
          stage: "video",
          passed: false,
          durationMs: Date.now() - start,
          error: "Cancelled",
        },
      };
    }
    return {
      result: {
        stage: "video",
        passed: false,
        durationMs: Date.now() - start,
        error: truncateError(String(err)),
      },
    };
  }
}

async function runProofScript(
  scriptPath: string,
  opts: { cwd: string; signal: AbortSignal; appUrl: string },
): Promise<{ code: number; output: string; evidencePath: string }> {
  const evidenceDir = path.join(opts.cwd, ".moltbot", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });

  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const child = spawn("bash", [scriptPath, "fast"], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        APP_URL: opts.appUrl,
        EVIDENCE_DIR: evidenceDir,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    });

    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, 120_000);

    const onAbort = () => {
      child.kill("SIGTERM");
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      opts.signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      opts.signal.removeEventListener("abort", onAbort);
      resolve({
        code: code ?? 1,
        output,
        evidencePath: path.join(evidenceDir, "evidence.json"),
      });
    });
  });
}

function parseEvidence(evidencePath: string, cwd: string): VideoResult | undefined {
  try {
    if (!fs.existsSync(evidencePath)) {
      return undefined;
    }
    const raw = fs.readFileSync(evidencePath, "utf-8");
    const data = JSON.parse(raw) as ProofReport;
    return {
      path: data.videoPath ?? "",
      screenshots: data.screenshots ?? [],
      reportPath: path.relative(cwd, evidencePath),
    };
  } catch {
    return undefined;
  }
}
