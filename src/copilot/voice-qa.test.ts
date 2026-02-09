import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertVoicePlatform,
  buildVoiceArgs,
  formatVoiceReport,
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

    it("accepts valid mono 16kHz 16-bit WAV", () => {
      const buf = buildWav({ channels: 1, sampleRate: 16000, bits: 16 });
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
      buf.writeUInt32LE(16000, 60); // 16kHz
      buf.writeUInt32LE(32000, 64);
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
      const buf = buildWav({ channels: 2, sampleRate: 16000, bits: 16 });
      expect(() => validateWavHeader(writeWav(buf))).toThrow("mono");
    });

    it("rejects wrong sample rate", () => {
      const buf = buildWav({ channels: 1, sampleRate: 44100, bits: 16 });
      expect(() => validateWavHeader(writeWav(buf))).toThrow("16kHz");
    });

    it("rejects wrong bit depth", () => {
      const buf = buildWav({ channels: 1, sampleRate: 16000, bits: 8 });
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
          passed: false,
        },
      ]);
      expect(report).toContain("User heard: Test prompt");
      expect(report).not.toContain("Tutor said:");
    });
  });
});
