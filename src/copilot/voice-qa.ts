/**
 * Voice QA — inject audio into Chrome's fake mic, verify tutor responds.
 *
 * Supports two modes:
 *   1. Single-prompt (legacy) — one prompt per browser session
 *   2. Multi-turn — persistent browser session with concatenated WAV + timeline polling
 *
 * macOS only (uses `say` for TTS). Headed Chrome only (SpeechRecognition
 * requires a visible browser window).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { StageResult } from "./types.js";
import type { EnrichedVoiceQaResult, WsEvent } from "./voice-qa-diagnosis.js";
import { resolveChromePath } from "./browser-inspect.js";
import {
  diagnose,
  enrichWsEventsFromConsole,
  formatDiagnosisReport,
} from "./voice-qa-diagnosis.js";

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

/** Chatterbox TTS server URL (local, port 4123). Falls back to macOS `say`. */
const CHATTERBOX_URL = "http://127.0.0.1:4123/v1/audio/speech";

/**
 * Generate mono 16 kHz 16-bit LE PCM WAV from text.
 * Tries Chatterbox TTS first (natural voice), falls back to macOS `say`.
 * Returns which TTS engine was used: "gemini" | "chatterbox" | "macos-say".
 */
export function generateWav(text: string, outputPath: string): string {
  assertVoicePlatform();

  // Try Gemini TTS first — natural, human-quality voice (Gemini talking to Gemini)
  try {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("No GEMINI_API_KEY");
    }

    const tmpResp = `${outputPath}.gemini.json`;
    execFileSync(
      "curl",
      [
        "-s",
        "-X",
        "POST",
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
        "-H",
        `x-goog-api-key: ${apiKey}`,
        "-H",
        "Content-Type: application/json",
        "-d",
        JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Say this naturally as a young student asking their tutor a question: ${text}`,
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Kore" },
              },
            },
          },
        }),
        "-o",
        tmpResp,
        "--max-time",
        "20",
      ],
      { timeout: 25_000 },
    );

    const respJson = JSON.parse(fs.readFileSync(tmpResp, "utf-8")) as {
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { data?: string } }> };
      }>;
    };
    const audioBase64 = respJson.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioBase64) {
      throw new Error("No audio in Gemini TTS response");
    }

    // Decode base64 → raw PCM (24kHz s16le mono), then convert to 16kHz WAV
    const tmpPcm = `${outputPath}.gemini.pcm`;
    fs.writeFileSync(tmpPcm, Buffer.from(audioBase64, "base64"));

    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "s16le",
        "-ar",
        "24000",
        "-ac",
        "1",
        "-i",
        tmpPcm,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-sample_fmt",
        "s16",
        "-f",
        "wav",
        outputPath,
      ],
      { timeout: 15_000, stdio: "pipe" },
    );

    try {
      fs.unlinkSync(tmpResp);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(tmpPcm);
    } catch {
      /* ignore */
    }
    validateWavHeader(outputPath);
    console.log(`[voice-qa] TTS: Gemini (Kore) — "${text.slice(0, 40)}..."`);
    return "gemini";
  } catch (err) {
    console.warn(`[voice-qa] Gemini TTS failed: ${String(err).slice(0, 100)}`);
  }

  // Try Chatterbox — natural, human-sounding voice (fallback)
  try {
    const tmpFloat = `${outputPath}.float.wav`;
    execFileSync(
      "curl",
      [
        "-s",
        "-X",
        "POST",
        CHATTERBOX_URL,
        "-H",
        "Content-Type: application/json",
        "-d",
        JSON.stringify({
          input: text,
          voice: "student",
          exaggeration: 0.6,
          cfg_weight: 0.4,
          temperature: 0.8,
        }),
        "-o",
        tmpFloat,
        "--max-time",
        "15",
      ],
      { timeout: 20_000 },
    );

    // Chatterbox returns 24kHz float WAV — convert to 16kHz 16-bit mono PCM
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-i",
        tmpFloat,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-sample_fmt",
        "s16",
        "-f",
        "wav",
        outputPath,
      ],
      { timeout: 15_000, stdio: "pipe" },
    );

    try {
      fs.unlinkSync(tmpFloat);
    } catch {
      /* ignore */
    }
    validateWavHeader(outputPath);
    console.log(`[voice-qa] TTS: Chatterbox (student) — "${text.slice(0, 40)}..."`);
    return "chatterbox";
  } catch (err) {
    console.warn(`[voice-qa] Chatterbox failed: ${String(err).slice(0, 100)}`);
  }

  // Fallback: macOS say (robotic but reliable)
  console.warn(`[voice-qa] TTS: macOS say (ROBOTIC FALLBACK) — "${text.slice(0, 40)}..."`);
  execFileSync("say", ["-o", outputPath, "--data-format=LEI16@16000", text], {
    timeout: 15_000,
  });
  validateWavHeader(outputPath);
  return "macos-say";
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
  /** WebSocket events captured during the test (for diagnosis engine). */
  wsEvents?: WsEvent[];
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
// Multi-turn types
// ---------------------------------------------------------------------------

export type TurnExpectation = {
  /** Tutor should respond (not be silent). Default true. */
  responds: boolean;
  /** Expected tool call name (e.g. "draw_annotation"). Any draw_* matches if set to "draw_*". */
  toolCall?: string;
  /** Keywords that should appear in tutor response (case-insensitive). */
  keywords?: string[];
  /** Should the canvas have new visual content after this turn? */
  drawingExpected?: boolean;
};

export type StudentTurn = {
  /** What the student says. */
  prompt: string;
  /** Seconds of silence AFTER this prompt (response window for tutor). */
  waitSec: number;
  /** Pass/fail criteria for this turn. */
  expect?: TurnExpectation;
};

export type StudentScript = {
  name: string;
  description: string;
  turns: StudentTurn[];
};

export type VisualQaConfig = {
  model: string;
  provider: string;
  agentDir: string;
  cfg: OpenClawConfig;
};

export type VisualIssue = {
  severity: "critical" | "major" | "minor";
  description: string;
  location?: string;
};

export type VisualAssessment = {
  score: number;
  canvasDescription: string;
  issues: VisualIssue[];
  drawingCorrect: boolean;
  rawResponse: string;
};

export type TurnResult = {
  turnIndex: number;
  prompt: string;
  tutorResponse: string | null;
  toolCalls: string[];
  keywords: { expected: string[]; found: string[] };
  visualAssessment?: VisualAssessment;
  /** Which TTS engine generated this turn's student audio. */
  ttsEngine?: string;
  passed: boolean;
  failReasons: string[];
  screenshotPath?: string;
  consoleErrors: string[];
  consoleLogs: string[];
};

export type MultiTurnResult = {
  scriptName: string;
  turns: TurnResult[];
  allPassed: boolean;
  sessionDurationMs: number;
  /** TTS engines used per turn (e.g. ["gemini","gemini","macos-say","gemini"]). */
  ttsEngines: string[];
  wsEvents: WsEvent[];
  overallConsoleErrors: string[];
  overallConsoleLogs: string[];
};

export type MultiTurnVoiceQaParams = {
  appUrl: string;
  script: StudentScript;
  chromePath: string;
  evidenceDir: string;
  authToken?: string;
  sessionTimeoutMs?: number;
  visualQa?: VisualQaConfig;
};

/** Timing info for one turn within the stitched WAV. */
type TurnTiming = {
  promptStartMs: number;
  promptEndMs: number;
  windowEndMs: number;
};

// ---------------------------------------------------------------------------
// Default student scripts
// ---------------------------------------------------------------------------

export const ELEMENTARY_MATH_SCRIPT: StudentScript = {
  name: "elementary-math",
  description: "Tests basic math tutoring with whiteboard interaction (4 turns, ~2 min)",
  turns: [
    {
      prompt: "What is two plus two?",
      waitSec: 15,
      expect: { responds: true, keywords: ["four", "4"] },
    },
    {
      prompt: "Can you show me that on the board?",
      waitSec: 20,
      expect: { responds: true, toolCall: "draw_*", drawingExpected: true },
    },
    {
      prompt: "Why does addition work like that?",
      waitSec: 20,
      expect: { responds: true },
    },
    {
      prompt: "Now what about three times five?",
      waitSec: 25,
      expect: { responds: true, keywords: ["fifteen", "15"] },
    },
  ],
};

// ---------------------------------------------------------------------------
// Poll for transcript
// ---------------------------------------------------------------------------

/** UI text fragments to strip from subtitle scraping (buttons, labels, etc.) */
const SUBTITLE_NOISE = ["End Session", "Start Session", "Settings", "Menu"];

/** Clean scraped subtitle text by removing UI noise. */
function cleanSubtitleText(raw: string): string {
  let text = raw;
  for (const noise of SUBTITLE_NOISE) {
    text = text.replace(noise, "");
  }
  return text.trim();
}

/**
 * Poll the subtitle overlay for both user transcript and tutor response.
 * Returns as soon as a NEW tutor ("Adam") response is detected that differs
 * from `previousTutorResponse`, or on timeout returns whatever was captured.
 *
 * `previousTutorResponse` prevents stale greeting detection — the poller
 * only returns when it sees something the tutor said AFTER this prompt.
 */
async function pollForTutorResponse(
  page: import("playwright-core").Page,
  timeoutMs: number,
  intervalMs = 500,
  previousTutorResponse?: string,
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
      const cleaned = cleanSubtitleText(result.text);
      // Only count as new response if it differs from the previous turn's response
      if (cleaned && cleaned !== previousTutorResponse) {
        return { transcript: lastUserTranscript, tutorResponse: cleaned };
      }
    }
    if (result?.text && result.speaker.includes("You")) {
      lastUserTranscript = cleanSubtitleText(result.text);
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
      const wsEvents: WsEvent[] = [];
      try {
        const context = await browser.newContext({ permissions: ["microphone"] });
        const page = await context.newPage();

        // Intercept WebSocket connections for diagnosis engine
        page.on("websocket", (ws) => {
          wsEvents.push({ timestamp: Date.now(), type: "open", url: ws.url() });

          ws.on("framesent", (data) => {
            const payload =
              typeof data.payload === "string"
                ? data.payload.slice(0, 500)
                : `<binary ${data.payload.byteLength} bytes>`;
            wsEvents.push({ timestamp: Date.now(), type: "message-sent", payload });
          });

          ws.on("framereceived", (data) => {
            const payload =
              typeof data.payload === "string"
                ? data.payload.slice(0, 500)
                : `<binary ${data.payload.byteLength} bytes>`;
            wsEvents.push({ timestamp: Date.now(), type: "message-received", payload });
          });

          ws.on("close", () => {
            wsEvents.push({ timestamp: Date.now(), type: "close" });
          });

          ws.on("socketerror", (error) => {
            wsEvents.push({ timestamp: Date.now(), type: "error", payload: String(error) });
          });
        });

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
          wsEvents,
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

/** Format multi-turn voice QA results into a human-readable report. */
export function formatMultiTurnReport(result: MultiTurnResult): string {
  const lines: string[] = [];
  const passed = result.turns.filter((t) => t.passed).length;
  lines.push(`Voice QA [${result.scriptName}]: ${passed}/${result.turns.length} turns passed`);
  lines.push(`Session duration: ${Math.round(result.sessionDurationMs / 1000)}s`);

  // TTS engine summary
  if (result.ttsEngines.length > 0) {
    const counts = new Map<string, number>();
    for (const e of result.ttsEngines) {
      counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    const summary = [...counts.entries()].map(([e, n]) => `${e}(${n})`).join(", ");
    lines.push(`TTS engines: ${summary}`);
    if (result.ttsEngines.includes("macos-say")) {
      lines.push(
        `WARNING: macOS say fallback used — robotic voice may cause Gemini to misunderstand`,
      );
    }
  }
  lines.push("");

  for (const t of result.turns) {
    const icon = t.passed ? "PASS" : "FAIL";
    const engineTag = t.ttsEngine ? ` [${t.ttsEngine}]` : "";
    lines.push(`[${icon}] Turn ${t.turnIndex + 1}: "${t.prompt}"${engineTag}`);
    if (t.tutorResponse) {
      lines.push(`  Tutor said: ${t.tutorResponse}`);
    }
    if (t.toolCalls.length > 0) {
      lines.push(`  Tool calls: ${t.toolCalls.join(", ")}`);
    }
    if (t.keywords.expected.length > 0) {
      const missing = t.keywords.expected.filter((k) => !t.keywords.found.includes(k));
      if (missing.length > 0) {
        lines.push(`  Missing keywords: ${missing.join(", ")}`);
      }
    }
    if (t.visualAssessment) {
      lines.push(`  Visual score: ${t.visualAssessment.score}/100`);
      if (t.visualAssessment.issues.length > 0) {
        for (const issue of t.visualAssessment.issues) {
          lines.push(`  [${issue.severity.toUpperCase()}] ${issue.description}`);
        }
      }
    }
    if (t.failReasons.length > 0) {
      for (const reason of t.failReasons) {
        lines.push(`  FAIL: ${reason}`);
      }
    }
    if (t.consoleErrors.length > 0) {
      lines.push(`  Console errors: ${t.consoleErrors.slice(0, 3).join("; ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// WAV stitching — concatenate per-turn WAVs with silence gaps
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2; // 16-bit

/** Generate silence as raw PCM bytes (16-bit LE, mono, 16kHz). */
function silenceBytes(seconds: number): Buffer {
  const numSamples = Math.round(seconds * SAMPLE_RATE);
  return Buffer.alloc(numSamples * BYTES_PER_SAMPLE);
}

/** Extract raw PCM data from a WAV file (skips RIFF header + chunk headers). */
export function extractPcmData(wavPath: string): Buffer {
  const buf = fs.readFileSync(wavPath);

  // Find "data" chunk
  let dataOffset = -1;
  for (let i = 12; i < buf.length - 8; i++) {
    if (buf.toString("ascii", i, i + 4) === "data") {
      dataOffset = i;
      break;
    }
  }
  if (dataOffset < 0) {
    throw new Error("WAV data chunk not found");
  }

  const dataSize = buf.readUInt32LE(dataOffset + 4);
  return buf.subarray(dataOffset + 8, dataOffset + 8 + dataSize);
}

/** Write a valid WAV file header for mono 16kHz 16-bit LE PCM. */
function writeWavHeader(dataSize: number): Buffer {
  const header = Buffer.alloc(44);
  const fileSize = 36 + dataSize;

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);

  // fmt chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

/**
 * Generate a single WAV file containing all student prompts with silence gaps.
 * Returns the WAV path and timing map for each turn.
 */
export function generateSessionWav(
  turns: Array<{ prompt: string; waitSec: number }>,
  outputPath: string,
): { wavPath: string; turnTimings: TurnTiming[]; ttsEngines: string[] } {
  assertVoicePlatform();

  const pcmChunks: Buffer[] = [];
  const turnTimings: TurnTiming[] = [];
  const ttsEngines: string[] = [];
  let currentOffsetBytes = 0;

  const bytesToMs = (bytes: number) => (bytes / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;

  // 25s initial silence — tutor greeting finishes before Turn 1 audio plays
  const startSilence = silenceBytes(25);
  pcmChunks.push(startSilence);
  currentOffsetBytes += startSilence.length;

  for (const turn of turns) {
    const promptStartMs = bytesToMs(currentOffsetBytes);

    // Generate WAV for this prompt
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-stitch-"));
    const tmpWav = path.join(tmpDir, "prompt.wav");
    try {
      const engine = generateWav(turn.prompt, tmpWav);
      ttsEngines.push(engine);
      const pcm = extractPcmData(tmpWav);
      pcmChunks.push(pcm);
      currentOffsetBytes += pcm.length;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const promptEndMs = bytesToMs(currentOffsetBytes);

    // Add silence gap (response window)
    const silence = silenceBytes(turn.waitSec);
    pcmChunks.push(silence);
    currentOffsetBytes += silence.length;

    const windowEndMs = bytesToMs(currentOffsetBytes);

    turnTimings.push({ promptStartMs, promptEndMs, windowEndMs });
  }

  // Write concatenated WAV
  const allPcm = Buffer.concat(pcmChunks);
  const header = writeWavHeader(allPcm.length);
  fs.writeFileSync(outputPath, Buffer.concat([header, allPcm]));

  return { wavPath: outputPath, turnTimings, ttsEngines };
}

// ---------------------------------------------------------------------------
// Visual QA prompt + parsing
// ---------------------------------------------------------------------------

const VISUAL_QA_PROMPT = `You are a QA engineer reviewing a screenshot of an AI math tutor's blackboard.
The tutor just responded to: "{prompt}"

Assess the visual quality of the blackboard. Return a JSON object:

{
  "score": 0-100,
  "canvasDescription": "what's visible on the board",
  "drawingCorrect": true/false,
  "issues": [
    {
      "severity": "critical|major|minor",
      "description": "what's wrong",
      "location": "where on screen"
    }
  ]
}

Check for:
- CRITICAL: Overlapping text/drawings making content unreadable
- CRITICAL: Completely wrong content (e.g. drew subtraction when asked about addition)
- CRITICAL: Blank canvas when drawing was expected
- MAJOR: Text cut off or extending beyond visible area
- MAJOR: Colors clashing or unreadable against dark background
- MAJOR: Missing elements (asked to draw number line but only text shown)
- MINOR: Uneven spacing between elements
- MINOR: Inconsistent font sizes
- MINOR: Pen cursor visible in final state

For "drawingCorrect": true if the drawing reasonably matches what the student asked for.

Return ONLY the JSON object, no markdown.`;

/** Parse a vision model's response into a VisualAssessment. */
export function parseVisualAssessment(raw: string): VisualAssessment {
  const fallback: VisualAssessment = {
    score: 0,
    canvasDescription: "Unable to parse visual assessment",
    issues: [],
    drawingCorrect: false,
    rawResponse: raw,
  };

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      score?: number;
      canvasDescription?: string;
      drawingCorrect?: boolean;
      issues?: Array<{ severity?: string; description?: string; location?: string }>;
    };

    const issues: VisualIssue[] = [];
    if (Array.isArray(parsed.issues)) {
      for (const issue of parsed.issues) {
        if (!issue.description) {
          continue;
        }
        const sev = issue.severity?.toLowerCase();
        const severity = sev === "critical" ? "critical" : sev === "minor" ? "minor" : "major";
        issues.push({
          severity,
          description: issue.description,
          location: issue.location,
        });
      }
    }

    return {
      score: typeof parsed.score === "number" ? parsed.score : 0,
      canvasDescription: parsed.canvasDescription ?? "",
      issues,
      drawingCorrect: parsed.drawingCorrect ?? false,
      rawResponse: raw,
    };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Multi-turn runner
// ---------------------------------------------------------------------------

/** Set up Playwright page listeners for console + WS + HTTP errors. */
function attachPageListeners(
  page: import("playwright-core").Page,
  consoleErrors: string[],
  consoleLogs: string[],
  wsEvents: WsEvent[],
): void {
  page.on("websocket", (ws) => {
    wsEvents.push({ timestamp: Date.now(), type: "open", url: ws.url() });

    ws.on("framesent", (data) => {
      const payload =
        typeof data.payload === "string"
          ? data.payload.slice(0, 500)
          : `<binary ${data.payload.byteLength} bytes>`;
      wsEvents.push({ timestamp: Date.now(), type: "message-sent", payload });
    });

    ws.on("framereceived", (data) => {
      const payload =
        typeof data.payload === "string"
          ? data.payload.slice(0, 500)
          : `<binary ${data.payload.byteLength} bytes>`;
      wsEvents.push({ timestamp: Date.now(), type: "message-received", payload });
    });

    ws.on("close", () => {
      wsEvents.push({ timestamp: Date.now(), type: "close" });
    });

    ws.on("socketerror", (error) => {
      wsEvents.push({ timestamp: Date.now(), type: "error", payload: String(error) });
    });
  });

  page.on("console", (msg) => {
    const text = msg.text();
    const type = msg.type();
    if (type === "log" || type === "warning" || type === "info") {
      consoleLogs.push(`[${type}] ${text}`);
    }
    if (type === "error") {
      if (text.includes("findDOMNode") || text.includes("net::ERR_CONNECTION_REFUSED")) {
        return;
      }
      consoleErrors.push(text);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`[PAGE_ERROR] ${err.message}`);
  });
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
}

/** Extract tool call names from console logs within a time window. */
function extractToolCalls(consoleLogs: string[], _startIdx: number, _endIdx: number): string[] {
  // Tool calls are logged like: [useTutor] Calling tool: draw_annotation
  // or: [log] [useScratchpadAI] functionCall: draw_annotation
  const tools: string[] = [];
  // Scan the provided slice of logs (startIdx..endIdx)
  const slice = consoleLogs.slice(_startIdx, _endIdx);
  for (const log of slice) {
    const match = log.match(/(?:Calling tool|functionCall|tool call)[:\s]+(\w+)/i);
    if (match) {
      tools.push(match[1]);
    }
  }
  return tools;
}

/** Grade a single turn based on expectations. */
function gradeTurn(
  turn: StudentTurn,
  tutorResponse: string | null,
  toolCalls: string[],
  visualAssessment: VisualAssessment | undefined,
  consoleErrors: string[],
): { passed: boolean; failReasons: string[]; keywords: { expected: string[]; found: string[] } } {
  const failReasons: string[] = [];
  const expected = turn.expect ?? { responds: true };
  const expectedKeywords = expected.keywords ?? [];
  const foundKeywords: string[] = [];

  // Check: tutor should respond
  if (expected.responds && !tutorResponse) {
    failReasons.push("Tutor did not respond (no audio reply detected)");
  }

  // Check: keywords in response
  if (tutorResponse && expectedKeywords.length > 0) {
    const lower = tutorResponse.toLowerCase();
    for (const kw of expectedKeywords) {
      if (lower.includes(kw.toLowerCase())) {
        foundKeywords.push(kw);
      }
    }
    const missing = expectedKeywords.filter((k) => !foundKeywords.includes(k));
    if (missing.length > 0) {
      failReasons.push(`Missing keywords: ${missing.join(", ")}`);
    }
  }

  // Check: expected tool call
  if (expected.toolCall) {
    const pattern = expected.toolCall;
    const matched = pattern.includes("*")
      ? toolCalls.some((t) => t.startsWith(pattern.replace("*", "")))
      : toolCalls.includes(pattern);
    if (!matched) {
      failReasons.push(
        `Expected tool call "${pattern}" but got: ${toolCalls.join(", ") || "none"}`,
      );
    }
  }

  // Check: drawing expected
  if (expected.drawingExpected && visualAssessment && !visualAssessment.drawingCorrect) {
    failReasons.push("Drawing expected but canvas shows incorrect or no content");
  }

  // Check: visual score
  if (visualAssessment && visualAssessment.score < 50) {
    failReasons.push(`Visual quality below threshold: ${visualAssessment.score}/100`);
  }

  // Check: critical visual issues
  if (visualAssessment) {
    const criticals = visualAssessment.issues.filter((i) => i.severity === "critical");
    for (const c of criticals) {
      failReasons.push(`Visual CRITICAL: ${c.description}`);
    }
  }

  // Console errors also fail the turn
  if (consoleErrors.length > 0) {
    failReasons.push(`${consoleErrors.length} console error(s)`);
  }

  return {
    passed: failReasons.length === 0,
    failReasons,
    keywords: { expected: expectedKeywords, found: foundKeywords },
  };
}

/**
 * Run a multi-turn voice QA session using a pre-stitched WAV.
 *
 * Architecture:
 * - Generate all student prompts (via Gemini TTS) into a single WAV with silence gaps
 * - Launch Chrome ONCE with --use-file-for-fake-audio-capture (proven to work)
 * - 25s initial silence lets the tutor greeting complete before Turn 1 plays
 * - Timeline-based polling attributes tutor responses to the correct turn
 * - Gemini voice talking to Gemini tutor = natural conversation quality
 */
export async function runMultiTurnVoiceQa(
  params: MultiTurnVoiceQaParams,
): Promise<MultiTurnResult> {
  assertVoicePlatform();

  const { appUrl, script, chromePath, evidenceDir } = params;
  const sessionTimeoutMs = params.sessionTimeoutMs ?? 180_000;

  // Generate stitched WAV: [25s silence][turn1][wait][turn2][wait]...
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-mt-"));
  const stitchedWavPath = path.join(tmpDir, "session.wav");
  const { turnTimings, ttsEngines } = generateSessionWav(
    script.turns.map((t) => ({ prompt: t.prompt, waitSec: t.waitSec })),
    stitchedWavPath,
  );

  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      executablePath: chromePath,
      headless: false,
      args: buildVoiceArgs(stitchedWavPath),
      slowMo: 300,
    });

    const allConsoleErrors: string[] = [];
    const allConsoleLogs: string[] = [];
    const wsEvents: WsEvent[] = [];
    const turns: TurnResult[] = [];

    try {
      const context = await browser.newContext({ permissions: ["microphone", "camera"] });
      const page = await context.newPage();

      // Attach listeners
      attachPageListeners(page, allConsoleErrors, allConsoleLogs, wsEvents);

      // Navigate and start session
      await page.goto(appUrl, { timeout: 15_000, waitUntil: "domcontentloaded" });

      const startBtn = page.getByRole("button", { name: /start session/i });
      try {
        await startBtn.click({ timeout: 8_000 });
      } catch {
        allConsoleLogs.push("[voice-qa] Start Session button not found — assuming auto-connect");
      }

      // Wait for Gemini session to establish + WAV starts playing from fake mic
      await page.waitForTimeout(5_000);

      // Session clock: WAV started playing ~when getUserMedia was called
      const sessionStart = Date.now();

      // Wait for tutor greeting during the 25s initial silence
      let previousTutorResponse: string | undefined;
      const greetingPollMs = Math.max(turnTimings[0].promptStartMs - 5_000, 15_000);
      const { tutorResponse: greeting } = await pollForTutorResponse(page, greetingPollMs, 500);
      if (greeting) {
        previousTutorResponse = greeting;
        allConsoleLogs.push(`[voice-qa] Tutor greeting: "${greeting}"`);
      } else {
        allConsoleLogs.push("[voice-qa] No tutor greeting detected");
      }

      // Process each turn based on WAV timeline
      for (let i = 0; i < script.turns.length; i++) {
        const turn = script.turns[i];
        const timing = turnTimings[i];
        const logStartIdx = allConsoleLogs.length;

        // Wait until this turn's prompt audio has finished playing
        const elapsed = Date.now() - sessionStart;
        const waitUntilMs = timing.promptEndMs;
        if (elapsed < waitUntilMs) {
          await page.waitForTimeout(waitUntilMs - elapsed);
        }

        allConsoleLogs.push(
          `[voice-qa] Turn ${i}: prompt "${turn.prompt}" at ${Math.round((Date.now() - sessionStart) / 1000)}s`,
        );

        // Poll for NEW tutor response until this turn's response window closes
        const remainingWindowMs = timing.windowEndMs - (Date.now() - sessionStart);
        const pollMs = Math.max(remainingWindowMs, 5_000);
        const { tutorResponse } = await pollForTutorResponse(
          page,
          pollMs,
          500,
          previousTutorResponse,
        );
        if (tutorResponse) {
          previousTutorResponse = tutorResponse;
        }

        // Capture screenshot
        const screenshotPath = path.join(evidenceDir, `turn-${i}-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        // Extract tool calls from console logs during this turn
        const logEndIdx = allConsoleLogs.length;
        const toolCalls = extractToolCalls(allConsoleLogs, logStartIdx, logEndIdx);

        // Console errors during this turn
        const turnErrors = allConsoleErrors.slice(logStartIdx);
        const turnLogs = allConsoleLogs.slice(logStartIdx, logEndIdx);

        // Visual QA (optional)
        let visualAssessment: VisualAssessment | undefined;
        if (params.visualQa) {
          try {
            const { describeImageWithModel } =
              await import("../media-understanding/providers/image.js");
            const { normalizeBrowserScreenshot } = await import("../browser/screenshot.js");
            const screenshotBuffer = fs.readFileSync(screenshotPath);
            const compressed = await normalizeBrowserScreenshot(screenshotBuffer);
            const result = await describeImageWithModel({
              buffer: compressed.buffer,
              fileName: `turn-${i}.jpg`,
              mime: compressed.contentType ?? "image/jpeg",
              model: params.visualQa.model,
              provider: params.visualQa.provider,
              prompt: VISUAL_QA_PROMPT.replace("{prompt}", turn.prompt),
              maxTokens: 1024,
              timeoutMs: 30_000,
              agentDir: params.visualQa.agentDir,
              cfg: params.visualQa.cfg,
            });
            visualAssessment = parseVisualAssessment(result.text);
          } catch (err) {
            allConsoleLogs.push(`[voice-qa] Visual QA failed for turn ${i}: ${String(err)}`);
          }
        }

        // Grade this turn
        const grade = gradeTurn(
          turn,
          tutorResponse ?? null,
          toolCalls,
          visualAssessment,
          turnErrors,
        );

        turns.push({
          turnIndex: i,
          prompt: turn.prompt,
          tutorResponse: tutorResponse ?? null,
          toolCalls,
          keywords: grade.keywords,
          visualAssessment,
          ttsEngine: ttsEngines[i],
          passed: grade.passed,
          failReasons: grade.failReasons,
          screenshotPath,
          consoleErrors: turnErrors,
          consoleLogs: turnLogs,
        });

        // Check session timeout
        if (Date.now() - sessionStart > sessionTimeoutMs) {
          allConsoleLogs.push(`[voice-qa] Session timeout (${sessionTimeoutMs}ms) at turn ${i}`);
          break;
        }
      }

      // Final screenshot
      const finalPath = path.join(evidenceDir, `final-${Date.now()}.png`);
      await page.screenshot({ path: finalPath, fullPage: true });

      return {
        scriptName: script.name,
        turns,
        allPassed: turns.every((t) => t.passed),
        sessionDurationMs: Date.now() - sessionStart,
        ttsEngines,
        wsEvents,
        overallConsoleErrors: allConsoleErrors,
        overallConsoleLogs: allConsoleLogs,
      };
    } finally {
      await browser.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Pipeline stage adapter
// ---------------------------------------------------------------------------

/** Convert MultiTurnResult to EnrichedVoiceQaResult[] for diagnosis. */
function multiTurnToEnriched(result: MultiTurnResult): EnrichedVoiceQaResult[] {
  return result.turns.map((t) => ({
    prompt: t.prompt,
    passed: t.passed,
    error: t.failReasons.join("; ") || undefined,
    tutorResponse: t.tutorResponse ?? undefined,
    consoleErrors: t.consoleErrors,
    consoleLogs: t.consoleLogs,
    screenshotPath: t.screenshotPath,
    wsEvents: enrichWsEventsFromConsole(result.wsEvents, result.overallConsoleLogs),
    toolCalls: t.toolCalls,
    visualAssessment: t.visualAssessment,
  }));
}

/**
 * Run voice QA as a copilot pipeline stage.
 *
 * Returns a `StageResult` compatible with the worker verification cascade.
 * On failure, the error field contains the multi-turn report + static diagnosis.
 */
export async function runVoiceQaStage(params: {
  cwd: string;
  appUrl: string;
  script?: StudentScript;
  signal: AbortSignal;
}): Promise<StageResult> {
  const start = Date.now();
  try {
    const chromePath = resolveChromePath();
    if (!chromePath) {
      return {
        stage: "voice-qa",
        passed: false,
        durationMs: Date.now() - start,
        error: "Chrome not found",
      };
    }

    const evidenceDir = path.join(os.tmpdir(), `voice-qa-stage-${Date.now()}`);
    fs.mkdirSync(evidenceDir, { recursive: true });

    const result = await runMultiTurnVoiceQa({
      appUrl: params.appUrl,
      script: params.script ?? ELEMENTARY_MATH_SCRIPT,
      chromePath,
      evidenceDir,
      sessionTimeoutMs: 180_000,
    });

    if (result.allPassed) {
      return { stage: "voice-qa", passed: true, durationMs: Date.now() - start };
    }

    // Format error with diagnosis for feedback
    const enriched = multiTurnToEnriched(result);
    const diagnoses = diagnose(enriched);
    const diagReport = formatDiagnosisReport(diagnoses);
    const error = `${formatMultiTurnReport(result)}\n\n${diagReport}`;

    return { stage: "voice-qa", passed: false, durationMs: Date.now() - start, error };
  } catch (err) {
    return {
      stage: "voice-qa",
      passed: false,
      durationMs: Date.now() - start,
      error: String(err),
    };
  }
}
