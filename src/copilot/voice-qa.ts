/**
 * Voice QA — inject audio into Chrome's fake mic, verify tutor responds.
 *
 * macOS only (uses `say` for TTS). Headed Chrome only (SpeechRecognition
 * requires a visible browser window).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Platform guard
// ---------------------------------------------------------------------------

export function assertVoicePlatform(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "Voice QA requires macOS (uses `say` for TTS). Not available on this platform.",
    );
  }
}

// ---------------------------------------------------------------------------
// WAV generation
// ---------------------------------------------------------------------------

/** Generate mono 16 kHz 16-bit LE PCM WAV from text using macOS `say`. */
export function generateWav(text: string, outputPath: string): void {
  assertVoicePlatform();
  execFileSync("say", ["-o", outputPath, "--data-format=LEI16@16000", text], {
    timeout: 15_000,
  });
  validateWavHeader(outputPath);
}

/**
 * Validate WAV header: RIFF, WAVE, mono, 16 kHz, 16-bit.
 * Scans for the `fmt ` chunk (macOS `say` inserts JUNK before fmt).
 */
export function validateWavHeader(wavPath: string): void {
  const buf = fs.readFileSync(wavPath);

  if (buf.length < 44) {
    throw new Error("WAV file too small");
  }

  const riff = buf.toString("ascii", 0, 4);
  const wave = buf.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Not a valid WAV file");
  }

  // Scan for "fmt " chunk (may not be at fixed offset 12 if JUNK chunks exist)
  let fmtOffset = -1;
  for (let i = 12; i < buf.length - 8; i++) {
    if (buf.toString("ascii", i, i + 4) === "fmt ") {
      fmtOffset = i;
      break;
    }
  }
  if (fmtOffset < 0) {
    throw new Error("WAV fmt chunk not found");
  }

  // fmt chunk: offset+8 = audioFormat, +10 = channels, +12 = sampleRate, +22 = bitsPerSample
  const channels = buf.readUInt16LE(fmtOffset + 10);
  const sampleRate = buf.readUInt32LE(fmtOffset + 12);
  const bitsPerSample = buf.readUInt16LE(fmtOffset + 22);

  if (channels !== 1) {
    throw new Error(`Expected mono (1 channel), got ${channels}`);
  }
  if (sampleRate !== 16000) {
    throw new Error(`Expected 16kHz, got ${sampleRate}`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`Expected 16-bit, got ${bitsPerSample}`);
  }
}

// ---------------------------------------------------------------------------
// Chrome args
// ---------------------------------------------------------------------------

export function buildVoiceArgs(wavPath: string): string[] {
  return [
    "--no-default-browser-check",
    "--disable-features=TranslateUI",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${wavPath}`,
  ];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceQaResult = {
  prompt: string;
  /** What SpeechRecognition heard (user side) */
  transcript?: string;
  /** What the tutor replied */
  tutorResponse?: string;
  screenshotPath?: string;
  consoleErrors: string[];
  /** All console.log/warn/info for diagnostics */
  consoleLogs: string[];
  passed: boolean;
  error?: string;
};

export type VoiceQaParams = {
  appUrl: string;
  prompts: string[];
  chromePath: string;
  evidenceDir: string;
  timeoutMs?: number;
  /** JWT token to inject into localStorage before navigating (bypasses login). */
  authToken?: string;
};

// ---------------------------------------------------------------------------
// Poll for transcript
// ---------------------------------------------------------------------------

/**
 * Poll the subtitle overlay for both user transcript and tutor response.
 * Returns as soon as a tutor ("Adam") response is detected, or on timeout
 * returns whatever user transcript was captured (proof mic was heard).
 */
async function pollForTutorResponse(
  page: import("playwright-core").Page,
  timeoutMs: number,
  intervalMs = 500,
): Promise<{ transcript?: string; tutorResponse?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastUserTranscript: string | undefined;

  while (Date.now() < deadline) {
    const result = await page.evaluate(() => {
      const divs = document.querySelectorAll("div");
      for (const div of divs) {
        const style = div.style;
        const spanText = div.querySelector("span")?.textContent?.trim() || "";

        // Primary: fixed positioning + zIndex
        // Fallback: any fixed-bottom div with known speaker labels
        const isSubtitle =
          (style.position === "fixed" && style.bottom === "32px" && style.zIndex === "50") ||
          (style.position === "fixed" && (spanText.includes("Adam") || spanText.includes("You")));
        if (!isSubtitle) {
          continue;
        }

        const fullText = div.textContent?.trim() || "";
        const text = fullText.replace(spanText, "").trim();
        return { speaker: spanText, text };
      }
      return null;
    });

    if (result?.text && result.speaker.includes("Adam")) {
      return { transcript: lastUserTranscript, tutorResponse: result.text };
    }
    if (result?.text && result.speaker.includes("You")) {
      lastUserTranscript = result.text;
    }

    await page.waitForTimeout(intervalMs);
  }

  return { transcript: lastUserTranscript };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/** Run voice QA: generate WAV per prompt, launch headed Chrome, poll for response. */
export async function runVoiceQa(params: VoiceQaParams): Promise<VoiceQaResult[]> {
  assertVoicePlatform();

  const { appUrl, prompts, chromePath, evidenceDir } = params;
  const timeoutMs = params.timeoutMs ?? 30_000;
  const results: VoiceQaResult[] = [];

  for (const prompt of prompts) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-qa-"));
    const wavPath = path.join(tmpDir, "prompt.wav");

    try {
      generateWav(prompt, wavPath);

      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({
        executablePath: chromePath,
        headless: false,
        args: buildVoiceArgs(wavPath),
        slowMo: 300,
      });

      const consoleErrors: string[] = [];
      const consoleLogs: string[] = [];
      try {
        const context = await browser.newContext({ permissions: ["microphone"] });
        const page = await context.newPage();
        page.on("console", (msg) => {
          const text = msg.text();
          const type = msg.type();
          // Capture all logs for diagnostics
          if (type === "log" || type === "warning" || type === "info") {
            consoleLogs.push(`[${type}] ${text}`);
          }
          if (type === "error") {
            // Filter React dev warnings and resource loading failures
            if (text.includes("findDOMNode") || text.includes("net::ERR_CONNECTION_REFUSED")) {
              return;
            }
            consoleErrors.push(text);
          }
        });
        page.on("pageerror", (err) => {
          consoleErrors.push(`[PAGE_ERROR] ${err.message}`);
        });
        // Capture HTTP failures (4xx/5xx) from network requests
        page.on("response", (response) => {
          if (response.status() >= 400) {
            consoleLogs.push(
              `[HTTP ${response.status()}] ${response.request().method()} ${response.url()}`,
            );
          }
          if (response.status() >= 500) {
            consoleErrors.push(
              `[HTTP ${response.status()}] ${response.request().method()} ${response.url()}`,
            );
          }
        });
        page.on("requestfailed", (request) => {
          const failure = request.failure()?.errorText ?? "unknown";
          consoleErrors.push(`[NET_FAIL] ${request.method()} ${request.url()} — ${failure}`);
        });

        await page.goto(appUrl, { timeout: 15_000, waitUntil: "domcontentloaded" });

        // In bypass mode the app auto-connects to Gemini — wait for session.
        // Without bypass, click "Start Session" manually.
        const startBtn = page.getByRole("button", { name: /start session/i });
        try {
          await startBtn.click({ timeout: 8_000 });
        } catch {
          // Button may not exist if bypass auto-connect already fired
          consoleLogs.push("[voice-qa] Start Session button not found — assuming auto-connect");
        }

        // Wait for Gemini session to establish
        await page.waitForTimeout(5_000);

        // Poll for tutor response (not a fixed timeout)
        const { transcript, tutorResponse } = await pollForTutorResponse(page, timeoutMs);

        const screenshotPath = path.join(evidenceDir, `voice-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        results.push({
          prompt,
          transcript,
          tutorResponse,
          screenshotPath,
          consoleErrors,
          consoleLogs,
          passed: !!tutorResponse && consoleErrors.length === 0,
        });
      } finally {
        await browser.close();
      }
    } catch (err) {
      results.push({
        prompt,
        consoleErrors: [],
        consoleLogs: [],
        passed: false,
        error: String(err),
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  return results;
}

/** Format voice QA results into a human-readable report. */
export function formatVoiceReport(results: VoiceQaResult[]): string {
  const lines: string[] = [];
  const passed = results.filter((r) => r.passed).length;
  lines.push(`Voice QA: ${passed}/${results.length} prompts passed\n`);

  for (const r of results) {
    const icon = r.passed ? "PASS" : "FAIL";
    lines.push(`[${icon}] "${r.prompt}"`);
    if (r.transcript) {
      lines.push(`  User heard: ${r.transcript}`);
    }
    if (r.tutorResponse) {
      lines.push(`  Tutor said: ${r.tutorResponse}`);
    }
    if (r.error) {
      lines.push(`  Error: ${r.error}`);
    }
    if (r.consoleErrors.length > 0) {
      lines.push(`  Console errors: ${r.consoleErrors.slice(0, 3).join("; ")}`);
    }
    if (r.consoleLogs.length > 0) {
      lines.push(`  Console logs (last 10):`);
      for (const log of r.consoleLogs.slice(-10)) {
        lines.push(`    ${log}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
