import { describe, expect, it } from "vitest";
import {
  normalizeGoogleModelId,
  buildXiaomiProvider,
  XIAOMI_DEFAULT_MODEL_ID,
} from "./models-config.providers.js";

describe("normalizeGoogleModelId", () => {
  it("rewrites gemini-3-pro to preview variant", () => {
    expect(normalizeGoogleModelId("gemini-3-pro")).toBe("gemini-3-pro-preview");
  });

  it("rewrites gemini-3-flash to preview variant", () => {
    expect(normalizeGoogleModelId("gemini-3-flash")).toBe("gemini-3-flash-preview");
  });

  it("passes through already-preview IDs unchanged", () => {
    expect(normalizeGoogleModelId("gemini-3-pro-preview")).toBe("gemini-3-pro-preview");
    expect(normalizeGoogleModelId("gemini-3-flash-preview")).toBe("gemini-3-flash-preview");
  });

  it("passes through unrelated model IDs unchanged", () => {
    expect(normalizeGoogleModelId("gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(normalizeGoogleModelId("claude-opus-4-5")).toBe("claude-opus-4-5");
    expect(normalizeGoogleModelId("gpt-4o")).toBe("gpt-4o");
  });
});

describe("buildXiaomiProvider", () => {
  it("returns a provider with anthropic-messages API", () => {
    const provider = buildXiaomiProvider();
    expect(provider.api).toBe("anthropic-messages");
  });

  it("includes the default model", () => {
    const provider = buildXiaomiProvider();
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0].id).toBe(XIAOMI_DEFAULT_MODEL_ID);
  });

  it("sets zero cost for Xiaomi models", () => {
    const provider = buildXiaomiProvider();
    const cost = provider.models[0].cost;
    expect(cost).toBeDefined();
    expect(cost?.input).toBe(0);
    expect(cost?.output).toBe(0);
  });

  it("has a valid base URL", () => {
    const provider = buildXiaomiProvider();
    expect(provider.baseUrl).toContain("xiaomimimo");
    expect(provider.baseUrl).toContain("anthropic");
  });
});
