import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./common.js";
import { createBrowserDelegateTool } from "./browser-delegate-tool.js";

const configState: { tools?: { subagents?: { allowNestedSpawn?: boolean } } } = {};
const browserClientState = vi.hoisted(() => ({
  chromeAttached: true,
}));
const browserClientMocks = vi.hoisted(() => ({
  browserStatus: vi.fn(async (_baseUrl?: string, opts?: { profile?: string }) => {
    if (opts?.profile === "chrome") {
      return {
        extensionConnected: browserClientState.chromeAttached,
        attachedTabCount: browserClientState.chromeAttached ? 1 : 0,
        running: true,
        cdpReady: true,
      };
    }
    return {
      running: true,
      cdpReady: true,
    };
  }),
  browserExtensionAttachActive: vi.fn(async () => {
    browserClientState.chromeAttached = true;
    return {
      ok: true,
      extensionConnected: true,
      attachedTabCount: 1,
    };
  }),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => configState,
}));

vi.mock("../../browser/client.js", () => browserClientMocks);

afterEach(() => {
  vi.clearAllMocks();
  configState.tools = undefined;
  browserClientState.chromeAttached = true;
});

describe("browser_delegate tool", () => {
  it("builds a delegation contract and spawns a long-run sub-agent mission", async () => {
    configState.tools = { subagents: { allowNestedSpawn: true } };
    const calls: Array<{ toolCallId: string; args: unknown }> = [];
    const sessionsSpawnTool: AnyAgentTool = {
      name: "sessions_spawn",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async (toolCallId, args) => {
        calls.push({ toolCallId, args });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "accepted",
                childSessionKey: "agent:main:subagent:abc",
                runId: "run-123",
              }),
            },
          ],
          details: {
            status: "accepted",
            childSessionKey: "agent:main:subagent:abc",
            runId: "run-123",
          },
        };
      },
    } as unknown as AnyAgentTool;

    const tool = createBrowserDelegateTool({ sessionsSpawnTool });
    const result = await tool.execute("delegate-1", {
      task: "Research RLM memory techniques with evidence.",
      maxMinutes: 30,
      successCriteria: ["Compare at least 3 credible sources."],
    });

    expect(calls).toHaveLength(1);
    const spawnArgs = calls[0].args as Record<string, unknown>;
    expect(spawnArgs.runTimeoutSeconds).toBe(1800);
    expect(spawnArgs.cleanup).toBe("keep");
    expect(typeof spawnArgs.task).toBe("string");
    expect(String(spawnArgs.task)).toContain("Delegation contract:");
    expect(String(spawnArgs.task)).toContain("Six-dimension assessment:");
    expect(String(spawnArgs.task)).toContain("Quality gates:");
    expect(String(spawnArgs.task)).toContain("Minimum sources: 4");
    expect(String(spawnArgs.task)).toContain("Governance policy:");
    expect(String(spawnArgs.task)).toContain("Do not offload verification to the user.");
    expect(String(spawnArgs.task)).toContain("Do not output placeholders like UNVERIFIED quotes");
    expect(String(spawnArgs.task)).toContain("Execution policy:");
    expect(String(spawnArgs.task)).toContain("Authenticated-site default:");
    expect(String(spawnArgs.task)).toContain("FINAL_VAR_BEGIN");
    expect(String(spawnArgs.task)).toContain("FINAL_VAR_END");

    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("accepted");
    expect(details.delegated).toBe(true);
    expect(details.childSessionKey).toBe("agent:main:subagent:abc");
    expect(details.runId).toBe("run-123");
    expect(details.nestedDelegationAllowed).toBe(true);
    const quality = (details.contract as { quality?: Record<string, unknown> }).quality;
    expect(quality?.minSources).toBe(4);
    expect(quality?.minIndependentDomains).toBe(2);
    expect(quality?.requireCrossVerification).toBe(true);
    const assessment = details.assessment as { decision?: string; score?: number };
    expect(assessment.decision).toBe("delegate");
    expect(typeof assessment.score).toBe("number");
  });

  it("returns structured error metadata when delegated spawn is rejected", async () => {
    configState.tools = { subagents: { allowNestedSpawn: false } };
    const sessionsSpawnTool: AnyAgentTool = {
      name: "sessions_spawn",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        content: [{ type: "text", text: JSON.stringify({ status: "forbidden" }) }],
        details: { status: "forbidden", error: "not allowed" },
      }),
    } as unknown as AnyAgentTool;

    const tool = createBrowserDelegateTool({ sessionsSpawnTool });
    const result = await tool.execute("delegate-2", {
      task: "Run an irreversible workflow.",
      authority: "read_only",
      cleanup: "delete",
    });

    const details = result.details as Record<string, unknown>;
    expect(["error", "rejected"]).toContain(String(details.status));
    expect(details.delegated).toBe(false);
    if (details.status === "error") {
      const contract = details.contract as {
        authority?: { level?: string };
        constraints?: string[];
      };
      expect(contract.authority?.level).toBe("read_only");
      expect(contract.constraints ?? []).toContain(
        "Do not submit forms, post content, or trigger irreversible actions.",
      );
      expect(details.nestedDelegationAllowed).toBe(false);
    } else {
      expect(details.reason).toBe("governor_rejected");
    }
  });

  it("returns structured validation errors for invalid enum inputs", async () => {
    const sessionsSpawnTool: AnyAgentTool = {
      name: "sessions_spawn",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("should not execute");
      },
    } as unknown as AnyAgentTool;

    const tool = createBrowserDelegateTool({ sessionsSpawnTool });
    const result = await tool.execute("delegate-3", {
      task: "Test invalid parameters.",
      authority: "unsafe",
    });
    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("error");
    expect(details.code).toBe("invalid_parameters");
    expect(String(details.error)).toContain("authority must be one of");
  });

  it("attempts chrome attach during preflight when no tab is attached", async () => {
    browserClientState.chromeAttached = false;
    const sessionsSpawnTool: AnyAgentTool = {
      name: "sessions_spawn",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        content: [{ type: "text", text: JSON.stringify({ status: "accepted" }) }],
        details: { status: "accepted", childSessionKey: "k", runId: "r" },
      }),
    } as unknown as AnyAgentTool;

    const tool = createBrowserDelegateTool({ sessionsSpawnTool });
    const result = await tool.execute("delegate-4", {
      task: "Research updates from my authenticated dashboard.",
    });

    expect(browserClientMocks.browserExtensionAttachActive).toHaveBeenCalledWith(undefined, {
      profile: "chrome",
    });
    const details = result.details as Record<string, unknown>;
    const preflight = details.preflight as Record<string, unknown>;
    expect(preflight.chromeAttachAttempted).toBe(true);
    expect(preflight.chromeAttached).toBe(true);
  });
});
