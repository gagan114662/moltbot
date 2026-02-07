/**
 * Sandbox Agent Extension for OpenClaw
 *
 * Integrates Rivet's sandbox-agent to run coding agents (Claude Code, Codex, OpenCode, Amp)
 * in isolated sandboxes with HTTP control and human-in-the-loop approval via messaging channels.
 */

import type { UniversalEvent, ItemEventData, ContentPart } from "sandbox-agent";
import { SandboxAgentManager } from "./manager.js";

export interface SandboxAgentConfig {
  /** Enable the sandbox agent integration */
  enabled?: boolean;

  /** Default agent to use: "claude" | "codex" | "opencode" | "amp" */
  defaultAgent?: "claude" | "codex" | "opencode" | "amp";

  /** Server mode: "embedded" spawns locally, "remote" connects to existing server */
  mode?: "embedded" | "remote";

  /** Remote server URL (required if mode is "remote") */
  serverUrl?: string;

  /** Auth token for the sandbox server */
  token?: string;

  /** Port for embedded server (default: 2468) */
  port?: number;

  /** Enable human-in-the-loop approvals via messaging channel */
  humanInTheLoop?: {
    enabled?: boolean;
    /** Timeout in seconds to wait for approval (default: 300) */
    timeoutSeconds?: number;
    /** Auto-approve safe operations (file reads, etc.) */
    autoApproveSafe?: boolean;
  };

  /** Workspace directory for sandbox sessions */
  workspaceDir?: string;
}

// Generic plugin context interface (simplified for standalone build)
interface PluginContext {
  config?: SandboxAgentConfig;
  workspaceDir?: string;
  log: (message: string) => void;
  set: (key: string, value: unknown) => void;
  get: (key: string) => unknown;
  registerCommand?: (cmd: {
    name: string;
    description: string;
    usage: string;
    handler: (
      args: string,
      message: { channelId: string; reply: (text: string) => Promise<void> },
    ) => Promise<string>;
  }) => void;
  registerSkill?: (skill: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler: (params: Record<string, unknown>) => Promise<unknown>;
  }) => void;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  getControlChannel?: () => { send: (text: string) => Promise<{ id?: string }> } | undefined;
}

export const plugin = {
  name: "sandbox-agent",
  version: "0.1.0",

  async onLoad(ctx: PluginContext) {
    const config = ctx.config ?? {};

    if (config.enabled === false) {
      ctx.log("Sandbox Agent plugin disabled");
      return;
    }

    ctx.log("Initializing Sandbox Agent integration...");

    // Create the manager
    const manager = new SandboxAgentManager({
      mode: config.mode ?? "embedded",
      serverUrl: config.serverUrl,
      token: config.token,
      port: config.port ?? 2468,
      defaultAgent: config.defaultAgent ?? "claude",
      workspaceDir: config.workspaceDir ?? ctx.workspaceDir ?? process.cwd(),
    });

    // Store in context for other plugins/extensions to use
    ctx.set("sandboxAgent", manager);

    // Register commands if available
    if (ctx.registerCommand) {
      ctx.registerCommand({
        name: "sandbox",
        description: "Run a coding task in an isolated sandbox",
        usage: "/sandbox <agent> <task>",
        handler: async (
          args: string,
          message: { channelId: string; reply: (text: string) => Promise<void> },
        ) => {
          const [agentName, ...taskParts] = args.split(" ");
          const task = taskParts.join(" ");

          if (!task) {
            return "Usage: /sandbox <agent> <task>\nAgents: claude, codex, opencode, amp";
          }

          const agent =
            (agentName as "claude" | "codex" | "opencode" | "amp") ||
            config.defaultAgent ||
            "claude";

          ctx.log(`Starting sandbox session with ${agent}...`);
          await message.reply(`Starting sandbox session with ${agent}...`);

          try {
            const result = await manager.runTask({
              agent,
              task,
              sessionId: `${message.channelId}-${Date.now()}`,
              onEvent: async (event: UniversalEvent) => {
                // Stream events back to the user
                if (event.type === "item.completed") {
                  const data = event.data as ItemEventData;
                  if (data.item.role === "assistant") {
                    const content = data.item.content
                      ?.filter((c): c is ContentPart & { type: "text" } => c.type === "text")
                      .map((c) => c.text)
                      .join("");
                    if (content) {
                      await message.reply(content.slice(0, 2000));
                    }
                  }
                }
              },
            });

            return result.summary ?? "Task completed";
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return `Sandbox error: ${error}`;
          }
        },
      });
    }

    // Register skill for use by agents
    if (ctx.registerSkill) {
      ctx.registerSkill({
        name: "sandbox-task",
        description: "Run a coding task in an isolated sandbox environment",
        parameters: {
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
            description: "Working directory for the task",
            optional: true,
          },
        },
        handler: async (params: Record<string, unknown>) => {
          const result = await manager.runTask({
            agent: params.agent as "claude" | "codex" | "opencode" | "amp",
            task: params.task as string,
            sessionId: `skill-${Date.now()}`,
            workingDirectory: params.workingDirectory as string | undefined,
          });
          return result;
        },
      });
    }

    ctx.log("Sandbox Agent plugin loaded");
  },

  async onUnload(ctx: PluginContext) {
    const manager = ctx.get("sandboxAgent") as SandboxAgentManager | undefined;
    if (manager) {
      await manager.shutdown();
    }
    ctx.log("Sandbox Agent plugin unloaded");
  },
};

export default plugin;
export { SandboxAgentManager } from "./manager.js";
export type { SandboxSession, TaskResult } from "./manager.js";
