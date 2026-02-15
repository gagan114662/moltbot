import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";
import {
  applyExamplesToTools,
  formatExamplesBlock,
  TOOL_EXAMPLES,
  type ToolExample,
} from "./tool-examples.js";

function makeTool(name: string, description = "A tool."): AnyAgentTool {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ type: "text", text: "ok" }),
  } as unknown as AnyAgentTool;
}

describe("formatExamplesBlock", () => {
  it("returns empty string for empty examples", () => {
    expect(formatExamplesBlock([])).toBe("");
  });

  it("formats a single example", () => {
    const examples: ToolExample[] = [
      {
        title: "Send a message",
        parameters: { action: "send", message: "hi" },
      },
    ];
    const result = formatExamplesBlock(examples);
    expect(result).toContain("<examples>");
    expect(result).toContain("</examples>");
    expect(result).toContain("<title>Send a message</title>");
    expect(result).toContain('"action":"send"');
    expect(result).toContain('"message":"hi"');
  });

  it("formats multiple examples", () => {
    const examples: ToolExample[] = [
      { title: "First", parameters: { a: 1 } },
      { title: "Second", parameters: { b: 2 } },
    ];
    const result = formatExamplesBlock(examples);
    expect(result).toContain("<title>First</title>");
    expect(result).toContain("<title>Second</title>");
    // Should have two <example> blocks
    const matches = result.match(/<example>/g);
    expect(matches).toHaveLength(2);
  });

  it("includes result when present", () => {
    const examples: ToolExample[] = [
      {
        title: "With result",
        parameters: { q: "test" },
        result: "Found 3 results",
      },
    ];
    const result = formatExamplesBlock(examples);
    expect(result).toContain("<result>Found 3 results</result>");
  });

  it("omits result when not present", () => {
    const examples: ToolExample[] = [{ title: "No result", parameters: { q: "test" } }];
    const result = formatExamplesBlock(examples);
    expect(result).not.toContain("<result>");
  });
});

describe("applyExamplesToTools", () => {
  it("appends examples to tools that have them", () => {
    const tools = [makeTool("message"), makeTool("exec")];
    const result = applyExamplesToTools(tools);

    expect(result[0].description).toContain("<examples>");
    expect(result[0].description).toContain("Send a text message on WhatsApp");
    expect(result[1].description).toContain("<examples>");
    expect(result[1].description).toContain("Run a simple shell command");
  });

  it("preserves original description", () => {
    const tools = [makeTool("message", "Send messages across channels.")];
    const result = applyExamplesToTools(tools);
    expect(result[0].description).toMatch(/^Send messages across channels\./);
  });

  it("leaves tools without examples unchanged", () => {
    const tools = [makeTool("custom_tool_xyz")];
    const result = applyExamplesToTools(tools);
    expect(result[0].description).toBe("A tool.");
    expect(result[0].description).not.toContain("<examples>");
  });

  it("does not mutate original tools", () => {
    const tools = [makeTool("message")];
    const originalDesc = tools[0].description;
    applyExamplesToTools(tools);
    expect(tools[0].description).toBe(originalDesc);
  });

  it("respects enabled=false", () => {
    const tools = [makeTool("message")];
    const result = applyExamplesToTools(tools, { enabled: false });
    expect(result[0].description).toBe("A tool.");
  });

  it("handles bash alias to exec", () => {
    const tools = [makeTool("bash")];
    const result = applyExamplesToTools(tools);
    // normalizeToolName maps "bash" -> "exec"
    expect(result[0].description).toContain("Run a simple shell command");
  });
});

describe("TOOL_EXAMPLES registry", () => {
  it("has examples for key tools", () => {
    const expectedTools = [
      "message",
      "exec",
      "browser",
      "web_search",
      "web_fetch",
      "sessions_send",
      "memory_search",
    ];
    for (const name of expectedTools) {
      expect(TOOL_EXAMPLES[name]).toBeDefined();
      expect(TOOL_EXAMPLES[name].length).toBeGreaterThan(0);
    }
  });

  it("every example has required fields", () => {
    for (const [name, examples] of Object.entries(TOOL_EXAMPLES)) {
      for (const ex of examples) {
        expect(ex.title, `${name}: missing title`).toBeTruthy();
        expect(ex.parameters, `${name}: missing parameters`).toBeDefined();
        expect(typeof ex.parameters, `${name}: parameters not object`).toBe("object");
      }
    }
  });
});
