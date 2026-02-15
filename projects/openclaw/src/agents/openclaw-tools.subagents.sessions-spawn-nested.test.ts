import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

const configState: { value: Record<string, unknown> } = {
  value: {
    routing: {
      sessions: {
        mainKey: "agent:test:main",
      },
    },
  },
};

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual("../config/config.js");
  return {
    ...actual,
    loadConfig: () => configState.value,
  };
});

vi.mock("../gateway/call.js", () => {
  return {
    callGateway: vi.fn(async ({ method }: { method: string }) => {
      if (method === "agent") {
        return { runId: "run-123" };
      }
      return {};
    }),
  };
});

describe("sessions_spawn nested recursion", () => {
  beforeEach(async () => {
    delete process.env.OPENCLAW_ALLOW_NESTED_SPAWN;
    configState.value = {
      routing: {
        sessions: {
          mainKey: "agent:test:main",
        },
      },
    };
    const { callGateway } = await import("../gateway/call.js");
    (callGateway as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it("forbids sessions_spawn from sub-agent sessions by default", async () => {
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:test:subagent:child-1" });
    const result = await tool.execute("call-1", { task: "nested task" });
    expect(result.details).toMatchObject({ status: "forbidden" });

    const { callGateway } = await import("../gateway/call.js");
    expect((callGateway as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("allows sessions_spawn from sub-agent sessions when OPENCLAW_ALLOW_NESTED_SPAWN=1", async () => {
    process.env.OPENCLAW_ALLOW_NESTED_SPAWN = "1";

    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:test:subagent:child-2" });
    const result = await tool.execute("call-2", { task: "nested task" });
    expect(result.details).toMatchObject({ status: "accepted" });

    const { callGateway } = await import("../gateway/call.js");
    const methods = (callGateway as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { method?: string }).method,
    );
    expect(methods).toContain("agent");
  });
});
