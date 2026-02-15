/**
 * Tool use examples registry.
 *
 * Provides concrete usage examples that are injected into tool descriptions
 * as `<examples>` XML blocks. This significantly improves tool call accuracy
 * (72% → 90% per Anthropic's testing) by showing the LLM real invocation patterns
 * rather than relying on JSON schemas alone.
 *
 * @see https://www.anthropic.com/engineering/advanced-tool-use
 */

import type { AnyAgentTool } from "./pi-tools.types.js";
import { normalizeToolName } from "./tool-policy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolExample = {
  /** Short label describing the example scenario. */
  title: string;
  /** The tool parameters as a JSON-serializable object. */
  parameters: Record<string, unknown>;
  /** Optional expected result summary. */
  result?: string;
};

// ---------------------------------------------------------------------------
// Built-in examples registry
// ---------------------------------------------------------------------------

export const TOOL_EXAMPLES: Record<string, ToolExample[]> = {
  message: [
    {
      title: "Send a text message on WhatsApp",
      parameters: {
        action: "send",
        target: "whatsapp:+14155551234",
        message: "Hey, just checking in!",
      },
    },
    {
      title: "Send an image with caption on Telegram",
      parameters: {
        action: "send",
        channel: "telegram",
        target: "johndoe",
        message: "Check out this screenshot",
        media: "https://example.com/screenshot.png",
      },
    },
    {
      title: "Reply to a specific message in a thread",
      parameters: {
        action: "reply",
        replyTo: "msg_abc123",
        message: "Great point! I agree.",
      },
    },
    {
      title: "Send a message to a Discord channel",
      parameters: {
        action: "send",
        channel: "discord",
        target: "#general",
        message: "Server maintenance at 10pm UTC tonight.",
      },
    },
  ],
  exec: [
    {
      title: "Run a simple shell command",
      parameters: { command: "ls -la /tmp" },
    },
    {
      title: "Run a piped command",
      parameters: { command: "cat /var/log/app.log | grep ERROR | tail -20" },
    },
    {
      title: "Run a long-running command in background",
      parameters: { command: "npm run build", background: true },
    },
  ],
  browser: [
    {
      title: "Take a screenshot of a page",
      parameters: {
        action: "screenshot",
        url: "https://example.com",
      },
    },
    {
      title: "Get an accessibility snapshot of the current page",
      parameters: {
        action: "snapshot",
      },
    },
    {
      title: "Click an element from snapshot ref",
      parameters: {
        action: "act",
        request: {
          kind: "click",
          ref: "e12",
        },
      },
    },
  ],
  web_search: [
    {
      title: "Search for recent news",
      parameters: {
        query: "latest AI safety research 2026",
        maxResults: 5,
      },
    },
    {
      title: "Search within a specific site",
      parameters: {
        query: "site:github.com openai whisper alternatives",
        maxResults: 3,
      },
    },
  ],
  web_fetch: [
    {
      title: "Fetch and extract content from a URL",
      parameters: {
        url: "https://docs.example.com/api/reference",
      },
    },
    {
      title: "Fetch with max character limit",
      parameters: {
        url: "https://en.wikipedia.org/wiki/Large_language_model",
        maxChars: 5000,
      },
    },
  ],
  sessions_send: [
    {
      title: "Send a message to another agent session",
      parameters: {
        sessionKey: "agent:researcher",
        message: "Summarize the findings from the last search.",
      },
    },
  ],
  memory_search: [
    {
      title: "Search memory for a topic",
      parameters: {
        query: "user preferences for notification settings",
      },
    },
    {
      title: "Search with source filter",
      parameters: {
        query: "deployment runbook",
        source: "memory",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format an array of tool examples into an XML `<examples>` block
 * suitable for appending to a tool description.
 */
export function formatExamplesBlock(examples: ToolExample[]): string {
  if (examples.length === 0) {
    return "";
  }

  const items = examples.map((ex) => {
    const parts = [`<example>`, `<title>${ex.title}</title>`];
    parts.push(`<parameters>${JSON.stringify(ex.parameters)}</parameters>`);
    if (ex.result) {
      parts.push(`<result>${ex.result}</result>`);
    }
    parts.push("</example>");
    return parts.join("\n");
  });

  return `\n<examples>\n${items.join("\n")}\n</examples>`;
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

/**
 * Apply tool use examples to a list of tools.
 * Returns a new array with examples appended to matching tool descriptions.
 * Tools without matching examples are returned unchanged.
 */
export function applyExamplesToTools(
  tools: AnyAgentTool[],
  options?: { enabled?: boolean },
): AnyAgentTool[] {
  if (options?.enabled === false) {
    return tools;
  }

  return tools.map((tool) => {
    const name = normalizeToolName(tool.name);
    const examples = TOOL_EXAMPLES[name];
    if (!examples || examples.length === 0) {
      return tool;
    }

    const block = formatExamplesBlock(examples);
    if (!block) {
      return tool;
    }

    return {
      ...tool,
      description: (tool.description ?? "") + block,
    };
  });
}
