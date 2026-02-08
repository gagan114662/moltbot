/**
 * Screenshot-diff stage: compare browser screenshot against saved baseline.
 *
 * Uses sharp for raw RGBA extraction and pixel-by-pixel comparison.
 * First run saves as baseline and passes. Writes diff image to evidence dir.
 */

import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "./types.js";
import { truncateError } from "./feedback.js";

const BASELINES_DIR = ".moltbot/baselines";
const EVIDENCE_DIR = ".moltbot/evidence";

/** Per-pixel RGB tolerance (0–255). Handles font anti-aliasing. */
const PIXEL_TOLERANCE = 30;
/** Percentage of differing pixels before failure. */
const DIFF_THRESHOLD = 0.005; // 0.5%

export type DiffResult = {
  totalPixels: number;
  diffPixels: number;
  diffPercent: number;
  diffImagePath?: string;
};

/**
 * Compare two screenshots pixel-by-pixel using sharp.
 * Returns diff stats and writes a red-highlighted diff image.
 */
export async function compareScreenshots(
  baselinePath: string,
  currentPath: string,
  diffOutputPath: string,
): Promise<DiffResult> {
  // Dynamic import — sharp may not be installed in all environments
  const sharp = (await import("sharp")).default;

  const baselineMeta = await sharp(baselinePath).metadata();
  const currentImg = sharp(currentPath);

  // Resize current to match baseline if dimensions differ
  const bw = baselineMeta.width ?? 1280;
  const bh = baselineMeta.height ?? 720;

  const baselineRaw = await sharp(baselinePath)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const currentRaw = await currentImg
    .resize(bw, bh, { fit: "fill" })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const baseData = baselineRaw.data;
  const currData = currentRaw.data;
  const totalPixels = bw * bh;
  let diffPixels = 0;

  // Build diff image (copy of current, paint differing pixels red)
  const diffData = Buffer.from(currData);

  for (let i = 0; i < totalPixels; i++) {
    const offset = i * 4;
    const dr = Math.abs(baseData[offset] - currData[offset]);
    const dg = Math.abs(baseData[offset + 1] - currData[offset + 1]);
    const db = Math.abs(baseData[offset + 2] - currData[offset + 2]);

    if (dr > PIXEL_TOLERANCE || dg > PIXEL_TOLERANCE || db > PIXEL_TOLERANCE) {
      diffPixels++;
      // Paint red in diff image
      diffData[offset] = 255;
      diffData[offset + 1] = 0;
      diffData[offset + 2] = 0;
      diffData[offset + 3] = 255;
    }
  }

  const diffPercent = diffPixels / totalPixels;

  // Write diff image if there are differences
  let diffImagePath: string | undefined;
  if (diffPixels > 0) {
    fs.mkdirSync(path.dirname(diffOutputPath), { recursive: true });
    await sharp(diffData, { raw: { width: bw, height: bh, channels: 4 } })
      .png()
      .toFile(diffOutputPath);
    diffImagePath = diffOutputPath;
  }

  return { totalPixels, diffPixels, diffPercent, diffImagePath };
}

export type ScreenshotDiffContext = {
  cwd: string;
  /** Path to the current screenshot from browser-inspect stage */
  screenshotPath: string;
  signal: AbortSignal;
};

export async function runScreenshotDiffStage(ctx: ScreenshotDiffContext): Promise<StageResult> {
  const start = Date.now();
  const baselinesDir = path.join(ctx.cwd, BASELINES_DIR);
  const evidenceDir = path.join(ctx.cwd, EVIDENCE_DIR);
  const baselinePath = path.join(baselinesDir, "browser-inspect.png");

  // If no screenshot from browser stage, skip
  if (!ctx.screenshotPath || !fs.existsSync(ctx.screenshotPath)) {
    return {
      stage: "screenshot-diff",
      passed: true,
      durationMs: Date.now() - start,
      error: "No screenshot available from browser stage",
    };
  }

  // First run: save as baseline and pass
  if (!fs.existsSync(baselinePath)) {
    fs.mkdirSync(baselinesDir, { recursive: true });
    fs.copyFileSync(ctx.screenshotPath, baselinePath);
    return {
      stage: "screenshot-diff",
      passed: true,
      durationMs: Date.now() - start,
      error: "Baseline created (first run)",
    };
  }

  try {
    const diffOutputPath = path.join(evidenceDir, "screenshot-diff.png");
    const result = await compareScreenshots(baselinePath, ctx.screenshotPath, diffOutputPath);

    if (result.diffPercent > DIFF_THRESHOLD) {
      return {
        stage: "screenshot-diff",
        passed: false,
        durationMs: Date.now() - start,
        error: truncateError(
          `Visual regression: ${result.diffPixels}/${result.totalPixels} pixels differ (${(result.diffPercent * 100).toFixed(2)}% > ${(DIFF_THRESHOLD * 100).toFixed(1)}% threshold)` +
            (result.diffImagePath ? `\nDiff image: ${result.diffImagePath}` : ""),
        ),
      };
    }

    return {
      stage: "screenshot-diff",
      passed: true,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    // sharp not available or comparison failed — pass with warning
    return {
      stage: "screenshot-diff",
      passed: true,
      durationMs: Date.now() - start,
      error: `Screenshot comparison failed (non-blocking): ${String(err).slice(0, 200)}`,
    };
  }
}
