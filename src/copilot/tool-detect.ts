/**
 * Detect whether a CLI tool binary is available on PATH.
 *
 * Used by optional integrations (Rodney, Showboat) to gracefully
 * skip when the tool is not installed.
 */

import { execSync } from "node:child_process";

export type ToolInfo = {
  available: boolean;
  path?: string;
};

/**
 * Check if a CLI binary is available on PATH.
 * Returns the resolved path or `{ available: false }` if not found.
 */
export function detectTool(name: string): ToolInfo {
  try {
    const toolPath = execSync(`which ${name}`, {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return { available: true, path: toolPath };
  } catch {
    return { available: false };
  }
}
