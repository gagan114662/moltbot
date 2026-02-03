/**
 * Human-in-the-Loop Module
 *
 * Bridges sandbox agent permission requests and questions to messaging channels
 * (WhatsApp, Telegram, Discord, etc.) for human approval.
 */

import type {
  UniversalEvent,
  PermissionEventData,
  QuestionEventData,
} from "sandbox-agent";

import type { SandboxAgentManager } from "./manager.js";
import type { SandboxAgentConfig } from "./index.js";

export interface HumanInTheLoopConfig {
  enabled?: boolean;
  timeoutSeconds?: number;
  autoApproveSafe?: boolean;
}

// Safe operations that can be auto-approved
const SAFE_OPERATIONS = new Set([
  "read_file",
  "list_files",
  "search_files",
  "glob",
  "grep",
  "view_file",
]);

// Dangerous operations that should always require approval
const DANGEROUS_OPERATIONS = new Set([
  "write_file",
  "delete_file",
  "execute",
  "bash",
  "shell",
  "rm",
  "sudo",
  "install",
]);

// Simplified plugin context for human-in-the-loop
interface HITLPluginContext {
  log: (message: string) => void;
  set: (key: string, value: unknown) => void;
  on?: (event: string, handler: (message: HITLMessage) => void) => void;
  getControlChannel?: () => HITLChannel | undefined;
}

interface HITLMessage {
  text?: string;
  channelId: string;
  replyToId?: string;
  reply: (text: string) => Promise<void>;
}

interface HITLChannel {
  send: (text: string) => Promise<{ id?: string }>;
}

export function setupHumanInTheLoop(
  ctx: HITLPluginContext,
  manager: SandboxAgentManager,
  config: HumanInTheLoopConfig,
): void {
  const timeoutMs = (config.timeoutSeconds ?? 300) * 1000;

  // Track pending approvals
  const pendingApprovals = new Map<
    string,
    {
      resolve: (result: { approved: boolean; reason?: string }) => void;
      sessionId: string;
      messageId?: string;
    }
  >();

  const pendingQuestions = new Map<
    string,
    {
      resolve: (answer: string[][]) => void;
      sessionId: string;
      messageId?: string;
    }
  >();

  // Listen for approval responses from users
  if (ctx.on) {
    ctx.on("message", (message: HITLMessage) => {
      const text = message.text?.toLowerCase().trim();
      if (!text) return;

      // Check for approval responses: "approve", "deny", "yes", "no"
      const isApproval = text === "approve" || text === "yes" || text === "y";
      const isDenial = text === "deny" || text === "no" || text === "n";

      if (isApproval || isDenial) {
        // Find pending approval for this channel
        for (const [id, pending] of pendingApprovals.entries()) {
          if (pending.messageId && message.replyToId === pending.messageId) {
            pending.resolve({
              approved: isApproval,
              reason: isDenial ? "User denied" : undefined,
            });
            pendingApprovals.delete(id);
            message.reply(isApproval ? "Approved." : "Denied.");
            return;
          }
        }

        // If no reply match, check if there's any pending approval
        const firstPending = pendingApprovals.entries().next();
        if (!firstPending.done) {
          const [id, pending] = firstPending.value;
          pending.resolve({
            approved: isApproval,
            reason: isDenial ? "User denied" : undefined,
          });
          pendingApprovals.delete(id);
          message.reply(isApproval ? "Approved." : "Denied.");
          return;
        }
      }

      // Check for question answers
      if (pendingQuestions.size > 0) {
        const firstQuestion = pendingQuestions.entries().next();
        if (!firstQuestion.done) {
          const [id, pending] = firstQuestion.value;
          pending.resolve([[message.text ?? ""]]);
          pendingQuestions.delete(id);
          return;
        }
      }
    });
  }

  // Create permission handler
  const handlePermission = async (
    event: UniversalEvent,
  ): Promise<{ approved: boolean; reason?: string }> => {
    const permData = event.data as PermissionEventData;
    const operation = permData.action ?? "unknown";

    // Auto-approve safe operations if configured
    if (config.autoApproveSafe && SAFE_OPERATIONS.has(operation)) {
      ctx.log(`[sandbox-hitl] Auto-approved safe operation: ${operation}`);
      return { approved: true };
    }

    // Format approval request message
    const isDangerous = DANGEROUS_OPERATIONS.has(operation);
    const emoji = isDangerous ? "🚨" : "⚠️";

    const approvalMessage = [
      `${emoji} **Sandbox Agent Permission Request**`,
      "",
      `**Operation:** \`${operation}\``,
      "",
      isDangerous
        ? "⚠️ This is a potentially dangerous operation."
        : "This operation requires your approval.",
      "",
      "Reply **yes** to approve or **no** to deny.",
    ].join("\n");

    // Find the appropriate channel to send the request
    const controlChannel = ctx.getControlChannel?.();

    if (!controlChannel) {
      ctx.log("[sandbox-hitl] No control channel available, auto-denying");
      return { approved: false, reason: "No control channel for approval" };
    }

    // Send the approval request
    const sentMessage = await controlChannel.send(approvalMessage);

    // Create a promise that resolves when user responds or timeout
    return new Promise((resolve) => {
      const id = permData.permission_id;

      const timeoutHandle = setTimeout(() => {
        pendingApprovals.delete(id);
        ctx.log(`[sandbox-hitl] Permission request timed out: ${operation}`);
        resolve({ approved: false, reason: "Timeout" });
      }, timeoutMs);

      pendingApprovals.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutHandle);
          resolve(result);
        },
        sessionId: event.session_id ?? "",
        messageId: sentMessage?.id,
      });
    });
  };

  // Create question handler
  const handleQuestion = async (event: UniversalEvent): Promise<string[][]> => {
    const questionData = event.data as QuestionEventData;
    const question = questionData.prompt ?? "The agent has a question for you.";

    const questionMessage = [
      "❓ **Sandbox Agent Question**",
      "",
      question,
      "",
      "Please reply with your answer.",
    ].join("\n");

    const controlChannel = ctx.getControlChannel?.();

    if (!controlChannel) {
      ctx.log("[sandbox-hitl] No control channel available for question");
      return [["Unable to get user input"]];
    }

    const sentMessage = await controlChannel.send(questionMessage);

    return new Promise((resolve) => {
      const id = questionData.question_id;

      const timeoutHandle = setTimeout(() => {
        pendingQuestions.delete(id);
        ctx.log("[sandbox-hitl] Question timed out");
        resolve([["No response (timeout)"]]);
      }, timeoutMs);

      pendingQuestions.set(id, {
        resolve: (answer) => {
          clearTimeout(timeoutHandle);
          resolve(answer);
        },
        sessionId: event.session_id ?? "",
        messageId: sentMessage?.id,
      });
    });
  };

  // Export handlers for manager to use
  ctx.set("sandboxAgentPermissionHandler", handlePermission);
  ctx.set("sandboxAgentQuestionHandler", handleQuestion);

  ctx.log("[sandbox-hitl] Human-in-the-loop enabled");
}
