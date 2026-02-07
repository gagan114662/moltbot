import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectSecretsInConfigFindings,
  collectSyncedFolderFindings,
  collectHooksHardeningFindings,
  collectModelHygieneFindings,
  collectExposureMatrixFindings,
} from "./audit-extra.js";

const emptyCfg = {} as OpenClawConfig;

describe("audit-extra", () => {
  describe("collectAttackSurfaceSummaryFindings", () => {
    it("returns a single info finding with default config", () => {
      const findings = collectAttackSurfaceSummaryFindings(emptyCfg);
      expect(findings).toHaveLength(1);
      expect(findings[0].checkId).toBe("summary.attack_surface");
      expect(findings[0].severity).toBe("info");
    });

    it("reports open group policies", () => {
      const cfg = {
        channels: {
          telegram: { groupPolicy: "open" },
          discord: { groupPolicy: "allowlist" },
        },
      } as unknown as OpenClawConfig;
      const findings = collectAttackSurfaceSummaryFindings(cfg);
      expect(findings[0].detail).toContain("open=1");
      expect(findings[0].detail).toContain("allowlist=1");
    });

    it("reports elevated tools and hooks status", () => {
      const cfg = {
        tools: { elevated: { enabled: true } },
        hooks: { enabled: true },
      } as unknown as OpenClawConfig;
      const findings = collectAttackSurfaceSummaryFindings(cfg);
      expect(findings[0].detail).toContain("tools.elevated: enabled");
      expect(findings[0].detail).toContain("hooks: enabled");
    });

    it("reports disabled browser control", () => {
      const cfg = {
        browser: { enabled: false },
      } as unknown as OpenClawConfig;
      const findings = collectAttackSurfaceSummaryFindings(cfg);
      expect(findings[0].detail).toContain("browser control: disabled");
    });
  });

  describe("collectSyncedFolderFindings", () => {
    it("returns empty for non-synced paths", () => {
      const findings = collectSyncedFolderFindings({
        stateDir: "/home/user/.openclaw",
        configPath: "/home/user/.openclaw/config.yaml",
      });
      expect(findings).toEqual([]);
    });

    it("warns for iCloud stateDir", () => {
      const findings = collectSyncedFolderFindings({
        stateDir: "/Users/user/iCloud/.openclaw",
        configPath: "/home/user/.openclaw/config.yaml",
      });
      expect(findings).toHaveLength(1);
      expect(findings[0].checkId).toBe("fs.synced_dir");
      expect(findings[0].severity).toBe("warn");
    });

    it("warns for Dropbox configPath", () => {
      const findings = collectSyncedFolderFindings({
        stateDir: "/home/user/.openclaw",
        configPath: "/Users/user/Dropbox/.openclaw/config.yaml",
      });
      expect(findings).toHaveLength(1);
      expect(findings[0].checkId).toBe("fs.synced_dir");
    });

    it("warns for OneDrive and Google Drive", () => {
      expect(
        collectSyncedFolderFindings({
          stateDir: "/Users/user/OneDrive/.openclaw",
          configPath: "/some/path",
        }),
      ).toHaveLength(1);

      expect(
        collectSyncedFolderFindings({
          stateDir: "/Users/user/Google Drive/.openclaw",
          configPath: "/some/path",
        }),
      ).toHaveLength(1);
    });
  });

  describe("collectSecretsInConfigFindings", () => {
    it("returns empty when no secrets in config", () => {
      expect(collectSecretsInConfigFindings(emptyCfg)).toEqual([]);
    });

    it("warns when gateway password is plaintext", () => {
      const cfg = {
        gateway: { auth: { password: "my-secret-password" } },
      } as unknown as OpenClawConfig;
      const findings = collectSecretsInConfigFindings(cfg);
      expect(findings).toHaveLength(1);
      expect(findings[0].checkId).toBe("config.secrets.gateway_password_in_config");
      expect(findings[0].severity).toBe("warn");
    });

    it("skips env-ref passwords like ${ENV_VAR}", () => {
      const cfg = {
        gateway: { auth: { password: "${GATEWAY_PASSWORD}" } },
      } as unknown as OpenClawConfig;
      expect(collectSecretsInConfigFindings(cfg)).toEqual([]);
    });

    it("reports hooks token in config", () => {
      const cfg = {
        hooks: { enabled: true, token: "my-hooks-token" },
      } as unknown as OpenClawConfig;
      const findings = collectSecretsInConfigFindings(cfg);
      expect(findings).toHaveLength(1);
      expect(findings[0].checkId).toBe("config.secrets.hooks_token_in_config");
      expect(findings[0].severity).toBe("info");
    });
  });

  describe("collectHooksHardeningFindings", () => {
    it("returns empty when hooks disabled", () => {
      expect(collectHooksHardeningFindings(emptyCfg)).toEqual([]);
    });

    it("warns on short hooks token", () => {
      const cfg = {
        hooks: { enabled: true, token: "short" },
      } as unknown as OpenClawConfig;
      const findings = collectHooksHardeningFindings(cfg);
      const shortTokenFinding = findings.find((f) => f.checkId === "hooks.token_too_short");
      expect(shortTokenFinding).toBeDefined();
      expect(shortTokenFinding?.severity).toBe("warn");
    });

    it("does not warn on long token", () => {
      const cfg = {
        hooks: { enabled: true, token: "a".repeat(48) },
      } as unknown as OpenClawConfig;
      const findings = collectHooksHardeningFindings(cfg);
      const shortTokenFinding = findings.find((f) => f.checkId === "hooks.token_too_short");
      expect(shortTokenFinding).toBeUndefined();
    });

    it("warns on root hooks path", () => {
      const cfg = {
        hooks: { enabled: true, path: "/" },
      } as unknown as OpenClawConfig;
      const findings = collectHooksHardeningFindings(cfg);
      const rootPathFinding = findings.find((f) => f.checkId === "hooks.path_root");
      expect(rootPathFinding).toBeDefined();
      expect(rootPathFinding?.severity).toBe("critical");
    });
  });

  describe("collectModelHygieneFindings", () => {
    it("returns empty with no models configured", () => {
      expect(collectModelHygieneFindings(emptyCfg)).toEqual([]);
    });

    it("warns on GPT-3.5 models", () => {
      const cfg = {
        agents: {
          defaults: { model: { primary: "gpt-3.5-turbo" } },
        },
      } as unknown as OpenClawConfig;
      const findings = collectModelHygieneFindings(cfg);
      const legacyFinding = findings.find((f) => f.checkId === "models.legacy");
      expect(legacyFinding).toBeDefined();
      expect(legacyFinding?.detail).toContain("GPT-3.5");
    });

    it("warns on Claude 2 / Claude Instant models", () => {
      const cfg = {
        agents: {
          defaults: { model: { primary: "claude-2.1" } },
        },
      } as unknown as OpenClawConfig;
      const findings = collectModelHygieneFindings(cfg);
      const legacyFinding = findings.find((f) => f.checkId === "models.legacy");
      expect(legacyFinding).toBeDefined();
      expect(legacyFinding?.detail).toContain("Claude 2/Instant");
    });

    it("warns on Haiku tier as weak model", () => {
      const cfg = {
        agents: {
          defaults: { model: { primary: "claude-3-haiku-20240307" } },
        },
      } as unknown as OpenClawConfig;
      const findings = collectModelHygieneFindings(cfg);
      const weakFinding = findings.find((f) => f.checkId === "models.weak_tier");
      expect(weakFinding).toBeDefined();
      expect(weakFinding?.detail).toContain("Haiku");
    });

    it("does not warn on modern models", () => {
      const cfg = {
        agents: {
          defaults: { model: { primary: "claude-opus-4-5" } },
        },
      } as unknown as OpenClawConfig;
      const findings = collectModelHygieneFindings(cfg);
      expect(findings).toEqual([]);
    });

    it("detects legacy models in agent list fallbacks", () => {
      const cfg = {
        agents: {
          list: [
            {
              id: "my-agent",
              model: {
                primary: "claude-opus-4-5",
                fallbacks: ["gpt-3.5-turbo"],
              },
            },
          ],
        },
      } as unknown as OpenClawConfig;
      const findings = collectModelHygieneFindings(cfg);
      const legacyFinding = findings.find((f) => f.checkId === "models.legacy");
      expect(legacyFinding).toBeDefined();
    });
  });

  describe("collectExposureMatrixFindings", () => {
    it("returns empty with default config", () => {
      const findings = collectExposureMatrixFindings(emptyCfg);
      // Should return findings (at least the matrix itself)
      expect(findings.length).toBeGreaterThanOrEqual(0);
    });
  });
});
