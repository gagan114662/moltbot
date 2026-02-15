import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./common.js";
import { applyOrchestrateTool, createOrchestrateTool } from "./orchestrate-tool.js";

function makeTool(name: string, handler?: (params: unknown) => unknown): AnyAgentTool {
  return {
    name,
    description: `The ${name} tool.`,
    parameters: { type: "object", properties: { input: { type: "string" } } },
    execute: async (_toolCallId: string, params: unknown) => {
      const result = handler ? handler(params) : { output: `${name} default` };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  } as unknown as AnyAgentTool;
}

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

describe("createOrchestrateTool", () => {
  const tools = [
    makeTool("read", (params) => {
      const p = params as Record<string, unknown>;
      const path = typeof p.path === "string" ? p.path : "unknown";
      return { content: `Content of ${path}` };
    }),
    makeTool("web_fetch", (params) => {
      const p = params as Record<string, unknown>;
      return { url: p.url, body: `<html>Page for ${String(p.url)}</html>` };
    }),
    makeTool("exec", (params) => {
      const p = params as Record<string, unknown>;
      return { stdout: `Ran: ${String(p.command)}`, exitCode: 0 };
    }),
  ];

  it("creates a tool named orchestrate", () => {
    const tool = createOrchestrateTool(tools);
    expect(tool.name).toBe("orchestrate");
    expect(tool.description).toContain("orchestrate");
  });

  it("lists available tools in description", () => {
    const tool = createOrchestrateTool(tools);
    expect(tool.description).toContain("read");
    expect(tool.description).toContain("web_fetch");
    expect(tool.description).toContain("exec");
  });

  it("excludes meta-tools from available tools", () => {
    const withMeta = [...tools, makeTool("search_tools"), makeTool("orchestrate")];
    const tool = createOrchestrateTool(withMeta);
    expect(tool.description).not.toContain("search_tools");
    // "orchestrate" appears in description text but shouldn't be listed as callable
  });

  it("executes simple code that calls a tool", async () => {
    const tool = createOrchestrateTool(tools);
    const raw = await tool.execute("call-1", {
      code: `const r = await tools.read({ path: "/test.txt" }); result(r);`,
      description: "Read a file",
    });
    const parsed = parseResult(raw);
    expect(parsed.status).toBe("ok");
    expect(parsed.result).toEqual({ content: "Content of /test.txt" });
    expect(parsed.tool_calls_made).toBe(1);
  });

  it("executes code with multiple tool calls", async () => {
    const tool = createOrchestrateTool(tools);
    const raw = await tool.execute("call-2", {
      code: `
				const r1 = await tools.web_fetch({ url: "https://a.com" });
				const r2 = await tools.web_fetch({ url: "https://b.com" });
				result([r1.body, r2.body]);
			`,
      description: "Fetch two URLs",
    });
    const parsed = parseResult(raw);
    expect(parsed.status).toBe("ok");
    const resultArr = parsed.result as string[];
    expect(resultArr).toHaveLength(2);
    expect(resultArr[0]).toContain("a.com");
    expect(resultArr[1]).toContain("b.com");
    expect(parsed.tool_calls_made).toBe(2);
  });

  it("captures console.log output", async () => {
    const tool = createOrchestrateTool(tools);
    const raw = await tool.execute("call-3", {
      code: `console.log("hello"); console.log("world"); result("done");`,
      description: "Log test",
    });
    const parsed = parseResult(raw);
    expect(parsed.console_output).toEqual(["hello", "world"]);
  });

  it("returns error for syntax errors", async () => {
    const tool = createOrchestrateTool(tools);
    const raw = await tool.execute("call-4", {
      code: "this is not valid javascript ???",
      description: "Bad code",
    });
    const parsed = parseResult(raw);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toBeTruthy();
  });

  it("returns error for runtime errors", async () => {
    const tool = createOrchestrateTool(tools);
    const raw = await tool.execute("call-5", {
      code: `throw new Error("boom");`,
      description: "Throw test",
    });
    const parsed = parseResult(raw);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toContain("boom");
  });

  it("times out on long-running code", async () => {
    const tool = createOrchestrateTool(tools, { timeoutMs: 100 });
    const raw = await tool.execute("call-6", {
      code: `await new Promise(r => {}); result("never");`,
      description: "Infinite wait",
    });
    const parsed = parseResult(raw);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toContain("timed out");
  }, 5000);

  it("returns undefined result when result() not called", async () => {
    const tool = createOrchestrateTool(tools);
    const raw = await tool.execute("call-7", {
      code: `const x = 42;`,
      description: "No result set",
    });
    const parsed = parseResult(raw);
    expect(parsed.status).toBe("ok");
    expect(parsed.result).toBeUndefined();
  });

  it("respects allowedTools filter", async () => {
    const tool = createOrchestrateTool(tools, { allowedTools: ["read"] });
    // Should be able to call read
    const raw1 = await tool.execute("call-8a", {
      code: `const r = await tools.read({ path: "/x" }); result(r);`,
      description: "Read allowed",
    });
    expect(parseResult(raw1).status).toBe("ok");

    // web_fetch should not be accessible
    const raw2 = await tool.execute("call-8b", {
      code: `const r = await tools.web_fetch({ url: "https://x.com" }); result(r);`,
      description: "Fetch not allowed",
    });
    const parsed2 = parseResult(raw2);
    expect(parsed2.status).toBe("error");
  });

  it("blocks dangerous globals", async () => {
    const tool = createOrchestrateTool(tools);
    // setTimeout should be undefined
    const raw = await tool.execute("call-9", {
      code: `result(typeof setTimeout);`,
      description: "Check setTimeout",
    });
    const parsed = parseResult(raw);
    expect(parsed.result).toBe("undefined");
  });

  it("can use JSON, Math, Array utilities", async () => {
    const tool = createOrchestrateTool(tools);
    const raw = await tool.execute("call-10", {
      code: `
				const arr = [3, 1, 2];
				arr.sort();
				const obj = { a: 1 };
				const json = JSON.stringify(obj);
				result({ sorted: arr, json, pi: Math.PI });
			`,
      description: "Utility test",
    });
    const parsed = parseResult(raw);
    expect(parsed.status).toBe("ok");
    const r = parsed.result as Record<string, unknown>;
    expect(r.sorted).toEqual([1, 2, 3]);
    expect(r.json).toBe('{"a":1}');
    expect(r.pi).toBe(Math.PI);
  });

  it("tracks tool call durations", async () => {
    const tool = createOrchestrateTool(tools);
    const raw = await tool.execute("call-11", {
      code: `await tools.read({ path: "/a" }); result("done");`,
      description: "Duration tracking",
    });
    const parsed = parseResult(raw);
    const details = parsed.tool_call_details as Array<{ tool: string; durationMs: number }>;
    expect(details).toHaveLength(1);
    expect(details[0].tool).toBe("read");
    expect(typeof details[0].durationMs).toBe("number");
  });
});

describe("applyOrchestrateTool", () => {
  const tools = [makeTool("read"), makeTool("exec")];

  it("returns tools unchanged when disabled", () => {
    const result = applyOrchestrateTool(tools);
    expect(result).toBe(tools);
  });

  it("returns tools unchanged when enabled=false", () => {
    const result = applyOrchestrateTool(tools, { enabled: false });
    expect(result).toBe(tools);
  });

  it("adds orchestrate tool when enabled", () => {
    const result = applyOrchestrateTool(tools, { enabled: true });
    const names = result.map((t) => t.name);
    expect(names).toContain("orchestrate");
    expect(result.length).toBe(tools.length + 1);
  });

  it("preserves existing tools", () => {
    const result = applyOrchestrateTool(tools, { enabled: true });
    expect(result[0].name).toBe("read");
    expect(result[1].name).toBe("exec");
  });

  it("passes config to orchestrate tool", () => {
    const result = applyOrchestrateTool(tools, {
      enabled: true,
      allowedTools: ["read"],
    });
    const orchestrate = result.find((t) => t.name === "orchestrate");
    expect(orchestrate).toBeDefined();
    // Only read should be listed (not exec) since we restricted allowedTools
    expect(orchestrate?.description).toContain("read");
  });
});
