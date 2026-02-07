import { describe, expect, it } from "vitest";
import {
  getAllFeatureFlags,
  getFeatureFlagNames,
  isFeatureEnabled,
  resolveFeatureFlags,
} from "./feature-flags.js";

const noEnv = {} as NodeJS.ProcessEnv;

describe("feature flags", () => {
  describe("resolveFeatureFlags", () => {
    it("returns empty when no config or env", () => {
      expect(resolveFeatureFlags(undefined, noEnv)).toEqual([]);
    });

    it("parses comma-separated env flags", () => {
      const env = { OPENCLAW_FEATURES: "session-memory,council-mode" } as NodeJS.ProcessEnv;
      const flags = resolveFeatureFlags(undefined, env);
      expect(flags).toContain("session-memory");
      expect(flags).toContain("council-mode");
    });

    it("treats env '1' as all flags enabled", () => {
      const env = { OPENCLAW_FEATURES: "1" } as NodeJS.ProcessEnv;
      const flags = resolveFeatureFlags(undefined, env);
      expect(flags.length).toBeGreaterThan(0);
      expect(flags).toContain("session-memory");
      expect(flags).toContain("council-mode");
      expect(flags).toContain("feedback-loop");
      expect(flags).toContain("video-proof");
    });

    it("treats env '0' as no flags", () => {
      const env = { OPENCLAW_FEATURES: "0" } as NodeJS.ProcessEnv;
      expect(resolveFeatureFlags(undefined, env)).toEqual([]);
    });

    it("treats env 'false' as no flags", () => {
      const env = { OPENCLAW_FEATURES: "false" } as NodeJS.ProcessEnv;
      expect(resolveFeatureFlags(undefined, env)).toEqual([]);
    });

    it("normalizes flag names to lowercase", () => {
      const env = { OPENCLAW_FEATURES: "SESSION-MEMORY" } as NodeJS.ProcessEnv;
      expect(resolveFeatureFlags(undefined, env)).toContain("session-memory");
    });

    it("deduplicates flags from config + env", () => {
      const cfg = { features: { flags: ["session-memory"] } } as never;
      const env = { OPENCLAW_FEATURES: "session-memory,council-mode" } as NodeJS.ProcessEnv;
      const flags = resolveFeatureFlags(cfg, env);
      const sessionMemoryCount = flags.filter((f) => f === "session-memory").length;
      expect(sessionMemoryCount).toBe(1);
      expect(flags).toContain("council-mode");
    });
  });

  describe("isFeatureEnabled", () => {
    it("returns false for all flags by default (no config, no env)", () => {
      expect(isFeatureEnabled("session-memory", undefined, noEnv)).toBe(false);
      expect(isFeatureEnabled("council-mode", undefined, noEnv)).toBe(false);
      expect(isFeatureEnabled("feedback-loop", undefined, noEnv)).toBe(false);
      expect(isFeatureEnabled("video-proof", undefined, noEnv)).toBe(false);
    });

    it("returns true when flag is in env", () => {
      const env = { OPENCLAW_FEATURES: "session-memory" } as NodeJS.ProcessEnv;
      expect(isFeatureEnabled("session-memory", undefined, env)).toBe(true);
      expect(isFeatureEnabled("council-mode", undefined, env)).toBe(false);
    });

    it("returns true when all flags enabled via env '1'", () => {
      const env = { OPENCLAW_FEATURES: "1" } as NodeJS.ProcessEnv;
      expect(isFeatureEnabled("session-memory", undefined, env)).toBe(true);
      expect(isFeatureEnabled("video-proof", undefined, env)).toBe(true);
    });
  });

  describe("getAllFeatureFlags", () => {
    it("returns all known flags with enabled status", () => {
      const env = { OPENCLAW_FEATURES: "session-memory" } as NodeJS.ProcessEnv;
      const flags = getAllFeatureFlags(undefined, env);
      expect(flags.length).toBeGreaterThanOrEqual(4);

      const sessionMemory = flags.find((f) => f.name === "session-memory");
      expect(sessionMemory?.enabled).toBe(true);
      expect(sessionMemory?.description).toBeTruthy();

      const council = flags.find((f) => f.name === "council-mode");
      expect(council?.enabled).toBe(false);
    });

    it("uses defaults when no flags configured", () => {
      const flags = getAllFeatureFlags(undefined, noEnv);
      for (const flag of flags) {
        expect(flag.enabled).toBe(flag.default);
      }
    });
  });

  describe("getFeatureFlagNames", () => {
    it("returns all known flag names", () => {
      const names = getFeatureFlagNames();
      expect(names).toContain("session-memory");
      expect(names).toContain("council-mode");
      expect(names).toContain("feedback-loop");
      expect(names).toContain("video-proof");
    });
  });
});
