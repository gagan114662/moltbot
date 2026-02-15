import { describe, expect, it } from "vitest";
import { shouldResetSaturatedSession } from "./session-preflight.js";

describe("shouldResetSaturatedSession", () => {
  it("returns false for new sessions", () => {
    expect(
      shouldResetSaturatedSession({
        isNewSession: true,
        totalTokens: 400_000,
        contextTokens: 400_000,
      }),
    ).toBe(false);
  });

  it("returns true when total tokens reach the context limit", () => {
    expect(
      shouldResetSaturatedSession({
        totalTokens: 400_000,
        contextTokens: 400_000,
      }),
    ).toBe(true);
  });

  it("returns true when remaining tokens are below threshold", () => {
    expect(
      shouldResetSaturatedSession({
        totalTokens: 399_200,
        contextTokens: 400_000,
      }),
    ).toBe(true);
  });

  it("returns false when session still has healthy remaining budget", () => {
    expect(
      shouldResetSaturatedSession({
        totalTokens: 320_000,
        contextTokens: 400_000,
      }),
    ).toBe(false);
  });

  it("caps reserve floor influence so very high values do not force early resets", () => {
    expect(
      shouldResetSaturatedSession({
        totalTokens: 397_500,
        contextTokens: 400_000,
        reserveTokensFloor: 50_000,
      }),
    ).toBe(false);
  });
});
