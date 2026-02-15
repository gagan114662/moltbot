/**
 * Orchestrate tool — programmatic tool calling via JavaScript sandbox.
 *
 * Lets the LLM write JavaScript code that calls other tools programmatically.
 * The code runs in a Node.js `vm.createContext` sandbox with async tool
 * functions exposed as APIs. Only the final result enters the LLM's context.
 *
 * @see https://www.anthropic.com/engineering/advanced-tool-use
 */

import vm from "node:vm";
import type { AnyAgentTool } from "./common.js";
import { normalizeToolName } from "../tool-policy.js";
import { jsonResult, readStringParam } from "./common.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Meta-tools that should not be callable from orchestrate code. */
const META_TOOLS = new Set(["search_tools", "orchestrate"]);

// ---------------------------------------------------------------------------
// Tool ID generation
// ---------------------------------------------------------------------------

let toolCallCounter = 0;
function generateToolCallId(): string {
  return `orch-${Date.now()}-${++toolCallCounter}`;
}

// ---------------------------------------------------------------------------
// Sandbox builder
// ---------------------------------------------------------------------------

type SandboxResult = {
  result: unknown;
  logs: string[];
  toolCalls: Array<{ tool: string; durationMs: number }>;
};

async function runInSandbox(
  code: string,
  toolApis: Record<string, (params: unknown) => Promise<unknown>>,
  timeoutMs: number,
): Promise<SandboxResult> {
  const logs: string[] = [];
  const toolCalls: Array<{ tool: string; durationMs: number }> = [];
  let finalResult: unknown = undefined;
  let resultSet = false;

  const sandbox = vm.createContext({
    tools: toolApis,
    result: (value: unknown) => {
      finalResult = value;
      resultSet = true;
    },
    console: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => logs.push(`[error] ${args.map(String).join(" ")}`),
      warn: (...args: unknown[]) => logs.push(`[warn] ${args.map(String).join(" ")}`),
    },
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    RegExp,
    Map,
    Set,
    Promise,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    // Explicitly block dangerous globals
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    fetch: undefined,
    require: undefined,
    process: undefined,
    Buffer: undefined,
    __dirname: undefined,
    __filename: undefined,
  });

  // Wrap tool APIs to track calls
  const trackedApis: Record<string, (params: unknown) => Promise<unknown>> = {};
  for (const [name, fn] of Object.entries(toolApis)) {
    trackedApis[name] = async (params: unknown) => {
      const start = Date.now();
      const r = await fn(params);
      toolCalls.push({ tool: name, durationMs: Date.now() - start });
      return r;
    };
  }
  sandbox.tools = trackedApis;

  // Compile and run the script
  const wrappedCode = `
		(async () => {
			${code}
		})()
	`;

  const script = new vm.Script(wrappedCode, {
    filename: "orchestrate.js",
  });

  // vm.Script timeout only works for synchronous code.
  // For async code, we use Promise.race with a timeout.
  const execution = script.runInContext(sandbox);

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Orchestrate script timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Don't block process exit
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  });

  await Promise.race([execution, timeoutPromise]);

  return {
    result: resultSet ? finalResult : undefined,
    logs,
    toolCalls,
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the orchestrate tool.
 *
 * @param tools — the full tool list (post-policy). Only non-meta tools are exposed.
 * @param options — configuration overrides.
 */
export function createOrchestrateTool(
  tools: AnyAgentTool[],
  options?: {
    allowedTools?: string[];
    timeoutMs?: number;
  },
): AnyAgentTool {
  const timeoutMs = options?.timeoutMs ?? 30_000;

  // Build allowed tool map
  const allowedSet = options?.allowedTools
    ? new Set(options.allowedTools.map(normalizeToolName))
    : null;

  const callableTools = tools.filter((t) => {
    const name = normalizeToolName(t.name);
    if (META_TOOLS.has(name)) {
      return false;
    }
    if (allowedSet && !allowedSet.has(name)) {
      return false;
    }
    return true;
  });

  // Build tool APIs for the sandbox
  const toolApis: Record<string, (params: unknown) => Promise<unknown>> = {};
  for (const tool of callableTools) {
    const name = normalizeToolName(tool.name);
    toolApis[name] = async (params: unknown) => {
      const callId = generateToolCallId();
      const r = await tool.execute(callId, params, undefined, undefined);
      // Extract text content from AgentToolResult
      if (r && typeof r === "object" && "content" in r) {
        const content = r.content as Array<{ type: string; text?: string }>;
        const textPart = content?.find((c) => c.type === "text");
        if (textPart?.text) {
          try {
            return JSON.parse(textPart.text);
          } catch {
            return textPart.text;
          }
        }
      }
      if (r && typeof r === "object" && "details" in r) {
        return r.details;
      }
      return r;
    };
  }

  const toolNames = Object.keys(toolApis);
  const toolListStr =
    toolNames.length > 10
      ? `${toolNames.slice(0, 10).join(", ")} and ${toolNames.length - 10} more`
      : toolNames.join(", ");

  return {
    label: "Orchestrate",
    name: "orchestrate",
    description: [
      "Execute JavaScript code that orchestrates multiple tool calls.",
      "Use this when you need to: (1) call multiple tools and process their results,",
      "(2) filter/transform large tool outputs before returning them,",
      "(3) run conditional tool chains based on intermediate results.",
      `Available tools: ${toolListStr}.`,
      "Call tools with `await tools.toolName(params)`. Set the final output with `result(value)`.",
      "The sandbox has no network, filesystem, or timer access — only tool APIs.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        code: {
          type: "string",
          description:
            'JavaScript code to execute. Use `await tools.toolName(params)` to call tools. Set your final result with `result(value)`. Example: `const r = await tools.web_fetch({url: "https://example.com"}); result(r);`',
        },
        description: {
          type: "string",
          description: "Brief description of what the code does.",
        },
      },
      required: ["code", "description"],
    },
    execute: async (_toolCallId: string, args: unknown) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const code = readStringParam(params, "code", { required: true });
      const description = readStringParam(params, "description") ?? "orchestrate script";

      try {
        const {
          result: scriptResult,
          logs,
          toolCalls,
        } = await runInSandbox(code, toolApis, timeoutMs);

        return jsonResult({
          status: "ok",
          description,
          result: scriptResult,
          tool_calls_made: toolCalls.length,
          tool_call_details: toolCalls,
          ...(logs.length > 0 ? { console_output: logs } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          status: "error",
          description,
          error: message,
        });
      }
    },
  } as unknown as AnyAgentTool;
}

// ---------------------------------------------------------------------------
// Pipeline helper
// ---------------------------------------------------------------------------

/**
 * Conditionally add the orchestrate tool to the tool list.
 * Only adds it when `config.enabled` is true.
 */
export function applyOrchestrateTool(
  tools: AnyAgentTool[],
  config?: { enabled?: boolean; allowedTools?: string[]; timeoutMs?: number },
): AnyAgentTool[] {
  if (!config?.enabled) {
    return tools;
  }

  const orchestrateTool = createOrchestrateTool(tools, {
    allowedTools: config.allowedTools,
    timeoutMs: config.timeoutMs,
  });

  return [...tools, orchestrateTool];
}
