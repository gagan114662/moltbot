import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareScreenshots, runScreenshotDiffStage } from "./stages-screenshot-diff.js";

const tmpDir = path.join("/tmp", "screenshot-diff-test-" + process.pid);

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runScreenshotDiffStage", () => {
  it("passes when no screenshot is available", async () => {
    const result = await runScreenshotDiffStage({
      cwd: tmpDir,
      screenshotPath: "",
      signal: new AbortController().signal,
    });
    expect(result.stage).toBe("screenshot-diff");
    expect(result.passed).toBe(true);
    expect(result.error).toContain("No screenshot");
  });

  it("creates baseline on first run", async () => {
    // Create a minimal PNG (1x1 red pixel)
    const sharp = (await import("sharp")).default;
    const testPng = path.join(tmpDir, "current.png");
    await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toFile(testPng);

    const result = await runScreenshotDiffStage({
      cwd: tmpDir,
      screenshotPath: testPng,
      signal: new AbortController().signal,
    });
    expect(result.passed).toBe(true);
    expect(result.error).toContain("Baseline created");

    // Baseline should exist now
    expect(fs.existsSync(path.join(tmpDir, ".moltbot/baselines/browser-inspect.png"))).toBe(true);
  });

  it("passes when screenshots are identical", async () => {
    const sharp = (await import("sharp")).default;
    const testPng = path.join(tmpDir, "current.png");
    await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toFile(testPng);

    // Create baseline
    const baselinesDir = path.join(tmpDir, ".moltbot/baselines");
    fs.mkdirSync(baselinesDir, { recursive: true });
    fs.copyFileSync(testPng, path.join(baselinesDir, "browser-inspect.png"));

    const result = await runScreenshotDiffStage({
      cwd: tmpDir,
      screenshotPath: testPng,
      signal: new AbortController().signal,
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe("compareScreenshots", () => {
  it("detects differences between images", async () => {
    const sharp = (await import("sharp")).default;
    const base = path.join(tmpDir, "base.png");
    const current = path.join(tmpDir, "current.png");
    const diff = path.join(tmpDir, "diff.png");

    // Red baseline
    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toFile(base);

    // Blue current
    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 0, g: 0, b: 255, alpha: 1 },
      },
    })
      .png()
      .toFile(current);

    const result = await compareScreenshots(base, current, diff);
    expect(result.diffPixels).toBe(10000); // All pixels differ
    expect(result.diffPercent).toBe(1);
    expect(result.diffImagePath).toBe(diff);
    expect(fs.existsSync(diff)).toBe(true);
  });

  it("reports zero diff for identical images", async () => {
    const sharp = (await import("sharp")).default;
    const base = path.join(tmpDir, "base.png");
    const current = path.join(tmpDir, "current.png");
    const diff = path.join(tmpDir, "diff.png");

    await sharp({
      create: {
        width: 50,
        height: 50,
        channels: 4,
        background: { r: 128, g: 128, b: 128, alpha: 1 },
      },
    })
      .png()
      .toFile(base);

    fs.copyFileSync(base, current);

    const result = await compareScreenshots(base, current, diff);
    expect(result.diffPixels).toBe(0);
    expect(result.diffPercent).toBe(0);
    expect(result.diffImagePath).toBeUndefined();
  });
});
