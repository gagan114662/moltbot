import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";
import { shouldUseSubagentVerifierMode } from "./tools/sessions-spawn-tool.js";

function latestAgentPrompt(calls: Array<{ method?: string; params?: unknown }>) {
  const agentCall = [...calls]
    .toReversed()
    .find((call) => call.method === "agent" && typeof call.params === "object");
  const params = (agentCall?.params ?? {}) as { extraSystemPrompt?: string };
  return params.extraSystemPrompt ?? "";
}

describe("sessions_spawn verifier mode", () => {
  beforeEach(() => {
    delete process.env.OPENCLAW_SUBAGENT_VERIFIER_MODE;
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-verify", status: "accepted" };
      }
      return {};
    });
  });

  afterEach(() => {
    delete process.env.OPENCLAW_SUBAGENT_VERIFIER_MODE;
  });

  it("auto mode enables verifier guidance for complex tasks", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-complex", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const task =
      "Analyze 40 documents, compare conflicting requirements, verify evidence, and produce a root cause report with citations for each claim.";
    const result = await tool.execute("call-complex", { task });
    expect(result.details).toMatchObject({ status: "accepted" });

    const prompt = latestAgentPrompt(calls);
    expect(prompt).toContain("## Complex Task Mode (Worker + Verifier)");
    expect(prompt).toContain("verifier subagent");
    expect(prompt).toContain("FINAL_VAR_BEGIN");
    expect(prompt).toContain("FINAL_VAR_END");
  });

  it("auto mode skips verifier guidance for simple tasks", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-simple", status: "accepted" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      agentChannel: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) {
      throw new Error("missing sessions_spawn tool");
    }

    const result = await tool.execute("call-simple", { task: "Find the current date." });
    expect(result.details).toMatchObject({ status: "accepted" });

    const prompt = latestAgentPrompt(calls);
    expect(prompt).not.toContain("## Complex Task Mode (Worker + Verifier)");
  });

  it("always mode forces verifier guidance", () => {
    process.env.OPENCLAW_SUBAGENT_VERIFIER_MODE = "always";
    expect(shouldUseSubagentVerifierMode("hello")).toBe(true);
  });

  it("off mode disables verifier guidance", () => {
    process.env.OPENCLAW_SUBAGENT_VERIFIER_MODE = "off";
    expect(
      shouldUseSubagentVerifierMode(
        "Analyze many logs, verify claims, and compare conflicting findings across documents.",
      ),
    ).toBe(false);
  });
});
