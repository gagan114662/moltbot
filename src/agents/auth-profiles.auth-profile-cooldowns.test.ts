import { describe, expect, it } from "vitest";
import { calculateAuthProfileCooldownMs } from "./auth-profiles.js";

describe("auth profile cooldowns", () => {
  it("applies exponential backoff with a 2m cap", () => {
    expect(calculateAuthProfileCooldownMs(1)).toBe(15_000);
    expect(calculateAuthProfileCooldownMs(2)).toBe(30_000);
    expect(calculateAuthProfileCooldownMs(3)).toBe(60_000);
    expect(calculateAuthProfileCooldownMs(4)).toBe(120_000);
    expect(calculateAuthProfileCooldownMs(5)).toBe(120_000);
  });
});
