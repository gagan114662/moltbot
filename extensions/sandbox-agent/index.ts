import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { SandboxAgentManager } from "./src/manager.js";

// Global manager instance
let manager: SandboxAgentManager | null = null;

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = api.getPluginConfig?.() as
    | {
        defaultAgent?: "claude" | "codex" | "opencode" | "amp";
        mode?: "embedded" | "remote";
        serverUrl?: string;
        token?: string;
        port?: number;
        workspaceDir?: string;
        humanInTheLoop?: {
          enabled?: boolean;
          timeoutSeconds?: number;
          autoApproveSafe?: boolean;
        };
      }
    | undefined;

  const config = pluginConfig ?? {};

  // Create the manager
  manager = new SandboxAgentManager({
    mode: config.mode ?? "embedded",
    serverUrl: config.serverUrl,
    token: config.token,
    port: config.port ?? 2468,
    defaultAgent: config.defaultAgent ?? "claude",
    workspaceDir: config.workspaceDir ?? process.cwd(),
  });

  // Register a tool for running sandbox tasks
  api.registerTool({
    name: "sandbox_task",
    description:
      "Run a coding task in an isolated sandbox environment using Claude Code, Codex, OpenCode, or Amp",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: ["claude", "codex", "opencode", "amp"],
          description: "The coding agent to use",
        },
        task: {
          type: "string",
          description: "The task to execute",
        },
        workingDirectory: {
          type: "string",
          description: "Working directory for the task (optional)",
        },
      },
      required: ["agent", "task"],
    },
    handler: async (params: { agent: string; task: string; workingDirectory?: string }) => {
      if (!manager) {
        return { error: "Sandbox agent manager not initialized" };
      }

      try {
        const result = await manager.runTask({
          agent: params.agent as "claude" | "codex" | "opencode" | "amp",
          task: params.task,
          sessionId: `tool-${Date.now()}`,
          workingDirectory: params.workingDirectory,
        });

        return {
          success: result.success,
          summary: result.summary,
          error: result.error,
          eventCount: result.events.length,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { error };
      }
    },
  });

  // Register command for chat interface
  api.registerCommand?.({
    name: "sandbox",
    description: "Run a coding task in an isolated sandbox",
    usage: "/sandbox <agent> <task>",
    handler: async (args: string) => {
      if (!manager) {
        return "Sandbox agent manager not initialized";
      }

      const [agentName, ...taskParts] = args.split(" ");
      const task = taskParts.join(" ");

      if (!task) {
        return "Usage: /sandbox <agent> <task>\nAgents: claude, codex, opencode, amp";
      }

      const agent =
        (agentName as "claude" | "codex" | "opencode" | "amp") || config.defaultAgent || "claude";

      try {
        const result = await manager.runTask({
          agent,
          task,
          sessionId: `cmd-${Date.now()}`,
        });

        return result.summary ?? (result.success ? "Task completed" : `Failed: ${result.error}`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return `Sandbox error: ${error}`;
      }
    },
  });

  console.log("[sandbox-agent] Plugin registered");
}

// Export manager for other extensions to use
export function getSandboxAgentManager(): SandboxAgentManager | null {
  return manager;
}
