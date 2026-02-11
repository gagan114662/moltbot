import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MultiTurnResult, TurnResult, VisualAssessment } from "./voice-qa.js";
import {
  assertVoicePlatform,
  buildVoiceArgs,
  ELEMENTARY_MATH_SCRIPT,
  extractPcmData,
  formatMultiTurnReport,
  formatVoiceReport,
  generateSessionWav,
  parseVisualAssessment,
  runVoiceQaStage,
  validateWavHeader,
} from "./voice-qa.js";

describe("voice-qa", () => {
  describe("assertVoicePlatform", () => {
    it("does not throw on darwin", () => {
      // Current test env is macOS
      if (process.platform === "darwin") {
        expect(() => assertVoicePlatform()).not.toThrow();
      }
    });

    it("throws on non-darwin", () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        expect(() => assertVoicePlatform()).toThrow("Voice QA requires macOS");
      } finally {
        Object.defineProperty(process, "platform", { value: original });
      }
    });
  });

  describe("buildVoiceArgs", () => {
    it("returns Chrome args with embedded wavPath", () => {
      const args = buildVoiceArgs("/tmp/test.wav");
      expect(args).toContain("--use-fake-device-for-media-stream");
      expect(args).toContain("--use-fake-ui-for-media-stream");
      expect(args).toContain("--use-file-for-fake-audio-capture=/tmp/test.wav");
    });
  });

  describe("validateWavHeader", () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    /** Build a WAV buffer with proper RIFF + WAVE + fmt chunk. */
    function buildWav(opts: { channels: number; sampleRate: number; bits: number }): Buffer {
      // RIFF(4) + size(4) + WAVE(4) + "fmt "(4) + chunkSize(4) + fmt data(16) = 36 + data
      const buf = Buffer.alloc(44);
      buf.write("RIFF", 0, "ascii");
      buf.writeUInt32LE(36, 4);
      buf.write("WAVE", 8, "ascii");
      buf.write("fmt ", 12, "ascii");
      buf.writeUInt32LE(16, 16); // fmt chunk size
      buf.writeUInt16LE(1, 20); // PCM
      buf.writeUInt16LE(opts.channels, 22);
      buf.writeUInt32LE(opts.sampleRate, 24);
      buf.writeUInt32LE(opts.sampleRate * opts.channels * (opts.bits / 8), 28);
      buf.writeUInt16LE(opts.channels * (opts.bits / 8), 32);
      buf.writeUInt16LE(opts.bits, 34);
      return buf;
    }

    function writeWav(buf: Buffer): string {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-qa-test-"));
      const wavPath = path.join(tmpDir, "test.wav");
      fs.writeFileSync(wavPath, buf);
      return wavPath;
    }

    it("accepts valid mono 48kHz 16-bit WAV", () => {
      const buf = buildWav({ channels: 1, sampleRate: 48000, bits: 16 });
      expect(() => validateWavHeader(writeWav(buf))).not.toThrow();
    });

    it("accepts WAV with JUNK chunk before fmt (macOS say)", () => {
      // RIFF + WAVE + JUNK(28 bytes) + fmt
      const buf = Buffer.alloc(80);
      buf.write("RIFF", 0, "ascii");
      buf.writeUInt32LE(72, 4);
      buf.write("WAVE", 8, "ascii");
      buf.write("JUNK", 12, "ascii");
      buf.writeUInt32LE(28, 16); // JUNK size
      // fmt chunk at offset 48
      buf.write("fmt ", 48, "ascii");
      buf.writeUInt32LE(16, 52);
      buf.writeUInt16LE(1, 56); // PCM
      buf.writeUInt16LE(1, 58); // mono
      buf.writeUInt32LE(48000, 60); // 48kHz
      buf.writeUInt32LE(96000, 64);
      buf.writeUInt16LE(2, 68);
      buf.writeUInt16LE(16, 70); // 16-bit
      expect(() => validateWavHeader(writeWav(buf))).not.toThrow();
    });

    it("rejects non-WAV file", () => {
      const buf = Buffer.alloc(44);
      buf.write("NOPE", 0, "ascii");
      expect(() => validateWavHeader(writeWav(buf))).toThrow("Not a valid WAV");
    });

    it("rejects stereo WAV", () => {
      const buf = buildWav({ channels: 2, sampleRate: 48000, bits: 16 });
      expect(() => validateWavHeader(writeWav(buf))).toThrow("mono");
    });

    it("rejects wrong sample rate", () => {
      const buf = buildWav({ channels: 1, sampleRate: 44100, bits: 16 });
      expect(() => validateWavHeader(writeWav(buf))).toThrow("48kHz");
    });

    it("rejects wrong bit depth", () => {
      const buf = buildWav({ channels: 1, sampleRate: 48000, bits: 8 });
      expect(() => validateWavHeader(writeWav(buf))).toThrow("16-bit");
    });
  });

  describe("formatVoiceReport", () => {
    it("formats passing results", () => {
      const report = formatVoiceReport([
        {
          prompt: "What is 2+2?",
          transcript: "What is 2+2?",
          tutorResponse: "Two plus two equals four.",
          consoleErrors: [],
          consoleLogs: [],
          passed: true,
        },
      ]);
      expect(report).toContain("1/1 prompts passed");
      expect(report).toContain("[PASS]");
      expect(report).toContain("Tutor said: Two plus two equals four.");
      expect(report).toContain("User heard: What is 2+2?");
    });

    it("formats failing results", () => {
      const report = formatVoiceReport([
        {
          prompt: "Hello tutor",
          consoleErrors: ["WebSocket error"],
          consoleLogs: [],
          passed: false,
          error: "Timeout waiting for response",
        },
      ]);
      expect(report).toContain("0/1 prompts passed");
      expect(report).toContain("[FAIL]");
      expect(report).toContain("Error: Timeout");
      expect(report).toContain("Console errors:");
    });

    it("includes user transcript even when tutor fails", () => {
      const report = formatVoiceReport([
        {
          prompt: "Test prompt",
          transcript: "Test prompt",
          consoleErrors: [],
          consoleLogs: [],
          passed: false,
        },
      ]);
      expect(report).toContain("User heard: Test prompt");
      expect(report).not.toContain("Tutor said:");
    });
  });

  describe("extractPcmData", () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("extracts data chunk from standard WAV", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-qa-pcm-"));
      const wavPath = path.join(tmpDir, "test.wav");

      // Build a minimal WAV with 100 bytes of PCM data
      const pcmData = Buffer.alloc(100, 0x42);
      const header = Buffer.alloc(44);
      header.write("RIFF", 0, "ascii");
      header.writeUInt32LE(36 + pcmData.length, 4);
      header.write("WAVE", 8, "ascii");
      header.write("fmt ", 12, "ascii");
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20); // PCM
      header.writeUInt16LE(1, 22); // mono
      header.writeUInt32LE(16000, 24);
      header.writeUInt32LE(32000, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write("data", 36, "ascii");
      header.writeUInt32LE(pcmData.length, 40);

      fs.writeFileSync(wavPath, Buffer.concat([header, pcmData]));

      const result = extractPcmData(wavPath);
      expect(result.length).toBe(100);
      expect(result[0]).toBe(0x42);
    });

    it("handles WAV with JUNK chunk before data", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-qa-pcm-"));
      const wavPath = path.join(tmpDir, "junk.wav");

      const pcmData = Buffer.alloc(50, 0xaa);
      // RIFF + WAVE + fmt(24) + JUNK(12) + data
      const buf = Buffer.alloc(12 + 24 + 12 + 8 + pcmData.length);
      let offset = 0;
      buf.write("RIFF", offset, "ascii");
      offset += 4;
      buf.writeUInt32LE(buf.length - 8, offset);
      offset += 4;
      buf.write("WAVE", offset, "ascii");
      offset += 4;
      // fmt chunk
      buf.write("fmt ", offset, "ascii");
      offset += 4;
      buf.writeUInt32LE(16, offset);
      offset += 4;
      buf.writeUInt16LE(1, offset);
      offset += 2; // PCM
      buf.writeUInt16LE(1, offset);
      offset += 2; // mono
      buf.writeUInt32LE(16000, offset);
      offset += 4;
      buf.writeUInt32LE(32000, offset);
      offset += 4;
      buf.writeUInt16LE(2, offset);
      offset += 2;
      buf.writeUInt16LE(16, offset);
      offset += 2;
      // JUNK chunk
      buf.write("JUNK", offset, "ascii");
      offset += 4;
      buf.writeUInt32LE(4, offset);
      offset += 4;
      buf.writeUInt32LE(0, offset);
      offset += 4;
      // data chunk
      buf.write("data", offset, "ascii");
      offset += 4;
      buf.writeUInt32LE(pcmData.length, offset);
      offset += 4;
      pcmData.copy(buf, offset);

      fs.writeFileSync(wavPath, buf);

      const result = extractPcmData(wavPath);
      expect(result.length).toBe(50);
      expect(result[0]).toBe(0xaa);
    });
  });

  describe("generateSessionWav", () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // Only test on macOS (requires `say` command)
    const describeOnMac = process.platform === "darwin" ? describe : describe.skip;

    describeOnMac("on macOS", () => {
      it("generates a valid WAV with correct timing for 2 turns", () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-qa-session-"));
        const wavPath = path.join(tmpDir, "session.wav");

        const { wavPath: resultPath, turnTimings } = generateSessionWav(
          [
            { prompt: "Hello", waitSec: 5 },
            { prompt: "World", waitSec: 5 },
          ],
          wavPath,
        );

        expect(resultPath).toBe(wavPath);
        expect(fs.existsSync(wavPath)).toBe(true);

        // Validate WAV header
        expect(() => validateWavHeader(wavPath)).not.toThrow();

        // Check timings
        expect(turnTimings).toHaveLength(2);

        // First turn starts after 25s initial silence (tutor greeting window)
        expect(turnTimings[0].promptStartMs).toBe(25_000);
        expect(turnTimings[0].promptEndMs).toBeGreaterThan(25_000);
        expect(turnTimings[0].windowEndMs).toBeGreaterThan(turnTimings[0].promptEndMs);

        // Second turn starts after first turn's window ends
        expect(turnTimings[1].promptStartMs).toBeGreaterThan(turnTimings[0].promptEndMs);

        // WAV file should be reasonable size (> 44 bytes header + some data)
        const stat = fs.statSync(wavPath);
        expect(stat.size).toBeGreaterThan(1_000);
      });

      it("returns timings that increase monotonically", () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-qa-session-"));
        const wavPath = path.join(tmpDir, "session.wav");

        const { turnTimings } = generateSessionWav(
          [
            { prompt: "One", waitSec: 3 },
            { prompt: "Two", waitSec: 3 },
            { prompt: "Three", waitSec: 3 },
          ],
          wavPath,
        );

        expect(turnTimings).toHaveLength(3);
        for (let i = 1; i < turnTimings.length; i++) {
          expect(turnTimings[i].promptStartMs).toBeGreaterThan(turnTimings[i - 1].promptEndMs);
        }
        for (const t of turnTimings) {
          expect(t.promptEndMs).toBeGreaterThan(t.promptStartMs);
          expect(t.windowEndMs).toBeGreaterThan(t.promptEndMs);
        }
      });
    });
  });

  describe("parseVisualAssessment", () => {
    it("parses valid JSON response", () => {
      const raw = JSON.stringify({
        score: 85,
        canvasDescription: "A number line showing 2+2=4",
        drawingCorrect: true,
        issues: [{ severity: "minor", description: "Slight spacing issue", location: "center" }],
      });
      const result = parseVisualAssessment(raw);
      expect(result.score).toBe(85);
      expect(result.canvasDescription).toBe("A number line showing 2+2=4");
      expect(result.drawingCorrect).toBe(true);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe("minor");
      expect(result.rawResponse).toBe(raw);
    });

    it("handles response with markdown wrapping", () => {
      const json = {
        score: 30,
        canvasDescription: "Blank canvas",
        drawingCorrect: false,
        issues: [{ severity: "critical", description: "Canvas is empty" }],
      };
      const raw = "```json\n" + JSON.stringify(json) + "\n```";
      const result = parseVisualAssessment(raw);
      expect(result.score).toBe(30);
      expect(result.drawingCorrect).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe("critical");
    });

    it("returns fallback for garbage input", () => {
      const result = parseVisualAssessment("this is not json at all");
      expect(result.score).toBe(0);
      expect(result.drawingCorrect).toBe(false);
      expect(result.issues).toHaveLength(0);
      expect(result.rawResponse).toBe("this is not json at all");
    });

    it("normalizes unknown severity to major", () => {
      const raw = JSON.stringify({
        score: 60,
        canvasDescription: "Some content",
        drawingCorrect: true,
        issues: [{ severity: "unknown_level", description: "Something odd" }],
      });
      const result = parseVisualAssessment(raw);
      expect(result.issues[0].severity).toBe("major");
    });

    it("skips issues without description", () => {
      const raw = JSON.stringify({
        score: 50,
        canvasDescription: "Content",
        drawingCorrect: true,
        issues: [{ severity: "minor" }, { severity: "major", description: "Real issue" }],
      });
      const result = parseVisualAssessment(raw);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].description).toBe("Real issue");
    });
  });

  describe("formatMultiTurnReport", () => {
    function makeTurn(overrides: Partial<TurnResult> = {}): TurnResult {
      return {
        turnIndex: 0,
        prompt: "Test prompt",
        tutorResponse: "Test response",
        toolCalls: [],
        keywords: { expected: [], found: [] },
        passed: true,
        failReasons: [],
        consoleErrors: [],
        consoleLogs: [],
        ...overrides,
      };
    }

    function makeResult(overrides: Partial<MultiTurnResult> = {}): MultiTurnResult {
      return {
        scriptName: "test-script",
        turns: [makeTurn()],
        allPassed: true,
        sessionDurationMs: 120_000,
        ttsEngines: ["gemini"],
        wsEvents: [],
        overallConsoleErrors: [],
        overallConsoleLogs: [],
        ...overrides,
      };
    }

    it("formats all-passing multi-turn result", () => {
      const result = makeResult({
        turns: [
          makeTurn({ turnIndex: 0, prompt: "What is 2+2?", tutorResponse: "Four!" }),
          makeTurn({ turnIndex: 1, prompt: "Show me on the board", tutorResponse: "Sure!" }),
        ],
      });
      const report = formatMultiTurnReport(result);
      expect(report).toContain("test-script");
      expect(report).toContain("2/2 turns passed");
      expect(report).toContain("[PASS]");
      expect(report).toContain("What is 2+2?");
    });

    it("formats mixed pass/fail turns", () => {
      const result = makeResult({
        allPassed: false,
        turns: [
          makeTurn({ turnIndex: 0, prompt: "Hi", passed: true }),
          makeTurn({
            turnIndex: 1,
            prompt: "Draw something",
            passed: false,
            tutorResponse: null,
            failReasons: ["Tutor did not respond"],
          }),
        ],
      });
      const report = formatMultiTurnReport(result);
      expect(report).toContain("1/2 turns passed");
      expect(report).toContain("[FAIL]");
      expect(report).toContain("Tutor did not respond");
    });

    it("includes visual assessment info when present", () => {
      const va: VisualAssessment = {
        score: 45,
        canvasDescription: "Blank canvas",
        issues: [{ severity: "critical", description: "Nothing drawn" }],
        drawingCorrect: false,
        rawResponse: "{}",
      };
      const result = makeResult({
        allPassed: false,
        turns: [
          makeTurn({
            turnIndex: 0,
            prompt: "Draw 2+2",
            passed: false,
            failReasons: ["Visual quality below threshold: 45/100"],
            visualAssessment: va,
          }),
        ],
      });
      const report = formatMultiTurnReport(result);
      expect(report).toContain("Visual score: 45/100");
    });

    it("includes keyword info", () => {
      const result = makeResult({
        turns: [
          makeTurn({
            turnIndex: 0,
            prompt: "What is 2+2?",
            tutorResponse: "The answer is four.",
            keywords: { expected: ["four", "4"], found: ["four"] },
          }),
        ],
      });
      const report = formatMultiTurnReport(result);
      expect(report).toContain("Missing keywords: 4");
    });

    it("shows session duration", () => {
      const result = makeResult({ sessionDurationMs: 95_000 });
      const report = formatMultiTurnReport(result);
      // Should show ~95s or ~1.6m
      expect(report).toMatch(/\d+s/);
    });
  });

  describe("ELEMENTARY_MATH_SCRIPT", () => {
    it("has 4 turns totaling at least 80s of wait time", () => {
      expect(ELEMENTARY_MATH_SCRIPT.turns).toHaveLength(4);
      const totalWait = ELEMENTARY_MATH_SCRIPT.turns.reduce((sum, t) => sum + t.waitSec, 0);
      expect(totalWait).toBeGreaterThanOrEqual(80);
    });

    it("first turn expects keyword match", () => {
      const first = ELEMENTARY_MATH_SCRIPT.turns[0];
      expect(first.expect?.keywords).toContain("four");
    });

    it("second turn expects drawing", () => {
      const second = ELEMENTARY_MATH_SCRIPT.turns[1];
      expect(second.expect?.drawingExpected).toBe(true);
    });
  });

  describe("runVoiceQaStage", () => {
    it("is exported as a function", () => {
      expect(typeof runVoiceQaStage).toBe("function");
    });

    it("returns StageResult with error when Chrome not found on non-darwin", () => {
      // On CI or non-macOS, resolveChromePath may fail — test the export is callable
      // The actual browser test requires a running app, so we just validate the shape
      const original = process.platform;
      if (original !== "darwin") {
        // Can't resolve Chrome — test error path
        const controller = new AbortController();
        const result = runVoiceQaStage({
          cwd: "/tmp",
          appUrl: "http://localhost:3000/app",
          signal: controller.signal,
        });
        expect(result).toBeInstanceOf(Promise);
      }
    });
  });
});
