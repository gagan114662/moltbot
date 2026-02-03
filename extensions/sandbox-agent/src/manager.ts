/**
 * Sandbox Agent Manager
 *
 * Manages sandbox-agent connections and sessions for running coding agents
 * in isolated environments.
 */

import {
  SandboxAgent,
  type UniversalEvent,
  type UniversalItem,
  type ContentPart,
  type ItemEventData,
  type PermissionEventData,
  type QuestionEventData,
} from "sandbox-agent";

export interface SandboxAgentManagerOptions {
  mode: "embedded" | "remote";
  serverUrl?: string;
  token?: string;
  port: number;
  defaultAgent: "claude" | "codex" | "opencode" | "amp";
  workspaceDir: string;
}

export interface SandboxSession {
  id: string;
  agent: "claude" | "codex" | "opencode" | "amp";
  status: "running" | "completed" | "failed" | "waiting_approval";
  startedAt: Date;
  endedAt?: Date;
  events: UniversalEvent[];
}

export interface TaskResult {
  success: boolean;
  summary?: string;
  events: UniversalEvent[];
  error?: string;
}

export interface RunTaskOptions {
  agent: "claude" | "codex" | "opencode" | "amp";
  task: string;
  sessionId: string;
  workingDirectory?: string;
  onEvent?: (event: UniversalEvent) => Promise<void>;
  onPermissionRequest?: (
    event: UniversalEvent,
  ) => Promise<{ approved: boolean; reason?: string }>;
  onQuestion?: (event: UniversalEvent) => Promise<string[][]>;
  timeoutMs?: number;
}

export class SandboxAgentManager {
  private client: SandboxAgent | null = null;
  private options: SandboxAgentManagerOptions;
  private sessions: Map<string, SandboxSession> = new Map();
  private permissionHandlers: Map<
    string,
    (event: UniversalEvent) => Promise<{ approved: boolean; reason?: string }>
  > = new Map();
  private questionHandlers: Map<
    string,
    (event: UniversalEvent) => Promise<string[][]>
  > = new Map();

  constructor(options: SandboxAgentManagerOptions) {
    this.options = options;
  }

  /**
   * Initialize the sandbox-agent client
   */
  async initialize(): Promise<void> {
    if (this.client) return;

    if (this.options.mode === "embedded") {
      // Start embedded server
      this.client = await SandboxAgent.start({
        spawn: {
          port: this.options.port,
          token: this.options.token,
        },
      });
    } else {
      // Connect to remote server
      if (!this.options.serverUrl) {
        throw new Error("serverUrl is required for remote mode");
      }
      this.client = await SandboxAgent.connect({
        baseUrl: this.options.serverUrl,
        token: this.options.token,
      });
    }

    // Verify connection
    const health = await this.client.getHealth();
    console.log(`[sandbox-agent] Connected to server (status: ${health.status})`);
  }

  /**
   * Run a coding task in the sandbox
   */
  async runTask(opts: RunTaskOptions): Promise<TaskResult> {
    await this.initialize();

    if (!this.client) {
      return { success: false, events: [], error: "Client not initialized" };
    }

    const session: SandboxSession = {
      id: opts.sessionId,
      agent: opts.agent,
      status: "running",
      startedAt: new Date(),
      events: [],
    };
    this.sessions.set(opts.sessionId, session);

    // Store handlers for this session
    if (opts.onPermissionRequest) {
      this.permissionHandlers.set(opts.sessionId, opts.onPermissionRequest);
    }
    if (opts.onQuestion) {
      this.questionHandlers.set(opts.sessionId, opts.onQuestion);
    }

    try {
      // Create session
      await this.client.createSession(opts.sessionId, {
        agent: opts.agent,
        agentMode: "default",
        permissionMode: opts.onPermissionRequest ? "ask" : undefined,
      });

      // Send the task message and stream events
      const controller = new AbortController();
      const timeoutId = opts.timeoutMs
        ? setTimeout(() => controller.abort(), opts.timeoutMs)
        : undefined;

      try {
        // Stream the turn (message + events)
        for await (const event of this.client.streamTurn(
          opts.sessionId,
          { message: opts.task },
          { includeRaw: false },
          controller.signal,
        )) {
          session.events.push(event);

          // Handle special events
          await this.handleEvent(opts.sessionId, event);

          // Notify callback
          if (opts.onEvent) {
            await opts.onEvent(event);
          }
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      session.status = "completed";
      session.endedAt = new Date();

      // Generate summary from events
      const summary = this.generateSummary(session.events);

      return {
        success: true,
        summary,
        events: session.events,
      };
    } catch (err) {
      session.status = "failed";
      session.endedAt = new Date();

      const error = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        events: session.events,
        error,
      };
    } finally {
      // Cleanup handlers
      this.permissionHandlers.delete(opts.sessionId);
      this.questionHandlers.delete(opts.sessionId);
    }
  }

  /**
   * Handle special events like permission requests and questions
   */
  private async handleEvent(
    sessionId: string,
    event: UniversalEvent,
  ): Promise<void> {
    if (!this.client) return;

    if (event.type === "permission.requested") {
      const handler = this.permissionHandlers.get(sessionId);
      if (handler) {
        const session = this.sessions.get(sessionId);
        if (session) session.status = "waiting_approval";

        const result = await handler(event);

        if (session) session.status = "running";

        const permData = event.data as PermissionEventData;
        await this.client.replyPermission(sessionId, permData.permission_id, {
          reply: result.approved ? "once" : "reject",
        });
      }
    }

    if (event.type === "question.requested") {
      const handler = this.questionHandlers.get(sessionId);
      if (handler) {
        const answers = await handler(event);
        const questionData = event.data as QuestionEventData;
        await this.client.replyQuestion(sessionId, questionData.question_id, {
          answers,
        });
      }
    }
  }

  /**
   * Generate a summary from session events
   */
  private generateSummary(events: UniversalEvent[]): string {
    // Find completed items with assistant role
    const completedItems = events.filter(
      (e) => e.type === "item.completed",
    );

    // Get the last assistant message
    for (let i = completedItems.length - 1; i >= 0; i--) {
      const event = completedItems[i];
      const data = event.data as ItemEventData;
      const item = data.item;

      if (item.role === "assistant" && item.content) {
        const text = item.content
          .filter((c): c is ContentPart & { type: "text" } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        if (text) {
          return text.slice(0, 1000);
        }
      }
    }

    return "Task completed";
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): SandboxSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all sessions
   */
  listSessions(): SandboxSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * List available agents
   */
  async listAgents(): Promise<string[]> {
    await this.initialize();
    if (!this.client) return [];

    const response = await this.client.listAgents();
    return response.agents.map((a) => a.id);
  }

  /**
   * Shutdown the manager and cleanup
   */
  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.dispose();
      this.client = null;
    }
    this.sessions.clear();
    this.permissionHandlers.clear();
    this.questionHandlers.clear();
  }
}
