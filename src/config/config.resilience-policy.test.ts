import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("resilience model policy validation", () => {
  it("rejects configured models that are outside resilience allowlist", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5"],
          },
          resilience: {
            providers: {
              allowlist: ["openai/gpt-4.1-mini"],
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path === "agents.defaults.model.fallbacks.0"),
      ).toBe(true);
    }
  });

  it("rejects malformed model refs in resilience allowlist", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          resilience: {
            providers: {
              allowlist: ["anthropic/"],
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("agents.defaults.resilience.providers.allowlist.0");
    }
  });

  it("rejects minHealthyProviders when allowlist has too few providers", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          resilience: {
            providers: {
              allowlist: ["openai/gpt-4.1-mini", "openai/gpt-5.2"],
              minHealthyProviders: 2,
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (issue) => issue.path === "agents.defaults.resilience.providers.minHealthyProviders",
        ),
      ).toBe(true);
    }
  });

  it("accepts valid resilience model policy", () => {
    const result = validateConfigObject({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["google/gemini-2.5-flash"],
          },
          resilience: {
            providers: {
              allowlist: ["openai/gpt-4.1-mini", "google/gemini-2.5-flash"],
              minHealthyProviders: 2,
            },
            breakGlass: {
              model: "google/gemini-2.5-flash",
            },
          },
        },
      },
      models: {
        providers: {
          openai: { baseUrl: "https://api.openai.com/v1", models: [] },
          google: { baseUrl: "https://generativelanguage.googleapis.com", models: [] },
        },
      },
    });

    expect(result.ok).toBe(true);
  });
});
