import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";
import {
  DEFAULT_ALWAYS_LOADED,
  applyToolDeferral,
  buildToolIndex,
  classifyTools,
  createDeferredProxy,
  searchToolIndex,
} from "./tool-deferral.js";

function makeTool(
  name: string,
  description = `The ${name} tool.`,
  params?: Record<string, unknown>,
): AnyAgentTool {
  return {
    name,
    description,
    parameters: params ?? {
      type: "object",
      properties: {
        input: { type: "string" },
      },
    },
    execute: async () => ({ type: "text", text: `${name} result` }),
  } as unknown as AnyAgentTool;
}

describe("classifyTools", () => {
  it("puts core tools in loaded, others in deferred", () => {
    const tools = [makeTool("read"), makeTool("write"), makeTool("browser"), makeTool("canvas")];
    const { loaded, deferred } = classifyTools(tools);
    expect(loaded.map((t) => t.name)).toEqual(["read", "write"]);
    expect(deferred.map((t) => t.name)).toEqual(["browser", "canvas"]);
  });

  it("uses custom alwaysLoaded set", () => {
    const tools = [makeTool("browser"), makeTool("canvas")];
    const { loaded, deferred } = classifyTools(tools, new Set(["browser"]));
    expect(loaded.map((t) => t.name)).toEqual(["browser"]);
    expect(deferred.map((t) => t.name)).toEqual(["canvas"]);
  });

  it("handles empty tools list", () => {
    const { loaded, deferred } = classifyTools([]);
    expect(loaded).toEqual([]);
    expect(deferred).toEqual([]);
  });

  it("all tools in alwaysLoaded means nothing deferred", () => {
    const tools = [makeTool("read"), makeTool("exec")];
    const { loaded, deferred } = classifyTools(tools);
    expect(loaded).toHaveLength(2);
    expect(deferred).toHaveLength(0);
  });
});

describe("createDeferredProxy", () => {
  it("strips parameters to empty object", () => {
    const tool = makeTool("browser", "Control the browser with many features.");
    const proxy = createDeferredProxy(tool);
    expect(proxy.parameters).toEqual({ type: "object", properties: {} });
  });

  it("prefixes description with [Deferred]", () => {
    const tool = makeTool("browser", "Control the browser.");
    const proxy = createDeferredProxy(tool);
    expect(proxy.description).toContain("[Deferred]");
    expect(proxy.description).toContain("search_tools");
  });

  it("preserves execute function", () => {
    const tool = makeTool("browser");
    const proxy = createDeferredProxy(tool);
    expect(proxy.execute).toBe(tool.execute);
  });

  it("preserves tool name", () => {
    const tool = makeTool("browser");
    const proxy = createDeferredProxy(tool);
    expect(proxy.name).toBe("browser");
  });

  it("truncates long descriptions", () => {
    const longDesc = "A".repeat(200);
    const tool = makeTool("browser", longDesc);
    const proxy = createDeferredProxy(tool);
    // Should be much shorter than 200 chars
    expect(proxy.description?.length).toBeLessThan(150);
  });
});

describe("buildToolIndex + searchToolIndex", () => {
  const tools = [
    makeTool("browser", "Control the browser for web automation and screenshots.", {
      type: "object",
      properties: {
        action: { type: "string" },
        url: { type: "string" },
        screenshot: { type: "boolean" },
      },
    }),
    makeTool("canvas", "Draw and render on an HTML canvas.", {
      type: "object",
      properties: {
        command: { type: "string" },
        width: { type: "number" },
      },
    }),
    makeTool("cron", "Schedule recurring tasks with cron expressions.", {
      type: "object",
      properties: {
        expression: { type: "string" },
        command: { type: "string" },
      },
    }),
    makeTool("web_search", "Search the web for information.", {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
      },
    }),
  ];

  const index = buildToolIndex(tools);

  it("builds index with correct entry count", () => {
    expect(index.entries).toHaveLength(4);
  });

  it("finds tools by name", () => {
    const results = searchToolIndex(index, "browser");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("browser");
  });

  it("finds tools by description keywords", () => {
    const results = searchToolIndex(index, "screenshot");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("browser");
  });

  it("finds tools by parameter names", () => {
    const results = searchToolIndex(index, "expression");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("cron");
  });

  it("returns full schemas in results", () => {
    const results = searchToolIndex(index, "browser");
    expect(results[0].parameters).toEqual({
      type: "object",
      properties: {
        action: { type: "string" },
        url: { type: "string" },
        screenshot: { type: "boolean" },
      },
    });
    expect(results[0].description).toContain("web automation");
  });

  it("respects limit", () => {
    const results = searchToolIndex(index, "the", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns empty for no matches", () => {
    const results = searchToolIndex(index, "xyznonexistent");
    expect(results).toEqual([]);
  });

  it("scores exact name matches higher", () => {
    const results = searchToolIndex(index, "cron");
    expect(results[0].name).toBe("cron");
  });

  it("handles empty query gracefully", () => {
    const results = searchToolIndex(index, "");
    // Returns first N entries with score 0
    expect(results.length).toBeGreaterThan(0);
  });

  it("handles multi-word queries", () => {
    const results = searchToolIndex(index, "search web information");
    expect(results[0].name).toBe("web_search");
  });
});

describe("applyToolDeferral", () => {
  const tools = [
    makeTool("read"),
    makeTool("write"),
    makeTool("exec"),
    makeTool("message"),
    makeTool("browser", "Control the browser."),
    makeTool("canvas", "Draw on canvas."),
    makeTool("cron", "Schedule tasks."),
  ];

  it("enables deferral by default (no config)", () => {
    const result = applyToolDeferral(tools);
    const names = result.map((t) => t.name);
    // Deferral is on by default — deferred tools present + search_tools added
    expect(names).toContain("search_tools");
    const browserTool = result.find((t) => t.name === "browser");
    expect(browserTool?.description).toContain("[Deferred]");
  });

  it("returns tools unchanged when enabled=false", () => {
    const result = applyToolDeferral(tools, { enabled: false });
    expect(result).toBe(tools);
  });

  it("defers non-core tools when enabled", () => {
    const result = applyToolDeferral(tools, { enabled: true });
    const names = result.map((t) => t.name);

    // Core tools preserved
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("exec");
    expect(names).toContain("message");

    // Deferred tools still present (as proxies)
    expect(names).toContain("browser");
    expect(names).toContain("canvas");
    expect(names).toContain("cron");

    // search_tools added
    expect(names).toContain("search_tools");
  });

  it("deferred tools have stripped schemas", () => {
    const result = applyToolDeferral(tools, { enabled: true });
    const browserTool = result.find((t) => t.name === "browser");
    expect(browserTool?.description).toContain("[Deferred]");
    expect(browserTool?.parameters).toEqual({ type: "object", properties: {} });
  });

  it("core tools keep full schemas", () => {
    const result = applyToolDeferral(tools, { enabled: true });
    const readTool = result.find((t) => t.name === "read");
    expect(readTool?.description).not.toContain("[Deferred]");
    expect(readTool?.parameters).toEqual({
      type: "object",
      properties: { input: { type: "string" } },
    });
  });

  it("respects custom alwaysLoaded list", () => {
    const result = applyToolDeferral(tools, {
      enabled: true,
      alwaysLoaded: ["browser"],
    });
    const browserTool = result.find((t) => t.name === "browser");
    // browser should NOT be deferred since it's in alwaysLoaded
    expect(browserTool?.description).not.toContain("[Deferred]");
  });

  it("preserves execute functions on deferred tools", () => {
    const result = applyToolDeferral(tools, { enabled: true });
    const browserTool = result.find((t) => t.name === "browser");
    const original = tools.find((t) => t.name === "browser");
    expect(browserTool?.execute).toBe(original?.execute);
  });

  it("skips deferral when all tools are in alwaysLoaded", () => {
    const coreOnly = [makeTool("read"), makeTool("write"), makeTool("exec")];
    const result = applyToolDeferral(coreOnly, { enabled: true });
    // No deferred tools = no search_tools added
    const names = result.map((t) => t.name);
    expect(names).not.toContain("search_tools");
  });

  it("DEFAULT_ALWAYS_LOADED has expected tools", () => {
    expect(DEFAULT_ALWAYS_LOADED.has("read")).toBe(true);
    expect(DEFAULT_ALWAYS_LOADED.has("write")).toBe(true);
    expect(DEFAULT_ALWAYS_LOADED.has("edit")).toBe(true);
    expect(DEFAULT_ALWAYS_LOADED.has("exec")).toBe(true);
    expect(DEFAULT_ALWAYS_LOADED.has("process")).toBe(true);
    expect(DEFAULT_ALWAYS_LOADED.has("message")).toBe(true);
    expect(DEFAULT_ALWAYS_LOADED.has("session_status")).toBe(true);
    expect(DEFAULT_ALWAYS_LOADED.has("search_tools")).toBe(true);
  });
});
