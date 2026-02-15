import { describe, expect, it } from "vitest";
import { resolveSubagentToolPolicy } from "./pi-tools.policy.js";

describe("resolveSubagentToolPolicy nested spawn", () => {
  it("denies sessions_spawn by default", () => {
    delete process.env.OPENCLAW_ALLOW_NESTED_SPAWN;
    const policy = resolveSubagentToolPolicy({});
    expect(policy.deny ?? []).toContain("sessions_spawn");
  });

  it("allows sessions_spawn when OPENCLAW_ALLOW_NESTED_SPAWN=1", () => {
    process.env.OPENCLAW_ALLOW_NESTED_SPAWN = "1";
    const policy = resolveSubagentToolPolicy({});
    expect(policy.deny ?? []).not.toContain("sessions_spawn");
    delete process.env.OPENCLAW_ALLOW_NESTED_SPAWN;
  });
});
