import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type VideoProofResult = {
  ok: boolean;
  evidencePath?: string;
  videoPath?: string;
  screenshots?: string[];
  error?: string;
  exitCode?: number;
};

export type VideoProofOptions = {
  /** Working directory (repo root). */
  workspaceDir: string;
  /** Proof mode: "fast" (2+ sec, 2+ checkpoints) or "full" (8+ sec, 5+ checkpoints). */
  mode?: "fast" | "full";
  /** App URL to test (auto-detected if not set). */
  appUrl?: string;
  /** Timeout in milliseconds (default: 120000). */
  timeoutMs?: number;
};

/**
 * Capture video proof by invoking scripts/proof-run.sh.
 *
 * Returns the evidence.json path, video path, and screenshot paths on success.
 * Returns error details on failure.
 */
export async function captureVideoProof(opts: VideoProofOptions): Promise<VideoProofResult> {
  const { workspaceDir, mode = "fast", appUrl, timeoutMs = 120_000 } = opts;

  const scriptPath = path.join(workspaceDir, "scripts", "proof-run.sh");

  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...process.env,
      PATH: process.env.PATH ?? "",
    };

    if (appUrl) {
      env.APP_URL = appUrl;
    }

    const child = spawn("bash", [scriptPath, mode], {
      cwd: workspaceDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        ok: false,
        error: `Video proof timed out after ${timeoutMs}ms`,
        exitCode: -1,
      });
    }, timeoutMs);

    child.on("close", async (code) => {
      clearTimeout(timeout);

      // Parse output to find evidence path
      const evidenceMatch = stdout.match(/\[proof-run\] evidence: (.+)/);
      const evidencePath = evidenceMatch?.[1]?.trim();

      if (code !== 0) {
        resolve({
          ok: false,
          evidencePath,
          error: stderr || `proof-run.sh exited with code ${code}`,
          exitCode: code ?? -1,
        });
        return;
      }

      // Read evidence.json to get artifact paths
      if (!evidencePath) {
        resolve({
          ok: false,
          error: "proof-run.sh succeeded but no evidence path found",
          exitCode: code ?? 0,
        });
        return;
      }

      try {
        const evidenceJson = await readFile(evidencePath, "utf-8");
        const evidence = JSON.parse(evidenceJson) as {
          ok: boolean;
          artifacts?: {
            video?: string;
            screenshots?: string[];
          };
        };

        resolve({
          ok: evidence.ok,
          evidencePath,
          videoPath: evidence.artifacts?.video ?? undefined,
          screenshots: evidence.artifacts?.screenshots ?? [],
          exitCode: code ?? 0,
        });
      } catch (err) {
        resolve({
          ok: false,
          evidencePath,
          error: `Failed to read evidence.json: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: code ?? 0,
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        error: `Failed to spawn proof-run.sh: ${err.message}`,
        exitCode: -1,
      });
    });
  });
}
