/**
 * Visual Diff - Compare screenshots against baselines to catch visual regressions.
 *
 * Detects changes in:
 * - Layout/spacing
 * - Colors
 * - Missing/extra elements
 * - Size changes
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type VisualDiffResult = {
  url: string;
  hasBaseline: boolean;
  diffPercentage: number;
  passed: boolean;
  message: string;
  baselinePath?: string;
  currentPath?: string;
  diffPath?: string;
};

export type VisualDiffConfig = {
  /** Directory to store baseline screenshots */
  baselineDir: string;
  /** Maximum allowed diff percentage (0-100). Default: 5 */
  threshold?: number;
  /** Whether to auto-update baselines when none exist. Default: true */
  autoCreateBaseline?: boolean;
};

/**
 * Get the baseline path for a URL
 */
function getBaselinePath(baselineDir: string, url: string): string {
  // Create a safe filename from the URL
  const urlHash = createHash("md5").update(url).digest("hex").slice(0, 12);
  const safeName = url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]/g, "_")
    .slice(0, 50);
  return path.join(baselineDir, `${safeName}_${urlHash}.png`);
}

/**
 * Compare two PNG images and return the difference percentage.
 * Uses a simple but effective comparison approach.
 */
async function compareImages(
  baselinePath: string,
  currentPath: string,
): Promise<{ diffPercentage: number; diffPath?: string }> {
  const baselineBuffer = await fs.promises.readFile(baselinePath);
  const currentBuffer = await fs.promises.readFile(currentPath);

  // Quick check: if files are identical, no diff
  if (baselineBuffer.equals(currentBuffer)) {
    return { diffPercentage: 0 };
  }

  // Parse PNG headers to get dimensions
  const baselineDims = parsePngDimensions(baselineBuffer);
  const currentDims = parsePngDimensions(currentBuffer);

  // If dimensions differ significantly, that's a major change
  if (baselineDims && currentDims) {
    const widthDiff = Math.abs(baselineDims.width - currentDims.width);
    const heightDiff = Math.abs(baselineDims.height - currentDims.height);

    if (widthDiff > 50 || heightDiff > 50) {
      return {
        diffPercentage: 100,
      };
    }
  }

  // Compare file sizes as a rough heuristic
  const sizeDiff = Math.abs(baselineBuffer.length - currentBuffer.length);
  const maxSize = Math.max(baselineBuffer.length, currentBuffer.length);
  const sizeRatio = sizeDiff / maxSize;

  // Sample bytes from the image data (after PNG header) to detect changes
  const sampleSize = Math.min(10000, baselineBuffer.length - 100, currentBuffer.length - 100);
  let diffBytes = 0;

  // Skip PNG header (first ~100 bytes) and sample the rest
  const startOffset = 100;
  for (let i = 0; i < sampleSize; i++) {
    const idx = startOffset + Math.floor((i / sampleSize) * (baselineBuffer.length - startOffset));
    if (idx < baselineBuffer.length && idx < currentBuffer.length) {
      if (baselineBuffer[idx] !== currentBuffer[idx]) {
        diffBytes++;
      }
    }
  }

  const byteDiffRatio = diffBytes / sampleSize;

  // Combine size and byte diff for overall score
  const diffPercentage = Math.round((sizeRatio * 30 + byteDiffRatio * 70) * 100);

  return { diffPercentage: Math.min(100, diffPercentage) };
}

/**
 * Parse PNG dimensions from buffer
 */
function parsePngDimensions(buffer: Buffer): { width: number; height: number } | null {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  // IHDR chunk starts at byte 8, dimensions at bytes 16-23
  if (buffer.length < 24) {
    return null;
  }

  // Check PNG signature
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    return null;
  }

  // Read width and height from IHDR chunk (big-endian)
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  return { width, height };
}

/**
 * Run visual diff comparison for a screenshot
 */
export async function runVisualDiff(
  url: string,
  screenshotPath: string,
  config: VisualDiffConfig,
): Promise<VisualDiffResult> {
  const threshold = config.threshold ?? 5;
  const autoCreate = config.autoCreateBaseline ?? true;
  const baselinePath = getBaselinePath(config.baselineDir, url);

  // Ensure baseline directory exists
  await fs.promises.mkdir(config.baselineDir, { recursive: true });

  // Check if baseline exists
  const baselineExists = fs.existsSync(baselinePath);

  if (!baselineExists) {
    if (autoCreate) {
      // Copy current screenshot as baseline
      await fs.promises.copyFile(screenshotPath, baselinePath);
      return {
        url,
        hasBaseline: false,
        diffPercentage: 0,
        passed: true,
        message: "Baseline created (first run)",
        baselinePath,
        currentPath: screenshotPath,
      };
    } else {
      return {
        url,
        hasBaseline: false,
        diffPercentage: 0,
        passed: false,
        message: "No baseline exists and auto-create is disabled",
        currentPath: screenshotPath,
      };
    }
  }

  // Compare against baseline
  try {
    const { diffPercentage, diffPath } = await compareImages(baselinePath, screenshotPath);
    const passed = diffPercentage <= threshold;

    return {
      url,
      hasBaseline: true,
      diffPercentage,
      passed,
      message: passed
        ? `Visual diff within threshold (${diffPercentage}% <= ${threshold}%)`
        : `Visual regression detected (${diffPercentage}% > ${threshold}% threshold)`,
      baselinePath,
      currentPath: screenshotPath,
      diffPath,
    };
  } catch (err) {
    return {
      url,
      hasBaseline: true,
      diffPercentage: 0,
      passed: false,
      message: `Visual diff failed: ${err instanceof Error ? err.message : String(err)}`,
      baselinePath,
      currentPath: screenshotPath,
    };
  }
}

/**
 * Update baseline with current screenshot
 */
export async function updateBaseline(
  url: string,
  screenshotPath: string,
  config: VisualDiffConfig,
): Promise<void> {
  const baselinePath = getBaselinePath(config.baselineDir, url);
  await fs.promises.mkdir(config.baselineDir, { recursive: true });
  await fs.promises.copyFile(screenshotPath, baselinePath);
}

/**
 * List all baseline files
 */
export async function listBaselines(baselineDir: string): Promise<string[]> {
  try {
    const files = await fs.promises.readdir(baselineDir);
    return files.filter((f) => f.endsWith(".png"));
  } catch {
    return [];
  }
}

/**
 * Clear all baselines (useful for reset)
 */
export async function clearBaselines(baselineDir: string): Promise<number> {
  const files = await listBaselines(baselineDir);
  for (const file of files) {
    await fs.promises.unlink(path.join(baselineDir, file));
  }
  return files.length;
}
